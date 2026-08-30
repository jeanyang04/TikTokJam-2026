# Shared seams — what has already landed

`docs/TEAM.md` says who owns which file. This says what is **already in** the files more than one person has to touch, so the next person extends it instead of colliding with it.

Add an entry when you land something another owner will build on top of. Keep entries to what an agent cannot learn by reading the code: the convention, the reason, the collision waiting to happen.

---

## `config.ts` env schema (B2's file)

**Landed (B1, ticket 01):** `JWT_SECRET` and `SEED_USERS`.

`JWT_SECRET` has a dev default and throws in production on a non-loopback host, mirroring the `APP_AUTH_TOKEN` check already in the file. `SEED_USERS` is passed through as a **raw string**; `parseSeedUsers()` in `auth.ts` splits it.

**B2:** your Day 1 item 4 also assigns `JWT_SECRET` here. It exists. Extend, don't re-add.

**To add an env var:** one line in `envSchema`, one line in the returned object. Parse and validate the *shape* in the file that consumes it, so domain logic stays out of `config.ts`.

**Still present but unused:** `APP_AUTH_TOKEN` / `config.authToken`, left from the shared-token scheme ticket 01 deleted. B2's to remove.

---

## Token signing and verification (`auth.ts`, B1's file)

Import from `auth.js` rather than reaching for `jose` directly, so every token in the system is minted and checked one way.

```ts
signHuman(config, userId): Promise<string>
signAgent(config, {sub, own, run, jti, scp, expiresInSeconds}): Promise<string>
verifyToken(config, raw, "human"): Promise<HumanPrincipal | null>
verifyToken(config, raw, "agent"): Promise<AgentPrincipal | null>
```

Three things the signatures don't say:

**`config` comes first.** You need an `AppConfig` handle at the call site. `docs/PLAN.md` §2 writes these without it.

**`verifyToken` returns `null` on every failure** (bad signature, expiry, malformed claims, wrong type) rather than throwing. There is no error to catch and no way to skip the failure branch.

**The expected type is an argument, never read off the token.** `verifyToken(config, raw, "agent")` refuses a human token and vice versa. Asking for what you expect is what makes that hold, so a human JWT can never reach the gateway as an agent identity.

**`AgentPrincipal.scp` is `Scope[]`** (narrowed by Zeon when the contract merged; `agentClaims` validates against `SCOPES` from `types.ts`, so a token carrying an unknown scope fails verification).

---

## The `/api/*` gate (`auth.ts`, B1's file)

`registerAuth(app, config)` mounts `POST /api/auth/login` and the `onRequest` hook. Every `/api/*` route requires a human JWT except `/api/health`, `/api/auth`, and `/api/auth/login`. Routes outside `/api/` are never gated: `/mcp`, `/llm`, `/gw` and `/demo` authenticate agent tokens themselves.

The verified principal is on `request.principal` as `{typ:"human", userId}`. **Ownership checks read that**, never a body or query field.

**`/api/auth` is open, and `docs/PLAN.md` §2's list omits it.** §2 was written before anyone checked which routes exist. The baseline UI probes `/api/auth` at boot, and on failure `App.tsx:93` catches into an error banner without setting `authRequired`, stranding the app on its loading screen with no way in. The route now reports `{required: true}`. Leave it open and leave it truthful.

**F:** that boot probe is why the app still starts. Once the login bar replaces the token screen, `GET /api/auth` and the whole `authRequired` branch can go.

### Routes

All routes and shapes live in `docs/API.md` (the contract). This file only records seam conventions.

---

## The gateway (`gateway.ts`, Zeon's file) — mounted in `index.ts`

`gatewayPlugin` is registered in `index.ts` with a `GatewayDeps` object. Two slots are **left for other owners**:

- **`withOwner`** (B3): `(ownerId, agentId, fn) => Promise<T>` — transaction with `SET LOCAL app.owner_id/app.agent_id`. Until it's passed, `crm_read`/`crm_write` answer "CRM resource unavailable" and log an `error` event; nothing else is affected.
- **`webhookSink`** (B2): `(url, body) => Promise<{status}>`. Until it's passed, `webhook_send` fails closed after the IFC check.

Add your function to the `app.register(gatewayPlugin, {...})` call — that is the *only* line in `index.ts` you need to touch.

The gateway never imports `auth.ts`; `index.ts` adapts `verifyToken(config, raw, "agent")` (returns `null`) to the gateway's throwing `verifyAgentToken`. Keep it that way so `gateway.test.ts` can run with a test signer.

**All five tools are always registered.** The model's menu is shaped by Codex `enabled_tools` (B2) — build that list from `RunToken.scp`, not `agent.permissions.tools`, or "Allow for this run" is invisible to the model.

**"Allow for this run" writes `agent.tempScopes`.** B1: mint `RunToken.scp` with `effectiveScopes(agent)` from `store.ts`, or the follow-up message's new run drops the scope.

**Audit:** `recordEvent(store, event)` in `audit.ts` is the one way to write a `RunEvent`. It redacts. B3's `redact.ts` replaces the redactor via `setRedactor(fn)`; don't fork the pattern list.

---

## RunToken minting (`agent-service.ts`, B1's file)

**Landed (B1, ticket 04):** `sendMessage()` writes the `RunToken` row and the run in the
*same* `store.mutate`, then `executeRun` signs the agent JWT and passes it to
`runner.run()` as `request.token`.

Three things that are easy to get wrong from the outside:

**`scp` is `effectiveScopes(agent)`, not `permissions.tools`.** Permanent tools ∪ unexpired
`tempScopes`, so a scope granted by "Allow for this run" survives into the follow-up
message's run.

**`request.permissions.tools` is the token's `scp`, not the agent's permanent tools.** The
rest of `permissions` (sandbox, network, webSearch) is the agent's. B2 builds Codex's
`enabled_tools` from `permissions.tools`, and this is what keeps a just-widened scope
visible to the model. If you need the agent's permanent tools, read the agent.

**The JWT is a snapshot; the row is the authority.** Its `exp` matches the row's
`expiresAt` (`CODEX_TIMEOUT_MS + 60s`). Revoking mid-run means setting `revokedAt` on the
row — the JWT stays valid-looking and the gateway rejects it anyway, because it re-reads
the row on every call. Ticket 07's kill switch works the same way.

---

## Ownership enforcement (`app.ts`, B1's file)

**Landed (B1, ticket 03):** a `preHandler` on the root instance guards every route under
`/api/agents/` and `/api/runs/`, per `docs/API.md` §Ownership. It matches on the
**collection prefix** of `request.routeOptions.url`, not on `:id`, and returns early for
anything else, so the gateway's `/mcp` and the proxy's `/llm` are untouched.

**Ticket 06 added the `/api/grants/` and `/api/approvals/` rows** to the same table.
`grants.ts` and `approvals.ts` check the owner themselves as well; the gate is what turns
that check into a 403 *plus* an audit row, and what keeps an unknown id a bare 404.

**It fails closed on the case that would otherwise slip through.** Matching the prefix
rather than `:id` means a route named `/api/agents/:agentId/grants` still enters the gate;
finding no `id` param, it throws 500 rather than waving the request past unchecked. So
**name the parameter `:id`**. A malformed (non-uuid) id falls through to the route's own
zod parse, which answers 400. Both branches are pinned by tests.

**404 and 403 mean different things, on purpose.** An id that does not exist is a plain 404
and writes **no** RunEvent — logging it would make the audit trail an oracle for probing
which ids are real. An agent that exists but belongs to another tenant is 403 **and** a
RunEvent. A malformed (non-uuid) id falls through to the route's own zod parse and stays a
400.

**The deny row shape is fixed by `docs/API.md` §Ownership**, not invented here:
`{kind:"gateway", action:"api:<METHOD>", resource:"agent/<id>", decision:"deny",
reason:"cross-tenant"}`, with `resource: "run/<id>"` for the runs route by the same
pattern. `ownerId` is the *caller*, matching `gateway.ts` — read `ownerId` and `resource`
as "who tried" and "what they reached for". **F** renders `resource` verbatim in the
timeline row, so don't reformat it.

**`runId` is `null`** on these rows: an API call is not part of a run, so cross-tenant
denials never appear in a run timeline. **Resolved in ticket 06:** they surface on
`GET /api/agents/:id/events`, which keys on `agentId` — always set, on every row. The run
timeline stays run-scoped and needs no second query by `ownerId`.

**`listAgents(ownerId)` takes the owner as a required argument.** Not optional, not
defaulted — an optional filter on a tenant boundary is one forgotten argument away from
listing everybody's agents. `createAgent(input, ownerId)` still defaults to `"user-jean"`
for the service's own tests; `app.ts` always passes `request.principal.userId`.

**`POST /api/agents` and `PATCH /api/agents/:id` both accept `permissions`,** per
`docs/API.md` §"permissions". `updateAgent` merges it over the agent's current permissions
inside the existing `store.mutate`; the busy→409 guard that was already there covers the
contract's "PATCH with permissions while busy → 409".

**Two writers to `Agent.permissions.tools`, and ticket 06 adds no third.** An owner's PATCH
is the human configuring their own agent; `allow_always` is the human answering an Access
Request Card the agent provoked. Different triggers, same field, both through
`AgentService`. The card flow mediates *agent-initiated* escalation — it was never meant to
stop an owner editing their own agent, so PATCH is not a bypass of it.

**Keys explicitly set to `undefined` are stripped from the permissions body** before it
reaches `createAgent`, because the service spreads it over `DEFAULT_PERMISSIONS` and
`{...DEFAULT_PERMISSIONS, sandbox: undefined}` would leave the agent with no sandbox.

**`/api/runs/:id` is checked by the same hook**, resolving the run's agent and then its
owner. `docs/API.md` §Ownership names it in the preHandler list; ticket 03's checklist is
merely silent about it.

---

## Policy routes: grants, cards, timelines (`app.ts` + `agent-service.ts`, B1's files)

**Landed (B1, ticket 06):** the seven routes `docs/API.md` lists under Grants, Approvals
and Events. Kill (`POST /api/agents/:id/kill`) is ticket 07 and is *not* in yet.

**They go through `AgentService`, not through the store.** `app.ts` has no store handle,
and giving it one would put data access in the routing layer. The service methods
(`getGrants`, `createGrant`, `revokeGrant`, `listApprovals`, `decideApproval`,
`getRunEvents`, `getAgentEvents`) are thin calls into `grants.ts` / `approvals.ts`, which
stay Zeon's. Nothing is memoised — revoke-mid-run depends on reading the store per call.

**`POST /api/grants/parse` hit the `:id` trap, and ticket 08 resolved it with an
exemption.** It matches the `/api/grants/` prefix, names no `id`, and the gate's answer to
that is a 500. `idlessRoutes` in `app.ts` is now the one set that turns that throw off, and
it matches the **registered route string exactly**, never by prefix, so a later
`/api/grants/parse/:id` stays guarded. **Anything added to that set must check the caller's
ownership itself.** `POST /api/grants` and `GET /api/approvals` never needed it: no
trailing slash, so no match, and they check the owner inside `createGrant` /
`listApprovals`.

**`fromAgent` is required and nullable, not optional** (`null` = the owner's own CRM, which
has no source agent). Sending `{}` is a 400, not a CRM grant.

**Grant failures split three ways, and F should render them apart:** `404` unknown agent ·
`403` the recipient is not yours · `400` the source agent is another tenant's (D7,
intra-tenant only). **The 403 and the 400 both write a RunEvent; the 404 does not.**
`createGrant` refuses both cross-tenant reaches silently, and the route names no id for the
ownership gate to guard, so `AgentService.createGrant` writes the row before delegating.
CLAUDE.md rule 3 is about the *attempt*, not about which preHandler catches it — a
cross-tenant reach at an agent that exists is audited whatever status code the contract
gives it. **F: the row's `resource` is `agent/<id>` here, not `grant/<id>`** — a refused
create reaches for an agent, a refused revoke for a grant.

**`filter` defaults to `policy`** = kinds `gateway, approval, grant`; `all` adds
`command, file_change, mcp_call, llm`. Both are ordered oldest-first by `at`.
`GET /api/agents/:id/events` takes `limit` (default 200) and keeps the **newest** rows when
it bites, still in `at` order.

---

## The Kill switch (`agent-service.ts`, B1's file)

**Landed (B1, ticket 07):** `POST /api/agents/:id/kill` → `AgentService.killAgent`. Every
live `RunToken` for the agent gets `revokedAt`, `permissions.tools` is emptied, `200
{agent}`.

**It clears `tempScopes` as well, and `docs/API.md` §Agents says only `tools`.** A
deliberate deviation, because `RunToken.scp` is `effectiveScopes(agent)` = tools ∪ live
tempScopes: leaving an "Allow for this run" scope behind would hand it back to the very
next run and the kill would not be a kill. **Zeon:** the contract line wants the extra
clause; flagging rather than editing `API.md`.

**A kill mid-run is refused by `gateway.ts:95`,** which reads `revokedAt` off the row on
every call and answers `403 revoked`. Pinned end to end in `run-identity.test.ts`: same
token, run still open, `403 revoked`.

**The kill row names the run, and it is the only API row that does.** `gateway.ts:272`
audits the refusal it causes from `authenticate`'s failure path, before there is a verified
identity, so that row lands as `agentId: "unknown"`, `runId: null` and reaches no timeline.
Without a run on the kill row, nothing in the run's own timeline says why it stopped. The
row therefore carries the revoked token's `runId` when the kill interrupted exactly one
run, and `null` otherwise. **Zeon:** auditing the revoked branch from the claims would
attribute it properly, and then this can go back to `null` like every other API row.

**Pending cards are refused as part of the kill, and `docs/API.md`'s kill row does not say
so** — the second deviation, after `tempScopes`. A card the agent provoked before the kill
is still in the operator's queue afterwards, and `allow_always` writes straight into
`permissions.tools` (`approvals.ts:55`), so answering a stale card would undo a kill the
operator had just performed without them connecting the two. `killAgent` denies them
through `decideApproval`; each lands in the trail as the decision it now is, and a late
click gets the 409. **F:** a kill empties this agent's card list.

**What that does not do is tombstone the agent.** The killed token cannot mint a new card —
`gateway.ts` checks `revokedAt` in `authenticate`, before any tool dispatch, so a revoked
identity never reaches the branch that writes one. A *new* card needs a new run, which needs
the operator to send another message: a fresh decision, not a resurrection. If a killed
agent should stay dead until explicitly revived, that is a durable marker on the agent and
it belongs with `approvals.ts` — **Zeon's call**, not something to bolt onto this route.

**No busy guard, unlike PATCH.** A `409` here would mean the kill switch stops working
exactly when it is needed. The container is left running; Stop is what kills the process
(**B2:** the run's own clean exit as `failed` is your Day 3 item).

**An already-revoked token keeps its first timestamp.** When an identity died is evidence,
and a second kill must not rewrite the first one. `closeRunToken` at run end has the same
rule, from the other side.

---

## The demo cast (`seed.ts`, B1's file)

**Landed (B1, ticket 05):** `npm run seed` → `seedDemoFixtures()`. Researcher and Writer
(Jean), Alex-1 (Alex), Writer's workspace holding `notes.md` with the planted instruction
and a fake `credentials.json`.

**It lives at `apps/server/src/seed.ts`, and `docs/TEAM.md` says `scripts/seed.ts`.** A
file at the repo root is outside every tsconfig: `npm run typecheck` and `npm run build`
would both skip it and vitest would not collect `seed.test.ts` next to it, so the one gate
CLAUDE.md rule 1 names could not see the code. The npm script keeps TEAM.md's entry point.

**Re-running is a rehearsal reset as well as a no-op on the row count.** Ids survive
(grants, RunTokens and RunEvents all reference them), while `permissions`, `tempScopes`,
`codexThreadId` and grants wholly inside the cast go back to baseline. Otherwise
run-through two starts with Scene 1's "Always allow" already answered, and with a Codex
thread that remembers being denied and then allowed. Agents outside the cast and the whole
audit trail are untouched; the store is never truncated.

**Only grants with *both* ends in the cast are revoked.** A bystander agent granted read of
Writer's workspace is somebody's real configuration, not leftover demo state, so the
recipient has to be a cast agent too. A grant with `fromAgent: null` counts when its
`fromOwner` is Jean or Alex, because that is the owner's own CRM.

**It refuses while a cast agent is `busy`, with a 409.** The RunToken row is authoritative,
so resetting under a live run would leave that run working and silently take the scopes off
the *next* one. A reset that only half applies is worse than one that refuses. Writing rows
directly rather than through `AgentService` is what makes this the only guard in the way,
and it keeps the reset in one `store.mutate`.

**A reseed undoes the Kill switch on a cast agent, deliberately.** `killAgent` empties
`permissions.tools` and `tempScopes`; the reset writes the baseline back, so an operator
who kills Researcher during a rehearsal gets a scoped Researcher for the next one. That is
what a rehearsal reset is for, and it is the opposite of what the Kill switch section above
argues about resurrection, which is about the *agent's own* path back. **Zeon:** if the
durable dead-marker you floated there lands, this is the code that has to decide whether to
clear it. Refusing to reseed a tombstoned agent is the safer default.

**The seeded scopes are load-bearing, so read `FIXTURE_AGENTS` before changing them.**
Researcher gets `workspace:read` so Scene 1's deny is the missing *grant* (a card
`allow_always` can answer) rather than a missing scope, and `webhook:send` so Scene 2's
exfil attempt reaches the IFC check instead of stopping one step earlier.

**No grant and no RunToken are seeded, so `/demo/replay` does not work off a bare seed.**
Scene 1 is what writes the Writer→Researcher grant and Scene 2 consumes it; seeding one
would leave Scene 1 with nothing to deny. `demo.ts` also needs a live RunToken, which only
a real run mints. Run Scene 1, then send Researcher a message, and the replay has both.
**B2:** that is the order the fallback assumes.

**`credentials.json`'s fake token is shaped like a JWT (`eyJ…`) on purpose.** The pattern
list that scrubs it is `PATTERNS` in `audit.ts` today, not the `redact.ts` `docs/TEAM.md`
assigns to B3; `setRedactor()` is where that replacement lands. Either way the Scene 2
audit row shows `[redacted]` rather than the payload, and `seed.test.ts` pins it, so
flattening the fixture to a plainer fake value fails the suite instead of quietly putting
the payload back in the trail. **B3:** that test is also what tells you the new list still
bites on the demo path.

**Users are not seeded, because there is nowhere to seed them.** `Database` has no users
table; they come from `SEED_USERS` and are parsed at login. The seed instead *refuses* an
owner that `SEED_USERS` does not contain, before writing anything: an agent stamped with an
owner nobody can log in as is invisible to every session.

**CRM rows are not seeded either.** `docs/TEAM.md`'s Day 2 line for the seed asks for
them, but `crm_records` is Postgres and belongs to B3's `migrations/001_init.sql`, which
seeds two rows for Jean and one for Alex. Seeding them from here would need a second
connection and would duplicate that file's rows on every run.

**`npm run poc` does not seed.** It exports `APP_DATA_DIR` / `AGENT_WORKSPACE_ROOT` into
its own process only, so `npm run seed` from a second shell writes the *defaults*
(`.data`, `workspaces`) instead of the running server's state. Pass the same two variables,
or run it before `npm run poc`. The command prints both resolved paths for exactly this
reason. Auto-seeding on boot is deliberately not wired: it would reset the demo state in
the middle of a rehearsal.

---

## Natural-language grants (`nl-grant.ts`, B1's file)

**Landed (B1, ticket 08):** `POST /api/grants/parse {text}` → `201 {approval}` with
`source:"nl_intent"`, per `docs/API.md`. The stretch item, and the first thing on
CLAUDE.md's cut list.

**The card is the gateway's card with a different badge.** `kind:"grant"` and the same
`grant` payload `gateway.ts` builds on a no-grant deny, so `decideApproval` writes the
PolicyGrant without knowing which raised it. A test approves an nl_intent card with
`allow_always` and asserts the grant lands, so a change to the payload shape fails there
rather than on stage.

**`resource` and `action` are byte-identical to `gateway.ts`'s `grantCard` on purpose.**
`createCardOnDeny` dedupes on `(agentId, kind, resource, action)`, so a second format for
the same access would put two cards in front of the operator for one decision. The
consequence: after a Scene 1 live deny, a parse request for the same grant **returns that
pending card unchanged**, badge and all. Right behaviour, one pending decision per access,
but the route then answers **`200`, not the `201` `docs/API.md` pins**, because nothing was
created. **Zeon:** the contract line wants that 200, and the `404` / `422` this route can
also answer.

**`allow_run` is refused on an nl_intent card, with a 409.** `runId` and `jti` are `null`
because no run asked, and `approvals.ts`'s grant branch resolves the run window through
`card.jti` with **no fallback when it is null** (its scope branch has one, which is what
makes this easy to misread). So `allow_run` would write `expiresAt: null`: a permanent
grant from the narrower button. `AgentService.decideApproval` fails closed instead.
**Zeon:** a `?? tenMinutesFromNow` in that branch retires the guard, and it is the only
reason these cards cannot take all three buttons. Gateway cards, which always carry a
`jti`, are untouched by the guard.

**The guard names `kind:"grant"`, and that is not because the scope branch is safe.** It
reads `card.jti` too; it merely has the fallback the grant branch lacks. The guard is
narrow only because `gateway.ts` is today the sole source of `kind:"scope"` cards and it
always passes `ctx.jti`. **If you add a card source that can mint a scope card without a
run, widen this guard with it.**

**Names resolve inside the caller's own agents, and this route can reach no others.** Agent
names are not unique between tenants, so a store-wide lookup would mis-hit (Alex may also
have a "Writer") and would answer whether another tenant owns a given name. Filtering to
the caller first removes both. **The consequence is a deliberate deviation from CLAUDE.md
rule 3:** an unknown name is `404` and writes no RunEvent, and there is no cross-tenant
`403` on this route at all, because nothing cross-tenant is visible to refuse. Rule 3
governs reaching an existing resource by id; here no id is ever supplied. **F:** do not
render a 404 from this route as "no such agent anywhere". It means "you have no agent by
that name".

**`gateway.ts:125` answers the same input class differently, and that is not an oversight
to reconcile away.** There a name that resolves to another tenant's agent is a `403` plus
an audit row. The actor differs: the gateway is an *agent* reaching for a target, which is
an attempt worth seeing in the timeline, while this route is a *human* naming agents in
their own namespace. **Zeon:** if you want them uniform, the gateway's behaviour is the one
to keep, and this route would need an audited 403 that also reintroduces the
name-existence oracle. Worth a decision, not a silent drift.

**Workspace grants only, and exactly one action.** `crm_read` / `crm_write` are gated on
scope alone and never call `findLiveGrant`, so a PolicyGrant on `crm` is a row nothing
reads: an approval that looks like it worked and changes nothing. The parser therefore
refuses to produce one, and refuses two actions at once, so the card's `action` stays the
single token every other card and timeline row uses. **Zeon:** if CRM ever becomes
grant-gated, this is where the NL path opens back up.

**The model's answer is untrusted input.** Ark is asked first when `isArkConfigured`, and
whatever comes back is validated against the same zod schema the grammar output is, before
any name is resolved. Every Ark failure mode (unreachable, timeout, non-200, malformed
JSON, a schema the model ignored) returns `null` so the grammar still gets a go, and the
call carries a 10s `AbortSignal.timeout`.

**The Ark request shape is not verified against a live endpoint.** It posts to
`${arkBaseUrl}/responses` because that is what `llm-proxy.ts` forwards to and what
`writeCodexConfig` sets `wire_api` to, rather than introducing a second convention. If Ark
rejects it, the demo still works off the grammar and nobody notices in the room. **B2:**
you own the Ark wire format; this is the second caller.

**Nothing in the suite reaches the network.** `parseGrantIntent` takes the fetch as an
argument, and `AgentService` takes the parser as an optional constructor argument, so route
tests run with Ark unconfigured. `makeHarness(prefix, env)` gained an env override for
exactly that.

**The caller's prose never reaches a RunEvent.** The card creation logs `kind:"approval"`,
`decision:"pending"`, `reason:"nl_intent"` and the text's *length*. The text is human prose
that may contain anything, including an injection aimed at whoever reads the trail.

---

## Codex runtime version (`Dockerfile.runtime`, B2's file)

**Compatibility pin (verified 2026-08-29):** the runtime uses Codex `0.100.0`, deliberately
not PLAN/TEAM's `0.144.6`. Codex `0.130.0` and `0.144.6` discover Launchpad successfully
(`initialize` and `tools/list` both return 200) but serialize the MCP server into the Ark
Responses request as `{type:"namespace", name:"mcp__launchpad..."}`. Ark rejects the whole
request with `InvalidParameter: unknown tool type: namespace`, so the model never sees
`workspace_read` and no gateway/card event can occur.

`0.100.0` was tested through a host-side diagnostic model proxy that logged tool names and
types only: it emitted `{type:"function", name:"mcp__launchpad__workspace_read"}`, Ark
accepted the request, and Codex completed `tools/call`. It also sends the configured
`http_headers` Agent JWT and honors `enabled_tools`. Do not bump Codex without an actual Ark
round-trip that proves those three behaviours; argument snapshots alone cannot detect this
provider incompatibility.

---

## Postgres / LOCK 2 (`docker-compose.yml`, `migrations/001_init.sql`, `db.ts`, B3's files)

**Landed (B3):** the `postgres` service, `001_init.sql`, and `db.ts`'s `withOwner`, plugged
into the `withOwner` slot `gateway.ts`/`index.ts` already had waiting (see the gateway
section above). `crm_read`/`crm_write` are real now, not just "unavailable".

**Host port is 5433, not Postgres's usual 5432.** A dev machine may already have a local
Postgres bound to 5432 (this repo's own reference machine did) — 5433 avoids fighting it
for the port. The container's *internal* port is still 5432; only the host-side mapping
moved. `DATABASE_URL_ADMIN`/`DATABASE_URL_AGENT` in `.env.example` and
`start-local-poc.sh`'s defaults both already say 5433 — if you're constructing either
string yourself instead of reading the exported env var, don't hardcode 5432.

**`crm_records` has a `UNIQUE (owner_id, customer)` constraint that `docs/PLAN.md`'s
schema sketch didn't call out.** `gateway.ts`'s `crm_write` does `INSERT ... ON CONFLICT
(owner_id, customer) DO UPDATE` — found by reading that code before writing the migration,
not by the schema sketch, which has no such constraint. Without it the upsert throws
"no unique or exclusion constraint matching ON CONFLICT specification" the first time
anyone actually calls `crm_write`. If `crm_records` ever needs a schema change, keep this
constraint or `crm_write` breaks again the same way.

**`SET LOCAL app.owner_id = $1` is a Postgres syntax error — `SET` never takes bind
parameters, only literals.** `withOwner()` uses `SELECT set_config('app.owner_id', $1,
true)` instead: the parameterized equivalent, `true` meaning transaction-scoped exactly
like `LOCAL`. This is not a style choice. The tempting "fix" — building the `SET LOCAL`
statement by splicing the owner id into the SQL text — would reopen the SQL-injection hole
`withOwner` exists to close, in the one function every crm_* call trusts for tenant
isolation. Pinned in `rls.test.ts` and `db.ts`'s own comment; don't rewrite this call as a
plain `SET LOCAL` no matter how the error message reads.

**`app_admin` (`BYPASSRLS`) is not used anywhere in the gateway path.** It exists for admin
tooling and tests that legitimately need to see across owners. `withOwner()` — the only
thing `crm_*` tools call — always runs as `app_agent` (`NOBYPASSRLS`), so RLS is load-
bearing on every gateway call, not just nominally present.

**Two independent tests exist for this, at different layers, and they answer different
questions.** `rls.test.ts` proves the Postgres policy holds on its own — raw SQL, no
gateway, no app code, gated on `DATABASE_URL_AGENT`. `crm-gateway.test.ts` proves LOCK 1
(gateway scope/grant checks) and LOCK 2 (RLS) hold *together*, the way a real Codex tool
call exercises them: two owners, both passing every gateway-side check identically, one
still can't see the other's row. If you're extending `crm_read`/`crm_write`, the second
file is the one to add a case to; the first is about the policy, not the tool.

**`start-local-poc.sh`'s Postgres-readiness check polls the container's Docker healthcheck
via `docker inspect`, not `docker compose exec ... pg_isready`.** The `exec` form was tried
first and was unreliable in this specific non-interactive script context — it looped
through all 30 retries and never reported ready, even though the same `pg_isready` command
run directly in a shell succeeded instantly. Root cause not fully chased down (likely a
`docker compose exec` + non-tty/scripted-invocation interaction); `docker inspect -f
'{{.State.Health.Status}}'` against the container id from `docker compose ps -q postgres`
sidesteps it entirely and is what's in the script now. If you're touching that wait loop,
don't switch it back to the `exec` form without confirming it actually reports ready in a
plain `npm run poc` run, not just when typed by hand — the two behaved differently here.

---

## Redaction (`redact.ts`, B3's file, wired via `audit.ts`'s `setRedactor()`)

**Landed (B3):** `setRedactor(redact)`, called once in `index.ts` at startup, replaces the
placeholder pattern list that was living directly in `audit.ts` (see the gateway section
above — Zeon left it there on purpose, commented as B3's to replace).

**Redact BEFORE truncating, not after — the placeholder had this backwards.** The old
order truncated a string at 2KB first, then ran the redaction patterns over what was left.
A secret straddling the 2048-char cut would get sliced mid-token by the truncation, and a
half-token no longer matches the pattern meant to catch it — the fragment ships to the
trail unredacted. `redact.ts` runs the patterns first and truncates whatever's left, so
truncation only ever trims content that's already been swept. Pinned in `redact.test.ts`.

**`setRedactor()` is only called from `index.ts`, which tests never import.** Test files go
through `test-harness.ts`/`makeHarness()`, not the real entrypoint, so `audit.ts`'s
placeholder pattern list is still what's active during `npm run test` — including
`seed.test.ts`'s pinned check that the fake-JWT `credentials.json` fixture gets redacted.
That's fine and deliberate: the placeholder list already covers the same four patterns, so
nothing in the suite is testing stale behavior, and confirmed by hand — the real `redact.ts`
was checked directly against the compiled `dist/audit.js` + `dist/redact.js` the running
server actually uses, not inferred from the unit tests alone. If the pattern list ever
needs to diverge between the two, that divergence is invisible to `npm run test` and would
need its own test wired through `setRedactor()` to catch.

---

## IFC fingerprint persistence (`ifc.ts`, Zeon's file — B3 extended it, not replaced it)

**Landed (B3):** `index` (the in-memory shingle-hash `Map` Zeon left as a deliberate
placeholder, comment: *"B3 may replace with a persistent one"*) is still there and still
what every request-path lookup reads — `matchOrigin()` stayed synchronous on purpose, since
it runs mid tool-call inside `egressGate()` and can't await a store round-trip. What
changed is that `fingerprint()` now writes through to the store (hashes + label, never the
raw content) on every call, and a new `loadFingerprints(store)` rehydrates the cache from
those rows once at startup — `index.ts` calls it right after `service.initialize()`, before
the gateway is registered. Net effect: a server restart mid-demo no longer silently drops
Scene 2's provenance data, without adding a single `await` to `gateway.ts`'s tool handlers.

**The one call site that had to change:** `fingerprint(ctx.run, label, text)` in
`gateway.ts` became `fingerprint(store, ctx.run, label, text)` — `store` was already in
scope in that closure, so this is the only line touched in a file B3 doesn't own.
`matchOrigin()` and `checkEgress()` kept their exact signatures; nothing else in
`gateway.ts` needed to change.

**`Database` gained a `fingerprints: FingerprintEntry[]` field** (`types.ts` — Zeon's
shared contract, extended the same cautious way B1's `ownerId`/`permissions` additions
were: additive, with a default in `store.ts`'s `emptyDatabase()` so a v1 or v2 file with no
`fingerprints` key loads exactly as before). **Only ever hashes + a `Label`, never the
content that produced them** — the whole point of a "fingerprint" here is that the index
itself can't become a second copy of whatever secret it's tracking. `store.test.ts`'s
pinned v2-migration fixture needed the same one-line addition to keep matching the new
shape; that test's assertions are otherwise untouched.

**Persistence is fire-and-forget, not awaited.** `store.mutate()` queues and persists
atomically on its own (see `store.ts`), so `fingerprint()`/`clearFingerprints()` call it
without `await` and swallow a failed write. A lost write degrades to "this one read has no
persisted provenance if the server restarts right now" — never to a blocked tool call, and
never to the hot cache disagreeing with what's on disk in the meantime, since the cache is
always updated synchronously first, before the store write is even queued.

**`clearFingerprints(store, runId)` still has no caller anywhere in the codebase** — that
predates this change (it was already unused when `index` was in-memory-only) and is still
true now. The in-memory cache and the persisted rows both grow unbounded across a long
session; not fixed here, since wiring a call site (most likely on run completion, in
`agent-service.ts`) is B1's file to touch. Flagging it rather than adding an uninvited call
site.

**New test file, `ifc.test.ts`** (not gated — no Postgres/Docker involved, pure `JsonStore`
+ `ifc.ts`): proves persisted rows contain hashes and a label but never the original text,
and — the one existing `gateway.test.ts` Scene 2 test can't show — that `matchOrigin()`
genuinely fails after the in-memory cache is cleared and genuinely recovers once
`loadFingerprints()` reloads it from the store, i.e. that this actually survives a restart
rather than merely compiling.

---

## Info tagging / security levels (`classify.ts` new, `types.ts`, `ifc.ts`, `gateway.ts` — Zeon's files)

**Landed (Zeon):** every gateway read is classified (`public < internal < confidential <
secret`, `SECURITY_LEVELS` in `types.ts` — compare with `classify.ts`'s `levelRank()`,
never by string), `Label` gained a `level`, and `ifc.ts` gained `screenOutput()`: chat
output is the **third egress surface**. Tool calls were already gated by `checkEgress`;
the run's *final output* becomes a stored chat message and was never checked, so a
prompt-injected agent could simply print what it may not send.

**What the levels mean here.** `confidential` = provenance (grant-scoped reads, CRM) —
egress for *tool calls* stays entirely with taints/`checkEgress`, unchanged. `secret` =
the content detectors fired (credentials-shaped). Only `secret` is withheld from chat at
the default threshold: the owner reading their own grant-approved data in their own chat
is the product working, but a stored/screenshotted chat message must never carry a
credential, even toward the owner.

**Reads of the agent's own *workspace* fingerprint at `secret` only, and never taint.**
`tagSelfRead` in `gateway.ts` writes a `{grantId: "self"}` label with full egress, so
Scene 5 ("agent keeps working") and every existing egress behaviour are untouched; the
fingerprint exists solely so `screenOutput` can catch the content being printed. Grant
reads fingerprint always (as before) and their taints now carry `level`.

**CRM reads used to come through `tagSelfRead` too, and no longer do** — see "The
owner's own CRM" section at the end of this file. The sentence above is now about the
agent's own workspace only.

**`matchOrigin()` now returns the highest-level match, not the first.** Its one other
caller (`egressGate`'s deny message) only reads `origin`/`grantId`, so this is
behaviour-compatible — but if you add a caller that cares *which* of several matching
labels comes back, that's the rule.

**Old persisted rows lack `level`.** `loadFingerprints()` defaults them to `"internal"`
on load; old `RunToken.taints` are never read for level (only fingerprints are), so they
need no migration. `store.ts` untouched.

**`classify.ts`'s `SECRET_PATTERNS` mirrors the redaction list on purpose and is
deliberately a separate list** — redaction scrubs the audit trail, classification flags
live content. **B3:** when `redact.ts`'s patterns grow, grow these with them (and note
they carry no `/g` — a global regex's `lastIndex` makes `.test()` stateful; `scrubSecrets`
adds `g` per call).

**Wired (item 1, `agent-service.ts`).** `screenOutput(run.id, result.output)` runs in
`executeRun` between `runner.run()` returning and the completion `store.mutate`, and
`screened.output` — not `result.output` — is what persists as both `run.output` and the
assistant message. A non-`allow` verdict writes one `kind:"gateway", action:"output",
resource:"chat", decision:"deny"` RunEvent, `reason` = the verdict, `detail` =
`{level, origin}` and never the output. **Deny rows only**, the deviation from the
gateway's every-branch rule this section already argued for.

**The event is written *before* the completion mutate, deliberately.** If `recordEvent`
threw after it, `executeRun`'s catch would mark a run `failed` whose output had already
persisted as `completed`. Ordering it first means a failure leaves nothing half-written.

**`clearFingerprints(store, runId)` still has no caller,** and this was the obvious
place. Calling it here would empty the index the screen has just read — and, if moved
before, would defeat the screen entirely. Left uncalled; the index still grows unbounded
across a session (see the IFC persistence section above).

**F:** a run whose output was screened shows a deny row in the *policy* timeline with
`resource: "chat"`. It is not a tool call and names no tool.

**The threshold is a defaulted parameter (`"confidential"`), not config, still.** If an
operator knob is wanted, it's `OUTPUT_MAX_LEVEL` as one line in `config.ts`'s schema
(**B2's file**, the documented one-liner), shape-validated in `classify.ts`. Setting it
to `"internal"` makes confidential copied-through content block too — pinned in
`ifc.test.ts`.

---

## Task-scoped permissions — REMOVED (was `scope-estimator.ts`, `agent-service.ts`, `config.ts`, `index.ts`)

**Landed (item 2), removed 2026-08-30.** The estimator narrowed `RunToken.scp` to
`effectiveScopes(agent) ∩ estimate(prompt)` and raised an up-front `source:"nl_intent"`,
`kind:"scope"` card per scope the estimate wanted and the agent lacked. In practice the
estimate over-asked — a read-only task drew a `workspace:write` card (the keyword
grammar's no-match fallback was the workspace *pair*, and the Ark path could over-include
on its own judgment) — so the operator saw spurious cards for scopes no task needed. The
whole layer is out.

What "out" means on the seams:

- `RunToken.scp` is `effectiveScopes(agent)` again (tools ∪ live tempScopes), exactly the
  pre-estimator mint. The tempScopes union that the narrowing had to special-case is just
  `effectiveScopes` doing its normal job now.
- `PERMISSION_ESTIMATOR_ENABLED` is gone from `config.ts` and `.env.example`.
- `AgentService`'s constructor is back to five arguments; the 5th (`parseGrantIntent`) is
  the last, and `index.ts` passes only the first four.
- **`gateway.ts` is once again the sole source of `kind:"scope"` cards, and it always
  passes `ctx.jti`** — so the NL-grants section's `allow_run` guard note above holds as
  written, with no exception to remember. `approvals.ts`'s scope branch is untouched; it
  still serves the gateway's cards.
- The "⚠ This changes demo Scene 2" consequence this section used to carry is reverted:
  `webhook:send` from `seed.ts` stays on the token, Scene 2's exfil attempt reaches the
  IFC check live, and `/demo/replay` works again with no env-var caveat.

The rule the estimator implemented (Progent: removing permissions is automatic, adding
one always needs a card) still holds everywhere else — nothing that remains widens a
scope, a trust, or a destination without a human. If narrowing comes back, the two traps
this section used to pin are: live `tempScopes` must survive the narrowing (or the
"Allow for this run" card livelocks), and the up-front cards need a real `jti` (or
`decideApproval`'s `allow_run` guard must widen).

---

## Scoped declassification (`types.ts`, `gateway.ts`, `approvals.ts`, `store.ts`)

**Ownership note first: `types.ts` was edited from this workstream.** CLAUDE.md rule 7
and `docs/TEAM.md` make it the shared contract nobody edits unilaterally; this whole
feature was handed here, so `RunToken.egressAllow` landed directly. Additive with a
default in `store.ts`'s migration, the same shape B3's `fingerprints` addition took.
**Zeon:** `docs/API.md` says nothing about `egressAllow` and nothing needs it to — no
route exposes the field.

**Landed (item 3):** `RunToken.egressAllow: string[]`, checked as the first thing
`egressGate` does after it re-reads the token. `resource` is already that function's
parameter: the URL for `webhook_send`, `"<name>/workspace"` for `workspace_write`.

**The two declassify buttons now mean different things, deliberately.** "Allow for this
run" used to push the destination *class* onto the taints, so approving "post this to
our team webhook" also permitted every other external URL for the rest of that run — an
attacker's included. It now writes the one destination the human actually looked at into
`egressAllow` and touches no taint. "Always allow" is unchanged: the human making a
standing policy statement, so it widens the grant's `egress` (and the matching taints,
so the current run proceeds).

**`checkEgress` stays payload-blind and untouched.** The `egressAllow` check is a
separate line *before* it, keyed on the resource, never on anything read out of the body.

**Rows written before the field default to `[]` in `migrateDatabase`.** The migration
only mapped `agents` before; `runTokens` now gets the same treatment, because
`approvals.ts` pushes into the array and `undefined` would throw on the first approval
after an upgrade. Pinned in `store.test.ts`.

**The existing Scene 2 test still passes unchanged** — it approves and re-calls the same
URL, which is exactly the behaviour that survives. Two new gateway tests pin what
changed: destination B is still `403 ifc` after A was approved, and `allow_always` still
widens the grant.

---

## Trust label (`types.ts`, `gateway.ts`, `ifc.ts`, `approvals.ts`, `grants.ts`, `store.ts`, web)

**Landed (item 4):** content now carries a second tag saying whether it can be
*believed* — `Label.trust` — beside the one saying how sensitive it is. Untrusted
content cannot trigger an outbound action without a human. This catches the case
confidentiality cannot see at all: an agent hijacked into an action that leaks nothing
(FIDES, arXiv 2505.23643).

**The tag is decided by the channel the content arrived on, never by reading it.** Own
workspace and own CRM → `trusted`. A borrowed workspace read → `grant.trustContent`,
default `false`. **Do not put a model in this decision.** A model asked "is this
trustworthy?" is reading attacker-controlled text, and the attacker can simply write the
answer.

**The integrity check runs *after* `checkEgress`, inside `egressGate`, and order is
load-bearing.** Scene 2's exfil attempt is a borrowed read going external, which now
trips both halves; confidentiality first keeps that a `DENIED (ifc)` with the origin
named, which is the line the scene narrates and what `gateway.test.ts` pins.

**It applies to genuinely outbound surfaces only — `egressGate`'s new `outbound`
parameter.** `webhook_send` and `crm_write` always; `workspace_write` only when the
target is *another* agent's workspace. A write into the agent's own workspace is scratch
space inside the trust boundary, and holding it back would stop a run the moment it read
anything borrowed — Scene 5's "the agent keeps working on the rest" would break.

**A declassify card now carries one of two `reason` prefixes.** `grant:<id>` is the
confidentiality deny it always was; `integrity:<id>` is new. `approvals.ts` reads them
apart because approving means different things: `allow_run` writes `egressAllow` for
both (the human approved *this* destination for *this* run, and `egressGate`
short-circuits on it before either check), while `allow_always` on an integrity card
sets `grant.trustContent = true` and marks that grant's live taints trusted — a standing
statement about the source, not about the destination class.

**`allow_run` does collapse the two labels for that one destination**, and that is worth
knowing: `egressAllow` short-circuits `egressGate` *before* both checks, so approving a
confidentiality card also clears integrity for that destination in that run, and vice
versa. Defensible — the human looked at that exact flow and approved it — but it is the
one place the two labels are not independent. If you want them separated, the change is
two lists rather than one, and both checks reading their own.

**`addTaint`'s dedupe key is now `grantId + "|" + origin`.** `grantId` alone was fine
while every label came from a grant; `"self"` labels made it collapse distinct reads
into one. Pinned in `ifc.test.ts`, both directions.

**Two migrations, both to the safe side.** `Label.trust` defaults to `"untrusted"` on
load — in `migrateDatabase`'s new `runTokens` mapping (nested inside the `egressAllow`
one, not a second pass) and in `loadFingerprints` beside its existing `level` default.
`PolicyGrant.trustContent` defaults to `false`; undefined was already falsy, but the
type was lying about a field `gateway.ts` reads on every borrowed read.

**`POST /api/grants` accepts `trustContent`, and `docs/API.md` does not mention it.**
Optional, defaults false, so every existing caller is unaffected. **Zeon:** the contract
line wants it.

**The checkbox lives on the Access Request Card, not on a grant form.** There is no
create-grant form in `App.tsx` — grants are only ever created from a card or from
`POST /api/grants/parse` — so "Trust content from this source" is rendered on the card
itself, and only for `kind: "grant"`, which is the only card that creates a source the
agent will later read from. It rides both allow buttons; **Deny always sends `false`**.
The approval toast has no checkbox and passes `false`, because a one-line toast is not
where a trust decision should be made. Each grant row also shows `content: trusted` /
`content: untrusted` as evidence after the fact.

**`POST /api/approvals/:id/decide` gained an optional `trustContent` boolean**, threaded
`app.ts` → `AgentService.decideApproval(id, decision, byOwner, options)` →
`approvals.ts`'s grant branch → `createGrant`. Every existing caller omits it and gets
`false`. **Zeon:** `docs/API.md` §Approvals does not mention the field. Pinned both ways
in `policy-routes.test.ts` (ticked → `trustContent: true` on the written grant; body
without the key → `false`).

Editing `App.tsx`, `api.ts`, `styles.css` and the web `types.ts` is a deviation from
`docs/TEAM.md`, noted for the same reason `types.ts` is above.

---

## The owner's own CRM is tainted now (`gateway.ts`, `approvals.ts`, `grants.ts`)

**This reverses a decision two sections above deliberately left open.** `tagSelfRead`
fingerprinted own-resource reads and never tainted them, so reading your own customer
records and posting them to an external webhook succeeded. The owner asked for it
closed; it is closed.

**What `crm_read` does now.** It adds a taint, `origin: "<ownerId>/crm"`, `egress` from
a live tenant-level CRM grant if one exists and `["internal"]` otherwise, `level` from
`classify("crm", …)`, `trust: "trusted"` (own tenant, inside the boundary — integrity is
unaffected). It still fingerprints, so the output screen keeps working.

**What that does and does not stop.** `internal` is still permitted, so `crm_write` and
a write into the agent's own workspace are untouched — Scene 5's "keeps working on the
rest" holds, and `crm-gateway.test.ts` (DB-gated) does exactly that pair. What now needs
a human: `webhook_send` (`external`) and a write into another agent's workspace
(`agent`), both `403 ifc` naming `user-jean/crm`, both raising a declassify card.

**`OWN_CRM_LABEL` (`"self:crm"`, exported from `grants.ts`) is not a grant id.** Nothing
in `policyGrants` has it. It is what the taint carries when the owner has written no
standing CRM grant, and `approvals.ts` recognises it: **"Always allow" on such a card
creates the tenant-level grant** (`fromAgent: null`, `resource: "crm"`,
`actions: ["read"]`, `egress: ["internal", <dest>]`) that later reads then pick their
egress up from. Without that the button would have nothing to widen and would silently
behave like the narrower one. The `createGrant` call sits **outside** the surrounding
`store.mutate`, because it mutates itself.

**This makes a `resource: "crm"` PolicyGrant a live row for the first time.** The
NL-grant section above says a CRM grant is "a row nothing reads" and refuses to produce
one. That is still true for *access* — `crm_read`/`crm_write` are gated on scope alone
and never call `findLiveGrant` for permission — but it is no longer true for *egress*.
**Zeon:** if you want the NL path to open up here, that is the line that changes.

**Tested without Postgres.** `gateway.test.ts` gained a describe block that stubs
`withOwner` with two in-memory rows, so the gateway half (taint, deny, card, the
standing grant) runs in `npm run check`. The database half stays where it was, in
`rls.test.ts` and `crm-gateway.test.ts`. **Neither DB-gated file was run for this
change** — no Docker on the machine it was written on. Reasoning says they are
unaffected (their only outbound call is `crm_write`, which is `internal`), but that is
reasoning, not a green run. Worth one `npm run check:db` from someone who has Docker.

**Demo consequence, and it is a good one.** An agent that reads the CRM and tries to
post it out is now a live Scene 2 that needs no planted file at all. The card names
`user-jean/crm` as the origin.

---

## Taints survive the turn (`agent-service.ts`, `types.ts`, `store.ts`)

**The hole this closes, found in a live store.** Taints lived on the `RunToken`, and a
RunToken is minted per *message*. The Codex thread persists across turns, so the agent
still remembered what it read — but the next token was minted with `taints: []`. Read
under a grant on one message, send on the next, no block. Observed directly:
run `4a9e5e` read a borrowed workspace and carried `[user-jean/woof woof:internal]`;
run `0f25fa`, the very next message, carried `[]` and its `webhook_send` was allowed.
Within one run the machinery was always fine (`99231f` read the CRM and was denied
`ifc` on the same turn) — the boundary was the only problem.

**What it does now.** `sendMessage` carries `taints` forward from the agent's newest
prior RunToken while the conversation is the same one.

**`RunToken.threadId` is what "the same conversation" means**, set at mint from
`agent.codexThreadId` and **backfilled on completion** with the thread the run created.
The backfill is load-bearing and not obvious: a conversation's first run is minted
before any thread exists, so without it that token records `null` forever and every
later mint reads it as "same conversation" — including in a genuinely different thread
that remembers nothing. A `null` that survives means a run that never completed, and
that is treated as the same conversation: failing permissive keeps a label the agent may
still hold, failing strict drops it.

**`egressAllow` is deliberately NOT carried.** It is a human approving one destination
for one run, and carrying it would silently extend that approval past the run they
approved. Pinned in `agent-service.test.ts`.

**What this does NOT close: laundering through storage.** An agent can read a borrowed
file and `workspace_write` a copy into *its own* workspace — permitted, because that
destination is `internal` and the taint allows `internal`. Own-workspace reads go
through `tagSelfRead`, which never taints. So the copy is clean data, and no run-scoped
or conversation-scoped label can see it: start a new conversation, read the copy, send
it anywhere. **Closing that needs the label on the file** — `workspace_write` recording
the run's taints against the written path, and `workspace_read` re-applying them. That
is the real fix and it is not in. Two individually reasonable rules compose into the
hole, which is why it is worth writing down rather than leaving to be rediscovered.

**The output screen still resets per turn.** `screenOutput` finds provenance through
`matchOrigin(runId, …)`, and the fingerprint index is keyed by `runId`, so a credential
read on one turn and printed on the next is not caught. Carrying that would mean either
copying fingerprint rows to the new run or making the index conversation-scoped —
`ifc.ts`, not done here.

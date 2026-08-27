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

**`POST /api/grants/parse` will hit the `:id` trap.** It matches the `/api/grants/` prefix,
finds no `id` param, and throws 500 before the handler runs. Whoever builds the NL stretch
route: give the ownership gate an exemption, or mount the route somewhere that does not
match a guarded prefix. `POST /api/grants` and `GET /api/approvals` are fine — no trailing
slash, so no match — and they check the owner inside `createGrant` / `listApprovals`.

**`fromAgent` is required and nullable, not optional** (`null` = the owner's own CRM, which
has no source agent). Sending `{}` is a 400, not a CRM grant.

**Grant failures split three ways, and F should render them apart:** `404` unknown agent ·
`403` the recipient is not yours · `400` the source agent is another tenant's (D7,
intra-tenant only). **The 403 and the 400 both write a RunEvent; the 404 does not.**
`createGrant` refuses both cross-tenant reaches silently, and the route names no id for the
ownership gate to guard, so `AgentService.createGrant` writes the row before delegating.
CLAUDE.md rule 3 is about the *attempt*, not about which preHandler catches it — a
cross-tenant reach at an agent that exists is audited whatever status code the contract
gives it.

**`filter` defaults to `policy`** = kinds `gateway, approval, grant`; `all` adds
`command, file_change, mcp_call, llm`. Both are ordered oldest-first by `at`.
`GET /api/agents/:id/events` takes `limit` (default 200) and keeps the **newest** rows when
it bites, still in `at` order.

# API contract — Identity & Authorization middleware

Route and type reference for the Identity & Authorization middleware. Types are in
`apps/server/src/types.ts`.
Every `/api/*` route requires a **human JWT** (`Authorization: Bearer …`) except `/api/health` and `/api/auth/login`.
Every gateway/proxy route requires an **agent JWT**.

## Auth (`auth.ts`)

| Route | Body | Response |
|---|---|---|
| `POST /api/auth/login` | `{ userId: "user-jean" \| "user-alex" }` | `200 { token, user: { id, name } }` · `401 { error }` unknown user · `400` malformed |
| `GET /api/auth` | — (open) | `200 { required: true }` — baseline UI boot probe |
| `GET /api/health` | — (open) | `200` |

Every other `/api/*` route needs `Authorization: Bearer <token>` → else `401 { error }`. Token expires after 8 h: a 401 on a route that worked = expired → clear it, show the login bar.
Human JWT claims: `{ sub, typ:"human", exp }`. Agent JWT claims: `{ sub:agentId, typ:"agent", own:ownerId, run:runId, jti, scp:Scope[], exp }`.

`auth.ts`:
```ts
signHuman(config, userId): Promise<string>
signAgent(config, { sub, own, run, jti, scp, expiresInSeconds }): Promise<string>
verifyToken(config, raw, "human"): Promise<HumanPrincipal | null>   // { typ, userId }
verifyToken(config, raw, "agent"): Promise<AgentPrincipal | null>   // { typ, agentId, ownerId, runId, jti, scp }
```
`verifyToken` returns **null** on every failure (never throws); the expected type is an argument, never read off the token. `request.principal` carries the human principal on `/api/*`. The gateway adapts `AgentPrincipal` into its own `AgentClaims` in `index.ts`.

**Minting** (in `AgentService.sendMessage`, inside the existing `store.mutate`): the RunToken's
`scp` (scopes) starts from the agent's standing scopes (`permissions.tools` ∪ live `tempScopes`),
narrowed to what the task's estimator thinks the prompt needs — an empty estimate means no
opinion, so the standing scopes pass through unchanged. Any live `tempScopes` (an earlier "Allow
for this run" click) always survive the narrowing. The row also records `estimated` (what the
task looked like it needed) and `withheld` (standing scopes this run didn't get), the taints
carried forward from the previous token in the same Codex thread, and an empty `egressAllow` —
per-run human approvals are never carried across runs. If the estimate needs a scope the agent
doesn't hold at all, a card is raised *before the run starts* (`source:"nl_intent"`,
`kind:"scope"`, one card per scope). The signed agent JWT and the projected permissions
(`tools: [...scp, ...withheld]`) are passed into `executeRun`. The model's tool menu is
`scp ∪ withheld` — a withheld tool stays visible so an attempt produces a deny and a card as
evidence, but the gateway checks the token's `scp`, so offering it grants nothing.

## Ownership (`app.ts`)

`preHandler` on every `/api/agents/:id*`, `/api/runs/:id*`, `/api/grants/:id*`, `/api/approvals/:id*`:
unknown id → `404` (not logged) · exists but `ownerId !== principal.sub` → `403 { error }` **+ RunEvent** `{kind:"gateway", action:"api:<method>", resource:"agent/<id>", decision:"deny", reason:"cross-tenant"}` (via `recordEvent` in `audit.ts`).
`GET /api/agents` returns only the caller's agents.

## Agents (`app.ts`)

`POST /api/agents` / `PATCH /api/agents/:id` body gains:
```json
"permissions": { "sandbox": "read-only"|"workspace-write", "network": true, "webSearch": false,
                 "tools": ["workspace:read","workspace:write","crm:read","crm:write","webhook:send"] }
```
All fields optional; defaults = `DEFAULT_PERMISSIONS` (`tools: []`). `PATCH` with `permissions` while the agent is `busy` → `409`.
`Agent` JSON now includes `ownerId`, `permissions`, `tempScopes`.

| Route | Effect |
|---|---|
| `POST /api/agents/:id/kill` | Kill switch: every active RunToken for the agent → `revokedAt=now`; `permissions.tools=[]` **and** `tempScopes=[]` (a leftover "Allow for this run" scope would hand itself to the next run); the agent's **pending cards are denied** (a stale "Always allow" clicked later would undo the kill); RunEvent `{action:"kill", decision:"deny", reason:"revoked-by-operator"}` carrying the interrupted run's `runId` when exactly one run was live. Container not killed (Stop does that). No busy guard — the kill must work exactly when the agent is busy. `200 { agent }` |
| `GET /api/runs/:id` | `200 { run, scopes: { active, withheld, estimated } }` — derived from the RunToken (never the row itself; it carries the `jti`). Drives the UI's "N of M tools active this run" |

## Grants (`grants.ts`)

| Route | Body / Response |
|---|---|
| `GET /api/agents/:id/grants` | `200 { grants: PolicyGrant[] }` — grants to or from this agent |
| `POST /api/grants` | `{ fromAgent: id\|null, toAgent: id, resource:"workspace"\|"crm", actions:["read","write"], egress?:["internal","agent","external"], trustContent?: boolean }` → `201 { grant }`. `404` unknown agent (unlogged) · `403` the recipient is not yours (audited) · `400` the source agent is another tenant's (audited — intra-tenant only). `fromAgent` is required and nullable (`null` = the owner's own CRM), not optional |
| `POST /api/grants/:id/revoke` | `200 { grant }`. Sets `revokedAt`; the grant's taints on every RunToken → `egress: []` |

`PolicyGrant`: `{ id, fromOwner, fromAgent, toAgent, resource, actions, egress, trustContent, createdAt, expiresAt, revokedAt }`. `trustContent` (default `false`) says whether content read under the grant may be *believed* — an untrusted taint blocks outbound actions (integrity) until a human approves.
Grants are checked **on every gateway call** (`findLiveGrant`) — never cached.

## Approvals / Access Request Cards (`approvals.ts`)

| Route | Body / Response |
|---|---|
| `GET /api/approvals` | `200 { approvals: ApprovalRequest[] }` — caller's tenant, newest first. The UI polls every 2 s |
| `POST /api/approvals/:id/decide` | `{ decision: "allow_run" \| "allow_always" \| "deny", trustContent?: boolean }` → `200 { approval }`. `trustContent` (grant cards only, default `false`) marks the created grant's content believable. `409` already decided, and `409` for `allow_run` on an nl_intent grant card (no run window to expire against) |
| `POST /api/grants/parse` | `{ text }` → `201 { approval }` with `source:"nl_intent"`, `status:"pending"` · `200 { approval }` when a byte-identical card is already pending (dedupe — nothing created) · `404` you have no agent by that name (names resolve inside the caller's tenant only; unlogged) · `422` unparseable. Workspace grants only, exactly one action |

`ApprovalRequest`: `{ id, source:"live_deny"|"nl_intent", kind:"scope"|"grant"|"declassify", agentId, ownerId, runId, jti, resource, action, scope, grant, reason, risk, evidence, status:"pending"|"allow_run"|"allow_always"|"deny", createdAt, decidedAt, decidedBy }`.
`risk` (`"routine"|"elevated"|"critical"`) and `evidence` (`{userAsked, attempting, outsideTaskScope, untrustedOrigin, classifiedOrigin}`) are computed server-side — `critical` is only ever the injection signature (outside the task estimate ∧ untrusted content held ∧ outward destination). The UI renders them, never derives them.
A declassify card's `reason` prefix names which check denied: `grant:<id>` (confidentiality) or `integrity:<id>` (untrusted content held).

Button semantics:
- **Allow for this run** (`allow_run`): `scope` → current RunToken.scp widened **and** `agent.tempScopes += {scope, expiresAt: token.expiresAt}` so the follow-up message's new run still has it · `grant` → PolicyGrant with `expiresAt = token.expiresAt` · `declassify` → `RunToken.egressAllow += resource` — the **one destination** the human looked at (a URL, a `"<name>/workspace"`), never the whole class, for both `grant:` and `integrity:` cards.
- **Always allow** (`allow_always`): `scope` → `agent.permissions.tools` · `grant` → permanent PolicyGrant (with `trustContent` if ticked) · `declassify` `grant:` → grant.egress widened (+ matching live taints, so the current run proceeds) · `declassify` `integrity:` → `grant.trustContent = true` + that grant's live taints marked trusted. On a card whose reason is `grant:self:crm` (the owner's own CRM, no standing grant yet) it **creates** the tenant-level CRM grant (`fromAgent: null`) with the approved destination in its egress.
- **Deny**: status only. All three write a RunEvent `{kind:"approval"}`.

Cards are created by the gateway on deny, by `sendMessage` at mint (`action:"run:<scope>"` for a scope the task needs but the agent lacks), and by `POST /api/grants/parse` — one pending card per `(agentId, kind, resource, action)`. There are no pattern-based cards.

## Events / timeline (`audit.ts`)

| Route | Response |
|---|---|
| `GET /api/runs/:id/events?filter=policy\|all` | `200 { events: RunEvent[] }` ordered by `at`. `policy` (default) = kinds `gateway, approval, grant`; `all` adds `command, file_change, mcp_call, llm` |
| `GET /api/agents/:id/events?filter=…&limit=200` | same shape, across runs — the full agent timeline |

`RunEvent`: `{ id, runId, agentId, ownerId, at, kind, action, resource, decision:"allow"|"deny"|"pending"|null, reason, detail }` — the row reads **human (ownerId) → agent → action → resource → outcome (decision/reason)**. `detail` is always passed through `redact()`.
Gateway `reason` values: `no-token, bad-token, unknown-token, revoked, expired, scope, no-grant, cross-tenant, unknown-agent, unknown-tool, path-escape, ifc, integrity, error`.
A run whose final output was screened writes one `{kind:"gateway", action:"output", resource:"chat", decision:"deny"}` row (`reason` = the verdict, `detail` = `{level, origin}`, never the output itself) — deny rows only, the one deviation from the every-branch rule.

## Gateway (`gateway.ts`, MCP streamable HTTP)

`POST /mcp` — JSON-RPC over HTTP (`Accept: application/json, text/event-stream`), stateless, `Authorization: Bearer <agent JWT>`.
`401` no/invalid/human token · `403` revoked/expired/unknown jti · otherwise MCP. `GET/DELETE /mcp` → `405`.

Tools (all five always listed; enforcement on call):

| Tool | Args | Scope | Resource / egress |
|---|---|---|---|
| `workspace_read` | `{ agent, path }` | `workspace:read` | own workspace (no taint; secret-shaped content is fingerprinted for the output screen), or another agent's with a live grant (adds a **taint**, `trust` from `grant.trustContent`) |
| `workspace_write` | `{ agent, path, body }` | `workspace:write` | own = `internal`, not outbound; another agent's = `agent` (grant + egress + integrity check) |
| `crm_read` | `{ customer? }` | `crm:read` | own tenant's `crm_records` via `withOwner(ownerId, agentId)` (RLS). Adds a **taint** `{origin:"<owner>/crm", trust:"trusted"}` — egress from a standing tenant-level CRM grant (`fromAgent:null`) if one exists, else `["internal"]` |
| `crm_write` | `{ customer, note }` | `crm:write` | `internal`, outbound (egress + integrity checked); upsert on `(owner_id, customer)` |
| `webhook_send` | `{ url, body }` | `webhook:send` | `external` — egressAllow short-circuit, then egress + integrity check, then the mock webhook sink |

Denied calls return `isError:true` with text `DENIED (<reason>): <message>. An Access Request Card is pending operator approval — tell the user, then retry after they approve.`

Registered as a plugin in `index.ts`. `GATEWAY_ENFORCE=false` skips the gateway's scope/grant/egress checks (LOCK 2's row-level security still holds independently) — see the README's Configuration table.

## Runtime projection (`codex-runner.ts`)

`buildCodexArgs(request, sandboxMode, workspacePath, gatewayUrl)` emits, from `request.permissions` / `request.token`:
```
-c sandbox_mode="<permissions.sandbox>"
-c sandbox_workspace_write.network_access=<permissions.network>
-c web_search="live"|"disabled"
-c mcp_servers.launchpad.url="<gatewayUrl>/mcp"
-c mcp_servers.launchpad.http_headers={Authorization="Bearer <token>"}
-c mcp_servers.launchpad.enabled_tools=[<tool names for permissions.tools>]      # menu only; gateway enforces
```
`permissions.tools` here is the runner projection `scp ∪ withheld` (see Minting above), not the agent's standing tools.
Codex is pinned to `0.100.0`: `0.130.0`/`0.144.6` serialize the MCP server into the Ark Responses request as `{type:"namespace"}`, which Ark rejects (`unknown tool type: namespace`) — the model would never see any tool. `0.100.0` emits `{type:"function"}`, sends the configured `http_headers` agent JWT, and honors `enabled_tools`; don't bump without a live Ark round-trip proving all three (see `docs/SEAMS.md`). Drop `--env ARK_API_KEY` only when `LLM_PROXY_ENABLED`.
`parseCodexEventLine` calls `request.onEvent({ runId, agentId, kind:"command"|"file_change"|"mcp_call", action, resource, decision:null, reason:null, detail })`.

## Data (`db.ts`, `migrations/001_init.sql`)

`withOwner(ownerId, agentId, fn)` — `BEGIN; SET LOCAL app.owner_id=$1; SET LOCAL app.agent_id=$2; await fn(q); COMMIT` as role `app_agent` (`NOBYPASSRLS`). `q(text, params) → { rows }`. Owner-only policy on `crm_records`; unique `(owner_id, customer)` for the upsert. Seed: user-jean 2 rows, user-alex 1.
`webhookSink(url, body) → { status }` — records to `data/webhooks.jsonl`, never leaves the machine.

## Demo (`demo.ts`)

`POST /demo/replay { agentId }` (human JWT, owner) — issues the injection-scenario gateway calls (`workspace_read notes.md` → `workspace_read credentials.json` → `webhook_send`) with the agent's **real** current RunToken, returns the three results + the events written. Deterministic fallback for the live-model version of the same scenario; see the README's reproduction steps.

# API contract — Identity & Authorization middleware

Shared contract for F (web), B1 (routes), B2 (runtime), B3 (data). Types are in `apps/server/src/types.ts`.
Every `/api/*` route requires a **human JWT** (`Authorization: Bearer …`) except `/api/health` and `/api/auth/login`.
Every gateway/proxy route requires an **agent JWT**.

## Auth (B1 — `auth.ts`)

| Route | Body | Response |
|---|---|---|
| `POST /api/auth/login` | `{ userId: "user-jean" \| "user-alex" }` | `200 { token, user: { id, name } }` · `401 { error }` unknown user · `400` malformed |
| `GET /api/auth` | — (open) | `200 { required: true }` — baseline UI boot probe; F removes it with the login bar |
| `GET /api/health` | — (open) | `200` |

Every other `/api/*` route needs `Authorization: Bearer <token>` → else `401 { error }`. Token expires after 8 h: a 401 on a route that worked = expired → clear it, show the login bar.
Human JWT claims: `{ sub, typ:"human", exp }`. Agent JWT claims: `{ sub:agentId, typ:"agent", own:ownerId, run:runId, jti, scp:Scope[], exp }`.

`auth.ts` (landed, B1):
```ts
signHuman(config, userId): Promise<string>
signAgent(config, { sub, own, run, jti, scp, expiresInSeconds }): Promise<string>
verifyToken(config, raw, "human"): Promise<HumanPrincipal | null>   // { typ, userId }
verifyToken(config, raw, "agent"): Promise<AgentPrincipal | null>   // { typ, agentId, ownerId, runId, jti, scp }
```
`verifyToken` returns **null** on every failure (never throws); the expected type is an argument, never read off the token. `request.principal` carries the human principal on `/api/*`. The gateway is wired in `index.ts` with a 4-line adapter from `AgentPrincipal` to the gateway's `AgentClaims`.

**Minting (B1, in `AgentService.sendMessage`)** — inside the existing `store.mutate`:
```ts
const standing = effectiveScopes(storedAgent);       // store.ts: permissions.tools ∪ live tempScopes
const estimated = await estimateScopes(prompt);      // scope-estimator.ts; [] = no opinion → scp = standing
const scp = estimated.length > 0
  ? [...new Set([...standing.filter(s => estimated.includes(s)), ...liveTempScopes])]  // narrowing never strips a human's "Allow for this run"
  : standing;
database.runTokens.push({ jti, runId, agentId, ownerId, scp,
  taints: carriedFromPreviousTokenSameThread,        // read on one turn, send on the next: still blocked
  egressAllow: [],                                   // NOT carried across runs — per-run human approvals
  estimated, withheld: standing.filter(s => !scp.includes(s)),
  threadId: storedAgent.codexThreadId,               // backfilled on completion for a conversation's first run
  issuedAt, expiresAt, revokedAt: null });
// a scope the estimate needs but the agent lacks raises a card BEFORE the run starts:
//   {source:"nl_intent", kind:"scope", action:"run:<scope>"} — one card per scope
// then: token = await signAgent(config, { sub, own, run, jti, scp, expiresInSeconds })
// pass { token, permissions: { ...storedAgent.permissions, tools: [...scp, ...withheld] } } into executeRun
// (menu = scp ∪ withheld: a withheld tool stays visible so an attempt produces a deny + card as evidence;
//  the gateway checks the token's scp, so offering it grants nothing)
```

## Ownership (B1 — `app.ts`)

`preHandler` on every `/api/agents/:id*`, `/api/runs/:id*`, `/api/grants/:id*`, `/api/approvals/:id*`:
unknown id → `404` (not logged) · exists but `ownerId !== principal.sub` → `403 { error }` **+ RunEvent** `{kind:"gateway", action:"api:<method>", resource:"agent/<id>", decision:"deny", reason:"cross-tenant"}` (use `recordEvent` from `audit.ts`).
`GET /api/agents` returns only the caller's agents.

## Agents (B1 — `app.ts`; existing routes unchanged plus)

`POST /api/agents` / `PATCH /api/agents/:id` body gains:
```json
"permissions": { "sandbox": "read-only"|"workspace-write", "network": true, "webSearch": false,
                 "tools": ["workspace:read","workspace:write","crm:read","crm:write","webhook:send"] }
```
All fields optional; defaults = `DEFAULT_PERMISSIONS` (today's behaviour, `tools: []`). `PATCH` with `permissions` while the agent is `busy` → `409`.
`Agent` JSON now includes `ownerId`, `permissions`, `tempScopes`.

| Route | Effect |
|---|---|
| `POST /api/agents/:id/kill` | Kill switch: every active RunToken for the agent → `revokedAt=now`; `permissions.tools=[]` **and** `tempScopes=[]` (a leftover "Allow for this run" scope would hand itself to the next run); the agent's **pending cards are denied** (a stale "Always allow" clicked later would undo the kill); RunEvent `{action:"kill", decision:"deny", reason:"revoked-by-operator"}` carrying the interrupted run's `runId` when exactly one run was live. Container not killed (Stop does that). No busy guard — the kill must work exactly when the agent is busy. `200 { agent }` |
| `GET /api/runs/:id` | `200 { run, scopes: { active, withheld, estimated } }` — derived from the RunToken (never the row itself; it carries the `jti`). The UI's "N of M tools active this run" |

## Grants (B1 routes → Zeon's `grants.ts`)

| Route | Body / Response |
|---|---|
| `GET /api/agents/:id/grants` | `200 { grants: PolicyGrant[] }` — `listGrants(store, id)` (grants to or from this agent) |
| `POST /api/grants` | `{ fromAgent: id\|null, toAgent: id, resource:"workspace"\|"crm", actions:["read","write"], egress?:["internal","agent","external"], trustContent?: boolean }` → `201 { grant }` via `createGrant(store, body, principal.sub)`. `404` unknown agent (unlogged) · `403` the recipient is not yours (audited) · `400` the source agent is another tenant's (audited — intra-tenant only). `fromAgent` is required and nullable (`null` = the owner's own CRM), not optional |
| `POST /api/grants/:id/revoke` | `200 { grant }` via `revokeGrant(store, id, principal.sub)`. Sets `revokedAt`; the grant's taints on every RunToken → `egress: []` |

`PolicyGrant`: `{ id, fromOwner, fromAgent, toAgent, resource, actions, egress, trustContent, createdAt, expiresAt, revokedAt }`. `trustContent` (default `false`) says whether content read under the grant may be *believed* — an untrusted taint blocks outbound actions (integrity) until a human approves.
Grants are checked **on every gateway call** (`findLiveGrant`) — never cached.

## Approvals / Access Request Cards (B1 routes → Zeon's `approvals.ts`)

| Route | Body / Response |
|---|---|
| `GET /api/approvals` | `200 { approvals: ApprovalRequest[] }` — caller's tenant, newest first (`listApprovals(store, principal.sub)`). F polls every 2 s |
| `POST /api/approvals/:id/decide` | `{ decision: "allow_run" \| "allow_always" \| "deny", trustContent?: boolean }` → `200 { approval }` via `decideApproval(id, decision, principal.sub, { trustContent })`. `trustContent` (grant cards only, default `false`) marks the created grant's content believable. `409` already decided, and `409` for `allow_run` on an nl_intent grant card (no run window to expire against) |
| `POST /api/grants/parse` (stretch) | `{ text }` → `201 { approval }` with `source:"nl_intent"`, `status:"pending"` · `200 { approval }` when a byte-identical card is already pending (dedupe — nothing created) · `404` you have no agent by that name (names resolve inside the caller's tenant only; unlogged) · `422` unparseable. Workspace grants only, exactly one action |

`ApprovalRequest`: `{ id, source:"live_deny"|"nl_intent", kind:"scope"|"grant"|"declassify", agentId, ownerId, runId, jti, resource, action, scope, grant, reason, risk, evidence, status:"pending"|"allow_run"|"allow_always"|"deny", createdAt, decidedAt, decidedBy }`.
`risk` (`"routine"|"elevated"|"critical"`) and `evidence` (`{userAsked, attempting, outsideTaskScope, untrustedOrigin, classifiedOrigin}`) are computed server-side — `critical` is only ever the injection signature (outside the task estimate ∧ untrusted content held ∧ outward destination). The UI renders them, never derives them.
A declassify card's `reason` prefix names which check denied: `grant:<id>` (confidentiality) or `integrity:<id>` (untrusted content held).

Button semantics (D8):
- **Allow for this run** (`allow_run`): `scope` → current RunToken.scp widened **and** `agent.tempScopes += {scope, expiresAt: token.expiresAt}` so the follow-up message's new run still has it · `grant` → PolicyGrant with `expiresAt = token.expiresAt` · `declassify` → `RunToken.egressAllow += resource` — the **one destination** the human looked at (a URL, a `"<name>/workspace"`), never the whole class, for both `grant:` and `integrity:` cards.
- **Always allow** (`allow_always`): `scope` → `agent.permissions.tools` · `grant` → permanent PolicyGrant (with `trustContent` if ticked) · `declassify` `grant:` → grant.egress widened (+ matching live taints, so the current run proceeds) · `declassify` `integrity:` → `grant.trustContent = true` + that grant's live taints marked trusted. On a card whose reason is `grant:self:crm` (the owner's own CRM, no standing grant yet) it **creates** the tenant-level CRM grant (`fromAgent: null`) with the approved destination in its egress.
- **Deny**: status only. All three write a RunEvent `{kind:"approval"}`.

Cards are created by the gateway on deny, by `sendMessage` at mint (`action:"run:<scope>"` for a scope the task needs but the agent lacks), and by `POST /api/grants/parse` — one pending card per `(agentId, kind, resource, action)`. No pattern cards (D11).

## Events / timeline (B3 `appendEvent` + B1 route)

| Route | Response |
|---|---|
| `GET /api/runs/:id/events?filter=policy\|all` | `200 { events: RunEvent[] }` ordered by `at`. `policy` (default) = kinds `gateway, approval, grant`; `all` adds `command, file_change, mcp_call, llm` |
| `GET /api/agents/:id/events?filter=…&limit=200` | same shape, across runs (for the Scene 6 timeline) |

`RunEvent`: `{ id, runId, agentId, ownerId, at, kind, action, resource, decision:"allow"|"deny"|"pending"|null, reason, detail }` — the row reads **human (ownerId) → agent → action → resource → outcome (decision/reason)**. `detail` is always passed through `redact()` (`audit.ts`; B3's `redact.ts` may replace via `setRedactor`).
Gateway `reason` values: `no-token, bad-token, unknown-token, revoked, expired, scope, no-grant, cross-tenant, unknown-agent, unknown-tool, path-escape, ifc, integrity, error`.
A run whose final output was screened writes one `{kind:"gateway", action:"output", resource:"chat", decision:"deny"}` row (`reason` = the verdict, `detail` = `{level, origin}`, never the output itself) — deny rows only, the one deviation from the every-branch rule.

## Gateway (Zeon — `gateway.ts`, MCP streamable HTTP)

`POST /mcp` — JSON-RPC over HTTP (`Accept: application/json, text/event-stream`), stateless, `Authorization: Bearer <agent JWT>`.
`401` no/invalid/human token · `403` revoked/expired/unknown jti · otherwise MCP. `GET/DELETE /mcp` → `405`.

Tools (all five always listed; enforcement on call):

| Tool | Args | Scope | Resource / egress |
|---|---|---|---|
| `workspace_read` | `{ agent, path }` | `workspace:read` | own workspace (no taint; secret-shaped content is fingerprinted for the output screen), or another agent's with a live grant (adds a **taint**, `trust` from `grant.trustContent`) |
| `workspace_write` | `{ agent, path, body }` | `workspace:write` | own = `internal`, not outbound; another agent's = `agent` (grant + egress + integrity check) |
| `crm_read` | `{ customer? }` | `crm:read` | own tenant's `crm_records` via `withOwner(ownerId, agentId)` (RLS). Adds a **taint** `{origin:"<owner>/crm", trust:"trusted"}` — egress from a standing tenant-level CRM grant (`fromAgent:null`) if one exists, else `["internal"]` |
| `crm_write` | `{ customer, note }` | `crm:write` | `internal`, outbound (egress + integrity checked); upsert on `(owner_id, customer)` |
| `webhook_send` | `{ url, body }` | `webhook:send` | `external` — egressAllow short-circuit, then egress + integrity check, then B2's sink |

Denied calls return `isError:true` with text `DENIED (<reason>): <message>. An Access Request Card is pending operator approval — tell the user, then retry after they approve.`

Plugin registration (index.ts, Zeon + B1 at Sync 1):
Already mounted in `index.ts` (Zeon). **B3:** add `withOwner` to that call when `db.ts` lands. **B2:** add `webhookSink`. `GATEWAY_ENFORCE=false` env skips scope/grant/egress checks for the RLS demo.

## Runtime projection (B2 — `codex-runner.ts`)

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
Codex is pinned to `0.100.0` (verified 2026-08-29): `0.130.0`/`0.144.6` serialize the MCP server into the Ark Responses request as `{type:"namespace"}`, which Ark rejects (`unknown tool type: namespace`) — the model would never see any tool. `0.100.0` emits `{type:"function"}`, sends the configured `http_headers` agent JWT, and honors `enabled_tools`; don't bump without a live Ark round-trip proving all three. Drop `--env ARK_API_KEY` only when `LLM_PROXY_ENABLED`.
`parseCodexEventLine` calls `request.onEvent({ runId, agentId, kind:"command"|"file_change"|"mcp_call", action, resource, decision:null, reason:null, detail })`.

## Data (B3 — `db.ts`, `migrations/001_init.sql`)

`withOwner(ownerId, agentId, fn)` — `BEGIN; SET LOCAL app.owner_id=$1; SET LOCAL app.agent_id=$2; await fn(q); COMMIT` as role `app_agent` (`NOBYPASSRLS`). `q(text, params) → { rows }`. Owner-only policy on `crm_records` (D4); unique `(owner_id, customer)` for the upsert. Seed: user-jean 2 rows, user-alex 1.
`webhookSink(url, body) → { status }` (B2): records to `data/webhooks.jsonl`, never leaves the machine.

## Demo (B2 — `demo.ts`)

`POST /demo/replay { agentId }` (human JWT, owner) — issues the Scene-2 gateway calls (`workspace_read notes.md` → `workspace_read credentials.json` → `webhook_send`) with the agent's **real** current RunToken, returns the three results + the events written.

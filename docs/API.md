# API contract — Identity & Authorization middleware

Shared contract for F (web), B1 (routes), B2 (runtime), B3 (data). Types are in `apps/server/src/types.ts`. Decisions in `docs/PLAN.md §0`.
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
const scp = effectiveScopes(storedAgent);            // store.ts: permissions.tools ∪ live tempScopes
const jti = randomUUID(), expiresAt = new Date(Date.now() + config.codexTimeoutMs + 60_000).toISOString();
database.runTokens.push({ jti, runId, agentId, ownerId: storedAgent.ownerId, scp, taints: [], issuedAt: timestamp, expiresAt, revokedAt: null });
// then: token = await signAgent(config, { sub: agentId, own: storedAgent.ownerId, run: runId, jti, scp, expiresInSeconds: config.codexTimeoutMs / 1000 + 60 })
// pass { token, permissions: { ...storedAgent.permissions, tools: scp } } into executeRun → runner.run()
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
| `POST /api/agents/:id/kill` | Kill switch: every active RunToken for the agent → `revokedAt=now`; `permissions.tools=[]`; RunEvent `{action:"kill", decision:"deny", reason:"revoked-by-operator"}`. Container not killed (Stop does that). `200 { agent }` |

## Grants (B1 routes → Zeon's `grants.ts`)

| Route | Body / Response |
|---|---|
| `GET /api/agents/:id/grants` | `200 { grants: PolicyGrant[] }` — `listGrants(store, id)` (grants to or from this agent) |
| `POST /api/grants` | `{ fromAgent: id\|null, toAgent: id, resource:"workspace"\|"crm", actions:["read","write"], egress?:["internal","agent","external"] }` → `201 { grant }` via `createGrant(store, body, principal.sub)`. `400` cross-tenant, `403` not your agent |
| `POST /api/grants/:id/revoke` | `200 { grant }` via `revokeGrant(store, id, principal.sub)`. Sets `revokedAt`; the grant's taints on every RunToken → `egress: []` |

`PolicyGrant`: `{ id, fromOwner, fromAgent, toAgent, resource, actions, egress, createdAt, expiresAt, revokedAt }`.
Grants are checked **on every gateway call** (`findLiveGrant`) — never cached.

## Approvals / Access Request Cards (B1 routes → Zeon's `approvals.ts`)

| Route | Body / Response |
|---|---|
| `GET /api/approvals` | `200 { approvals: ApprovalRequest[] }` — caller's tenant, newest first (`listApprovals(store, principal.sub)`). F polls every 2 s |
| `POST /api/approvals/:id/decide` | `{ decision: "allow_run" \| "allow_always" \| "deny" }` → `200 { approval }` via `decideApproval(store, id, decision, principal.sub)`. `409` already decided |
| `POST /api/grants/parse` (stretch) | `{ text }` → `201 { approval }` with `source:"nl_intent"`, `status:"pending"` |

`ApprovalRequest`: `{ id, source:"live_deny"|"nl_intent", kind:"scope"|"grant"|"declassify", agentId, ownerId, runId, jti, resource, action, scope, grant, reason, status:"pending"|"allow_run"|"allow_always"|"deny", createdAt, decidedAt, decidedBy }`.

Button semantics (D8):
- **Allow for this run** (`allow_run`): `scope` → current RunToken.scp widened **and** `agent.tempScopes += {scope, expiresAt: token.expiresAt}` so the follow-up message's new run still has it · `grant` → PolicyGrant with `expiresAt = token.expiresAt` · `declassify` → the run's taint for that grant gains the destination class.
- **Always allow** (`allow_always`): `scope` → `agent.permissions.tools` · `grant` → permanent PolicyGrant · `declassify` → grant.egress widened.
- **Deny**: status only. All three write a RunEvent `{kind:"approval"}`.

Cards are created **by the gateway on deny** — one pending card per `(agentId, kind, resource, action)`. No pattern cards (D11).

## Events / timeline (B3 `appendEvent` + B1 route)

| Route | Response |
|---|---|
| `GET /api/runs/:id/events?filter=policy\|all` | `200 { events: RunEvent[] }` ordered by `at`. `policy` (default) = kinds `gateway, approval, grant`; `all` adds `command, file_change, mcp_call, llm` |
| `GET /api/agents/:id/events?filter=…&limit=200` | same shape, across runs (for the Scene 6 timeline) |

`RunEvent`: `{ id, runId, agentId, ownerId, at, kind, action, resource, decision:"allow"|"deny"|"pending"|null, reason, detail }` — the row reads **human (ownerId) → agent → action → resource → outcome (decision/reason)**. `detail` is always passed through `redact()` (`audit.ts`; B3's `redact.ts` may replace via `setRedactor`).
Gateway `reason` values: `no-token, bad-token, unknown-token, revoked, expired, scope, no-grant, cross-tenant, unknown-agent, unknown-tool, path-escape, ifc, error`.

## Gateway (Zeon — `gateway.ts`, MCP streamable HTTP)

`POST /mcp` — JSON-RPC over HTTP (`Accept: application/json, text/event-stream`), stateless, `Authorization: Bearer <agent JWT>`.
`401` no/invalid/human token · `403` revoked/expired/unknown jti · otherwise MCP. `GET/DELETE /mcp` → `405`.

Tools (all five always listed; enforcement on call):

| Tool | Args | Scope | Resource / egress |
|---|---|---|---|
| `workspace_read` | `{ agent, path }` | `workspace:read` | own workspace, or another agent's with a live grant (adds a **taint**) |
| `workspace_write` | `{ agent, path, body }` | `workspace:write` | own = `internal`; another agent's = `agent` (grant + taint check) |
| `crm_read` | `{ customer? }` | `crm:read` | own tenant's `crm_records` via `withOwner(ownerId, agentId)` (RLS) |
| `crm_write` | `{ customer, note }` | `crm:write` | `internal`; upsert on `(owner_id, customer)` |
| `webhook_send` | `{ url, body }` | `webhook:send` | `external` — taint check, then B2's sink |

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
Verified 2026-08-26: codex 0.144.6 sends the header on `initialize`. Drop `--env ARK_API_KEY` only when `LLM_PROXY_ENABLED`.
`parseCodexEventLine` calls `request.onEvent({ runId, agentId, kind:"command"|"file_change"|"mcp_call", action, resource, decision:null, reason:null, detail })`.

## Data (B3 — `db.ts`, `migrations/001_init.sql`)

`withOwner(ownerId, agentId, fn)` — `BEGIN; SET LOCAL app.owner_id=$1; SET LOCAL app.agent_id=$2; await fn(q); COMMIT` as role `app_agent` (`NOBYPASSRLS`). `q(text, params) → { rows }`. Owner-only policy on `crm_records` (D4); unique `(owner_id, customer)` for the upsert. Seed: user-jean 2 rows, user-alex 1.
`webhookSink(url, body) → { status }` (B2): records to `data/webhooks.jsonl`, never leaves the machine.

## Demo (B2 — `demo.ts`)

`POST /demo/replay { agentId }` (human JWT, owner) — issues the Scene-2 gateway calls (`workspace_read notes.md` → `workspace_read credentials.json` → `webhook_send`) with the agent's **real** current RunToken, returns the three results + the events written.

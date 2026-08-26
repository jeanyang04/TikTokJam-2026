# Implementation Plan — Identity & Authorization middleware

Track: **Identity & Authorization** ("Bouncer"). Thesis: *agents get capabilities, not credentials.* Trace and threat-containment are supporting evidence, not extra tracks.
See `docs/DIAGRAMS.md` for pictures, `docs/TEAM.md` for ownership, `CLAUDE.md` for vocabulary and rules.

## 1. Architecture and trust boundaries

```
Browser ──human JWT──▶ Fastify (auth.ts → ownership preHandler → AgentService)
                          │ mint RunToken{jti, scp, taints} + agent JWT
                          ▼
                  docker run codex exec -c sandbox/network/web_search
                                       -c mcp_servers.launchpad.{url,http_headers,enabled_tools}
                          │ (no ARK key, no human JWT in the container)
          ┌───────────────┴────────────────┐
   tool call + agent JWT           model call + agent JWT
          ▼                                ▼
   gateway.ts /mcp  (LOCK 1)         llm-proxy.ts /llm
   token · scope · grant · owner ·   verify · swap key → Ark
   egress/taint · audit
          ▼
   workspaces (path-jailed) · Postgres crm_records (LOCK 2, RLS) · webhook sink
```

| Boundary | Decides | Data crossing | On failure |
|---|---|---|---|
| Browser → Fastify | `auth.ts` hook + ownership `preHandler` | human JWT | 401 no JWT; **403 + RunEvent** on cross-tenant; list filtered |
| Fastify → container | `sendMessage` + runner | projected Codex config + agent JWT | token expires with run; container never sees Ark key |
| Container → gateway | `gateway.ts` pipeline | agent JWT + tool args → result or 401/403 + RunEvent | unset identity = deny; revoked = 403; gateway down = tool error, platform up |
| Gateway → Postgres | RLS policy, role `app_agent` | `SET LOCAL app.owner_id, app.agent_id` | policy false → 0 rows / `42501` → 403 + RunEvent |
| Container → model | `llm-proxy.ts` | agent JWT → Ark response | invalid/revoked → 401 → run fails cleanly |

## 2. Principals and tokens (`jose`, HS256, `JWT_SECRET`)

Human JWT `{sub:userId, typ:"human", exp:8h}` — `POST /api/auth/login {userId}` against `SEED_USERS=user-jean:Jean,user-alex:Alex`. Verified by `onRequest` on `/api/*` (skip `/api/health`, `/api/auth/login`, `/mcp`, `/llm`, `/gw`, `/demo`). Sets `request.principal`.

Agent JWT `{sub:agentId, typ:"agent", own:ownerId, run:runId, jti, scp[], exp: CODEX_TIMEOUT_MS+60s}` — minted in `AgentService.sendMessage()` inside the existing `store.mutate` (`agent-service.ts:185`). **Store row is authoritative**; the JWT is a snapshot. Delivered to Codex only inside `-c mcp_servers.launchpad.http_headers` (fallback: `env_http_headers` + `--env AGENT_TOKEN` if the spike shows `exec` ignores `http_headers`).

## 3. Data model (`types.ts`, JsonStore v2; Postgres only for `crm_records`)

```ts
type Scope = "workspace:read"|"workspace:write"|"crm:read"|"crm:write"|"webhook:send";
type Egress = "internal"|"external"|"agent";
interface AgentPermissions { sandbox:"read-only"|"workspace-write"; network:boolean; webSearch:boolean; tools:Scope[] }
interface Agent { …; ownerId:string; permissions:AgentPermissions }
interface RunToken { jti; runId; agentId; ownerId; scp:Scope[]; taints:Label[]; issuedAt; expiresAt; revokedAt:string|null }
interface PolicyGrant { id; fromOwner; fromAgent?:string; toAgent; resource:"workspace"|"crm"; actions:("read"|"write")[]; egress:Egress[]; createdAt; revokedAt:string|null }
interface Label { grantId; origin:string; egress:Egress[] }
interface ApprovalRequest { id; source:"live_deny"|"pattern"|"nl_intent"; kind:"scope"|"grant"|"declassify"; agentId; ownerId; runId?; resource; action; status:"pending"|"allow_once"|"allow_always"|"denied"; createdAt; decidedAt?; decidedBy? }
interface RunEvent { id; runId; agentId; ownerId; at; kind:"command"|"file_change"|"mcp_call"|"gateway"|"approval"|"grant"|"llm"; action?; resource?; decision?:"allow"|"deny"|"pending"; reason?; detail:Record<string,unknown> /* redacted */ }
interface Database { version:2; agents; messages; runs; runTokens; policyGrants; approvals; runEvents }
interface RunnerRequest { …; token:string; permissions:AgentPermissions; onEvent?:(e)=>void }
```
Defaults for existing agents (migration v1→v2 in `store.ts`): `ownerId:"user-jean"`, `tools:[]`, sandbox/network from config. Baseline keeps booting.

Postgres `migrations/001_init.sql`: roles `app_admin`, `app_agent NOBYPASSRLS`; `crm_records(id, owner_id, customer, note, updated_at)`; `policy_grants_mirror(grant_id, from_owner, to_agent, resource, actions, revoked_at)` kept in sync by `grants.ts`; `ENABLE`+`FORCE ROW LEVEL SECURITY`; policy `owner_id = current_setting('app.owner_id', true) OR EXISTS (SELECT 1 FROM policy_grants_mirror WHERE to_agent = current_setting('app.agent_id', true) AND from_owner = owner_id AND resource='crm' AND revoked_at IS NULL)`. Seed: Jean 2 rows, Alex 1 row.

## 4. Gateway pipeline (`gateway.ts`, Fastify plugin at `POST /mcp`)

```
1 Authorization header → verify JWT, typ=agent                      ✗ 401
2 RunToken by jti: revokedAt null, not expired                      ✗ 403 revoked
3 tool → required scope
4 scope ∈ RunToken.scp (store copy)                                  ✗ 403 scope → card(live_deny)
5 resource owner == token.own  OR  live PolicyGrant(from→agent, resource, action)
                                                                    ✗ 403 cross-tenant/no-grant → card(live_deny)
6 outbound tool? every taint permits destination class              ✗ 403 ifc (+origin via fingerprint) → card(declassify)
7 handler   crm_*: withOwner(ownerId, agentId) txn  ·  workspace_*: path-jailed FS  ·  webhook_send: sink
8 grant-gated READ → taints += Label · fingerprint(result, label)
9 RunEvent on EVERY branch (allow and deny), after redact()
   on deny: pattern check (≥3 same agent/resource/action in 10 min → card(pattern))
```
Denials return `isError:true` with a structured message naming the missing scope/grant/origin. `GATEWAY_ENFORCE=false` skips 4–6 only (demo: RLS still holds). `tools/list` is also filtered by `scp`.

Tools: `workspace_read{agent,path}`, `workspace_write{agent,path,body}`, `crm_read{customer?}`, `crm_write{customer,note}`, `webhook_send{url,body}` (external), `share_to_agent{agent,body}` (agent egress, optional).

## 5. Workstreams (blocking order)

| # | Workstream | Owner | Files | Exit test |
|---|---|---|---|---|
| 1 | Human auth + ownership (403+audit, filtered list) | B1 | `auth.ts`, `app.ts`, `agent-service.ts` | login; 401; Alex→403+event; list filtered |
| 2 | Permissions field + store v2 migration | B1 | `types.ts`(Zeon), `store.ts`, `app.ts` zod | defaults; v1 file loads |
| 3 | RunToken mint in `sendMessage` | B1 | `agent-service.ts` | row exists; JWT verifies typ=agent |
| 4 | Codex projection (`-c` flags, no ARK env, add-host, version bump) + `http_headers` spike | B2 | `codex-runner.ts`, `container-codex-runner.ts`, `config.ts`, `Dockerfile.runtime` | args snapshot; token not in env |
| 5 | Postgres + RLS + `db.ts` `withOwner()` + `redact.ts` + `appendEvent` | B3 | compose, `migrations/`, `db.ts`, `redact.ts` | jean 2 / alex 1 / unset 0; redact strips 4 patterns |
| 6 | Gateway pipeline + tools + RunEvents | Zeon | `gateway.ts` | 401 / 403 scope / 403 no-grant / 200 |
| 7 | Grants (create, revoke, live-check per call) + mirror sync | Zeon | `grants.ts` | allow → revoke → same token 403; other tools 200 |
| 8 | Cards: create on deny; decide once/always/deny; routes | Zeon + B1 | `approvals.ts`, `app.ts` | deny → card; allow_always → grant+scp; same token now 200 |
| 9 | Pattern detector | B1 | `pattern.ts` | 3 denies → one pending card |
| 10 | Trace from `--json` stream + timeline route | B2 + B3 | `codex-runner.ts`, `app.ts` | parser captures command/file/mcp; ordered by `at` |
| 11 | Whole-token revoke (kill) | B1 | `agent-service.ts` | every call 403; proxy 401 |
| 12 | LLM proxy (optional) | B2 | `llm-proxy.ts`, `config.ts` | human JWT→401; revoked→401; upstream gets real key |
| 13 | IFC: taints + egress check + fingerprint | Zeon + B3 | `ifc.ts` | read under grant → webhook_send 403 ifc w/ origin; own-workspace write 200 |
| 14 | `/demo/replay` + webhook sink + seed | B3 + B1 | `demo.ts`, `scripts/seed.ts` | Scene 2 reproducible |
| 15 | NL grant parse (cut first) | B1 | `app.ts` route | parse → pending card; ownership re-check rejects foreign refs |
| 16 | UI: login, permissions, grants, card, timeline, Alex view | F | `apps/web/src/*` | six demo screens |
| 17 | Tests green, README, diagram PNG, fresh-clone repro, fallback video | all | — | `npm run check`; clean clone → `npm run poc` |

## 6. Failure semantics (README verbatim)

| Situation | Behaviour |
|---|---|
| No / invalid human JWT | 401 on `/api/*` |
| Non-owner touches an agent/resource | **403 + RunEvent** (never a fake 404); listings filtered |
| Agent token not `typ:"agent"` | 401 at gateway/proxy |
| Token revoked/expired | 403/401; run ends `failed` with reason; platform unaffected |
| Grant revoked mid-run | next grant-gated call 403 `grant-revoked`; other tools continue; run completes |
| Tool outside `scp` / no grant | 403 + structured message + card(`live_deny`) + RunEvent |
| Outbound violates taint | 403 `ifc` naming origin + card(`declassify`) + RunEvent; destination never called |
| `app.owner_id` unset in DB txn | RLS → 0 rows / `42501` — deny-all |
| Postgres down | `crm_*` return "resource unavailable"; workspace tools and chat keep working |
| Gateway throws | 500 to the tool, redacted RunEvent, run continues |
| Permissions edited while `busy` | 409 |
| Server restart mid-run | existing behaviour: run `cancelled`; tokens expire |

## 7. Env / deps

`JWT_SECRET` (generated into `.env` by `start-local-poc.sh`), `SEED_USERS`, `GATEWAY_URL`, `GATEWAY_ENFORCE=true`, `LLM_PROXY_ENABLED`, `DATABASE_URL_ADMIN`, `DATABASE_URL_AGENT`. Deps: `jose`, `pg`, `@modelcontextprotocol/sdk`; dev `@types/pg`.

## 8. Demo (3:00) — see storyboard

1 deny → card → Allow always (0:30) · 2 injection → provenance block (0:50) · 3 NL + pattern cards (0:30) · 4 Alex: absent list, 403 logged (0:30) · 5 revoke grant mid-task (0:20) · 6 timeline + still usable (0:20).

## 9. Risks

`http_headers` in `codex exec` unverified → Day-1 spike, `env_http_headers` fallback · `host.docker.internal` on Linux/Podman → `--add-host`/`host.containers.internal` · MCP SDK vs Fastify → REST fallback `POST /gw/:tool` · JSON store write amplification → batch events, cap 500/run · six scenes with two live runs in 3:00 → pre-seed, `/demo/replay`, fallback video · approval with non-interactive Codex → follow-up message path, documented.

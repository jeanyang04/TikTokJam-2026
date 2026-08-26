# Team Briefs — Agent Launchpad Middleware (Identity & Authorization track)

Paste the "Everyone" section to the whole group, then each personal brief to its owner.
Reference docs (in repo `docs/` once copied): `techjam-agent-middleware-implementation-plan.md`, `techjam-architecture-diagrams.md`, the demo storyboard.

---

## Everyone — read first (5 min)

**What we're building, one sentence:** every agent run gets its own scoped, revocable identity; every tool call is checked at our gateway (who / which tool / whose data / where may it go) and logged; a human confirms every grant.

**The six demo scenes** (the storyboard): 1 deny-by-default → live Access Request Card → Allow always · 2 prompt-injection exfil blocked by provenance · 3 pattern + NL grant cards · 4 cross-tenant: absent in list, explicit 403 · 5 revoke one grant mid-task, agent keeps working · 6 audit timeline.

**Rules**
- Baseline must keep working. `npm run check` must stay green on every PR.
- You own your files. Don't edit someone else's without asking in chat. Shared contract = `apps/server/src/types.ts` + `docs/API.md` — Zeon owns both; ask for changes, don't make them.
- One branch per person (`feat/<name>-<seam>`), PR to `main`, Zeon merges. Small PRs, merged daily.
- Never commit `.env`, keys, tokens. `git log -p | grep -i ark_api_key` should return nothing, ever.
- Two syncs a day: 10:00 standup (what's blocked), 18:00 merge + integration check.
- If you're blocked > 30 min, say so in chat. Don't work around by editing someone else's seam.

**Start here (all, Day 1 morning):** `cd volc-agent-launchpad && npm run poc` → run the baseline acceptance test from the brief §1.3 (create agent → "Create a TypeScript hello-world CLI…" task → follow-up → stop/start). Don't write middleware until this passes on your machine.

**Codebase map:** `apps/server/src/types.ts` (data model) · `app.ts` (routes) · `agent-service.ts` (run lifecycle, `sendMessage` L157) · `codex-runner.ts` (`buildCodexArgs` L22, `parseCodexEventLine` L44) · `container-codex-runner.ts` (`buildContainerRunArgs` L36) · `config.ts` (`writeCodexConfig` L103) · `store.ts` (`JsonStore`) · `apps/web/src/App.tsx`, `api.ts`.

---

## Zeon — Gateway + integration lead

**You own:** `types.ts`, `docs/API.md`, `gateway.ts`, `grants.ts`, `approvals.ts`, `ifc.ts`, README, diagram, demo.

**Day 1**
1. First 90 min, before anyone codes: finalise `types.ts` (Agent.ownerId/permissions, RunToken{scp,taints}, PolicyGrant, ApprovalRequest{source}, RunEvent) and `docs/API.md` (every route, request/response). Post in chat.
2. `gateway.ts` as a Fastify plugin at `POST /mcp` (MCP streamable HTTP; fall back to REST `POST /gw/:tool` if the SDK fights you). Pipeline: verify agent JWT → RunToken active → tool→scope → scope ∈ scp → resource owner == own OR live grant → handler → RunEvent on every branch (allow *and* deny).
3. Tools: `workspace_read`, `workspace_write` (path-jailed to `workspaces/<agentId>/`), `crm_read`, `crm_write` (via B3's `withOwner()`), `webhook_send` (calls B3's sink).
4. Test with a fake store + curl and a hand-minted token. Exit: `gateway.test.ts` 401 / 403 scope / 403 no-grant / 200.

**Day 2** — `grants.ts` (create, revoke, `isLive()` checked per call, never cached) · `approvals.ts` (gateway creates card on deny with `source:"live_deny"`; decide → `allow_once` widens `RunToken.scp`, `allow_always` writes PolicyGrant + widens `Agent.permissions.tools`, `deny` logs) · switch gateway to the real store · Sync 2 owner.

**Day 3** — `ifc.ts`: on grant-gated read → `RunToken.taints += {grantId, origin, egress}` + fingerprint (hash shingles) of the result; on outbound tool (`webhook_send`, cross-workspace write) → every taint must permit the destination class, else 403 `ifc` with the origin named; on IFC deny create a `declassify` card. README + diagram PNG. Present the demo.

**Never cache** grants or tokens — the whole revoke story depends on reading the store on every call.

---

## B1 — Auth + control plane

**You own:** `auth.ts` (new), `app.ts`, `agent-service.ts`, `store.ts`, `pattern.ts` (new), `scripts/seed.ts` (new).

**Day 1**
1. Get `npm run poc` green first — everyone is waiting on you to confirm the baseline.
2. `auth.ts`: `jose` HS256. `POST /api/auth/login {userId}` against `SEED_USERS` (user-jean:Jean, user-alex:Alex) → JWT `{sub, typ:"human", exp:8h}`. `onRequest` hook verifying it on `/api/*` except `/api/health`, `/api/auth/login`, and anything under `/mcp`, `/llm`, `/gw`. Sets `request.principal`. Delete the static-bearer hook at `app.ts:44-64`. Export `signAgent(claims)` / `verifyToken(raw, typ)` for Zeon and B2.
3. `types.ts` is Zeon's — use his `ownerId`, `permissions`. In `store.ts` accept `version:1` files and migrate to v2 (`ownerId:"user-jean"`, default permissions, empty `runTokens/policyGrants/approvals/runEvents`). Baseline data must still load.
4. Ownership `preHandler` on every `/api/agents/:id*` route: owner mismatch → **403** (not 404) + `RunEvent{human, action, resource, decision:deny, reason:cross-tenant}`. `GET /api/agents` filtered by owner. `createAgent` stamps `ownerId` + permissions (zod schema on body).
5. In `sendMessage()` (`agent-service.ts:157`, inside the existing `store.mutate` at L185): mint RunToken row `{jti, runId, agentId, ownerId, scp: [...permissions.tools], taints:[], expiresAt: now+CODEX_TIMEOUT_MS+60s}` and the agent JWT; pass `token` + `permissions` into `executeRun` → `runner.run()`.
Exit: `app.test.ts` — login works · no JWT → 401 · Alex GET Jean's agent → 403 + event · Alex's list excludes Jean's agents · RunToken row exists after sendMessage.

**Day 2** — routes from `API.md`: `GET /api/approvals`, `POST /api/approvals/:id/decide`, `POST /api/grants`, `POST /api/grants/:id/revoke`, `GET /api/agents/:id/grants`, `GET /api/runs/:id/events`, `POST /api/agents/:id/revoke` (whole token = kill) · `pattern.ts`: on every deny event, count denies for same (agent, resource, action) in last 10 min; ≥3 and no pending card → create card `source:"pattern"` · `scripts/seed.ts`: Jean, Alex, Researcher, Writer; Writer's workspace with `notes.md` (hidden instruction) + `credentials.json` (fake); CRM rows for both owners.

**Day 3** — `POST /api/grants/parse {text}`: server-side Ark call with a JSON schema → zod → re-check agent/resource exist and belong to caller → card `source:"nl_intent"`. Regex fallback for `let <agent> read <agent>'s (notes|workspace)`. **This is the first thing we cut** — don't start it until Sync 2 passed. Then test gaps.

---

## B2 — Runtime

**You own:** `codex-runner.ts`, `container-codex-runner.ts`, `config.ts`, `Dockerfile.runtime`, `llm-proxy.ts` (new).

**Day 1**
1. **Spike, done by lunch, decides everything downstream:** bump `Dockerfile.runtime` `CODEX_VERSION` to current (host has 0.144.6). Run against a stub HTTP server:
   `codex exec -c 'mcp_servers.x.url="http://host.docker.internal:3000/mcp"' -c 'mcp_servers.x.http_headers={Authorization="Bearer t"}' "list your tools"` — does the header arrive? If not, fallback is `env_http_headers={Authorization="AGENT_TOKEN"}` + `--env AGENT_TOKEN`. Post the answer in chat.
2. `buildCodexArgs` (`codex-runner.ts:22`): add `permissions` + `token` + `gatewayUrl` inputs; emit `-c sandbox_mode=…`, `-c sandbox_workspace_write.network_access=…`, `-c web_search=…`, `-c mcp_servers.launchpad.url=…`, `-c mcp_servers.launchpad.http_headers={Authorization="Bearer <token>"}`, `-c mcp_servers.launchpad.enabled_tools=[…]` (from `permissions.tools` → tool names).
3. `buildContainerRunArgs` (`container-codex-runner.ts:36`): remove `"--env","ARK_API_KEY"` (behind `LLM_PROXY_ENABLED` until Day 2), add `"--add-host","host.docker.internal:host-gateway"`. Drop `ARK_API_KEY` from `childEnvironment()` in both runners under the same flag.
4. `config.ts`: `GATEWAY_URL` (container default `http://host.docker.internal:3000`, local-process `http://127.0.0.1:3000`), `LLM_PROXY_ENABLED`, `JWT_SECRET`.
Exit: `codex-runner.test.ts` — args snapshot for `{read-only, network:false, tools:["workspace:read"]}`; token appears in args, never in env; `enabled_tools` never lists a tool outside permissions.

**Day 2** — `parseCodexEventLine` (`codex-runner.ts:44`): on `item.completed` with `command_execution` / `file_change` / `mcp_tool_call` → call `request.onEvent({kind, detail})` (B3 provides `appendEvent`/`redact`; you just emit). Then `llm-proxy.ts`: `POST /llm/responses` verifies agent JWT + token active, forwards to `ARK_BASE_URL/responses` with the real key, streams back (don't buffer SSE), logs status+usage only. `writeCodexConfig` (`config.ts:103`): `base_url = GATEWAY_URL + "/llm"`, `env_key="AGENT_TOKEN"`. Not in the demo — cut without guilt if Day 2 is tight.

**Day 3** — render diagram to PNG in `docs/` · fresh-machine reproduction: clone on a laptop that never ran it, `cp .env.example .env`, fill keys, `npm run poc` — write down every snag and fix it · runtime edge cases: run revoked mid-turn exits cleanly as `failed` with the reason.

---

## B3 — Data + trace + verification

**You own:** `docker-compose.yml`, `apps/server/migrations/`, `db.ts` (new), `redact.ts` (new), `appendEvent` in the store layer (coordinate one function with B1), `rls.test.ts`, `scripts/start-local-poc.sh` (Postgres bring-up), `/demo/replay` route, webhook sink.

**Day 1**
1. `docker-compose.yml`: add `postgres:16-alpine`, mount `apps/server/migrations` to `/docker-entrypoint-initdb.d`. `start-local-poc.sh`: `docker compose up -d postgres` before the server; export `DATABASE_URL_ADMIN` / `DATABASE_URL_AGENT`.
2. `migrations/001_init.sql`: roles `app_admin`, `app_agent NOBYPASSRLS`; table `crm_records(id, owner_id, customer, note, updated_at)`; `ENABLE` + `FORCE ROW LEVEL SECURITY`; policy `USING/WITH CHECK (owner_id = current_setting('app.owner_id', true) OR EXISTS (live grant to current_setting('app.agent_id', true)))` — the grant part reads a small `policy_grants` mirror table B1/Zeon will populate, or start owner-only and add grants on Day 2; `GRANT SELECT, INSERT, UPDATE ON crm_records TO app_agent`; seed rows for user-jean (2) and user-alex (1).
3. `db.ts`: two `pg.Pool`s; `withOwner(ownerId, agentId, fn)` = `BEGIN; SET LOCAL app.owner_id=$1; SET LOCAL app.agent_id=$2; fn(client); COMMIT` (ROLLBACK on throw). Zeon calls this from `crm_*`.
4. `redact.ts`: deep-walk; replace `Bearer …`, `eyJ…` (JWT), `ep-…`, `ARK_[A-Z_]*=…` with `[redacted]`; truncate strings > 2 KB.
5. `appendEvent(runId, agentId, event)`: batches into `store.mutate` every 250 ms / 20 events; always calls `redact()` first.
Exit: `rls.test.ts` (gated on `DATABASE_URL_AGENT`): jean sees 2, alex 1, unset 0, cross-owner insert → `42501` · `redact.test.ts` strips all four patterns in nested objects · `npm run check` still green **without** Docker.

**Day 2** — `webhook_send` mock sink (records calls, never leaves the machine) · `POST /demo/replay`: issues the real Scene-2 gateway calls with Researcher's real token in sequence (enforcement real, model choice pre-recorded) · `npm run check:db` script · `.env.example` with placeholders only · scan `git log -p` for secrets · fix anything that breaks `npm run check` on a clean clone.

**Day 3** — fingerprint index for IFC with Zeon (hashes + labels only, never content) · timeline/event tests · secret scan of screenshots and the demo video · **record the fallback demo video** and keep it on your laptop for demo day.

---

## F — Frontend

**You own:** everything in `apps/web/src`. Build against `docs/API.md` shapes using JSON fixtures until the backend lands — don't wait.

**Screens (only these six; no restyle):**
1. **Login bar** — two buttons "Jean" / "Alex" → `POST /api/auth/login` → store JWT in `localStorage`; `api.ts` fetch wrapper (L24) adds `Authorization: Bearer`. On 401, clear and show the bar.
2. **Agent form** — permissions: sandbox (read-only / workspace-write), network, web search, tools checkboxes (`workspace:read`, `workspace:write`, `crm:read`, `crm:write`, `webhook:send`). Show as chips on the card.
3. **Agent page** — Grants panel (`GET /api/agents/:id/grants`, each row with **Revoke**), status, existing playground.
4. **Access Request Card** — poll `GET /api/approvals` every 2 s; card shows agent → action → resource, a `source` badge (`live_deny` / `pattern` / `nl_intent`), three buttons Allow once / Allow always / Deny → `POST /api/approvals/:id/decide`. Plus a text box "Describe a grant…" → `POST /api/grants/parse` → lands as a card.
5. **Run timeline** — `GET /api/runs/:id/events`; one row per event: time · human → agent → action → resource → outcome; deny rows red, IFC deny shows the origin line ("content from Writer/credentials.json, grant g-1").
6. **Alex's view** — same app, logged in as Alex: only Alex's agents; direct URL to Jean's agent shows a clear "403 Forbidden — this access was logged".

**Day 1:** 1, 2, skeleton of 3–5 on fixtures. **Day 2:** wire 3–5 to real routes; card polling; timeline. **Day 3:** Scene 2 blocked-message rendering, timing rehearsal with Zeon, nothing new.

Don't: add a UI library, restyle the app, or put any logic in the UI that the backend should own. The rubric gives zero points for UI; it gives points for the UI *exposing* backend evidence clearly.

---

## Sync checkpoints

| When | Must be true |
|---|---|
| Day 1, 12:00 | Baseline green everywhere (B1) · `types.ts`/`API.md` posted (Zeon) · `http_headers` spike answered (B2) |
| Day 1, 18:00 | One real container makes one denied tool call that appears in the store |
| Day 2, 18:00 | Scenes 1, 4, 5, 6 live from the browser |
| Day 3, 12:00 | Scene 2 (IFC) live · `npm run check` green on a clean clone (B2's fresh machine) |
| Day 3, 15:00+ | Three full 3-minute run-throughs; fallback video recorded |

**Cut order if slipping:** NL parse (B1) → LLM proxy (B2) → IFC fingerprint layer (keep run-level taint) → IFC entirely (Scene 2 becomes "curl blocked by scope"). Never cut: gateway, grants, cards, 403+audit, grant revoke, timeline, tests.

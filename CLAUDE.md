# CLAUDE.md — Agent Launchpad middleware (TikTok Tech Jam 2026)

Read this fully before touching code. Then read `docs/PLAN.md` (design), `docs/TEAM.md` (who owns what), and skim `docs/DIAGRAMS.md`.

**Read `docs/SEAMS.md` before adding an env var, signing or verifying a token, reading the caller's identity, or editing a file `docs/TEAM.md` assigns to someone else** — it records what already landed on the shared seams, and where the code deviates from `PLAN.md` on purpose. Add an entry there when you land something another owner builds on.

## What this repo is
The RrankPyramid/CodeJam starter kit (React UI + Fastify control plane + Codex CLI running in a disposable Docker container per turn) plus our middleware for the **Identity & Authorization** track.

**Core feature, one sentence:** every agent run gets its own scoped, revocable identity (an agent JWT + a `RunToken` row); every tool call is checked at our gateway (`gateway.ts` at `POST /mcp`) — who / which tool / whose data / where may it go — and logged as a `RunEvent`; a human confirms every grant via an Access Request Card.

## Vocabulary (use these exact names)
- **Human JWT** — `{sub:userId, typ:"human"}`, issued by `POST /api/auth/login`, only ever between browser and `/api/*`. Never enters a container.
- **Agent JWT** — `{sub:agentId, typ:"agent", own:ownerId, run, jti, scp, exp}`, minted per run in `AgentService.sendMessage`, passed to Codex via `-c mcp_servers.launchpad.http_headers`. A *snapshot*.
- **RunToken** — store row keyed by `jti`: `{scp[], taints[], revokedAt, expiresAt}`. **Authoritative.** Enforcement reads this row, not the JWT claims.
- **scp** — tool scopes an agent may call: `workspace:read|write`, `crm:read|write`, `webhook:send`. Tools: `workspace_read`, `workspace_write`, `crm_read`, `crm_write`, `webhook_send` — exactly five.
- **PolicyGrant** is intra-tenant only (`createGrant` → 400 on owner mismatch).
- **PolicyGrant** — `{fromOwner, toAgent, resource, actions[], egress[], revokedAt}`: whose *data* an agent may touch and where it may go. Checked on every call.
- **taints** — labels added to a RunToken when it reads grant-scoped data; outbound tools must satisfy every taint's `egress` (IFC). Egress classes: `internal` (own workspace / own CRM), `agent` (another agent's workspace, same tenant), `external` (`webhook_send`). Taints persist after grant revoke (revoked grant → `egress: []`).
- **Access Request Card** — `ApprovalRequest{source: "live_deny"|"nl_intent", kind: "scope"|"grant"|"declassify", status}`; buttons **Allow for this run** (widen `RunToken.scp`; grant with run expiry), **Always allow** (write PolicyGrant + widen `Agent.permissions.tools`), **Deny**. No pattern cards.
- **RunEvent** — audit row: `human → agent → action → resource → outcome`, written on **every** gateway branch, allow and deny, after `redact()`.
- **LOCK 1** = gateway checks. **LOCK 2** = Postgres RLS on `crm_records`, **owner-only**: `owner_id = current_setting('app.owner_id', true)`. Grants are enforced in the gateway only; `withOwner()` binds `app.owner_id` from the verified token, never from a tool argument.

## Non-negotiable rules
1. **Baseline must keep working.** Agent CRUD, Playground, run lifecycle, JSON store. Defaults for new fields = today's behaviour. `npm run check` green on every PR (and it must pass *without* Docker — DB tests are gated on `DATABASE_URL_AGENT`).
2. **No caching of tokens or grants.** Gateway reads the RunToken row and PolicyGrant on every call. Revoke-mid-run depends on it.
3. **Cross-tenant = 403 + RunEvent** on an existing resource; unknown ID = plain 404. Listing is filtered (absent, not hidden).
4. **Secrets never enter the container or the logs.** No `ARK_API_KEY` in container env (behind `LLM_PROXY_ENABLED`); everything written to RunEvents passes `redact()`; never commit `.env`.
5. **Enforcement lives in the backend/data layer, never the UI.** UI only exposes evidence.
6. **Keep the JSON store** for agents/runs/tokens/grants/events. Postgres holds only the protected resource (`crm_records`).
7. **Don't edit files you don't own** (see `docs/TEAM.md`). `types.ts` and `docs/API.md` are the shared contract — propose changes in chat, don't make them.
8. Smallest diff that proves the behaviour. No new UI libraries, no restyle, no speculative abstractions. One runnable test per new behaviour.

## Where things are
- `apps/server/src/types.ts` — data model (contract)
- `apps/server/src/app.ts` — routes; auth hook; ownership `preHandler`
- `apps/server/src/agent-service.ts` — run lifecycle; `sendMessage()` mints the RunToken
- `apps/server/src/codex-runner.ts` — `buildCodexArgs` (permissions → `-c` flags), `parseCodexEventLine` (`--json` stream → RunEvents)
- `apps/server/src/container-codex-runner.ts` — `docker run …` args
- `apps/server/src/config.ts` — env schema; `writeCodexConfig` (Codex `config.toml`)
- `apps/server/src/gateway.ts` — LOCK 1, tools, cards (Fastify plugin)
- `apps/server/src/db.ts`, `apps/server/migrations/` — Postgres, RLS (LOCK 2)
- `apps/web/src/App.tsx`, `api.ts` — the only UI files

## Commands
- `npm run poc` — start everything locally (builds runtime image, starts Postgres, opens :3000)
- `npm run check` — typecheck + tests + build (must stay green, no Docker needed)
- `npm run check:db` — RLS tests against the compose Postgres

## Demo scenes (what the code must make true)
1 deny-by-default → live card → Always allow → follow-up message succeeds · 2 prompt-injection exfil blocked by provenance (live once, `/demo/replay` fallback) · 3 NL grant card (stretch) · 4 cross-tenant: absent in list, explicit 403 · 5 revoke one grant mid-task, agent keeps working on the rest · 6 audit timeline (filter: policy only / all).

Gateway transport is **MCP streamable HTTP** (verified: codex 0.144.6 sends `-c mcp_servers.*.http_headers`). Approval is never same-turn: tool returns DENIED, human decides, user sends the next message. Revoke = per grant; Kill switch = per agent identity; Stop = kit's process kill. No hosted instance — judges run locally.

## Cut order if time is short
NL parse → LLM proxy → IFC fingerprint layer (keep run-level taint). **IFC itself is committed.** Never cut: gateway, grants, cards, 403+audit, grant revoke, taints + egress block, timeline, tests.

# 01: Human login + JWT gate

**What to build:** A real login: a user submits their userId, gets back a signed JWT identifying them as a human principal. Every `/api/*` route (except health, login, and the `/mcp`/`/llm`/`/gw` machine-to-machine routes) requires that JWT and rejects requests without one. Replaces the current static-bearer placeholder hook.

**Blocked by:** None (can start immediately).

**Status:** done (branch `feat/b1-auth-control-plane`, commits `4deeec4` + `7842d51`)

- [x] `auth.ts` created: `jose` HS256 signing/verification
- [x] `POST /api/auth/login {userId}` checks against `SEED_USERS`, returns JWT `{sub, typ:"human", exp:8h}`
- [x] `onRequest` hook verifies the JWT on all `/api/*` routes except the documented exceptions, sets `request.principal`
- [x] Missing/invalid JWT on a protected route returns 401
- [x] Static-bearer hook at `app.ts:44-64` removed
- [x] `signAgent(claims)` and `verifyToken(raw, typ)` exported for use by gateway/proxy code
- [x] Test: login succeeds and returns a usable JWT; request without JWT to a protected route returns 401

## Notes for the next ticket / the team

- **Both helpers take `config` first:** `signAgent(config, claims)`, `verifyToken(config, raw, typ)`. The ticket wrote them without it; explicit config beats a module-level singleton, but Zeon and B2 need an `AppConfig` handle at each call site.
- **`verifyToken` returns `null` rather than throwing**, and is overloaded on the type argument, so `"human"` gives `HumanPrincipal | null` and `"agent"` gives `AgentPrincipal | null`.
- **`AgentPrincipal.scp` is `string[]`,** not `Scope[]` — `types.ts` is still v1 baseline. Narrow it when Zeon's contract lands.
- **Cross-seam edit, B2 should know:** `config.ts` gained `JWT_SECRET` and `SEED_USERS`. TEAM.md assigns `JWT_SECRET` in `config.ts` to B2's Day 1 item 4, so expect a collision. `APP_AUTH_TOKEN` and `config.authToken` were left in place, now unused.
- **`GET /api/auth` is kept, and now reports `{required: true}`.** PLAN.md §2's skip list omits `/api/auth`, but that list predates checking which routes exist. The baseline UI probes it at boot and, if the probe fails, `App.tsx:93` catches into an error banner without ever setting `authRequired`, stranding the app on "Connecting to the control plane" with no way in. Gating or deleting the route breaks the running app, so rule 1 wins over the literal list.
- **The baseline UI is degraded but usable until F ships the login bar:** it shows its "Enter the access token" screen, and a human JWT from `POST /api/auth/login` pasted in there unlocks it.

## Verified against a running server

`GET /api/auth` → 200 `{"required":true}` · `GET /api/agents` no token → 401 · garbage token → 401 · login `user-jean` → `{"id":"user-jean","name":"Jean"}` + a 3-segment JWT · same token on `/api/agents` → 200 · unknown user → 401. Decoded claims `{typ:"human", sub:"user-jean", iat, exp}` with `exp - iat` = 28800s, the 8h §2 specifies.

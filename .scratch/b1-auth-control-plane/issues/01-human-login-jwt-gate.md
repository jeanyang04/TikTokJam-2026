# 01: Human login + JWT gate

**What to build:** A real login: a user submits their userId, gets back a signed JWT identifying them as a human principal. Every `/api/*` route (except health, login, and the `/mcp`/`/llm`/`/gw` machine-to-machine routes) requires that JWT and rejects requests without one. Replaces the current static-bearer placeholder hook.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `auth.ts` created: `jose` HS256 signing/verification
- [ ] `POST /api/auth/login {userId}` checks against `SEED_USERS`, returns JWT `{sub, typ:"human", exp:8h}`
- [ ] `onRequest` hook verifies the JWT on all `/api/*` routes except the documented exceptions, sets `request.principal`
- [ ] Missing/invalid JWT on a protected route returns 401
- [ ] Static-bearer hook at `app.ts:44-64` removed
- [ ] `signAgent(claims)` and `verifyToken(raw, typ)` exported for use by gateway/proxy code
- [ ] Test: login succeeds and returns a usable JWT; request without JWT to a protected route returns 401

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

**`AgentPrincipal.scp` is `string[]`,** not `Scope[]` — `types.ts` was still v1 baseline when ticket 01 landed. Narrow it once Zeon's contract is in.

---

## The `/api/*` gate (`auth.ts`, B1's file)

`registerAuth(app, config)` mounts `POST /api/auth/login` and the `onRequest` hook. Every `/api/*` route requires a human JWT except `/api/health`, `/api/auth`, and `/api/auth/login`. Routes outside `/api/` are never gated: `/mcp`, `/llm`, `/gw` and `/demo` authenticate agent tokens themselves.

The verified principal is on `request.principal` as `{typ:"human", userId}`. **Ownership checks read that**, never a body or query field.

**`/api/auth` is open, and `docs/PLAN.md` §2's list omits it.** §2 was written before anyone checked which routes exist. The baseline UI probes `/api/auth` at boot, and on failure `App.tsx:93` catches into an error banner without setting `authRequired`, stranding the app on its loading screen with no way in. The route now reports `{required: true}`. Leave it open and leave it truthful.

**F:** that boot probe is why the app still starts. Once the login bar replaces the token screen, `GET /api/auth` and the whole `authRequired` branch can go.

### Routes ticket 01 added

Here because `docs/API.md` did not exist yet and F is told to build against it. **`docs/API.md` is the contract** — when Zeon posts it, these move there and this block goes.

```
POST /api/auth/login   {userId}  ->  200 {token, user:{id, name}}
                                     401 {error} — userId not in SEED_USERS
                                     400 {error, details} — missing or malformed body
GET  /api/auth                   ->  200 {required: true}   (open, no token)
GET  /api/health                 ->  200                    (open, no token)
```

Every other `/api/*` route needs `Authorization: Bearer <token>` and answers **401 `{error}`** without a valid one. The token is the `token` field above, verbatim. It expires after 8h, so a 401 on a route that worked earlier means expired, not forbidden: clear the stored token and show the login bar. Ownership failures are **403**, and land in ticket 03.

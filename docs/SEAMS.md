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

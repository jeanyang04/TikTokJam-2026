# 04: RunToken mint on sendMessage

**What to build:** Every agent run gets its own scoped, storable identity the moment it starts. `sendMessage()` mints a `RunToken` row (`jti`, `scp` snapshot from the agent's permissions, empty `taints`, expiry) and a matching agent JWT, and passes both into the runner so the container that gets spawned carries them.

**Blocked by:** 01 (Human login + JWT gate — needs `signAgent`), 02 (Store v2 migration — needs `RunToken`/`Agent` types and store collections).

**Status:** ready-for-agent

- [ ] Inside `agent-service.ts:157`'s existing `store.mutate` (around L185): mint `RunToken{jti, runId, agentId, ownerId, scp:[...permissions.tools], taints:[], expiresAt}`
- [ ] Agent JWT `{sub:agentId, typ:"agent", own:ownerId, run:runId, jti, scp, exp}` signed and passed into `executeRun`/`runner.run()`
- [ ] Expiry set to `CODEX_TIMEOUT_MS + 60s`
- [ ] Test: after `sendMessage()`, a RunToken row exists in the store for the run; the agent JWT verifies with `typ:"agent"` and matches the RunToken's `jti`

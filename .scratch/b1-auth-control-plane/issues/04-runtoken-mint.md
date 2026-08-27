# 04: RunToken mint on sendMessage

**What to build:** Every agent run gets its own scoped, storable identity the moment it starts. `sendMessage()` mints a `RunToken` row (`jti`, `scp` snapshot from the agent's permissions, empty `taints`, expiry) and a matching agent JWT, and passes both into the runner so the container that gets spawned carries them.

**Blocked by:** 01 (Human login + JWT gate — needs `signAgent`), 02 (Store v2 migration — needs `RunToken`/`Agent` types and store collections).

**Status:** done (commits `d86d978`, `b669ea1`)

- [x] Inside `agent-service.ts:157`'s existing `store.mutate` (around L185): mint `RunToken{jti, runId, agentId, ownerId, scp:[...permissions.tools], taints:[], expiresAt}`
- [x] Agent JWT `{sub:agentId, typ:"agent", own:ownerId, run:runId, jti, scp, exp}` signed and passed into `executeRun`/`runner.run()`
- [x] Expiry set to `CODEX_TIMEOUT_MS + 60s`
- [x] Test: after `sendMessage()`, a RunToken row exists in the store for the run; the agent JWT verifies with `typ:"agent"` and matches the RunToken's `jti`

**Deviation from the checklist, deliberate.** `scp` is `effectiveScopes(agent)` (permanent
tools ∪ unexpired `tempScopes`), not `[...permissions.tools]` as written above. Taking the
checklist literally would drop an "Allow for this run" scope on the follow-up message, which
is Scene 1. `docs/SEAMS.md` line 75 calls for the same thing.

`request.permissions.tools` also carries the token's `scp` rather than the agent's permanent
tools, because B2's `codex-runner.ts:86` builds Codex's `enabled_tools` from it. Without that,
a just-widened scope is enforceable at the gateway but invisible to the model, so the agent
never tries the tool it was just allowed. Recorded in `docs/SEAMS.md`.

**Added beyond the checklist.** The row is revoked when the run ends, on both the success and
the failure path. Without it a cancelled or failed run left a usable identity behind for the
rest of `CODEX_TIMEOUT_MS`. `run-identity.test.ts` proves the join the checklist stops short
of: the minted token reaching the real gateway plugin, allowed in scope, denied out of scope
with an audited reason, and refused once revoked or once the run ends.

**Note for ticket 07.** `closeRunToken` skips rows that already carry a `revokedAt`, so a kill
switch timestamp is not overwritten when the run it interrupted unwinds.

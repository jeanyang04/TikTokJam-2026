# 07: Kill switch

**What to build:** An emergency stop per agent identity. One API call revokes every RunToken belonging to the agent and clears its tools, so every subsequent tool call and model call fails immediately, regardless of what the run is mid-way through doing.

**Blocked by:** 04 (RunToken mint).

**Status:** ready-for-agent

- [ ] `POST /api/agents/:id/kill` revokes every RunToken row for the agent (`revokedAt` set)
- [ ] Clears `Agent.permissions.tools`
- [ ] Logs a RunEvent for the kill action
- [ ] Respects ownership (only the owner can kill their own agent)
- [ ] Test: after kill, a subsequent gateway tool call with the agent's existing token returns 403; a model call via the proxy returns 401

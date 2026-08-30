# 06: Approval, grant, and timeline routes

**What to build:** The human-facing API for the approve/deny/grant flow and the audit timeline: list pending approvals, decide one (allow-for-this-run / always-allow / deny), create and revoke grants, list an agent's grants, and pull a run's event timeline.

**Blocked by:** 03 (Ownership enforcement), 04 (RunToken mint), and Zeon's `grants.ts`/`approvals.ts` logic existing (external — coordinate in chat).

**Status:** done (commits `88f3319`, `1b637d5`, `9e01aaf`). See `docs/SEAMS.md` § Policy routes.

- [ ] `GET /api/approvals` returns pending requests for the caller's own agents
- [ ] `POST /api/approvals/:id/decide {decision: allow_run|allow_always|deny}` applies the decision: allow_run widens `RunToken.scp` (+ grant with run expiry for grant cards), allow_always writes a `PolicyGrant` + widens `Agent.permissions.tools`, deny just logs
- [ ] `POST /api/grants` creates a grant, intra-tenant only (400 on owner mismatch)
- [ ] `POST /api/grants/:id/revoke` sets `revokedAt`, logs a RunEvent
- [ ] `GET /api/agents/:id/grants` lists grants for an agent
- [ ] `GET /api/runs/:id/events?filter=policy|all` returns the ordered event timeline
- [ ] Every route respects ownership (403+audit on cross-tenant attempts)
- [ ] Test: deny → card appears → allow_always → same RunToken now permitted; revoke → grant no longer live

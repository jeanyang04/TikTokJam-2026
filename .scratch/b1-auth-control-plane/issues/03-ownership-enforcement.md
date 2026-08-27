# 03: Ownership enforcement + filtered listing

**What to build:** Cross-tenant isolation at the API layer. A user can only see and touch their own agents. Touching someone else's existing agent returns 403 and is logged as a RunEvent; touching an ID that doesn't exist at all returns a plain 404 with no log. Listing agents only ever returns the caller's own.

**Blocked by:** 01 (Human login + JWT gate), 02 (Store v2 migration).

**Status:** ready-for-agent

- [ ] `preHandler` on every `/api/agents/:id*` route: unknown ID → 404 (not logged)
- [ ] Existing agent, wrong owner → 403 + `RunEvent{human, action, resource, decision:deny, reason:cross-tenant}`
- [ ] `GET /api/agents` filtered server-side to the caller's `ownerId` (not just hidden client-side)
- [ ] `createAgent` stamps `ownerId` from the verified principal and validates the permissions body with zod
- [ ] Test: Alex GET-ing Jean's agent gets 403 + an audit event is recorded; Alex's agent list excludes Jean's agents; unknown ID gets 404 with no event

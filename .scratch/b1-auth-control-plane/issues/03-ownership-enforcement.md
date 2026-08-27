# 03: Ownership enforcement + filtered listing

**What to build:** Cross-tenant isolation at the API layer. A user can only see and touch their own agents. Touching someone else's existing agent returns 403 and is logged as a RunEvent; touching an ID that doesn't exist at all returns a plain 404 with no log. Listing agents only ever returns the caller's own.

**Blocked by:** 01 (Human login + JWT gate), 02 (Store v2 migration).

**Status:** done

- [x] `preHandler` on every `/api/agents/:id*` route: unknown ID → 404 (not logged)
- [x] Existing agent, wrong owner → 403 + `RunEvent{human, action, resource, decision:deny, reason:cross-tenant}`
- [x] `GET /api/agents` filtered server-side to the caller's `ownerId` (not just hidden client-side)
- [x] `createAgent` stamps `ownerId` from the verified principal and validates the permissions body with zod
- [x] Test: Alex GET-ing Jean's agent gets 403 + an audit event is recorded; Alex's agent list excludes Jean's agents; unknown ID gets 404 with no event

13 tests in `apps/server/src/ownership.test.ts` (a real store and a real app, since
`app.test.ts`'s service is a cast fake). `npm run check` green: 81 tests, 13 files.

The deny row's shape (`action:"api:<METHOD>"`, `resource:"agent/<id>"`) is
`docs/API.md` §Ownership's, not one of mine — the first cut invented
`"GET /api/agents/:id"` / `"<ownerId>/<id>"` and code review caught it against the
contract. F renders `resource` verbatim in the timeline row.

## Additions beyond the checklist

**`/api/runs/:id` is checked too.** `getRun()` looks a run up by its own id with no owner
filter, so it was the one route left reading across tenants. Not on this ticket's
checklist, but `docs/API.md` §Ownership names `/api/runs/:id*` in the preHandler list, so
it is contract work rather than scope creep. Same hook, one more row in `ownershipChecks`.

**The hook matches the collection prefix, not `:id`, and fails closed.** Matching
`/api/agents/:id` would mean a later `/api/agents/:agentId/grants` never enters the gate at
all — it would simply not match, and nothing would check it. Matching `/api/agents/` and
then demanding an `id` param turns that silent miss into a loud 500. Pinned by a test that
registers exactly that route.

**`PATCH /api/agents/:id` applies `permissions` instead of dropping it.** The schema was
`createAgentBody.partial()`, so adding `permissions` to create added it to update too —
where `updateAgent` ignored it, silently accepting and dropping the field. I first made
PATCH reject it, on the theory that widening `permissions.tools` there routes around the
Access Request Card. `docs/API.md:44-49` says otherwise: it documents `permissions` on both
routes with an explicit 409 when busy. The contract wins (rule 7), and it is right on the
merits — the card mediates *agent-initiated* escalation, and an owner editing their own
agent is the human already deciding. `updateAgent` now merges the field inside its existing
`store.mutate`; the busy→409 guard already there satisfies the contract's 409.

**Undefined permission keys are stripped, not spread.** `createAgent` spreads the body over
`DEFAULT_PERMISSIONS`, and zod's `.partial()` emits explicitly-undefined keys, so
`{sandbox: undefined}` would have left an agent with no sandbox. The typecheck caught it
via `exactOptionalPropertyTypes`; the transform fixes the type and the behaviour together.

**`listAgents(ownerId)` is required, not optional.** An optional filter on a tenant boundary
is one forgotten argument away from listing everyone's agents. Two call sites in
`agent-service.test.ts` updated.

`createAgent`'s `ownerId = "user-jean"` default survives, which is the same hazard treated
the opposite way, and the honest reason is cost: ~14 test call sites. It is the milder case
— a forgotten argument there mislabels a *new* agent rather than exposing an existing one,
and `app.ts` always passes the principal. Worth closing when something else touches that
signature.

## For ticket 06

**These deny rows carry `runId: null`** — an API call is not part of a run. If
`GET /api/runs/:id/events` filters by `runId`, cross-tenant denials will not appear in any
run timeline. Decide there whether the timeline also needs a query by `ownerId`; leaving it
means the audit rows exist but nothing surfaces them.

**`Agent.permissions.tools` now has two writers:** an owner's PATCH and, when 06 lands,
`allow_always`. Both go through `AgentService`; don't add a third path.

## No deviation from `docs/API.md`

`permissions` on `POST` and `PATCH`, the 409 when busy, and `ownerId` on the `Agent` JSON
all match §"permissions" (lines 44-50). Nothing in the contract was edited.

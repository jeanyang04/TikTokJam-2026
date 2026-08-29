# Frontend Implementation Plan

This plan completes the frontend work described in `docs/TEAM.md`. It is divided into independently runnable milestones so each part can be reviewed and tested before proceeding.

Frontend-owned files:

- `apps/web/src/types.ts`
- `apps/web/src/api.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`

Constraints:

- Do not add a UI library.
- Do not move authorization or policy enforcement into the frontend.
- Use the backend API as the source of truth.
- Keep changes small and preserve the existing Playground and run lifecycle.

---

## Part 0 — Stabilize authentication

**Status: implemented.** Web typecheck and production build pass. The full repository check remains blocked by the pre-existing `run-identity.test.ts` temporary-directory `ENOTEMPTY` cleanup race.

Most of this exists from the Jean/Alex login work, but the remaining edge cases should be completed before adding authenticated screens.

### Work

- Keep the Jean and Alex login buttons.
- Persist `{token, user}` in `localStorage`.
- Restore the session after a browser refresh.
- Display the current user compactly in the sidebar.
- Keep the **Switch user** action.
- Handle expired tokens consistently:
  - Any protected request returning `401` clears the stored session.
  - Return to the login screen.
  - Do not leave the previous user's data visible.
- Switching Jean → Alex must clear:
  - selected agent
  - messages
  - active run
  - approvals
  - grants
  - timeline events

### Checkpoint

1. Start the application.
2. Log in as Jean.
3. Refresh the browser.
4. Confirm Jean remains signed in.
5. Click **Switch**.
6. Log in as Alex.
7. Confirm Jean's agents and messages are no longer visible.
8. Clear `launchpad.auth` in browser storage and refresh.
9. Confirm the login screen appears.

### Validation

```bash
npm run typecheck -w @launchpad/web
npm run build -w @launchpad/web
```

---

## Part 1 — Agent permission form and chips

**Status: implemented.** Web typecheck and production build pass. The full repository check reaches the server suite but remains blocked by pre-existing temporary-directory `ENOTEMPTY` cleanup races.

This is the first major visible feature and should be completed before approval or timeline work.

### 1.1 Frontend permission types

Add frontend equivalents of the existing backend contract:

```ts
type Scope =
  | "workspace:read"
  | "workspace:write"
  | "crm:read"
  | "crm:write"
  | "webhook:send";

interface AgentPermissions {
  sandbox: "read-only" | "workspace-write";
  network: boolean;
  webSearch: boolean;
  tools: Scope[];
}
```

Extend the frontend `Agent` type with:

```ts
ownerId: string;
permissions: AgentPermissions;
tempScopes: TempScope[];
```

These values already exist in backend responses; the frontend currently ignores them.

### 1.2 Form state

Change create/edit form state from:

```ts
{
  name,
  description,
  instructions
}
```

to:

```ts
{
  name,
  description,
  instructions,
  permissions: {
    sandbox: "workspace-write",
    network: true,
    webSearch: false,
    tools: []
  }
}
```

These values match the backend defaults.

### 1.3 Permission controls

Add a permissions section to both:

- Create Agent modal
- Existing Agent Settings panel

#### Sandbox

Use two radio-style choices:

```text
Read-only
Workspace write
```

Include short explanations:

- **Read-only:** Codex cannot directly modify its runtime workspace.
- **Workspace write:** Codex may directly edit its own workspace.

#### Runtime capabilities

Use switches or normal checkboxes:

```text
[ ] Network access
[ ] Web search
```

#### Gateway tools

Use five checkboxes:

```text
[ ] Read workspaces       workspace:read
[ ] Write workspaces      workspace:write
[ ] Read CRM              crm:read
[ ] Write CRM             crm:write
[ ] Send webhooks         webhook:send
```

Each label should show both the readable name and exact scope.

### 1.4 API payloads

Creation sends:

```json
{
  "name": "Researcher",
  "description": "...",
  "instructions": "...",
  "permissions": {
    "sandbox": "read-only",
    "network": false,
    "webSearch": true,
    "tools": ["workspace:read", "crm:read"]
  }
}
```

Editing uses the same permission object through:

```http
PATCH /api/agents/:id
```

The backend already validates this shape.

### 1.5 Permission chips

Show compact chips in the sidebar agent card. For example:

```text
Read-only
Web search
workspace:read
+1
```

To prevent the sidebar from becoming crowded:

- Show the sandbox chip.
- Show at most two enabled capability/tool chips.
- Show `+N` for the remaining permissions.

Show the complete chip list near the selected agent header or in Settings.

Runtime and tool chips should look slightly different:

```text
Runtime: Read-only, Network, Web search
Tools: workspace:read, crm:read
```

### Important wording

The form should explain:

> Sandbox access controls direct Codex access to its own workspace. Workspace tools are gateway-mediated and audited.

This prevents users from assuming that disabling `workspace:write` also prevents direct filesystem edits when sandbox mode is still `workspace-write`.

### Checkpoint

1. Log in as Jean.
2. Create an agent with:
   - Read-only
   - Network off
   - Web search on
   - `workspace:read`
   - `crm:read`
3. Confirm the chips appear.
4. Open Settings.
5. Confirm all controls restore the saved values.
6. Change CRM read to CRM write.
7. Save.
8. Refresh the page.
9. Confirm the new permissions persist.
10. Start an agent run and confirm Settings is disabled while busy.

### Stop point

At this point, permission configuration is complete and independently useful. Review it before adding approval UI.

---

## Part 2 — Access Request Cards

**Status: implemented.** The authenticated UI polls every two seconds, renders pending scope/grant/declassify cards, submits all three decisions once, and refreshes agents/grants after each decision. Web typecheck/build and gateway tests pass.

This adds the human approval loop.

### 2.1 Frontend types

Add:

- `ApprovalRequest`
- `ApprovalSource`
- `ApprovalKind`
- `ApprovalDecision`
- `ApprovalStatus`

Use the exact backend values:

```ts
source: "live_deny" | "nl_intent";
kind: "scope" | "grant" | "declassify";
status: "pending" | "allow_run" | "allow_always" | "deny";
```

### 2.2 API methods

Add:

```ts
api.listApprovals()
api.decideApproval(id, decision)
```

Routes:

```http
GET /api/approvals
POST /api/approvals/:id/decide
```

### 2.3 Polling

After login:

- Poll approvals every two seconds.
- Stop polling on logout and unmount.
- Avoid creating multiple intervals.
- Keep only the logged-in owner's returned cards.
- Display pending cards first.

When the selected agent changes, cards for other owned agents should remain discoverable. A sidebar badge can show the total pending count.

### 2.4 Card layout

A card should show:

```text
Live deny · Grant

Researcher wants to:
Read Writer/workspace

Reason:
No live grant

[Allow for this run] [Always allow] [Deny]
```

Include:

- Requesting agent
- Action
- Resource
- Reason
- Source badge
- Kind badge
- Creation time

Card categories should be visually distinct:

- `scope`: missing tool permission
- `grant`: access to another agent's data
- `declassify`: requested data egress

### 2.5 Decision handling

When a button is clicked:

1. Disable all buttons on that card.
2. Send the decision.
3. Replace the pending state with the decision result.
4. Refresh:
   - approvals
   - agents
   - selected agent grants
5. Display:

```text
Approved. Send a follow-up message so the agent retries the action.
```

Do not imply that the failed call resumes automatically.

### Repeatable test

Reset the seeded demo:

```bash
npm run seed
```

Then:

1. Log in as Jean.
2. Select Researcher.
3. Send:

   ```text
   Use workspace_read to read notes.md from Writer's workspace.
   ```

4. The gateway should deny it for `no-grant`.
5. A grant card should appear.
6. Click **Deny**.
7. Run `npm run seed` again if needed.
8. Repeat and choose **Always allow**.
9. Send a follow-up message.
10. Confirm the second call succeeds.

### Stop point

Review card polling, duplicate prevention, and decision handling before continuing.

---

## Part 3 — Grants panel and Kill switch

**Status: implemented.** The grants panel and Kill identity control work independently of Part 2; Part 2 will later provide the browser approval flow that creates grants. Web typecheck/build pass, Kill switch backend tests pass, and the policy-route suite passes its assertions apart from the known temporary-directory `ENOTEMPTY` cleanup race.

This completes the selected agent's security controls.

### 3.1 Grant types and API methods

Add frontend `PolicyGrant` and:

```ts
api.getAgentGrants(agentId)
api.revokeGrant(grantId)
api.killAgent(agentId)
```

Routes:

```http
GET /api/agents/:id/grants
POST /api/grants/:id/revoke
POST /api/agents/:id/kill
```

### 3.2 Grants panel

On the selected agent page, show grants where the agent is either the source or recipient.

Each row should clearly show direction:

```text
Writer → Researcher
Workspace · Read
Egress: internal
Permanent
[Revoke]
```

Or:

```text
Researcher → Writer
Workspace · Write
Expires in 6 minutes
[Revoke]
```

Show these states:

- Active
- Temporary with expiry
- Revoked

Do not hide revoked grants by default because they are useful evidence. Visually de-emphasize them.

### 3.3 Revoke behavior

On Revoke:

1. Ask for confirmation.
2. Call the revoke endpoint.
3. Refresh grants.
4. Refresh approvals and timeline.
5. Mark the grant revoked rather than immediately removing it.

Suggested confirmation:

```text
Revoke this grant? The next protected call will be denied.
```

### 3.4 Kill switch

Add a visually distinct red button:

```text
Kill agent identity
```

Do not label it simply **Stop**, because Stop and Kill have different semantics.

Confirmation:

```text
Kill Researcher's identity?

This revokes all active run tokens and removes its tool scopes.
It does not replace the normal Stop control.
```

After success:

- Refresh the agent.
- Clear permission tool chips through the returned backend state.
- Refresh active run state.
- Show a confirmation banner.

### Checkpoint

1. Create a grant through an Access Request Card.
2. Confirm it appears in the Grants panel.
3. Revoke it.
4. Ask Researcher to retry.
5. Confirm it is denied.
6. Create or reset an agent with tool scopes.
7. Hit Kill.
8. Confirm tool chips disappear.
9. Confirm subsequent protected calls are denied.

### Stop point

At this stage, Agent Settings, grants, approvals, revoke, and kill are visible.

---

## Part 4 — Audit timeline and blocked-action rendering

This exposes the existing backend evidence.

### 4.1 Event types and API methods

Add frontend `RunEvent` and:

```ts
api.getRunEvents(runId, filter)
api.getAgentEvents(agentId, filter, limit)
```

Routes:

```http
GET /api/runs/:id/events?filter=policy|all
GET /api/agents/:id/events?filter=policy|all&limit=200
```

### 4.2 Timeline scope

For the selected agent page, use the agent-wide endpoint by default:

```http
GET /api/agents/:id/events
```

This allows the UI to show:

- current-run events
- previous-run events
- kill events
- API authorization events with `runId: null`

When a specific run is selected later, use the run endpoint.

### 4.3 Filters

Default:

```text
Policy only
```

Optional toggle:

```text
All activity
```

Policy events:

- gateway
- approval
- grant

All activity additionally includes:

- command
- file change
- MCP call
- LLM

### 4.4 Timeline row

Each row should show:

```text
10:32:14
Jean → Researcher
workspace_read → Writer/workspace
DENIED · no-grant
```

Color rules:

- Allow: green
- Deny: red
- Pending: amber
- Neutral execution telemetry: gray or purple

Expanded details can show redacted `detail`, but avoid dumping raw JSON by default.

### 4.5 IFC rendering

An IFC denial should clearly show the origin:

```text
Blocked external egress

Content originated from:
user-jean/Writer

Grant:
a12bc34d

Destination:
external
```

Do not reconstruct policy decisions in the frontend. Render the backend event's reason and details.

### 4.6 Blocked-message callout

When the latest policy event is a deny for the selected run, show a callout near the Playground:

```text
Action blocked by policy

Researcher could not read Writer/workspace.
Reason: no-grant

An Access Request Card is pending.
```

Drive this from the gateway event/card, not by parsing assistant prose.

### Current limitation

The backend currently stores policy events, so those will display immediately.

Codex command/file/MCP events are parsed but are not yet connected to `recordEvent()`. Initially:

- Policy timeline works.
- LLM events work when the proxy is enabled.
- **All activity** may not yet show command/file/MCP events.

Do not fake missing events in the frontend.

### Checkpoint

Run this sequence:

1. Researcher attempts a Writer read.
2. Observe gateway deny.
3. Approve it.
4. Retry.
5. Observe gateway allow.
6. Revoke the grant.
7. Retry.
8. Observe another gateway deny.
9. Toggle policy/all.
10. Refresh and confirm events persist.

Expected timeline:

```text
DENY no-grant
APPROVAL allow
GRANT create
ALLOW workspace_read
GRANT revoke
DENY no-grant
```

### Stop point

Review event ordering, polling, and readability before adding deep-link authorization behavior.

---

## Part 5 — Alex's view and explicit 403 screen

The list is already filtered by the backend. The missing frontend behavior is handling a direct URL to another tenant's known agent.

### 5.1 Agent URLs

Without adding React Router, use a path convention:

```text
/agents/:agentId
```

When selecting an agent, update the URL with `history.pushState()`.

On startup:

1. Read the agent ID from the path.
2. Fetch that agent directly.
3. Distinguish:
   - `200`: show agent
   - `403`: show forbidden page
   - `404`: show not found
   - `401`: return to login

### 5.2 Forbidden screen

For Alex opening Jean's agent:

```text
403 Forbidden

This agent belongs to another tenant.
The attempted access was denied and recorded.
```

Actions:

```text
[Back to my agents]
[Switch user]
```

Do not reveal the other tenant's agent details if they were not already known.

### 5.3 List behavior

When Alex logs in:

- Only Alex's agents appear.
- Jean's agents are absent, not disabled.
- Do not show placeholders indicating hidden agents.

### Checkpoint

1. Log in as Jean.
2. Copy a Jean agent URL.
3. Switch to Alex.
4. Paste the Jean URL.
5. Confirm the explicit 403 screen.
6. Return to Alex's list.
7. Confirm Jean's agents are absent.
8. Paste a random UUID.
9. Confirm a plain 404 screen, not 403.

### Stop point

At this point, required cross-tenant frontend evidence is complete.

---

## Part 6 — Natural-language grant request

This is explicitly a stretch feature and should follow all core screens.

### Work

Add:

```ts
api.parseGrant(text)
```

UI:

```text
Describe a grant

[ Let Researcher read Writer's workspace       ]
[ Create request ]
```

The API call does not immediately create a grant. It creates or returns a pending Access Request Card.

Handle:

- `201`: card created
- `200`: matching pending card already exists
- `404`: referenced agent not found
- `422`: request could not be understood
- `401`: session expired

After success:

1. Clear the input.
2. Refresh approvals.
3. Scroll to or highlight the matching card.
4. Require the human to choose Allow or Deny.

### Checkpoint

Submit:

```text
Let Researcher read Writer's workspace
```

Confirm:

- A `source: nl_intent` card appears.
- No grant exists before approval.
- **Always allow** creates a permanent grant.
- **Deny** creates no grant.

---

## Part 7 — Integration and UI cleanup

Only begin this after the required behavior works.

### Layout pass

Keep the existing visual style. Organize the selected agent page into:

1. Agent header and status
2. Permission chips
3. Settings panel when open
4. Pending Access Request Cards
5. Playground
6. Security section
   - Grants
   - Kill switch
7. Audit timeline

Avoid putting all information permanently in the narrow sidebar.

### Loading and empty states

Add explicit states for:

- No agents
- No grants
- No pending approvals
- No policy events
- Timeline loading
- Approval decision in progress
- Grant revocation in progress
- Session expired
- Backend unavailable

### Polling cleanup

Ensure:

- Approval polling stops after logout.
- Timeline polling follows the selected agent.
- Responses for a previously selected agent do not overwrite current state.
- No duplicate polling intervals are created after switching users.
- Polling can pause when the document is hidden if needed.

### Accessibility

- Associate labels with permission inputs.
- Keep cards and buttons keyboard-operable.
- Use `aria-live` for approval and denial banners.
- Confirm revoke and kill actions.
- Do not represent allow/deny using color alone.

### Final test sequence

Run:

```bash
npm run seed
npm run poc
```

#### Jean

1. Login.
2. Create an agent with custom permissions.
3. Edit permissions.
4. Trigger a denied cross-agent read.
5. See an Access Request Card.
6. Always allow.
7. Retry successfully.
8. See the grant.
9. See the timeline.
10. Revoke.
11. Retry and see denial.
12. Kill the agent.

#### Alex

1. Switch to Alex.
2. Confirm only Alex's agents appear.
3. Open Jean's known URL.
4. Confirm 403 and “attempt logged.”

#### Persistence

1. Refresh.
2. Confirm login persists.
3. Confirm permissions, grants, and events reload.
4. Switch users.
5. Confirm no previous-user state leaks.

Final commands:

```bash
npm run typecheck -w @launchpad/web
npm run build -w @launchpad/web
npm run check
```

The earlier full-check `ENOTEMPTY` failure appeared to be a server-test cleanup race. If it occurs again, rerun it and report it separately rather than treating it as a frontend failure.

---

## Recommended execution order

Stop for review after each batch:

1. **Part 0:** Authentication stability
2. **Part 1:** Permission form and chips
3. **Part 2:** Access Request Cards
4. **Part 3:** Grants and Kill switch
5. **Part 4:** Timeline and blocked actions
6. **Part 5:** Alex/403 view
7. **Part 6:** Natural-language grant stretch
8. **Part 7:** Integration cleanup

The first implementation checkpoint should be **Part 1 only**. It is self-contained and does not require approval polling, grants, or timeline state.

# Credential Handling Implementation Plan

## 1. Goal

Turn Agent Launchpad into a **just-in-time credential broker for AI agents**.

> Agents receive narrow, revocable capabilities. Provider credentials stay in the trusted Fastify control plane and never enter the model, Codex runtime, workspace, logs, or audit store.

GitHub is the first provider and the complete proof of the design. Do not add more providers until the GitHub flow, approval, revocation, audit, and no-leak tests work end to end.

## 2. Precise security claim

Do not claim that the agent has “no credentials.” The runtime intentionally receives a scoped Launchpad **Agent JWT**.

Use this claim instead:

> The agent has a scoped, revocable Launchpad Agent JWT, but it never receives a reusable GitHub provider credential. The trusted gateway exchanges the agent capability for a short-lived GitHub installation token and performs the approved operation on the agent’s behalf.

## 3. MVP scope

### Required GitHub operations

- `github_read_file`
- `github_create_issue`

### Required scopes

- `github:contents:read`
- `github:issues:write`

### Stretch operations

- `github_create_branch`
- `github_write_file`
- `github_open_pull_request`

### Explicitly excluded from the MVP

- Personal access tokens (PATs)
- OAuth token forwarding into containers
- `git clone` credentials in containers
- Generic `github_request(method, url, body)` tools
- Arbitrary authenticated HTTP proxying
- GitHub organization administration
- GitHub Actions secrets or workflow execution
- Multiple providers

The current project contract specifies exactly five tools. Adding GitHub tools is an intentional product-level change and must be agreed and reflected in `docs/PLAN.md`, `docs/API.md`, `apps/server/src/types.ts`, and `docs/SEAMS.md` before implementation.

## 4. Architecture

```text
Browser
  │ Human JWT
  ▼
Fastify control plane
  ├─ GitHub connection lifecycle
  ├─ Access Request Cards
  ├─ PolicyGrant management
  └─ audit timeline

Agent container
  │ Agent JWT + narrow GitHub tool request
  ▼
Gateway
  ├─ verify Agent JWT
  ├─ read authoritative RunToken
  ├─ check scope
  ├─ check connection ownership/status
  ├─ check repository-specific PolicyGrant
  ├─ check IFC egress rules
  └─ call GitHub credential broker
          │
          ├─ sign GitHub App JWT
          ├─ mint short-lived installation token
          ├─ perform one allowlisted GitHub operation
          └─ discard token and return only the result
                  │
                  ▼
                GitHub
```

### Trust boundaries

Trusted:

- Fastify host process
- GitHub App private key
- GitHub credential broker
- Gateway authorization pipeline
- RunToken and PolicyGrant state

Untrusted:

- Codex container
- Model output
- Tool arguments
- Repository files
- Issue and pull-request text
- Prompt instructions found in GitHub content

## 5. GitHub terminology

### GitHub App

A provider identity registered in GitHub Developer Settings. Launchpad may still run locally. “Installing” the app means authorizing it for selected repositories, not installing software on the machine.

### GitHub installation

The authorization created when a user or organization installs the GitHub App and selects repositories.

### Installation token

A temporary GitHub credential minted by the trusted backend for one installation. It is limited by the app’s permissions and selected repositories and normally expires in about one hour.

### Credential broker

Trusted Fastify code that obtains and uses provider credentials without returning them to the agent. The broker performs operations such as `readFile()` and `createIssue()`; it must not expose `getInstallationToken()` to the gateway or model.

## 6. One-time GitHub App setup

Create a GitHub App with the minimum permissions needed by the MVP:

- Metadata: read-only
- Repository contents: read-only
- Issues: read and write
- Pull requests: disabled until the stretch phase
- Webhooks: optional and disabled initially
- Repository access: only selected repositories

Host-only configuration:

```env
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/outside/repository/github-app.pem
GITHUB_API_BASE_URL=https://api.github.com
```

Requirements:

- Keep the PEM file outside the repository.
- Set file mode to `0600` where supported.
- Never mount the PEM into the runtime container.
- Never copy it into `Dockerfile.runtime`.
- Put placeholders only in `.env.example`.
- Fail startup clearly if GitHub is enabled but configuration is invalid.
- Coordinate `config.ts` changes with its owner and record the seam in `docs/SEAMS.md`.

Because provider credential isolation is the main thesis, enable the existing LLM proxy for the demo so `ARK_API_KEY` also remains outside the runtime.

## 7. Data model changes

These are shared-contract proposals. The owner of `types.ts` and `docs/API.md` must approve and land them.

### 7.1 Provider connection

```ts
export type Provider = "github";
export type ConnectionStatus = "active" | "revoked";

export interface ProviderConnection {
  id: string;
  ownerId: string;
  provider: "github";
  installationId: number; // non-secret GitHub identifier
  accountLogin: string;
  accountType: "User" | "Organization";
  status: ConnectionStatus;
  createdAt: string;
  revokedAt: string | null;
}
```

A `ProviderConnection` answers:

> Which GitHub App installation did this human connect to Launchpad?

It does not authorize an agent and contains no provider token.

Add to `Database`:

```ts
providerConnections: ProviderConnection[];
```

### 7.2 Connection intent

Use one-time state to bind a GitHub installation callback to the authenticated Launchpad user.

```ts
export interface ConnectionIntent {
  id: string;
  ownerId: string;
  provider: "github";
  stateHash: string;
  expiresAt: string;
  consumedAt: string | null;
}
```

Add:

```ts
connectionIntents: ConnectionIntent[];
```

Store only `sha256(rawState)`. The browser receives the raw state. Expire intents after approximately ten minutes and reject reuse.

### 7.3 Scopes

Extend `Scope` and `SCOPES`:

```ts
| "github:contents:read"
| "github:issues:write"
```

Stretch:

```ts
| "github:contents:write"
| "github:pull_requests:write"
```

### 7.4 Extend PolicyGrant

Continue using `PolicyGrant`; do not build an unrelated second grant system.

```ts
export type Resource = "workspace" | "crm" | "github";

export type GrantAction =
  | "read"
  | "write"
  | "contents:read"
  | "contents:write"
  | "issues:write"
  | "pull_requests:write";

export interface ExternalResourceConstraint {
  connectionId: string;
  repository: string; // canonical owner/repository
  branches: string[];
}
```

Add to `PolicyGrant`:

```ts
external: ExternalResourceConstraint | null;
```

Validation rules:

- `resource === "github"` requires `external !== null`.
- Workspace and CRM grants require `external === null`.
- The connection must belong to `fromOwner`.
- The receiving agent must belong to `fromOwner`.
- The repository must be canonicalized to lowercase `owner/repository` for comparison.
- The MVP permits exact repository matches only.
- The requested action must be explicitly listed.
- Existing grants load with `external: null`.

Example:

```ts
{
  id: "grant-1",
  fromOwner: "user-jean",
  fromAgent: null,
  toAgent: "researcher-id",
  resource: "github",
  actions: ["contents:read"],
  external: {
    connectionId: "conn-1",
    repository: "acme/backend",
    branches: []
  },
  egress: ["internal"],
  createdAt: "...",
  expiresAt: null,
  revokedAt: null
}
```

## 8. User connection flow

### 8.1 Start connection

Route:

```http
POST /api/connections/github/start
Authorization: Bearer <Human JWT>
```

Backend:

1. Verify the Human JWT.
2. Read `request.principal.userId`; never accept owner ID from the body.
3. Generate at least 32 random bytes as `state`.
4. Store a `ConnectionIntent` containing only `sha256(state)`.
5. Return the GitHub App installation URL containing the raw state.
6. Browser redirects to GitHub.

Example response:

```json
{
  "url": "https://github.com/apps/agent-launchpad/installations/new?state=..."
}
```

### 8.2 GitHub installation callback

Route:

```http
GET /api/connections/github/callback
  ?installation_id=12345
  &setup_action=install
  &state=<raw-state>
```

Backend:

1. Hash the state.
2. Find an unexpired, unconsumed intent.
3. Recover the owner from the intent.
4. Authenticate to GitHub as the GitHub App.
5. Fetch and verify installation metadata.
6. Create or update the owner’s `ProviderConnection`.
7. Mark the intent consumed.
8. Write a redacted audit event.
9. Redirect to the Launchpad UI.

The callback relies on one-time state because browser navigation does not automatically attach a Human JWT stored in `localStorage`.

### 8.3 List connections

```http
GET /api/connections
Authorization: Bearer <Human JWT>
```

Return only caller-owned metadata. Never return tokens, private keys, or authorization headers.

### 8.4 Disconnect

```http
POST /api/connections/:id/revoke
Authorization: Bearer <Human JWT>
```

Backend:

1. Unknown ID: plain 404.
2. Existing connection owned by another user: 403 plus RunEvent.
3. Mark the connection revoked.
4. Revoke every PolicyGrant referencing it.
5. Change existing taints from those grants to `egress: []`.
6. Audit the connection and grant revocations.
7. Do not automatically uninstall from GitHub unless the UI explicitly says so.

## 9. Credential broker implementation

Create a trusted module such as:

```text
apps/server/src/github-client.ts
```

Suggested interface:

```ts
export interface GitHubBroker {
  readFile(input: {
    installationId: number;
    repository: string;
    path: string;
    ref?: string;
  }): Promise<{ content: string; sha: string; bytes: number }>;

  createIssue(input: {
    installationId: number;
    repository: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
}
```

Do not export a method that returns an installation token.

### 9.1 Sign a GitHub App JWT

Use RS256 and the host-only PEM:

```ts
{
  iat: now - 30,
  exp: now + 9 * 60,
  iss: githubAppId
}
```

This GitHub App JWT is separate from Launchpad Human and Agent JWTs.

### 9.2 Mint an installation token

Call:

```http
POST /app/installations/:installationId/access_tokens
Authorization: Bearer <GitHub App JWT>
```

Narrow the token to the requested repository and permission when GitHub supports it:

```json
{
  "repositories": ["backend"],
  "permissions": {
    "contents": "read"
  }
}
```

For the MVP, keep the installation token in a function-local variable, use it immediately, and discard it. Never persist or return it.

### 9.3 Perform allowlisted operations

`readFile()` constructs a fixed GitHub API request. Tool input supplies repository/path data, never an arbitrary API URL.

`createIssue()` constructs the issue endpoint and returns only issue number and URL.

Provider errors must be translated into controlled errors. Do not serialize request headers, fetch options, or raw provider errors that might include credentials.

## 10. Gateway changes

Extend `GatewayDeps` with the broker:

```ts
github?: GitHubBroker;
```

The gateway remains the authorization authority. The broker performs an already-authorized operation and does not decide policy.

### 10.1 Tool mapping

```ts
github_read_file: "github:contents:read"
github_create_issue: "github:issues:write"
```

### 10.2 `github_read_file`

Input:

```ts
{
  connectionId: string;
  repository: string;
  path: string;
  ref?: string;
}
```

Pipeline on every call:

1. Verify Agent JWT and `typ: "agent"`.
2. Read RunToken by `jti`.
3. Reject missing, revoked, or expired RunToken.
4. Check `github:contents:read` in authoritative `RunToken.scp`.
5. Read the connection from the store.
6. Check connection owner equals `RunToken.ownerId`.
7. Check connection status is active.
8. Read a live PolicyGrant matching agent, connection, repository, and `contents:read`.
9. Ask the broker to read the file.
10. Add a taint for the grant-scoped read.
11. Fingerprint returned content without persisting raw content.
12. Write a redacted RunEvent.
13. Return file content and safe metadata, never the token.

Suggested taint origin:

```text
github/acme/backend/README.md
```

### 10.3 `github_create_issue`

Input:

```ts
{
  connectionId: string;
  repository: string;
  title: string;
  body: string;
}
```

Pipeline:

1. Perform the same identity, RunToken, connection, and grant checks.
2. Require `github:issues:write` scope and action.
3. Classify GitHub write as external egress.
4. Run IFC against title/body before contacting GitHub.
5. Call the broker only after all checks pass.
6. Audit repository, issue number, and status, not the full body.

### 10.4 Denials and cards

Create a scope card when the GitHub scope is missing.

Create a grant card when the scope exists but repository authorization is missing:

```text
Researcher wants contents:read on GitHub repository acme/backend through Jean's connection.
```

For the demo, seed Researcher with `github:contents:read` but no repository grant so the first denial produces one meaningful repository grant card instead of two sequential cards.

## 11. Approval semantics

### Allow for this run

- Widen the RunToken and `tempScopes` if scope is missing.
- Create a repository-specific PolicyGrant with `expiresAt` equal to the run window.

### Always allow

- Add the scope to permanent agent permissions if needed.
- Create a permanent repository-specific PolicyGrant.

### Deny

- Close the card.
- Change no permissions.
- Write a denial event.

Approval never resumes the denied call. The human sends a follow-up message and the next run/tool call re-reads current state.

## 12. Runtime projection

Update Codex scope-to-tool projection:

```text
github:contents:read -> github_read_file
github:issues:write -> github_create_issue
```

The model’s menu is derived from effective RunToken scopes. The gateway still enforces every call.

Never add GitHub values to:

- Container environment
- Codex arguments
- Workspace files
- Generated Codex config
- Prompt text
- Runtime mounts

Add snapshot tests showing that no variable or mount contains `GITHUB`, `GH_TOKEN`, `PRIVATE_KEY`, or installation-token data.

## 13. IFC and prompt injection

Treat all GitHub content as untrusted.

After an approved `github_read_file`:

```ts
{
  grantId: "grant-1",
  origin: "github/acme/backend/README.md",
  egress: ["internal"]
}
```

If repository content instructs the model to send itself to a webhook:

1. The model cannot reveal a GitHub token because it never received one.
2. `webhook_send` is external.
3. The GitHub taint permits only internal flow.
4. Gateway denies before contacting the destination.
5. RunEvent identifies the repository/path origin.

Do not put raw GitHub file content into events. Store repository, path, SHA, byte count, grant ID, hashes, and outcome only.

## 14. Redaction

Extend redaction patterns for common GitHub credentials:

```text
ghp_
gho_
ghu_
ghs_
ghr_
github_pat_
-----BEGIN PRIVATE KEY-----
-----BEGIN RSA PRIVATE KEY-----
```

Continue redacting before truncating.

Redaction is a last line of defense. The primary control is that provider credentials never cross into agent-facing data structures.

## 15. Audit events

Safe connection event:

```ts
{
  kind: "grant",
  action: "connection:create",
  resource: "github/acme",
  decision: "allow",
  detail: {
    connectionId: "conn-1",
    installationId: 12345
  }
}
```

Safe read event:

```ts
{
  kind: "gateway",
  action: "github_read_file",
  resource: "github/acme/backend/README.md",
  decision: "allow",
  detail: {
    connectionId: "conn-1",
    grantId: "grant-1",
    sha: "...",
    bytes: 1200
  }
}
```

Never log installation tokens, GitHub App JWTs, private keys, authorization headers, complete file bodies, or complete issue bodies.

## 16. UI flow

### Connections panel

```text
GitHub
Account: acme
Status: Connected

[Manage on GitHub] [Disconnect]
```

### Agent permissions

- Read GitHub repository contents
- Create GitHub issues

### Grant row

```text
GitHub · acme/backend · contents:read · Researcher
[Revoke]
```

### Access Request Card

```text
Researcher wants to read repository contents
Provider: GitHub
Repository: acme/backend
Connection owner: Jean

[Allow for this run] [Always allow] [Deny]
```

### Timeline

```text
Jean -> Researcher -> github_read_file
-> github/acme/backend/README.md -> ALLOWED
```

The UI displays policy evidence only. All enforcement remains in the backend.

## 17. Proposed API additions

| Route | Purpose |
|---|---|
| `POST /api/connections/github/start` | Create one-time state and return installation URL |
| `GET /api/connections/github/callback` | Verify state and bind a GitHub installation to its owner |
| `GET /api/connections` | List caller-owned connection metadata |
| `POST /api/connections/:id/revoke` | Revoke a connection and associated grants |
| `GET /api/connections/:id/repositories` | Optional repository picker; safe metadata only |
| `POST /api/grants` | Extend existing route to accept GitHub constraints |

Example GitHub grant request:

```json
{
  "fromAgent": null,
  "toAgent": "researcher-id",
  "resource": "github",
  "actions": ["contents:read"],
  "egress": ["internal"],
  "external": {
    "connectionId": "conn-1",
    "repository": "acme/backend",
    "branches": []
  }
}
```

## 18. Proof that credentials do not enter the agent

### 18.1 Canary credential test

Use a fake GitHub server in tests. It returns a unique fake installation token:

```ts
const CANARY = "ghs_LAUNCHPAD_CANARY_MUST_NOT_LEAK";
```

Execute a real gateway `github_read_file` call.

Verify the trusted broker used the canary:

```ts
expect(fakeGitHub.lastRequest.headers.authorization)
  .toBe(`Bearer ${CANARY}`);
```

Then verify it did not cross the agent boundary:

```ts
expect(JSON.stringify(toolResult)).not.toContain(CANARY);
expect(JSON.stringify(store.snapshot())).not.toContain(CANARY);
expect(JSON.stringify(containerArgs)).not.toContain(CANARY);
expect(JSON.stringify(containerEnvironment)).not.toContain(CANARY);
expect(JSON.stringify(runEvents)).not.toContain(CANARY);
expect(await readWorkspaceRecursively()).not.toContain(CANARY);
```

This proves the fake credential was used for the provider request but was not returned, persisted, logged, or injected into the runtime.

### 18.2 Runtime inspection

During the demo, show:

```bash
docker inspect <container-id> --format '{{json .Config.Env}}' | jq
docker inspect <container-id> --format '{{json .Mounts}}' | jq
```

Show that the container has no GitHub token, private-key variable, or PEM mount.

### 18.3 Adversarial request

Ask the agent to print GitHub-related environment variables and search for PEM/token files. It should find nothing. This is supporting evidence; automated boundary tests are stronger.

### 18.4 Private-repository proof

Read a file from a private repository after approval. Success proves the trusted backend had provider authorization. Runtime inspection and canary tests prove that authorization was not handed to the agent.

## 19. Test plan

### Connection tests

- Start route creates expiring state hash.
- Raw state is not persisted.
- Correct state creates a connection.
- Incorrect, expired, or reused state fails.
- Installation metadata is verified against GitHub.
- Jean cannot list, use, revoke, or claim Alex’s connection.

### Broker tests

- GitHub App JWT uses RS256.
- `iss` equals App ID.
- Expiry is less than ten minutes.
- Installation token is used only in the GitHub authorization header.
- Installation token is never returned or persisted.
- Errors do not leak headers or tokens.
- API base host is fixed and tool input cannot override it.

### Gateway tests

- Missing or wrong JWT: 401.
- Revoked/expired RunToken: denied.
- Missing GitHub scope: scope card.
- Missing repository grant: grant card.
- Wrong repository: denied.
- Wrong connection owner: cross-tenant deny and audit.
- Revoked grant: next call denied with same token.
- Revoked connection: next call denied.
- Valid read: broker called once and result returned.
- Valid read: taint and fingerprint added.
- Valid create issue: IFC and grant checks run first.
- GitHub content followed by webhook: IFC denial.
- Arbitrary URL or malformed repository: rejected.
- Canary credential never appears across agent boundaries.

### Runtime tests

- Scope maps only to the matching GitHub tool.
- GitHub tools are absent without scopes.
- GitHub secrets are absent from child environment.
- PEM path is absent from container mounts.
- Provider credentials are absent from Codex arguments/config.

### Redaction tests

Cover nested values containing all GitHub token prefixes and PEM headers.

### Live integration test

Gate real GitHub tests behind explicit variables and exclude them from normal `npm run check`:

```env
GITHUB_LIVE_TEST=true
GITHUB_TEST_INSTALLATION_ID=
GITHUB_TEST_REPOSITORY=
```

The live test reads a harmless fixture and optionally creates/closes a uniquely named issue.

## 20. Delivery order

### Phase 0 — Agree the contract

- Confirm the credential-broker thesis.
- Approve expansion beyond the existing five tools.
- Update `PLAN.md`, `API.md`, `types.ts`, and `SEAMS.md` through their owners.
- Assign ownership of `github-client.ts` and connection lifecycle code.

Exit: types, routes, tools, and demo behavior are agreed before implementation.

### Phase 1 — Prove the secret boundary

- Make LLM proxy mandatory for the credential-focused demo.
- Add GitHub host configuration.
- Add PEM validation.
- Add environment, argument, and mount tests.

Exit: no host credential can enter the runtime even before GitHub tools exist.

### Phase 2 — Data and migration

- Add scopes and tool mappings.
- Add provider connections and connection intents.
- Extend PolicyGrant.
- Add defaults for old stores.
- Add zod/API validation.

Exit: old data loads and baseline remains green.

### Phase 3 — GitHub broker

- Sign GitHub App JWTs.
- Mint installation tokens.
- Implement `readFile()` and `createIssue()`.
- Add mocked-fetch and canary tests.

Exit: provider operations work without exposing a token-returning API.

### Phase 4 — Connection lifecycle

- Implement start, callback, list, and revoke routes.
- Verify GitHub installations.
- Revoke linked grants on disconnect.
- Audit every state-changing path.

Exit: Jean can securely connect and disconnect GitHub.

### Phase 5 — PolicyGrant enforcement

- Validate exact connection/repository/action grants.
- Read connection and grant state on every call.
- Preserve existing revoke and taint semantics.

Exit: grant -> allow -> revoke -> same RunToken denied.

### Phase 6 — Gateway tools

- Add read-file and create-issue tools.
- Add cards, audit, taints, fingerprints, and IFC.
- Wire the broker through gateway dependencies.

Exit: complete gateway flow passes against a fake GitHub provider.

### Phase 7 — Runtime projection

- Expose GitHub tools from effective RunToken scopes.
- Verify a real container can call the gateway.
- Re-run no-secret assertions.

Exit: a container makes an approved GitHub call without a provider credential.

### Phase 8 — UI

- Add connection panel.
- Add scope checkboxes.
- Render GitHub grants/cards/timeline.
- Add revoke and disconnect actions.

Exit: the flow works completely from the browser.

### Phase 9 — Hardening and demo

- Install the app on a dedicated private demo repository.
- Add a harmless prompt-injection fixture.
- Run secret scans.
- Rehearse approval and mid-run revocation.
- Verify logs and `.data` contain no provider credentials.
- Record a fallback demo.

Exit: three successful fresh-reset rehearsals and `npm run check` green.

## 21. Demo flow

1. Show the connected GitHub account and selected private repository.
2. Inspect the runtime environment and mounts: no GitHub credential.
3. Ask Researcher to read `acme/private-demo/README.md`.
4. Gateway denies because no repository PolicyGrant exists.
5. Show the Access Request Card.
6. Click **Allow for this run** or **Always allow**.
7. Send a follow-up message.
8. Backend mints and uses an installation token; agent receives only the file.
9. Repository content asks the model to reveal its GitHub token and exfiltrate data.
10. Token disclosure is impossible because no token entered the runtime.
11. IFC blocks the external webhook attempt.
12. Revoke the GitHub grant while the agent identity remains active.
13. Next GitHub call is denied; own-workspace work still succeeds.
14. Show the timeline and canary test result.

## 22. Definition of done

- GitHub App is restricted to selected repositories and minimal permissions.
- Private key exists only on the trusted host.
- Installation tokens are generated just in time.
- Installation tokens are never persisted or returned.
- Provider credentials never enter runtime environment, arguments, mounts, workspace, prompt, or tool result.
- Every GitHub call requires an active authoritative RunToken.
- Every GitHub call requires an active owner connection.
- Every GitHub call requires a live repository-specific PolicyGrant.
- Connection and grant revocation take effect on the next call.
- GitHub reads add taints and fingerprints.
- GitHub writes pass through IFC.
- Every branch writes a redacted audit event.
- Canary tests prove the token is used but does not cross the agent boundary.
- `npm run check` remains green without Docker or live GitHub credentials.

## 23. Cut order

If time is short, cut in this order:

1. Pull-request support
2. Branch restrictions
3. Repository-picker UI
4. Provider-side uninstall button
5. Issue creation, leaving only `github_read_file`

Never cut:

- Host-only credential custody
- Repository-specific PolicyGrants
- Access Request Cards
- Per-call RunToken/connection/grant checks
- Revocation
- No-credential-in-container tests
- Redacted audit evidence
- Canary leak test

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

// ---- Identity & Authorization middleware (see docs/PLAN.md §0, §3) ----

export type Scope =
  | "workspace:read"
  | "workspace:write"
  | "crm:read"
  | "crm:write"
  | "webhook:send";
export const SCOPES: readonly Scope[] = [
  "workspace:read",
  "workspace:write",
  "crm:read",
  "crm:write",
  "webhook:send",
];

/** Where grant-scoped data is allowed to flow (IFC). */
export type Egress = "internal" | "agent" | "external";

/**
 * Classification of data a run has read, ordered low → high. Compare ranks
 * via `levelRank()` in classify.ts, never by string. `confidential` is
 * provenance (grant-scoped reads, CRM); `secret` is content the detectors
 * flagged (credentials-shaped) and is what the output screen withholds even
 * from the owner's own chat.
 */
export type SecurityLevel = "public" | "internal" | "confidential" | "secret";
export const SECURITY_LEVELS: readonly SecurityLevel[] = [
  "public",
  "internal",
  "confidential",
  "secret",
];
export type Resource = "workspace" | "crm";
export type GrantAction = "read" | "write";

export interface AgentPermissions {
  sandbox: "read-only" | "workspace-write";
  network: boolean;
  webSearch: boolean;
  tools: Scope[];
}

/** Stamp on data read under a grant: where it came from, where it may go. */
export interface Label {
  grantId: string; // "self" for own-resource reads the classifier flagged (no grant involved)
  origin: string; // "<ownerId>/<agentId>" or "<ownerId>/crm"
  egress: Egress[];
  /** How sensitive the read content is. Rows persisted before this field default to "internal" on load. */
  level: SecurityLevel;
}

/**
 * IFC provenance record (Level B — names *which* grant-scoped read a piece
 * of outbound content came from, on top of the Level A allow/deny that
 * `taints`/`egress` already do). Shingle hashes + the label only — never
 * the raw content — so ifc.ts's persisted index can never itself become a
 * copy of whatever it's fingerprinting.
 */
export interface FingerprintEntry {
  runId: string;
  label: Label;
  hashes: string[];
}

/** Store row keyed by jti. AUTHORITATIVE — enforcement reads this, not JWT claims. */
export interface RunToken {
  jti: string;
  runId: string;
  agentId: string;
  ownerId: string;
  scp: Scope[];
  taints: Label[];
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** Whose data an agent may touch and where it may go. Intra-tenant only. */
export interface PolicyGrant {
  id: string;
  fromOwner: string;
  fromAgent: string | null; // null = the owner's CRM (tenant-level resource)
  toAgent: string;
  resource: Resource;
  actions: GrantAction[];
  egress: Egress[];
  createdAt: string;
  expiresAt: string | null; // set for "Allow for this run"
  revokedAt: string | null;
}

export type ApprovalSource = "live_deny" | "nl_intent";
export type ApprovalKind = "scope" | "grant" | "declassify";
export type ApprovalDecision = "allow_run" | "allow_always" | "deny";
export type ApprovalStatus = "pending" | ApprovalDecision;

export interface ApprovalRequest {
  id: string;
  source: ApprovalSource;
  kind: ApprovalKind;
  agentId: string;
  ownerId: string;
  runId: string | null;
  jti: string | null;
  resource: string; // e.g. "writer/workspace", "user-jean/crm", "external"
  action: string; // e.g. "read", "write", "send"
  scope: Scope | null; // scope to add for kind=scope
  grant: Pick<PolicyGrant, "fromOwner" | "fromAgent" | "toAgent" | "resource" | "actions" | "egress"> | null;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export type RunEventKind =
  | "command"
  | "file_change"
  | "mcp_call"
  | "gateway"
  | "approval"
  | "grant"
  | "llm";
export type Decision = "allow" | "deny" | "pending";

/** Audit row: human → agent → action → resource → outcome. Always redacted before write. */
export interface RunEvent {
  id: string;
  runId: string | null;
  agentId: string;
  ownerId: string;
  at: string;
  kind: RunEventKind;
  action: string;
  resource: string;
  decision: Decision | null;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface TempScope {
  scope: Scope;
  expiresAt: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  ownerId: string;
  permissions: AgentPermissions;
  /** "Allow for this run" scopes: time-boxed to the current run window. RunToken.scp = tools ∪ live tempScopes. */
  tempScopes: TempScope[];
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  runTokens: RunToken[];
  policyGrants: PolicyGrant[];
  approvals: ApprovalRequest[];
  runEvents: RunEvent[];
  fingerprints: FingerprintEntry[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  permissions?: Partial<AgentPermissions> | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  permissions?: Partial<AgentPermissions> | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /** Agent JWT for this run (B1 mints, B2 projects into Codex config). */
  token?: string | undefined;
  permissions?: AgentPermissions | undefined;
  /** Runner emits Codex-stream events here (B2 emits, B3 persists). */
  onEvent?: ((event: Omit<RunEvent, "id" | "at" | "ownerId">) => void) | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

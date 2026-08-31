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

/**
 * Whether content can be *believed*, as opposed to how sensitive it is. Decided
 * by the channel the content arrived on — inside the trust boundary or not —
 * and never by reading it: a model asked "is this trustworthy?" is reading
 * attacker-controlled text, and the attacker can write the answer.
 */
export type Trust = "trusted" | "untrusted";

/** Stamp on data read under a grant: where it came from, where it may go. */
export interface Label {
  grantId: string; // "self" for own-resource reads the classifier flagged (no grant involved)
  origin: string; // "<ownerId>/<agentId>" or "<ownerId>/crm"
  egress: Egress[];
  /** How sensitive the read content is. Rows persisted before this field default to "internal" on load. */
  level: SecurityLevel;
  /** Rows persisted before this field default to "untrusted" on load — the safe direction. */
  trust: Trust;
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
  /**
   * Concrete destinations a human approved for *this run* — a webhook URL, a
   * `"<name>/workspace"`. "Allow for this run" on a declassify card writes one
   * of these rather than widening the whole destination class, so approving
   * "post this to our team webhook" does not also permit an attacker's URL.
   * Rows persisted before this field default to `[]` on load.
   */
  egressAllow: string[];
  /**
   * What the *task* looked like it needed, from the user's message alone
   * (`scope-estimator.ts`). `scp` is this intersected with what the agent
   * holds. Kept because it is the baseline a card is judged against: a tool
   * the agent asks for that is not in here is a tool the user's own request
   * never implied. Empty means the estimator had no opinion and `scp` is the
   * agent's standing set unchanged. Rows persisted before this field default
   * to `[]` on load.
   */
  estimated: Scope[];
  /**
   * Standing scopes this run did *not* get, so the UI can say "1 of 3 tools
   * active" after the fact. Not recomputable later — the agent's permissions
   * may have changed since — so it is recorded at mint. Rows persisted before
   * this field default to `[]` on load.
   */
  withheld: Scope[];
  /**
   * The agent's Codex thread as of this mint, or null for a run that predates
   * the thread it went on to create. Taints carry forward from the previous
   * run only while this is the same conversation — the model's memory of what
   * it read is what the taint is tracking. Rows persisted before this field
   * default to null on load.
   */
  threadId: string | null;
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
  /**
   * May content read under this grant be *believed*? Default `false`: a
   * borrowed workspace is outside the trust boundary, so what an agent reads
   * there cannot trigger an outbound action without a human. Rows persisted
   * before this field default to `false` on load.
   */
  trustContent: boolean;
  createdAt: string;
  expiresAt: string | null; // set for "Allow for this run"
  revokedAt: string | null;
}

export type ApprovalSource = "live_deny" | "nl_intent";
export type ApprovalKind = "scope" | "grant" | "declassify";
export type ApprovalDecision = "allow_run" | "allow_always" | "deny";
export type ApprovalStatus = "pending" | ApprovalDecision;

/**
 * How alarming this card should be, computed server-side from what the run
 * actually did — never styling the UI picks for itself (CLAUDE.md rule 5).
 *
 * `critical` is the prompt-injection signature and nothing else: the agent is
 * reaching for something the user's own request never implied, while holding
 * content from outside the trust boundary, and pointing it outward. Rare by
 * construction, which is the point — a card that always looks alarming is a
 * card nobody reads (OWASP ASI09, automation bias).
 */
export type ApprovalRisk = "routine" | "elevated" | "critical";

/**
 * What makes the card believable, as facts rather than adjectives. The alarm
 * is the juxtaposition of `userAsked` and `attempting`; the origins name what
 * changed the agent's behaviour.
 */
export interface ApprovalEvidence {
  /** The message that started the run, truncated. Null if the run is gone. */
  userAsked: string | null;
  /** What the agent is trying to do, in one human phrase. */
  attempting: string;
  /** The request is outside what the user's own message implied. */
  outsideTaskScope: boolean;
  /** Origin of untrusted content the run is holding, if any. */
  untrustedOrigin: string | null;
  /** Origin of classified content blocked from this destination, if any. */
  classifiedOrigin: string | null;
}

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
  /** Rows persisted before this field default to "routine" on load. */
  risk: ApprovalRisk;
  /** Rows persisted before this field get an empty-handed default on load. */
  evidence: ApprovalEvidence;
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

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type Scope =
  | "workspace:read"
  | "workspace:write"
  | "crm:read"
  | "crm:write"
  | "webhook:send";

export interface AgentPermissions {
  sandbox: "read-only" | "workspace-write";
  network: boolean;
  webSearch: boolean;
  tools: Scope[];
}

export interface TempScope {
  scope: Scope;
  expiresAt: string;
}

export type Egress = "internal" | "agent" | "external";
export type GrantAction = "read" | "write";
export type Resource = "workspace" | "crm";

export interface PolicyGrant {
  id: string;
  fromOwner: string;
  fromAgent: string | null;
  toAgent: string;
  resource: Resource;
  actions: GrantAction[];
  egress: Egress[];
  /** May content read under this grant trigger an outbound action? Default false. */
  trustContent: boolean;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export type ApprovalSource = "live_deny" | "nl_intent";
export type ApprovalKind = "scope" | "grant" | "declassify";
export type ApprovalDecision = "allow_run" | "allow_always" | "deny";
export type ApprovalStatus = "pending" | ApprovalDecision;
export type EventFilter = "policy" | "all";
export type RunEventKind =
  | "command"
  | "file_change"
  | "mcp_call"
  | "gateway"
  | "approval"
  | "grant"
  | "llm";
export type EventDecision = "allow" | "deny" | "pending";

export interface RunEvent {
  id: string;
  runId: string | null;
  agentId: string;
  ownerId: string;
  at: string;
  kind: RunEventKind;
  action: string;
  resource: string;
  decision: EventDecision | null;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  source: ApprovalSource;
  kind: ApprovalKind;
  agentId: string;
  ownerId: string;
  runId: string | null;
  jti: string | null;
  resource: string;
  action: string;
  scope: Scope | null;
  grant: Pick<
    PolicyGrant,
    "fromOwner" | "fromAgent" | "toAgent" | "resource" | "actions" | "egress"
  > | null;
  reason: string;
  /** Optional on the wire: a server older than these fields omits them. */
  risk?: ApprovalRisk;
  evidence?: ApprovalEvidence;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** Computed server-side. The UI renders this judgement, it never makes one. */
export type ApprovalRisk = "routine" | "elevated" | "critical";

export interface ApprovalEvidence {
  userAsked: string | null;
  attempting: string;
  outsideTaskScope: boolean;
  untrustedOrigin: string | null;
  classifiedOrigin: string | null;
}

/** What one run was allowed to do, against what the agent holds standing. */
export interface RunScopes {
  active: Scope[];
  withheld?: Scope[];
  estimated?: Scope[];
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  ownerId: string;
  permissions: AgentPermissions;
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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface WorkspaceFile {
  /** Relative to the workspace root, always "/"-separated. */
  path: string;
  size: number;
  modifiedAt: string;
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

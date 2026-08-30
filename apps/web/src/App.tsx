import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  clearAuthToken,
  setAuthToken,
  setUnauthorizedHandler,
} from "./api";
import type {
  Agent,
  AgentPermissions,
  AgentRun,
  ApprovalDecision,
  ApprovalRequest,
  EventFilter,
  Message,
  PolicyGrant,
  RunEvent,
  Scope,
  SystemInfo,
  WorkspaceFile,
  WorkspaceFileContent,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const defaultPermissions: AgentPermissions = {
  sandbox: "workspace-write",
  network: true,
  webSearch: false,
  tools: [],
};

const newAgentForm = () => ({
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
  permissions: { ...defaultPermissions, tools: [...defaultPermissions.tools] },
});

const toolOptions: ReadonlyArray<{
  scope: Scope;
  label: string;
  description: string;
}> = [
    { scope: "workspace:read", label: "Read workspaces", description: "Read files through the audited gateway." },
    { scope: "workspace:write", label: "Write workspaces", description: "Write files through the audited gateway." },
    { scope: "crm:read", label: "Read CRM", description: "Read CRM records for this tenant." },
    { scope: "crm:write", label: "Write CRM", description: "Create or update tenant CRM notes." },
    { scope: "webhook:send", label: "Send webhooks", description: "Request external egress through the gateway." },
  ];

const demoUsers = [
  { id: "user-jean", name: "Jean" },
  { id: "user-alex", name: "Alex" },
];

const authStorageKey = "launchpad.auth";

type LoggedInUser = { id: string; name: string };

function restoreStoredUser(): LoggedInUser | null {
  const raw = window.localStorage.getItem(authStorageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; user?: unknown };
    const user = parsed.user as Partial<LoggedInUser> | undefined;
    if (
      typeof parsed.token !== "string" ||
      !parsed.token.trim() ||
      typeof user?.id !== "string" ||
      !user.id ||
      typeof user.name !== "string" ||
      !user.name
    ) {
      throw new Error("Invalid stored session");
    }
    setAuthToken(parsed.token);
    return { id: user.id, name: user.name };
  } catch {
    window.localStorage.removeItem(authStorageKey);
    clearAuthToken();
    return null;
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatEventTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return Math.round(value / 1024) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) + "…" : value;
}

function formatEventLabel(value: string): string {
  return value.replaceAll("_", " ");
}

// "action" in event.detail is the grant-level action (read/write) the
// gateway checked for — a different concept from the tool name already
// shown above it (e.g. "workspace_read"). Label it distinctly so it
// doesn't read as a duplicate of that line.
function formatDetailKey(key: string): string {
  if (key === "action") return "Grant action needed";
  return formatEventLabel(key);
}

function formatDetailValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function grantState(grant: PolicyGrant): "active" | "expired" | "revoked" {
  if (grant.revokedAt) return "revoked";
  if (grant.expiresAt && grant.expiresAt <= new Date().toISOString()) return "expired";
  return "active";
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

type FileTreeNode =
  | { type: "folder"; name: string; path: string; children: FileTreeNode[] }
  | { type: "file"; name: string; path: string; size: number };

function buildFileTree(entries: WorkspaceFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const childrenByPath = new Map<string, FileTreeNode[]>([["", root]]);

  const ensureFolder = (path: string): FileTreeNode[] => {
    const existing = childrenByPath.get(path);
    if (existing) return existing;
    const cut = path.lastIndexOf("/");
    const parentPath = cut >= 0 ? path.slice(0, cut) : "";
    const name = cut >= 0 ? path.slice(cut + 1) : path;
    const parentChildren = ensureFolder(parentPath);
    const node: FileTreeNode = { type: "folder", name, path, children: [] };
    parentChildren.push(node);
    childrenByPath.set(path, node.children);
    return node.children;
  };

  for (const file of entries) {
    const cut = file.path.lastIndexOf("/");
    const parentPath = cut >= 0 ? file.path.slice(0, cut) : "";
    const name = cut >= 0 ? file.path.slice(cut + 1) : file.path;
    ensureFolder(parentPath).push({ type: "file", name, path: file.path, size: file.size });
  }

  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) =>
      a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name),
    );
    for (const node of nodes) if (node.type === "folder") sortNodes(node.children);
  };
  sortNodes(root);
  return root;
}

function FileTree({
  nodes,
  depth,
  expanded,
  onToggleFolder,
  selectedPath,
  onSelectFile,
}: {
  nodes: FileTreeNode[];
  depth: number;
  expanded: Set<string>;
  onToggleFolder: (path: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.type === "folder" ? (
          <div key={node.path}>
            <button
              className="tree-row tree-folder"
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => onToggleFolder(node.path)}
            >
              <span className={"tree-chevron" + (expanded.has(node.path) ? " open" : "")}>
                ›
              </span>
              {node.name}
            </button>
            {expanded.has(node.path) && (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                onToggleFolder={onToggleFolder}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
        ) : (
          <button
            key={node.path}
            className={"tree-row tree-file" + (selectedPath === node.path ? " selected" : "")}
            style={{ paddingLeft: 24 + depth * 14 }}
            aria-pressed={selectedPath === node.path}
            onClick={() => onSelectFile(node.path)}
          >
            <span className="tree-file-name">{node.name}</span>
            <span className="files-size">{formatBytes(node.size)}</span>
          </button>
        ),
      )}
    </>
  );
}

function ApprovalCard({
  approval,
  agentName,
  deciding,
  disabled,
  onDecide,
}: {
  approval: ApprovalRequest;
  agentName: string;
  deciding: boolean;
  disabled: boolean;
  onDecide: (decision: ApprovalDecision, trustContent: boolean) => void;
}) {
  // Only a grant card creates a source the agent will later read from, so this
  // is the only card where trusting the content is a question. Off by default:
  // borrowed content cannot drive an outbound action unless a human says so.
  const [trustContent, setTrustContent] = useState(false);
  return (
    <article className="approval-card">
      <h3>{agentName} requests access</h3>
      <p className="approval-summary">
        <strong>{approval.action}</strong> → <code>{approval.resource}</code>
      </p>
      <p className="approval-reason">{approval.reason}</p>
      {approval.scope && (
        <p className="approval-detail">
          Missing scope <code>{approval.scope}</code>
        </p>
      )}
      {approval.grant && (
        <p className="approval-detail">
          Grant: {approval.grant.resource} · {approval.grant.actions.join(" + ")} · egress{" "}
          {approval.grant.egress.join(", ")}
        </p>
      )}
      {approval.kind === "grant" && (
        <label className="approval-trust">
          <input
            type="checkbox"
            checked={trustContent}
            disabled={disabled}
            onChange={(event) => setTrustContent(event.target.checked)}
          />
          <span>
            Trust content from this source
            <small>
              Leave off and the agent can read it, but cannot act on it outward without asking
              you again.
            </small>
          </span>
        </label>
      )}
      {deciding && (
        <div className="approval-saving">
          <Spinner /> Saving decision…
        </div>
      )}
      <div className="approval-actions">
        <button className="button approval-deny-button" disabled={disabled} onClick={() => onDecide("deny", false)}>
          Deny
        </button>
        <button className="button button-ghost" disabled={disabled} onClick={() => onDecide("allow_run", trustContent)}>
          Allow for this run
        </button>
        <button className="button button-primary" disabled={disabled} onClick={() => onDecide("allow_always", trustContent)}>
          Always allow
        </button>
      </div>
    </article>
  );
}

function PermissionChips({
  permissions,
  compact = false,
}: {
  permissions: AgentPermissions;
  compact?: boolean;
}) {
  const chips = [
    {
      label: permissions.sandbox === "read-only" ? "Read-only" : "Workspace write",
      kind: "runtime",
      muted: false,
    },
    ...(!compact || permissions.network
      ? [{ label: permissions.network ? "Network on" : "Network off", kind: "runtime", muted: !permissions.network }]
      : []),
    ...(!compact || permissions.webSearch
      ? [{ label: permissions.webSearch ? "Web search on" : "Web search off", kind: "runtime", muted: !permissions.webSearch }]
      : []),
    ...permissions.tools.map((scope) => ({ label: scope, kind: "tool", muted: false })),
    ...(!compact && permissions.tools.length === 0
      ? [{ label: "No gateway tools", kind: "tool", muted: true }]
      : []),
  ];
  const visible = compact ? chips.slice(0, 3) : chips;
  const remaining = chips.length - visible.length;

  return (
    <div className={"permission-chips" + (compact ? " permission-chips-compact" : "")}>
      {visible.map((chip) => (
        <span
          className={
            "permission-chip permission-chip-" + chip.kind + (chip.muted ? " muted" : "")
          }
          key={chip.label}
        >
          {chip.label}
        </span>
      ))}
      {remaining > 0 && <span className="permission-chip permission-chip-more">+{remaining}</span>}
    </div>
  );
}

function PermissionsFields({
  idPrefix,
  permissions,
  onChange,
}: {
  idPrefix: string;
  permissions: AgentPermissions;
  onChange: (permissions: AgentPermissions) => void;
}) {
  const setTool = (scope: Scope, enabled: boolean) => {
    const tools = enabled
      ? [...new Set([...permissions.tools, scope])]
      : permissions.tools.filter((item) => item !== scope);
    onChange({ ...permissions, tools });
  };

  return (
    <fieldset className="permissions-editor">
      <legend>Permissions</legend>
      <p className="permissions-help">
        Sandbox access controls direct Codex access to its own workspace. Workspace tools
        are gateway-mediated and audited.
      </p>

      <div className="permission-group">
        <span className="permission-group-title">Sandbox</span>
        <div className="permission-choice-grid">
          <label className="permission-choice" htmlFor={idPrefix + "-sandbox-read"}>
            <input
              id={idPrefix + "-sandbox-read"}
              name={idPrefix + "-sandbox"}
              type="radio"
              checked={permissions.sandbox === "read-only"}
              onChange={() => onChange({ ...permissions, sandbox: "read-only" })}
            />
            <span>
              <strong>Read-only</strong>
              <small>Codex cannot directly modify its runtime workspace.</small>
            </span>
          </label>
          <label className="permission-choice" htmlFor={idPrefix + "-sandbox-write"}>
            <input
              id={idPrefix + "-sandbox-write"}
              name={idPrefix + "-sandbox"}
              type="radio"
              checked={permissions.sandbox === "workspace-write"}
              onChange={() => onChange({ ...permissions, sandbox: "workspace-write" })}
            />
            <span>
              <strong>Workspace write</strong>
              <small>Codex may directly edit files in its own workspace.</small>
            </span>
          </label>
        </div>
      </div>

      <div className="permission-group">
        <span className="permission-group-title">Runtime capabilities</span>
        <div className="permission-choice-grid">
          <label className="permission-choice" htmlFor={idPrefix + "-network"}>
            <input
              id={idPrefix + "-network"}
              type="checkbox"
              checked={permissions.network}
              onChange={(event) =>
                onChange({ ...permissions, network: event.target.checked })
              }
            />
            <span>
              <strong>Network access</strong>
              <small>Allow sandboxed commands to access the network.</small>
            </span>
          </label>
          <label className="permission-choice" htmlFor={idPrefix + "-web-search"}>
            <input
              id={idPrefix + "-web-search"}
              type="checkbox"
              checked={permissions.webSearch}
              onChange={(event) =>
                onChange({ ...permissions, webSearch: event.target.checked })
              }
            />
            <span>
              <strong>Web search</strong>
              <small>Enable Codex's built-in live web search.</small>
            </span>
          </label>
        </div>
      </div>

      <div className="permission-group">
        <span className="permission-group-title">Gateway tools</span>
        <div className="permission-tools-grid">
          {toolOptions.map((tool) => (
            <label className="permission-choice" htmlFor={idPrefix + "-" + tool.scope} key={tool.scope}>
              <input
                id={idPrefix + "-" + tool.scope}
                type="checkbox"
                checked={permissions.tools.includes(tool.scope)}
                onChange={(event) => setTool(tool.scope, event.target.checked)}
              />
              <span>
                <strong>{tool.label}</strong>
                <code>{tool.scope}</code>
                <small>{tool.description}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="permissions-note">
          A tool scope permits a request. Accessing another agent's data still requires a live grant.
        </p>
      </div>
    </fieldset>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(newAgentForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);
  const [grants, setGrants] = useState<PolicyGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [openFile, setOpenFile] = useState<WorkspaceFileContent | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [showFilesDrawer, setShowFilesDrawer] = useState(false);
  const [activeTab, setActiveTab] = useState<"security" | "playground" | "timeline">(
    "playground",
  );
  const [fileFilter, setFileFilter] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [drawerWidth, setDrawerWidth] = useState(720);
  const [treePaneWidth, setTreePaneWidth] = useState(220);
  const [approvalToasts, setApprovalToasts] = useState<
    { approval: ApprovalRequest; agentName: string }[]
  >([]);
  const [dismissedApprovalModalIds, setDismissedApprovalModalIds] = useState<Set<string>>(
    new Set(),
  );
  const knownPendingApprovalIdsRef = useRef<Set<string> | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventFilter, setEventFilter] = useState<EventFilter>("policy");
  const [killingAgent, setKillingAgent] = useState(false);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [currentUser, setCurrentUser] = useState<LoggedInUser | null>(restoreStoredUser);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const accountWrapperRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const sessionVersionRef = useRef(0);
  const eventRequestRef = useRef(0);
  const timelineFilterRef = useRef<EventFilter>(eventFilter);
  const initialUserRef = useRef(currentUser);
  selectedIdRef.current = selectedId;
  timelineFilterRef.current = eventFilter;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const filteredFiles = useMemo(() => {
    const query = fileFilter.trim().toLowerCase();
    if (!query) return null;
    return files.filter((file) => file.path.toLowerCase().includes(query));
  }, [files, fileFilter]);
  const pendingApprovals = useMemo(
    () => approvals
      .filter((approval) => approval.status === "pending")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [approvals],
  );
  // Scoped to the agent actually on screen — a request for a different
  // agent must never surface here (that's what the toast is for).
  const selectedAgentPendingApprovals = useMemo(
    () => pendingApprovals.filter((approval) => approval.agentId === selected?.id),
    [pendingApprovals, selected],
  );
  const visibleModalApprovals = useMemo(
    () =>
      selectedAgentPendingApprovals.filter(
        (approval) => !dismissedApprovalModalIds.has(approval.id),
      ),
    [selectedAgentPendingApprovals, dismissedApprovalModalIds],
  );
  // Badges signal "this many need attention" — a revoked or expired grant
  // doesn't, so counts exclude them. The list itself still shows history.
  const activeGrantsCount = useMemo(
    () => grants.filter((grant) => grantState(grant) === "active").length,
    [grants],
  );
  const latestBlockedEvent = useMemo(() => {
    if (!activeRun) return null;
    const policyEvents = events.filter(
      (event) =>
        event.runId === activeRun.id &&
        ["gateway", "approval", "grant"].includes(event.kind),
    );
    const latest = policyEvents.at(-1) ?? null;
    return latest?.decision === "deny" ? latest : null;
  }, [activeRun, events]);
  const blockedEventHasCard = useMemo(
    () =>
      latestBlockedEvent !== null &&
      pendingApprovals.some(
        (approval) =>
          approval.agentId === latestBlockedEvent.agentId &&
          approval.runId === latestBlockedEvent.runId,
      ),
    [latestBlockedEvent, pendingApprovals],
  );
  const isProcessing = useMemo(
    () =>
      (activeRun != null && ["queued", "running"].includes(activeRun.status)) ||
      selected?.status === "busy",
    [activeRun, selected?.status],
  );

  const clearSession = useCallback((message: string | null = null) => {
    sessionVersionRef.current += 1;
    window.localStorage.removeItem(authStorageKey);
    clearAuthToken();
    pollingRunIds.current.clear();
    selectedIdRef.current = null;
    setCurrentUser(null);
    setAgents([]);
    setSelectedId(null);
    setMessages([]);
    setSystem(null);
    setShowCreate(false);
    setShowSettings(false);
    setForm(newAgentForm());
    setPrompt("");
    setActiveRun(null);
    setApprovals([]);
    setApprovalsLoading(false);
    setDecidingApprovalId(null);
    setGrants([]);
    setGrantsLoading(false);
    setRevokingGrantId(null);
    eventRequestRef.current += 1;
    setEvents([]);
    setEventsLoading(false);
    setEventFilter("policy");
    setKillingAgent(false);
    setSecurityNotice(null);
    setBusy(false);
    setError(message);
    setAuthRequired(true);
  }, []);

  const refreshAgents = useCallback(async () => {
    const sessionVersion = sessionVersionRef.current;
    const { agents: next } = await api.listAgents();
    if (!mountedRef.current || sessionVersion !== sessionVersionRef.current) return;
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const sessionVersion = sessionVersionRef.current;
    const result = await api.messages(agentId);
    if (
      mountedRef.current &&
      sessionVersion === sessionVersionRef.current &&
      selectedIdRef.current === agentId
    ) {
      setMessages(result.messages);
    }
  }, []);

  const refreshGrants = useCallback(async (agentId: string) => {
    const sessionVersion = sessionVersionRef.current;
    setGrantsLoading(true);
    try {
      const result = await api.getAgentGrants(agentId);
      if (
        mountedRef.current &&
        sessionVersion === sessionVersionRef.current &&
        selectedIdRef.current === agentId
      ) {
        setGrants(result.grants);
      }
    } finally {
      if (
        mountedRef.current &&
        sessionVersion === sessionVersionRef.current &&
        selectedIdRef.current === agentId
      ) {
        setGrantsLoading(false);
      }
    }
  }, []);

  const refreshFiles = useCallback(async (agentId: string) => {
    const sessionVersion = sessionVersionRef.current;
    const current = () =>
      mountedRef.current &&
      sessionVersion === sessionVersionRef.current &&
      selectedIdRef.current === agentId;
    setFilesLoading(true);
    try {
      const result = await api.listWorkspaceFiles(agentId);
      if (current()) {
        setFiles(result.files);
        setFilesTruncated(result.truncated);
      }
    } finally {
      if (current()) setFilesLoading(false);
    }
  }, []);

  // The file body is fetched on click rather than with the listing: a workspace
  // can hold a lot of files, and only the one being looked at is worth sending.
  const showFile = useCallback(async (agentId: string, filePath: string) => {
    const sessionVersion = sessionVersionRef.current;
    setOpenFilePath(filePath);
    setOpenFile(null);
    setFileError(null);
    try {
      const result = await api.readWorkspaceFile(agentId, filePath);
      if (
        mountedRef.current &&
        sessionVersion === sessionVersionRef.current &&
        selectedIdRef.current === agentId
      ) {
        setOpenFile(result.file);
      }
    } catch (reason) {
      if (mountedRef.current && sessionVersion === sessionVersionRef.current) {
        setFileError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, []);

  const refreshEvents = useCallback(async (
    agentId: string,
    filter: EventFilter,
    showLoading = false,
  ) => {
    const sessionVersion = sessionVersionRef.current;
    const requestId = ++eventRequestRef.current;
    if (showLoading) setEventsLoading(true);
    try {
      const result = await api.getAgentEvents(agentId, filter);
      if (
        mountedRef.current &&
        sessionVersion === sessionVersionRef.current &&
        requestId === eventRequestRef.current &&
        selectedIdRef.current === agentId &&
        timelineFilterRef.current === filter
      ) {
        setEvents(result.events);
      }
    } finally {
      if (
        mountedRef.current &&
        sessionVersion === sessionVersionRef.current &&
        requestId === eventRequestRef.current &&
        selectedIdRef.current === agentId &&
        timelineFilterRef.current === filter
      ) {
        setEventsLoading(false);
      }
    }
  }, []);

  const refreshApprovals = useCallback(async (showLoading = false) => {
    const sessionVersion = sessionVersionRef.current;
    if (showLoading) setApprovalsLoading(true);
    try {
      const result = await api.listApprovals();
      if (mountedRef.current && sessionVersion === sessionVersionRef.current) {
        setApprovals((current) =>
          result.approvals.map((incoming) => {
            const existing = current.find((item) => item.id === incoming.id);
            return existing?.status !== undefined &&
              existing.status !== "pending" &&
              incoming.status === "pending"
              ? existing
              : incoming;
          }),
        );
      }
    } finally {
      if (
        showLoading &&
        mountedRef.current &&
        sessionVersion === sessionVersionRef.current
      ) {
        setApprovalsLoading(false);
      }
    }
  }, []);

  const bootstrap = useCallback(async () => {
    const sessionVersion = sessionVersionRef.current;
    const [, nextSystem] = await Promise.all([refreshAgents(), api.system()]);
    if (mountedRef.current && sessionVersion === sessionVersionRef.current) {
      setSystem(nextSystem);
    }
  }, [refreshAgents]);

  useEffect(() => {
    setUnauthorizedHandler(() =>
      clearSession("Your session expired. Please sign in again."),
    );
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (cancelled || !mountedRef.current) return;
        if (!required || initialUserRef.current) {
          await bootstrap();
          if (!cancelled && mountedRef.current) setAuthRequired(false);
        } else {
          setAuthRequired(true);
        }
      })
      .catch((reason) => {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 401) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    if (authRequired !== false || !currentUser) return;
    let cancelled = false;
    const load = (showLoading: boolean) => {
      void refreshApprovals(showLoading).catch((reason) => {
        if (!cancelled && !(reason instanceof ApiError && reason.status === 401)) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    };
    load(true);
    const timer = window.setInterval(() => load(false), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authRequired, currentUser, refreshApprovals]);

  // Toast any newly-arrived pending approval for an agent the user isn't
  // currently looking at — that agent's own page shows a blocking modal
  // instead, so a toast there would be redundant. First observation each
  // session just establishes the baseline; it doesn't toast for requests
  // that were already pending before this tab opened. Toasts persist until
  // the human acts on them or dismisses them — no auto-dismiss, since a
  // stuck task shouldn't quietly disappear from view.
  useEffect(() => {
    const pendingIds = new Set(
      approvals.filter((approval) => approval.status === "pending").map((approval) => approval.id),
    );
    const known = knownPendingApprovalIdsRef.current;
    if (known === null) {
      knownPendingApprovalIdsRef.current = pendingIds;
      return;
    }
    const arrivals = approvals.filter(
      (approval) =>
        approval.status === "pending" &&
        !known.has(approval.id) &&
        approval.agentId !== selectedIdRef.current,
    );
    if (arrivals.length > 0) {
      setApprovalToasts((current) => [
        ...current,
        ...arrivals.map((approval) => ({
          approval,
          agentName: agents.find((agent) => agent.id === approval.agentId)?.name ?? "An agent",
        })),
      ]);
    }
    knownPendingApprovalIdsRef.current = pendingIds;
  }, [approvals, agents]);

  // Toasts reflect live approval state — if a request is decided from
  // somewhere else (the modal, another tab), drop its toast automatically.
  useEffect(() => {
    setApprovalToasts((current) =>
      current.filter((toast) =>
        approvals.some((approval) => approval.id === toast.approval.id && approval.status === "pending"),
      ),
    );
  }, [approvals]);

  const dismissApprovalToast = (id: string) => {
    setApprovalToasts((current) => current.filter((toast) => toast.approval.id !== id));
  };

  const decideFromToast = (approval: ApprovalRequest, decision: ApprovalDecision) => {
    void decideApproval(approval, decision);
  };

  useEffect(() => {
    if (authRequired !== false || !currentUser || !selectedId) {
      eventRequestRef.current += 1;
      setEvents([]);
      setEventsLoading(false);
      return;
    }
    let cancelled = false;
    const load = (showLoading: boolean) => {
      void refreshEvents(selectedId, eventFilter, showLoading).catch((reason) => {
        if (!cancelled && !(reason instanceof ApiError && reason.status === 401)) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    };
    setEvents([]);
    load(true);
    const timer = window.setInterval(() => load(false), 2_000);
    return () => {
      cancelled = true;
      eventRequestRef.current += 1;
      window.clearInterval(timer);
    };
  }, [authRequired, currentUser, eventFilter, refreshEvents, selectedId]);

  useEffect(() => {
    setActiveRun(null);
    setGrants([]);
    setSecurityNotice(null);
    setShowSettings(false);
    // The open file belongs to the agent that was selected, so it goes with it
    // rather than sitting over the next agent's workspace under its old name.
    setFiles([]);
    setFilesTruncated(false);
    setOpenFile(null);
    setOpenFilePath(null);
    setFileError(null);
    setShowFilesDrawer(false);
    setFileFilter("");
    setExpandedFolders(new Set());
    if (!selectedId) {
      setMessages([]);
      setGrantsLoading(false);
      setFilesLoading(false);
      return;
    }
    void refreshGrants(selectedId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
    void refreshFiles(selectedId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshFiles, refreshGrants, refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
        permissions: {
          ...selected.permissions,
          tools: [...selected.permissions.tools],
        },
      });
    }
  }, [selected]);

  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTo({
        top: messagesContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, activeRun]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [selectedId]);

  useEffect(() => {
    if (!showAccountMenu) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        accountWrapperRef.current &&
        !accountWrapperRef.current.contains(event.target as Node)
      ) {
        setShowAccountMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowAccountMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showAccountMenu]);

  useEffect(() => {
    if (!showSettings) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowSettings(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showSettings]);

  useEffect(() => {
    if (!securityNotice) return;
    const timer = setTimeout(() => {
      setSecurityNotice(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [securityNotice]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(newAgentForm());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const stopProcessing = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.stopAgent(selected.id);
      pollingRunIds.current.clear();
      setActiveRun((current) => (current ? { ...current, status: "cancelled" } : null));
      await Promise.all([
        refreshAgents(),
        refreshMessages(selected.id),
        refreshEvents(selected.id, timelineFilterRef.current),
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const decideApproval = async (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    // The card's checkbox. The toast has no checkbox, so it stays false there.
    trustContent = false,
  ) => {
    if (approval.status !== "pending") return;
    const sessionVersion = sessionVersionRef.current;
    const selectedAgentId = selectedIdRef.current;
    setDecidingApprovalId(approval.id);
    setSecurityNotice(null);
    setError(null);
    try {
      const { approval: decided } = await api.decideApproval(approval.id, decision, trustContent);
      if (mountedRef.current && sessionVersion === sessionVersionRef.current) {
        setApprovals((current) =>
          current.map((item) => item.id === decided.id ? decided : item),
        );
        setSecurityNotice(
          decision === "deny"
            ? "Request denied. No permission or grant was added."
            : "Approved. Send a follow-up message so the agent retries the action.",
        );
        await Promise.all([
          refreshAgents(),
          refreshApprovals(),
          ...(selectedAgentId
            ? [
              refreshGrants(selectedAgentId),
              refreshEvents(selectedAgentId, timelineFilterRef.current),
            ]
            : []),
        ]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mountedRef.current && sessionVersion === sessionVersionRef.current) {
        setDecidingApprovalId(null);
      }
    }
  };

  const revokeGrant = async (grant: PolicyGrant) => {
    if (grantState(grant) !== "active") return;
    if (!window.confirm("Revoke this grant? The next protected call will be denied.")) {
      return;
    }
    const sessionVersion = sessionVersionRef.current;
    const agentId = selectedIdRef.current;
    setRevokingGrantId(grant.id);
    setSecurityNotice(null);
    setError(null);
    try {
      const { grant: revoked } = await api.revokeGrant(grant.id);
      if (
        mountedRef.current &&
        sessionVersion === sessionVersionRef.current &&
        selectedIdRef.current === agentId
      ) {
        setGrants((current) =>
          current.map((item) => item.id === revoked.id ? revoked : item),
        );
        setSecurityNotice("Grant revoked. The next protected call will be checked without it.");
        await Promise.all([
          refreshApprovals(),
          ...(agentId
            ? [refreshEvents(agentId, timelineFilterRef.current)]
            : []),
        ]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mountedRef.current && sessionVersion === sessionVersionRef.current) {
        setRevokingGrantId(null);
      }
    }
  };

  const killAgentIdentity = async () => {
    if (!selected) return;
    if (!window.confirm(
      "Kill " + selected.name + "'s identity?\n\n" +
      "This revokes all active run tokens and removes its gateway tool scopes. " +
      "It does not stop the Codex process or change sandbox access.",
    )) {
      return;
    }
    const sessionVersion = sessionVersionRef.current;
    const agentId = selected.id;
    const hadActiveScopes =
      selected.permissions.tools.length > 0 || selected.tempScopes.length > 0;
    setKillingAgent(true);
    setSecurityNotice(null);
    setError(null);
    try {
      const { agent: killed } = await api.killAgent(agentId);
      if (
        mountedRef.current &&
        sessionVersion === sessionVersionRef.current &&
        selectedIdRef.current === agentId
      ) {
        setAgents((current) =>
          current.map((agent) => agent.id === killed.id ? killed : agent),
        );
        setSecurityNotice(
          hadActiveScopes
            ? killed.name + "'s active identity was revoked and its gateway tools were removed."
            : "No active scopes to revoke — " + killed.name + " already had none.",
        );
        await Promise.all([
          refreshApprovals(),
          refreshEvents(agentId, timelineFilterRef.current),
        ]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mountedRef.current && sessionVersion === sessionVersionRef.current) {
        setKillingAgent(false);
      }
    }
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const resizeDrawer = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = drawerWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const max = Math.min(1100, window.innerWidth - 120);
      const next = startWidth - (moveEvent.clientX - startX);
      setDrawerWidth(Math.min(max, Math.max(380, next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resizeTreePane = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = treePaneWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + (moveEvent.clientX - startX);
      setTreePaneWidth(Math.min(drawerWidth - 260, Math.max(140, next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    const sessionVersion = sessionVersionRef.current;
    pollingRunIds.current.add(runId);
    try {
      while (
        mountedRef.current &&
        sessionVersion === sessionVersionRef.current
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (
          !mountedRef.current ||
          sessionVersion !== sessionVersionRef.current
        ) return;
        const result = await api.run(runId);
        if (
          sessionVersion === sessionVersionRef.current &&
          selectedIdRef.current === agentId
        ) {
          setActiveRun(result.run);
        }
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([
            refreshMessages(agentId),
            refreshAgents(),
            ...(selectedIdRef.current === agentId
              ? [refreshEvents(agentId, timelineFilterRef.current)]
              : []),
          ]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setShowSettings(false);
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const loginAs = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.login(userId);
      sessionVersionRef.current += 1;
      pollingRunIds.current.clear();
      selectedIdRef.current = null;
      setAuthToken(token);
      window.localStorage.setItem(authStorageKey, JSON.stringify({ token, user }));
      setCurrentUser(user);
      setAgents([]);
      setSelectedId(null);
      setMessages([]);
      setActiveRun(null);
      setApprovals([]);
      setGrants([]);
      eventRequestRef.current += 1;
      setEvents([]);
      setEventFilter("policy");
      setSecurityNotice(null);
      await bootstrap();
      if (mountedRef.current) setAuthRequired(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const logout = () => clearSession();

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Choose a demo user</h1>
          <p>We will call /api/auth/login, store the returned token, and show that user's agents.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="auth-actions">
            {demoUsers.map((user) => (
              <button
                key={user.id}
                className="button button-primary"
                disabled={busy}
                onClick={() => void loginAs(user.id)}
              >
                {busy ? <Spinner /> : "Continue as " + user.name}
              </button>
            ))}
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      {approvalToasts.length > 0 && (
        <div className="approval-toast-stack" role="status" aria-live="polite">
          {approvalToasts.map((toast) => {
            const deciding = decidingApprovalId === toast.approval.id;
            return (
              <article className="approval-toast" key={toast.approval.id}>
                <div className="approval-toast-head">
                  <div className="approval-toast-body">
                    <strong>{toast.agentName}</strong> requests access
                    <p>
                      {formatEventLabel(toast.approval.action)} → <code>{toast.approval.resource}</code>
                    </p>
                  </div>
                  <button
                    className="approval-toast-dismiss"
                    onClick={() => dismissApprovalToast(toast.approval.id)}
                    aria-label="Dismiss"
                  >
                    ×
                  </button>
                </div>
                {deciding && (
                  <div className="approval-saving">
                    <Spinner /> Saving decision…
                  </div>
                )}
                <div className="approval-toast-actions">
                  <button
                    className="button button-ghost"
                    disabled={decidingApprovalId !== null}
                    onClick={() => decideFromToast(toast.approval, "allow_run")}
                  >
                    Allow for this run
                  </button>
                  <button
                    className="button button-primary"
                    disabled={decidingApprovalId !== null}
                    onClick={() => decideFromToast(toast.approval, "allow_always")}
                  >
                    Always allow
                  </button>
                  <button
                    className="button approval-deny-button"
                    disabled={decidingApprovalId !== null}
                    onClick={() => decideFromToast(toast.approval, "deny")}
                  >
                    Deny
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(newAgentForm());
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => {
                setSelectedId(agent.id);
                window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
              }}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span className="agent-description">{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="runtime-card">
            <span className="eyebrow">Runtime</span>
            <strong>{system?.runtime ?? "Checking…"}</strong>
            <span>
              {system?.arkModel ?? "Ark model not configured"}
              {system?.containerEngine ? " · " + system.containerEngine : ""}
            </span>
          </div>

          {currentUser && (
            <div className="account-wrapper" ref={accountWrapperRef}>
              {showAccountMenu && (
                <div className="account-dropdown-menu" role="menu" aria-label="Switch account">
                  {/* Available Switchable Accounts */}
                  <div className="account-dropdown-list">
                    {demoUsers.map((user) => {
                      const isCurrent = user.id === currentUser.id;
                      return (
                        <button
                          key={user.id}
                          className={"account-dropdown-item " + (isCurrent ? "current" : "")}
                          disabled={busy}
                          onClick={() => {
                            setShowAccountMenu(false);
                            if (!isCurrent) {
                              void loginAs(user.id);
                            }
                          }}
                          role="menuitem"
                        >
                          <div className="account-switch-avatar-wrap">
                            <div className="account-avatar">{user.name.slice(0, 1).toUpperCase()}</div>
                            {!isCurrent && (
                              <div className="account-switch-badge">
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                                </svg>
                              </div>
                            )}
                          </div>
                          <div className="account-dropdown-item-content">
                            <strong className="account-dropdown-item-name">{user.name}</strong>
                          </div>
                          {isCurrent && (
                            <div className="account-dropdown-check">✓</div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <div className="account-dropdown-divider" />

                  <button
                    className="account-dropdown-logout"
                    onClick={() => {
                      setShowAccountMenu(false);
                      logout();
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    <span>Log out</span>
                  </button>
                </div>
              )}

              <div
                className={"account-card " + (showAccountMenu ? "active" : "")}
                onClick={() => setShowAccountMenu((prev) => !prev)}
              >
                <div className="account-avatar">{currentUser.name.slice(0, 1).toUpperCase()}</div>
                <div className="account-copy">
                  <strong>{currentUser.name}</strong>
                  <span>
                    {approvalsLoading
                      ? "Checking requests…"
                      : pendingApprovals.length > 0
                        ? pendingApprovals.length + " pending request" + (pendingApprovals.length === 1 ? "" : "s")
                        : "Signed in"}
                  </span>
                </div>
                <button
                  className="account-switch"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAccountMenu((prev) => !prev);
                  }}
                  title="Switch user"
                  aria-expanded={showAccountMenu}
                >
                  Switch
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
                <PermissionChips permissions={selected.permissions} />
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost icon-button"
                  onClick={() => setShowFilesDrawer(true)}
                  aria-label={"Open " + selected.name + "'s workspace files"}
                  title="Workspace files"
                >
                  <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M4 3.5C4 2.67 4.67 2 5.5 2H11l4 4v10.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 3 16.5v-13Zm7 .75V6.5h2.25L11 4.25Z"
                    />
                  </svg>
                  {files.length > 0 && <span className="icon-badge">{files.length}</span>}
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                {selected.status === "stopped" && (
                  <button
                    className="button button-ghost"
                    onClick={toggleAgent}
                    disabled={busy}
                  >
                    Start
                  </button>
                )}
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {visibleModalApprovals.length > 0 && (
              <div
                className="approval-modal-backdrop"
                onMouseDown={() =>
                  setDismissedApprovalModalIds((current) => {
                    const next = new Set(current);
                    for (const approval of visibleModalApprovals) next.add(approval.id);
                    return next;
                  })
                }
              >
                <div
                  className="approval-modal"
                  role="dialog"
                  aria-label="Access requests for this agent"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div className="approvals-heading">
                    <div>
                      <h2>{selected.name} is waiting on you</h2>
                      <p>
                        This task stays paused until you decide. Approve, then send a follow-up
                        message so {selected.name} can proceed.
                      </p>
                    </div>
                    <button
                      className="approval-toast-dismiss"
                      aria-label="Dismiss"
                      onClick={() =>
                        setDismissedApprovalModalIds((current) => {
                          const next = new Set(current);
                          for (const approval of visibleModalApprovals) next.add(approval.id);
                          return next;
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                  <div className="approval-list">
                    {visibleModalApprovals.map((approval) => (
                      <ApprovalCard
                        key={approval.id}
                        approval={approval}
                        agentName={selected.name}
                        deciding={decidingApprovalId === approval.id}
                        disabled={decidingApprovalId !== null}
                        onDecide={(decision, trustContent) => void decideApproval(approval, decision, trustContent)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {showSettings && (
              <div
                className="settings-drawer-backdrop"
                onMouseDown={() => setShowSettings(false)}
              >
                <form
                  className="settings-panel settings-drawer"
                  onSubmit={saveAgent}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div className="settings-title">
                    <div>
                      <span className="eyebrow">Agent configuration</span>
                      <h2>Identity and permissions</h2>
                    </div>
                    <button
                      type="button"
                      className="drawer-close-button"
                      onClick={() => setShowSettings(false)}
                      aria-label="Close settings"
                    >
                      ×
                    </button>
                  </div>
                  <div className="form-grid">
                    <label>
                      Name
                      <input
                        value={form.name}
                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                        required
                        maxLength={80}
                      />
                    </label>
                    <label>
                      Description
                      <input
                        value={form.description}
                        onChange={(event) =>
                          setForm({ ...form, description: event.target.value })
                        }
                        maxLength={500}
                      />
                    </label>
                  </div>
                  <label>
                    System instructions
                    <textarea
                      value={form.instructions}
                      onChange={(event) =>
                        setForm({ ...form, instructions: event.target.value })
                      }
                      rows={5}
                      maxLength={10_000}
                    />
                  </label>
                  <PermissionsFields
                    idPrefix="settings"
                    permissions={form.permissions}
                    onChange={(permissions) => setForm({ ...form, permissions })}
                  />
                  <div className="panel-footer">
                    <code>{selected.workspacePath}</code>
                    <button className="button button-primary" disabled={busy}>
                      {busy ? <Spinner /> : "Save changes"}
                    </button>
                  </div>
                </form>
              </div>
            )}

            {securityNotice && (
              <div className="toast-container" role="status" aria-live="polite">
                <div className="toast toast-success">
                  <span className="toast-icon">✓</span>
                  <p className="toast-message">{securityNotice}</p>
                  <button
                    type="button"
                    className="toast-close"
                    onClick={() => setSecurityNotice(null)}
                    aria-label="Dismiss notification"
                  >
                    ×
                  </button>
                </div>
              </div>
            )}

            <div className="agent-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={activeTab === "playground"}
                className={activeTab === "playground" ? "selected" : ""}
                onClick={() => setActiveTab("playground")}
              >
                Playground
              </button>
              <button
                role="tab"
                aria-selected={activeTab === "security"}
                className={activeTab === "security" ? "selected" : ""}
                onClick={() => setActiveTab("security")}
              >
                Grants &amp; Kill Switch
                {activeGrantsCount > 0 && <span className="tab-badge">{activeGrantsCount}</span>}
              </button>
              <button
                role="tab"
                aria-selected={activeTab === "timeline"}
                className={activeTab === "timeline" ? "selected" : ""}
                onClick={() => setActiveTab("timeline")}
              >
                Timeline
              </button>
            </div>

            {activeTab === "security" && (
              <div className="tab-scroll">
              {selectedAgentPendingApprovals.length > 0 && (
              <section className="approvals-panel" aria-label="Pending access requests">
                <div className="approvals-heading">
                  <div>
                    <h2>Access Requests</h2>
                    <p>Denied actions stay denied until you decide. Approval applies when the agent retries.</p>
                  </div>
                  <span>{selectedAgentPendingApprovals.length} pending</span>
                </div>
                <div className="approval-list">
                  {selectedAgentPendingApprovals.map((approval) => (
                    <ApprovalCard
                      key={approval.id}
                      approval={approval}
                      agentName={selected.name}
                      deciding={decidingApprovalId === approval.id}
                      disabled={decidingApprovalId !== null}
                      onDecide={(decision, trustContent) => void decideApproval(approval, decision, trustContent)}
                    />
                  ))}
                </div>
              </section>
              )}

              <section className="security-panel" aria-label="Agent security controls">
                <div className="security-card grants-card">
                  <div className="security-card-heading">
                    <div>
                      <h2>Policy grants</h2>
                      <p>Access involving this agent. The gateway checks active grants on every call.</p>
                    </div>
                    <span className="security-count">{activeGrantsCount}</span>
                  </div>

                  {grantsLoading ? (
                    <div className="security-empty"><Spinner /> Loading grants…</div>
                  ) : grants.length === 0 ? (
                    <div className="security-empty">
                      <strong>No grants yet</strong>
                      <span>Cross-agent access approved by the owner will appear here.</span>
                    </div>
                  ) : (
                    <div className="grant-list">
                      {[...grants]
                        .sort((left, right) => {
                          const rank = { active: 0, expired: 1, revoked: 2 } as const;
                          const stateDiff = rank[grantState(left)] - rank[grantState(right)];
                          return stateDiff !== 0
                            ? stateDiff
                            : right.createdAt.localeCompare(left.createdAt);
                        })
                        .map((grant) => {
                          const state = grantState(grant);
                          const source = grant.fromAgent === null
                            ? (currentUser?.name ?? "Owner") + "'s CRM"
                            : agents.find((agent) => agent.id === grant.fromAgent)?.name ?? shortId(grant.fromAgent);
                          const destination = agents.find((agent) => agent.id === grant.toAgent)?.name ?? shortId(grant.toAgent);
                          return (
                            <article className={"grant-row grant-row-" + state} key={grant.id}>
                              <div className="grant-main">
                                <div className="grant-direction">
                                  <strong>{source}</strong>
                                  <span>→</span>
                                  <strong>{destination}</strong>
                                </div>
                                <div className="grant-meta">
                                  <span>{grant.resource}</span>
                                  <span>{grant.actions.join(" + ")}</span>
                                  {grant.egress.map((egress) => (
                                    <span key={egress}>egress: {egress}</span>
                                  ))}
                                  <span>
                                    {grant.trustContent
                                      ? "content: trusted"
                                      : "content: untrusted"}
                                  </span>
                                </div>
                                <div className="grant-lifetime">
                                  {state === "revoked" && grant.revokedAt
                                    ? "Revoked " + formatDateTime(grant.revokedAt)
                                    : state === "expired" && grant.expiresAt
                                      ? "Expired " + formatDateTime(grant.expiresAt)
                                      : grant.expiresAt
                                        ? "Temporary · expires " + formatDateTime(grant.expiresAt)
                                        : "Permanent · active"}
                                </div>
                              </div>
                              {state === "active" ? (
                                <button
                                  className="button grant-revoke-button"
                                  disabled={revokingGrantId !== null}
                                  onClick={() => void revokeGrant(grant)}
                                >
                                  {revokingGrantId === grant.id ? <Spinner /> : "Revoke"}
                                </button>
                              ) : (
                                <span className={"grant-state grant-state-" + state}>{state}</span>
                              )}
                            </article>
                          );
                        })}
                    </div>
                  )}
                </div>

                <div className="security-card identity-card">
                  <div className="security-card-heading">
                    <div>
                      <h2>Kill switch</h2>
                    </div>
                  </div>
                  <p className="identity-copy">
                    Revoke every active run token and remove all gateway tool scopes for {selected.name}.
                  </p>
                  <div className="identity-scope-count">
                    <strong>{selected.permissions.tools.length}</strong>
                    <span>permanent gateway scope{selected.permissions.tools.length === 1 ? "" : "s"}</span>
                  </div>
                  <button
                    className="button button-danger kill-button"
                    disabled={killingAgent}
                    onClick={() => void killAgentIdentity()}
                  >
                    {killingAgent ? <><Spinner /> Killing identity…</> : "Kill agent identity"}
                  </button>
                  <p className="identity-note">
                    This does not stop Codex or change sandbox access. Use Stop to end the process.
                  </p>
                </div>
              </section>
              </div>
            )}

            {latestBlockedEvent && (
              <aside className="policy-blocked-callout" role="alert">
                <div className="policy-blocked-icon">!</div>
                <div>
                  <strong>Action blocked by policy</strong>
                  <p>
                    {selected.name} could not {formatEventLabel(latestBlockedEvent.action)} → {latestBlockedEvent.resource}.
                    {latestBlockedEvent.reason ? " Reason: " + latestBlockedEvent.reason + "." : ""}
                  </p>
                  {blockedEventHasCard && (
                    <span>An Access Request Card is pending.</span>
                  )}
                </div>
              </aside>
            )}

            {activeTab === "playground" && (
              <section className="playground">
                <div className="playground-topbar">
                  <div>
                    <h2>Build something with your Agent</h2>
                  </div>
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>

                <div className="messages" ref={messagesContainerRef}>
                  {messages.length === 0 && !activeRun ? (
                    <div className="welcome">
                      <div className="welcome-orbit">
                        <div>⌁</div>
                      </div>
                      <h3>What should {selected.name} build?</h3>
                      <p>
                        The Agent can inspect files, write code, run commands, and continue the
                        same Codex session across messages.
                      </p>
                      <div className="prompt-grid">
                        {starterPrompts.map((item) => (
                          <button key={item} onClick={() => setPrompt(item)}>
                            <span>↗</span>
                            {item}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <article className={"message message-" + message.role} key={message.id}>
                        <div className="message-meta">
                          <strong>{message.role === "user" ? "You" : selected.name}</strong>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <div className="message-body">{message.content}</div>
                      </article>
                    ))
                  )}
                  {activeRun && ["queued", "running"].includes(activeRun.status) && (
                    <article className="message message-assistant thinking">
                      <div className="message-meta">
                        <strong>{selected.name}</strong>
                        <span>working in the Agent workspace</span>
                      </div>
                      <div className="thinking-row">
                        <Spinner />
                        Codex is reading, editing, or running commands…
                      </div>
                    </article>
                  )}
                  {activeRun?.status === "failed" && (
                    <article className="run-error">
                      <strong>Run failed</strong>
                      <span>{activeRun.error}</span>
                    </article>
                  )}
                  <div ref={messageEnd} />
                </div>

                <form className="composer" onSubmit={sendMessage}>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        if (!isProcessing) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }
                    }}
                    placeholder={
                      selected.status === "stopped"
                        ? "Start this Agent to continue…"
                        : isProcessing
                          ? "Agent is processing…"
                          : "Describe what you want the Agent to do…"
                    }
                    disabled={selected.status === "stopped" || isProcessing}
                    rows={3}
                  />
                  <div className="composer-footer">
                    <span>
                      {isProcessing
                        ? "Agent is processing · Click Stop to cancel"
                        : "Enter to send · Shift + Enter for newline · " +
                        (system?.codexSandboxMode ?? "checking sandbox")}
                    </span>
                    {isProcessing ? (
                      <button
                        type="button"
                        className="send-button stop-button"
                        onClick={() => void stopProcessing()}
                        disabled={busy}
                        aria-label="Stop processing"
                        title="Stop processing"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <rect x="4" y="4" width="16" height="16" rx="3" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        type="submit"
                        className="send-button"
                        disabled={
                          !prompt.trim() ||
                          selected.status === "stopped" ||
                          busy
                        }
                        aria-label="Send message"
                      >
                        ↑
                      </button>
                    )}
                  </div>
                </form>
              </section>
            )}

            {showFilesDrawer && (
              <div
                className="files-drawer-backdrop"
                onMouseDown={() => setShowFilesDrawer(false)}
              >
                <section
                  className="files-panel files-drawer"
                  aria-label="Agent workspace files"
                  style={{ width: drawerWidth }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div
                    className="files-drawer-resize-handle"
                    onPointerDown={resizeDrawer}
                    aria-hidden="true"
                  />

                  <div className="timeline-heading">
                    <div>
                      <span className="eyebrow">Agent workspace</span>
                      <h2>Workspace files</h2>
                      <p>
                        What {selected.name} has on disk. Reading here is the owner's own
                        view — an agent still needs a scope and a grant to reach it.
                      </p>
                    </div>
                    <div className="files-drawer-actions">
                      <button
                        className="button"
                        onClick={() =>
                          void refreshFiles(selected.id).catch((reason) =>
                            setError(reason instanceof Error ? reason.message : String(reason)),
                          )
                        }
                        disabled={filesLoading}
                      >
                        {filesLoading ? <Spinner /> : "Refresh"}
                      </button>
                      <button
                        className="files-drawer-close"
                        onClick={() => setShowFilesDrawer(false)}
                        aria-label="Close workspace files"
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  {filesLoading && files.length === 0 ? (
                    <div className="timeline-empty"><Spinner /> Reading workspace…</div>
                  ) : files.length === 0 ? (
                    <div className="timeline-empty">
                      <strong>This workspace is empty</strong>
                      <span>Files the agent creates or edits will appear here.</span>
                    </div>
                  ) : (
                    <div
                      className="files-body"
                      style={{ gridTemplateColumns: treePaneWidth + "px 6px 1fr" }}
                    >
                      <div className="files-tree-pane">
                        <div className="files-filter">
                          <input
                            type="text"
                            placeholder="Filter files…"
                            value={fileFilter}
                            onChange={(event) => setFileFilter(event.target.value)}
                          />
                        </div>
                        <div className="files-tree-scroll">
                          {filteredFiles ? (
                            filteredFiles.length === 0 ? (
                              <div className="files-tree-empty">
                                No files match "{fileFilter}"
                              </div>
                            ) : (
                              filteredFiles.map((file) => (
                                <button
                                  key={file.path}
                                  className={
                                    "tree-row tree-file" +
                                    (openFilePath === file.path ? " selected" : "")
                                  }
                                  style={{ paddingLeft: 12, paddingRight: 12 }}
                                  aria-pressed={openFilePath === file.path}
                                  onClick={() => void showFile(selected.id, file.path)}
                                >
                                  <span className="tree-file-name">{file.path}</span>
                                  <span className="files-size">{formatBytes(file.size)}</span>
                                </button>
                              ))
                            )
                          ) : (
                            <FileTree
                              nodes={fileTree}
                              depth={0}
                              expanded={expandedFolders}
                              onToggleFolder={toggleFolder}
                              selectedPath={openFilePath}
                              onSelectFile={(path) => void showFile(selected.id, path)}
                            />
                          )}
                        </div>
                      </div>

                      <div
                        className="files-resize-handle"
                        onPointerDown={resizeTreePane}
                        aria-hidden="true"
                      />

                      <div className="files-viewer">
                        {fileError ? (
                          <div className="files-placeholder">{fileError}</div>
                        ) : !openFilePath ? (
                          <div className="files-placeholder">Select a file to read it.</div>
                        ) : !openFile ? (
                          <div className="files-placeholder"><Spinner /> Loading…</div>
                        ) : (
                          <>
                            <div className="files-viewer-heading">
                              <code>{openFile.path}</code>
                              <span>{formatBytes(openFile.size)}</span>
                            </div>
                            {openFile.binary ? (
                              <div className="files-placeholder">
                                Binary file — not shown.
                              </div>
                            ) : (
                              <pre>{openFile.content}</pre>
                            )}
                            {openFile.truncated && (
                              <p className="files-note">
                                Truncated — showing the first 256 KB of this file.
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {filesTruncated && (
                    <p className="files-note">
                      Listing truncated at 500 files. `.git`, `node_modules`, `dist` and
                      `.codex` are never listed.
                    </p>
                  )}
                </section>
              </div>
            )}

            {activeTab === "timeline" && (
              <section className="timeline-panel" aria-label="Agent audit timeline">
                <div className="timeline-heading">
                  <div>
                    <h2>Audit timeline</h2>
                    <p>Human → agent → action → resource → outcome. Event details are redacted by the server.</p>
                  </div>
                  <div className="timeline-filters" aria-label="Timeline filter">
                    <button
                      className={eventFilter === "policy" ? "selected" : ""}
                      aria-pressed={eventFilter === "policy"}
                      onClick={() => setEventFilter("policy")}
                    >
                      Policy only
                    </button>
                    <button
                      className={eventFilter === "all" ? "selected" : ""}
                      aria-pressed={eventFilter === "all"}
                      onClick={() => setEventFilter("all")}
                    >
                      All activity
                    </button>
                  </div>
                </div>

                {eventsLoading ? (
                  <div className="timeline-empty"><Spinner /> Loading audit events…</div>
                ) : events.length === 0 ? (
                  <div className="timeline-empty">
                    <strong>No {eventFilter === "policy" ? "policy" : "activity"} events yet</strong>
                    <span>Gateway decisions, approvals, grants, and runtime telemetry will appear here.</span>
                  </div>
                ) : (
                  <ol className="timeline-list">
                    {events.map((event) => {
                      const eventAgent = agents.find((agent) => agent.id === event.agentId);
                      const owner = event.ownerId === currentUser?.id
                        ? currentUser.name
                        : event.ownerId;
                      const detailEntries = Object.entries(event.detail);
                      const origin = typeof event.detail.origin === "string"
                        ? event.detail.origin
                        : null;
                      const grantId = typeof event.detail.grantId === "string"
                        ? event.detail.grantId
                        : null;
                      return (
                        <li
                          className={
                            "timeline-row timeline-row-" + (event.decision ?? "neutral")
                          }
                          key={event.id}
                        >
                          <time dateTime={event.at}>{formatEventTime(event.at)}</time>
                          <div className="timeline-marker" aria-hidden="true" />
                          <article className={detailEntries.length > 0 ? "has-details" : ""}>
                            <div className="timeline-main">
                              <div className="timeline-row-heading">
                                <span className={"timeline-kind timeline-kind-" + event.kind}>
                                  {formatEventLabel(event.kind)}
                                </span>
                                <span className={"timeline-outcome timeline-outcome-" + (event.decision ?? "neutral")}>
                                  {event.decision ?? "recorded"}
                                </span>
                              </div>
                              <div className="timeline-actor">
                                <strong>{owner}</strong>
                                <span>→</span>
                                <strong>{eventAgent?.name ?? shortId(event.agentId)}</strong>
                              </div>
                              <div className="timeline-action">
                                <code>{event.action}</code>
                                <span>→</span>
                                <code>{event.resource}</code>
                              </div>
                              {event.reason && (
                                <p className="timeline-reason">Reason: {event.reason}</p>
                              )}
                              {event.reason === "ifc" && (
                                <div className="timeline-ifc">
                                  <strong>Blocked external egress</strong>
                                  {origin && <span>Content originated from: {origin}</span>}
                                  {grantId && <span>Grant: {shortId(grantId)}</span>}
                                  <span>Destination: {event.resource}</span>
                                </div>
                              )}
                            </div>
                            {detailEntries.length > 0 && (
                              <div className="timeline-details">
                                <span className="timeline-details-label">Redacted event details</span>
                                <dl>
                                  {detailEntries.map(([key, value]) => (
                                    <div key={key}>
                                      <dt>{formatDetailKey(key)}</dt>
                                      <dd>{formatDetailValue(value)}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                            )}
                          </article>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            )}
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(newAgentForm());
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <PermissionsFields
              idPrefix="create"
              permissions={form.permissions}
              onChange={(permissions) => setForm({ ...form, permissions })}
            />
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

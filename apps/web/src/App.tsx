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
  Message,
  PolicyGrant,
  Scope,
  SystemInfo,
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

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) + "…" : value;
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
  const [killingAgent, setKillingAgent] = useState(false);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [currentUser, setCurrentUser] = useState<LoggedInUser | null>(restoreStoredUser);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const sessionVersionRef = useRef(0);
  const initialUserRef = useRef(currentUser);
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const pendingApprovals = useMemo(
    () => approvals
      .filter((approval) => approval.status === "pending")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [approvals],
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

  useEffect(() => {
    setActiveRun(null);
    setGrants([]);
    setSecurityNotice(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      setGrantsLoading(false);
      return;
    }
    void refreshGrants(selectedId).catch((reason) =>
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
  }, [refreshGrants, refreshMessages, selectedId]);

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
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

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
  ) => {
    if (approval.status !== "pending") return;
    const sessionVersion = sessionVersionRef.current;
    const selectedAgentId = selectedIdRef.current;
    setDecidingApprovalId(approval.id);
    setSecurityNotice(null);
    setError(null);
    try {
      const { approval: decided } = await api.decideApproval(approval.id, decision);
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
          ...(selectedAgentId ? [refreshGrants(selectedAgentId)] : []),
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
          killed.name + "'s active identity was revoked and its gateway tools were removed.",
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mountedRef.current && sessionVersion === sessionVersionRef.current) {
        setKillingAgent(false);
      }
    }
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
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
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

        {currentUser && (
          <div className="account-card">
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
            <button className="account-switch" onClick={logout} title="Switch user">
              Switch
            </button>
          </div>
        )}

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
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span className="agent-description">{agent.description || "Coding Agent"}</span>
                <PermissionChips permissions={agent.permissions} compact />
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

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
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
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {pendingApprovals.length > 0 && (
              <section className="approvals-panel" aria-label="Pending access requests">
                <div className="approvals-heading">
                  <div>
                    <span className="eyebrow">Human approval required</span>
                    <h2>Access Requests</h2>
                    <p>Denied actions stay denied until you decide. Approval applies when the agent retries.</p>
                  </div>
                  <span>{pendingApprovals.length} pending</span>
                </div>
                <div className="approval-list">
                  {pendingApprovals.map((approval) => {
                    const requestingAgent = agents.find(
                      (agent) => agent.id === approval.agentId,
                    );
                    const deciding = decidingApprovalId === approval.id;
                    return (
                      <article className="approval-card" key={approval.id}>
                        <div className="approval-badges">
                          <span className="approval-source">
                            {approval.source === "live_deny" ? "Live deny" : "Natural language"}
                          </span>
                          <span className={"approval-kind approval-kind-" + approval.kind}>
                            {approval.kind}
                          </span>
                          <time dateTime={approval.createdAt}>{formatDateTime(approval.createdAt)}</time>
                        </div>
                        <h3>{requestingAgent?.name ?? shortId(approval.agentId)} requests access</h3>
                        <div className="approval-request-line">
                          <strong>{approval.action}</strong>
                          <span>→</span>
                          <code>{approval.resource}</code>
                        </div>
                        <p className="approval-reason">{approval.reason}</p>
                        {approval.scope && (
                          <div className="approval-detail">
                            Missing scope <code>{approval.scope}</code>
                          </div>
                        )}
                        {approval.grant && (
                          <div className="approval-detail">
                            Grant: {approval.grant.resource} · {approval.grant.actions.join(" + ")} · egress {approval.grant.egress.join(", ")}
                          </div>
                        )}
                        {deciding && <div className="approval-saving"><Spinner /> Saving decision…</div>}
                        <div className="approval-actions">
                          <button
                            className="button button-ghost"
                            disabled={decidingApprovalId !== null}
                            onClick={() => void decideApproval(approval, "allow_run")}
                          >
                            Allow for this run
                          </button>
                          <button
                            className="button button-primary"
                            disabled={decidingApprovalId !== null}
                            onClick={() => void decideApproval(approval, "allow_always")}
                          >
                            Always allow
                          </button>
                          <button
                            className="button approval-deny-button"
                            disabled={decidingApprovalId !== null}
                            onClick={() => void decideApproval(approval, "deny")}
                          >
                            Deny
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Identity and permissions</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
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
            )}

            {securityNotice && (
              <div className="success-banner" role="status">
                <span>✓</span>
                <p>{securityNotice}</p>
                <button onClick={() => setSecurityNotice(null)} aria-label="Dismiss">×</button>
              </div>
            )}

            <section className="security-panel" aria-label="Agent security controls">
              <div className="security-card grants-card">
                <div className="security-card-heading">
                  <div>
                    <span className="eyebrow">Data relationships</span>
                    <h2>Policy grants</h2>
                    <p>Access involving this agent. The gateway checks active grants on every call.</p>
                  </div>
                  <span className="security-count">{grants.length}</span>
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
                      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
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
                    <span className="eyebrow">Identity controls</span>
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

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
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
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
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

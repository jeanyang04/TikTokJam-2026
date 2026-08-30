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
  SystemInfo,
  WorkspaceFile,
  WorkspaceFileContent,
} from "./types";

type AgentInput = {
  name: string;
  description: string;
  instructions: string;
  permissions: AgentPermissions;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";
let unauthorizedHandler: (() => void) | null = null;

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

export function clearAuthToken(): void {
  authToken = "";
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function isProtectedApiRequest(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path.startsWith("/api/") && ![
    "/api/auth",
    "/api/auth/login",
    "/api/health",
  ].includes(path);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const tokenAtRequest = authToken;
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(tokenAtRequest ? { Authorization: "Bearer " + tokenAtRequest } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    if (
      response.status === 401 &&
      tokenAtRequest &&
      authToken === tokenAtRequest &&
      isProtectedApiRequest(url)
    ) {
      clearAuthToken();
      unauthorizedHandler?.();
      throw new ApiError("Your session expired. Please sign in again.", 401);
    }
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  login: (userId: string) =>
    request<{ token: string; user: { id: string; name: string } }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: AgentInput) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: AgentInput,
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  killAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/kill", {
      method: "POST",
    }),
  listWorkspaceFiles: (id: string) =>
    request<{ files: WorkspaceFile[]; truncated: boolean }>(
      "/api/agents/" + id + "/files",
    ),
  readWorkspaceFile: (id: string, filePath: string) =>
    request<{ file: WorkspaceFileContent }>(
      "/api/agents/" + id + "/files/content?path=" + encodeURIComponent(filePath),
    ),
  getAgentGrants: (id: string) =>
    request<{ grants: PolicyGrant[] }>("/api/agents/" + id + "/grants"),
  revokeGrant: (id: string) =>
    request<{ grant: PolicyGrant }>("/api/grants/" + id + "/revoke", {
      method: "POST",
    }),
  listApprovals: () => request<{ approvals: ApprovalRequest[] }>("/api/approvals"),
  decideApproval: (id: string, decision: ApprovalDecision, trustContent = false) =>
    request<{ approval: ApprovalRequest }>("/api/approvals/" + id + "/decide", {
      method: "POST",
      body: JSON.stringify({ decision, trustContent }),
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  getAgentEvents: (id: string, filter: EventFilter, limit = 200) =>
    request<{ events: RunEvent[] }>(
      "/api/agents/" + id + "/events?filter=" + filter + "&limit=" + limit,
    ),
  getRunEvents: (id: string, filter: EventFilter) =>
    request<{ events: RunEvent[] }>(
      "/api/runs/" + id + "/events?filter=" + filter,
    ),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
};

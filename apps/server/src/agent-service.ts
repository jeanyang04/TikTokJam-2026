import { randomUUID } from "node:crypto";
import { recordEvent } from "./audit.js";
import { signAgent } from "./auth.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { decideApproval, listApprovals } from "./approvals.js";
import { createGrant, listGrants, revokeGrant, type GrantInput } from "./grants.js";
import { DEFAULT_PERMISSIONS, effectiveScopes, JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  ApprovalDecision,
  ApprovalRequest,
  CreateAgentInput,
  Message,
  PolicyGrant,
  RunEvent,
  RunEventKind,
  RunToken,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export type EventFilter = "policy" | "all";
/** `docs/API.md` §Events: what a human decided or the gateway enforced. */
const POLICY_EVENT_KINDS: RunEventKind[] = ["gateway", "approval", "grant"];

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  /**
   * Filtered server-side, and `ownerId` is required rather than optional: an
   * optional filter on a tenant boundary is one forgotten argument away from
   * listing everybody's agents.
   */
  listAgents(ownerId: string): Agent[] {
    return this.store
      .snapshot()
      .agents.filter((agent) => agent.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  /**
   * Cross-tenant isolation for `/api/agents/:id*`. An agent that does not exist
   * is a plain 404 and is not logged — logging it would turn the audit trail
   * into an oracle for probing which ids are real. An agent that exists but
   * belongs to someone else is an explicit 403 and an audit row, because that
   * is an attempt worth seeing in the timeline.
   */
  async assertAgentOwnership(
    agentId: string,
    callerId: string,
    action: string,
  ): Promise<Agent> {
    const agent = this.getAgent(agentId);
    if (agent.ownerId !== callerId) {
      await this.denyCrossTenant(agent.id, callerId, action, "agent/" + agent.id);
    }
    return agent;
  }

  /**
   * The same check for `/api/runs/:id`, which looks a run up by its own id and
   * would otherwise be the one route that reads across tenants. Not on ticket
   * 03's checklist; CLAUDE.md rule 3 is not scoped to the agent routes.
   */
  async assertRunOwnership(
    runId: string,
    callerId: string,
    action: string,
  ): Promise<AgentRun> {
    const run = this.getRun(runId);
    const agent = this.getAgent(run.agentId);
    if (agent.ownerId !== callerId) {
      await this.denyCrossTenant(agent.id, callerId, action, "run/" + run.id);
    }
    return run;
  }

  /**
   * The same check for `/api/grants/:id*`. `grants.ts` refuses another tenant's
   * grant too, but silently — the gate is where the 403 becomes an audit row,
   * and where an unknown id stays a bare 404. The event's `agentId` is the
   * grant's recipient: the identity the caller was reaching for.
   */
  async assertGrantOwnership(
    grantId: string,
    callerId: string,
    action: string,
  ): Promise<PolicyGrant> {
    const grant = this.store.snapshot().policyGrants.find((item) => item.id === grantId);
    if (!grant) {
      throw new HttpError(404, "Grant not found");
    }
    if (grant.fromOwner !== callerId) {
      await this.denyCrossTenant(grant.toAgent, callerId, action, "grant/" + grant.id);
    }
    return grant;
  }

  /** The same check for `/api/approvals/:id*`. */
  async assertApprovalOwnership(
    approvalId: string,
    callerId: string,
    action: string,
  ): Promise<ApprovalRequest> {
    const card = this.store.snapshot().approvals.find((item) => item.id === approvalId);
    if (!card) {
      throw new HttpError(404, "Approval not found");
    }
    if (card.ownerId !== callerId) {
      await this.denyCrossTenant(card.agentId, callerId, action, "approval/" + card.id);
    }
    return card;
  }

  /**
   * Row shape is fixed by `docs/API.md` §Ownership: `action` is `"api:<method>"`
   * and `resource` is `"<kind>/<id>"`. `ownerId` is the *caller*, matching how
   * `gateway.ts` records a deny — read the pair as who tried, and what for.
   */
  private async denyCrossTenant(
    agentId: string,
    callerId: string,
    action: string,
    resource: string,
  ): Promise<never> {
    await this.logCrossTenant(agentId, callerId, action, resource);
    throw new HttpError(403, "That resource belongs to another tenant");
  }

  /**
   * The row on its own, for the one caller that must record the attempt but
   * answer something other than 403 (`createGrant`, whose cross-tenant *source*
   * is a 400 by contract). Every cross-tenant refusal is audited; not every one
   * is a 403.
   */
  private async logCrossTenant(
    agentId: string,
    callerId: string,
    action: string,
    resource: string,
  ): Promise<void> {
    await recordEvent(this.store, {
      runId: null,
      agentId,
      ownerId: callerId,
      kind: "gateway",
      action,
      resource,
      decision: "deny",
      reason: "cross-tenant",
      detail: {},
    });
  }

  // ownerId is threaded from request.principal by B1 (auth.ts); default keeps the baseline working.
  async createAgent(input: CreateAgentInput, ownerId = "user-jean"): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      ownerId,
      permissions: { ...DEFAULT_PERMISSIONS, ...(input.permissions ?? {}) },
      tempScopes: [],
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      // The owner configuring their own agent. Distinct from ticket 06's
      // `allow_always`, which widens the same field in response to an agent
      // hitting a deny; both write it here rather than each finding their own way.
      if (input.permissions !== undefined) {
        agent.permissions = { ...agent.permissions, ...input.permissions };
      }
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * Grants and cards go through here rather than through `app.ts` directly, so
   * every store read in the control plane has one door. The policy itself lives
   * in `grants.ts` / `approvals.ts` (Zeon's) and is only called from here.
   * Nothing is memoised: revoke-mid-run depends on reading the store per call.
   */
  getGrants(agentId: string): PolicyGrant[] {
    this.getAgent(agentId);
    return listGrants(this.store, agentId);
  }

  /**
   * `createGrant` refuses both cross-tenant reaches itself, but silently, and
   * `POST /api/grants` names no id for the ownership gate to guard — so the
   * audit row CLAUDE.md rule 3 requires is written here, before delegating.
   * The recipient is a 403 (the gate's own answer); a source agent belonging to
   * another tenant stays the 400 `docs/API.md` §Grants specifies, so that one
   * is logged and then left to `grants.ts` to refuse.
   */
  async createGrant(input: GrantInput, byOwner: string): Promise<PolicyGrant> {
    await this.assertAgentOwnership(input.toAgent, byOwner, "api:POST");
    const source =
      input.fromAgent === null
        ? undefined
        : this.store.snapshot().agents.find((item) => item.id === input.fromAgent);
    if (source && source.ownerId !== byOwner) {
      await this.logCrossTenant(source.id, byOwner, "api:POST", "agent/" + source.id);
    }
    return createGrant(this.store, input, byOwner);
  }

  async revokeGrant(grantId: string, byOwner: string): Promise<PolicyGrant> {
    return revokeGrant(this.store, grantId, byOwner);
  }

  listApprovals(ownerId: string): ApprovalRequest[] {
    return listApprovals(this.store, ownerId);
  }

  async decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    byOwner: string,
  ): Promise<ApprovalRequest> {
    return decideApproval(this.store, approvalId, decision, byOwner);
  }

  /**
   * The run timeline. `policy` is the default because that is the story the
   * demo tells; `all` adds what the agent actually did in between.
   */
  getRunEvents(runId: string, filter: EventFilter = "policy"): RunEvent[] {
    this.getRun(runId);
    return this.selectEvents((event) => event.runId === runId, filter);
  }

  /**
   * The agent timeline, across runs. It keys on `agentId` rather than on the
   * agent's runs on purpose: a cross-tenant denial names the agent but no run
   * (`runId: null`, docs/SEAMS.md), so it can only ever surface here.
   */
  getAgentEvents(agentId: string, filter: EventFilter = "policy", limit = 200): RunEvent[] {
    this.getAgent(agentId);
    const rows = this.selectEvents((event) => event.agentId === agentId, filter);
    // Drop from the front when the limit bites: the newest rows are the ones
    // being watched, and the order stays oldest-first for the timeline.
    return rows.slice(Math.max(0, rows.length - limit));
  }

  private selectEvents(match: (event: RunEvent) => boolean, filter: EventFilter): RunEvent[] {
    return this.store
      .snapshot()
      .runEvents.filter(
        (event) => match(event) && (filter === "all" || POLICY_EVENT_KINDS.includes(event.kind)),
      )
      .sort((left, right) => left.at.localeCompare(right.at));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    // The token row and the run are written in one mutation: a run that exists
    // without an identity would be a run the gateway cannot check.
    const { agent: agentAtStart, runToken } = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const token: RunToken = {
        jti: randomUUID(),
        runId,
        agentId,
        ownerId: storedAgent.ownerId,
        // tools ∪ live tempScopes, so an "Allow for this run" grant survives into
        // the follow-up message's run (docs/SEAMS.md).
        scp: effectiveScopes(storedAgent, timestamp),
        taints: [],
        issuedAt: timestamp,
        expiresAt: new Date(Date.parse(timestamp) + this.config.codexTimeoutMs + 60_000)
          .toISOString(),
        revokedAt: null,
      };
      database.runTokens.push(token);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return { agent: snapshot, runToken: token };
    });
    const execution = this.executeRun(agentAtStart, run, runToken);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    runToken: RunToken,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      // A snapshot of the row, not the authority: the gateway re-reads the row
      // on every call so a revoke mid-run takes effect immediately.
      const token = await signAgent(this.config, {
        sub: runToken.agentId,
        own: runToken.ownerId,
        run: runToken.runId,
        jti: runToken.jti,
        scp: runToken.scp,
        expiresInSeconds: Math.ceil(
          (Date.parse(runToken.expiresAt) - Date.now()) / 1000,
        ),
      });
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        token,
        // tools comes from the token's scope set, not the agent's permanent tools:
        // B2 builds Codex's enabled_tools from this, so an "Allow for this run"
        // scope would otherwise never reach the model's menu (docs/SEAMS.md).
        permissions: { ...agentAtStart.permissions, tools: runToken.scp },
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      await this.closeRunToken(runToken.jti);
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      await this.closeRunToken(runToken.jti);
    }
  }

  /**
   * A run's identity dies with the run. Without this a cancelled or failed run leaves a
   * usable token behind until its expiry, which can be most of CODEX_TIMEOUT_MS.
   * Leaves an already-revoked row alone so the kill switch's timestamp survives.
   */
  private async closeRunToken(jti: string): Promise<void> {
    await this.store.mutate((database) => {
      const token = database.runTokens.find((item) => item.jti === jti);
      if (token && !token.revokedAt) {
        token.revokedAt = now();
      }
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

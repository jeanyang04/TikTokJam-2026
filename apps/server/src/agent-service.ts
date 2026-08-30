import { randomUUID } from "node:crypto";
import { recordEvent } from "./audit.js";
import { signAgent } from "./auth.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { createCardOnDeny, decideApproval, listApprovals } from "./approvals.js";
import { parseGrantIntent, type GrantIntent } from "./nl-grant.js";
import { createGrant, listGrants, revokeGrant, type GrantInput } from "./grants.js";
import { screenOutput } from "./ifc.js";
import { keywordScopes, type ScopeEstimator } from "./scope-estimator.js";
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
  Scope,
  UpdateAgentInput,
} from "./types.js";
import { SCOPES } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/**
 * Revocation narrows and never widens: an already-revoked row keeps its first
 * timestamp, because *when* an identity died is the evidence. The run ending and
 * the operator's Kill switch both come through here so the rule is stated once.
 */
function revokeToken(token: RunToken, at: string): void {
  if (!token.revokedAt) {
    token.revokedAt = at;
  }
}

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
    /**
     * Injected so a test can decide what the sentence meant without a network
     * call. The default asks Ark when it is configured and falls back to the
     * grammar; nothing in the suite reaches Ark.
     */
    private readonly intentParser: (
      config: AppConfig,
      text: string,
    ) => Promise<GrantIntent | null> = parseGrantIntent,
    /**
     * What *this task* needs, so the run token can be narrowed to it. The
     * default is the deterministic keyword grammar, not the Ark-backed
     * estimator: every harness in the suite has Ark "configured" with a fake
     * key, so asking Ark by default would put a real network call in the path
     * of every test that sends a message. `index.ts` injects
     * `makeScopeEstimator(config)` for the running server.
     */
    private readonly estimateTaskScopes: ScopeEstimator = async (prompt) =>
      keywordScopes(prompt),
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
   * What this run was allowed to do, for the UI to show against what the agent
   * holds standing. Derived from the RunToken rather than returning it: the
   * row carries a `jti` the browser has no business seeing.
   *
   * A run with no token (or one minted before task-scoped permissions) reports
   * nothing withheld, which is the truth about it — it was never narrowed.
   */
  getRunScopes(runId: string): { active: Scope[]; withheld: Scope[]; estimated: Scope[] } {
    const token = this.store
      .snapshot()
      .runTokens.find((item) => item.runId === runId);
    return {
      active: token?.scp ?? [],
      withheld: token?.withheld ?? [],
      estimated: token?.estimated ?? [],
    };
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
   * The Kill switch: end this agent's identity, everywhere, now. Every live
   * RunToken is revoked and the tool scopes are emptied, so a call in flight is
   * refused on its next hop (the gateway re-reads the row) and no later run can
   * mint the scopes back.
   *
   * **`tempScopes` goes with `permissions.tools`.** `docs/API.md` §Agents names
   * only `tools`, but `RunToken.scp` is `effectiveScopes(agent)` = tools ∪ live
   * tempScopes, so leaving an "Allow for this run" scope behind would hand it
   * straight back to the next run. Killing one of the two is not killing.
   *
   * Runs regardless of status: a PATCH mid-run is an edit that can wait, a kill
   * cannot. The container is left alone — Stop is what kills the process.
   */
  async killAgent(agentId: string, callerId: string): Promise<Agent> {
    const { agent: killed, runIds } = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      const timestamp = now();
      const revoked: string[] = [];
      for (const token of database.runTokens) {
        if (token.agentId === agentId && !token.revokedAt) {
          revoked.push(token.runId);
        }
        if (token.agentId === agentId) {
          revokeToken(token, timestamp);
        }
      }
      agent.permissions = { ...agent.permissions, tools: [] };
      agent.tempScopes = [];
      agent.updatedAt = timestamp;
      return { agent: structuredClone(agent), runIds: revoked };
    });
    // Before the summary row, so the kill is the last word in the timeline.
    const voidedCards = await this.voidPendingCards(agentId, callerId);
    await recordEvent(this.store, {
      // Unlike every other API row this one names a run, because the run timeline
      // has no other honest record of the kill: `gateway.ts` audits the refused
      // call it causes before it has a verified identity, so that row lands as
      // `agentId: "unknown"` with no run. **Zeon:** auditing the revoked branch
      // from the claims would attribute it, and this could go back to null.
      runId: runIds.length === 1 ? (runIds[0] ?? null) : null,
      agentId,
      ownerId: callerId,
      kind: "gateway",
      action: "kill",
      resource: "agent/" + agentId,
      decision: "deny",
      reason: "revoked-by-operator",
      detail: { revokedRuns: runIds, voidedCards },
    });
    return killed;
  }

  /**
   * A card the agent provoked before the kill would otherwise still be sitting in
   * the operator's queue, and answering it with "Always allow" writes straight
   * back into `permissions.tools` — resurrecting the identity that was killed.
   * They are refused through `decideApproval`, so each one lands in the audit
   * trail as the decision it now is.
   */
  private async voidPendingCards(agentId: string, callerId: string): Promise<number> {
    const pending = this.store
      .snapshot()
      .approvals.filter((card) => card.agentId === agentId && card.status === "pending");
    for (const card of pending) {
      await decideApproval(this.store, card.id, "deny", callerId);
    }
    return pending.length;
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

  /**
   * `POST /api/grants/parse`: plain English in, a pending card out. The card is
   * the same `kind:"grant"` shape the gateway raises on a no-grant deny, so
   * `decideApproval` writes the PolicyGrant without knowing which one it is.
   * Only `source` differs.
   *
   * **Names resolve inside the caller's own agents, never across the store.**
   * Names are not unique between tenants, so a global lookup would both mis-hit
   * (Alex may also have a "Writer") and answer whether another tenant has an
   * agent by that name. Filtering first means this route cannot see anyone
   * else's agents, so an unknown name is a plain 404 and there is no
   * cross-tenant 403 to reach. That is a deliberate difference from the
   * id-addressed routes, where a 403 plus an audit row is the right answer.
   */
  async parseGrantRequest(
    text: string,
    callerId: string,
  ): Promise<{ approval: ApprovalRequest; created: boolean }> {
    const intent = await this.intentParser(this.config, text);
    if (!intent) {
      throw new HttpError(422, "Could not read a grant out of that");
    }
    const mine = this.store.snapshot().agents.filter((agent) => agent.ownerId === callerId);
    const byName = (written: string): Agent => {
      const match = mine.find(
        (agent) => agent.name.toLowerCase() === written.trim().toLowerCase(),
      );
      if (!match) throw new HttpError(404, "You have no agent named " + written);
      return match;
    };

    const to = byName(intent.toAgent);
    const from = byName(intent.fromAgent);
    const [action] = intent.actions;
    const before = new Set(this.store.snapshot().approvals.map((item) => item.id));
    const card = await createCardOnDeny(this.store, {
      source: "nl_intent",
      kind: "grant",
      agentId: to.id,
      ownerId: callerId,
      // No run raised this: the human asked directly. `decideApproval` reads the
      // run window off `jti`, which is why `allow_run` is refused for these
      // cards until that branch has a fallback.
      runId: null,
      jti: null,
      // Deliberately byte-identical to `gateway.ts`'s `grantCard`, because
      // `createCardOnDeny` dedupes on (agentId, kind, resource, action). Two
      // formats for the same access would mean the operator sees two cards for
      // one decision.
      resource: from.name + "/workspace",
      action,
      scope: null,
      // The human asked for this themselves, in these words, before any run
      // touched anything. There is nothing to be alarmed about and nothing to
      // juxtapose it against.
      risk: "routine",
      evidence: {
        userAsked: text.length > 300 ? text.slice(0, 300) + "…" : text,
        attempting: action + " on " + from.name + "/workspace",
        outsideTaskScope: false,
        untrustedOrigin: null,
        classifiedOrigin: null,
      },
      grant: {
        fromOwner: callerId,
        fromAgent: from.id,
        toAgent: to.id,
        resource: "workspace",
        actions: [action],
        egress: ["internal"],
      },
      reason: "requested in natural language",
    });
    // Sharing the key means a live deny may already have raised this exact
    // card. Returning it unchanged is right (one pending decision per access),
    // but the route must not then claim it created something.
    const created = !before.has(card.id);
    await recordEvent(this.store, {
      runId: null,
      agentId: to.id,
      ownerId: callerId,
      kind: "approval",
      action: card.action,
      resource: card.resource,
      decision: "pending",
      // The text is the human's own prose and may contain anything, so its
      // length is all that goes in the trail (CLAUDE.md rule 4).
      reason: "nl_intent",
      detail: { cardId: card.id, source: card.source, created, textLength: text.length },
    });
    return { approval: card, created };
  }

  async decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    byOwner: string,
    /** The card's "trust content from this source" checkbox, for grant cards. */
    options: { trustContent?: boolean | undefined } = {},
  ): Promise<ApprovalRequest> {
    const card = this.store.snapshot().approvals.find((item) => item.id === approvalId);
    // "Allow for this run" on a card that no run raised would write a
    // *permanent* grant: `approvals.ts` reads the run window through `card.jti`
    // and its grant branch has no fallback when that is null, unlike its scope
    // branch. The narrower button must not produce the broader outcome, so this
    // fails closed until that fallback exists. Ticket 08's nl_intent cards are
    // the only ones with a null `jti`; gateway cards are untouched.
    // **Zeon:** a `?? tenMinutesFromNow` in the grant branch retires this.
    if (
      card &&
      card.ownerId === byOwner &&
      decision === "allow_run" &&
      card.kind === "grant" &&
      card.jti === null
    ) {
      throw new HttpError(
        409,
        "No run to scope this to. Use Always allow, then revoke when you are done",
      );
    }
    return decideApproval(this.store, approvalId, decision, byOwner, options);
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
    // What this task needs, decided from the user's message alone and *before*
    // any tool runs, so nothing an agent later reads can influence it.
    const estimated = await this.estimateScopes(prompt);
    // The token row and the run are written in one mutation: a run that exists
    // without an identity would be a run the gateway cannot check.
    const {
      agent: agentAtStart,
      runToken,
      missing,
    } = await this.store.mutate((database) => {
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
      // tools ∪ live tempScopes, so an "Allow for this run" grant survives into
      // the follow-up message's run (docs/SEAMS.md).
      const standing = effectiveScopes(storedAgent, timestamp);
      // Narrowing is automatic and needs no human; widening never is. An empty
      // estimate (disabled, or the estimator could not answer) means the
      // standing set, which is exactly the behaviour before this existed.
      // `storedAgent.permissions.tools` is never touched: the narrowing lives
      // on the run token and dies with the run.
      //
      // Live `tempScopes` survive the filter. They are written by exactly one
      // thing — a human answering "Allow for this run" — and stripping them
      // would livelock the card: the follow-up run would drop the scope the
      // operator had just granted, deny again, and raise the same card forever.
      // Keeping them is the system declining to override a human, not the
      // system widening anything.
      const liveTempScopes = storedAgent.tempScopes
        .filter((temp) => temp.expiresAt > timestamp)
        .map((temp) => temp.scope);
      const scp =
        estimated.length > 0
          ? [
              ...new Set([
                ...standing.filter((scope) => estimated.includes(scope)),
                ...liveTempScopes,
              ]),
            ]
          : standing;
      // Taints follow the data for as long as the model can still remember it.
      // A follow-up message is a *new* run with a new token, but the Codex
      // thread persists, so the agent is still holding what it read last turn.
      // Minting an empty taint list let it launder anything by waiting a turn:
      // read under a grant, then send on the next message with a clean token.
      //
      // Not carried: `egressAllow`. That is a human approving one destination
      // for one run, and it must not silently outlive the run they approved.
      //
      // This does *not* close laundering through storage — copying borrowed
      // content into the agent's own workspace, which never taints on read,
      // survives any run- or conversation-scoped label. Closing that needs the
      // label on the file (docs/SEAMS.md).
      const previousToken = database.runTokens
        .filter((item) => item.agentId === agentId)
        .sort((left, right) => left.issuedAt.localeCompare(right.issuedAt))
        .at(-1);
      // A completed run has its thread backfilled below, so null here means a
      // run that never finished and never learned its thread. Treat that as
      // the same conversation: failing permissive keeps a label the agent may
      // still be holding, and failing strict would drop it.
      const sameConversation =
        previousToken !== undefined &&
        (previousToken.threadId === null ||
          previousToken.threadId === storedAgent.codexThreadId);
      const token: RunToken = {
        jti: randomUUID(),
        runId,
        agentId,
        ownerId: storedAgent.ownerId,
        scp,
        taints: sameConversation ? structuredClone(previousToken.taints) : [],
        egressAllow: [],
        // Both recorded rather than recomputed later: `estimated` is the
        // baseline a card is judged against (a scope the agent reaches for
        // that is not in here is one the user never asked for), and
        // `withheld` cannot be reconstructed once the agent's standing
        // permissions change.
        estimated,
        withheld: standing.filter((scope) => !scp.includes(scope)),
        threadId: storedAgent.codexThreadId,
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
      return {
        agent: snapshot,
        runToken: token,
        missing: estimated.filter((scope) => !standing.includes(scope)),
      };
    });
    // Asked before the run starts rather than after a mid-task deny, so a task
    // that needs a scope the agent lacks costs the operator one decision
    // instead of a failed run and a second message. `createCardOnDeny` is a
    // `store.mutate` of its own, so it cannot be called from inside the one
    // above, and it is awaited before `executeRun` is spawned so the card is
    // really there before the agent starts.
    await this.requestMissingScopes(agentAtStart, run, runToken, missing);
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

  /**
   * The estimate, or an empty array meaning "no opinion". Fails to the status
   * quo in every direction: disabled by config, an estimator that throws, an
   * estimator that answers with something that is not a scope. A broken
   * estimate must never be able to break a run, and must never be able to
   * *widen* anything either — hence the filter against `SCOPES`, since the
   * Ark-backed estimator's answer is model output.
   */
  private async estimateScopes(prompt: string): Promise<Scope[]> {
    if (!this.config.permissionEstimatorEnabled) return [];
    try {
      const estimated = await this.estimateTaskScopes(prompt);
      return estimated.filter((scope) => SCOPES.includes(scope));
    } catch {
      return [];
    }
  }

  /**
   * One `scope` card per scope the task wants and the agent does not hold. The
   * run still starts: the agent is denied if it reaches for the missing scope,
   * which is today's behaviour, so a wrong estimate costs one round trip and
   * nothing else. Nothing here grants anything — a human answers the card.
   *
   * **`action` carries the scope, and `docs/SEAMS.md` records why.**
   * `createCardOnDeny` dedupes on `(agentId, kind, resource, action)`, so a
   * literal `"run"` would collapse two missing scopes into one card and the
   * operator would never see the second decision. Keying on the scope also
   * keeps a retry of the same task from piling cards up, which is what the
   * dedupe is for.
   */
  private async requestMissingScopes(
    agent: Agent,
    run: AgentRun,
    runToken: RunToken,
    missing: Scope[],
  ): Promise<void> {
    for (const scope of missing) {
      await createCardOnDeny(this.store, {
        source: "nl_intent",
        kind: "scope",
        agentId: agent.id,
        ownerId: agent.ownerId,
        // Unlike ticket 08's nl_intent cards these do name a run, so
        // `decideApproval`'s `allow_run` guard does not bite and both buttons
        // work (docs/SEAMS.md).
        runId: run.id,
        jti: runToken.jti,
        resource: agent.name,
        action: "run:" + scope,
        scope,
        grant: null,
        reason: "this task looks like it needs " + scope + ", which this agent doesn't have",
        // Routine by construction: this scope is in the estimate, which is
        // what "the task needs it" means, and no tool has run yet so there is
        // no untrusted content to be wary of.
        risk: "routine",
        evidence: {
          userAsked: run.prompt.length > 300 ? run.prompt.slice(0, 300) + "…" : run.prompt,
          attempting: "use " + scope + " for this task",
          outsideTaskScope: false,
          untrustedOrigin: null,
          classifiedOrigin: null,
        },
      });
    }
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
        // The model's menu is `scp ∪ withheld`, not `scp`. Two reasons it is
        // not just the agent's permanent tools: an "Allow for this run" scope
        // lives on the token and would otherwise never reach the menu, and a
        // scope the agent no longer holds must not reappear on it.
        //
        // **Withheld tools stay on the menu on purpose.** Enforcement is the
        // token's `scp`, checked at the gateway, so offering a withheld tool
        // grants nothing — the call is denied and raises a card. Hiding it
        // instead makes the narrowing invisible: a prompt injection reaching
        // for a tool that is not there looks identical to a model that simply
        // chose not to call it, and there is no denial, no card, and no audit
        // row to show anyone. An attempt that is refused is evidence; an
        // attempt that never happens is not (docs/SEAMS.md).
        permissions: {
          ...agentAtStart.permissions,
          tools: [...new Set([...runToken.scp, ...runToken.withheld])],
        },
      });
      // Chat is the third egress surface: the reply becomes a stored message
      // that gets screenshotted and pasted, so an agent blocked from *sending*
      // classified content must not be able to simply print it instead. The
      // screen decides on the fingerprint index and the content detectors; it
      // is what gets persisted, both as the run output and as the message.
      const screened = screenOutput(run.id, result.output);
      const completedAt = now();
      if (screened.verdict !== "allow") {
        // Deny rows only — an allow row per run would be timeline noise. A
        // deliberate, documented deviation from the gateway's every-branch
        // rule (docs/SEAMS.md). `detail` never carries the output itself.
        await recordEvent(this.store, {
          runId: run.id,
          agentId: agentAtStart.id,
          ownerId: agentAtStart.ownerId,
          kind: "gateway",
          action: "output",
          resource: "chat",
          decision: "deny",
          reason: screened.verdict,
          detail: { level: screened.level, origin: screened.origin?.origin ?? null },
        });
      }
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = screened.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: screened.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
        // The first run of a conversation is minted before the thread exists,
        // so its token records `threadId: null`. Backfill it with the thread
        // the run created, or the next mint cannot tell "the conversation this
        // started" from "some other conversation" and carries taints into a
        // thread that remembers nothing.
        const storedToken = database.runTokens.find((item) => item.jti === runToken.jti);
        if (storedToken && storedToken.threadId === null) {
          storedToken.threadId = result.threadId;
        }
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

/**
 * LOCK 1 — the tool gateway. Every Codex tool call enters here (MCP streamable HTTP at POST /mcp).
 * Pipeline per call: verify agent JWT → RunToken row live → tool→scope → scope ∈ scp
 *   → resource owner == own OR live intra-tenant grant → egress/taint check → handler → RunEvent.
 * Nothing here is cached: RunToken and PolicyGrant rows are read from the store on every call.
 * All five tools are always registered so that an out-of-scope call yields a structured DENIED + card + audit
 * (the model's *menu* is shaped separately by Codex `enabled_tools`, projected by the runner from RunToken.scp).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { recordEvent } from "./audit.js";
import { createCardOnDeny } from "./approvals.js";
import { findLiveGrant } from "./grants.js";
import { addTaint, checkEgress, fingerprint, matchOrigin } from "./ifc.js";
import type { JsonStore } from "./store.js";
import type { Agent, Egress, GrantAction, Label, Resource, RunToken, Scope } from "./types.js";

export interface AgentClaims {
  sub: string; // agentId
  own: string; // ownerId
  run: string; // runId
  jti: string;
  scp: Scope[];
}

export interface GatewayDeps {
  store: JsonStore;
  workspaceRoot: string;
  /** B1's auth.ts provides this; makeJwtVerifier() is the default. Must reject typ != "agent". */
  verifyAgentToken: (raw: string) => Promise<AgentClaims>;
  /** B3's db.ts. Runs fn inside a txn with SET LOCAL app.owner_id/app.agent_id (RLS). Optional until B3 lands. */
  withOwner?: (<T>(ownerId: string, agentId: string, fn: (q: SqlQuery) => Promise<T>) => Promise<T>) | undefined;
  /** B2's mock sink. */
  webhookSink?: ((url: string, body: string) => Promise<{ status: number }>) | undefined;
  /** GATEWAY_ENFORCE=false skips scope/grant/egress checks (demo: RLS still holds). */
  enforce?: boolean | undefined;
}
export type SqlQuery = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export function makeJwtVerifier(secret: string): (raw: string) => Promise<AgentClaims> {
  const key = new TextEncoder().encode(secret);
  return async (raw) => {
    const { payload } = await jwtVerify(raw, key, { algorithms: ["HS256"] });
    if (payload.typ !== "agent") throw new Error("not an agent token");
    return { sub: String(payload.sub), own: String(payload.own), run: String(payload.run), jti: String(payload.jti), scp: (payload.scp as Scope[]) ?? [] };
  };
}

// ---- tool catalogue ----
const TOOL_SCOPE: Record<string, Scope> = {
  workspace_read: "workspace:read",
  workspace_write: "workspace:write",
  crm_read: "crm:read",
  crm_write: "crm:write",
  webhook_send: "webhook:send",
};

class Denied extends Error {
  constructor(public readonly status: 401 | 403, public readonly reason: string, message: string) {
    super(message);
  }
}

interface Ctx extends AgentClaims {
  token: RunToken;
  ownerId: string;
}

export const gatewayPlugin: FastifyPluginAsync<GatewayDeps> = async (app, deps) => {
  const enforce = deps.enforce ?? true;
  const store = deps.store;

  const audit = (ctx: Pick<Ctx, "sub" | "own" | "run"> | null, action: string, resource: string, decision: "allow" | "deny", reason: string | null, detail: Record<string, unknown> = {}) =>
    recordEvent(store, { runId: ctx?.run ?? null, agentId: ctx?.sub ?? "unknown", ownerId: ctx?.own ?? "unknown", kind: "gateway", action, resource, decision, reason, detail });

  // Steps 1–2: who is calling, and is the run still live.
  async function authenticate(request: FastifyRequest): Promise<Ctx> {
    const header = request.headers.authorization ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!raw) throw new Denied(401, "no-token", "Authentication required");
    let claims: AgentClaims;
    try {
      claims = await deps.verifyAgentToken(raw);
    } catch {
      throw new Denied(401, "bad-token", "Invalid agent token");
    }
    const token = store.snapshot().runTokens.find((t) => t.jti === claims.jti);
    if (!token) throw new Denied(403, "unknown-token", "Unknown run token");
    if (token.revokedAt !== null) throw new Denied(403, "revoked", "Agent token revoked by operator");
    if (token.expiresAt <= new Date().toISOString()) throw new Denied(403, "expired", "Agent token expired");
    return { ...claims, token, ownerId: token.ownerId };
  }

  const agentByRef = (ref: string): Agent | null =>
    store.snapshot().agents.find((a) => a.id === ref || a.name.toLowerCase() === ref.toLowerCase()) ?? null;

  const structuredDeny = (reason: string, message: string, hint: string) =>
    ({ content: [{ type: "text" as const, text: `DENIED (${reason}): ${message}. ${hint}` }], isError: true as const });

  async function deny(ctx: Ctx, tool: string, resource: string, action: string, reason: string, message: string, card: Parameters<typeof createCardOnDeny>[1] | null) {
    await audit(ctx, tool, resource, "deny", reason, { action });
    if (card) await createCardOnDeny(store, card);
    return structuredDeny(reason, message, card ? "An Access Request Card is pending operator approval — tell the user, then retry after they approve." : "This action is not permitted for this agent.");
  }

  // Steps 4–5: may this agent call this tool, on this resource.
  function scopeOf(ctx: Ctx, tool: string): Scope {
    const scope = TOOL_SCOPE[tool];
    if (!scope) throw new Denied(403, "unknown-tool", "Unknown tool " + tool);
    if (enforce && !ctx.token.scp.includes(scope)) throw new Denied(403, "scope", "Missing scope " + scope);
    return scope;
  }

  /** Resolves a target agent for workspace tools; returns the grant used (null = own workspace). */
  function resolveWorkspace(ctx: Ctx, ref: string, action: GrantAction): { target: Agent; grant: ReturnType<typeof findLiveGrant> } {
    const target = agentByRef(ref);
    if (!target) throw new Denied(403, "unknown-agent", "No such agent " + ref);
    if (target.id === ctx.sub) return { target, grant: null };
    if (target.ownerId !== ctx.ownerId) throw new Denied(403, "cross-tenant", "Agent " + ref + " belongs to another tenant");
    if (!enforce) return { target, grant: null };
    const grant = findLiveGrant(store, { fromOwner: target.ownerId, fromAgent: target.id, toAgent: ctx.sub, resource: "workspace", action });
    if (!grant) throw new Denied(403, "no-grant", "No live grant to " + action + " " + target.name + "'s workspace");
    return { target, grant };
  }

  // Step 6: IFC — may data this run holds go to this destination class.
  function egressGate(ctx: Ctx, destination: Egress, payload: string, resource: string): void {
    if (!enforce) return;
    const fresh = store.snapshot().runTokens.find((t) => t.jti === ctx.jti);
    const blocking = checkEgress(fresh?.taints ?? [], destination);
    if (!blocking) return;
    const origin = matchOrigin(ctx.run, payload) ?? blocking;
    throw new Denied(403, "ifc", `content originating from ${origin.origin} (grant ${origin.grantId.slice(0, 8)}, egress ${JSON.stringify(blocking.egress)}) cannot go to ${destination} destination ${resource}`);
  }

  const jail = (agentId: string, rel: string): string => {
    const root = path.resolve(deps.workspaceRoot, agentId);
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Denied(403, "path-escape", "Path escapes the workspace");
    return full;
  };

  const labelFor = (grantId: string, target: Agent, egress: Egress[]): Label => ({ grantId, origin: target.ownerId + "/" + target.name, egress });

  // ---- build a per-request MCP server whose tools close over the authenticated ctx ----
  function buildServer(ctx: Ctx): McpServer {
    const server = new McpServer({ name: "launchpad", version: "1.0.0" });

    const run = async <T>(tool: string, resource: string, action: string, cardOf: () => Parameters<typeof createCardOnDeny>[1] | null, fn: () => Promise<T>) => {
      try {
        const result = await fn();
        await audit(ctx, tool, resource, "allow", null, { action });
        return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
      } catch (error) {
        if (error instanceof Denied) return deny(ctx, tool, resource, action, error.reason, error.message, error.reason === "scope" || error.reason === "no-grant" || error.reason === "ifc" ? cardOf() : null);
        await audit(ctx, tool, resource, "deny", "error", { action, error: String(error) });
        return { content: [{ type: "text" as const, text: "Tool failed: " + String(error) }], isError: true as const };
      }
    };

    const scopeCard = (scope: Scope, resource: string, action: string): Parameters<typeof createCardOnDeny>[1] => ({
      source: "live_deny", kind: "scope", agentId: ctx.sub, ownerId: ctx.ownerId, runId: ctx.run, jti: ctx.jti, resource, action, scope, grant: null, reason: "tool " + action + " on " + resource + " denied: missing " + scope,
    });
    const grantCard = (target: Agent, action: GrantAction): Parameters<typeof createCardOnDeny>[1] => ({
      source: "live_deny", kind: "grant", agentId: ctx.sub, ownerId: ctx.ownerId, runId: ctx.run, jti: ctx.jti, resource: target.name + "/workspace", action, scope: null,
      grant: { fromOwner: target.ownerId, fromAgent: target.id, toAgent: ctx.sub, resource: "workspace", actions: [action], egress: ["internal"] }, reason: "no grant",
    });
    const declassifyCard = (dest: Egress, resource: string): Parameters<typeof createCardOnDeny>[1] => {
      const t = store.snapshot().runTokens.find((x) => x.jti === ctx.jti);
      const blocking = checkEgress(t?.taints ?? [], dest);
      return { source: "live_deny", kind: "declassify", agentId: ctx.sub, ownerId: ctx.ownerId, runId: ctx.run, jti: ctx.jti, resource, action: dest, scope: null, grant: null, reason: "grant:" + (blocking?.grantId ?? "") };
    };
    const cardFor = (scope: Scope, resource: string, action: string, target?: Agent, grantAction?: GrantAction, dest?: Egress) => () => {
      if (!ctx.token.scp.includes(scope)) return scopeCard(scope, resource, action);
      if (dest && checkEgress(store.snapshot().runTokens.find((x) => x.jti === ctx.jti)?.taints ?? [], dest)) return declassifyCard(dest, resource);
      if (target && grantAction && target.id !== ctx.sub) return grantCard(target, grantAction);
      return null;
    };

    server.registerTool("workspace_read", {
      description: "Read a file from an agent's workspace. Use agent = your own name for your workspace; another agent's name needs a grant.",
      inputSchema: { agent: z.string(), path: z.string() },
    }, async ({ agent, path: rel }) => {
      const target = agentByRef(agent);
      return run("workspace_read", (target?.name ?? agent) + "/workspace", "read", cardFor("workspace:read", (target?.name ?? agent) + "/workspace", "read", target ?? undefined, "read"), async () => {
        scopeOf(ctx, "workspace_read");
        const { target, grant } = resolveWorkspace(ctx, agent, "read");
        const text = await readFile(jail(target.id, rel), "utf8");
        if (grant) {
          const label = labelFor(grant.id, target, grant.egress);
          await addTaint(store, ctx.jti, label);
          fingerprint(ctx.run, label, text);
        }
        return text;
      });
    });

    server.registerTool("workspace_write", {
      description: "Write a file into an agent's workspace. Writing into another agent's workspace needs a grant and counts as sharing.",
      inputSchema: { agent: z.string(), path: z.string(), body: z.string() },
    }, async ({ agent, path: rel, body }) => {
      const target = agentByRef(agent);
      const dest: Egress = target && target.id !== ctx.sub ? "agent" : "internal";
      const resource = (target?.name ?? agent) + "/workspace";
      return run("workspace_write", resource, "write", cardFor("workspace:write", resource, "write", target ?? undefined, "write", dest), async () => {
        scopeOf(ctx, "workspace_write");
        const { target } = resolveWorkspace(ctx, agent, "write");
        egressGate(ctx, dest, body, resource);
        const full = jail(target.id, rel);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, body, "utf8");
        return { written: rel, bytes: Buffer.byteLength(body) };
      });
    });

    server.registerTool("crm_read", {
      description: "Read CRM records for your tenant.",
      inputSchema: { customer: z.string().optional() },
    }, async ({ customer }) => run("crm_read", ctx.ownerId + "/crm", "read", cardFor("crm:read", ctx.ownerId + "/crm", "read"), async () => {
      scopeOf(ctx, "crm_read");
      if (!deps.withOwner) throw new Error("CRM resource unavailable");
      // app.owner_id is bound from the VERIFIED token — never from an argument (D4).
      return deps.withOwner(ctx.ownerId, ctx.sub, async (q) => {
        const rows = customer
          ? await q("SELECT id, owner_id, customer, note FROM crm_records WHERE customer = $1", [customer])
          : await q("SELECT id, owner_id, customer, note FROM crm_records ORDER BY customer");
        return rows.rows;
      });
    }));

    server.registerTool("crm_write", {
      description: "Create or update a CRM note for your tenant.",
      inputSchema: { customer: z.string(), note: z.string() },
    }, async ({ customer, note }) => run("crm_write", ctx.ownerId + "/crm", "write", cardFor("crm:write", ctx.ownerId + "/crm", "write", undefined, undefined, "internal"), async () => {
      scopeOf(ctx, "crm_write");
      egressGate(ctx, "internal", note, ctx.ownerId + "/crm");
      if (!deps.withOwner) throw new Error("CRM resource unavailable");
      return deps.withOwner(ctx.ownerId, ctx.sub, async (q) => {
        const r = await q(
          "INSERT INTO crm_records (owner_id, customer, note) VALUES ($1, $2, $3) ON CONFLICT (owner_id, customer) DO UPDATE SET note = EXCLUDED.note, updated_at = now() RETURNING id",
          [ctx.ownerId, customer, note],
        );
        return { id: r.rows[0]?.id, customer };
      });
    }));

    server.registerTool("webhook_send", {
      description: "POST a body to an external webhook URL.",
      inputSchema: { url: z.string().url(), body: z.string() },
    }, async ({ url, body }) => run("webhook_send", url, "send", cardFor("webhook:send", url, "send", undefined, undefined, "external"), async () => {
      scopeOf(ctx, "webhook_send");
      egressGate(ctx, "external", body, url);
      if (!deps.webhookSink) throw new Error("Webhook sink unavailable");
      return deps.webhookSink(url, body);
    }));

    return server;
  }

  app.post("/mcp", async (request, reply) => {
    let ctx: Ctx;
    try {
      ctx = await authenticate(request);
    } catch (error) {
      const d = error instanceof Denied ? error : new Denied(401, "bad-token", "Invalid agent token");
      await audit(null, "mcp", "/mcp", "deny", d.reason, {});
      return reply.code(d.status).send({ error: d.message });
    }
    const server = buildServer(ctx);
    // No sessionIdGenerator → stateless; JSON responses keep curl/tests simple (Codex accepts both).
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.raw.on("close", () => void transport.close());
    await server.connect(transport as unknown as Transport); // SDK types vs exactOptionalPropertyTypes
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless server: no sessions to GET/DELETE.
  app.get("/mcp", async (_r, reply) => reply.code(405).send({ error: "Stateless MCP: POST only" }));
  app.delete("/mcp", async (_r, reply) => reply.code(405).send({ error: "Stateless MCP: POST only" }));
};

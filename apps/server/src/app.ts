import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerAuth } from "./auth.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { SCOPES, type AgentPermissions, type Scope } from "./types.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const grantIdParams = z.object({ id: z.string().uuid() });
const approvalIdParams = z.object({ id: z.string().uuid() });
/**
 * Absent keys fall back to `DEFAULT_PERMISSIONS`, so an explicitly-undefined one
 * has to be dropped rather than spread: `{...DEFAULT_PERMISSIONS, sandbox:
 * undefined}` would leave the agent with no sandbox at all.
 */
const permissionsBody = z
  .object({
    sandbox: z.enum(["read-only", "workspace-write"]),
    network: z.boolean(),
    webSearch: z.boolean(),
    tools: z.array(z.enum(SCOPES as [Scope, ...Scope[]])),
  })
  .partial()
  .transform(
    (value) =>
      Object.fromEntries(
        Object.entries(value).filter(([, field]) => field !== undefined),
      ) as Partial<AgentPermissions>,
  );
const agentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const createAgentBody = agentBody.extend({ permissions: permissionsBody.optional() });
const updateAgentBody = agentBody
  .partial()
  .extend({ permissions: permissionsBody.optional() })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
// `fromAgent: null` is the owner's own CRM, a tenant-level resource with no
// source agent — so it is required and nullable rather than optional.
const grantBody = z.object({
  fromAgent: z.string().uuid().nullable(),
  toAgent: z.string().uuid(),
  resource: z.enum(["workspace", "crm"]),
  actions: z.array(z.enum(["read", "write"])).min(1),
  egress: z.array(z.enum(["internal", "agent", "external"])).optional(),
});
const decideBody = z.object({
  decision: z.enum(["allow_run", "allow_always", "deny"]),
});
const eventsQuery = z.object({
  filter: z.enum(["policy", "all"]).default("policy"),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  registerAuth(app, config);

  /**
   * The caller, from the verified JWT and nowhere else. The auth hook has
   * already run for every route that calls this, so an absent principal is a
   * routing mistake, not a request the caller can provoke.
   */
  const callerOf = (request: FastifyRequest): string => {
    const principal = request.principal;
    if (!principal) {
      throw new HttpError(500, "Route reached without a verified principal");
    }
    return principal.userId;
  };

  /**
   * Ownership gate for every `/api/agents/:id*`, `/api/runs/:id*`,
   * `/api/grants/:id*` and `/api/approvals/:id*` route (`docs/API.md`
   * §Ownership), so a sub-route added later is covered by existing rather than
   * by remembering to add a check.
   * A malformed id is left alone for the route's own zod parse to answer 400.
   */
  // Arrows, not `.bind`: the method is looked up when a guarded route is hit,
  // so building the app never depends on the service being fully populated.
  const ownershipChecks = [
    {
      prefix: "/api/agents/",
      check: (id: string, caller: string, action: string) =>
        service.assertAgentOwnership(id, caller, action),
    },
    {
      prefix: "/api/runs/",
      check: (id: string, caller: string, action: string) =>
        service.assertRunOwnership(id, caller, action),
    },
    {
      prefix: "/api/grants/",
      check: (id: string, caller: string, action: string) =>
        service.assertGrantOwnership(id, caller, action),
    },
    {
      prefix: "/api/approvals/",
      check: (id: string, caller: string, action: string) =>
        service.assertApprovalOwnership(id, caller, action),
    },
  ];

  app.addHook("preHandler", async (request) => {
    const route = request.routeOptions.url ?? "";
    const matched = ownershipChecks.find((entry) => route.startsWith(entry.prefix));
    if (!matched) {
      return;
    }
    // Matched on the collection prefix, not on `:id`, so a route that names its
    // parameter something else is caught here loudly instead of slipping past
    // the gate unchecked. A malformed id still falls through to the route's own
    // zod parse, which answers 400.
    const { id } = (request.params ?? {}) as { id?: string };
    if (id === undefined) {
      throw new HttpError(500, "Guarded route " + route + " does not name its id param :id");
    }
    const parsed = agentIdParams.safeParse({ id });
    if (!parsed.success) {
      return;
    }
    await matched.check(parsed.data.id, callerOf(request), "api:" + request.method);
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  // Kept for the baseline UI's boot probe (apps/web/src/api.ts), which strands
  // on its loading screen if this 401s or 404s. Now reports the JWT gate, which
  // is always on: the token it asks for is a human JWT from /api/auth/login
  // until F replaces this screen with the login bar.
  app.get("/api/auth", async () => ({ required: true }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => ({
    agents: service.listAgents(callerOf(request)),
  }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body, callerOf(request));
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  // Checked in the handler rather than the hook above: this is the only route
  // that reaches a resource by an id that is not an agent's.
  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const run = await service.assertRunOwnership(
      id,
      callerOf(request),
      "GET /api/runs/:id",
    );
    return { run };
  });

  app.get("/api/agents/:id/grants", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { grants: service.getGrants(id) };
  });

  // Not under a guarded prefix, and it must not be: the resource being created
  // has no id yet. `createGrant` checks both agents against the caller itself —
  // 403 for an agent that is not theirs, 400 for a grant across tenants.
  app.post("/api/grants", async (request, reply) => {
    const body = grantBody.parse(request.body);
    const grant = await service.createGrant(body, callerOf(request));
    return reply.code(201).send({ grant });
  });

  app.post("/api/grants/:id/revoke", async (request) => {
    const { id } = grantIdParams.parse(request.params);
    return { grant: await service.revokeGrant(id, callerOf(request)) };
  });

  app.get("/api/approvals", async (request) => ({
    approvals: service.listApprovals(callerOf(request)),
  }));

  app.post("/api/approvals/:id/decide", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    const { decision } = decideBody.parse(request.body);
    return { approval: await service.decideApproval(id, decision, callerOf(request)) };
  });

  app.get("/api/runs/:id/events", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const { filter } = eventsQuery.parse(request.query);
    return { events: service.getRunEvents(id, filter) };
  });

  app.get("/api/agents/:id/events", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { filter, limit } = eventsQuery.parse(request.query);
    return { events: service.getAgentEvents(id, filter, limit) };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}

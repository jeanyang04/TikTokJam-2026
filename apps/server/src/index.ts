import path from "node:path";
import { AgentService } from "./agent-service.js";
import { verifyToken } from "./auth.js";
import { gatewayPlugin } from "./gateway.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const app = await createApp(config, service);

// LOCK 1. withOwner (B3, Postgres/RLS) and webhookSink (B2) plug in here when they land;
// until then crm_* report "unavailable" and webhook_send fails closed.
await app.register(gatewayPlugin, {
  store,
  workspaceRoot: config.workspaceRoot,
  verifyAgentToken: async (raw) => {
    const principal = await verifyToken(config, raw, "agent");
    if (!principal) throw new Error("invalid agent token");
    return { sub: principal.agentId, own: principal.ownerId, run: principal.runId, jti: principal.jti, scp: principal.scp };
  },
  enforce: process.env.GATEWAY_ENFORCE !== "false",
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

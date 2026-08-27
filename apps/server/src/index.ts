import path from "node:path";
import { AgentService } from "./agent-service.js";
import { verifyToken } from "./auth.js";
import { gatewayPlugin } from "./gateway.js";
import { llmProxyPlugin } from "./llm-proxy.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { demoPlugin } from "./demo.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { MockWebhookSink } from "./webhook-sink.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
const webhookSink = new MockWebhookSink();
await service.initialize();

const app = await createApp(config, service);

// LOCK 1. withOwner (B3, Postgres/RLS) plugs in here when it lands;
// until then crm_* reports "unavailable". The B2 webhook sink is local-only.
await app.register(gatewayPlugin, {
  store,
  workspaceRoot: config.workspaceRoot,
  verifyAgentToken: async (raw) => {
    const principal = await verifyToken(config, raw, "agent");
    if (!principal) throw new Error("invalid agent token");
    return { sub: principal.agentId, own: principal.ownerId, run: principal.runId, jti: principal.jti, scp: principal.scp };
  },
  webhookSink: webhookSink.send,
  enforce: process.env.GATEWAY_ENFORCE !== "false",
});
await app.register(demoPlugin, { config, store });
if (config.llmProxyEnabled) {
  await app.register(llmProxyPlugin, { config, store });
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

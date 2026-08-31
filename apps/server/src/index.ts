import path from "node:path";
import { AgentService } from "./agent-service.js";
import { setRedactor } from "./audit.js";
import { verifyToken } from "./auth.js";
import { createDb } from "./db.js";
import { gatewayPlugin } from "./gateway.js";
import { llmProxyPlugin } from "./llm-proxy.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { demoPlugin } from "./demo.js";
import { loadFingerprints } from "./ifc.js";
import { parseGrantIntent } from "./nl-grant.js";
import { redact } from "./redact.js";
import { makeScopeEstimator } from "./scope-estimator.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { MockWebhookSink } from "./webhook-sink.js";

// B3's redact.ts replaces audit.ts's built-in placeholder pattern list —
// every RunEvent audit.ts has already written or ever writes goes through
// this from here on.
setRedactor(redact);

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
// The Ark-backed estimator is wired here, not defaulted in the constructor:
// every test harness has Ark "configured" with a fake key, so the default has
// to be the offline keyword grammar. `parseGrantIntent` is
// passed explicitly only because it sits in front of it in the signature.
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  parseGrantIntent,
  makeScopeEstimator(config),
);
const webhookSink = new MockWebhookSink();
await service.initialize();

// B3: rehydrates ifc.ts's in-memory fingerprint cache from the store, so a
// restart mid-demo doesn't lose Scene 2's provenance data. Must run before
// the gateway (registered below) accepts its first request.
loadFingerprints(store);

const app = await createApp(config, service);

// LOCK 2 (B3): null until DATABASE_URL_ADMIN/DATABASE_URL_AGENT are both
// set — see db.ts and .env.example. crm_* stays "unavailable" until then.
const db = createDb(config);

// LOCK 1. The B2 webhook sink is local-only.
await app.register(gatewayPlugin, {
  store,
  workspaceRoot: config.workspaceRoot,
  verifyAgentToken: async (raw) => {
    const principal = await verifyToken(config, raw, "agent");
    if (!principal) throw new Error("invalid agent token");
    return { sub: principal.agentId, own: principal.ownerId, run: principal.runId, jti: principal.jti, scp: principal.scp };
  },
  withOwner: db?.withOwner,
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
  await db?.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

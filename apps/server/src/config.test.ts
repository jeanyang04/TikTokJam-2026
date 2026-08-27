import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, writeCodexConfig } from "./config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Runtime config", () => {
  it("uses a gateway URL reachable from the selected runtime", () => {
    expect(loadConfig({ NODE_ENV: "test" }).gatewayUrl).toBe(
      "http://127.0.0.1:3000",
    );
    expect(
      loadConfig({ NODE_ENV: "test", RUNTIME_PROVIDER: "container" }).gatewayUrl,
    ).toBe("http://host.docker.internal:3000");
    expect(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_URL: "http://gateway.example:4000/",
      }).gatewayUrl,
    ).toBe("http://gateway.example:4000");
  });

  it("points Codex at the local LLM proxy without writing the Ark key", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-config-"));
    directories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: directory,
      ARK_API_KEY: "ark-secret-must-not-be-written",
      ARK_MODEL: "ep-test",
      GATEWAY_URL: "http://127.0.0.1:3000",
      LLM_PROXY_ENABLED: "true",
    });

    await writeCodexConfig(config);
    const contents = await readFile(path.join(directory, "config.toml"), "utf8");

    expect(contents).toContain('base_url = "http://127.0.0.1:3000/llm"');
    expect(contents).toContain('env_key = "AGENT_TOKEN"');
    expect(contents).not.toContain("ark-secret-must-not-be-written");
  });
});

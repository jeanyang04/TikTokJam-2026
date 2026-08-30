import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signAgent } from "./auth.js";
import { loadConfig } from "./config.js";
import { llmProxyPlugin } from "./llm-proxy.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-"));
  directories.push(directory);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: directory,
    JWT_SECRET: "test-secret-at-least-32-bytes-long",
    ARK_API_KEY: "real-host-only-key",
    ARK_MODEL: "ep-test",
    LLM_PROXY_ENABLED: "true",
  });
  const store = new JsonStore(path.join(directory, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.runTokens.push({
      jti: "jti-1",
      runId: "run-1",
      agentId: "agent-1",
      ownerId: "user-jean",
      scp: [],
      taints: [],
      egressAllow: [],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
    });
  });
  const token = await signAgent(config, {
    sub: "agent-1",
    own: "user-jean",
    run: "run-1",
    jti: "jti-1",
    scp: [],
    expiresInSeconds: 60,
  });
  const app = Fastify();
  await app.register(llmProxyPlugin, { config, store });
  return { app, config, store, token };
}

describe("LLM proxy", () => {
  it("swaps the Agent token for the Ark key and streams the response", async () => {
    const { app, store, token } = await setup();
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('data: {"type":"done"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/llm/responses",
      headers: {
        authorization: "Bearer " + token,
        accept: "text/event-stream",
      },
      payload: { model: "ep-test", input: "hello" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: {"type":"done"}');
    expect(upstream).toHaveBeenCalledOnce();
    const init = upstream.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer real-host-only-key",
    );
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      kind: "llm",
      decision: "allow",
      detail: { status: 200, usage: null },
    });
  });

  it("rejects a revoked RunToken without contacting Ark", async () => {
    const { app, store, token } = await setup();
    await store.mutate((database) => {
      database.runTokens[0]!.revokedAt = new Date().toISOString();
    });
    const upstream = vi.spyOn(globalThis, "fetch");

    const response = await app.inject({
      method: "POST",
      url: "/llm/responses",
      headers: { authorization: "Bearer " + token },
      payload: { input: "hello" },
    });

    expect(response.statusCode).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      kind: "llm",
      decision: "deny",
      reason: "revoked-or-expired",
    });
  });
});

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  parseSeedUsers,
  registerAuth,
  signAgent,
  signHuman,
  verifyToken,
} from "./auth.js";
import { loadConfig } from "./config.js";

const config = loadConfig({ NODE_ENV: "test" });

describe("token verification", () => {
  it("round-trips a human token", async () => {
    const token = await signHuman(config, "user-jean");
    expect(await verifyToken(config, token, "human")).toEqual({
      typ: "human",
      userId: "user-jean",
    });
  });

  it("round-trips an agent token with its run identity", async () => {
    const token = await signAgent(config, {
      sub: "agent-7",
      own: "user-jean",
      run: "run-3",
      jti: "jti-9",
      scp: ["workspace:read"],
      expiresInSeconds: 600,
    });
    expect(await verifyToken(config, token, "agent")).toEqual({
      typ: "agent",
      agentId: "agent-7",
      ownerId: "user-jean",
      runId: "run-3",
      jti: "jti-9",
      scp: ["workspace:read"],
    });
  });

  it("refuses a token whose type does not match the one demanded", async () => {
    const human = await signHuman(config, "user-jean");
    expect(await verifyToken(config, human, "agent")).toBeNull();

    const agent = await signAgent(config, {
      sub: "agent-7",
      own: "user-jean",
      run: "run-3",
      jti: "jti-9",
      scp: [],
      expiresInSeconds: 600,
    });
    expect(await verifyToken(config, agent, "human")).toBeNull();
  });

  it("refuses a token signed with a different secret", async () => {
    const token = await signHuman(config, "user-jean");
    const otherConfig = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "an-entirely-different-secret",
    });
    expect(await verifyToken(otherConfig, token, "human")).toBeNull();
  });

  it("refuses an expired token", async () => {
    const token = await signAgent(config, {
      sub: "agent-7",
      own: "user-jean",
      run: "run-3",
      jti: "jti-9",
      scp: [],
      expiresInSeconds: -60,
    });
    expect(await verifyToken(config, token, "agent")).toBeNull();
  });

  it("refuses malformed input", async () => {
    expect(await verifyToken(config, "", "human")).toBeNull();
    expect(await verifyToken(config, "not-a-jwt", "human")).toBeNull();
  });
});

describe("seed users", () => {
  it("parses the SEED_USERS pairs into ids and display names", () => {
    expect(parseSeedUsers("user-jean:Jean, user-alex:Alex")).toEqual([
      { id: "user-jean", name: "Jean" },
      { id: "user-alex", name: "Alex" },
    ]);
  });

  it("falls back to the id when a pair has no display name", () => {
    expect(parseSeedUsers("user-jean")).toEqual([
      { id: "user-jean", name: "user-jean" },
    ]);
  });

  it("ignores empty entries", () => {
    expect(parseSeedUsers("user-jean:Jean,, ,")).toEqual([
      { id: "user-jean", name: "Jean" },
    ]);
  });
});

describe("the human gate", () => {
  it("attaches the verified principal to the request", async () => {
    const app = Fastify();
    registerAuth(app, config);
    app.get("/api/whoami", async (request) => ({
      principal: request.principal ?? null,
    }));

    const token = await signHuman(config, "user-alex");
    const response = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: "Bearer " + token },
    });
    expect(response.json()).toEqual({
      principal: { typ: "human", userId: "user-alex" },
    });
    await app.close();
  });

  it("does not gate routes outside /api/", async () => {
    const app = Fastify();
    registerAuth(app, config);
    app.post("/mcp", async () => ({ ok: true }));
    app.post("/llm/responses", async () => ({ ok: true }));
    app.post("/gw/workspace_read", async () => ({ ok: true }));
    app.post("/demo/replay", async () => ({ ok: true }));

    for (const url of [
      "/mcp",
      "/llm/responses",
      "/gw/workspace_read",
      "/demo/replay",
    ]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode, url).toBe(200);
    }
    await app.close();
  });
});

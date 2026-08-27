import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { signAgent, signHuman } from "./auth.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("issues a human JWT on login and accepts it on protected routes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { userId: "user-jean" },
    });
    expect(login.statusCode).toBe(200);
    const { token, user } = login.json() as {
      token: string;
      user: { id: string; name: string };
    };
    expect(user).toEqual({ id: "user-jean", name: "Jean" });

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer " + token },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("rejects login for a userId outside SEED_USERS", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { userId: "user-mallory" },
    });
    expect(login.statusCode).toBe(401);
    await app.close();
  });

  it("rejects protected API routes without a valid human JWT", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);

    const missing = await app.inject({ method: "GET", url: "/api/agents" });
    expect(missing.statusCode).toBe(401);

    const garbage = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(garbage.statusCode).toBe(401);

    const foreignSecret = await new SignJWT({ typ: "human" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-jean")
      .setExpirationTime("8h")
      .sign(new TextEncoder().encode("a-different-secret-entirely"));
    const forged = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer " + foreignSecret },
    });
    expect(forged.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an agent JWT on human API routes", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const app = await createApp(config, service);
    const agentToken = await signAgent(config, {
      sub: "agent-1",
      own: "user-jean",
      run: "run-1",
      jti: "jti-1",
      scp: [],
      expiresInSeconds: 600,
    });
    const denied = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer " + agentToken },
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it("leaves the boot probe open and reports that auth is required", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const probe = await app.inject({ method: "GET", url: "/api/auth" });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({ required: true });
    await app.close();
  });

  it("leaves health open, query string included", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);

    const healthWithQuery = await app.inject({
      method: "GET",
      url: "/api/health?probe=1",
    });
    expect(healthWithQuery.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const app = await createApp(config, service);
    const authorization = "Bearer " + (await signHuman(config, "user-jean"));

    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", authorization },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", authorization },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

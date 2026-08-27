import { describe, expect, it } from "vitest";
import { signAgent, signHuman, verifyToken } from "./auth.js";
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
    const parsed = loadConfig({
      NODE_ENV: "test",
      SEED_USERS: "user-jean:Jean, user-alex:Alex",
    });
    expect(parsed.seedUsers).toEqual([
      { id: "user-jean", name: "Jean" },
      { id: "user-alex", name: "Alex" },
    ]);
  });
});

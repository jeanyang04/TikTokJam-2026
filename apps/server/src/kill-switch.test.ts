import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";
import { cleanupHarnesses, makeHarness as harness } from "./test-harness.js";
import type { Agent, RunToken } from "./types.js";

const makeHarness = () => harness("launchpad-kill-");

afterEach(cleanupHarnesses);

/** A live token for a run that is still open, as `sendMessage` mints it. */
async function seedToken(
  store: JsonStore,
  agent: Agent,
  overrides: Partial<RunToken> = {},
): Promise<RunToken> {
  const token: RunToken = {
    jti: randomUUID(),
    runId: randomUUID(),
    agentId: agent.id,
    ownerId: agent.ownerId,
    scp: ["crm:read"],
    taints: [],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    revokedAt: null,
    ...overrides,
  };
  await store.mutate((database) => database.runTokens.push(token));
  return token;
}

describe("Kill switch", () => {
  it("revokes every live token for the agent and nobody else's", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Researcher" }, "user-jean");
    const bystander = await service.createAgent({ name: "Writer" }, "user-jean");
    const first = await seedToken(store, agent);
    const second = await seedToken(store, agent);
    const untouched = await seedToken(store, bystander);

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/kill",
      headers: await as("user-jean"),
    });

    expect(response.statusCode).toBe(200);
    const tokens = store.snapshot().runTokens;
    const revokedAt = (jti: string) => tokens.find((token) => token.jti === jti)?.revokedAt;
    expect(revokedAt(first.jti)).not.toBeNull();
    expect(revokedAt(second.jti)).not.toBeNull();
    expect(revokedAt(untouched.jti)).toBeNull();
    await app.close();
  });

  it("leaves an already-revoked token's timestamp alone", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Researcher" }, "user-jean");
    const closed = await seedToken(store, agent, { revokedAt: "2026-08-27T09:00:00.000Z" });

    await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/kill",
      headers: await as("user-jean"),
    });

    const token = store.snapshot().runTokens.find((item) => item.jti === closed.jti);
    expect(token?.revokedAt).toBe("2026-08-27T09:00:00.000Z");
    await app.close();
  });

  it("clears the temp scopes too, so the next run cannot mint back what was killed", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent(
      { name: "Researcher", permissions: { tools: ["crm:read"] } },
      "user-jean",
    );
    // "Allow for this run" leaves this behind, and `effectiveScopes` is tools ∪
    // live tempScopes: clearing only `tools` would let the next run revive it.
    await store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === agent.id);
      stored?.tempScopes.push({
        scope: "webhook:send",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/kill",
      headers: await as("user-jean"),
    });

    const killed = (response.json() as { agent: Agent }).agent;
    expect(killed.permissions.tools).toEqual([]);
    expect(killed.tempScopes).toEqual([]);

    const { run } = await service.sendMessage(agent.id, "carry on");
    const minted = store.snapshot().runTokens.find((token) => token.runId === run.id);
    expect(minted?.scp).toEqual([]);
    // Let the run settle so teardown doesn't race the store's writes.
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await app.close();
  });

  it("writes the operator's row, shaped by docs/API.md", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Researcher" }, "user-jean");
    await seedToken(store, agent);

    await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/kill",
      headers: await as("user-jean"),
    });

    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      agentId: agent.id,
      ownerId: "user-jean",
      action: "kill",
      resource: "agent/" + agent.id,
      decision: "deny",
      reason: "revoked-by-operator",
      runId: null,
    });
    await app.close();
  });

  it("works while the agent is busy — that is the whole point of it", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent(
      { name: "Researcher", permissions: { tools: ["crm:read"] } },
      "user-jean",
    );
    await store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === agent.id);
      if (stored) stored.status = "busy";
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/kill",
      headers: await as("user-jean"),
    });

    // Not a 409: a PATCH mid-run is an edit that can wait, a kill cannot.
    expect(response.statusCode).toBe(200);
    expect(service.getAgent(agent.id).permissions.tools).toEqual([]);
    // The container keeps running; Stop is what kills the process.
    expect(service.getAgent(agent.id).status).toBe("busy");
    await app.close();
  });

  it("refuses another tenant's agent", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent(
      { name: "Researcher", permissions: { tools: ["crm:read"] } },
      "user-jean",
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/kill",
      headers: await as("user-alex"),
    });

    expect(response.statusCode).toBe(403);
    expect(service.getAgent(agent.id).permissions.tools).toEqual(["crm:read"]);
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      ownerId: "user-alex",
      reason: "cross-tenant",
    });
    await app.close();
  });
});

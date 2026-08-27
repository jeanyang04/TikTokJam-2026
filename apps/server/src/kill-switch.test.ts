import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";
import { cleanupHarnesses, makeHarness as harness } from "./test-harness.js";
import type { Agent, ApprovalRequest, RunToken } from "./types.js";

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

/** A pending scope card, as the gateway writes it on a deny. */
async function seedCard(store: JsonStore, agent: Agent): Promise<ApprovalRequest> {
  const card: ApprovalRequest = {
    id: randomUUID(),
    source: "live_deny",
    kind: "scope",
    agentId: agent.id,
    ownerId: agent.ownerId,
    runId: null,
    jti: null,
    resource: agent.ownerId + "/crm",
    action: "read",
    scope: "crm:read",
    grant: null,
    reason: "scope",
    status: "pending",
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
  };
  await store.mutate((database) => database.approvals.push(card));
  return card;
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
    const token = await seedToken(store, agent);

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
      // Named, so the run's own timeline can show why it stopped: the gateway
      // audits the call it refuses before it has an identity to attribute.
      runId: token.runId,
    });
    await app.close();
  });

  it("names no run when the kill did not interrupt exactly one", async () => {
    const { app, service, store, as } = await makeHarness();
    const jean = await as("user-jean");
    const idle = await service.createAgent({ name: "Idle" }, "user-jean");
    const twoRuns = await service.createAgent({ name: "Researcher" }, "user-jean");
    await seedToken(store, twoRuns);
    await seedToken(store, twoRuns);

    // The common case: an idle agent, killed pre-emptively. Nothing to interrupt.
    await app.inject({ method: "POST", url: "/api/agents/" + idle.id + "/kill", headers: jean });
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({ action: "kill", runId: null });

    await app.inject({
      method: "POST",
      url: "/api/agents/" + twoRuns.id + "/kill",
      headers: jean,
    });
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({ action: "kill", runId: null });
    await app.close();
  });

  it("refuses the cards still pending, so Always allow cannot resurrect the agent", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Researcher" }, "user-jean");
    const card = await seedCard(store, agent);
    const jean = await as("user-jean");

    await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/kill",
      headers: jean,
    });

    expect(store.snapshot().approvals[0]).toMatchObject({ id: card.id, status: "deny" });

    // The operator answering a stale card must not write the scope back.
    const late = await app.inject({
      method: "POST",
      url: "/api/approvals/" + card.id + "/decide",
      headers: jean,
      payload: { decision: "allow_always" },
    });
    expect(late.statusCode).toBe(409);
    expect(service.getAgent(agent.id).permissions.tools).toEqual([]);
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

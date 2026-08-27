import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";
import { cleanupHarnesses, makeHarness as harness, UNKNOWN_ID } from "./test-harness.js";
import type { Agent, ApprovalRequest, PolicyGrant, RunEvent } from "./types.js";

const makeHarness = () => harness("launchpad-policy-");

afterEach(cleanupHarnesses);

/** A pending card, shaped as the gateway writes it on a scope deny. */
async function seedCard(
  store: JsonStore,
  agent: Agent,
  overrides: Partial<ApprovalRequest> = {},
): Promise<ApprovalRequest> {
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
    ...overrides,
  };
  await store.mutate((database) => database.approvals.push(card));
  return card;
}

describe("Grant routes", () => {
  it("creates a grant for the caller's own agents and lists it on both sides", async () => {
    const { app, service, as } = await makeHarness();
    const writer = await service.createAgent({ name: "Writer" }, "user-jean");
    const researcher = await service.createAgent({ name: "Researcher" }, "user-jean");

    const created = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: await as("user-jean"),
      payload: {
        fromAgent: writer.id,
        toAgent: researcher.id,
        resource: "workspace",
        actions: ["read"],
      },
    });

    expect(created.statusCode).toBe(201);
    const { grant } = created.json() as { grant: PolicyGrant };
    expect(grant).toMatchObject({
      fromOwner: "user-jean",
      fromAgent: writer.id,
      toAgent: researcher.id,
      egress: ["internal"],
      revokedAt: null,
    });

    for (const agent of [writer, researcher]) {
      const listed = await app.inject({
        method: "GET",
        url: "/api/agents/" + agent.id + "/grants",
        headers: await as("user-jean"),
      });
      expect(listed.statusCode).toBe(200);
      expect((listed.json() as { grants: PolicyGrant[] }).grants.map((g) => g.id)).toEqual([
        grant.id,
      ]);
    }
    await app.close();
  });

  it("refuses a grant to someone else's agent, and one across tenants, auditing both", async () => {
    const { app, service, store, as } = await makeHarness();
    const jeans = await service.createAgent({ name: "Writer" }, "user-jean");
    const alexs = await service.createAgent({ name: "Alex-1" }, "user-alex");
    const alex = await as("user-alex");

    const notYours = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: alex,
      payload: { fromAgent: null, toAgent: jeans.id, resource: "crm", actions: ["read"] },
    });
    expect(notYours.statusCode).toBe(403);
    // CLAUDE.md rule 3: this route names no id for the gate to guard, so the row
    // has to come from somewhere. It reaches an agent that exists.
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      agentId: jeans.id,
      ownerId: "user-alex",
      resource: "agent/" + jeans.id,
      decision: "deny",
      reason: "cross-tenant",
    });

    // The source agent is Jean's: a 400 by contract (D7), and audited all the
    // same — reaching for another tenant's workspace is the attempt worth
    // seeing. Counted, because this row looks exactly like the one above: an
    // assertion on `at(-1)` alone would pass by re-reading it.
    const afterFirst = store.snapshot().runEvents.length;
    const crossTenant = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: alex,
      payload: {
        fromAgent: jeans.id,
        toAgent: alexs.id,
        resource: "workspace",
        actions: ["read"],
      },
    });
    expect(crossTenant.statusCode).toBe(400);
    expect(store.snapshot().runEvents).toHaveLength(afterFirst + 1);
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      agentId: jeans.id,
      ownerId: "user-alex",
      resource: "agent/" + jeans.id,
      reason: "cross-tenant",
    });

    const before = store.snapshot().runEvents.length;
    const unknown = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: alex,
      payload: { fromAgent: null, toAgent: UNKNOWN_ID, resource: "crm", actions: ["read"] },
    });
    expect(unknown.statusCode).toBe(404);
    expect(store.snapshot().runEvents).toHaveLength(before);
    await app.close();
  });

  it("revokes a grant, and refuses another tenant's with 403 and an audit row", async () => {
    const { app, service, store, as } = await makeHarness();
    const writer = await service.createAgent({ name: "Writer" }, "user-jean");
    const researcher = await service.createAgent({ name: "Researcher" }, "user-jean");
    const created = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: await as("user-jean"),
      payload: {
        fromAgent: writer.id,
        toAgent: researcher.id,
        resource: "workspace",
        actions: ["read"],
      },
    });
    const { grant } = created.json() as { grant: PolicyGrant };

    const refused = await app.inject({
      method: "POST",
      url: "/api/grants/" + grant.id + "/revoke",
      headers: await as("user-alex"),
    });
    expect(refused.statusCode).toBe(403);
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      agentId: researcher.id,
      ownerId: "user-alex",
      kind: "gateway",
      action: "api:POST",
      resource: "grant/" + grant.id,
      decision: "deny",
      reason: "cross-tenant",
      runId: null,
    });

    const revoked = await app.inject({
      method: "POST",
      url: "/api/grants/" + grant.id + "/revoke",
      headers: await as("user-jean"),
    });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { grant: PolicyGrant }).grant.revokedAt).not.toBeNull();
    await app.close();
  });

  it("answers a plain 404 for an unknown grant, with nothing logged", async () => {
    const { app, store, as } = await makeHarness();

    const response = await app.inject({
      method: "POST",
      url: "/api/grants/" + UNKNOWN_ID + "/revoke",
      headers: await as("user-alex"),
    });

    expect(response.statusCode).toBe(404);
    expect(store.snapshot().runEvents).toHaveLength(0);
    await app.close();
  });
});

describe("Approval routes", () => {
  it("lists only the caller's cards, newest first", async () => {
    const { app, service, store, as } = await makeHarness();
    const jeans = await service.createAgent({ name: "Writer" }, "user-jean");
    const alexs = await service.createAgent({ name: "Alex-1" }, "user-alex");
    const older = await seedCard(store, jeans, {
      createdAt: "2026-08-27T10:00:00.000Z",
      action: "read",
    });
    const newer = await seedCard(store, jeans, {
      createdAt: "2026-08-27T11:00:00.000Z",
      action: "write",
    });
    await seedCard(store, alexs);

    const response = await app.inject({
      method: "GET",
      url: "/api/approvals",
      headers: await as("user-jean"),
    });

    expect(response.statusCode).toBe(200);
    const { approvals } = response.json() as { approvals: ApprovalRequest[] };
    expect(approvals.map((card) => card.id)).toEqual([newer.id, older.id]);
    await app.close();
  });

  it("widens the agent's permanent tools on allow_always, then 409s on a second decision", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Researcher" }, "user-jean");
    const card = await seedCard(store, agent);
    const jean = await as("user-jean");

    const decided = await app.inject({
      method: "POST",
      url: "/api/approvals/" + card.id + "/decide",
      headers: jean,
      payload: { decision: "allow_always" },
    });

    expect(decided.statusCode).toBe(200);
    expect((decided.json() as { approval: ApprovalRequest }).approval).toMatchObject({
      status: "allow_always",
      decidedBy: "user-jean",
    });
    expect(service.getAgent(agent.id).permissions.tools).toEqual(["crm:read"]);

    const again = await app.inject({
      method: "POST",
      url: "/api/approvals/" + card.id + "/decide",
      headers: jean,
      payload: { decision: "allow_always" },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("rejects an unknown decision", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Researcher" }, "user-jean");
    const card = await seedCard(store, agent);

    const response = await app.inject({
      method: "POST",
      url: "/api/approvals/" + card.id + "/decide",
      headers: await as("user-jean"),
      payload: { decision: "allow_forever" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("refuses another tenant's card with 403 and a row, an unknown one with a bare 404", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Researcher" }, "user-jean");
    const card = await seedCard(store, agent);
    const alex = await as("user-alex");

    const refused = await app.inject({
      method: "POST",
      url: "/api/approvals/" + card.id + "/decide",
      headers: alex,
      payload: { decision: "allow_always" },
    });
    expect(refused.statusCode).toBe(403);
    expect(store.snapshot().runEvents.at(-1)).toMatchObject({
      agentId: agent.id,
      ownerId: "user-alex",
      resource: "approval/" + card.id,
      decision: "deny",
      reason: "cross-tenant",
    });
    expect(service.getAgent(agent.id).permissions.tools).toEqual([]);

    const before = store.snapshot().runEvents.length;
    const unknown = await app.inject({
      method: "POST",
      url: "/api/approvals/" + UNKNOWN_ID + "/decide",
      headers: alex,
      payload: { decision: "deny" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(store.snapshot().runEvents).toHaveLength(before);
    await app.close();
  });
});

describe("Event timeline routes", () => {
  it("defaults a run timeline to policy kinds and widens it with filter=all", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Writer" }, "user-jean");
    const { run } = await service.sendMessage(agent.id, "hello");
    const row = (kind: RunEvent["kind"], at: string): RunEvent => ({
      id: randomUUID(),
      runId: run.id,
      agentId: agent.id,
      ownerId: "user-jean",
      at,
      kind,
      action: kind,
      resource: "workspace/notes.md",
      decision: null,
      reason: null,
      detail: {},
    });
    await store.mutate((database) => {
      database.runEvents.push(
        row("command", "2026-08-27T10:00:02.000Z"),
        row("gateway", "2026-08-27T10:00:01.000Z"),
        // Another run's row: never in this run's timeline.
        { ...row("gateway", "2026-08-27T10:00:03.000Z"), runId: randomUUID() },
      );
    });
    const jean = await as("user-jean");

    const policy = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id + "/events",
      headers: jean,
    });
    expect(policy.statusCode).toBe(200);
    expect((policy.json() as { events: RunEvent[] }).events.map((event) => event.kind)).toEqual([
      "gateway",
    ]);

    const all = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id + "/events?filter=all",
      headers: jean,
    });
    expect((all.json() as { events: RunEvent[] }).events.map((event) => event.kind)).toEqual([
      "gateway",
      "command",
    ]);
    await app.close();
  });

  it("refuses another tenant's run timeline", async () => {
    const { app, service, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Writer" }, "user-jean");
    const { run } = await service.sendMessage(agent.id, "hello");

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id + "/events",
      headers: await as("user-alex"),
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("gathers an agent's rows across runs, including the ones no run owns", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Writer" }, "user-jean");
    await service.sendMessage(agent.id, "hello");
    // A cross-tenant denial: agentId set, runId null. It belongs on the agent
    // timeline even though no run timeline can show it.
    await app.inject({
      method: "GET",
      url: "/api/agents/" + agent.id,
      headers: await as("user-alex"),
    });
    await store.mutate((database) => {
      database.runEvents.push({
        id: randomUUID(),
        runId: null,
        agentId: agent.id,
        ownerId: "user-jean",
        at: "2026-08-27T09:00:00.000Z",
        kind: "command",
        action: "shell",
        resource: "workspace",
        decision: null,
        reason: null,
        detail: {},
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/" + agent.id + "/events",
      headers: await as("user-jean"),
    });

    expect(response.statusCode).toBe(200);
    const { events } = response.json() as { events: RunEvent[] };
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "cross-tenant", runId: null });

    const limited = await app.inject({
      method: "GET",
      url: "/api/agents/" + agent.id + "/events?filter=all&limit=1",
      headers: await as("user-jean"),
    });
    // Newest kept when the limit bites, still ordered by `at`.
    const rows = (limited.json() as { events: RunEvent[] }).events;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "cross-tenant" });
    await app.close();
  });
});

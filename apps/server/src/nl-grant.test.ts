import { afterEach, describe, expect, it, vi } from "vitest";
import { createCardOnDeny } from "./approvals.js";
import { loadConfig } from "./config.js";
import {
  parseGrantIntent,
  parseWithArk,
  parseWithGrammar,
  type FetchLike,
} from "./nl-grant.js";
import { cleanupHarnesses, makeHarness } from "./test-harness.js";

afterEach(cleanupHarnesses);

const arkConfig = loadConfig({
  NODE_ENV: "test",
  ARK_API_KEY: "test-key",
  ARK_MODEL: "ep-test",
});
const noArkConfig = loadConfig({ NODE_ENV: "test" });

/** Ark answering with `raw` as its structured output. */
const arkAnswering = (raw: string): FetchLike =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ output_text: raw }),
  }));

describe("the demo grammar", () => {
  it("reads the sentence Scene 3 is rehearsed with", () => {
    expect(parseWithGrammar("let Researcher read Writer's notes")).toEqual({
      toAgent: "Researcher",
      fromAgent: "Writer",
      resource: "workspace",
      actions: ["read"],
    });
  });

  it("takes the workspace wording and a curly apostrophe", () => {
    expect(parseWithGrammar("Please let Researcher read Writer’s workspace")).toMatchObject({
      fromAgent: "Writer",
      resource: "workspace",
    });
  });

  it("returns null rather than guessing at a sentence it does not know", () => {
    expect(parseWithGrammar("give Researcher whatever it needs")).toBeNull();
  });

  it("does not offer a CRM grant, which the gateway would never read", async () => {
    // `crm_read`/`crm_write` are gated on scope alone, so a PolicyGrant on
    // `crm` is a row nothing consults.
    expect(parseWithGrammar("let Researcher read the CRM")).toBeNull();
    expect(await parseGrantIntent(noArkConfig, "let Researcher read the CRM")).toBeNull();
  });

  it("reads as unparseable rather than throwing when a name is absurdly long", async () => {
    const text = "let " + "R".repeat(80) + " read Writer's notes";
    expect(parseWithGrammar(text)).not.toBeNull();
    await expect(parseGrantIntent(noArkConfig, text)).resolves.toBeNull();
  });
});

describe("the Ark path", () => {
  it("takes a well-formed answer", async () => {
    const intent = await parseWithArk(
      arkConfig,
      "share the writer's drafts with the researcher",
      arkAnswering(
        JSON.stringify({
          toAgent: "Researcher",
          fromAgent: "Writer",
          resource: "workspace",
          actions: ["read"],
        }),
      ),
    );
    expect(intent).toMatchObject({ toAgent: "Researcher", fromAgent: "Writer" });
  });

  it("refuses an answer that does not match the schema", async () => {
    const intent = await parseWithArk(
      arkConfig,
      "anything",
      arkAnswering(JSON.stringify({ toAgent: "Researcher", resource: "everything" })),
    );
    expect(intent).toBeNull();
  });

  it("refuses an answer asking for two actions at once", async () => {
    const intent = await parseWithArk(
      arkConfig,
      "let Researcher do everything to Writer's notes",
      arkAnswering(
        JSON.stringify({
          toAgent: "Researcher",
          fromAgent: "Writer",
          resource: "workspace",
          actions: ["read", "write"],
        }),
      ),
    );
    expect(intent).toBeNull();
  });

  it("falls back to the grammar when Ark is unreachable", async () => {
    const failing: FetchLike = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const intent = await parseGrantIntent(
      arkConfig,
      "let Researcher read Writer's notes",
      failing,
    );
    expect(failing).toHaveBeenCalledOnce();
    expect(intent).toMatchObject({ toAgent: "Researcher", fromAgent: "Writer" });
  });

  it("does not call Ark at all when it is not configured", async () => {
    const spy: FetchLike = vi.fn();
    await parseGrantIntent(noArkConfig, "let Researcher read Writer's notes", spy);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("POST /api/grants/parse", () => {
  const harnessWithoutArk = () => makeHarness("nl-grant-", { ARK_API_KEY: "", ARK_MODEL: "" });

  const seedTwoAgents = async (harness: Awaited<ReturnType<typeof makeHarness>>) => {
    const researcher = await harness.service.createAgent({ name: "Researcher" }, "user-jean");
    const writer = await harness.service.createAgent({ name: "Writer" }, "user-jean");
    return { researcher, writer };
  };

  it("lands a pending card carrying the nl_intent badge", async () => {
    const harness = await harnessWithoutArk();
    const { researcher, writer } = await seedTwoAgents(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/grants/parse",
      headers: await harness.as("user-jean"),
      payload: { text: "let Researcher read Writer's notes" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().approval).toMatchObject({
      source: "nl_intent",
      kind: "grant",
      status: "pending",
      agentId: researcher.id,
      resource: "Writer/workspace",
      action: "read",
      runId: null,
      jti: null,
      grant: {
        fromOwner: "user-jean",
        fromAgent: writer.id,
        toAgent: researcher.id,
        resource: "workspace",
        actions: ["read"],
      },
    });
  });

  it("produces a card that actually writes the grant when approved", async () => {
    const harness = await harnessWithoutArk();
    const { researcher, writer } = await seedTwoAgents(harness);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/grants/parse",
      headers: await harness.as("user-jean"),
      payload: { text: "let Researcher read Writer's notes" },
    });

    // The whole point of "identical in shape to a live-deny card": decide knows
    // nothing about where the card came from.
    const decided = await harness.app.inject({
      method: "POST",
      url: "/api/approvals/" + created.json().approval.id + "/decide",
      headers: await harness.as("user-jean"),
      payload: { decision: "allow_always" },
    });

    expect(decided.statusCode).toBe(200);
    const grants = harness.store.snapshot().policyGrants;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      fromOwner: "user-jean",
      fromAgent: writer.id,
      toAgent: researcher.id,
      resource: "workspace",
      actions: ["read"],
      revokedAt: null,
    });
  });

  it("refuses Allow for this run, which would write a permanent grant", async () => {
    const harness = await harnessWithoutArk();
    await seedTwoAgents(harness);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/grants/parse",
      headers: await harness.as("user-jean"),
      payload: { text: "let Researcher read Writer's notes" },
    });

    // `decideApproval` reads the run window off `card.jti`, and there is no run
    // behind an nl_intent card. Without this guard the narrower button writes
    // the broader grant.
    const decided = await harness.app.inject({
      method: "POST",
      url: "/api/approvals/" + created.json().approval.id + "/decide",
      headers: await harness.as("user-jean"),
      payload: { decision: "allow_run" },
    });

    expect(decided.statusCode).toBe(409);
    expect(harness.store.snapshot().policyGrants).toEqual([]);
  });

  it("returns the pending card a live deny already raised, and does not claim 201", async () => {
    const harness = await harnessWithoutArk();
    const { researcher, writer } = await seedTwoAgents(harness);
    // Exactly what gateway.ts writes on a no-grant deny.
    const live = await createCardOnDeny(harness.store, {
      source: "live_deny",
      kind: "grant",
      agentId: researcher.id,
      ownerId: "user-jean",
      runId: "run-1",
      jti: "jti-1",
      resource: "Writer/workspace",
      action: "read",
      scope: null,
      grant: {
        fromOwner: "user-jean",
        fromAgent: writer.id,
        toAgent: researcher.id,
        resource: "workspace",
        actions: ["read"],
        egress: ["internal"],
      },
      reason: "no grant",
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/grants/parse",
      headers: await harness.as("user-jean"),
      payload: { text: "let Researcher read Writer's notes" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().approval.id).toBe(live.id);
    // One pending decision per access: the operator must not see two cards for
    // the same grant because it was asked for twice.
    expect(harness.store.snapshot().approvals).toHaveLength(1);

    // Scene 1 into Scene 3, in the demo's own order: the card the parse call
    // handed back still carries its run, so it takes the ordinary gateway path
    // and writes the grant.
    const decided = await harness.app.inject({
      method: "POST",
      url: "/api/approvals/" + live.id + "/decide",
      headers: await harness.as("user-jean"),
      payload: { decision: "allow_always" },
    });

    expect(decided.statusCode).toBe(200);
    expect(harness.store.snapshot().policyGrants).toMatchObject([
      { fromAgent: writer.id, toAgent: researcher.id, resource: "workspace", revokedAt: null },
    ]);
  });

  it("cannot name another tenant's agent, so it 404s before any card exists", async () => {
    const harness = await harnessWithoutArk();
    await harness.service.createAgent({ name: "Researcher" }, "user-jean");
    await harness.service.createAgent({ name: "Writer" }, "user-alex");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/grants/parse",
      headers: await harness.as("user-jean"),
      payload: { text: "let Researcher read Writer's notes" },
    });

    expect(response.statusCode).toBe(404);
    expect(harness.store.snapshot().approvals).toEqual([]);
  });

  it("answers 422 for a sentence it cannot read, and writes nothing", async () => {
    const harness = await harnessWithoutArk();
    await seedTwoAgents(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/grants/parse",
      headers: await harness.as("user-jean"),
      payload: { text: "do something clever about the notes" },
    });

    expect(response.statusCode).toBe(422);
    expect(harness.store.snapshot().approvals).toEqual([]);
  });

  it("keeps the caller's prose out of the audit trail", async () => {
    const harness = await harnessWithoutArk();
    await seedTwoAgents(harness);
    const text = "let Researcher read Writer's notes";

    await harness.app.inject({
      method: "POST",
      url: "/api/grants/parse",
      headers: await harness.as("user-jean"),
      payload: { text },
    });

    const event = harness.store.snapshot().runEvents.at(-1)!;
    expect(event).toMatchObject({ kind: "approval", decision: "pending", reason: "nl_intent" });
    expect(JSON.stringify(event)).not.toContain(text);
  });

  it("requires a human token like every other /api route", async () => {
    const harness = await harnessWithoutArk();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/grants/parse",
      payload: { text: "let Researcher read Writer's notes" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an empty or oversized body before anything is parsed", async () => {
    const harness = await harnessWithoutArk();
    const headers = await harness.as("user-jean");
    for (const text of ["", "x".repeat(501)]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/grants/parse",
        headers,
        payload: { text },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

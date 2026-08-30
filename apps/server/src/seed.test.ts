import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redact } from "./audit.js";
import { seedDemoFixtures, FIXTURE_AGENTS } from "./seed.js";
import { cleanupHarnesses, makeHarness } from "./test-harness.js";
import type { Agent } from "./types.js";

afterEach(cleanupHarnesses);

type Harness = Awaited<ReturnType<typeof makeHarness>>;

const seedInto = async (harness: Harness) =>
  seedDemoFixtures({
    store: harness.store,
    workspaceRoot: harness.config.workspaceRoot,
    seedUsers: harness.config.seedUsers,
  });

const named = (harness: Harness, name: string): Agent =>
  harness.store.snapshot().agents.find((agent) => agent.name === name)!;

describe("demo fixtures", () => {
  it("seeds the cast the storyboard names", async () => {
    const harness = await makeHarness("seed-cast-");
    await seedInto(harness);

    const agents = harness.store.snapshot().agents;
    expect(
      agents.map((agent) => [agent.name, agent.ownerId]).sort(),
    ).toEqual([
      ["Alex-1", "user-alex"],
      ["Researcher", "user-jean"],
      ["Writer", "user-jean"],
    ]);
    // Scene 2 reaches the IFC check only if the send is in scope; Scene 1 stays
    // a deny because no grant on Writer's workspace is seeded.
    expect(named(harness, "Researcher").permissions.tools).toEqual([
      "workspace:read",
      "webhook:send",
    ]);
  });

  it("writes Writer's planted notes and fake credentials", async () => {
    const harness = await makeHarness("seed-workspace-");
    await seedInto(harness);

    const writer = named(harness, "Writer");
    const notes = await readFile(path.join(writer.workspacePath, "notes.md"), "utf8");
    const credentials = await readFile(
      path.join(writer.workspacePath, "credentials.json"),
      "utf8",
    );
    expect(notes).toContain("https://hooks.opsdesk.io/inbound");
    expect(notes).toContain("credentials.json");
    expect(JSON.parse(credentials)).toMatchObject({ service: expect.any(String) });
  });

  it("shapes the fake credential so the audit trail redacts it", async () => {
    const harness = await makeHarness("seed-redaction-");
    await seedInto(harness);

    const credentials = await readFile(
      path.join(named(harness, "Writer").workspacePath, "credentials.json"),
      "utf8",
    );
    // What Scene 2's blocked webhook_send would put in the RunEvent detail.
    const audited = redact(credentials) as string;
    expect(audited).toContain("[redacted]");
    expect(audited).not.toContain(JSON.parse(credentials).session_token);
  });

  it("runs against a workspace root no server has created yet", async () => {
    const harness = await makeHarness("seed-cold-root-");
    const root = path.join(harness.config.workspaceRoot, "never-initialised");

    await seedDemoFixtures({
      store: harness.store,
      workspaceRoot: root,
      seedUsers: harness.config.seedUsers,
    });

    const writer = named(harness, "Writer");
    expect(writer.workspacePath.startsWith(root)).toBe(true);
    await expect(
      readFile(path.join(writer.workspacePath, "notes.md"), "utf8"),
    ).resolves.toContain("https://hooks.opsdesk.io/inbound");
  });

  it("re-runs without duplicating an agent or changing its id", async () => {
    const harness = await makeHarness("seed-idempotent-");
    await seedInto(harness);
    const first = harness.store.snapshot().agents.map((agent) => agent.id);

    await seedInto(harness);

    const agents = harness.store.snapshot().agents;
    expect(agents).toHaveLength(FIXTURE_AGENTS.length);
    expect(agents.map((agent) => agent.id)).toEqual(first);
    const notes = await readFile(
      path.join(named(harness, "Writer").workspacePath, "notes.md"),
      "utf8",
    );
    expect(notes).toContain("https://hooks.opsdesk.io/inbound");
  });

  it("resets what a rehearsal widened, so Scene 1 denies again", async () => {
    const harness = await makeHarness("seed-reset-");
    await seedInto(harness);
    const researcher = named(harness, "Researcher");
    const writer = named(harness, "Writer");
    // What Scene 1's "Always allow" leaves behind, plus the thread the run left.
    await harness.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === researcher.id)!;
      agent.permissions.tools = [...agent.permissions.tools, "crm:read"];
      agent.tempScopes.push({ scope: "crm:write", expiresAt: "2099-01-01T00:00:00.000Z" });
      agent.codexThreadId = "thread-from-a-rehearsal";
      database.policyGrants.push({
        id: "grant-from-a-rehearsal",
        fromOwner: "user-jean",
        fromAgent: writer.id,
        toAgent: researcher.id,
        resource: "workspace",
        actions: ["read"],
        egress: ["internal"],
        createdAt: "2026-08-28T00:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
      });
    });

    await seedInto(harness);

    const reset = named(harness, "Researcher");
    expect(reset.permissions.tools).toEqual(["workspace:read", "webhook:send"]);
    expect(reset.tempScopes).toEqual([]);
    expect(reset.codexThreadId).toBeNull();
    const grant = harness.store
      .snapshot()
      .policyGrants.find((item) => item.id === "grant-from-a-rehearsal")!;
    expect(grant.revokedAt).not.toBeNull();
  });

  it("leaves an agent outside the cast, and its grant, alone", async () => {
    const harness = await makeHarness("seed-bystander-");
    const bystander = await harness.service.createAgent(
      { name: "Bystander", permissions: { tools: ["crm:write"] } },
      "user-jean",
    );
    await seedInto(harness);
    const writer = named(harness, "Writer");
    await harness.store.mutate((database) => {
      database.policyGrants.push({
        id: "a-real-grant",
        fromOwner: "user-jean",
        fromAgent: writer.id,
        toAgent: bystander.id,
        resource: "workspace",
        actions: ["read"],
        egress: ["internal"],
        createdAt: "2026-08-28T00:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
      });
    });

    await seedInto(harness);

    const after = harness.store.snapshot();
    expect(after.agents.find((agent) => agent.id === bystander.id)!.permissions.tools).toEqual([
      "crm:write",
    ]);
    // Only the recipient decides: a grant reaching out of the cast is somebody's
    // real configuration, not leftover demo state.
    expect(after.policyGrants.find((grant) => grant.id === "a-real-grant")!.revokedAt).toBeNull();
  });

  it("refuses to reset a cast agent that is mid-run", async () => {
    const harness = await makeHarness("seed-busy-");
    await seedInto(harness);
    const researcher = named(harness, "Researcher");
    await harness.store.mutate((database) => {
      database.agents.find((agent) => agent.id === researcher.id)!.status = "busy";
    });

    await expect(seedInto(harness)).rejects.toThrow(/Researcher/);
    expect(named(harness, "Researcher").status).toBe("busy");
  });

  it("clears the stage on --reset: strays gone, history emptied, cast intact", async () => {
    const harness = await makeHarness("seed-reset-");
    const stray = await harness.service.createAgent(
      { name: "Bystander", permissions: { tools: ["crm:write"] } },
      "user-jean",
    );
    await seedInto(harness);
    const writer = named(harness, "Writer");
    await harness.store.mutate((database) => {
      database.messages.push({
        id: "m1", agentId: stray.id, runId: "r1", role: "user", content: "hi",
        createdAt: "2026-08-28T00:00:00.000Z",
      });
      database.runEvents.push({
        id: "e1", runId: "r1", agentId: stray.id, ownerId: "user-jean",
        at: "2026-08-28T00:00:00.000Z", kind: "gateway", action: "x", resource: "y",
        decision: "allow", reason: null, detail: {},
      });
      database.policyGrants.push({
        id: "a-real-grant", fromOwner: "user-jean", fromAgent: writer.id,
        toAgent: stray.id, resource: "workspace", actions: ["read"], egress: ["internal"],
        trustContent: false, createdAt: "2026-08-28T00:00:00.000Z", expiresAt: null, revokedAt: null,
      });
    });

    const result = await seedDemoFixtures({
      store: harness.store,
      workspaceRoot: harness.config.workspaceRoot,
      seedUsers: harness.config.seedUsers,
      reset: true,
    });

    const after = harness.store.snapshot();
    expect(after.agents.map((agent) => agent.name).sort()).toEqual([
      "Alex-1", "Researcher", "Writer",
    ]);
    expect(after.messages).toEqual([]);
    expect(after.runEvents).toEqual([]);
    // Removed outright, not revoked: a revoked row would still render in the
    // grants list and make the next run-through unreadable.
    expect(after.policyGrants).toEqual([]);
    expect(result.removed).toEqual(["Bystander"]);
    expect(result.purged?.messages).toBe(1);
    // The stray's workspace is archived, not destroyed.
    const archived = path.join(harness.config.workspaceRoot, ".deleted");
    expect((await readdir(archived)).some((entry) => entry.startsWith(stray.id))).toBe(true);
  });

  it("refuses a --reset while any agent is mid-run, including one outside the cast", async () => {
    const harness = await makeHarness("seed-reset-busy-");
    const stray = await harness.service.createAgent({ name: "Bystander" }, "user-jean");
    await seedInto(harness);
    await harness.store.mutate((database) => {
      database.agents.find((agent) => agent.id === stray.id)!.status = "busy";
    });

    await expect(
      seedDemoFixtures({
        store: harness.store,
        workspaceRoot: harness.config.workspaceRoot,
        seedUsers: harness.config.seedUsers,
        reset: true,
      }),
    ).rejects.toThrow(/Bystander/);
    // A refused reset changes nothing at all.
    expect(harness.store.snapshot().agents).toHaveLength(4);
  });

  it("refuses to stamp an owner the deployment does not know", async () => {
    const harness = await makeHarness("seed-unknown-owner-");
    await expect(
      seedDemoFixtures({
        store: harness.store,
        workspaceRoot: harness.config.workspaceRoot,
        seedUsers: "user-jean:Jean",
      }),
    ).rejects.toThrow(/user-alex/);
    expect(harness.store.snapshot().agents).toEqual([]);
  });
});

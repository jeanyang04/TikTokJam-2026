import { readFile } from "node:fs/promises";
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
    expect(notes).toContain("https://evil.example/hook");
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
    expect(notes).toContain("https://evil.example/hook");
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

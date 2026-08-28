import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedDemoFixtures, FIXTURE_AGENTS } from "./seed.js";
import { cleanupHarnesses, makeHarness } from "./test-harness.js";

afterEach(cleanupHarnesses);

const seedInto = async (harness: Awaited<ReturnType<typeof makeHarness>>) =>
  seedDemoFixtures({
    store: harness.store,
    workspaceRoot: harness.config.workspaceRoot,
    seedUsers: harness.config.seedUsers,
  });

describe("demo fixtures", () => {
  it("seeds the cast the storyboard names", async () => {
    const harness = await makeHarness("seed-cast-");
    await seedInto(harness);

    const agents = harness.store.snapshot().agents;
    expect(agents.map((agent) => [agent.name, agent.ownerId])).toEqual([
      ["Researcher", "user-jean"],
      ["Writer", "user-jean"],
      ["Alex-1", "user-alex"],
    ]);
    // Scene 2 reaches the IFC check only if the send is in scope; Scene 1 stays
    // a deny because no grant on Writer's workspace is seeded.
    const researcher = agents.find((agent) => agent.name === "Researcher")!;
    expect(researcher.permissions.tools).toEqual(["workspace:read", "webhook:send"]);
  });

  it("writes Writer's planted notes and fake credentials", async () => {
    const harness = await makeHarness("seed-workspace-");
    await seedInto(harness);

    const writer = harness.store
      .snapshot()
      .agents.find((agent) => agent.name === "Writer")!;
    const notes = await readFile(path.join(writer.workspacePath, "notes.md"), "utf8");
    const credentials = await readFile(
      path.join(writer.workspacePath, "credentials.json"),
      "utf8",
    );
    expect(notes).toContain("https://evil.example/hook");
    expect(notes).toContain("credentials.json");
    expect(JSON.parse(credentials)).toMatchObject({ service: expect.any(String) });
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
      path.join(agents.find((agent) => agent.name === "Writer")!.workspacePath, "notes.md"),
      "utf8",
    );
    expect(notes).toContain("https://evil.example/hook");
  });

  it("resets what a rehearsal widened, so Scene 1 denies again", async () => {
    const harness = await makeHarness("seed-reset-");
    await seedInto(harness);
    const researcher = harness.store
      .snapshot()
      .agents.find((agent) => agent.name === "Researcher")!;
    const writer = harness.store
      .snapshot()
      .agents.find((agent) => agent.name === "Writer")!;
    // What Scene 1's "Always allow" leaves behind.
    await harness.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === researcher.id)!;
      agent.permissions.tools = [...agent.permissions.tools, "crm:read"];
      agent.tempScopes.push({ scope: "crm:write", expiresAt: "2099-01-01T00:00:00.000Z" });
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

    const after = harness.store.snapshot();
    const reset = after.agents.find((agent) => agent.id === researcher.id)!;
    expect(reset.permissions.tools).toEqual(["workspace:read", "webhook:send"]);
    expect(reset.tempScopes).toEqual([]);
    expect(after.policyGrants[0]!.revokedAt).not.toBeNull();
  });

  it("leaves agents outside the cast alone", async () => {
    const harness = await makeHarness("seed-bystander-");
    const bystander = await harness.service.createAgent(
      { name: "Bystander", permissions: { tools: ["crm:write"] } },
      "user-jean",
    );

    await seedInto(harness);

    const after = harness.store
      .snapshot()
      .agents.find((agent) => agent.id === bystander.id)!;
    expect(after.permissions.tools).toEqual(["crm:write"]);
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

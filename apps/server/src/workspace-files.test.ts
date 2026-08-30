import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHarnesses, makeHarness as harness } from "./test-harness.js";

const makeHarness = () => harness("launchpad-files-");

afterEach(cleanupHarnesses);

describe("Workspace file inspector", () => {
  it("lists the agent's files and reads one back", async () => {
    const { app, service, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Writer" }, "user-jean");
    await mkdir(path.join(agent.workspacePath, "drafts"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "drafts", "ch1.md"), "chapter one", "utf8");

    const listing = await app.inject({
      method: "GET",
      url: "/api/agents/" + agent.id + "/files",
      headers: await as("user-jean"),
    });

    expect(listing.statusCode).toBe(200);
    const { files, truncated } = listing.json() as {
      files: { path: string }[];
      truncated: boolean;
    };
    expect(truncated).toBe(false);
    // Posix separators regardless of host, so the UI can split on "/".
    expect(files.map((file) => file.path)).toContain("drafts/ch1.md");

    const content = await app.inject({
      method: "GET",
      url: "/api/agents/" + agent.id + "/files/content?path=drafts/ch1.md",
      headers: await as("user-jean"),
    });

    expect(content.statusCode).toBe(200);
    expect((content.json() as { file: { content: string } }).file.content).toBe("chapter one");
    await app.close();
  });

  it("omits .git and node_modules from the walk", async () => {
    const { app, service, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Writer" }, "user-jean");
    await mkdir(path.join(agent.workspacePath, "node_modules", "left-pad"), { recursive: true });
    await writeFile(
      path.join(agent.workspacePath, "node_modules", "left-pad", "index.js"),
      "module.exports = 1;",
      "utf8",
    );

    const listing = await app.inject({
      method: "GET",
      url: "/api/agents/" + agent.id + "/files",
      headers: await as("user-jean"),
    });

    const { files } = listing.json() as { files: { path: string }[] };
    expect(files.some((file) => file.path.startsWith("node_modules/"))).toBe(false);
    await app.close();
  });

  it("refuses a path that escapes the workspace", async () => {
    const { app, service, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Writer" }, "user-jean");
    const victim = await service.createAgent({ name: "Researcher" }, "user-jean");
    await writeFile(path.join(victim.workspacePath, "secret.md"), "not yours", "utf8");

    const escape = await app.inject({
      method: "GET",
      url:
        "/api/agents/" +
        agent.id +
        "/files/content?path=" +
        encodeURIComponent("../" + path.basename(victim.workspacePath) + "/secret.md"),
      headers: await as("user-jean"),
    });

    // Even between two agents the same person owns: the route reads one
    // workspace, and traversal is how it would quietly read another.
    expect(escape.statusCode).toBe(403);

    const absolute = await app.inject({
      method: "GET",
      url:
        "/api/agents/" +
        agent.id +
        "/files/content?path=" +
        encodeURIComponent(path.join(victim.workspacePath, "secret.md")),
      headers: await as("user-jean"),
    });

    expect(absolute.statusCode).toBe(400);
    await app.close();
  });

  it("404s a file that is not there", async () => {
    const { app, service, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Writer" }, "user-jean");

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/" + agent.id + "/files/content?path=nope.md",
      headers: await as("user-jean"),
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("refuses another tenant's workspace with 403 and an audit event", async () => {
    const { app, service, store, as } = await makeHarness();
    const agent = await service.createAgent({ name: "Writer" }, "user-jean");
    await writeFile(path.join(agent.workspacePath, "notes.md"), "jean's notes", "utf8");

    const listing = await app.inject({
      method: "GET",
      url: "/api/agents/" + agent.id + "/files",
      headers: await as("user-alex"),
    });
    const content = await app.inject({
      method: "GET",
      url: "/api/agents/" + agent.id + "/files/content?path=notes.md",
      headers: await as("user-alex"),
    });

    expect(listing.statusCode).toBe(403);
    expect(content.statusCode).toBe(403);
    // The inspector rides the existing preHandler rather than its own check, so
    // this pins that it is actually covered by it — CLAUDE.md rule 3.
    expect(
      store.snapshot().runEvents.filter((event) => event.reason === "cross-tenant"),
    ).toHaveLength(2);
    await app.close();
  });
});

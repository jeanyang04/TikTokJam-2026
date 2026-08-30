import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint, loadFingerprints, matchOrigin, screenOutput } from "./ifc.js";
import { JsonStore } from "./store.js";
import type { Label } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "ifc-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

const label: Label = { grantId: "g-1", origin: "user-jean/Writer", egress: ["internal"], level: "confidential" };

describe("ifc fingerprint persistence", () => {
  it("writes hashes + label to the store, never the raw content", async () => {
    const store = await tempStore();
    fingerprint(store, "run-1", label, "the quarterly roadmap says ship the identity gateway before demo day");
    // fingerprint() writes through fire-and-forget; give the queued mutate a turn to land.
    await store.mutate(() => {});

    const rows = store.snapshot().fingerprints;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: "run-1", label });
    expect(rows[0]!.hashes.length).toBeGreaterThan(0);
    // Every persisted hash is a short hex digest — nothing resembling the
    // original sentence made it into the store.
    for (const hash of rows[0]!.hashes) expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(rows)).not.toMatch(/quarterly|roadmap|identity gateway/);
  });

  it("survives a simulated restart: matchOrigin fails on a fresh process until loadFingerprints rehydrates it", async () => {
    const store = await tempStore();
    const content = "the quarterly roadmap says ship the identity gateway before demo day arrives";
    fingerprint(store, "run-2", label, content);
    await store.mutate(() => {});

    // Confirm it resolves before we simulate anything, so the "not found"
    // case below is really about the restart and not a broken fixture.
    expect(matchOrigin("run-2", content)).toMatchObject(label);

    // Simulate a server restart: the in-memory cache is gone, but the store
    // (a real file on disk) is not — that's the whole point of persisting.
    // An un-initialized JsonStore starts from an empty in-memory database
    // (see store.ts's emptyDatabase()), so loading from one here is a clean
    // way to reset the cache without touching the real store's file.
    loadFingerprints(new JsonStore(path.join(tmpdir(), "ifc-test-never-initialized.json")));
    expect(matchOrigin("run-2", content)).toBeNull();

    // Rehydrate from the same store a fresh process would load at startup.
    loadFingerprints(store);
    expect(matchOrigin("run-2", content)).toMatchObject(label);
  });

  it("clearFingerprints removes a run from both the cache and the store", async () => {
    const store = await tempStore();
    const content = "some content that is long enough to produce a shingle hash for this test";
    fingerprint(store, "run-3", label, content);
    await store.mutate(() => {});
    expect(matchOrigin("run-3", content)).toMatchObject(label);

    const { clearFingerprints } = await import("./ifc.js");
    clearFingerprints(store, "run-3");
    await store.mutate(() => {});

    expect(matchOrigin("run-3", content)).toBeNull();
    expect(store.snapshot().fingerprints.some((f) => f.runId === "run-3")).toBe(false);
  });

  it("defaults level to internal on rows persisted before Label.level existed", async () => {
    const store = await tempStore();
    const content = "an old provenance row from before the classification field ever existed here";
    fingerprint(store, "run-legacy", label, content);
    await store.mutate(() => {});
    // Strip the field the way a pre-level db.json genuinely lacks it.
    await store.mutate((d) => {
      for (const f of d.fingerprints) delete (f.label as Partial<Label>).level;
    });
    loadFingerprints(store);
    expect(matchOrigin("run-legacy", content)?.level).toBe("internal");
    expect(screenOutput("run-legacy", content).verdict).toBe("allow");
  });
});

const FAKE_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIn0.c2ln";
const secretLabel: Label = { grantId: "self", origin: "user-jean/Writer", egress: ["internal", "agent", "external"], level: "secret" };

describe("screenOutput — chat output as the third egress surface", () => {
  it("blocks output copying through a secret-classified read, naming the origin", async () => {
    const store = await tempStore();
    const creds = "the deploy credentials file contains the token " + FAKE_JWT + " for production use";
    fingerprint(store, "screen-1", secretLabel, creds);
    const result = screenOutput("screen-1", "Here is what I found: " + creds);
    expect(result.verdict).toBe("block");
    expect(result.origin?.origin).toBe("user-jean/Writer");
    expect(result.output).toMatch(/DENIED \(classification\)/);
    expect(result.output).toMatch(/user-jean\/Writer/);
    expect(result.output).not.toContain(FAKE_JWT);
  });

  it("lets confidential (grant-scoped) content reach the owner's chat at the default threshold", async () => {
    const store = await tempStore();
    const notes = "the quarterly roadmap says ship the identity gateway before demo day arrives";
    fingerprint(store, "screen-2", label, notes);
    const result = screenOutput("screen-2", "Summary of Writer's notes: " + notes);
    expect(result.verdict).toBe("allow");
    expect(result.output).toBe("Summary of Writer's notes: " + notes);
  });

  it("blocks confidential copied-through content when the operator lowers the threshold", async () => {
    const store = await tempStore();
    const notes = "the quarterly roadmap says ship the identity gateway before demo day arrives";
    fingerprint(store, "screen-3", label, notes);
    const result = screenOutput("screen-3", notes, "internal");
    expect(result.verdict).toBe("block");
    expect(result.origin?.grantId).toBe("g-1");
  });

  it("scrubs a verbatim secret with no tagged read behind it, keeping the rest", () => {
    const result = screenOutput("screen-untagged", "All done. For reference the key was " + FAKE_JWT + " as configured.");
    expect(result.verdict).toBe("redact");
    expect(result.output).not.toContain(FAKE_JWT);
    expect(result.output).toContain("[redacted]");
    expect(result.output).toContain("All done.");
    expect(result.output).toMatch(/1 secret-level value/);
  });

  it("passes benign output through byte-identical", () => {
    const output = "I summarised the roadmap and wrote it to summary.md.";
    const result = screenOutput("screen-benign", output);
    expect(result).toMatchObject({ verdict: "allow", origin: null, output });
  });
});

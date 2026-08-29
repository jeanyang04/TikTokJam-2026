import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint, loadFingerprints, matchOrigin } from "./ifc.js";
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

const label: Label = { grantId: "g-1", origin: "user-jean/Writer", egress: ["internal"] };

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
});

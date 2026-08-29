import { createHash } from "node:crypto";
import type { JsonStore } from "./store.js";
import type { Egress, Label } from "./types.js";

/** Level A (sound): every taint the run holds must permit the destination class. */
export function checkEgress(taints: Label[], destination: Egress): Label | null {
  return taints.find((t) => !t.egress.includes(destination)) ?? null;
}

export async function addTaint(store: JsonStore, jti: string, label: Label): Promise<void> {
  await store.mutate((d) => {
    const token = d.runTokens.find((t) => t.jti === jti);
    if (!token) return;
    if (!token.taints.some((t) => t.grantId === label.grantId)) token.taints.push(label);
  });
}

// Level B (explanatory): name the origin of copied-through content.
//
// `index` is an in-memory hot cache so matchOrigin() — called synchronously
// on every egress check, mid tool-call — never has to await a store read.
// Persistence (B3) piggybacks on top of it rather than replacing it:
// fingerprint() writes through to the JsonStore (hashes + label only, never
// the raw content that produced them) so a server restart mid-demo doesn't
// silently drop Scene 2's provenance data, and loadFingerprints() rehydrates
// this cache from the store once at startup, before any request reaches the
// gateway.
const index = new Map<string, { label: Label; hashes: Set<string> }[]>();

function shingles(text: string): string[] {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const out: string[] = [];
  for (let i = 0; i + 6 <= words.length; i++) {
    out.push(createHash("sha1").update(words.slice(i, i + 6).join(" ")).digest("hex").slice(0, 16));
  }
  if (out.length === 0 && text.trim().length >= 12) out.push(createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 16));
  return out;
}

/** Call once at startup, before the gateway accepts requests. */
export function loadFingerprints(store: JsonStore): void {
  index.clear();
  for (const entry of store.snapshot().fingerprints) {
    const list = index.get(entry.runId) ?? [];
    list.push({ label: entry.label, hashes: new Set(entry.hashes) });
    index.set(entry.runId, list);
  }
}

export function fingerprint(store: JsonStore, runId: string, label: Label, content: string): void {
  const hashes = shingles(content);
  const list = index.get(runId) ?? [];
  list.push({ label, hashes: new Set(hashes) });
  index.set(runId, list);

  // Fire-and-forget: JsonStore.mutate() queues and persists atomically on
  // its own, so this doesn't need to block the tool call that triggered it.
  // A failed write here degrades to "this one read has no persisted
  // provenance if the server restarts" — never to a blocked or corrupted
  // tool call, and never to the hot cache above disagreeing with it, since
  // the cache was already updated synchronously either way.
  void store.mutate((d) => {
    d.fingerprints.push({ runId, label, hashes });
  }).catch(() => {});
}

export function matchOrigin(runId: string, payload: string): Label | null {
  const list = index.get(runId);
  if (!list) return null;
  const probe = shingles(payload);
  for (const entry of list) if (probe.some((h) => entry.hashes.has(h))) return entry.label;
  return null;
}

export function clearFingerprints(store: JsonStore, runId: string): void {
  index.delete(runId);
  void store.mutate((d) => {
    d.fingerprints = d.fingerprints.filter((f) => f.runId !== runId);
  }).catch(() => {});
}

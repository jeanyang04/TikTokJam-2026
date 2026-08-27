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
// ponytail: in-memory shingle index keyed by run; B3 may replace with a persistent one.
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

export function fingerprint(runId: string, label: Label, content: string): void {
  const list = index.get(runId) ?? [];
  list.push({ label, hashes: new Set(shingles(content)) });
  index.set(runId, list);
}

export function matchOrigin(runId: string, payload: string): Label | null {
  const list = index.get(runId);
  if (!list) return null;
  const probe = shingles(payload);
  for (const entry of list) if (probe.some((h) => entry.hashes.has(h))) return entry.label;
  return null;
}

export function clearFingerprints(runId: string): void {
  index.delete(runId);
}

import { createHash } from "node:crypto";
import { detectLevel, levelRank, maxLevel, scrubSecrets } from "./classify.js";
import type { JsonStore } from "./store.js";
import type { Egress, Label, SecurityLevel } from "./types.js";

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
    // Rows persisted before Label.level existed lack the field at runtime
    // (the type can't say so); they default to "internal".
    list.push({ label: { ...entry.label, level: entry.label.level ?? "internal" }, hashes: new Set(entry.hashes) });
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
  // Highest-level match wins, so the output screen (and a deny message) names
  // the most sensitive origin when several reads left prints in the payload.
  let best: Label | null = null;
  for (const entry of list) {
    if (!probe.some((h) => entry.hashes.has(h))) continue;
    if (!best || levelRank(entry.label.level) > levelRank(best.level)) best = entry.label;
  }
  return best;
}

// ---- Output screen: chat output is the third egress surface ----
// Tool calls are gated by checkEgress above; the run's *final output* becomes
// a stored chat message and was previously never checked, so a prompt-injected
// agent could simply print what it may not send. `screenOutput` runs after the
// Codex output lands (agent-service.ts's executeRun) and before it persists.

export interface ScreenResult {
  verdict: "allow" | "redact" | "block";
  /** Highest level of evidence found in the output. */
  level: SecurityLevel;
  /** The classified read the output copies through, when that is the trigger. */
  origin: Label | null;
  /** What to persist as the run output / assistant message. */
  output: string;
}

/**
 * Synchronous on the fingerprint hot cache, like matchOrigin — the caller
 * writes the RunEvent. `outputMaxLevel` is the highest level allowed through
 * untouched; the default lets confidential (grant-scoped provenance the owner
 * already approved) reach the owner's chat while secrets never do.
 *
 * Copied-through classified content blocks the whole output (it may be
 * paraphrased around the matched windows, so partial removal can't be
 * trusted); a bare detector hit is scrubbed in place and the rest kept.
 */
export function screenOutput(
  runId: string,
  output: string,
  outputMaxLevel: SecurityLevel = "confidential",
): ScreenResult {
  const origin = matchOrigin(runId, output);
  const originLevel: SecurityLevel = origin?.level ?? "public";
  const level = maxLevel(originLevel, detectLevel(output));
  if (levelRank(level) <= levelRank(outputMaxLevel)) {
    return { verdict: "allow", level, origin: null, output };
  }
  if (origin && levelRank(originLevel) > levelRank(outputMaxLevel)) {
    return {
      verdict: "block",
      level,
      origin,
      output:
        `DENIED (classification): output withheld — it carries content originating from ${origin.origin}` +
        ` classified ${originLevel}, above the chat output limit (${outputMaxLevel}).` +
        " The audit timeline has the details.",
    };
  }
  const { output: scrubbed, hits } = scrubSecrets(output);
  return {
    verdict: "redact",
    level,
    origin,
    output: scrubbed + `\n\n[launchpad] ${hits} secret-level value(s) redacted from this output.`,
  };
}

export function clearFingerprints(store: JsonStore, runId: string): void {
  index.delete(runId);
  void store.mutate((d) => {
    d.fingerprints = d.fingerprints.filter((f) => f.runId !== runId);
  }).catch(() => {});
}

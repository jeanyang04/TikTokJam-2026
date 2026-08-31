/**
 * Security-level classification ("info tagging"). Pure functions only — the
 * gateway calls `classify()` when a read happens, and ifc.ts's output screen
 * calls `detectLevel()`/`scrubSecrets()` on the run's final output.
 *
 * Levels mean, in this codebase:
 *   public/internal  — never acted on; internal is the floor for anything read.
 *   confidential     — provenance: grant-scoped or CRM data. Egress rules for
 *                      tool calls stay with taints/checkEgress; the output
 *                      screen only acts on it if the operator lowers
 *                      OUTPUT_MAX_LEVEL below its default.
 *   secret           — credentials-shaped content. Withheld from chat output
 *                      even toward the owner (a chat message is stored,
 *                      screenshotted, pasted — CLAUDE.md rule 4's spirit).
 */
import { SECURITY_LEVELS, type SecurityLevel } from "./types.js";

export const levelRank = (level: SecurityLevel): number => SECURITY_LEVELS.indexOf(level);

export const maxLevel = (a: SecurityLevel, b: SecurityLevel): SecurityLevel =>
  levelRank(a) >= levelRank(b) ? a : b;

/**
 * The same four shapes audit.ts / redact.ts scrub, deliberately a separate
 * list: redaction scrubs the audit trail, classification flags live content.
 * Keep the two in sync when either grows a pattern.
 * No /g flags here — a global regex's lastIndex makes .test() stateful.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]+/,
  /\beyJ[A-Za-z0-9._-]{20,}/,
  /\bep-[a-z0-9-]+/i,
  /ARK_[A-Z_]*=\S+/,
];

/** What the read is, before looking at its content. */
export type ClassifyContext = "own-workspace" | "granted-workspace" | "crm";

const BASE_LEVEL: Record<ClassifyContext, SecurityLevel> = {
  "own-workspace": "internal",
  "granted-workspace": "confidential",
  crm: "confidential",
};

/** Detectors alone — for screening output that had no tagged read behind it. */
export function detectLevel(content: string): SecurityLevel {
  return SECRET_PATTERNS.some((pattern) => pattern.test(content)) ? "secret" : "public";
}

/** Resource default ∨ content detectors, whichever is higher. */
export function classify(context: ClassifyContext, content: string): SecurityLevel {
  return maxLevel(BASE_LEVEL[context], detectLevel(content));
}

/** Replace every detector hit in place; the caller decides what to append. */
export function scrubSecrets(content: string): { output: string; hits: number } {
  let hits = 0;
  let output = content;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(new RegExp(pattern.source, pattern.flags + "g"), () => {
      hits += 1;
      return "[redacted]";
    });
  }
  return { output, hits };
}

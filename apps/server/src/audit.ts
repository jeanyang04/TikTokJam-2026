import { randomUUID } from "node:crypto";
import type { JsonStore } from "./store.js";
import type { RunEvent } from "./types.js";

// ponytail: minimal redaction here; B3's redact.ts replaces it via setRedactor().
const PATTERNS = [/Bearer\s+[A-Za-z0-9._-]+/g, /\beyJ[A-Za-z0-9._-]{20,}/g, /\bep-[a-z0-9-]+/gi, /ARK_[A-Z_]*=\S+/g];
let redactor = (value: unknown): unknown => {
  if (typeof value === "string") {
    let out = value.length > 2048 ? value.slice(0, 2048) + "…" : value;
    for (const p of PATTERNS) out = out.replace(p, "[redacted]");
    return out;
  }
  if (Array.isArray(value)) return value.map(redactor);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactor(v)]));
  }
  return value;
};
export function setRedactor(fn: (value: unknown) => unknown): void {
  redactor = fn;
}
export const redact = (value: unknown): unknown => redactor(value);

export type EventInput = Omit<RunEvent, "id" | "at">;

/** Audit row: human → agent → action → resource → outcome. Always redacted. */
export async function recordEvent(store: JsonStore, event: EventInput): Promise<RunEvent> {
  const row: RunEvent = {
    ...event,
    id: randomUUID(),
    at: new Date().toISOString(),
    detail: redact(event.detail) as Record<string, unknown>,
  };
  await store.mutate((db) => {
    db.runEvents.push(row);
    if (db.runEvents.length > 5000) db.runEvents.splice(0, db.runEvents.length - 5000);
  });
  return row;
}

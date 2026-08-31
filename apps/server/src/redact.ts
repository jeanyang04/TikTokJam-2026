/**
 * Strips secrets from anything written to a RunEvent, before it's persisted
 * or shown in the timeline. Wired in via audit.ts's setRedactor() — this
 * file owns the pattern list and
 * truncation rule; audit.ts's recordEvent() just calls whatever function is
 * installed here.
 */

const PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]+/g,
  /\beyJ[A-Za-z0-9._-]{20,}/g, // JWT — base64url header segment always starts "eyJ"
  /\bep-[a-z0-9-]+/gi, // Ark model endpoint id
  /ARK_[A-Z_]*=\S+/g,
];

const MAX_STRING_LENGTH = 2048;

function redactString(value: string): string {
  let out = value;
  for (const pattern of PATTERNS) out = out.replace(pattern, "[redacted]");
  // Redact BEFORE truncating, not after: truncating first can cut a secret
  // in half at the 2048-char boundary, and a half-secret no longer matches
  // the pattern it should have been caught by — it would ship to the trail
  // instead of a full match getting masked. Doing it in this order means
  // truncation only ever trims content that's already been swept.
  return out.length > MAX_STRING_LENGTH ? out.slice(0, MAX_STRING_LENGTH) + "…" : out;
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redact(v)]));
  }
  return value;
}

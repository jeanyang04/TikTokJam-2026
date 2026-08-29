import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  it("strips a Bearer token", () => {
    expect(redact("Authorization: Bearer abc.def-123_456")).toBe("Authorization: [redacted]");
  });

  it("strips a JWT even without a Bearer prefix", () => {
    expect(redact("session_token: eyJhbGciOiJIUzI1NiJ9.ZmFrZS1kZW1vLWZpeHR1cmU.not-a-real-signature")).toBe(
      "session_token: [redacted]",
    );
  });

  it("strips an Ark endpoint id", () => {
    expect(redact("model=ep-00000000000000-fake0")).toBe("model=[redacted]");
  });

  it("strips an ARK_*=... env assignment", () => {
    expect(redact("export ARK_API_KEY=ark-00000000-0000-0000-0000-000000000000-fake")).toBe(
      "export [redacted]",
    );
  });

  it("redacts inside nested objects and arrays, leaving harmless values alone", () => {
    const input = {
      customer: "Acme Corp",
      headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def" },
      history: ["fine", "ARK_MODEL=ep-should-go-too", 42, null],
    };
    expect(redact(input)).toEqual({
      customer: "Acme Corp",
      headers: { authorization: "[redacted]" },
      history: ["fine", "[redacted]", 42, null],
    });
  });

  it("truncates a long, otherwise-harmless string at 2KB", () => {
    const long = "x".repeat(3000);
    const out = redact(long) as string;
    expect(out.length).toBe(2049); // 2048 chars + the "…" marker
    expect(out.endsWith("…")).toBe(true);
  });

  it("redacts before truncating, so a secret straddling the 2KB cut is still fully caught", () => {
    // The bearer token starts at char 2000 and runs to ~2207 — truncating
    // at 2048 first would slice it mid-token (a partial token no longer
    // matches the pattern, so a fragment would ship unredacted). Because
    // redaction runs first, the whole token is gone before truncation ever
    // looks at the string, and the (now short) result isn't truncated at
    // all — proving the property without truncation trimming the marker.
    const padding = "a".repeat(2000);
    const secret = "Bearer " + "s".repeat(200);
    const out = redact(padding + secret) as string;
    expect(out).not.toMatch(/Bearer s/);
    expect(out).toBe(padding + "[redacted]");
  });

  it("leaves numbers, booleans, and null untouched", () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
  });
});

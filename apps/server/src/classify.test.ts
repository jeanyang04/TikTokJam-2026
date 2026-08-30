import { describe, expect, it } from "vitest";
import { classify, detectLevel, levelRank, maxLevel, scrubSecrets } from "./classify.js";

const FAKE_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIn0.c2ln";

describe("security levels", () => {
  it("orders public < internal < confidential < secret", () => {
    expect(levelRank("public")).toBeLessThan(levelRank("internal"));
    expect(levelRank("internal")).toBeLessThan(levelRank("confidential"));
    expect(levelRank("confidential")).toBeLessThan(levelRank("secret"));
    expect(maxLevel("internal", "secret")).toBe("secret");
    expect(maxLevel("confidential", "internal")).toBe("confidential");
  });
});

describe("classify", () => {
  it("credentials-shaped content is secret in every context", () => {
    const creds = '{"token":"' + FAKE_JWT + '"}';
    expect(classify("own-workspace", creds)).toBe("secret");
    expect(classify("granted-workspace", creds)).toBe("secret");
    expect(classify("crm", creds)).toBe("secret");
  });

  it("plain prose takes the resource default", () => {
    const prose = "the quarterly roadmap says ship the identity gateway before demo day";
    expect(classify("own-workspace", prose)).toBe("internal");
    expect(classify("granted-workspace", prose)).toBe("confidential");
    expect(classify("crm", prose)).toBe("confidential");
  });

  it("detects each of the four secret shapes, and detection is not stateful", () => {
    for (const sample of ["Authorization: Bearer abc.def-123", FAKE_JWT, "endpoint ep-2024-demo", "ARK_API_KEY=sk-xyz"]) {
      // Twice on purpose: a /g regex's lastIndex would make the second call flaky.
      expect(detectLevel(sample)).toBe("secret");
      expect(detectLevel(sample)).toBe("secret");
    }
    expect(detectLevel("nothing sensitive here")).toBe("public");
  });
});

describe("scrubSecrets", () => {
  it("replaces every hit in place and counts them", () => {
    const { output, hits } = scrubSecrets("first " + FAKE_JWT + " then Bearer tok-abc done");
    expect(hits).toBe(2);
    expect(output).not.toContain(FAKE_JWT);
    expect(output).not.toContain("tok-abc");
    expect(output).toBe("first [redacted] then [redacted] done");
  });
});

import { describe, expect, it } from "vitest";
import { MockWebhookSink } from "./webhook-sink.js";

describe("Mock webhook sink", () => {
  it("records an allowed call without making an outbound request", async () => {
    const sink = new MockWebhookSink();
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("network must not be used");
    }) as typeof fetch;

    try {
      await expect(
        sink.send("https://evil.example/hook", "demo payload"),
      ).resolves.toEqual({ status: 202 });
      expect(fetched).toBe(false);
      expect(sink.calls()).toMatchObject([
        { url: "https://evil.example/hook", body: "demo payload" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

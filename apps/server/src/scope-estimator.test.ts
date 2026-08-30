import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  estimateWithArk,
  keywordScopes,
  makeScopeEstimator,
  type FetchLike,
} from "./scope-estimator.js";

const config = loadConfig({
  NODE_ENV: "test",
  ARK_API_KEY: "test-key",
  ARK_MODEL: "ep-test",
});

/** Answers as Ark would, with whatever JSON the test wants back. */
const arkSaying = (raw: string): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => ({ output_text: raw }) });

describe("keyword estimator", () => {
  it("asks for the CRM when the task is about customers", () => {
    expect(keywordScopes("update the CRM note for Acme")).toContain("crm:read");
  });

  it("asks for webhook:send when the task is about sending something out", () => {
    expect(keywordScopes("post the summary to our team webhook")).toContain("webhook:send");
  });

  it("does not ask for webhook:send for a task that only reads a file", () => {
    expect(keywordScopes("summarise notes.md")).not.toContain("webhook:send");
  });

  it("defaults to read-only when nothing matches — never presumes write", () => {
    expect(keywordScopes("hello")).toEqual(["workspace:read"]);
  });
});

describe("Ark estimator", () => {
  it("takes a well-formed answer", async () => {
    const scopes = await estimateWithArk(
      config,
      "read the notes",
      arkSaying(JSON.stringify({ scopes: ["workspace:read"] })),
    );
    expect(scopes).toEqual(["workspace:read"]);
  });

  it("refuses a scope the model invented", async () => {
    const scopes = await estimateWithArk(
      config,
      "read the notes",
      arkSaying(JSON.stringify({ scopes: ["workspace:read", "admin:everything"] })),
    );
    expect(scopes).toBeNull();
  });

  it("returns null rather than throwing when Ark is unreachable", async () => {
    const scopes = await estimateWithArk(config, "read the notes", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(scopes).toBeNull();
  });

  it("falls back to the grammar when Ark cannot answer", async () => {
    const estimate = makeScopeEstimator(config, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await estimate("post the summary to our team webhook")).toContain("webhook:send");
  });
});

import { z } from "zod";
import { isArkConfigured, type AppConfig } from "./config.js";
import type { GrantAction } from "./types.js";

/**
 * Plain English to a grant *intent*. Names, not ids: nobody types a uuid, and
 * resolving a name is the caller's own agents' business, so this module never
 * touches the store. `agent-service.ts` resolves and checks ownership, and only
 * then does a card exist.
 *
 * Ark is asked first when it is configured, and the regex grammar is the
 * fallback. Either way the result goes through `intentSchema` before anything
 * downstream sees it: the model's output is untrusted input like any other.
 *
 * **Workspace grants only, and exactly one action.** `crm_read` / `crm_write`
 * in `gateway.ts` are gated on scope alone and never consult `findLiveGrant`,
 * so a PolicyGrant on `crm` would be a row nothing reads: a card that looks
 * like it worked and changes nothing. One action because the card's `action`
 * feeds the dedupe key and the operator's own reading of what they are
 * approving; "read+write" is a string no other card produces.
 */
export interface GrantIntent {
  /** Recipient, as written. */
  toAgent: string;
  /** Agent whose workspace is shared, as written. */
  fromAgent: string;
  resource: "workspace";
  actions: [GrantAction];
}

const intentSchema = z.object({
  toAgent: z.string().trim().min(1).max(64),
  fromAgent: z.string().trim().min(1).max(64),
  resource: z.literal("workspace"),
  actions: z.tuple([z.enum(["read", "write"])]),
});

/** Ark gets this, and its answer is still validated against `intentSchema`. */
const INTENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["toAgent", "fromAgent", "resource", "actions"],
  properties: {
    toAgent: { type: "string", description: "Agent receiving access, as named by the user" },
    fromAgent: { type: "string", description: "Agent whose workspace is being shared" },
    resource: { type: "string", enum: ["workspace"] },
    actions: {
      type: "array",
      items: { type: "string", enum: ["read", "write"] },
      minItems: 1,
      maxItems: 1,
    },
  },
} as const;

const SYSTEM_PROMPT = [
  "Extract one workspace access grant from the user's sentence.",
  "toAgent receives access; fromAgent owns the workspace being shared.",
  "Choose exactly one action, the weaker one if the sentence is ambiguous.",
  "Never invent an agent the sentence does not name.",
].join(" ");

/** `let Researcher read Writer's notes`. The demo grammar. */
const WORKSPACE_GRAMMAR =
  /\blet\s+([\w.-]+)\s+(read|write)\s+([\w.-]+)(?:'s|’s)?\s+(?:notes?|workspace|files?)/i;

export function parseWithGrammar(text: string): GrantIntent | null {
  const match = WORKSPACE_GRAMMAR.exec(text);
  if (!match) return null;
  return {
    toAgent: match[1]!,
    fromAgent: match[3]!,
    resource: "workspace",
    actions: [match[2]!.toLowerCase() as GrantAction],
  };
}

/** Injected in tests. Ark is never called from the suite. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * NOT verified against a live Ark endpoint. What is verified: `llm-proxy.ts`
 * forwards to `${arkBaseUrl}/responses` and `writeCodexConfig` sets
 * `wire_api = "responses"`, so this follows the one convention the repo already
 * uses rather than introducing a second. If Ark rejects the shape, every caller
 * still lands on `parseWithGrammar`, which is why this returns null instead of
 * throwing.
 */
export async function parseWithArk(
  config: AppConfig,
  text: string,
  fetchImpl: FetchLike,
): Promise<GrantIntent | null> {
  try {
    const response = await fetchImpl(config.arkBaseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer " + config.arkApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.arkModel,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "grant_intent",
            strict: true,
            schema: INTENT_JSON_SCHEMA,
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
      output_text?: string;
    };
    const raw = body.output_text ?? body.output?.[0]?.content?.[0]?.text;
    if (!raw) return null;
    const parsed = intentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // A refused connection, a timeout, malformed JSON, a schema the model
    // ignored: all the same answer, because the grammar still has a go.
    return null;
  }
}

export async function parseGrantIntent(
  config: AppConfig,
  text: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<GrantIntent | null> {
  if (isArkConfigured(config)) {
    const fromArk = await parseWithArk(config, text, fetchImpl);
    if (fromArk) return fromArk;
  }
  const fromGrammar = parseWithGrammar(text);
  if (!fromGrammar) return null;
  // safeParse, not parse: the grammar's `[\w.-]+` is unbounded and the schema
  // caps a name at 64, so a long one must read as "could not parse" (422)
  // rather than escaping as a ZodError the route turns into a 400.
  const checked = intentSchema.safeParse(fromGrammar);
  return checked.success ? checked.data : null;
}

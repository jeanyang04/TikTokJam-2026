import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { FastifyPluginAsync } from "fastify";
import { recordEvent } from "./audit.js";
import { verifyToken } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { JsonStore } from "./store.js";

export interface LlmProxyDeps {
  config: AppConfig;
  store: JsonStore;
}

/** Optional host-side Ark proxy. The real Ark key never crosses into a runtime. */
export const llmProxyPlugin: FastifyPluginAsync<LlmProxyDeps> = async (
  app,
  { config, store },
) => {
  app.post("/llm/responses", async (request, reply) => {
    const header = request.headers.authorization ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
    const principal = raw
      ? await verifyToken(config, raw, "agent")
      : null;
    if (!principal) {
      return reply.code(401).send({ error: "Invalid agent token" });
    }

    // Authoritative lookup on every model call; never trust the JWT scp snapshot.
    const token = store
      .snapshot()
      .runTokens.find((item) => item.jti === principal.jti);
    const active =
      token &&
      token.agentId === principal.agentId &&
      token.ownerId === principal.ownerId &&
      token.runId === principal.runId &&
      token.revokedAt === null &&
      token.expiresAt > new Date().toISOString();
    if (!active) {
      await recordEvent(store, {
        runId: principal.runId,
        agentId: principal.agentId,
        ownerId: principal.ownerId,
        kind: "llm",
        action: "responses",
        resource: "ark",
        decision: "deny",
        reason: "revoked-or-expired",
        detail: {},
      });
      return reply.code(401).send({ error: "Agent token revoked or expired" });
    }
    if (!config.arkApiKey) {
      return reply.code(503).send({ error: "Ark is not configured" });
    }

    try {
      const upstream = await fetch(config.arkBaseUrl + "/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer " + config.arkApiKey,
          "content-type": "application/json",
          accept: request.headers.accept ?? "text/event-stream, application/json",
        },
        body: JSON.stringify(request.body ?? {}),
      });

      await recordEvent(store, {
        runId: principal.runId,
        agentId: principal.agentId,
        ownerId: principal.ownerId,
        kind: "llm",
        action: "responses",
        resource: "ark",
        decision: upstream.ok ? "allow" : "deny",
        reason: upstream.ok ? null : "upstream-status",
        // Never log prompts, response chunks, headers, or the upstream key.
        detail: { status: upstream.status, usage: null },
      });

      reply.code(upstream.status);
      for (const name of ["content-type", "cache-control"] as const) {
        const value = upstream.headers.get(name);
        if (value) reply.header(name, value);
      }
      if (!upstream.body) return reply.send();
      return reply.send(
        Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>),
      );
    } catch {
      await recordEvent(store, {
        runId: principal.runId,
        agentId: principal.agentId,
        ownerId: principal.ownerId,
        kind: "llm",
        action: "responses",
        resource: "ark",
        decision: "deny",
        reason: "upstream-unavailable",
        detail: {},
      });
      return reply.code(502).send({ error: "Model upstream unavailable" });
    }
  });
};

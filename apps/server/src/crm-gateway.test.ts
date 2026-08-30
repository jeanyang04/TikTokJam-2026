/**
 * Exercises db.ts's real withOwner() through the actual gateway pipeline —
 * not RLS in isolation (rls.test.ts) and not the gateway's other tools with
 * a fake withOwner (gateway.test.ts). This is the one test that proves LOCK
 * 1 (gateway scope/grant checks) and LOCK 2 (Postgres RLS) both hold on the
 * crm_* path end to end, the same way a real Codex tool call would exercise
 * it.
 *
 * Gated on DATABASE_URL_ADMIN/DATABASE_URL_AGENT, same as rls.test.ts, so
 * `npm run check` stays green without Docker (CLAUDE.md rule 1).
 */
import Fastify from "fastify";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./db.js";
import { gatewayPlugin, makeJwtVerifier } from "./gateway.js";
import { DEFAULT_PERMISSIONS, JsonStore } from "./store.js";
import type { Agent, RunToken, Scope } from "./types.js";

const canRun = Boolean(process.env.DATABASE_URL_ADMIN && process.env.DATABASE_URL_AGENT);
const SECRET = "test-secret-at-least-32-bytes-long-ok";
const key = new TextEncoder().encode(SECRET);
const soon = () => new Date(Date.now() + 60_000).toISOString();

async function sign(claims: Record<string, unknown>) {
  return new SignJWT({ ...claims, typ: "agent" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(key);
}

function agent(id: string, ownerId: string, tools: Scope[], root: string): Agent {
  const t = new Date().toISOString();
  return {
    id,
    name: id,
    description: "",
    instructions: "",
    ownerId,
    permissions: { ...DEFAULT_PERMISSIONS, tools },
    tempScopes: [],
    status: "ready",
    workspacePath: path.join(root, id),
    codexThreadId: null,
    lastError: null,
    createdAt: t,
    updatedAt: t,
  };
}

function token(jti: string, agentId: string, ownerId: string, scp: Scope[]): RunToken {
  return {
    jti,
    runId: "run-" + jti,
    agentId,
    ownerId,
    scp,
    taints: [],
    egressAllow: [],
    issuedAt: new Date().toISOString(),
    expiresAt: soon(),
    revokedAt: null,
  };
}

describe.skipIf(!canRun)("gateway crm_read/crm_write — real Postgres withOwner", () => {
  let app: ReturnType<typeof Fastify>;
  let store: JsonStore;
  let db: Db;

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    db ??= createDb({
      databaseUrlAdmin: process.env.DATABASE_URL_ADMIN,
      databaseUrlAgent: process.env.DATABASE_URL_AGENT,
    })!;

    const root = await mkdtemp(path.join(os.tmpdir(), "gw-crm-"));
    store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    await store.mutate((d) => {
      d.agents.push(agent("jean-agent", "user-jean", ["crm:read", "crm:write"], root));
      d.agents.push(agent("alex-agent", "user-alex", ["crm:read", "crm:write"], root));
      d.runTokens.push(token("t-jean", "jean-agent", "user-jean", ["crm:read", "crm:write"]));
      d.runTokens.push(token("t-alex", "alex-agent", "user-alex", ["crm:read", "crm:write"]));
    });
    app = Fastify();
    await app.register(gatewayPlugin, {
      store,
      workspaceRoot: root,
      verifyAgentToken: makeJwtVerifier(SECRET),
      withOwner: db.withOwner,
    });
  });

  async function call(jwt: string, tool: string, args: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + jwt,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
    });
    const body = res.json() as { result?: { content: { text: string }[]; isError?: boolean } };
    return { isError: body.result?.isError ?? false, text: body.result?.content[0]?.text ?? "" };
  }

  it("Jean's agent writes then reads back a CRM note through the real gateway + Postgres", async () => {
    const jwt = await sign({ sub: "jean-agent", own: "user-jean", run: "run-t-jean", jti: "t-jean", scp: ["crm:read", "crm:write"] });
    const customer = "E2E-" + randomUUID().slice(0, 8);

    const write = await call(jwt, "crm_write", { customer, note: "written through the real gateway" });
    expect(write.isError).toBe(false);

    const read = await call(jwt, "crm_read", { customer });
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.text)).toMatchObject([
      { owner_id: "user-jean", customer, note: "written through the real gateway" },
    ]);
  });

  it("Alex's agent cannot see the row Jean's agent just wrote — LOCK 2 holds even though LOCK 1's scope check passes for both", async () => {
    const jeanJwt = await sign({ sub: "jean-agent", own: "user-jean", run: "run-t-jean", jti: "t-jean", scp: ["crm:read", "crm:write"] });
    const alexJwt = await sign({ sub: "alex-agent", own: "user-alex", run: "run-t-alex", jti: "t-alex", scp: ["crm:read", "crm:write"] });
    const customer = "E2E-" + randomUUID().slice(0, 8);

    await call(jeanJwt, "crm_write", { customer, note: "jean's private note" });

    const alexRead = await call(alexJwt, "crm_read", { customer });
    expect(alexRead.isError).toBe(false);
    expect(JSON.parse(alexRead.text)).toEqual([]);
  });
});

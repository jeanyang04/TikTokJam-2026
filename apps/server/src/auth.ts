import { SignJWT, jwtVerify } from "jose";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";

const ALGORITHM = "HS256";
const HUMAN_TOKEN_LIFETIME = "8h";

export type PrincipalType = "human" | "agent";

export interface HumanPrincipal {
  typ: "human";
  userId: string;
}

export interface AgentPrincipal {
  typ: "agent";
  agentId: string;
  ownerId: string;
  runId: string;
  jti: string;
  /** TODO: narrow to Scope[] once Zeon's types.ts lands. */
  scp: string[];
}

export type Principal = HumanPrincipal | AgentPrincipal;

export interface AgentClaimsInput {
  sub: string;
  own: string;
  run: string;
  jti: string;
  scp: string[];
  expiresInSeconds: number;
}

const loginBody = z.object({ userId: z.string().trim().min(1).max(128) });

const humanClaims = z.object({
  sub: z.string().min(1),
  typ: z.literal("human"),
});

const agentClaims = z.object({
  sub: z.string().min(1),
  typ: z.literal("agent"),
  own: z.string().min(1),
  run: z.string().min(1),
  jti: z.string().min(1),
  scp: z.array(z.string()),
});

/**
 * Routes under `/api/` that never carry a human JWT: liveness and the login
 * exchange itself. The machine-to-machine surfaces (`/mcp`, `/llm`, `/gw`,
 * `/demo`) are outside `/api/` by construction and authenticate agent tokens
 * themselves, so this gate never sees them.
 */
const OPEN_PATHS = new Set(["/api/health", "/api/auth/login"]);

export interface SeedUser {
  id: string;
  name: string;
}

/** Parses the `SEED_USERS` env format: `id:Display Name` pairs, comma separated. */
export function parseSeedUsers(raw: string): SeedUser[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf(":");
      const id = (separator === -1 ? entry : entry.slice(0, separator)).trim();
      const name = (separator === -1 ? entry : entry.slice(separator + 1)).trim();
      return { id, name: name || id };
    })
    .filter((user) => user.id.length > 0);
}

function secretFor(config: AppConfig): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

export async function signHuman(
  config: AppConfig,
  userId: string,
): Promise<string> {
  return new SignJWT({ typ: "human" })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(HUMAN_TOKEN_LIFETIME)
    .sign(secretFor(config));
}

export async function signAgent(
  config: AppConfig,
  claims: AgentClaimsInput,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({
    typ: "agent",
    own: claims.own,
    run: claims.run,
    scp: claims.scp,
  })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + claims.expiresInSeconds)
    .sign(secretFor(config));
}

/**
 * Verifies a raw JWT and asserts its principal type. Returns null on any
 * failure: bad signature, expiry, malformed claims, or a type mismatch. That
 * last case is why the type is an argument rather than something read off the
 * token, so callers cannot accidentally treat an agent token as a human one.
 */
export async function verifyToken(
  config: AppConfig,
  raw: string,
  typ: "human",
): Promise<HumanPrincipal | null>;
export async function verifyToken(
  config: AppConfig,
  raw: string,
  typ: "agent",
): Promise<AgentPrincipal | null>;
export async function verifyToken(
  config: AppConfig,
  raw: string,
  typ: PrincipalType,
): Promise<Principal | null> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(raw, secretFor(config), {
      algorithms: [ALGORITHM],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typ === "human") {
    const parsed = humanClaims.safeParse(payload);
    if (!parsed.success) {
      return null;
    }
    return { typ: "human", userId: parsed.data.sub };
  }

  const parsed = agentClaims.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return {
    typ: "agent",
    agentId: parsed.data.sub,
    ownerId: parsed.data.own,
    runId: parsed.data.run,
    jti: parsed.data.jti,
    scp: parsed.data.scp,
  };
}

function bearerFrom(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function pathnameOf(url: string): string {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function requiresHumanToken(url: string): boolean {
  const pathname = pathnameOf(url);
  return pathname.startsWith("/api/") && !OPEN_PATHS.has(pathname);
}

/**
 * Registers the login exchange and the human JWT gate. Every `/api/*` route
 * other than health and login requires a valid human token; the verified
 * principal is attached to the request for downstream ownership checks.
 */
export function registerAuth(app: FastifyInstance, config: AppConfig): void {
  const seedUsers = new Map(
    parseSeedUsers(config.seedUsers).map((user) => [user.id, user]),
  );

  app.addHook("onRequest", async (request, reply) => {
    if (!requiresHumanToken(request.url)) {
      return;
    }
    const principal = await verifyToken(config, bearerFrom(request), "human");
    if (!principal) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    request.principal = principal;
  });

  app.post("/api/auth/login", async (request, reply) => {
    const { userId } = loginBody.parse(request.body);
    const user = seedUsers.get(userId);
    if (!user) {
      return reply.code(401).send({ error: "Unknown user" });
    }
    const token = await signHuman(config, user.id);
    return { token, user };
  });
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: HumanPrincipal;
  }
}

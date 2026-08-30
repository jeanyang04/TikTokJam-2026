import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, AgentPermissions, Database, Scope } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
  runTokens: [],
  policyGrants: [],
  approvals: [],
  runEvents: [],
  fingerprints: [],
});

/** Scopes a new RunToken should carry: permanent tools ∪ unexpired temp scopes. B1 calls this when minting. */
export function effectiveScopes(agent: Pick<Agent, "permissions" | "tempScopes">, at = new Date().toISOString()): Scope[] {
  const live = agent.tempScopes.filter((t) => t.expiresAt > at).map((t) => t.scope);
  return [...new Set([...agent.permissions.tools, ...live])];
}

export const DEFAULT_PERMISSIONS: AgentPermissions = {
  sandbox: "workspace-write",
  network: true,
  webSearch: false,
  tools: [],
};

/** v1 (starter kit) → v2: existing agents belong to the first seeded user, no tool scopes. */
export function migrateDatabase(raw: unknown, defaultOwner = "user-jean"): Database {
  const parsed = raw as Omit<Partial<Database>, "version"> & { version?: number };
  if (!Array.isArray(parsed.agents)) throw new Error("Unsupported database format");
  if (parsed.version !== 1 && parsed.version !== 2) throw new Error("Unsupported database format");
  return {
    ...emptyDatabase(),
    ...parsed,
    version: 2,
    // `egressAllow` postdates the first v2 files. The type says `string[]`, and
    // `approvals.ts` pushes into it, so a row loaded without the key would
    // throw on the first "Allow for this run" of a declassify card.
    runTokens: (parsed.runTokens ?? []).map((token) => ({
      ...token,
      egressAllow: token.egressAllow ?? [],
      // A taint written before `trust` existed defaults to "untrusted": the
      // safe direction, since the check it feeds refuses an outbound action.
      taints: (token.taints ?? []).map((taint) => ({ ...taint, trust: taint.trust ?? "untrusted" })),
    })),
    // Undefined is already falsy is already untrusted, but the type would be
    // lying about a field `gateway.ts` reads on every borrowed read.
    policyGrants: (parsed.policyGrants ?? []).map((grant) => ({
      ...grant,
      trustContent: grant.trustContent ?? false,
    })),
    agents: parsed.agents.map((agent) => ({
      ...agent,
      ownerId: agent.ownerId ?? defaultOwner,
      permissions: { ...DEFAULT_PERMISSIONS, ...(agent.permissions ?? {}) },
      tempScopes: agent.tempScopes ?? [],
    })),
  };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = migrateDatabase(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

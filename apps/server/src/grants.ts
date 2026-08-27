import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { JsonStore } from "./store.js";
import type { GrantAction, PolicyGrant, Resource } from "./types.js";
import { recordEvent } from "./audit.js";

export interface GrantInput {
  fromAgent: string | null; // null = owner's CRM
  toAgent: string;
  resource: Resource;
  actions: GrantAction[];
  egress?: PolicyGrant["egress"] | undefined;
  expiresAt?: string | null | undefined;
}

const now = () => new Date().toISOString();

export function isLive(grant: PolicyGrant, at = now()): boolean {
  return grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > at);
}

/** Intra-tenant only (D7): both agents must belong to `byOwner`. */
export async function createGrant(store: JsonStore, input: GrantInput, byOwner: string): Promise<PolicyGrant> {
  const db = store.snapshot();
  const to = db.agents.find((a) => a.id === input.toAgent);
  if (!to) throw new HttpError(404, "Agent not found");
  if (to.ownerId !== byOwner) throw new HttpError(403, "Agent belongs to another tenant");
  if (input.fromAgent !== null) {
    const from = db.agents.find((a) => a.id === input.fromAgent);
    if (!from) throw new HttpError(404, "Source agent not found");
    if (from.ownerId !== byOwner) throw new HttpError(400, "Grants are intra-tenant only");
  }
  const grant: PolicyGrant = {
    id: randomUUID(),
    fromOwner: byOwner,
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    resource: input.resource,
    actions: input.actions,
    egress: input.egress ?? ["internal"],
    createdAt: now(),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
  };
  await store.mutate((d) => d.policyGrants.push(grant));
  await recordEvent(store, {
    runId: null, agentId: grant.toAgent, ownerId: byOwner, kind: "grant",
    action: "grant:" + grant.actions.join("+"), resource: (grant.fromAgent ?? byOwner) + "/" + grant.resource,
    decision: "allow", reason: null, detail: { grantId: grant.id, egress: grant.egress, expiresAt: grant.expiresAt },
  });
  return grant;
}

/** Revocation narrows, never widens (D9): the grant's taints lose all egress. */
export async function revokeGrant(store: JsonStore, grantId: string, byOwner: string): Promise<PolicyGrant> {
  const revoked = await store.mutate((d) => {
    const grant = d.policyGrants.find((g) => g.id === grantId);
    if (!grant) throw new HttpError(404, "Grant not found");
    if (grant.fromOwner !== byOwner) throw new HttpError(403, "Grant belongs to another tenant");
    if (grant.revokedAt === null) grant.revokedAt = now();
    for (const token of d.runTokens) {
      for (const taint of token.taints) if (taint.grantId === grantId) taint.egress = [];
    }
    return structuredClone(grant);
  });
  await recordEvent(store, {
    runId: null, agentId: revoked.toAgent, ownerId: byOwner, kind: "grant", action: "revoke",
    resource: (revoked.fromAgent ?? byOwner) + "/" + revoked.resource, decision: "deny",
    reason: "revoked-by-operator", detail: { grantId },
  });
  return revoked;
}

export function findLiveGrant(
  store: JsonStore,
  query: { fromOwner: string; fromAgent: string | null; toAgent: string; resource: Resource; action: GrantAction },
): PolicyGrant | null {
  // Never cached: read the store on every call (CLAUDE.md rule 2).
  return (
    store.snapshot().policyGrants.find(
      (g) =>
        isLive(g) &&
        g.fromOwner === query.fromOwner &&
        g.fromAgent === query.fromAgent &&
        g.toAgent === query.toAgent &&
        g.resource === query.resource &&
        g.actions.includes(query.action),
    ) ?? null
  );
}

export function listGrants(store: JsonStore, agentId: string): PolicyGrant[] {
  return store.snapshot().policyGrants.filter((g) => g.toAgent === agentId || g.fromAgent === agentId);
}

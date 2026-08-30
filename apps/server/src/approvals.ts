import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { JsonStore } from "./store.js";
import type { ApprovalDecision, ApprovalRequest, Egress } from "./types.js";
import { recordEvent } from "./audit.js";
import { createGrant, OWN_CRM_LABEL } from "./grants.js";

export type CardInput = Omit<ApprovalRequest, "id" | "status" | "createdAt" | "decidedAt" | "decidedBy">;

/** Gateway calls this on every deny. One pending card per (agent, kind, resource, action). */
export async function createCardOnDeny(store: JsonStore, input: CardInput): Promise<ApprovalRequest> {
  return store.mutate((d) => {
    const existing = d.approvals.find(
      (c) => c.status === "pending" && c.agentId === input.agentId && c.kind === input.kind &&
        c.resource === input.resource && c.action === input.action,
    );
    if (existing) return structuredClone(existing);
    const card: ApprovalRequest = {
      ...input, id: randomUUID(), status: "pending", createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
    };
    d.approvals.push(card);
    return structuredClone(card);
  });
}

export function listApprovals(store: JsonStore, ownerId: string): ApprovalRequest[] {
  return store.snapshot().approvals.filter((c) => c.ownerId === ownerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Allow for this run  → RunToken.scp widened / grant with run expiry / taint egress widened for this run.
 * Always allow        → Agent.permissions.tools widened / permanent grant / grant egress widened.
 * Deny                → logged, nothing changes.
 */
export async function decideApproval(
  store: JsonStore, cardId: string, decision: ApprovalDecision, byOwner: string,
  /** From the card's "trust content from this source" checkbox. Omitted = false. */
  options: { trustContent?: boolean | undefined } = {},
): Promise<ApprovalRequest> {
  const card = store.snapshot().approvals.find((c) => c.id === cardId);
  if (!card) throw new HttpError(404, "Approval not found");
  if (card.ownerId !== byOwner) throw new HttpError(403, "Approval belongs to another tenant");
  if (card.status !== "pending") throw new HttpError(409, "Approval already decided");

  if (decision !== "deny") {
    const forRun = decision === "allow_run";
    if (card.kind === "scope" && card.scope) {
      const scope = card.scope;
      await store.mutate((d) => {
        const token = d.runTokens.find((t) => t.jti === card.jti);
        if (token && !token.scp.includes(scope)) token.scp.push(scope);
        const agent = d.agents.find((a) => a.id === card.agentId);
        if (!agent) return;
        if (forRun) {
          // Follow-up messages are new runs (D3): keep the scope alive for the current run window.
          const expiresAt = token?.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString();
          agent.tempScopes = agent.tempScopes.filter((t) => t.scope !== scope).concat({ scope, expiresAt });
        } else if (!agent.permissions.tools.includes(scope)) {
          agent.permissions.tools.push(scope);
        }
      });
    }
    if (card.kind === "grant" && card.grant) {
      const token = store.snapshot().runTokens.find((t) => t.jti === card.jti);
      // trustContent is the human's answer to "may the agent act on what it
      // reads here", asked on the card itself. Default false either way.
      await createGrant(store, {
        ...card.grant,
        trustContent: options.trustContent ?? false,
        expiresAt: forRun ? (token?.expiresAt ?? null) : null,
      }, byOwner);
    }
    // The two buttons mean genuinely different things here, and that is the point.
    // "Allow for this run" approves the destination the human actually looked at
    // — this URL, this workspace — and nothing else; widening the class would let
    // the same run reach an attacker's URL on the strength of an approval for the
    // team webhook. "Always allow" is the human making a deliberate standing
    // policy statement, so it widens the grant's egress class as it always did.
    if (card.kind === "declassify") {
      const dest = card.action as Egress;
      // `gateway.ts` writes one of two prefixes: `grant:` for a confidentiality
      // deny, `integrity:` for content the run may not believe. Approving means
      // different things, so they are read apart.
      const integrity = card.reason.startsWith("integrity:");
      const grantId = card.reason.includes(":") ? card.reason.slice(card.reason.indexOf(":") + 1) : null;
      // The owner's own CRM has no grant row to widen, because reading it never
      // needed one. "Always allow" therefore *creates* the tenant-level grant
      // (`fromAgent: null`) that later reads pick their egress up from, which is
      // what makes this button mean something durable rather than acting like
      // the narrower one. Outside the mutate below: createGrant mutates itself.
      if (!forRun && !integrity && grantId === OWN_CRM_LABEL) {
        await createGrant(store, {
          fromAgent: null,
          toAgent: card.agentId,
          resource: "crm",
          actions: ["read"],
          egress: [...new Set<Egress>(["internal", dest])],
        }, byOwner);
      }
      await store.mutate((d) => {
        const token = d.runTokens.find((t) => t.jti === card.jti);
        if (forRun) {
          // Either way, the human approved *this* destination for *this* run.
          // `egressGate` short-circuits on it before both checks.
          if (token && !token.egressAllow.includes(card.resource)) token.egressAllow.push(card.resource);
          return;
        }
        if (integrity) {
          // A standing statement about the source: content from this grant may
          // be believed from now on, and this run stops being held back by it.
          const g = d.policyGrants.find((x) => x.id === grantId);
          if (g) g.trustContent = true;
          for (const t of token?.taints ?? []) if (t.grantId === grantId) t.trust = "trusted";
          return;
        }
        for (const t of token?.taints ?? []) if (t.grantId === grantId && !t.egress.includes(dest)) t.egress.push(dest);
        const g = d.policyGrants.find((x) => x.id === grantId);
        if (g && !g.egress.includes(dest)) g.egress.push(dest);
      });
    }
  }

  const decided = await store.mutate((d) => {
    const c = d.approvals.find((x) => x.id === cardId)!;
    c.status = decision; c.decidedAt = new Date().toISOString(); c.decidedBy = byOwner;
    return structuredClone(c);
  });
  await recordEvent(store, {
    runId: card.runId, agentId: card.agentId, ownerId: byOwner, kind: "approval",
    action: card.action, resource: card.resource, decision: decision === "deny" ? "deny" : "allow",
    reason: decision, detail: { cardId, kind: card.kind, source: card.source, decidedBy: byOwner },
  });
  return decided;
}

import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { JsonStore } from "./store.js";
import type { ApprovalDecision, ApprovalRequest, Egress } from "./types.js";
import { recordEvent } from "./audit.js";
import { createGrant } from "./grants.js";

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
      await createGrant(store, { ...card.grant, expiresAt: forRun ? (token?.expiresAt ?? null) : null }, byOwner);
    }
    if (card.kind === "declassify") {
      const dest = card.action as Egress;
      const grantId = card.reason.startsWith("grant:") ? card.reason.slice(6) : null;
      await store.mutate((d) => {
        const token = d.runTokens.find((t) => t.jti === card.jti);
        for (const t of token?.taints ?? []) if (t.grantId === grantId && !t.egress.includes(dest)) t.egress.push(dest);
        if (!forRun) {
          const g = d.policyGrants.find((x) => x.id === grantId);
          if (g && !g.egress.includes(dest)) g.egress.push(dest);
        }
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

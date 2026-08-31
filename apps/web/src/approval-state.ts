import type { ApprovalRequest } from "./types";

/** Pending requests are unresolved UI state; policy-event polling must not replace it. */
export function pendingApprovalsForAgent(
  approvals: readonly ApprovalRequest[],
  agentId: string | null,
): ApprovalRequest[] {
  if (!agentId) return [];
  return approvals
    .filter((approval) => approval.agentId === agentId && approval.status === "pending")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

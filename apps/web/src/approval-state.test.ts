import { describe, expect, it } from "vitest";
import { pendingApprovalsForAgent } from "./approval-state";
import type { ApprovalRequest } from "./types";

function approval(
  id: string,
  agentId: string,
  status: ApprovalRequest["status"],
  createdAt: string,
): ApprovalRequest {
  return {
    id,
    source: "live_deny",
    kind: "scope",
    agentId,
    ownerId: "user-jean",
    runId: "run-1",
    jti: "token-1",
    resource: "Writer/workspace",
    action: "read",
    scope: "workspace:read",
    grant: null,
    reason: "missing scope",
    status,
    createdAt,
    decidedAt: status === "pending" ? null : createdAt,
    decidedBy: status === "pending" ? null : "user-jean",
  };
}

describe("pendingApprovalsForAgent", () => {
  it("keeps unresolved requests visible and removes them only after a decision", () => {
    const pending = approval("approval-1", "agent-1", "pending", "2026-01-01T00:00:00.000Z");

    expect(pendingApprovalsForAgent([pending], "agent-1")).toEqual([pending]);

    const decided = { ...pending, status: "allow_run" as const };
    expect(pendingApprovalsForAgent([decided], "agent-1")).toEqual([]);
  });

  it("shows only the selected agent's pending requests, newest first", () => {
    const older = approval("older", "agent-1", "pending", "2026-01-01T00:00:00.000Z");
    const newer = approval("newer", "agent-1", "pending", "2026-01-01T00:00:01.000Z");
    const otherAgent = approval("other", "agent-2", "pending", "2026-01-01T00:00:02.000Z");

    expect(pendingApprovalsForAgent([older, otherAgent, newer], "agent-1")).toEqual([
      newer,
      older,
    ]);
  });
});

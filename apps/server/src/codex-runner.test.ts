import { describe, expect, it } from "vitest";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
      "http://127.0.0.1:3000",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
      "http://127.0.0.1:3000",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("projects only the Agent's permissions and token into Codex config", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "read the workspace",
        threadId: null,
        token: "agent.jwt.token",
        permissions: {
          sandbox: "read-only",
          network: false,
          webSearch: false,
          tools: ["workspace:read"],
        },
      },
      "workspace-write",
      "http://127.0.0.1:3000",
    );

    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      'web_search="disabled"',
      "-c",
      'mcp_servers.launchpad.url="http://127.0.0.1:3000/mcp"',
      "-c",
      'mcp_servers.launchpad.http_headers={Authorization="Bearer agent.jwt.token"}',
      "-c",
      'mcp_servers.launchpad.enabled_tools=["workspace_read"]',
      "read the workspace",
    ]);
    const enabledTools = args.find((arg) =>
      arg.startsWith("mcp_servers.launchpad.enabled_tools="),
    );
    expect(enabledTools).not.toContain('"workspace_write"');
    expect(enabledTools).not.toContain('"webhook_send"');
  });

  it("does not let a migrated permission widen a globally read-only sandbox", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "inspect only",
        threadId: null,
        permissions: {
          sandbox: "workspace-write",
          network: false,
          webSearch: false,
          tools: [],
        },
      },
      "read-only",
      "http://127.0.0.1:3000",
    );

    expect(args).toContain("read-only");
    expect(args).not.toContain("workspace-write");
    expect(args).toContain('sandbox_mode="read-only"');
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("emits command, file and MCP trace events without payload bodies", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    const events: Array<{ kind: string; detail: Record<string, unknown> }> = [];
    const emit = (event: {
      kind: "command" | "file_change" | "mcp_call";
      detail: Record<string, unknown>;
    }) => events.push(event);

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npm test",
          status: "completed",
          exit_code: 0,
          aggregated_output: "secret output",
        },
      }),
      parsed,
      emit,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "file_change",
          status: "completed",
          changes: [{ path: "src/a.ts", kind: "update" }],
        },
      }),
      parsed,
      emit,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "launchpad",
          tool: "workspace_read",
          status: "completed",
          arguments: { body: "secret" },
          result: "secret",
        },
      }),
      parsed,
      emit,
    );

    expect(events.map((event) => event.kind)).toEqual([
      "command",
      "file_change",
      "mcp_call",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(events[2]?.detail).toEqual({
      server: "launchpad",
      tool: "workspace_read",
      status: "completed",
      hasError: false,
    });
  });
});

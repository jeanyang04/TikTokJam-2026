import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
  Scope,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

const SCOPE_TO_TOOL: Record<Scope, string> = {
  "workspace:read": "workspace_read",
  "workspace:write": "workspace_write",
  "crm:read": "crm_read",
  "crm:write": "crm_write",
  "webhook:send": "webhook_send",
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return "[" + values.map(tomlString).join(",") + "]";
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  gatewayUrl: string,
  workspacePath = request.workspacePath,
): string[] {
  const effectiveSandbox = request.permissions?.sandbox ?? sandboxMode;
  const args = [
    "exec",
    "--json",
    "--sandbox",
    effectiveSandbox,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];

  if (request.permissions) {
    args.push(
      "-c",
      "sandbox_mode=" + tomlString(request.permissions.sandbox),
      "-c",
      "sandbox_workspace_write.network_access=" + request.permissions.network,
      "-c",
      "web_search=" + tomlString(request.permissions.webSearch ? "live" : "disabled"),
    );
  }

  if (request.token) {
    const enabledTools = (request.permissions?.tools ?? []).map(
      (scope) => SCOPE_TO_TOOL[scope],
    );
    args.push(
      "-c",
      "mcp_servers.launchpad.url=" + tomlString(gatewayUrl.replace(/\/+$/, "") + "/mcp"),
      "-c",
      "mcp_servers.launchpad.http_headers={Authorization=" +
        tomlString("Bearer " + request.token) +
        "}",
      "-c",
      "mcp_servers.launchpad.enabled_tools=" + tomlStringArray(enabledTools),
    );
  }

  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export interface CodexTraceEvent {
  kind: "command" | "file_change" | "mcp_call";
  action: string;
  resource: string;
  detail: Record<string, unknown>;
}

function traceItem(item: Record<string, unknown>): CodexTraceEvent | null {
  if (item.type === "command_execution") {
    return {
      kind: "command",
      action: "execute",
      resource: typeof item.command === "string" ? item.command : "command",
      detail: {
        command: typeof item.command === "string" ? item.command : "",
        status: typeof item.status === "string" ? item.status : null,
        exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
      },
    };
  }
  if (item.type === "file_change") {
    const changes = Array.isArray(item.changes)
      ? item.changes.map((change) => {
          if (!change || typeof change !== "object") return { path: "", kind: null };
          const value = change as Record<string, unknown>;
          return {
            path: typeof value.path === "string" ? value.path : "",
            kind: typeof value.kind === "string" ? value.kind : null,
          };
        })
      : [];
    return {
      kind: "file_change",
      action: "change",
      resource: changes.map((change) => change.path).filter(Boolean).join(", ") || "workspace",
      detail: { changes, status: typeof item.status === "string" ? item.status : null },
    };
  }
  if (item.type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "unknown";
    const tool = typeof item.tool === "string" ? item.tool : "unknown";
    return {
      kind: "mcp_call",
      action: tool,
      resource: server,
      detail: {
        server,
        tool,
        status: typeof item.status === "string" ? item.status : null,
        hasError: item.error !== undefined && item.error !== null,
      },
    };
  }
  return null;
}

export function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  onEvent?: (event: CodexTraceEvent) => void,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
    const trace = traceItem(item);
    if (trace) onEvent?.(trace);
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(
      request,
      this.config.codexSandboxMode,
      this.config.gatewayUrl,
    );
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(request.token),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    const emitTrace = (event: CodexTraceEvent) => {
      try {
        request.onEvent?.({
          runId: null,
          agentId: request.agentId,
          kind: event.kind,
          action: event.action,
          resource: event.resource,
          decision: null,
          reason: null,
          detail: event.detail,
        });
      } catch {
        // Trace persistence must never break the Codex run.
      }
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed, emitTrace);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed, emitTrace);
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(token?: string): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      NO_COLOR: "1",
      ...(this.config.llmProxyEnabled
        ? token
          ? { AGENT_TOKEN: token }
          : {}
        : { ARK_API_KEY: this.config.arkApiKey }),
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}

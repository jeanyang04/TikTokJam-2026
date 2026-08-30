import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";

/**
 * Owner-facing view of an agent's workspace, for the UI's file inspector.
 *
 * This is **not** a gateway path. The gateway governs what an *agent* may read
 * (scope + grant + taint, `gateway.ts`); this answers what an *owner* may see
 * of their own agent, and is reached only through `/api/agents/:id/*`, where
 * `app.ts`'s ownership preHandler has already turned another tenant's request
 * into a 403 + RunEvent. Nothing here re-decides access, so there is no second
 * policy to keep in sync with LOCK 1.
 */

/**
 * Never walked: `.git` and `node_modules` are large enough to stall the listing,
 * and neither is something an operator is inspecting the workspace to find.
 * `.codex` is the runtime's own session state, not the agent's work.
 */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", ".codex"]);

/**
 * A runaway agent can write files faster than anyone will read them. Both caps
 * are about keeping one HTTP response bounded, not about hiding anything: the
 * response says when it truncated, so the UI can say so too rather than
 * silently showing a partial workspace as if it were the whole one.
 */
const MAX_ENTRIES = 500;
const MAX_BYTES = 256 * 1024;

export interface WorkspaceFile {
  /** Relative to the workspace root, `/`-separated on every platform. */
  path: string;
  size: number;
  modifiedAt: string;
}

export interface WorkspaceListing {
  files: WorkspaceFile[];
  /** True when `MAX_ENTRIES` cut the walk short. */
  truncated: boolean;
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
  size: number;
  /** True when the file was longer than `MAX_BYTES` and `content` is a prefix. */
  truncated: boolean;
  /** True when the bytes are not text; `content` is then empty. */
  binary: boolean;
}

/**
 * Resolve `relative` inside `workspacePath`, refusing anything that escapes.
 *
 * Same shape as `gateway.ts`'s `jail`, deliberately duplicated rather than
 * shared: that one throws the gateway's `Denied` (which writes a RunEvent and
 * becomes an MCP tool error), this one throws an `HttpError` for a REST route.
 * Folding them together would mean one of the two callers raising the other's
 * error type.
 */
export function resolveInWorkspace(workspacePath: string, relative: string): string {
  const root = path.resolve(workspacePath);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(403, "Path escapes the workspace");
  }
  return full;
}

/** Depth-first walk of an agent's workspace, capped at `MAX_ENTRIES`. */
export async function listWorkspaceFiles(workspacePath: string): Promise<WorkspaceListing> {
  const root = path.resolve(workspacePath);
  const files: WorkspaceFile[] = [];
  let truncated = false;

  const walk = async (directory: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // A workspace that was archived (agent deleted) or never created reads as
      // empty rather than as a 500: the caller asked what is there, and the
      // answer is nothing.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // Sorted here rather than once at the end so the truncation cap cuts a
    // predictable set of files instead of whatever the filesystem listed first.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      // Symlinks are listed but not followed: `isFile()` is false for them, so
      // a link pointing outside the workspace never becomes a readable entry.
      if (!entry.isFile()) continue;
      const info = await stat(full);
      files.push({
        path: path.relative(root, full).split(path.sep).join("/"),
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  };

  await walk(root);
  return { files, truncated };
}

/** Read one file from an agent's workspace as text. */
export async function readWorkspaceFile(
  workspacePath: string,
  relative: string,
): Promise<WorkspaceFileContent> {
  const full = resolveInWorkspace(workspacePath, relative);
  let info;
  try {
    info = await stat(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "No such file in this workspace");
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new HttpError(400, "Not a file");
  }

  const buffer = await readFile(full);
  const slice = buffer.subarray(0, MAX_BYTES);
  // A NUL byte in the first slice is the cheap, conventional binary test. The
  // point is only to avoid pasting a PNG into a <pre>; nothing downstream
  // depends on the classification being exact.
  const binary = slice.includes(0);
  return {
    path: relative,
    content: binary ? "" : slice.toString("utf8"),
    size: info.size,
    truncated: !binary && buffer.length > MAX_BYTES,
    binary,
  };
}

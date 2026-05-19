import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../../logging.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import type { WikiWorkspaceRow } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("wiki-git-precompile");

/**
 * Pre-compile git auto-commit for `!compile full` on external vaults.
 *
 * WIKI_BUILDER_DESIGN.md §P2.E / §14 Q5.
 *
 * Gate:
 *   - Internal-mode workspace                 → skip (NotApplicable). The
 *     `md_file_snapshots` mechanism is the recovery surface.
 *   - External, not a git repo                → skip (NoBackup). The
 *     approval-gate DM tells the operator no git backup was taken.
 *   - External + git, `git_pre_compile_enabled = 0` → skip (Disabled).
 *   - External + git, dirty working tree      → Refused. The bang
 *     handler is expected to abort with a DM telling the operator to
 *     commit/stash first; no agent session is spawned.
 *   - External + git, clean working tree      → run `git add -A` +
 *     `git commit -m "aitne wiki: pre-compile snapshot <ts>"`. Operator
 *     hooks fire as normal (no `--no-verify`).
 */
export type GitPreCompileOutcome =
  | { status: "skipped"; reason: "internal_mode" | "no_git_repo" | "disabled" }
  | { status: "refused"; reason: "dirty_tree"; dirtyPaths: string[] }
  | { status: "committed"; commitSha: string; commitMessage: string };

/**
 * Preview shape — what a dry-run of the pre-compile gate would do without
 * actually mutating git state. Mirrors `GitPreCompileOutcome` minus the
 * `committed` arm, replacing it with `clean_would_commit`.
 *
 * Used by `GET /wiki/:ws/git/status` so the dashboard can render the
 * "what would happen on `!compile full`" hint without creating empty
 * commits on every poll. WIKI_BUILDER_DESIGN.md §P2.E.
 */
export type GitPreCompilePreview =
  | { status: "skipped"; reason: "internal_mode" | "no_git_repo" | "disabled" }
  | { status: "refused"; reason: "dirty_tree"; dirtyPaths: string[] }
  | { status: "clean_would_commit" };

export interface GitPreCompileDeps {
  /**
   * Override the timestamp baked into the commit message. Tests pass a
   * fixed string here; production callers leave it unset and the helper
   * uses `new Date().toISOString()`.
   */
  now?: () => Date;
  /**
   * Inject a custom `execFile`-compatible runner. Production code uses
   * the node built-in; tests can stub it without monkey-patching the
   * module. The signature matches `child_process.execFile`'s callback
   * form via `promisify` — callers do not need to await the wrapped
   * shape directly.
   */
  run?: (
    file: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Optional commit-attribution tracker (C1). When provided, the SHA of
   * the resulting snapshot commit is registered via `markAgentCommit`
   * so `GitWatcher`'s next observation of that SHA attributes it to
   * `actor='agent'` instead of `'user'`. Production callers should
   * always pass this; tests omit it.
   */
  writeTracker?: AgentWriteTracker;
}

/**
 * Pure read of the pre-compile gate state — never mutates the git working
 * tree. Returns the same `skipped` / `refused` arms as the mutating
 * `runGitPreCompile`, plus a `clean_would_commit` arm in place of the
 * mutating `committed` arm.
 *
 * Use this on dashboard GETs and on the `!compile full` decision pass so
 * the actual commit is deferred until the path that *will* run the agent
 * session decides to proceed.
 */
export async function previewGitPreCompile(
  workspace: WikiWorkspaceRow,
  deps: GitPreCompileDeps = {},
): Promise<GitPreCompilePreview> {
  if (workspace.kind !== "external") {
    return { status: "skipped", reason: "internal_mode" };
  }
  if (!isGitRepo(workspace.root_path)) {
    return { status: "skipped", reason: "no_git_repo" };
  }
  if (workspace.git_pre_compile_enabled !== 1) {
    return { status: "skipped", reason: "disabled" };
  }

  const dirtyPaths = await readDirtyPaths(workspace, deps);
  if (dirtyPaths.length > 0) {
    return { status: "refused", reason: "dirty_tree", dirtyPaths };
  }
  return { status: "clean_would_commit" };
}

export async function runGitPreCompile(
  workspace: WikiWorkspaceRow,
  deps: GitPreCompileDeps = {},
): Promise<GitPreCompileOutcome> {
  const preview = await previewGitPreCompile(workspace, deps);
  if (preview.status !== "clean_would_commit") {
    return preview;
  }

  const run = deps.run ?? defaultRun;
  const root = workspace.root_path;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const commitMessage = `aitne wiki: pre-compile snapshot ${now}`;

  await run("git", ["-C", root, "add", "-A"], { timeout: 30_000 });
  await run(
    "git",
    [
      "-C",
      root,
      "commit",
      "--allow-empty",
      "-m",
      commitMessage,
    ],
    { timeout: 30_000 },
  );

  const sha = await run("git", ["-C", root, "rev-parse", "HEAD"], {
    timeout: 5_000,
  });
  const trimmed = sha.stdout.trim();
  // Tell GitWatcher this SHA was committed by the daemon so the next
  // poll-cycle observation attributes it to `actor='agent'` rather than
  // the historical `'user'` (C1 — closes the daemon-side self-trigger
  // loop in wiki pre-compile).
  deps.writeTracker?.markAgentCommit(root, trimmed);
  return {
    status: "committed",
    commitSha: trimmed,
    commitMessage,
  };
}

async function readDirtyPaths(
  workspace: WikiWorkspaceRow,
  deps: GitPreCompileDeps,
): Promise<string[]> {
  const run = deps.run ?? defaultRun;
  const statusOut = await run(
    "git",
    ["-C", workspace.root_path, "status", "--porcelain"],
    { timeout: 10_000 },
  ).catch((err) => {
    logger.warn(
      { workspace: workspace.name, err: err instanceof Error ? err.message : String(err) },
      "wiki git pre-compile: status check failed — treating as dirty for safety",
    );
    return { stdout: "?? git-status-failed", stderr: "" };
  });
  // Porcelain output is exactly "XY <path>" — two status chars + space.
  // Do NOT pre-trim because trimming would eat the leading space for the
  // single-column statuses (`?? newfile`, ` M tracked-edit`) and chop the
  // first letter of the filename.
  return statusOut.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
}

export function isGitRepo(rootPath: string): boolean {
  const gitDir = join(rootPath, ".git");
  if (!existsSync(gitDir)) return false;
  try {
    const stat = statSync(gitDir);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

async function defaultRun(
  file: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: options?.timeout ?? 10_000,
    cwd: options?.cwd,
    windowsHide: true,
  });
  return { stdout, stderr };
}

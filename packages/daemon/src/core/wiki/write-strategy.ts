import type Database from "better-sqlite3";
import { dirname, join, relative, resolve } from "node:path";
import { ObsidianService } from "../../services/obsidian.js";
import type { WikiWorkspaceRow } from "./workspaces.js";
import { writeFileAtomically } from "../atomic-write.js";

/**
 * WikiWriteStrategy — encapsulates how the daemon persists a write into
 * a wiki workspace.
 *
 * - `internal` workspaces always use the local-fs path (atomic write).
 * - `external` workspaces start in `auto` and probe: try direct fs first,
 *   fall back to Obsidian-CLI on EPERM / EACCES / EROFS (typical for
 *   iCloud-sandboxed vaults). The resolved strategy is persisted to
 *   `wiki_workspaces.write_strategy` so subsequent writes skip the probe.
 *
 * WIKI_BUILDER_DESIGN.md §P2.B, §8 (external-mode iCloud fallback).
 *
 * The module owns ZERO state besides the per-workspace ObsidianService
 * instance map; the resolved strategy lives in the DB row. This keeps
 * the probe outcome durable across daemon restarts.
 */
export type WikiResolvedStrategy = "fs" | "cli";

export interface WikiWriteStrategyResolverDeps {
  db: Database.Database;
  obsidian: ObsidianService;
}

export interface WriteWikiFileInput {
  workspace: WikiWorkspaceRow;
  relPath: string;
  content: string;
}

export interface WriteWikiFileOutcome {
  strategy: WikiResolvedStrategy;
  durationMs: number;
}

const FALLBACK_ERROR_CODES = new Set(["EPERM", "EACCES", "EROFS", "EBUSY"]);

export class WikiWriteStrategyResolver {
  constructor(private readonly deps: WikiWriteStrategyResolverDeps) {}

  /**
   * Resolve the strategy a write should use for a workspace.
   *
   * Internal-mode rows are always `fs`. External-mode rows return their
   * cached `write_strategy` when it is `fs` or `cli`; `auto` (the post-
   * setup default) means "probe on the first write". The probe happens
   * inside `writeFile()` rather than here, because we only know the
   * outcome after attempting the write — surfacing it ahead of time
   * would duplicate the failure path.
   */
  resolveStrategy(workspace: WikiWorkspaceRow): "fs" | "cli" | "auto" {
    if (workspace.kind === "internal") return "fs";
    return workspace.write_strategy;
  }

  async writeFile(input: WriteWikiFileInput): Promise<WriteWikiFileOutcome> {
    const start = Date.now();
    const strategy = this.resolveStrategy(input.workspace);
    const fullPath = resolve(input.workspace.root_path, input.relPath);
    const safe = ensureWithinRoot(input.workspace.root_path, fullPath);
    if (!safe) {
      throw Object.assign(
        new Error(`wiki write: path escapes workspace root: ${input.relPath}`),
        { code: "EWIKIPATH" },
      );
    }

    if (strategy === "fs") {
      writeFileAtomically(fullPath, ensureTrailingNewline(input.content));
      return { strategy: "fs", durationMs: Date.now() - start };
    }
    if (strategy === "cli") {
      await this.writeViaCli(input);
      return { strategy: "cli", durationMs: Date.now() - start };
    }

    // strategy === "auto" — external workspace, no probe outcome cached.
    try {
      writeFileAtomically(fullPath, ensureTrailingNewline(input.content));
      this.persistResolved(input.workspace, "fs");
      return { strategy: "fs", durationMs: Date.now() - start };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!FALLBACK_ERROR_CODES.has(code)) throw err;
      await this.writeViaCli(input);
      this.persistResolved(input.workspace, "cli");
      return { strategy: "cli", durationMs: Date.now() - start };
    }
  }

  private async writeViaCli(input: WriteWikiFileInput): Promise<void> {
    if (!this.deps.obsidian.available) {
      throw Object.assign(
        new Error(
          "wiki write: Obsidian CLI is required for external-mode fallback but the service is not configured.",
        ),
        { code: "EWIKI_CLI_UNAVAILABLE" },
      );
    }
    if (!(await this.deps.obsidian.isRunning())) {
      throw Object.assign(
        new Error(
          "wiki write: Obsidian app is not running; the CLI fallback cannot reach the sandboxed vault.",
        ),
        { code: "EWIKI_CLI_NOT_RUNNING" },
      );
    }
    // The Obsidian CLI's `create path=… overwrite` is idempotent and
    // accepts relative vault paths. We use the workspace root_path as the
    // vault root, so the rel path passed straight through is correct.
    await this.deps.obsidian.updateNote(
      input.relPath,
      ensureTrailingNewline(input.content),
    );
  }

  private persistResolved(
    workspace: WikiWorkspaceRow,
    strategy: WikiResolvedStrategy,
  ): void {
    if (workspace.write_strategy === strategy) return;
    this.deps.db
      .prepare(
        `UPDATE wiki_workspaces
           SET write_strategy = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(strategy, workspace.id);
    workspace.write_strategy = strategy;
  }
}

/**
 * Health surface for `/api/health.wiki` — reports the per-workspace
 * resolved strategy plus a one-shot CLI reachability probe.
 */
export interface WikiWriteStrategyHealth {
  workspace: string;
  kind: "internal" | "external";
  strategy: "fs" | "cli" | "auto";
  cliAvailable: boolean | null;
}

export async function probeWikiWriteStrategyHealth(
  workspace: WikiWorkspaceRow,
  obsidian: ObsidianService,
): Promise<WikiWriteStrategyHealth> {
  if (workspace.kind === "internal") {
    return {
      workspace: workspace.name,
      kind: workspace.kind,
      strategy: "fs",
      cliAvailable: null,
    };
  }
  return {
    workspace: workspace.name,
    kind: workspace.kind,
    strategy: workspace.write_strategy,
    cliAvailable: obsidian.available ? await obsidian.isRunning() : false,
  };
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function ensureWithinRoot(root: string, fullPath: string): boolean {
  const rel = relative(root, fullPath);
  return !rel.startsWith("..") && !rel.startsWith("/");
}

/**
 * Resolve the workspace-relative directory of a vault-local file. Exposed
 * so the chokidar-driven `_index.md` cache can register the watcher path
 * without duplicating the join.
 */
export function resolveWikiPath(workspace: WikiWorkspaceRow, relPath: string): string {
  return join(workspace.root_path, relPath);
}

export function indexCachePathFor(workspace: WikiWorkspaceRow): string {
  return dirname(resolveWikiPath(workspace, "20_wiki/_index.md"));
}

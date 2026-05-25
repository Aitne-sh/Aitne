import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import {
  resolveRepositoryIdentifier,
  selectGitRepoPaths,
} from "../../db/repositories-store.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("git-api");

export interface GitRouteDependencies {
  /**
   * Database for resolving the unified `repositories` table. Optional
   * only because some tests construct the route with a static
   * `allowedRepos` allowlist instead of seeding the DB; production
   * always passes `db`.
   */
  db?: Database.Database;
  /**
   * Optional: when set, augments the unified-store allowlist. Tests use
   * this so they don't need to seed the table for every call. Production
   * code should pass `db` only and rely on the store.
   */
  allowedRepos?: string[];
}

/**
 * Git API routes — read-only proxy for configured repositories.
 *
 * GET /git/log   — recent commit log
 * GET /git/diff  — diff between refs
 * GET /git/show  — show a specific commit
 *
 * `?repo=` accepts:
 *   - an absolute filesystem path that appears in the unified
 *     `repositories` table with a non-null `local_path`,
 *   - a repository id (e.g. "github:acme/widgets" or "local:abc123…").
 *
 * GitHub-only repositories (no local clone) 404 with a helpful error.
 * Refs and hashes are sanitized to prevent shell injection.
 */
export function createGitRoutes(deps: GitRouteDependencies): Hono {
  const app = new Hono();

  function resolveRepo(repoParam: string | undefined): string | null {
    if (!repoParam) return null;
    // Direct path match first (the common case from existing callers).
    const allowed = new Set<string>();
    if (deps.db) {
      for (const path of selectGitRepoPaths(deps.db)) allowed.add(path);
    }
    if (deps.allowedRepos) {
      for (const path of deps.allowedRepos) allowed.add(path);
    }
    if (allowed.has(repoParam)) return repoParam;
    // Fallback: id lookup against the store.
    if (deps.db) {
      const row = resolveRepositoryIdentifier(deps.db, repoParam);
      if (row && row.localPath) return row.localPath;
    }
    return null;
  }

  function listAllowed(): string[] {
    const allowed = new Set<string>();
    if (deps.db) {
      for (const path of selectGitRepoPaths(deps.db)) allowed.add(path);
    }
    if (deps.allowedRepos) {
      for (const path of deps.allowedRepos) allowed.add(path);
    }
    return [...allowed];
  }

  // GET /git/log — recent commit log
  app.get("/git/log", async (c) => {
    const repoParam = c.req.query("repo");
    const repo = resolveRepo(repoParam);
    if (!repo) {
      return respondWithAgentError(c, 400, [
        composeIssue("git.invalid_repo", {
          field: "repo",
          received: repoParam ?? "<missing>",
        }),
      ], { legacyErrorCode: "invalid or missing repo", legacyFields: { allowed: listAllowed() } });
    }

    const countRaw = Number.parseInt(c.req.query("count") ?? "5", 10);
    const count =
      Number.isFinite(countRaw) && countRaw >= 1
        ? Math.min(countRaw, 200)
        : 5;
    // ASCII Unit Separator — git commit fields (subject/author) cannot contain it,
    // so it's a safer delimiter than `|` which naturally appears in commit subjects.
    const FS = "\x1f";
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", `--format=%H${FS}%h${FS}%s${FS}%an${FS}%ar`, `-${count}`],
        { cwd: repo, timeout: 10_000 },
      );
      const commits = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, short, subject, author, ago] = line.split(FS);
          return { hash, short, subject, author, ago };
        });
      return c.json({ commits });
    } catch (err) {
      logger.error({ err, repo }, "git log failed");
      return respondWithAgentError(c, 500, [
        composeIssue("git.exec_failed", {
          field: "git log",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyErrorCode: toSafeErrorMessage(err) });
    }
  });

  // GET /git/diff — diff between refs
  app.get("/git/diff", async (c) => {
    const repoParam = c.req.query("repo");
    const repo = resolveRepo(repoParam);
    if (!repo) {
      return respondWithAgentError(c, 400, [
        composeIssue("git.invalid_repo", {
          field: "repo",
          received: repoParam ?? "<missing>",
        }),
      ], { legacyErrorCode: "invalid or missing repo" });
    }

    // Use || (not ??) so explicit ?ref= (empty string) falls back to default
    const ref = c.req.query("ref") || "HEAD~1..HEAD";
    // Sanitize ref — reject shell metacharacters and flag-like arguments
    if (/[;&|`$]/.test(ref) || ref.startsWith("-")) {
      return respondWithAgentError(c, 400, [
        composeIssue("git.invalid_ref", {
          field: "ref",
          received: ref,
        }),
      ], { legacyErrorCode: "invalid ref format" });
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--stat", "-p", ref],
        { cwd: repo, timeout: 10_000, maxBuffer: 200_000 },
      );
      return c.json({ diff: stdout.slice(0, 10_000) });
    } catch (err) {
      logger.error({ err, repo, ref }, "git diff failed");
      return respondWithAgentError(c, 500, [
        composeIssue("git.exec_failed", {
          field: "git diff",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyErrorCode: toSafeErrorMessage(err) });
    }
  });

  // GET /git/show — show a specific commit
  app.get("/git/show", async (c) => {
    const repoParam = c.req.query("repo");
    const repo = resolveRepo(repoParam);
    if (!repo) {
      return respondWithAgentError(c, 400, [
        composeIssue("git.invalid_repo", {
          field: "repo",
          received: repoParam ?? "<missing>",
        }),
      ], { legacyErrorCode: "invalid or missing repo" });
    }

    const hash = c.req.query("hash") || "HEAD";
    if (/[;&|`$]/.test(hash) || hash.startsWith("-")) {
      return respondWithAgentError(c, 400, [
        composeIssue("git.invalid_hash", {
          field: "hash",
          received: hash,
        }),
      ], { legacyErrorCode: "invalid hash format" });
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", "--stat", "--format=%H%n%s%n%b%n---", hash],
        { cwd: repo, timeout: 10_000, maxBuffer: 100_000 },
      );
      return c.json({ show: stdout.slice(0, 5000) });
    } catch (err) {
      logger.error({ err, repo, hash }, "git show failed");
      return respondWithAgentError(c, 500, [
        composeIssue("git.exec_failed", {
          field: "git show",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyErrorCode: toSafeErrorMessage(err) });
    }
  });

  return app;
}

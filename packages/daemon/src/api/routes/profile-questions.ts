/**
 * Profile-interview queue HTTP surface.
 *
 * Read-only helper that wraps the canonical `isSlotFilled` rule
 * (`packages/daemon/src/core/profile-questions/slot-filled.ts`) for
 * agent prose to call. Centralising the rule here prevents the heuristic
 * from drifting between TS (`skeleton.ts` Layer 1) and prose (Layers 2,
 * 3, 5).
 *
 * Risk tier: Autonomous. The endpoint is read-only and operates on
 * paths inside the context vault; no secrets or auth-sensitive data
 * traverse this surface. See `safety/risk-classifier.ts`.
 */

import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ApiDependencies } from "../server.js";
import { getContextDir } from "../../config.js";
import { aliasVaultPath } from "../../core/context-vault-aliases.js";
import { isSlotFilled } from "../../core/profile-questions/slot-filled.js";
import { createLogger } from "../../logging.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("profile-questions-api");

export function createProfileQuestionsRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const getCurrentContextDir = () => getContextDir(deps.config);

  /**
   * GET /api/profile-questions/slot-filled
   *
   * Query:
   *   path     (required) Relative path under contextDir,
   *                       e.g. `identity/profile.md`. The trailing `.md`
   *                       can be omitted; `.base` files are not accepted
   *                       (this endpoint is for prose-bearing markdown).
   *   section  (optional) Heading text without leading `## ` —
   *                       e.g. `Identity`. Omit to scan the whole file.
   *   anchor   (optional) Bullet key to look for, e.g. `Name`. Omit to
   *                       accept any non-placeholder bullet as filled.
   *
   * Response:
   *   200 { filled, sectionPresent, fileExists, path, section?, anchor? }
   *   400 { error: "missing_path" | "invalid_path" }
   *   500 { error: "read_failed" } — fs error during read; logged
   */
  app.get("/profile-questions/slot-filled", (c) => {
    const path = c.req.query("path");
    const section = c.req.query("section") ?? null;
    const anchor = c.req.query("anchor") ?? null;
    if (!path || path.trim().length === 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("profile_questions.path_required", {
          field: "path",
          received: path ?? "<missing>",
        }),
      ], { legacyFields: { details: "Query parameter 'path' is required" } });
    }

    const contextDir = getCurrentContextDir();
    const resolved = safePath(contextDir, path);
    if (resolved === null) {
      return respondWithAgentError(c, 400, [
        composeIssue("profile_questions.path_invalid", {
          field: "path",
          received: path,
        }),
      ]);
    }
    if (!existsSync(resolved)) {
      return c.json({
        filled: false,
        sectionPresent: false,
        fileExists: false,
        path,
        section,
        anchor,
      });
    }

    let body: string;
    try {
      body = readFileSync(resolved, "utf-8");
    } catch (err) {
      logger.warn(
        { err, resolved, path },
        "Failed to read target for slot-filled probe",
      );
      return respondWithAgentError(c, 500, [
        composeIssue("profile_questions.read_failed", {
          field: "path",
          received: path,
        }),
      ]);
    }

    const result = isSlotFilled(body, section, anchor);
    return c.json({
      ...result,
      fileExists: true,
      path,
      section,
      anchor,
    });
  });

  return app;
}

/**
 * Resolve a user-supplied relative path against `contextDir`, rejecting
 * traversal attempts. Lighter-weight than the full
 * `context.ts:safePath` because this endpoint is read-only and never
 * mutates state — but still defends against `..` / absolute paths and
 * the `.base` extension family.
 */
function safePath(contextDir: string, userPath: string): string | null {
  if (userPath.length === 0 || isAbsolute(userPath)) return null;
  if (userPath.includes("\0")) return null;
  if (userPath.split(/[\\/]+/).some((seg) => seg === "..")) return null;
  // Accept paths with or without `.md`. Reject `.base` — those are
  // Obsidian view configs, not prose, and should not be probed by this
  // endpoint.
  let candidate = userPath;
  if (candidate.endsWith(".base")) return null;
  // CONTEXT_VAULT_REDESIGN: translate legacy paths (e.g. `identity/profile`)
  // to their canonical six-class destinations (`identity/profile`) so
  // skill code calling the route with either spelling resolves to the
  // same file.
  candidate = aliasVaultPath(candidate).canonicalPath;
  if (!candidate.endsWith(".md")) candidate = `${candidate}.md`;
  const resolved = resolve(contextDir, candidate);
  const rel = relative(contextDir, resolved);
  /* c8 ignore start — defense-in-depth past the `..`-segment + isAbsolute
     checks above; unreachable while those guards hold but kept so a
     future relaxation upstream cannot silently widen the surface. */
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  /* c8 ignore stop */
  return resolved;
}

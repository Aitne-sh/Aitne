import { Hono } from "hono";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { ApiDependencies } from "../server.js";
import { normalizeRequestedPath } from "./fs.logic.js";
import { validateWikiRootPath } from "../../core/wiki/workspaces.js";
import { probeExistingWikiVault } from "../../core/wiki/import-probe.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

/**
 * Wiki vault probe route — supports the dashboard's external-mode
 * picker (WIKI_BUILDER_DESIGN.md §6.1 "External vault path").
 *
 * Selection itself is handled by the existing system-native picker
 * (`/api/system/pick-directory`, which dispatches to `osascript`,
 * `powershell`, or `zenity`/`kdialog`/`yad`). This route only validates
 * the chosen path: existence, writability, collision with the
 * primary/external/data vault paths, and detection of an existing
 * LLM-Wiki structure. Splitting selection from validation keeps the
 * UX consistent across all directory-picker callers (setup wizard,
 * management mode, mail accounts) — the wiki page is the only one
 * that also needs §7 import detection, so the probe stays here.
 *
 * Security: classified at `RiskTier.Approve` in `risk-classifier.ts`.
 * `fs.logic.ts::normalizeRequestedPath` rejects relative paths,
 * forbidden system prefixes, and known secret-file paths before any
 * filesystem call is made.
 */
export function createFsRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();

  app.get("/fs/probe", (c) => {
    const rawPath = c.req.query("path");
    if (rawPath === undefined) {
      return respondWithAgentError(c, 400, [
        composeIssue("fs.missing_path", {
          field: "path",
          received: "<missing>",
        }),
      ], { legacyFields: { message: "Query param `path` is required." } });
    }
    const norm = normalizeRequestedPath(rawPath);
    if (!norm.ok) {
      return respondWithAgentError(c, 400, [
        composeIssue("fs.invalid_path", {
          field: "path",
          received: rawPath,
          /* c8 ignore next — normalizeRequestedPath always sets `message` on failure; the fallback is defensive in case a future error path forgets to. */
          expected: norm.message ?? "absolute path outside the system blocklist",
        }),
      ], {
        legacyErrorCode: norm.error,
        legacyFields: {
          ok: false,
          message: norm.message,
          exists: false,
          isDir: false,
          writable: false,
          collision: null,
          hasObsidianStructure: false,
          existingWiki: null,
        },
      });
    }
    const absPath = norm.path;
    const exists = existsSync(absPath);
    let isDir = false;
    let writable = false;
    if (exists) {
      try {
        isDir = statSync(absPath).isDirectory();
        /* c8 ignore start — TOCTOU race: existsSync above just returned
           true. statSync can still throw if the path is deleted, the
           dir is on a removable volume that just disappeared, or
           perms changed between the two calls. Reachable in production,
           but the picker doesn't need a special branch — fall through
           to `isDir=false` and let the banner explain. */
      } catch {
        isDir = false;
      }
      /* c8 ignore stop */
      if (isDir) {
        try {
          accessSync(absPath, fsConstants.W_OK);
          writable = true;
          /* c8 ignore start — same TOCTOU shape as above. Catch keeps
             writable=false so the banner surfaces "Obsidian CLI
             fallback applies" rather than throwing 500. */
        } catch {
          writable = false;
        }
        /* c8 ignore stop */
      }
    }
    // `validateWikiRootPath` already understands the full collision
    // matrix — primary vault, external Obsidian vault, dataDir, other
    // active wiki workspaces — and allows missing leaves so probing a
    // not-yet-created path works.
    const validation = validateWikiRootPath(absPath, deps.db, deps.config, {});
    const collision: ProbeCollision = validation.ok
      ? null
      : mapValidationError(validation.error);
    // `.obsidian` marker disambiguates an Obsidian vault from a plain
    // markdown folder. The Adopt / Migrate decision rides on this when
    // we surface it back through the §P2.D import wizard.
    const hasObsidianStructure = exists && isDir && existsSync(join(absPath, ".obsidian"));
    const probe = exists && isDir ? probeExistingWikiVault(absPath) : null;
    return c.json({
      ok: true,
      path: absPath,
      // `resolvedPath` is always set when validation.ok is true (see
      // `validateWikiRootPath` — it returns `real = realpathSafe(...)`).
      // The `?? absPath` fallback is defensive against a future type
      // change loosening that contract; the branch is unreachable
      // today.
      resolved: validation.ok
        ? /* c8 ignore next */ validation.resolvedPath ?? absPath
        : absPath,
      exists,
      isDir,
      writable,
      collision,
      collisionMessage: !validation.ok ? validation.message : null,
      hasObsidianStructure,
      existingWiki: probe && probe.kind !== "empty"
        ? {
            kind: probe.kind,
            layers: probe.layers.filter((l) => l.exists).map((l) => l.dir),
            taxonomyPresent: probe.taxonomyPresent,
            indexPresent: probe.indexPresent,
            unexpectedSubdirectories: probe.unexpectedSubdirectories,
          }
        : null,
    });
  });

  return app;
}

/**
 * Collision codes the picker surfaces. Sourced from
 * `validatePrimaryVaultPath` (config.ts) + `validateWikiRootPath`
 * (workspaces.ts). Anything we don't have a UI string for collapses to
 * `invalid` so the dashboard can fall back to the validator's
 * human-readable `collisionMessage`.
 */
type ProbeCollision =
  | null
  | "primary_vault"
  | "external_obsidian"
  | "data_dir"
  | "other_wiki"
  | "system_path"
  | "not_writable"
  | "invalid";

function mapValidationError(error: string | undefined): ProbeCollision {
  switch (error) {
    case "overlaps_primary_vault":
      return "primary_vault";
    // Wiki validator emits `overlaps_external_obsidian`; the underlying
    // primary-vault validator emits `overlaps_external_vault`. In
    // practice the primary validator fires first because the wiki
    // validator chains it — the `overlaps_external_obsidian` arm is
    // defensive against a future refactor that flips the order.
    /* c8 ignore next */
    case "overlaps_external_obsidian":
    case "overlaps_external_vault":
      return "external_obsidian";
    case "overlaps_other_wiki":
      return "other_wiki";
    case "overlaps_data_dir":
      return "data_dir";
    /* c8 ignore start — `system_path` and `not_writable` are
       defense-in-depth: `fs.logic.ts::normalizeRequestedPath` rejects
       system prefixes before `validateWikiRootPath` runs, and
       `not_writable` requires a pre-existing locked directory which
       the OS-native picker effectively cannot return. Kept so a
       future call path that bypasses normalisation still surfaces a
       typed code. The `default` arm covers a future validator error
       we haven't mapped yet. */
    case "system_path":
      return "system_path";
    case "not_writable":
      return "not_writable";
    default:
      return "invalid";
    /* c8 ignore stop */
  }
}

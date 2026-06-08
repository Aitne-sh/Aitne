// drift-allow-file: this module documents the alias contract and
// translates legacy `user/`, `rules/`, etc. paths to their six-class
// destinations. Legacy refs in the docstring are load-bearing.
import {
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  CONTEXT_BASE_FILE_STEMS,
  CONTEXT_FILE_EXTENSIONS,
} from "../../../core/context-paths.js";
import { aliasVaultPath } from "../../../core/context-vault-aliases.js";
import type { ResolvedContextTarget } from "../../../core/context-validation/index.js";
import { createLogger } from "../../../logging.js";

const logger = createLogger("context-api");

const CONTEXT_BASE_FILE_STEM_SET = new Set<string>(CONTEXT_BASE_FILE_STEMS);

/**
 * Subpath prefixes inside contextDir that the API never exposes.
 * Relative paths from `path.relative` never contain a trailing slash for
 * the leaf element, so we match on "<name>" exactly OR "<name>/" prefix.
 *
 *  - `.git` — local repo artifacts the daemon must not touch
 *  - `.DS_Store` — macOS filesystem cruft
 *  - `.obsidian` — Obsidian's own state directory
 *
 * `.obsidian` stays denied in every mode. `vaultMode="obsidian"` means the
 * directory may exist on disk and should be preserved by the daemon, not that
 * the agent may read or edit Obsidian's workspace state through this API.
 */
const DENIED_SUBPATH_ROOTS = [".git", ".DS_Store", ".obsidian"] as const;

/**
 * Resolve a user-supplied path into a canonical `(base, ext)` pair.
 *
 * **Legacy alias translation** (CONTEXT_VAULT_REDESIGN_PLAN.md §7.3,
 * §14.3, v4 V8): every entry point first canonicalises the path
 * through `aliasVaultPath` so legacy spellings (e.g. `today.md`,
 * `user/profile.md`, `rules/management.md`) resolve to their six-class
 * destinations (`state/today.md`, `identity/profile.md`,
 * `policies/management.md`). The alias is an in-process resolver — no
 * HTTP 3xx — so existing `curl -s -X PATCH` callers that omit `-L`
 * continue to work. Idempotent on already-canonical paths.
 */
export function resolveContextTarget(userPath: string): ResolvedContextTarget {
  const aliased = aliasVaultPath(userPath).canonicalPath;
  for (const ext of CONTEXT_FILE_EXTENSIONS) {
    if (aliased.endsWith(ext)) {
      return { base: aliased.slice(0, -ext.length), ext };
    }
  }
  if (CONTEXT_BASE_FILE_STEM_SET.has(aliased)) {
    return { base: aliased, ext: ".base" };
  }
  return { base: aliased, ext: ".md" };
}

export function normalizeContextPath(userPath: string): string {
  return resolveContextTarget(userPath).base;
}

export function isDeniedPath(relativePath: string): boolean {
  // path.relative emits OS-native separators (backslash on Windows); the
  // DENIED_SUBPATH_ROOTS prefixes are forward-slash. Normalize before the
  // compare so nested `.git\config`, `.obsidian\workspace.json`, etc. are
  // caught on Windows. POSIX paths contain no backslashes -> no-op there.
  const normalized = relativePath.replace(/\\/g, "/");
  for (const root of DENIED_SUBPATH_ROOTS) {
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
}

export function escapesBase(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel.startsWith("..") || isAbsolute(rel);
}

export function resolveRealPathBestEffort(
  path: string,
  seen = new Set<string>(),
): string | null {
  const abs = resolve(path);
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      if (seen.has(abs)) return null;
      seen.add(abs);
      const target = readlinkSync(abs);
      return resolveRealPathBestEffort(
        isAbsolute(target) ? target : resolve(dirname(abs), target),
        seen,
      );
    }
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    const parentReal = resolveRealPathBestEffort(parent, seen);
    return parentReal ? resolve(parentReal, basename(abs)) : null;
  }
}

/**
 * Resolve a user-supplied path safely within contextDir.
 * Accepts paths with or without the trailing `.md` / `.base` extension.
 * Returns null if the resolved path escapes contextDir (path traversal),
 * targets a reserved `.base` stem with the wrong extension, or is on the
 * deny list.
 */
export function safePath(
  contextDir: string,
  userPath: string,
): string | null {
  const { base, ext } = resolveContextTarget(userPath);
  if (base === "plans/projects/_active" && ext !== ".base") {
    logger.warn({ userPath, base, ext }, "Base file requested with wrong extension");
    return null;
  }
  const resolved = resolve(contextDir, `${base}${ext}`);
  const rel = relative(contextDir, resolved);
  // Reject if path escapes contextDir (starts with .. or is absolute)
  if (escapesBase(contextDir, resolved)) {
    logger.warn({ userPath, resolved }, "Path traversal rejected");
    return null;
  }
  if (isDeniedPath(rel)) {
    logger.warn({ userPath, resolved }, "Denied subpath rejected");
    return null;
  }
  const contextReal = resolveRealPathBestEffort(contextDir);
  const resolvedReal = resolveRealPathBestEffort(resolved);
  if (!contextReal || !resolvedReal) {
    logger.warn({ userPath, resolved }, "Realpath resolution rejected");
    return null;
  }
  if (escapesBase(contextReal, resolvedReal)) {
    logger.warn({ userPath, resolved, resolvedReal }, "Symlink traversal rejected");
    return null;
  }
  const realRel = relative(contextReal, resolvedReal);
  if (isDeniedPath(realRel)) {
    logger.warn({ userPath, resolved, resolvedReal }, "Denied realpath rejected");
    return null;
  }
  return resolved;
}

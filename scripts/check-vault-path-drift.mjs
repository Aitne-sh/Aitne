#!/usr/bin/env node
/**
 * Vault-path drift guard (CONTEXT_VAULT_REDESIGN_PLAN.md §15 PR-3 +
 * §14.8 summary table).
 *
 * Scans the repo for accidental survival of legacy vault paths after
 * the CONTEXT_VAULT_REDESIGN restructure. Exits non-zero if any
 * scanned file references one of the legacy top-level directories
 * (`user/`, `rules/`, `routines/`, `daily/`, `weekly/`, `monthly/`,
 * `dossiers/`, `inbox/`, `agent/`, `projects/`, `git-repos/`) in an
 * unambiguously-path context.
 *
 * Excluded by design:
 *  - The alias resolver itself (`packages/daemon/src/core/context-vault-aliases*`),
 *    its peer test, and the migration runner — these are required to know
 *    legacy paths.
 *  - Markdown migration / design docs (this redesign plan, the design
 *    appendices, etc.) that describe the move.
 *  - Anything under `node_modules/` and build outputs.
 *  - Test files (`.test.ts` / `.test.tsx`) — many of them deliberately
 *    exercise the alias resolver, so legacy path strings inside them are
 *    *expected*, not drift.
 *
 * Per-file suppression: a file can opt out entirely by including the
 * marker `drift-allow-file: <reason>` anywhere in its first 30 lines.
 * This is for files whose job is to know about legacy paths (the alias
 * tables in `permissions.ts`, the per-route legacy-alias maps in
 * `read.ts` / `write.ts` / `snapshots.ts`, etc.).
 *
 * Per-line suppression: append `// drift-allow` (any prefix delimiter)
 * to the line. Use for an isolated documentation reference.
 *
 * Usage:
 *   node scripts/check-vault-path-drift.mjs
 *   node scripts/check-vault-path-drift.mjs --json   # machine-readable
 *
 * Exit codes:
 *   0  no drift detected
 *   1  drift detected (offenders listed in stdout)
 *   2  scan failed
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
/**
 * `docs/` and `agent-assets/docs/` are tracked separately by PR-8 (the
 * documentation rewrite). They are not load-bearing for runtime
 * correctness — the alias resolver handles legacy URLs in URLs, and
 * doc prose can lag the code. Skipped by default; pass --include-docs
 * to widen the scan for the PR-8 sweep itself.
 */
const includeDocs = args.includes("--include-docs");

const SCAN_ROOTS_PRODUCTION = [
  "packages/daemon/src",
  "packages/dashboard/src",
  "packages/shared/src",
  "agent-assets",
];
const SCAN_ROOTS_DOCS = ["docs", "agent-assets/docs"];
const SCAN_ROOTS = includeDocs
  ? [...SCAN_ROOTS_PRODUCTION, ...SCAN_ROOTS_DOCS]
  : SCAN_ROOTS_PRODUCTION;
const EXCLUDED_FILES = new Set([
  "packages/daemon/src/core/context-vault-aliases.ts",
  "packages/daemon/src/core/context-vault-aliases.test.ts",
  "packages/daemon/src/db/migrations/context-vault-restructure.ts",
  "packages/daemon/src/db/migrations/context-vault-restructure.test.ts",
  "packages/daemon/src/core/context-validation/frontmatter.ts",
  "scripts/check-vault-path-drift.mjs",
  // Design docs that describe the migration.
  "CONTEXT_VAULT_REDESIGN_PLAN.md",
]);
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
]);
/**
 * Relative-path prefixes skipped when `--include-docs` is off. These
 * are documentation roots inside otherwise-production scan trees
 * (`agent-assets/` is scanned for its skills + templates, but its
 * `docs/` sub-tree is doc prose that's PR-8's responsibility).
 */
const EXCLUDED_REL_PREFIXES = includeDocs
  ? []
  : ["agent-assets/docs"];
const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".md",
  ".json",
]);

/**
 * Negative lookbehind that suppresses matches whose delimiter `/`
 * happens to live inside a NEW-class prefix (`policies/routines/...`
 * legitimately contains `routines/`, etc.). Without this, every
 * canonical post-migration path would register as drift because the
 * delimiter group `(["'`/])` matches the inner slash.
 *
 * Listed in longest-name-first order so JS regex backtracking finds
 * the longest match — `policies` ahead of `plans` keeps a
 * `plans/projects/x` path from being misread as ending with `plans`
 * when the suppress check would actually be looking for `policies`.
 */
const NEW_CLASS_LOOKBEHIND =
  "(?<!(?:knowledge|policies|identity|journal|state|plans))";

function legacyPattern(rest) {
  return new RegExp(NEW_CLASS_LOOKBEHIND + rest, "g");
}

const LEGACY_PATTERNS = [
  // (regex, label)
  [
    legacyPattern(
      "([\"'`/])user\\/(?:profile|people|work|expertise|personal|goals|_index)",
    ),
    "legacy identity/ path under user/",
  ],
  [
    legacyPattern(
      "([\"'`/])rules\\/(?:management|mcp|redaction|journal-format|journal-export|policies|_index)",
    ),
    "legacy policies/ path under rules/",
  ],
  [
    legacyPattern(
      "([\"'`/])routines\\/(?:morning|evening|hourly|weekly|monthly|custom|_index)",
    ),
    "legacy policies/routines/ path under routines/",
  ],
  [
    legacyPattern(
      "([\"'`/])projects\\/(?:_active|_index|[a-z][a-z0-9-]*)",
    ),
    "legacy plans/projects/ path under projects/",
  ],
  [legacyPattern("([\"'`/])daily\\/[0-9]"), "legacy journal/daily/ path under daily/"],
  [legacyPattern("([\"'`/])weekly\\/[0-9]"), "legacy journal/weekly/ path under weekly/"],
  [legacyPattern("([\"'`/])monthly\\/[0-9]"), "legacy journal/monthly/ path under monthly/"],
  [legacyPattern("([\"'`/])dossiers\\/"), "legacy knowledge/dossiers/ path under dossiers/"],
  [legacyPattern("([\"'`/])inbox\\/[0-9]"), "legacy state/inbox/ path under inbox/"],
  [
    legacyPattern(
      "([\"'`/])agent\\/(?:journal|scratch|profile-questions)",
    ),
    "legacy state/scratch / journal/agent / state/profile-questions path under agent/",
  ],
  [legacyPattern("([\"'`/])_activity\\/"), "legacy state/activity/ path under _activity/"],
];

const offenders = [];
let scanned = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (EXCLUDED_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(abs);
      continue;
    }
    const rel = relative(ROOT, abs);
    if (EXCLUDED_FILES.has(rel)) continue;
    if (EXCLUDED_REL_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) {
      continue;
    }
    const ext = extname(abs);
    if (!SCAN_EXTENSIONS.has(ext)) continue;
    scanFile(abs, rel);
  }
}

/**
 * Test files (`.test.ts` / `.test.tsx`) often exercise the alias
 * resolver by sending legacy paths through the API and asserting the
 * canonical target. That is *expected* drift — there is no benefit to
 * forcing every test to be cleaned up, and many tests would lose their
 * regression value without the legacy string. The scan skips these
 * extensions entirely; production code is unaffected.
 */
function isTestFile(relPath) {
  return /\.test\.(ts|tsx|js|mjs)$/.test(relPath);
}

const FILE_OPTOUT_MARKER = /drift-allow-file/;
const LINE_OPTOUT_MARKER = /drift-allow/;

function scanFile(absPath, relPath) {
  if (isTestFile(relPath)) return;
  let content;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    return;
  }
  scanned += 1;
  // Per-file opt-out — first ~30 lines, so the marker must be near the
  // top to be discoverable by readers.
  const head = content.split("\n", 30).join("\n");
  if (FILE_OPTOUT_MARKER.test(head)) return;

  const lines = content.split("\n");
  for (const [pattern, label] of LEGACY_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const before = content.slice(0, m.index);
      const lineNumber = before.split("\n").length;
      // Per-line opt-out — the offending line itself can declare it.
      const lineText = lines[lineNumber - 1] ?? "";
      if (LINE_OPTOUT_MARKER.test(lineText)) continue;
      offenders.push({ file: relPath, line: lineNumber, match: m[0], label });
    }
  }
}

try {
  for (const root of SCAN_ROOTS) {
    const abs = join(ROOT, root);
    walk(abs);
  }
} catch (err) {
  console.error("scan failed:", err);
  process.exit(2);
}

if (jsonMode) {
  console.log(JSON.stringify({ scanned, offenders }, null, 2));
} else {
  if (offenders.length === 0) {
    console.log(`vault-path drift: clean (${scanned} files scanned)`);
  } else {
    console.error(`vault-path drift detected (${offenders.length} matches across ${scanned} files):`);
    for (const o of offenders.slice(0, 50)) {
      console.error(`  ${o.file}:${o.line}: ${o.match}  — ${o.label}`);
    }
    if (offenders.length > 50) {
      console.error(`  ... and ${offenders.length - 50} more`);
    }
  }
}

process.exit(offenders.length === 0 ? 0 : 1);

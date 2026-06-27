#!/usr/bin/env node
/**
 * Legacy vault-path rewriter for the CONTEXT_VAULT_REDESIGN PR-6 + PR-7
 * sweep. Translates the legacy vault paths that survive in shipped
 * task-flow / skill prose and dashboard labels to their canonical
 * post-restructure forms.
 *
 * The runtime alias resolver (`packages/daemon/src/core/context-vault-aliases.ts`)
 * makes the daemon work today either way — this script's only job is to
 * silence the alias by rewriting the visible source. The alias is
 * documented as a "one minor release" bridge; this rewrite must land
 * before that minor expires.
 *
 * Strategy:
 *   - Walk a hand-curated allowlist of roots (agent-assets/, packages/dashboard/src/).
 *   - For each file, match a longest-first list of (legacy, canonical)
 *     prefix pairs in quoted / path-like contexts. Same shape as
 *     `scripts/check-vault-path-drift.mjs` LEGACY_PATTERNS but with a
 *     replacement on each match.
 *   - Write back only if anything changed.
 *
 * Safety:
 *   - Default is --dry-run; --apply writes.
 *   - Print a diff per file in dry-run mode (head/tail snippets).
 *   - Excludes the alias resolver itself and the migration runner — they
 *     legitimately reference legacy paths.
 *
 * Usage:
 *   node scripts/rewrite-legacy-vault-paths.mjs               # dry-run
 *   node scripts/rewrite-legacy-vault-paths.mjs --apply       # rewrite
 *   node scripts/rewrite-legacy-vault-paths.mjs --paths agent-assets/task-flows
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(fileURLToPath(import.meta.url), "..", ".."));

// Default scan roots. Override via --paths (comma-separated).
const DEFAULT_SCAN_ROOTS = [
  "agent-assets",
  "packages/dashboard/src",
];

const EXCLUDED_FILES = new Set([
  // Drift guard + design docs that intentionally describe legacy paths.
  "scripts/check-vault-path-drift.mjs",
  "scripts/rewrite-legacy-vault-paths.mjs",
  "CONTEXT_VAULT_REDESIGN_PLAN.md",
]);
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "__snapshots__",
]);
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".json"]);

/**
 * Substitution rules. Each entry is `{ re, sub }`:
 *   - `re` matches the LEGACY path in a path-context. Patterns mirror
 *     `scripts/check-vault-path-drift.mjs:LEGACY_PATTERNS` so the
 *     rewriter only fires where the drift scanner would flag drift.
 *     Capture group 1 is the preceding delimiter (quote or `/`), which
 *     is preserved verbatim in the substitution.
 *   - `sub` is the replacement format string. `$1` = preserved delimiter.
 *
 * Rules are applied top-to-bottom. List compound prefixes before their
 * containing generic prefixes (`rules/policies/` before `rules/`) so
 * the rewrite is greedy-correct without sort-by-length gymnastics.
 */
const RULES = [
  // Compound — must run before the generic `rules/` rule.
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])rules\/policies\b/g,
    sub: "$1policies/management-captures",
    note: "rules/policies/ → policies/management-captures/",
  },
  // agent/journal{.md,/...} → journal/agent
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])agent\/journal\b/g,
    sub: "$1journal/agent",
    note: "agent/journal* → journal/agent*",
  },
  // agent/scratch/ → state/scratch/
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])agent\/scratch\b/g,
    sub: "$1state/scratch",
    note: "agent/scratch* → state/scratch*",
  },
  // agent/profile-questions* → state/profile-questions*
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])agent\/profile-questions\b/g,
    sub: "$1state/profile-questions",
    note: "agent/profile-questions* → state/profile-questions*",
  },
  // Generic prefixes — same suffix vocabulary as the drift scanner.
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])user\/(?=profile|people|work|expertise|personal|goals|_index)/g,
    sub: "$1identity/",
    note: "user/{known} → identity/{known}",
  },
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])rules\/(?=management|mcp|redaction|journal-format|journal-export|_index)/g,
    sub: "$1policies/",
    note: "rules/{known} → policies/{known}",
  },
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])routines\/(?=morning|evening|hourly|activity-scan|weekly|monthly|custom|_index)/g,
    sub: "$1policies/routines/",
    note: "routines/{known} → policies/routines/{known}",
  },
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])projects\/(?=_active|_index|[a-z][a-z0-9-]*[\w./])/g,
    sub: "$1plans/projects/",
    note: "projects/{slug|_active|_index} → plans/projects/...",
  },
  // Dated journal files — the [0-9] suffix is the drift signal.
  { re: /(?<![A-Za-z0-9_-])(["'`/])daily\/(?=[0-9])/g, sub: "$1journal/daily/", note: "daily/<date> → journal/daily/<date>" },
  { re: /(?<![A-Za-z0-9_-])(["'`/])weekly\/(?=[0-9])/g, sub: "$1journal/weekly/", note: "weekly/<date> → journal/weekly/<date>" },
  { re: /(?<![A-Za-z0-9_-])(["'`/])monthly\/(?=[0-9])/g, sub: "$1journal/monthly/", note: "monthly/<date> → journal/monthly/<date>" },
  // Knowledge / state subtrees.
  { re: /(?<![A-Za-z0-9_-])(["'`/])dossiers\//g, sub: "$1knowledge/dossiers/", note: "dossiers/ → knowledge/dossiers/" },
  { re: /(?<![A-Za-z0-9_-])(["'`/])inbox\/(?=[0-9])/g, sub: "$1state/inbox/", note: "inbox/<date> → state/inbox/<date>" },
  { re: /(?<![A-Za-z0-9_-])(["'`/])_activity\//g, sub: "$1state/activity/", note: "_activity/ → state/activity/" },
  // Loose top-level files. Require `.md` suffix and a non-word boundary
  // after (end-of-string, quote, paren, slash) so `today.md.bak` is
  // ignored and bare prose like "today" stays untouched.
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])today\.md(?=$|["'`)\s,)\]])/gm,
    sub: "$1state/today.md",
    note: "today.md → state/today.md",
  },
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])yesterday\.md(?=$|["'`)\s,)\]])/gm,
    sub: "$1state/yesterday.md",
    note: "yesterday.md → state/yesterday.md",
  },
  {
    re: /(?<![A-Za-z0-9_-])(["'`/])roadmap\.md(?=$|["'`)\s,)\]])/gm,
    sub: "$1plans/roadmap.md",
    note: "roadmap.md → plans/roadmap.md",
  },
  // URL-shaped references inside `/api/context/<legacy>/` (skill
  // allowed-tools, curl examples, dashboard hrefs). The general rules
  // above reject these because the preceding `context/` ends with `t`
  // (a word char) which trips the lookbehind. These rules are
  // explicit-prefix and unambiguous.
  {
    re: /\/api\/context\/rules\/policies\b/g,
    sub: "/api/context/policies/management-captures",
    note: "/api/context/rules/policies → /api/context/policies/management-captures",
  },
  {
    re: /\/api\/context\/agent\/journal\b/g,
    sub: "/api/context/journal/agent",
    note: "/api/context/agent/journal → /api/context/journal/agent",
  },
  {
    re: /\/api\/context\/agent\/scratch\b/g,
    sub: "/api/context/state/scratch",
    note: "/api/context/agent/scratch → /api/context/state/scratch",
  },
  {
    re: /\/api\/context\/agent\/profile-questions\b/g,
    sub: "/api/context/state/profile-questions",
    note: "/api/context/agent/profile-questions → /api/context/state/profile-questions",
  },
  {
    re: /\/api\/context\/user\/(?=profile|people|work|expertise|personal|goals|_index)/g,
    sub: "/api/context/identity/",
    note: "/api/context/user/{known} → /api/context/identity/{known}",
  },
  {
    re: /\/api\/context\/rules\/(?=management|mcp|redaction|journal-format|journal-export|_index)/g,
    sub: "/api/context/policies/",
    note: "/api/context/rules/{known} → /api/context/policies/{known}",
  },
  {
    re: /\/api\/context\/routines\/(?=morning|evening|hourly|activity-scan|weekly|monthly|custom|_index)/g,
    sub: "/api/context/policies/routines/",
    note: "/api/context/routines/{known} → /api/context/policies/routines/{known}",
  },
  {
    re: /\/api\/context\/projects\/(?=_active|_index|[a-z][a-z0-9-]*[\w./])/g,
    sub: "/api/context/plans/projects/",
    note: "/api/context/projects/{slug|_active|_index} → /api/context/plans/projects/...",
  },
  { re: /\/api\/context\/daily\/(?=[0-9])/g, sub: "/api/context/journal/daily/", note: "" },
  { re: /\/api\/context\/weekly\/(?=[0-9])/g, sub: "/api/context/journal/weekly/", note: "" },
  { re: /\/api\/context\/monthly\/(?=[0-9])/g, sub: "/api/context/journal/monthly/", note: "" },
  { re: /\/api\/context\/dossiers\//g, sub: "/api/context/knowledge/dossiers/", note: "" },
  { re: /\/api\/context\/inbox\/(?=[0-9])/g, sub: "/api/context/state/inbox/", note: "" },
  { re: /\/api\/context\/_activity\//g, sub: "/api/context/state/activity/", note: "" },
  { re: /\/api\/context\/today\.md\b/g, sub: "/api/context/state/today.md", note: "" },
  { re: /\/api\/context\/today\b(?!\.)/g, sub: "/api/context/state/today", note: "" },
  { re: /\/api\/context\/yesterday\.md\b/g, sub: "/api/context/state/yesterday.md", note: "" },
  { re: /\/api\/context\/yesterday\b(?!\.)/g, sub: "/api/context/state/yesterday", note: "" },
  { re: /\/api\/context\/roadmap\.md\b/g, sub: "/api/context/plans/roadmap.md", note: "" },
  { re: /\/api\/context\/roadmap\b(?!\.)/g, sub: "/api/context/plans/roadmap", note: "" },
];

function parseArgs(argv) {
  const opts = { apply: false, paths: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--dry-run") opts.apply = false;
    else if (a === "--paths") opts.paths = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "Usage: rewrite-legacy-vault-paths.mjs [--apply] [--paths a,b,c] [--json]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(1);
    }
  }
  return opts;
}

function* walk(rootRel, root) {
  const absRoot = join(root, rootRel);
  let entries;
  try {
    entries = readdirSync(absRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (EXCLUDED_DIRS.has(ent.name)) continue;
    const childRel = join(rootRel, ent.name);
    if (EXCLUDED_FILES.has(childRel)) continue;
    if (ent.isDirectory()) {
      yield* walk(childRel, root);
    } else if (ent.isFile()) {
      const ext = extname(ent.name);
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      yield childRel;
    }
  }
}

function rewriteContent(content) {
  let out = content;
  let count = 0;
  for (const rule of RULES) {
    // Re-anchor the regex each iteration; the global flag persists state
    // across `replace` calls on shared regex objects.
    const re = new RegExp(rule.re.source, rule.re.flags);
    out = out.replace(re, (match, delim) => {
      count += 1;
      // Rules with no capture group (the explicit /api/context/ URL
      // rules below) pass `undefined` for delim. Substitute literally.
      return delim === undefined ? rule.sub : rule.sub.replace("$1", delim);
    });
  }
  return { out, count };
}

function diffPreview(orig, next) {
  // Tiny per-line diff so the dry-run output is scannable. Only shows
  // the first 6 changed lines per file.
  const origLines = orig.split("\n");
  const nextLines = next.split("\n");
  const max = Math.max(origLines.length, nextLines.length);
  const changes = [];
  for (let i = 0; i < max && changes.length < 6; i++) {
    if (origLines[i] !== nextLines[i]) {
      changes.push({ line: i + 1, before: origLines[i] ?? "", after: nextLines[i] ?? "" });
    }
  }
  return changes;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scanRoots = opts.paths
    ? opts.paths.split(",").map((p) => p.trim()).filter(Boolean)
    : DEFAULT_SCAN_ROOTS;

  const reports = [];
  let totalChanges = 0;
  let filesChanged = 0;
  let filesScanned = 0;

  for (const r of scanRoots) {
    for (const rel of walk(r, ROOT)) {
      filesScanned += 1;
      const abs = join(ROOT, rel);
      let raw;
      try {
        raw = readFileSync(abs, "utf-8");
      } catch (err) {
        process.stderr.write(`read failed: ${rel}: ${err}\n`);
        continue;
      }
      const { out, count } = rewriteContent(raw);
      if (count === 0) continue;
      filesChanged += 1;
      totalChanges += count;
      const preview = diffPreview(raw, out);
      reports.push({ file: rel, count, preview });
      if (opts.apply) {
        writeFileSync(abs, out, "utf-8");
      }
    }
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { filesScanned, filesChanged, totalChanges, reports },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write(
    `${opts.apply ? "APPLIED" : "DRY-RUN"}: ${filesChanged} files / ${totalChanges} substitutions (scanned ${filesScanned})\n\n`,
  );
  for (const r of reports.slice(0, 25)) {
    process.stdout.write(`${r.file} (${r.count} change${r.count === 1 ? "" : "s"})\n`);
    for (const c of r.preview) {
      process.stdout.write(`  L${c.line}\n`);
      process.stdout.write(`    - ${c.before.length > 120 ? c.before.slice(0, 120) + "…" : c.before}\n`);
      process.stdout.write(`    + ${c.after.length > 120 ? c.after.slice(0, 120) + "…" : c.after}\n`);
    }
    process.stdout.write("\n");
  }
  if (reports.length > 25) {
    process.stdout.write(`… and ${reports.length - 25} more files (re-run with --json for the full list)\n`);
  }
  if (!opts.apply) {
    process.stdout.write("\nRun with --apply to write.\n");
  }
}

main();

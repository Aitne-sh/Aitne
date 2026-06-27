#!/usr/bin/env node
// DASHBOARD_UI_REFRESH_DESIGN.md follow-up #4 — hardcoded-color static guard.
//
// Fails (exit 1) if any dashboard source file uses a hardcoded Tailwind
// *status-hue* utility (red / emerald / green / amber / yellow / blue with a
// numeric shade) instead of the theme tokens introduced by the UI refresh:
//
//   red            → destructive
//   emerald, green → success
//   amber, yellow  → warning
//   blue           → primary
//
// Tokens are theme-aware (light/dark variants live in globals.css @theme /
// .dark), so a tokenized class also replaces its `dark:` twin. House style
// for derived shades: `/40` borders, `/5`–`/10` washes, `/15` pills.
//
// Deliberately NOT matched:
//   - non-status hues (violet, sky, teal, …) — decorative accents are fine
//   - bare `text-white` / `bg-black` etc. — no shade digit, no status intent
//   - hex/oklch literals in chart configs — out of scope for this guard
//
// Escape hatch: a line containing the marker comment
//   hardcoded-color-ok
// is skipped — use it for genuine data-viz scales that cannot derive from a
// token, and say why in the comment.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const searchRoot = resolve(root, "packages/dashboard/src");

if (!existsSync(searchRoot)) {
  console.error(`check-dashboard-colors: ${searchRoot} does not exist`);
  process.exit(1);
}

// Any variant chain (dark:, hover:, md:, group-hover:, …) followed by a
// color-bearing utility, a status hue, and a numeric shade. `\d` is what
// separates `bg-red-500` (blocked) from `bg-destructive` (fine).
const PATTERN = String.raw`\b(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|divide|shadow|accent|caret|placeholder)-(?:red|emerald|green|amber|yellow|blue)-\d+`;

const MARKER = "hardcoded-color-ok";

let rgOutput = "";
try {
  rgOutput = execFileSync(
    "rg",
    [
      "--no-heading",
      "--line-number",
      "--with-filename",
      "--pcre2",
      "--glob", "*.ts",
      "--glob", "*.tsx",
      PATTERN,
      searchRoot,
    ],
    { encoding: "utf-8" },
  );
} catch (err) {
  // rg exits 1 on "no matches" — that is the success case.
  if (err.status === 1 && !err.stdout) {
    console.log("check-dashboard-colors: OK (no hardcoded status colors)");
    process.exit(0);
  }
  // rg exited 2 (real error, e.g. binary missing) — surface it.
  if (err.status !== 1) {
    console.error(`check-dashboard-colors: rg failed: ${err.message}`);
    process.exit(1);
  }
  rgOutput = err.stdout ?? "";
}

const violations = rgOutput
  .split("\n")
  .filter((line) => line.trim() !== "")
  .filter((line) => !line.includes(MARKER));

if (violations.length === 0) {
  console.log("check-dashboard-colors: OK (no hardcoded status colors)");
  process.exit(0);
}

console.error(
  `check-dashboard-colors: ${violations.length} hardcoded status-color class(es) found.`,
);
console.error(
  "Use the theme tokens instead — red→destructive, emerald/green→success, amber/yellow→warning, blue→primary",
);
console.error(
  `(or append a '${MARKER}' comment with a justification for data-viz scales):\n`,
);
for (const v of violations) console.error(`  ${v}`);
process.exit(1);

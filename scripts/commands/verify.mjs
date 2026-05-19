/**
 * `aitne verify <target>` — post-launch verification for shipped design
 * surfaces. Each target bundles a small set of pass/warn/fail checks an
 * operator runs once after a rollout to confirm the change actually
 * delivered what it promised.
 *
 * Targets:
 *   - `evening-review-slimdown` — Phase 4 of
 *     `docs/design/appendices/evening-review-slimdown.md`. Confirms the
 *     four post-launch invariants the doc lists (cron audit freshness,
 *     token-envelope drop, conditional notify load, 30-day notify
 *     invocation sample).
 *
 * Verify is read-only and offline. No daemon HTTP call, no DB writes,
 * no network. Safe to run while the daemon is up (the daemon enables
 * WAL — concurrent readers are fine) or while it is stopped (we open
 * the SQLite file in readonly mode).
 *
 * The check logic itself lives in
 * `packages/daemon/src/core/evening-review-verify.ts` so the rulebook
 * predicate is reused verbatim from the daemon (no drift risk) and the
 * checks are unit-testable under the daemon's coverage gate. This file
 * is a thin CLI wrapper: parse args → resolve contextDir → call the
 * typed runner → render.
 *
 * Exit codes:
 *   0   every check returned pass or warn
 *   1   at least one check returned fail
 *   2   argument error / unknown target
 *   3   the SQLite file or daemon dist is missing
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KNOWN_TARGETS = new Set(["evening-review-slimdown"]);

export async function run(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const opts = parseArgs(args);

  if (!KNOWN_TARGETS.has(opts.target)) {
    process.stderr.write(`Unknown verify target: ${opts.target}\n`);
    process.stderr.write(`Available targets: ${[...KNOWN_TARGETS].join(", ")}\n`);
    process.exit(2);
  }

  const dbPath = path.join(ctx.DATA_DIR, "data", "personal_agent.db");
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(
      `SQLite file not found at ${dbPath}.\n` +
        `Has the daemon been started? Run \`aitne start\` first.\n`,
    );
    process.exit(3);
  }

  const verifyMod = await loadVerifyModule(ctx.PROJECT_ROOT);
  if (!verifyMod) {
    process.stderr.write(
      "Daemon dist is missing — `packages/daemon/dist/core/evening-review-verify.js` " +
        "did not resolve.\nRun `aitne build` first (or `aitne start`, which builds " +
        "if stale).\n",
    );
    process.exit(3);
  }

  const { loadBetterSqlite3 } = await import("../lib/sqlite-loader.mjs");
  const Database = await loadBetterSqlite3(ctx.PROJECT_ROOT);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  let report;
  try {
    const contextDir = verifyMod.resolveContextDirFromDb(db, ctx.DATA_DIR);
    report = verifyMod.runEveningReviewSlimdownChecks({
      db,
      contextDir,
      windowDays: opts.days,
    });
  } finally {
    db.close();
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(report.summary.failed > 0 ? 1 : 0);
  }

  printReport(opts.target, report, ctx);
  process.exit(report.summary.failed > 0 ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = {
    target: "evening-review-slimdown",
    days: 7,
    json: false,
  };

  let positional = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (a === "--days") {
      if (i + 1 >= args.length) {
        process.stderr.write("--days requires a value\n");
        process.exit(2);
      }
      const raw = args[++i];
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 365) {
        process.stderr.write(`--days must be a positive integer ≤ 365 (got: ${raw})\n`);
        process.exit(2);
      }
      opts.days = n;
      continue;
    }
    if (a.startsWith("-")) {
      process.stderr.write(`Unknown flag: ${a}\n`);
      process.stderr.write("See `aitne verify --help`.\n");
      process.exit(2);
    }
    if (positional !== null) {
      process.stderr.write(`Unexpected positional argument: ${a}\n`);
      process.exit(2);
    }
    positional = a;
  }
  if (positional !== null) opts.target = positional;
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────
// Daemon module + contextDir resolution
// ─────────────────────────────────────────────────────────────────────────

/**
 * Dynamically import the compiled `evening-review-verify` module from
 * the daemon's dist directory. Returns null when the dist is missing so
 * the caller can surface a clear "build first" hint instead of a stack
 * trace.
 *
 * Three resolution paths cover every shipping shape:
 *
 *   1. Workspace dev — pnpm symlinks `node_modules/@aitne/daemon` →
 *      `packages/daemon`, so the compiled module sits under the repo's
 *      own `packages/daemon/dist/`. Direct filesystem path.
 *   2. Published install — `npm i -g @aitne-sh/aitne` installs
 *      `@aitne/daemon` as a sibling under `<install>/node_modules/`.
 *      The daemon's `package.json` only exports `.` (its barrel
 *      index), so `import("@aitne/daemon/core/...")` is blocked by
 *      Node's exports-field gate. Resolve the barrel via
 *      `import.meta.resolve("@aitne/daemon")` to get the daemon root,
 *      then reach the sibling file directly.
 *   3. Legacy flatten — historical install layout where `dist/` ended up
 *      at the project root. Kept as a last-resort fallback so a future
 *      build/publish change doesn't silently break this CLI.
 *
 * The barrel `index.ts` does NOT re-export this module by design —
 * verify is operator-tooling, not a daemon API surface — so we always
 * go through the filesystem path rather than `import("@aitne/daemon")`.
 */
async function loadVerifyModule(projectRoot) {
  const candidates = [
    // 1. Workspace dev (pnpm symlink).
    path.join(projectRoot, "packages/daemon/dist/core/evening-review-verify.js"),
  ];
  // 2. Published install — resolve via the daemon's own package root.
  try {
    const daemonMainUrl = import.meta.resolve("@aitne/daemon");
    const daemonMainPath = fileURLToPath(daemonMainUrl);
    candidates.push(
      path.join(path.dirname(daemonMainPath), "core/evening-review-verify.js"),
    );
  } catch {
    // @aitne/daemon not resolvable from this context — fall through to
    // the legacy candidate below.
  }
  // 3. Legacy flatten fallback (defensive).
  candidates.push(path.join(projectRoot, "dist/core/evening-review-verify.js"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return import(pathToFileURL(candidate).href);
    }
  }
  return null;
}

// ContextDir resolution lives in the typed daemon module
// (`resolveContextDirFromDb`) so the degraded-mode branch + tilde
// expansion are unit-tested in lockstep with `getContextDir`.

// ─────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────

function printReport(target, report, ctx) {
  console.log(`${ctx.APP_NAME} verify ${target} — ${report.checks.length} check(s)`);
  console.log("");
  const labelWidth = Math.max(...report.checks.map((c) => c.label.length));
  for (const c of report.checks) {
    const mark = c.status === "pass" ? "ok " : c.status === "warn" ? "warn" : "FAIL";
    const label = c.label.padEnd(labelWidth);
    console.log(`  [${mark}]  ${label}  ${c.detail}`);
    if (c.hint && c.status !== "pass") {
      console.log(`           ${" ".repeat(labelWidth)}  hint: ${c.hint}`);
    }
  }
  const { passed, warned, failed, windowDays, installAgeDays } = report.summary;
  console.log("");
  console.log(
    `${passed} ok · ${warned} warn · ${failed} fail · window ${windowDays}d · install age ~${installAgeDays}d`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Help
// ─────────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`Usage: aitne verify [target] [flags]

Run post-launch verification for a shipped design surface. Read-only —
no daemon HTTP call required, no DB writes, no network. Safe to invoke
any time.

Targets:
  evening-review-slimdown    (default)
        Phase 4 of docs/design/appendices/evening-review-slimdown.md.
        Bundles four checks:
          1. Daily 17:45 \`roadmap_mechanical_maintenance\` audit row.
          2. evening_review session envelope (cost / turns / tokens).
          3. Conditional notify load (resolveSkillManifest mirror).
          4. 30-day notify invocations attributable to evening_review.

Flags:
  --days <N>     Window for time-bounded checks (default 7, max 365).
                 Capped at install age automatically; the 30-day notify
                 sample uses min(30, install age) regardless.
  --json         Machine-readable output. Implies no terminal formatting.
  -h, --help     Print this message.

Exit codes:
  0   every check returned pass or warn
  1   at least one check returned fail
  2   argument error / unknown target
  3   SQLite file or daemon dist missing — run \`aitne start\` once first

Examples:
  aitne verify
  aitne verify evening-review-slimdown --days 14
  aitne verify --json | jq '.summary'
  aitne verify --json | jq '.checks[] | select(.status != "pass")'`);
}

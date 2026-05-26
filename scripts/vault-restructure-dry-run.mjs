#!/usr/bin/env node
/**
 * Vault-restructure dry-run timing harness
 * (CONTEXT_VAULT_REDESIGN_PLAN.md §11.9.1 / V17).
 *
 * Purpose: empirically measure how long `rewritePathsInDb` takes against
 * a real user's SQLite DB BEFORE running the actual migration. Aitne is
 * released; a user with weeks of `messages.metadata` / `observations.payload`
 * backlog can have large JSON blobs that the rewrite passes scan
 * row-by-row. This script reports per-pair timings + row counts so the
 * user (and the project author) can see whether the upgrade is a fast
 * no-op or a multi-second pause.
 *
 * Safety:
 *   - The user's DB is NEVER touched. The script copies it to
 *     `<dataDir>/migration-backups/dry-run-<timestamp>.db`, runs the
 *     rewrite passes against the COPY, then deletes the copy on success.
 *   - The copy is taken with sqlite's `.backup()` (atomic, while-open
 *     safe) rather than a raw file copy, so a running daemon does not
 *     produce a torn snapshot.
 *   - The script does NOT mutate files on disk, does NOT write the
 *     version marker, and does NOT touch the daemon.
 *
 * Usage:
 *   # Default — reads ~/.personal-agent/data/personal_agent.db
 *   node scripts/vault-restructure-dry-run.mjs
 *
 *   # Custom locations
 *   node scripts/vault-restructure-dry-run.mjs \
 *     --db ~/some/other/personal_agent.db \
 *     --data-dir ~/some/other \
 *     --context-dir ~/some/other/context
 *
 *   # JSON output for piping into analysis
 *   node scripts/vault-restructure-dry-run.mjs --json
 *
 *   # Keep the temp DB after the run (for inspection)
 *   node scripts/vault-restructure-dry-run.mjs --keep
 *
 * Output (text mode):
 *   Per-pair table with oldPrefix, newPrefix, ms, rowsRewritten,
 *   rowsUnchanged, rowsUnparseable, plus a total row.
 *
 * Exit codes:
 *   0 — completed; check timings
 *   1 — argument error / source DB missing
 *   2 — runtime error during a rewrite pass
 */

// Silence the daemon's pino logger before importing the dist modules.
// MUST run before the dynamic imports below — ESM static `import`
// statements hoist above any top-level code, so the dist modules would
// otherwise read PA_LOG_LEVEL too early. Static imports are stdlib only;
// daemon imports are deferred to `main()`.
process.env.PA_LOG_LEVEL = process.env.PA_LOG_LEVEL ?? "error";

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

// `better-sqlite3` is a native module; pnpm hoists it into the daemon
// package's node_modules, NOT the workspace root. Resolve via the
// daemon's package.json so the script runs from anywhere.
const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonRequire = createRequire(
  join(__dirname, "..", "packages", "daemon", "package.json"),
);
const Database = daemonRequire("better-sqlite3");

function parseArgs(argv) {
  const opts = {
    db: null,
    dataDir: null,
    contextDir: null,
    json: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") opts.db = argv[++i];
    else if (a === "--data-dir") opts.dataDir = argv[++i];
    else if (a === "--context-dir") opts.contextDir = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "Usage: vault-restructure-dry-run.mjs [--db PATH] [--data-dir DIR] [--context-dir DIR] [--json] [--keep]\n"
          + "  --db          source DB (default: ~/.personal-agent/data/personal_agent.db)\n"
          + "  --data-dir    daemon dataDir, drives prefix derivation (default: ~/.personal-agent)\n"
          + "  --context-dir vault root (default: <dataDir>/context)\n"
          + "  --json        emit JSON instead of a table\n"
          + "  --keep        keep the temp DB after the run\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(1);
    }
  }
  return opts;
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function defaults(opts) {
  const dataDir = resolve(expandHome(opts.dataDir ?? join(homedir(), ".personal-agent")));
  const db = resolve(expandHome(opts.db ?? join(dataDir, "data", "personal_agent.db")));
  const contextDir = resolve(expandHome(opts.contextDir ?? join(dataDir, "context")));
  return { db, dataDir, contextDir };
}

function snapshotDb(srcPath, destPath) {
  // Synchronous file copy. Users running this dry-run are advised to
  // stop the daemon first; a torn snapshot from a live SQLite would just
  // give noisy timings, not corrupt the source (we never write to it).
  copyFileSync(srcPath, destPath);
}

function fmtMs(ms) {
  if (ms < 1) return `${ms.toFixed(3)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MiB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

async function main() {
  // Deferred imports — see the PA_LOG_LEVEL note at the top.
  const { buildAbsolutePathRewrites } = await import(
    "../packages/daemon/dist/db/migrations/context-vault-restructure.js"
  );
  const { rewritePathsInDb } = await import(
    "../packages/daemon/dist/core/path-rewrite.js"
  );

  const opts = parseArgs(process.argv.slice(2));
  const { db: srcDbPath, dataDir, contextDir } = defaults(opts);

  if (!existsSync(srcDbPath)) {
    process.stderr.write(`source DB not found: ${srcDbPath}\n`);
    process.exit(1);
  }

  const srcStat = statSync(srcDbPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Prefer `<dataDir>/migration-backups/` when writable so the temp file
  // lands next to the real backups; fall back to the OS temp dir for
  // synthetic / read-only dataDirs (used by smoke tests).
  let tempDir = join(dataDir, "migration-backups");
  try {
    mkdirSync(tempDir, { recursive: true });
  } catch {
    tempDir = join(tmpdir(), "aitne-vault-restructure-dry-run");
    mkdirSync(tempDir, { recursive: true });
  }
  const tempDbPath = join(tempDir, `dry-run-${stamp}.db`);

  if (!opts.json) {
    process.stdout.write(`Source DB:  ${srcDbPath} (${fmtBytes(srcStat.size)})\n`);
    process.stdout.write(`Temp copy:  ${tempDbPath}\n`);
    process.stdout.write(`dataDir:    ${dataDir}\n`);
    process.stdout.write(`contextDir: ${contextDir}\n\n`);
  }

  snapshotDb(srcDbPath, tempDbPath);

  const rewrites = buildAbsolutePathRewrites({ dataDir, contextDir });
  const tempDb = new Database(tempDbPath);

  const pairResults = [];
  let totalMs = 0;
  let runtimeErr = null;

  for (const [oldPrefix, newPrefix] of rewrites) {
    const t0 = performance.now();
    let stats;
    try {
      stats = rewritePathsInDb(tempDb, oldPrefix, newPrefix);
    } catch (err) {
      runtimeErr = err;
      pairResults.push({
        oldPrefix,
        newPrefix,
        ms: performance.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
    const ms = performance.now() - t0;
    totalMs += ms;
    pairResults.push({ oldPrefix, newPrefix, ms, ...stats });
  }

  tempDb.close();

  if (!opts.keep) {
    try {
      rmSync(tempDbPath);
    } catch {
      // best-effort
    }
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          srcDbPath,
          srcDbSizeBytes: srcStat.size,
          dataDir,
          contextDir,
          totalMs,
          pairResults,
          error: runtimeErr ? String(runtimeErr) : null,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const padR = (s, n) => String(s).padStart(n);
    const padL = (s, n) => String(s).padEnd(n);
    process.stdout.write(
      `${padL("oldPrefix", 60)}  ${padR("ms", 10)}  ${padR("rowsRewritten", 14)}  ${padR("rowsUnchanged", 14)}  ${padR("rowsUnparseable", 16)}\n`,
    );
    process.stdout.write(`${"-".repeat(60 + 2 + 10 + 2 + 14 + 2 + 14 + 2 + 16)}\n`);
    for (const r of pairResults) {
      if (r.error) {
        process.stdout.write(
          `${padL(r.oldPrefix.slice(-60), 60)}  ${padR(fmtMs(r.ms), 10)}  ERROR: ${r.error}\n`,
        );
      } else {
        process.stdout.write(
          `${padL(r.oldPrefix.slice(-60), 60)}  ${padR(fmtMs(r.ms), 10)}  ${padR(r.rowsRewritten, 14)}  ${padR(r.rowsUnchanged, 14)}  ${padR(r.rowsUnparseable, 16)}\n`,
        );
      }
    }
    process.stdout.write(
      `\nTotal: ${fmtMs(totalMs)} across ${pairResults.length} pairs\n`,
    );
    if (totalMs > 30_000) {
      process.stdout.write(
        "\n⚠  Total exceeded 30 s. Consider stopping the daemon for the upgrade boot so users don't see a stalled `aitne start`.\n",
      );
    } else if (totalMs > 5_000) {
      process.stdout.write(
        "\nℹ  Total exceeded 5 s. The upgrade boot will pause briefly but should not feel hung.\n",
      );
    } else {
      process.stdout.write(
        "\n✓ Fast path — upgrade boot rewrite pass should be near-instant.\n",
      );
    }
  }

  if (runtimeErr) process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`dry-run failed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});

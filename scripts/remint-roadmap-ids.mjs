#!/usr/bin/env node
// Re-mint fabricated roadmap-entry IDs in roadmap.md.
//
// Background: when `POST /api/context/roadmap/id` is misclassified
// (e.g. the 2026-04-28 incident where it landed in the default-Approve
// fail-closed bucket), the agent's `roadmap_refresh` task-flow falls
// through to inventing IDs inline. Sonnet's typical fabrications follow
// an obvious `[0-9][a-f][0-9][a-f][0-9][a-f]` alternation pattern
// (`1a2b3c`, `4d5e6f`, `0d1e2f`, …) instead of the daemon's randomly
// distributed `[a-f0-9]{6}`. Even after the underlying classifier bug
// is patched, those fabricated IDs persist in roadmap.md because the
// task-flow's "merge-by-id" rule preserves existing entries verbatim.
//
// This script:
//   1. Reads the active vault's `roadmap.md` via the daemon API.
//   2. Detects fabricated IDs by the alternation heuristic (or all
//      IDs when `--all` is set).
//   3. Mints a fresh daemon-owned ID for each via
//      `POST /api/context/roadmap/id`.
//   4. Rewrites the file via `PUT /api/context/roadmap`.
//
// The mint endpoint (now Autonomous) does not require auth, but PUT
// does — the script reads the bearer token from the OS secret store
// (macOS Keychain / Windows DPAPI / Linux libsecret / encrypted file)
// via the shared cross-platform reader, the same place the daemon stores it.
//
// Usage:
//   node scripts/remint-roadmap-ids.mjs            # detect + remint
//   node scripts/remint-roadmap-ids.mjs --dry-run  # print plan only
//   node scripts/remint-roadmap-ids.mjs --all      # remint every id
//   node scripts/remint-roadmap-ids.mjs --port 8321 # override port
//
// Other vault files (agent-journal.md, dossiers/roadmap.md, project
// notes) are NOT rewritten — the script logs every replacement so the
// operator can grep their vault for stale references.
//
// IMPORTANT: the live mint+PUT path has only been exercised via
// `--dry-run` — back up the vault (or rely on the daemon's snapshot
// table) before running without `--dry-run`. Live execution requires
// `--yes` to avoid accidental writes.

import { readApiToken as readApiTokenFromStore } from "./lib/read-api-token.mjs";
import { argv, exit } from "node:process";

// Heuristic mirror of `looksFabricatedRoadmapId` in
// packages/daemon/src/core/roadmap-ids.ts (kept inline so the script
// has no dist dependency). Unit-tested in roadmap-ids.test.ts; if you
// change the regex below, update both sites.
const ROADMAP_ID_RE = /^rm-\d{8}-[a-f0-9]{6}$/;
const ROADMAP_ID_COMMENT_RE = /<!--\s*id:\s*(rm-\d{8}-[a-f0-9]{6})\s*-->/g;
const FABRICATED_SUFFIX_RE = /^[0-9][a-f][0-9][a-f][0-9][a-f]$/;

function parseArgs(args) {
  const opts = { dryRun: false, all: false, port: 8321, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--port") opts.port = Number(args[++i]);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: remint-roadmap-ids.mjs [--dry-run] [--all] [--yes] [--port N]\n"
          + "  --dry-run  print plan, do not write\n"
          + "  --all      remint every id (default: only fabricated-looking ones)\n"
          + "  --yes      required to perform live writes (omit for dry-run safety)\n"
          + "  --port N   override daemon port (default 8321)\n",
      );
      exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      exit(2);
    }
  }
  return opts;
}

function readApiToken() {
  const token = readApiTokenFromStore();
  if (!token) {
    process.stderr.write(
      "Failed to read the daemon API token from the OS secret store.\n",
    );
    process.stderr.write(
      "(The script needs the daemon's apiToken to PUT the rewritten roadmap.)\n",
    );
    exit(1);
  }
  return token;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} → ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function suffixOf(id) {
  // `rm-YYYYMMDD-xxxxxx` → `xxxxxx`
  const dash = id.lastIndexOf("-");
  return dash >= 0 ? id.slice(dash + 1) : id;
}

function looksFabricated(id) {
  return FABRICATED_SUFFIX_RE.test(suffixOf(id));
}

function findIdsInBody(body) {
  const ids = new Set();
  for (const m of body.matchAll(ROADMAP_ID_COMMENT_RE)) ids.add(m[1]);
  return [...ids];
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (!opts.dryRun && !opts.yes) {
    process.stderr.write(
      "Live execution requires --yes (or use --dry-run to preview). Refusing to write.\n",
    );
    exit(2);
  }
  const base = `http://127.0.0.1:${opts.port}`;
  const token = readApiToken();

  // 1. Read current roadmap.md (Bearer covers both ReadSensitive and
  //    Approve tiers, so we always send it).
  const authHeaders = { Authorization: `Bearer ${token}` };
  const roadmap = await fetchJson(`${base}/api/context/roadmap`, {
    headers: authHeaders,
  }).catch((err) => {
    process.stderr.write(`Failed to read roadmap.md: ${err.message}\n`);
    exit(1);
  });
  const body =
    typeof roadmap === "object" && roadmap !== null && "content" in roadmap
      ? String(roadmap.content)
      : String(roadmap);

  const allIds = findIdsInBody(body);
  if (allIds.length === 0) {
    process.stdout.write("No roadmap IDs found in roadmap.md — nothing to do.\n");
    return;
  }

  const targets = opts.all
    ? allIds.filter((id) => ROADMAP_ID_RE.test(id))
    : allIds.filter(looksFabricated);

  if (targets.length === 0) {
    process.stdout.write(
      `Scanned ${allIds.length} ID(s). None match the fabrication heuristic. Use --all to force re-mint.\n`,
    );
    return;
  }

  process.stdout.write(
    opts.all
      ? `Re-minting all ${targets.length} ID(s) (--all flag set):\n`
      : `Found ${targets.length} fabricated-looking ID(s) (of ${allIds.length} total):\n`,
  );
  for (const id of targets) process.stdout.write(`  - ${id}\n`);

  // 2. Mint replacements (daemon refuses to mint a duplicate against
  //    the live file, so we feed it the IDs already in flight to
  //    avoid collisions when it scans).
  const mapping = new Map();
  for (const oldId of targets) {
    if (opts.dryRun) {
      mapping.set(oldId, "<would mint>");
      continue;
    }
    const minted = await fetchJson(`${base}/api/context/roadmap/id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Body is intentionally empty — the mint endpoint defaults
      // creationDate to today, which is what we want for a re-mint.
      body: "{}",
    }).catch((err) => {
      process.stderr.write(`Mint failed for ${oldId}: ${err.message}\n`);
      exit(1);
    });
    if (!minted || typeof minted.id !== "string" || !ROADMAP_ID_RE.test(minted.id)) {
      process.stderr.write(`Mint returned malformed response for ${oldId}\n`);
      exit(1);
    }
    if ([...mapping.values()].includes(minted.id)) {
      // The daemon-side existingIds dedup only sees what's in the
      // file; back-to-back mint calls within the same script run
      // could collide. Retry once.
      process.stderr.write(`Mint collision on ${minted.id}, retrying…\n`);
      const retry = await fetchJson(`${base}/api/context/roadmap/id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      mapping.set(oldId, retry.id);
    } else {
      mapping.set(oldId, minted.id);
    }
  }

  process.stdout.write("\nPlanned replacements:\n");
  for (const [oldId, newId] of mapping)
    process.stdout.write(`  ${oldId}  →  ${newId}\n`);

  if (opts.dryRun) {
    process.stdout.write("\n[--dry-run] No file written.\n");
    return;
  }

  // 3. Substitute IDs in the body. Use a literal regex per ID so a
  //    fabricated ID that happens to be a substring of another ID
  //    (extremely unlikely given the date prefix but cheap to guard)
  //    can't double-replace.
  let updated = body;
  for (const [oldId, newId] of mapping) {
    const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    updated = updated.replace(new RegExp(escaped, "g"), newId);
  }

  // 4. PUT the rewritten roadmap.
  await fetchJson(`${base}/api/context/roadmap`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content: updated }),
  });

  process.stdout.write(
    `\nRewrote roadmap.md with ${mapping.size} re-minted ID(s).\n`,
  );
  process.stdout.write(
    "If other vault files (agent-journal.md, dossiers/, projects/) reference the old IDs above, grep + update them manually.\n",
  );
}

main().catch((err) => {
  process.stderr.write(`Unhandled error: ${err.stack ?? err.message}\n`);
  exit(1);
});

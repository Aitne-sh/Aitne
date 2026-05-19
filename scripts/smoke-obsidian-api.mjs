#!/usr/bin/env node
/**
 * In-process smoke test for the Obsidian API routes.
 *
 * Purpose: verify empirically that the new PUT/DELETE endpoints — and
 * the `path=` CLI semantics they rely on — actually work against the
 * real Obsidian CLI and a real vault. The vitest suite mocks the
 * ObsidianService entirely, so it cannot catch wrong argument names,
 * missing CLI flags, or vault-level semantic mismatches.
 *
 * Strategy: mount the freshly-built routes against a real
 * ObsidianService pointing at the real vault, then drive the full
 * CRUD lifecycle via Hono's in-process `app.request`. No daemon
 * restart, no network, no port conflict.
 *
 * Safety:
 *   - All writes target a single `__smoketest_obsidian_api.md` path
 *     prefixed with `__` so it's visually obvious in the vault.
 *   - The lifecycle ends with DELETE, so a successful run leaves no
 *     residue.
 *   - On any failure we attempt a best-effort DELETE before exiting.
 */

import { createObsidianRoutes } from "../packages/daemon/dist/api/routes/obsidian.js";
import { ObsidianService } from "../packages/daemon/dist/services/obsidian.js";

const TEST_PATH = "__smoketest_obsidian_api";
const VAULT_PATH =
  process.env.PA_EXTERNAL_OBSIDIAN_VAULT_PATH ??
  process.env.PA_OBSIDIAN_VAULT_PATH ??
  "/Users/test/Library/Mobile Documents/iCloud~md~obsidian/Documents/personal-agent";
const VAULT_NAME =
  process.env.PA_EXTERNAL_OBSIDIAN_VAULT_NAME ??
  process.env.PA_OBSIDIAN_VAULT_NAME ??
  "personal-agent";

const config = {
  externalObsidianVaultPath: VAULT_PATH,
  externalObsidianVaultName: VAULT_NAME,
};

const service = new ObsidianService(config);
const app = createObsidianRoutes({ obsidianService: service });

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function request(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await app.request(path, init);
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function bestEffortCleanup() {
  try {
    await request("DELETE", `/obsidian/notes/${TEST_PATH}`);
  } catch {}
}

async function main() {
  console.log(`Vault: ${VAULT_PATH}`);
  console.log(`Test path: ${TEST_PATH}.md`);
  console.log();

  // --- Precondition: status ---
  console.log("1. Precondition");
  const status = await request("GET", "/obsidian/status");
  ok("status=200", status.status === 200);
  ok("available=true", status.json?.available === true, JSON.stringify(status.json));
  ok("obsidianRunning=true", status.json?.obsidianRunning === true, JSON.stringify(status.json));
  if (status.json?.obsidianRunning !== true) {
    console.error("\nObsidian app is not running — aborting smoke test.");
    process.exit(2);
  }

  // Make sure we start clean (in case a previous run crashed mid-lifecycle).
  await bestEffortCleanup();

  // --- Step 2: PUT creates a new note (idempotent create-or-replace) ---
  console.log("\n2. PUT create-path");
  const body1 = "# Smoke test v1\n\nLine A\n";
  const put1 = await request("PUT", `/obsidian/notes/${TEST_PATH}`, { content: body1 });
  ok("PUT status=200", put1.status === 200, `got ${put1.status} ${JSON.stringify(put1.json)}`);
  ok("PUT status field=updated", put1.json?.status === "updated");

  // --- Step 3: GET returns the created content ---
  console.log("\n3. GET read back");
  const get1 = await request("GET", `/obsidian/notes/${TEST_PATH}`);
  ok("GET status=200", get1.status === 200);
  ok(
    "GET content matches v1",
    typeof get1.json?.content === "string" && get1.json.content.includes("Line A"),
    `got ${JSON.stringify(get1.json?.content)?.slice(0, 80)}`,
  );

  // --- Step 4: PUT overwrites with new content ---
  console.log("\n4. PUT overwrite");
  const body2 = "# Smoke test v2\n\nLine B only\n";
  const put2 = await request("PUT", `/obsidian/notes/${TEST_PATH}`, { content: body2 });
  ok("PUT status=200", put2.status === 200);

  const get2 = await request("GET", `/obsidian/notes/${TEST_PATH}`);
  ok("GET status=200", get2.status === 200);
  ok(
    "GET content matches v2",
    typeof get2.json?.content === "string"
      && get2.json.content.includes("Line B only")
      && !get2.json.content.includes("Line A"),
    `got ${JSON.stringify(get2.json?.content)?.slice(0, 80)}`,
  );

  // --- Step 5: DELETE removes the note ---
  console.log("\n5. DELETE");
  const del1 = await request("DELETE", `/obsidian/notes/${TEST_PATH}`);
  ok("DELETE status=200", del1.status === 200, `got ${del1.status} ${JSON.stringify(del1.json)}`);
  ok("DELETE status field=deleted", del1.json?.status === "deleted");
  ok("DELETE permanent=false (default)", del1.json?.permanent === false);

  // --- Step 6: DELETE again → 404 (idempotent) ---
  console.log("\n6. DELETE idempotent 404");
  const del2 = await request("DELETE", `/obsidian/notes/${TEST_PATH}`);
  ok("Second DELETE status=404", del2.status === 404, `got ${del2.status} ${JSON.stringify(del2.json)}`);
  ok("error=not_found", del2.json?.error === "not_found");

  // --- Step 7: GET after delete → 404 ---
  console.log("\n7. GET after delete");
  const get3 = await request("GET", `/obsidian/notes/${TEST_PATH}`);
  ok("GET status=404", get3.status === 404, `got ${get3.status} ${JSON.stringify(get3.json)}`);

  // --- Summary ---
  console.log();
  console.log("─".repeat(48));
  console.log(`Passed: ${pass}   Failed: ${fail}`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("All smoke checks passed.");
}

main().catch(async (err) => {
  console.error("Smoke test threw:", err);
  await bestEffortCleanup();
  process.exit(1);
});

#!/usr/bin/env node
// Roadmap §2.5 / §9.2 — redaction static guard.
//
// Fails (exit 1) if any production source file outside the single
// permitted module (`auth-health-monitor.ts`) contains a raw SQL
// assignment to `auth_detail` or `last_error`. The permitted module
// owns the `writeAuthFailureDetail` / `writeAuthOkDetail` helpers,
// which apply `redactSensitiveString` unconditionally — every other
// caller is required to go through them.
//
// Exemptions:
//   - test files (*.test.ts)         — they seed raw fixtures, not
//                                       production writes
//   - `auth-health-monitor.ts`        — the helpers themselves
//
// A match prints file:line:matching-line and exits non-zero. The full
// scan runs in well under a second; it is intended to be wired into
// `pnpm test`'s preamble (or a CI step) so that a new offending write
// cannot silently land alongside a green test suite.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const searchRoot = resolve(root, "packages/daemon/src");

if (!existsSync(searchRoot)) {
  console.error(`check-redaction-coverage: ${searchRoot} does not exist`);
  process.exit(1);
}

// Pattern matches any assignment target `auth_detail =` or
// `last_error =`, regardless of placeholder style (`?` / `@name` /
// `:name` / `NULL` / literal). The rg -P flag uses PCRE so we can
// write a single union.
const PATTERN = String.raw`(auth_detail|last_error)\s*=`;

const EXEMPT_PATHS = new Set([
  "packages/daemon/src/core/backends/auth-health-monitor.ts",
  // `mail_accounts.last_error` is a separate column from the `backends`
  // table's `last_error` that the redaction helpers guard. The redaction
  // helper enforces scrubbing of model-auth detail strings; mail-poll
  // errors are IMAP/Graph status messages that never carry secrets
  // (credentials live in the encrypted blob store and are never inlined
  // into error text — see mail-poller.ts `handlePollError`).
  "packages/daemon/src/services/mail/account-registry.ts",
]);

let rgOutput = "";
try {
  rgOutput = execFileSync(
    "rg",
    [
      "--no-heading",
      "--line-number",
      "--with-filename",
      "--glob",
      "!**/*.test.ts",
      "--glob",
      "!**/*.d.ts",
      "-e",
      PATTERN,
      searchRoot,
    ],
    { encoding: "utf8" },
  );
} catch (err) {
  // rg exits 1 when there are zero matches — that is the success case.
  if (err.status === 1 && !err.stdout) {
    process.exit(0);
  }
  // rg exits 2 on actual errors. Surface them.
  console.error("check-redaction-coverage: rg failed");
  console.error(err.stderr?.toString() ?? err.message);
  process.exit(2);
}

const lines = rgOutput.split("\n").filter((line) => line.length > 0);
const offenders = [];
for (const line of lines) {
  // Each rg line is `absolute-path:line:content`. Convert to a repo
  // relative path so the exemption check is stable.
  const firstColon = line.indexOf(":");
  const secondColon = line.indexOf(":", firstColon + 1);
  if (firstColon < 0 || secondColon < 0) continue;
  const absPath = line.slice(0, firstColon);
  const relPath = relative(root, absPath).replace(/\\/g, "/");
  if (EXEMPT_PATHS.has(relPath)) continue;
  offenders.push(`${relPath}:${line.slice(firstColon + 1)}`);
}

if (offenders.length > 0) {
  console.error(
    "check-redaction-coverage: found raw auth_detail / last_error writes outside the helper module.",
  );
  console.error(
    "All writes must go through writeAuthFailureDetail / writeAuthOkDetail in packages/daemon/src/core/backends/auth-health-monitor.ts (roadmap §9.2).",
  );
  console.error("");
  for (const line of offenders) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}

process.exit(0);

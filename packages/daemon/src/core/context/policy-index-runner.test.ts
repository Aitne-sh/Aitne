import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  collectPolicySnapshots,
  parsePolicyFile,
  runPolicyIndexReconciler,
  POLICY_INDEX_RECONCILER_LAST_RUN_KEY,
} from "./policy-index-runner.js";
import { readRuntimeState } from "../../db/runtime-state.js";
import { CONTEXT_RELATIVE_PATHS } from "../context-paths.js";

function makeContextDir(): string {
  return mkdtempSync(join(tmpdir(), "pa-policy-runner-"));
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function writePolicyFile(
  contextDir: string,
  slug: string,
  body: string,
): void {
  const dir = join(contextDir, CONTEXT_RELATIVE_PATHS.rules.policiesDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body, "utf-8");
}

function writeRoutineFile(
  contextDir: string,
  slug: string,
  body: string,
): void {
  const dir = join(contextDir, CONTEXT_RELATIVE_PATHS.routines.customDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body, "utf-8");
}

function writeManagement(contextDir: string, body: string): void {
  const dir = join(contextDir, "policies");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(contextDir, CONTEXT_RELATIVE_PATHS.rules.management),
    body,
    "utf-8",
  );
}

const POLICY_BODY = `---
type: rule
kind: policy
owner: agent
updated: 2026-04-25
slug: morning-finance
status: active
created_at: 2026-04-20
created_via: dm
origin: "User DM 2026-04-20: every morning run finance app"
linked:
  routine: morning-finance
  dossier: finance
template_version: 1
---
# Morning finance check

## Why

Daily Moneytree balance and transactions snapshot for proactive
anomaly surfacing.

## How

1. At 07:00 local time, wake the routine.
`;

const ROUTINE_BODY = `---
type: rule
slug: morning-finance
process_key: routine.custom.morning-finance
cron: "0 7 * * *"
backend_tier: light
max_budget_usd: 0.20
enabled: true
---
# Morning finance routine

## Checks

### balance
**Action**: read balance.
`;

const MANAGEMENT_BODY = `---
type: rule
slug: management
owner: shared
updated: 2026-04-20
template_version: 2
---
# Management rules

## Source of Truth

| Category | Canonical store | Writer |
|---|---|---|
| User identity | user/profile.md | shared |

## Notes

- existing notes
`;

describe("parsePolicyFile", () => {
  it("parses flat + nested frontmatter and pulls Why paragraph", () => {
    const parsed = parsePolicyFile(POLICY_BODY);
    expect(parsed).not.toBeNull();
    expect(parsed!.slug).toBe("morning-finance");
    expect(parsed!.status).toBe("active");
    expect(parsed!.linkedRoutine).toBe("morning-finance");
    expect(parsed!.linkedDossier).toBe("finance");
    expect(parsed!.why).toContain("Daily Moneytree balance");
    expect(parsed!.createdAt).toBe("2026-04-20");
    expect(parsed!.updated).toBe("2026-04-25");
  });

  it("returns null when kind is not policy", () => {
    const body = POLICY_BODY.replace("kind: policy", "kind: other");
    expect(parsePolicyFile(body)).toBeNull();
  });

  it("returns null when frontmatter delimiters are missing", () => {
    expect(parsePolicyFile("# no frontmatter\n")).toBeNull();
  });

  it("returns null when status is invalid", () => {
    const body = POLICY_BODY.replace("status: active", "status: bogus");
    expect(parsePolicyFile(body)).toBeNull();
  });

  it("falls back to origin when Why section is empty", () => {
    const body = POLICY_BODY.replace(
      /## Why\n\nDaily[\s\S]*?\n\n## How/,
      "## Why\n\n## How",
    );
    const parsed = parsePolicyFile(body);
    expect(parsed!.why).toContain("User DM 2026-04-20");
  });

  it("returns null when frontmatter never closes", () => {
    expect(parsePolicyFile("---\nkind: policy\n# missing closer\n")).toBeNull();
  });

  it("ignores blank lines and comments inside frontmatter without breaking the parser", () => {
    const body = POLICY_BODY
      .replace("kind: policy\n", "kind: policy\n\n# comment line\n");
    const parsed = parsePolicyFile(body);
    expect(parsed).not.toBeNull();
  });

  it("resets the nest cursor when a malformed (no `key:`) line appears at top level", () => {
    // The frontmatter parser handles a non-key line by clearing
    // currentNest/nestKey and skipping the line. After such a line, a
    // subsequent valid top-level field must still be parsed.
    const body = `---
type: rule
kind: policy
owner: agent
updated: 2026-04-25
slug: morning-finance
status: active
created_at: 2026-04-20
malformed-line-with-no-colon
origin: "after the bad line"
---
# H

## Why
why
`;
    const parsed = parsePolicyFile(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.slug).toBe("morning-finance");
  });

  it("returns null when a required field is missing", () => {
    // Missing `slug` — must yield null, not throw.
    const body = POLICY_BODY.replace(/^slug:.*\n/m, "");
    expect(parsePolicyFile(body)).toBeNull();
  });
});

describe("collectPolicySnapshots", () => {
  let contextDir: string;
  beforeEach(() => {
    contextDir = makeContextDir();
  });
  afterEach(() => {
    rmSync(contextDir, { recursive: true, force: true });
  });

  it("returns empty when policies dir is absent", () => {
    expect(collectPolicySnapshots(contextDir)).toEqual([]);
  });

  it("walks policies and attaches cron from linked routine", () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(contextDir, "morning-finance", ROUTINE_BODY);
    const snapshots = collectPolicySnapshots(contextDir);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].cadence).toBe("0 7 * * *");
    expect(snapshots[0].linkedRoutine).toBe("morning-finance");
  });

  it("returns null cadence when linked routine file is missing", () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    const snapshots = collectPolicySnapshots(contextDir);
    expect(snapshots[0].cadence).toBeNull();
  });

  it("skips files whose slug does not match filename", () => {
    writePolicyFile(contextDir, "wrong-name", POLICY_BODY);
    const snapshots = collectPolicySnapshots(contextDir);
    expect(snapshots).toEqual([]);
  });

  it("skips _index.md", () => {
    writePolicyFile(contextDir, "_index", "---\ntype: index\nowner: agent\nupdated: 2026-04-25\n---\n# Policy index\n");
    expect(collectPolicySnapshots(contextDir)).toEqual([]);
  });

  it("attaches removedAt for status: removed entries", () => {
    const body = POLICY_BODY.replace("status: active", "status: removed");
    writePolicyFile(contextDir, "morning-finance", body);
    const snapshots = collectPolicySnapshots(contextDir);
    expect(snapshots[0].status).toBe("removed");
    expect(snapshots[0].removedAt).toBe("2026-04-25");
  });

  it("skips non-.md entries inside the policies directory", () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    const dir = join(contextDir, CONTEXT_RELATIVE_PATHS.rules.policiesDir);
    writeFileSync(join(dir, "README.txt"), "not a policy", "utf-8");
    writeFileSync(join(dir, "DRAFT.json"), "{}", "utf-8");
    const snapshots = collectPolicySnapshots(contextDir);
    expect(snapshots.map((s) => s.slug)).toEqual(["morning-finance"]);
  });

  it("skips files whose frontmatter cannot be parsed", () => {
    writePolicyFile(
      contextDir,
      "morning-finance",
      "no frontmatter at all\n",
    );
    expect(collectPolicySnapshots(contextDir)).toEqual([]);
  });

  it("returns null cadence when the linked routine file has no `cron` field", () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(
      contextDir,
      "morning-finance",
      "---\ntype: routine\nowner: shared\nupdated: 2026-04-21\n---\n# Routine\n",
    );
    const snapshots = collectPolicySnapshots(contextDir);
    expect(snapshots[0].cadence).toBeNull();
  });

  it("returns null cadence when the linked routine has no closing frontmatter delimiter", () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(
      contextDir,
      "morning-finance",
      "---\ncron: 0 7 * * *\n# missing closer\n",
    );
    const snapshots = collectPolicySnapshots(contextDir);
    expect(snapshots[0].cadence).toBeNull();
  });

  it("returns null cadence when the linked routine has no opening delimiter", () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(
      contextDir,
      "morning-finance",
      "no frontmatter at all\ncron: 0 7 * * *\n",
    );
    const snapshots = collectPolicySnapshots(contextDir);
    expect(snapshots[0].cadence).toBeNull();
  });
});

describe("runPolicyIndexReconciler", () => {
  let contextDir: string;
  let db: Database.Database;
  beforeEach(() => {
    contextDir = makeContextDir();
    db = makeDb();
  });
  afterEach(() => {
    rmSync(contextDir, { recursive: true, force: true });
    db.close();
  });

  const fixedNow = () => new Date("2026-04-25T10:00:00Z");

  it("noop when nothing to render and both files are absent", async () => {
    const record = await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    expect(record.result).toBe("noop");
    const stored = readRuntimeState(db, POLICY_INDEX_RECONCILER_LAST_RUN_KEY);
    expect(stored).not.toBeNull();
  });

  it("writes _index.md when policy file exists and index is missing", async () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(contextDir, "morning-finance", ROUTINE_BODY);
    const record = await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    expect(record.result).toBe("applied");
    const indexPath = join(
      contextDir,
      CONTEXT_RELATIVE_PATHS.rules.policiesIndex,
    );
    const indexBody = readFileSync(indexPath, "utf-8");
    expect(indexBody).toContain("morning-finance");
    expect(indexBody).toContain("`0 7 * * *`");
    expect(indexBody).toContain("Daily Moneytree balance");
  });

  it("upserts the Active Policies section in management.md", async () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(contextDir, "morning-finance", ROUTINE_BODY);
    writeManagement(contextDir, MANAGEMENT_BODY);
    const record = await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    expect(record.result).toBe("applied");
    const after = readFileSync(
      join(contextDir, CONTEXT_RELATIVE_PATHS.rules.management),
      "utf-8",
    );
    expect(after).toContain("## Active Policies");
    expect(after).toContain("morning-finance");
    expect(after).toContain("## Source of Truth");
    expect(after).toContain("## Notes");
  });

  it("snapshots prior content with policy_index_reconciled trigger", async () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(contextDir, "morning-finance", ROUTINE_BODY);
    writeManagement(contextDir, MANAGEMENT_BODY);
    await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    const snapshots = db
      .prepare(
        "SELECT file_path, trigger FROM md_file_snapshots WHERE trigger = ?",
      )
      .all("policy_index_reconciled") as { file_path: string; trigger: string }[];
    // Index was missing on first run, no snapshot for it. Management existed
    // → snapshot of its prior content.
    expect(snapshots.some((s) => s.file_path === CONTEXT_RELATIVE_PATHS.rules.management)).toBe(true);
  });

  it("is idempotent across re-runs", async () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(contextDir, "morning-finance", ROUTINE_BODY);
    writeManagement(contextDir, MANAGEMENT_BODY);
    await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    const second = await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    expect(second.result).toBe("noop");
  });

  it("notifies onPromptContextChanged for written paths", async () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(contextDir, "morning-finance", ROUTINE_BODY);
    writeManagement(contextDir, MANAGEMENT_BODY);
    const calls: Array<{
      path: string;
      reason: string;
      tier: string | undefined;
      tierReason: string | undefined;
    }> = [];
    await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      onPromptContextChanged: (path, reason, tier, metadata) =>
        calls.push({ path, reason, tier, tierReason: metadata?.tierReason }),
      now: fixedNow,
    });
    const paths = calls.map((c) => c.path);
    expect(paths).toContain(CONTEXT_RELATIVE_PATHS.rules.policiesIndex);
    expect(paths).toContain(CONTEXT_RELATIVE_PATHS.rules.management);
    expect(calls.every((c) => c.reason === "policy_index_reconciler")).toBe(true);
    expect(calls.every((c) => c.tier === "quiet")).toBe(true);
    expect(calls.every((c) => c.tierReason === "derived_policy_index")).toBe(true);
  });

  it("partitions buckets in the run record (active/paused/removed)", async () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    const pausedBody = POLICY_BODY
      .replace("slug: morning-finance", "slug: weekly-review")
      .replace("status: active", "status: paused")
      .replace("routine: morning-finance", "routine: weekly-review")
      .replace("dossier: finance", "dossier: review")
      .replace("Daily Moneytree", "Sunday review");
    writePolicyFile(contextDir, "weekly-review", pausedBody);
    const removedBody = POLICY_BODY
      .replace("slug: morning-finance", "slug: old-thing")
      .replace("status: active", "status: removed")
      .replace("routine: morning-finance", "routine: old-thing")
      .replace("dossier: finance", "dossier: old")
      .replace("Daily Moneytree", "Old thing — no longer needed");
    writePolicyFile(contextDir, "old-thing", removedBody);

    const record = await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    expect(record.result).toBe("applied");
    expect(record.added).toBe(1); // active
    expect(record.refreshedMtime).toBe(1); // paused
    expect(record.removed).toBe(1); // removed
  });

  it("returns an error record when an unexpected exception escapes the inner pipeline", async () => {
    // Pre-create a directory at the rules/_index path so writeFileSync
    // throws EISDIR — this is uncaught inside writeWithSnapshot and
    // surfaces in the outer catch.
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(contextDir, "morning-finance", ROUTINE_BODY);
    const indexAbs = join(
      contextDir,
      CONTEXT_RELATIVE_PATHS.rules.policiesIndex,
    );
    mkdirSync(indexAbs, { recursive: true });

    const record = await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    expect(record.result).toBe("error");
    expect(record.error).toBeTruthy();
  });

  it("snapshots prior content even when the snapshot insert fails (does not abort the run)", async () => {
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(contextDir, "morning-finance", ROUTINE_BODY);
    writeManagement(contextDir, MANAGEMENT_BODY);

    // Drop the snapshots table — the inner try/catch around the INSERT
    // must swallow the failure so the policy-index write still
    // completes.
    db.exec("DROP TABLE md_file_snapshots");

    const record = await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    expect(record.result).toBe("applied");
  });

  it("leaves files untouched when degraded mode is set", async () => {
    const { setDegradedMode } = await import("../../db/runtime-state.js");
    setDegradedMode(db, {
      reason: "vault_unreachable",
      path: null,
      since: new Date().toISOString(),
    });
    writePolicyFile(contextDir, "morning-finance", POLICY_BODY);
    writeRoutineFile(contextDir, "morning-finance", ROUTINE_BODY);
    const record = await runPolicyIndexReconciler({
      db,
      contextDir,
      trigger: "manual",
      now: fixedNow,
    });
    expect(record.result).toBe("noop");
    expect(record.error).toContain("degraded_mode");
  });
});

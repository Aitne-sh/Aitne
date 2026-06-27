import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySchema } from "../../db/schema.js";
import { readRuntimeState } from "../../db/runtime-state.js";
import { upsertAgent } from "../../db/agents-store.js";
import { agentDefinitionSchema, type AgentDefinition } from "@aitne/shared";
import { parseAgentFrontmatter } from "./agent-frontmatter.js";
import {
  CUSTOM_ROUTINES_MIGRATED_KEY,
  markSourceMigrated,
  migrateCustomRoutinesToAgents,
  stripLegacyFrontmatter,
} from "./custom-routine-migration.js";

const CUSTOM_DIR = "policies/routines/custom";

function routineFile(slug: string, over: Partial<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    type: "rule",
    slug,
    process_key: `routine.custom.${slug}`,
    cron: "0 9 * * 1",
    enabled: "true",
    backend_tier: "medium",
    max_budget_usd: "0.10",
    ...over,
  };
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push("---", "", "## Checks", "", "- Look at the inbox triage backlog.");
  return lines.join("\n");
}

describe("migrateCustomRoutinesToAgents", () => {
  let db: Database.Database;
  let contextDir: string;
  let userDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    contextDir = mkdtempSync(join(tmpdir(), "crm-ctx-"));
    userDir = join(contextDir, "policies", "agents");
    mkdirSync(join(contextDir, CUSTOM_DIR), { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(contextDir, { recursive: true, force: true });
  });

  function run() {
    return migrateCustomRoutinesToAgents(db, {
      contextDir,
      userDir,
      timezone: "Asia/Tokyo",
      now: () => 1_700_000_000_000,
    });
  }

  it("no custom dir contents → flagged no-op", () => {
    const result = run();
    expect(result).toEqual({ applied: true, migrated: [], skipped: [] });
    expect(readRuntimeState<string>(db, CUSTOM_ROUTINES_MIGRATED_KEY)).not.toBeNull();
  });

  it("converts a valid routine into a user agent.md and marks the source inert", () => {
    writeFileSync(join(contextDir, CUSTOM_DIR, "inbox-triage.md"), routineFile("inbox-triage"));
    const result = run();
    expect(result.migrated).toEqual([{ fromSlug: "inbox-triage", toSlug: "inbox-triage" }]);

    const agentMd = readFileSync(join(userDir, "inbox-triage", "agent.md"), "utf-8");
    const parsed = parseAgentFrontmatter(agentMd);
    const def = agentDefinitionSchema.parse(parsed.frontmatter);
    expect(def.slug).toBe("inbox-triage");
    expect(def.kind).toBe("user");
    expect(def.enabled).toBe(true);
    expect(def.schedule.expression).toBe("0 9 * * 1");
    expect(def.schedule.timezone).toBe("Asia/Tokyo");
    expect(def.backend.process_key).toBe("agent.task");
    expect(def.backend.tier).toBe("medium");
    expect(def.limits.max_budget_usd).toBe(0.1);
    // The ## Checks body became the agent body (= task_prompt).
    expect(parsed.body).toContain("## Checks");
    expect(parsed.body).toContain("inbox triage backlog");

    const source = readFileSync(join(contextDir, CUSTOM_DIR, "inbox-triage.md"), "utf-8");
    expect(source).toMatch(/^enabled: false$/m);
    expect(source).toMatch(/^migrated_to_agent: inbox-triage$/m);
  });

  it("a disabled routine migrates disabled (intent preserved)", () => {
    writeFileSync(
      join(contextDir, CUSTOM_DIR, "quiet.md"),
      routineFile("quiet", { enabled: "false" }),
    );
    const result = run();
    expect(result.migrated).toEqual([{ fromSlug: "quiet", toSlug: "quiet" }]);
    const def: AgentDefinition = agentDefinitionSchema.parse(
      parseAgentFrontmatter(
        readFileSync(join(userDir, "quiet", "agent.md"), "utf-8"),
      ).frontmatter,
    );
    expect(def.enabled).toBe(false);
  });

  it("legacy 'heavy' tier maps to high", () => {
    writeFileSync(
      join(contextDir, CUSTOM_DIR, "deep.md"),
      routineFile("deep", { backend_tier: "heavy" }),
    );
    run();
    const def: AgentDefinition = agentDefinitionSchema.parse(
      parseAgentFrontmatter(
        readFileSync(join(userDir, "deep", "agent.md"), "utf-8"),
      ).frontmatter,
    );
    expect(def.backend.tier).toBe("high");
  });

  it("invalid specs are skipped with a parse_error reason and left untouched", () => {
    const original = routineFile("broken", { cron: "not-a-cron" });
    writeFileSync(join(contextDir, CUSTOM_DIR, "broken.md"), original);
    const result = run();
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([{ slug: "broken", reason: "parse_error:invalid_cron" }]);
    expect(readFileSync(join(contextDir, CUSTOM_DIR, "broken.md"), "utf-8")).toBe(original);
    expect(existsSync(join(userDir, "broken"))).toBe(false);
  });

  it("builtin slug collision falls back to the custom- prefix", () => {
    writeFileSync(
      join(contextDir, CUSTOM_DIR, "activity-scan.md"),
      routineFile("activity-scan"),
    );
    const result = run();
    expect(result.migrated).toEqual([
      { fromSlug: "activity-scan", toSlug: "custom-activity-scan" },
    ]);
    expect(existsSync(join(userDir, "custom-activity-scan", "agent.md"))).toBe(true);
    const source = readFileSync(join(contextDir, CUSTOM_DIR, "activity-scan.md"), "utf-8");
    expect(source).toMatch(/^migrated_to_agent: custom-activity-scan$/m);
  });

  it("skips when both candidate slugs are taken", () => {
    writeFileSync(join(contextDir, CUSTOM_DIR, "busy.md"), routineFile("busy"));
    for (const slug of ["busy", "custom-busy"]) {
      upsertAgent(db, {
        slug,
        name: slug,
        description: "occupies the slug",
        source: "user",
        definitionPath: join(userDir, slug, "agent.md"),
        definitionHash: "h",
        enabled: true,
        processKey: "agent.task",
        scheduleKind: "cron",
        scheduleExpression: "0 9 * * *",
        scheduleTimezone: "UTC",
        tags: [],
        stopWarning: null,
        metadata: {},
      });
    }
    const result = run();
    expect(result.skipped).toEqual([{ slug: "busy", reason: "slug_collision" }]);
  });

  it("a candidate slug occupied only by an on-disk agent.md (no DB row) is skipped over", () => {
    writeFileSync(join(contextDir, CUSTOM_DIR, "disk.md"), routineFile("disk"));
    // Pre-existing user agent file with no agents row (e.g. mid-creation).
    mkdirSync(join(userDir, "disk"), { recursive: true });
    writeFileSync(join(userDir, "disk", "agent.md"), "---\nslug: disk\n---\n# X\n");
    const result = run();
    expect(result.migrated).toEqual([{ fromSlug: "disk", toSlug: "custom-disk" }]);
  });

  it("a write failure on one routine is reported as skipped without aborting the pass", () => {
    writeFileSync(join(contextDir, CUSTOM_DIR, "good.md"), routineFile("good"));
    writeFileSync(join(contextDir, CUSTOM_DIR, "doomed.md"), routineFile("doomed"));
    // Make the doomed slug's target dir un-creatable: a regular FILE occupies
    // the directory path, so mkdirSync(recursive) throws ENOTDIR.
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "doomed"), "not a directory");
    const result = run();
    expect(result.migrated).toEqual([{ fromSlug: "good", toSlug: "good" }]);
    expect(result.skipped).toEqual([{ slug: "doomed", reason: "write_failed" }]);
  });

  it("defaults `now` to the wall clock when not injected", () => {
    const result = migrateCustomRoutinesToAgents(db, {
      contextDir,
      userDir,
      timezone: "UTC",
    });
    expect(result.applied).toBe(true);
    expect(readRuntimeState<string>(db, CUSTOM_ROUTINES_MIGRATED_KEY)).not.toBeNull();
  });

  it("an effectively-empty body falls back to the description (## Checks only inside frontmatter)", () => {
    // `## Checks` can appear inside the frontmatter block (it is free text to
    // the line-scalar parser), making the spec valid while the stripped body
    // is empty.
    const content = [
      "---",
      "type: rule",
      "slug: hollow",
      "process_key: routine.custom.hollow",
      "cron: 0 9 * * 1",
      "enabled: true",
      "backend_tier: medium",
      "max_budget_usd: 0.10",
      "## Checks",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(contextDir, CUSTOM_DIR, "hollow.md"), content);
    const result = run();
    expect(result.migrated).toEqual([{ fromSlug: "hollow", toSlug: "hollow" }]);
    const agentMd = readFileSync(join(userDir, "hollow", "agent.md"), "utf-8");
    expect(agentMd).toContain('Migrated from custom routine "hollow".');
  });

  it("titleizes slugs with consecutive hyphens without crashing", () => {
    writeFileSync(join(contextDir, CUSTOM_DIR, "a--b.md"), routineFile("a--b"));
    const result = run();
    expect(result.migrated).toEqual([{ fromSlug: "a--b", toSlug: "a--b" }]);
    expect(readFileSync(join(userDir, "a--b", "agent.md"), "utf-8")).toContain("name: A  B");
  });

  it("second run is a flagged no-op (no re-conversion)", () => {
    writeFileSync(join(contextDir, CUSTOM_DIR, "once.md"), routineFile("once"));
    expect(run().migrated.length).toBe(1);
    rmSync(join(userDir, "once"), { recursive: true, force: true });
    const second = run();
    expect(second).toEqual({ applied: false, migrated: [], skipped: [] });
    expect(existsSync(join(userDir, "once"))).toBe(false);
  });
});

describe("stripLegacyFrontmatter (defensive branches)", () => {
  it("returns content unchanged when there is no opening fence", () => {
    expect(stripLegacyFrontmatter("# just a doc\n")).toBe("# just a doc\n");
  });

  it("returns content unchanged when the fence never closes", () => {
    const content = "---\ntype: rule\nno close";
    expect(stripLegacyFrontmatter(content)).toBe(content);
  });

  it("returns empty string when the closing fence ends the file", () => {
    expect(stripLegacyFrontmatter("---\ntype: rule\n---")).toBe("");
  });

  it("handles CRLF opening fences", () => {
    expect(stripLegacyFrontmatter("---\r\ntype: rule\r\n---\nbody")).toBe("body");
  });
});

describe("markSourceMigrated (defensive branches)", () => {
  it("flips enabled and inserts the marker before the closing fence", () => {
    const out = markSourceMigrated("---\nslug: x\nenabled: true\n---\n# X\n", "x");
    expect(out).toMatch(/^enabled: false$/m);
    expect(out).toMatch(/^migrated_to_agent: x$/m);
    expect(out.indexOf("migrated_to_agent")).toBeLessThan(out.indexOf("\n---\n# X"));
  });

  it("does not duplicate an existing marker", () => {
    const once = markSourceMigrated("---\nenabled: true\n---\nbody\n", "x");
    const twice = markSourceMigrated(once, "x");
    expect(twice.match(/migrated_to_agent/g)).toHaveLength(1);
  });

  it("inserts the marker into CRLF-fenced frontmatter", () => {
    const out = markSourceMigrated("---\r\nenabled: true\r\n---\r\nbody\r\n", "x");
    expect(out).toContain("migrated_to_agent: x");
  });

  it("leaves fence-less content unchanged apart from the enabled flip", () => {
    const out = markSourceMigrated("enabled: true\nno fences here\n", "x");
    expect(out).toMatch(/^enabled: false$/m);
    expect(out).not.toContain("migrated_to_agent");
  });
});

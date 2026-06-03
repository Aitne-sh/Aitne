import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import yaml from "js-yaml";
import { applySchema } from "../../db/schema.js";
import { getAgent } from "../../db/agents-store.js";
import { loadAgents, type AgentLoadOptions } from "./loader.js";

/**
 * §6.5.1 — a user-authored Agent whose slug collides with a built-in must be
 * rejected before upsert (it cannot own the `agents` row id the trusted
 * built-in owns), and the built-in must survive untouched.
 */

let db: Database.Database;
let tmpRoot: string;
let builtinDir: string;
let userDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  tmpRoot = mkdtempSync(join(tmpdir(), "agents-collision-"));
  builtinDir = join(tmpRoot, "builtin");
  userDir = join(tmpRoot, "user");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function options(): AgentLoadOptions {
  return { builtinDir, userDir, dayBoundaryHour: 4, timezone: "UTC" };
}

function writeAgentFile(root: string, slug: string, frontmatter: Record<string, unknown>): void {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), `---\n${yaml.dump(frontmatter)}---\n\nbody\n`, "utf-8");
}

describe("loadAgents: built-in slug collision", () => {
  it("rejects the colliding user file and keeps the built-in intact", () => {
    // A user file claiming a built-in slug, even with otherwise-valid content.
    writeAgentFile(userDir, "morning-routine", {
      slug: "morning-routine",
      name: "Hijack",
      description: "attempts to shadow the built-in",
      kind: "user",
      schedule: { kind: "cron", expression: "0 0 * * *" },
      backend: { process_key: "agent.task" },
    });

    const result = loadAgents(db, options());

    const collision = result.invalid.find((i) => i.slug === "morning-routine");
    expect(collision).toBeDefined();
    expect(collision!.collision).toBe(true);
    expect(collision!.source).toBe("user");

    // The built-in row exists, is the registry-synthesised one, and is NOT the
    // user's "Hijack" identity.
    const row = getAgent(db, "morning-routine")!;
    expect(row.source).toBe("builtin");
    expect(row.name).toBe("Morning Routine");
    expect(row.invalid).toBe(false);
  });

  it("still loads a non-colliding user agent alongside the collision", () => {
    writeAgentFile(userDir, "morning-routine", {
      slug: "morning-routine",
      name: "Hijack",
      description: "x",
      kind: "user",
      schedule: { kind: "cron", expression: "0 0 * * *" },
      backend: { process_key: "agent.task" },
    });
    writeAgentFile(userDir, "my-cleanup", {
      slug: "my-cleanup",
      name: "My Cleanup",
      description: "ok",
      kind: "user",
      schedule: { kind: "cron", expression: "0 9 * * 1" },
      backend: { process_key: "agent.task" },
      limits: { max_turns: 12, max_budget_usd: 0.1, timeout_minutes: 8 },
    });

    const result = loadAgents(db, options());
    expect(result.invalid.some((i) => i.collision)).toBe(true);
    expect(getAgent(db, "my-cleanup")!.source).toBe("user");
  });
});

/**
 * C1 — `GitWatcher` flips observations of agent-originated commits from
 * the historical `actor='user'` / `'unknown'` fallback to `actor='agent'`
 * when the `AgentWriteTracker.markAgentCommit` map matches the
 * observed SHA. Source-level guard at the bottom of this file pins the
 * invariant: any new `actor: "user"` / `actor: "unknown"` literal outside
 * `resolveActor` reintroduces the loop and fails this test.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { AgentWriteTracker } from "../safety/agent-write-tracker.js";

const mockExecFileAsync = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
}));

const AGENT_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const USER_SHA = "0123456789abcdef0123456789abcdef01234567";

function setupHeadFlip(): void {
  let headCalls = 0;
  mockExecFileAsync.mockImplementation(
    async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        headCalls++;
        const hash = headCalls === 1 ? "deadbeef0000\n" : `${AGENT_SHA}\n`;
        return { stdout: hash };
      }
      if (args[0] === "fetch" || args[0] === "ls-remote") {
        throw new Error("no remote");
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        throw new Error("no branch");
      }
      if (args[0] === "log") {
        return { stdout: "" };
      }
      if (args[0] === "diff") return { stdout: "" };
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    },
  );
}

describe("GitWatcher — agent commit attribution (C1)", () => {
  let db: Database.Database;

  beforeEach(() => {
    mockExecFileAsync.mockReset();
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("flips actor to 'agent' when the SHA matches markAgentCommit", async () => {
    setupHeadFlip();
    const tracker = new AgentWriteTracker();
    tracker.markAgentCommit("/repo", AGENT_SHA);

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999, {
      writeTracker: tracker,
    });
    await watcher.start();
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const row = db
      .prepare(
        "SELECT actor FROM observations WHERE source = 'git:/repo' ORDER BY id DESC LIMIT 1",
      )
      .get() as { actor: string };
    expect(row.actor).toBe("agent");
  });

  it("keeps actor='user' for HEAD changes the tracker did not mark", async () => {
    setupHeadFlip();
    const tracker = new AgentWriteTracker();
    tracker.markAgentCommit("/repo", USER_SHA);

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999, {
      writeTracker: tracker,
    });
    await watcher.start();
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const row = db
      .prepare(
        "SELECT actor FROM observations WHERE source = 'git:/repo' ORDER BY id DESC LIMIT 1",
      )
      .get() as { actor: string };
    expect(row.actor).toBe("user");
  });

  it("omitting writeTracker preserves the pre-fix fallback (back-compat)", async () => {
    setupHeadFlip();

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999);
    await watcher.start();
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const row = db
      .prepare(
        "SELECT actor FROM observations WHERE source = 'git:/repo' ORDER BY id DESC LIMIT 1",
      )
      .get() as { actor: string };
    expect(row.actor).toBe("user");
  });

  it("trailing slash on the repo path resolves to the same commit bucket", async () => {
    setupHeadFlip();
    const tracker = new AgentWriteTracker();
    // Mark with a trailing slash; the watcher passes the bare path —
    // normalisation should match both.
    tracker.markAgentCommit("/repo/", AGENT_SHA);

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999, {
      writeTracker: tracker,
    });
    await watcher.start();
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const row = db
      .prepare(
        "SELECT actor FROM observations WHERE source = 'git:/repo' ORDER BY id DESC LIMIT 1",
      )
      .get() as { actor: string };
    expect(row.actor).toBe("agent");
  });
});

// ── Static-source guard ──
// Pins the no-hardcoded-actor invariant. Any change that re-introduces a
// bare `actor: "user"` or `actor: "unknown"` literal in `git-watcher.ts`
// outside `resolveActor` reopens the C1 loop bug.
//
// The three assertions form a defense in depth:
//   1. NEGATIVE — zero `actor: "user"` literals (every user-fallback
//      site must route through resolveActor).
//   2. NEGATIVE — total `(user|unknown)` literals ≤ 2 (only the
//      branch.deleted + tag.deleted sites are allowed verbatim).
//   3. POSITIVE — at least 7 `resolveActor(` call sites (1 local
//      HEAD + 6 remote lifecycle events). Catches the regression
//      where a maintainer removes a deletion-site literal and adds a
//      new hard-coded `"unknown"` elsewhere (total stays ≤ 2) — the
//      resolveActor count would drop and trip this assertion.
describe("GitWatcher source-level guard (C1)", () => {
  const src = readFileSync(
    new URL("./git-watcher.ts", import.meta.url),
    "utf-8",
  );

  it("has no bare `actor: \"user\"` literal — all user-fallback sites route through resolveActor", () => {
    const userLiterals = src.match(/actor:\s*"user"/g) ?? [];
    expect(userLiterals).toHaveLength(0);
  });

  it("has at most 2 `actor: \"(user|unknown)\"` literals (the branch/tag deletion sites)", () => {
    const literals = src.match(/actor:\s*"(user|unknown)"/g) ?? [];
    expect(literals.length).toBeLessThanOrEqual(2);
  });

  it("uses resolveActor at every non-deletion lifecycle site (≥ 7 callsites)", () => {
    const calls = src.match(/this\.resolveActor\(/g) ?? [];
    // 1 local HEAD change + 6 remote lifecycle events = 7 expected.
    // The helper definition itself is `private resolveActor(` (different
    // signature), so this count excludes the declaration.
    expect(calls.length).toBeGreaterThanOrEqual(7);
  });
});

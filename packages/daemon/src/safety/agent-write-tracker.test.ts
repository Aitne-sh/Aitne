import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWriteTracker } from "./agent-write-tracker.js";

describe("AgentWriteTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks the exact content it wrote", () => {
    const tracker = new AgentWriteTracker(30_000);
    tracker.markWriting("/tmp/today.md", "hello");

    expect(tracker.isMarked("/tmp/today.md", "hello")).toBe(true);
  });

  it("does not match later user edits to the same path", () => {
    const tracker = new AgentWriteTracker(30_000);
    tracker.markWriting("/tmp/today.md", "hello");

    expect(tracker.isMarked("/tmp/today.md", "hello world")).toBe(false);
  });

  it("expires marks after the TTL window", () => {
    const tracker = new AgentWriteTracker(30_000);
    tracker.markWriting("/tmp/today.md", "hello");

    vi.advanceTimersByTime(30_001);

    expect(tracker.isMarked("/tmp/today.md", "hello")).toBe(false);
  });

  it("honors per-mark TTL override for polled sources", () => {
    const tracker = new AgentWriteTracker(30_000);
    tracker.markWriting("notion:abc", null, { ttlMs: 15 * 60_000 });

    // Default-TTL window has passed — the mark should still be alive.
    vi.advanceTimersByTime(60_000);
    expect(tracker.isMarked("notion:abc", null)).toBe(true);

    // But a mark with the default TTL alongside it expires normally.
    tracker.markWriting("obsidian:note", "body");
    vi.advanceTimersByTime(30_001);
    expect(tracker.isMarked("obsidian:note", "body")).toBe(false);
    expect(tracker.isMarked("notion:abc", null)).toBe(true);

    // The overridden mark expires after its own TTL.
    vi.advanceTimersByTime(15 * 60_000);
    expect(tracker.isMarked("notion:abc", null)).toBe(false);
  });

  it("isMarked returns false for paths never marked", () => {
    const tracker = new AgentWriteTracker(30_000);
    expect(tracker.isMarked("/tmp/not-marked.md", "anything")).toBe(false);
    expect(tracker.isMarked("/tmp/not-marked.md", null)).toBe(false);
    expect(tracker.isMarked("/tmp/not-marked.md", undefined)).toBe(false);
  });

  it("content-hash mark refuses path-only queries", () => {
    const tracker = new AgentWriteTracker(30_000);
    tracker.markWriting("/tmp/today.md", "hello");

    // Path-only query against a content-hash mark must not match — otherwise
    // an observer that has no content snapshot would suppress real user edits.
    expect(tracker.isMarked("/tmp/today.md", null)).toBe(false);
    expect(tracker.isMarked("/tmp/today.md", undefined)).toBe(false);
  });

  it("path-only mark matches regardless of content argument", () => {
    const tracker = new AgentWriteTracker(30_000);
    tracker.markWriting("notion:abc", null);

    expect(tracker.isMarked("notion:abc", null)).toBe(true);
    expect(tracker.isMarked("notion:abc", undefined)).toBe(true);
    expect(tracker.isMarked("notion:abc", "any-content")).toBe(true);
  });

  it("explicit cleanup() removes expired entries from the internal map", () => {
    const tracker = new AgentWriteTracker(1_000);
    tracker.markWriting("/tmp/a.md", "x");
    tracker.markWriting("/tmp/b.md", null, { ttlMs: 60_000 });

    vi.advanceTimersByTime(2_000);
    tracker.cleanup();

    expect(tracker.isMarked("/tmp/a.md", "x")).toBe(false);
    expect(tracker.isMarked("/tmp/b.md", null)).toBe(true);
  });

  it("cleanup() with explicit `now` purges entries whose expiry has passed", () => {
    const tracker = new AgentWriteTracker(1_000);
    tracker.markWriting("/tmp/a.md", "x");
    const now = Date.now() + 5_000;
    tracker.cleanup(now);
    expect(tracker.isMarked("/tmp/a.md", "x")).toBe(false);
  });

  // ── C2: unmark() rollback path for mark-before-write callers ──

  describe("unmark()", () => {
    it("clears a content-hash mark (round-trip with isMarked)", () => {
      const tracker = new AgentWriteTracker(30_000);
      tracker.markWriting("/tmp/today.md", "hello");
      expect(tracker.isMarked("/tmp/today.md", "hello")).toBe(true);

      tracker.unmark("/tmp/today.md");
      expect(tracker.isMarked("/tmp/today.md", "hello")).toBe(false);
    });

    it("clears a path-only mark (round-trip with isMarked)", () => {
      const tracker = new AgentWriteTracker(30_000);
      tracker.markWriting("notion:abc", null);
      expect(tracker.isMarked("notion:abc", null)).toBe(true);

      tracker.unmark("notion:abc");
      expect(tracker.isMarked("notion:abc", null)).toBe(false);
    });

    it("is a no-op on an unknown path (does not throw)", () => {
      const tracker = new AgentWriteTracker(30_000);
      expect(() => tracker.unmark("/tmp/never-marked.md")).not.toThrow();
      expect(tracker.isMarked("/tmp/never-marked.md", "any")).toBe(false);
    });

    it("is idempotent — second unmark on the same path does not throw", () => {
      const tracker = new AgentWriteTracker(30_000);
      tracker.markWriting("/tmp/today.md", "hello");
      tracker.unmark("/tmp/today.md");
      expect(() => tracker.unmark("/tmp/today.md")).not.toThrow();
    });
  });

  // ── C1: agent-commit attribution ──

  describe("markAgentCommit / isAgentCommit", () => {
    const SHA_A = "abcdef0123456789abcdef0123456789abcdef01";
    const SHA_B = "0123456789abcdef0123456789abcdef01234567";

    it("round-trips a full 40-char SHA", () => {
      const tracker = new AgentWriteTracker();
      tracker.markAgentCommit("/repo/a", SHA_A);
      expect(tracker.isAgentCommit("/repo/a", SHA_A)).toBe(true);
    });

    it("rejects unmarked SHAs", () => {
      const tracker = new AgentWriteTracker();
      tracker.markAgentCommit("/repo/a", SHA_A);
      expect(tracker.isAgentCommit("/repo/a", SHA_B)).toBe(false);
    });

    it("returns false for empty / never-marked SHA without throwing", () => {
      const tracker = new AgentWriteTracker();
      expect(tracker.isAgentCommit("/repo/a", "")).toBe(false);
      expect(tracker.isAgentCommit("/repo/a", SHA_A)).toBe(false);
    });

    it("expires marks after the commit TTL", () => {
      const tracker = new AgentWriteTracker(30_000, { commitTtlMs: 60_000 });
      tracker.markAgentCommit("/repo/a", SHA_A);
      vi.advanceTimersByTime(60_001);
      expect(tracker.isAgentCommit("/repo/a", SHA_A)).toBe(false);
    });

    it("honours per-mark TTL override", () => {
      const tracker = new AgentWriteTracker(30_000, { commitTtlMs: 60_000 });
      tracker.markAgentCommit("/repo/a", SHA_A, { ttlMs: 5_000 });
      vi.advanceTimersByTime(5_001);
      expect(tracker.isAgentCommit("/repo/a", SHA_A)).toBe(false);
    });

    it("isolates marks per repo (same SHA in different repos)", () => {
      const tracker = new AgentWriteTracker();
      tracker.markAgentCommit("/repo/a", SHA_A);
      expect(tracker.isAgentCommit("/repo/a", SHA_A)).toBe(true);
      expect(tracker.isAgentCommit("/repo/b", SHA_A)).toBe(false);
    });

    it("normalises trailing slash on repo path", () => {
      const tracker = new AgentWriteTracker();
      tracker.markAgentCommit("/repo/a", SHA_A);
      expect(tracker.isAgentCommit("/repo/a/", SHA_A)).toBe(true);
      expect(tracker.isAgentCommit("/repo/a//", SHA_A)).toBe(true);
    });

    it("is case-insensitive on SHA", () => {
      const tracker = new AgentWriteTracker();
      tracker.markAgentCommit("/repo/a", SHA_A.toUpperCase());
      expect(tracker.isAgentCommit("/repo/a", SHA_A.toLowerCase())).toBe(true);
    });

    it.each(["", "abc", "abcdef", "xyz1234", "not-hex!"])(
      "silently no-ops on malformed SHA: %p",
      (badSha) => {
        const tracker = new AgentWriteTracker();
        expect(() => tracker.markAgentCommit("/repo/a", badSha)).not.toThrow();
        expect(tracker.isAgentCommit("/repo/a", badSha)).toBe(false);
      },
    );

    it("accepts a 7-char abbreviated SHA (minimum-length boundary)", () => {
      const tracker = new AgentWriteTracker();
      const short = "abc1234";
      tracker.markAgentCommit("/repo/a", short);
      expect(tracker.isAgentCommit("/repo/a", short)).toBe(true);
    });
  });

  // ── C2: static-source guard ──
  // Pins the mark-before-write invariant. Any production file that
  // re-introduces `writeFileAtomically(...); markWriting(...);` (write
  // visible to FS-watch consumers before the tracker is populated)
  // fails this test. See RELEASE_GIT_C1_C4_PLAN.md §C2.
  describe("static-source guard", () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const monitoredFiles = [
      "core/repository-management-docs.ts",
      "core/roadmap-maintenance.ts",
      "core/context/reconciler-runner.ts",
      "core/context/default-schedules-runner.ts",
      "core/context/domain-index-runner.ts",
      "core/context/policy-index-runner.ts",
      "core/context/activity-view-runner.ts",
      "core/context/entity-source-rename.ts",
      "core/morning/agent-journal-appender.ts",
      "api/routes/context/write.ts",
      "api/routes/context/repair.ts",
      "api/routes/context/snapshots.ts",
    ];

    it("no monitored production file calls a sync write immediately before markWriting", () => {
      const offenders: string[] = [];
      for (const rel of monitoredFiles) {
        const src = readFileSync(join(srcRoot, rel), "utf-8");
        if (
          /write(FileAtomically|FileSync)\([^)]*\);\s*\n\s*[^/\n]*markWriting\(/.test(
            src,
          )
        ) {
          offenders.push(rel);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});

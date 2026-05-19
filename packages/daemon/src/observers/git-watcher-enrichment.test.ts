import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { EventPriority } from "@aitne/shared";
import type { EventBus } from "../core/event-bus.js";
import { applySchema } from "../db/schema.js";

// Mock execFile → promisify chain. We control the mock function that
// promisify(execFile) returns.
const mockExecFileAsync = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: vi.fn(), // raw callback form — not called directly
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
}));

describe("GitWatcher enrichment", () => {
  let db: Database.Database;

  beforeEach(() => {
    mockExecFileAsync.mockReset();
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("getCommitInfo includes commit body and stat diff in diffContent", async () => {
    let headCalls = 0;
    mockExecFileAsync.mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.join(" ") === "rev-parse HEAD") {
          headCalls++;
          return { stdout: headCalls === 1 ? "aaa111\n" : "bbb222\n" };
        }
        if (args[0] === "fetch" || args[0] === "ls-remote") {
          throw new Error("no remote");
        }
        if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
          throw new Error("no branch");
        }
        if (args[0] === "log") {
          return {
            stdout:
              "bbb222 Fix login bug (alice, 2 hours ago)\n\nExtended commit body here\n",
          };
        }
        if (args.join(" ") === "diff --stat aaa111 bbb222") {
          return {
            stdout:
              " src/auth.ts | 5 ++---\n 1 file changed, 2 insertions(+), 3 deletions(-)\n",
          };
        }
        if (args.join(" ") === "diff --name-only aaa111 bbb222") {
          return { stdout: "src/auth.ts\n" };
        }
        throw new Error(`unexpected git command: ${args.join(" ")}`);
      },
    );

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999);

    // start() initializes lastCommitHash via getLatestHash
    await watcher.start();

    // Manually invoke the private poll → checkRepo cycle
    // The second getLatestHash returns a different hash, triggering the event
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const observation = db.prepare(
      "SELECT source, ref, payload FROM observations ORDER BY id DESC LIMIT 1",
    ).get() as { source: string; ref: string; payload: string | null };
    const payload = JSON.parse(observation.payload ?? "{}") as {
      commitInfo?: string;
    };

    expect(observation.source).toBe("git:/repo");
    expect(observation.ref).toBe("bbb222");
    expect(payload.commitInfo).toContain("Fix login bug");
    expect(payload.commitInfo).toContain("Extended commit body here");
    expect(payload.commitInfo).toContain("src/auth.ts | 5 ++---");

    await watcher.stop();
  });

  it("getCommitRangeInfo falls back to a commit range summary on error", async () => {
    let headCalls = 0;
    mockExecFileAsync.mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.join(" ") === "rev-parse HEAD") {
          headCalls++;
          return {
            stdout: headCalls === 1 ? "aaa111\n" : "ccc333abcdef\n",
          };
        }
        if (args[0] === "fetch" || args[0] === "ls-remote") {
          throw new Error("no remote");
        }
        if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
          throw new Error("no branch");
        }
        if (args[0] === "log") {
          throw new Error("git log failed");
        }
        if (args.join(" ") === "diff --stat aaa111 ccc333abcdef") {
          throw new Error("git diff failed");
        }
        if (args.join(" ") === "diff --name-only aaa111 ccc333abcdef") {
          return { stdout: "" };
        }
        throw new Error(`unexpected git command: ${args.join(" ")}`);
      },
    );

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999);

    await watcher.start();
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const observation = db.prepare(
      "SELECT ref, payload FROM observations ORDER BY id DESC LIMIT 1",
    ).get() as { ref: string; payload: string | null };
    const payload = JSON.parse(observation.payload ?? "{}") as {
      commitInfo?: string;
    };

    expect(observation.ref).toBe("ccc333abcdef");
    expect(payload.commitInfo).toBe("aaa111..ccc333ab");

    await watcher.stop();
  });

  it("records remote branch, tag, push, and default-branch lifecycle observations after baseline", async () => {
    let headsCalls = 0;
    let tagsCalls = 0;
    mockExecFileAsync.mockImplementation(
      async (_cmd: string, args: string[]) => {
        const joined = args.join(" ");
        if (joined === "rev-parse HEAD") return { stdout: "local111\n" };
        if (args[0] === "fetch") return { stdout: "" };
        if (joined === "ls-remote --heads origin") {
          headsCalls++;
          return {
            stdout:
              headsCalls === 1
                ? "aaa111\trefs/heads/main\n"
                : "bbb222\trefs/heads/main\nccc333\trefs/heads/feature/new\n",
          };
        }
        if (joined === "ls-remote --tags --refs origin") {
          tagsCalls++;
          return {
            stdout:
              tagsCalls === 1
                ? "tag111\trefs/tags/v1.0.0\n"
                : "tag111\trefs/tags/v1.0.0\ntag222\trefs/tags/v1.1.0\n",
          };
        }
        if (joined === "ls-remote --symref origin HEAD") {
          return { stdout: "ref: refs/heads/main\tHEAD\nbbb222\tHEAD\n" };
        }
        if (joined === "merge-base --is-ancestor aaa111 bbb222") {
          return { stdout: "" };
        }
        if (joined === "rev-parse --abbrev-ref HEAD") {
          throw new Error("no upstream");
        }
        throw new Error(`unexpected git command: ${joined}`);
      },
    );

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999);

    await watcher.start();
    expect(db.prepare("SELECT COUNT(*) AS count FROM observations").get()).toEqual({
      count: 0,
    });

    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const rows = db.prepare(
      "SELECT ref, change_type, payload FROM observations ORDER BY ref ASC",
    ).all() as Array<{ ref: string; change_type: string; payload: string }>;
    const eventTypes = rows.map((row) => JSON.parse(row.payload).eventType);

    expect(eventTypes).toEqual([
      "git.branch.created",
      "git.merge_to_default",
      "git.push.detected",
      "git.tag.created",
    ]);
    expect(rows.map((row) => row.ref)).toEqual([
      "branch_created:feature/new:ccc333",
      "merge_to_default:main:bbb222",
      "push:main:bbb222",
      "tag_created:v1.1.0:tag222",
    ]);

    await watcher.stop();
  });

  it("records force-push observations when a remote branch no longer contains the prior tip", async () => {
    let headsCalls = 0;
    mockExecFileAsync.mockImplementation(
      async (_cmd: string, args: string[]) => {
        const joined = args.join(" ");
        if (joined === "rev-parse HEAD") return { stdout: "local111\n" };
        if (args[0] === "fetch") return { stdout: "" };
        if (joined === "ls-remote --heads origin") {
          headsCalls++;
          return {
            stdout:
              headsCalls === 1
                ? "aaa111\trefs/heads/main\n"
                : "fff999\trefs/heads/main\n",
          };
        }
        if (joined === "ls-remote --tags --refs origin") {
          return { stdout: "" };
        }
        if (joined === "ls-remote --symref origin HEAD") {
          return { stdout: "ref: refs/heads/main\tHEAD\nfff999\tHEAD\n" };
        }
        if (joined === "merge-base --is-ancestor aaa111 fff999") {
          throw Object.assign(new Error("not ancestor"), { code: 1 });
        }
        if (joined === "rev-parse --abbrev-ref HEAD") {
          throw new Error("no upstream");
        }
        throw new Error(`unexpected git command: ${joined}`);
      },
    );

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999);

    await watcher.start();
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const rows = db.prepare(
      "SELECT ref, payload FROM observations ORDER BY ref ASC",
    ).all() as Array<{ ref: string; payload: string }>;
    const forceRow = rows.find((row) => row.ref.startsWith("force_push:"));

    expect(forceRow).toBeDefined();
    expect(JSON.parse(forceRow?.payload ?? "{}")).toMatchObject({
      eventType: "git.push.force_pushed",
      branch: "main",
      previousRemoteHash: "aaa111",
      remoteHash: "fff999",
      forcePush: true,
    });

    await watcher.stop();
  });

  it("emits only force-push lifecycle events to the EventBus", async () => {
    let headsCalls = 0;
    mockExecFileAsync.mockImplementation(
      async (_cmd: string, args: string[]) => {
        const joined = args.join(" ");
        if (joined === "rev-parse HEAD") return { stdout: "local111\n" };
        if (args[0] === "fetch") return { stdout: "" };
        if (joined === "ls-remote --heads origin") {
          headsCalls++;
          return {
            stdout:
              headsCalls === 1
                ? "aaa111\trefs/heads/main\n"
                : "fff999\trefs/heads/main\n",
          };
        }
        if (joined === "ls-remote --tags --refs origin") {
          return { stdout: "" };
        }
        if (joined === "ls-remote --symref origin HEAD") {
          return { stdout: "ref: refs/heads/main\tHEAD\nfff999\tHEAD\n" };
        }
        if (joined === "merge-base --is-ancestor aaa111 fff999") {
          throw Object.assign(new Error("not ancestor"), { code: 1 });
        }
        if (joined === "rev-parse --abbrev-ref HEAD") {
          throw new Error("no upstream");
        }
        throw new Error(`unexpected git command: ${joined}`);
      },
    );

    const put = vi.fn(async (_event: unknown) => undefined);
    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999, {
      eventBus: { put } as unknown as EventBus,
    });

    await watcher.start();
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toMatchObject({
      type: "git.push.force_pushed",
      source: "git-watcher",
      priority: EventPriority.HIGH,
      data: {
        eventType: "git.push.force_pushed",
        repoPath: "/repo",
        branch: "main",
        previousRemoteHash: "aaa111",
        remoteHash: "fff999",
      },
    });

    await watcher.stop();
  });

  it("records local-ahead stale once per ahead-period, anchored to oldest unpushed commit", async () => {
    let now = 0;
    let headHash = "local999";
    // Oldest unpushed commit's committer time. Returned in seconds-since-epoch
    // by `git log --format=%ct --reverse <upstream>..HEAD` (we take the first
    // line). Holding this fixed across polls models a developer who keeps
    // committing on top — head moves, oldest unpushed does not.
    let oldestUnpushedCt = "0";
    mockExecFileAsync.mockImplementation(
      async (_cmd: string, args: string[]) => {
        const joined = args.join(" ");
        if (joined === "rev-parse HEAD") return { stdout: `${headHash}\n` };
        if (args[0] === "fetch" || args[0] === "ls-remote") {
          throw new Error("no remote");
        }
        if (joined === "rev-parse --abbrev-ref HEAD") {
          return { stdout: "main\n" };
        }
        if (joined === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
          return { stdout: "origin/main\n" };
        }
        if (joined === "rev-parse --verify origin/main") {
          return { stdout: "remote111\n" };
        }
        if (joined === "rev-list --count origin/main..HEAD") {
          return { stdout: "2\n" };
        }
        if (joined === "log --format=%ct --reverse origin/main..HEAD") {
          // Oldest commit first, newer commits below — we should anchor on
          // the first line.
          return { stdout: `${oldestUnpushedCt}\nlater_value_ignored\n` };
        }
        // checkLocalHead probes log/diff when HEAD advances. Tolerate them so
        // the staleness path is what this test exercises.
        if (args[0] === "log" || args[0] === "diff") return { stdout: "" };
        throw new Error(`unexpected git command: ${joined}`);
      },
    );

    const staleObsCount = (): number =>
      (db.prepare(
        "SELECT COUNT(*) AS count FROM observations WHERE ref LIKE 'local_ahead_stale:%'",
      ).get() as { count: number }).count;

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999, {
      pushOverdueMinutes: 1,
      now: () => now,
    });

    await watcher.start();
    await (watcher as unknown as { poll: () => Promise<void> }).poll();
    expect(staleObsCount()).toBe(0);

    now = 61_000;
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    // A new commit lands on top of the unpushed range. Head moves; the
    // oldest unpushed commit (and its timestamp) does not. The watcher must
    // not re-fire — one alert per ahead-period, regardless of how many top
    // commits land during that period.
    headHash = "local000new";
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const rows = db.prepare(
      "SELECT ref, payload FROM observations WHERE ref LIKE 'local_ahead_stale:%' ORDER BY id ASC",
    ).all() as Array<{ ref: string; payload: string }>;

    expect(rows).toHaveLength(1);
    // Ref intentionally omits headHash so a new top commit does not bypass
    // the dedup check.
    expect(rows[0].ref).toBe("local_ahead_stale:main:remote111");
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      eventType: "git.local_ahead.stale",
      branch: "main",
      upstreamRef: "origin/main",
      aheadCount: 2,
      pushOverdueMinutes: 1,
    });

    await watcher.stop();
  });

  it("records local-ahead stale even when the user keeps committing during the period", async () => {
    // Regression: anchor on OLDEST unpushed commit, not HEAD. Previously the
    // watcher reset its clock on every new top commit, so a developer who
    // committed every ~30 minutes for hours would never see the warning.
    let now = 0;
    let headHash = "first_commit";
    mockExecFileAsync.mockImplementation(
      async (_cmd: string, args: string[]) => {
        const joined = args.join(" ");
        if (joined === "rev-parse HEAD") return { stdout: `${headHash}\n` };
        if (args[0] === "fetch" || args[0] === "ls-remote") {
          throw new Error("no remote");
        }
        if (joined === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
        if (joined === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
          return { stdout: "origin/main\n" };
        }
        if (joined === "rev-parse --verify origin/main") {
          return { stdout: "remote_base\n" };
        }
        if (joined === "rev-list --count origin/main..HEAD") {
          return { stdout: "1\n" };
        }
        if (joined === "log --format=%ct --reverse origin/main..HEAD") {
          // Oldest commit's committer time stays at 0 throughout.
          return { stdout: "0\n" };
        }
        // checkLocalHead emits a "new local commit" observation each time
        // HEAD advances; tolerate its log/diff probes so the staleness path
        // is what we exercise. Output is not asserted on by this test.
        if (args[0] === "log" || args[0] === "diff") return { stdout: "" };
        throw new Error(`unexpected git command: ${joined}`);
      },
    );

    const staleObsCount = (): number =>
      (db.prepare(
        "SELECT COUNT(*) AS count FROM observations WHERE ref LIKE 'local_ahead_stale:%'",
      ).get() as { count: number }).count;

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999, {
      pushOverdueMinutes: 60,
      now: () => now,
    });
    await watcher.start();

    // 30 minutes elapse, user commits again — head changes, but oldest
    // unpushed commit's age is still only 30min. Should NOT fire yet.
    now = 30 * 60 * 1000;
    headHash = "second_commit";
    await (watcher as unknown as { poll: () => Promise<void> }).poll();
    expect(staleObsCount()).toBe(0);

    // 90 minutes after the oldest commit landed, the staleness clock fires
    // even though head advanced repeatedly during the window.
    now = 90 * 60 * 1000;
    headHash = "third_commit";
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const rows = db.prepare(
      "SELECT ref, payload FROM observations WHERE ref LIKE 'local_ahead_stale:%' ORDER BY id ASC",
    ).all() as Array<{ ref: string; payload: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].ref).toBe("local_ahead_stale:main:remote_base");
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      eventType: "git.local_ahead.stale",
      staleForMinutes: 90,
    });

    await watcher.stop();
  });

  it("records branch and tag deletion observations", async () => {
    let headsCalls = 0;
    let tagsCalls = 0;
    mockExecFileAsync.mockImplementation(
      async (_cmd: string, args: string[]) => {
        const joined = args.join(" ");
        if (joined === "rev-parse HEAD") return { stdout: "local111\n" };
        if (args[0] === "fetch") return { stdout: "" };
        if (joined === "ls-remote --heads origin") {
          headsCalls++;
          return {
            stdout:
              headsCalls === 1
                ? "aaa111\trefs/heads/main\nbbb222\trefs/heads/feature/old\n"
                : "aaa111\trefs/heads/main\n",
          };
        }
        if (joined === "ls-remote --tags --refs origin") {
          tagsCalls++;
          return {
            stdout:
              tagsCalls === 1
                ? "tag111\trefs/tags/v1.0.0\ntag222\trefs/tags/v0.9.0\n"
                : "tag111\trefs/tags/v1.0.0\n",
          };
        }
        if (joined === "ls-remote --symref origin HEAD") {
          return { stdout: "ref: refs/heads/main\tHEAD\naaa111\tHEAD\n" };
        }
        if (joined === "rev-parse --abbrev-ref HEAD") {
          throw new Error("no upstream");
        }
        throw new Error(`unexpected git command: ${joined}`);
      },
    );

    const { GitWatcher } = await import("./git-watcher.js");
    const watcher = new GitWatcher(["/repo"], db, 9999);

    await watcher.start();
    await (watcher as unknown as { poll: () => Promise<void> }).poll();

    const rows = db.prepare(
      "SELECT ref, change_type, payload FROM observations ORDER BY ref ASC",
    ).all() as Array<{ ref: string; change_type: string; payload: string }>;
    const eventTypes = rows.map((row) => JSON.parse(row.payload).eventType);

    expect(eventTypes).toContain("git.branch.deleted");
    expect(eventTypes).toContain("git.tag.deleted");

    const branchDelete = rows.find((row) => row.ref.startsWith("branch_deleted:"));
    expect(branchDelete?.change_type).toBe("deleted");
    expect(JSON.parse(branchDelete?.payload ?? "{}")).toMatchObject({
      eventType: "git.branch.deleted",
      branch: "feature/old",
      previousRemoteHash: "bbb222",
    });

    const tagDelete = rows.find((row) => row.ref.startsWith("tag_deleted:"));
    expect(tagDelete?.change_type).toBe("deleted");
    expect(JSON.parse(tagDelete?.payload ?? "{}")).toMatchObject({
      eventType: "git.tag.deleted",
      tag: "v0.9.0",
      previousTagHash: "tag222",
    });

    await watcher.stop();
  });

  it("parses ls-remote refs and default branch symrefs", async () => {
    const { parseDefaultBranch, parseLsRemoteRefs } = await import(
      "./git-watcher.js"
    );

    expect(
      parseLsRemoteRefs(
        "abc\trefs/heads/main\nignored\trefs/pull/1/head\n",
        "heads",
      ),
    ).toEqual(new Map([["main", "abc"]]));
    expect(
      parseLsRemoteRefs(
        "def\trefs/tags/v1.0.0\npeeled\trefs/tags/v1.0.0^{}\n",
        "tags",
      ),
    ).toEqual(new Map([["v1.0.0", "def"]]));
    expect(parseDefaultBranch("ref: refs/heads/main\tHEAD\nabc\tHEAD\n")).toBe(
      "main",
    );
  });
});

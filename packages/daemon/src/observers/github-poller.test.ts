import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { recordObservation } from "../db/observations.js";
import { EventBus } from "../core/event-bus.js";
import {
  GitHubPoller,
  isObservationFresh,
  isWorkflowRepoCold,
  parseGhIncludeResponse,
  type GhExecResult,
  type GhRunner,
} from "./github-poller.js";

describe("parseGhIncludeResponse", () => {
  it("parses 200 OK with headers and body", () => {
    const raw = [
      "HTTP/2.0 200 OK",
      'Etag: W/"abc123"',
      "Content-Type: application/json; charset=utf-8",
      "X-Ratelimit-Remaining: 4999",
      "",
      '[{"id":"1"}]',
    ].join("\n");

    const result = parseGhIncludeResponse(raw);
    expect(result.statusCode).toBe(200);
    expect(result.headers.etag).toBe('W/"abc123"');
    expect(result.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(result.body).toBe('[{"id":"1"}]');
  });

  it("parses 304 Not Modified with empty body", () => {
    const raw = [
      "HTTP/2.0 304 Not Modified",
      'Etag: W/"abc123"',
      "",
      "",
    ].join("\n");

    const result = parseGhIncludeResponse(raw);
    expect(result.statusCode).toBe(304);
    expect(result.body).toBe("");
  });

  it("lower-cases header names", () => {
    const raw = ["HTTP/2.0 200 OK", "ETag: foo", "Last-Modified: bar", "", "{}"].join("\n");
    const result = parseGhIncludeResponse(raw);
    expect(result.headers.etag).toBe("foo");
    expect(result.headers["last-modified"]).toBe("bar");
  });

  it("preserves colons in header values", () => {
    const raw = [
      "HTTP/2.0 200 OK",
      "Date: Wed, 28 Apr 2026 10:00:00 GMT",
      "",
      "{}",
    ].join("\n");
    const result = parseGhIncludeResponse(raw);
    expect(result.headers.date).toBe("Wed, 28 Apr 2026 10:00:00 GMT");
  });

  it("falls back to body-only with statusCode=0 when no header section is present", () => {
    // statusCode=0 is the "no HTTP status parsed" sentinel — distinct from
    // a legitimate 2xx so callers can fail loud rather than mistaking
    // unparseable output for success.
    const result = parseGhIncludeResponse("just a body");
    expect(result.statusCode).toBe(0);
    expect(result.headers).toEqual({});
    expect(result.body).toBe("just a body");
  });

  it("parses CRLF-separated headers (Go-style HTTP)", () => {
    const raw = [
      "HTTP/2.0 200 OK",
      'Etag: W/"abc123"',
      "Content-Type: application/json",
      "",
      '[{"id":"1"}]',
    ].join("\r\n");

    const result = parseGhIncludeResponse(raw);
    expect(result.statusCode).toBe(200);
    expect(result.headers.etag).toBe('W/"abc123"');
    expect(result.body).toBe('[{"id":"1"}]');
  });

  it("ignores malformed header lines without colons", () => {
    const raw = [
      "HTTP/2.0 200 OK",
      "Etag: W/\"abc\"",
      "garbage line without colon",
      "",
      "[]",
    ].join("\n");
    const result = parseGhIncludeResponse(raw);
    expect(result.headers.etag).toBe('W/"abc"');
    expect(Object.keys(result.headers)).toHaveLength(1);
    expect(result.body).toBe("[]");
  });

  it("returns statusCode=0 when first line is not HTTP-shaped", () => {
    const raw = ["NOT HTTP", "Etag: x", "", "{}"].join("\n");
    const result = parseGhIncludeResponse(raw);
    expect(result.statusCode).toBe(0);
  });
});

describe("isObservationFresh", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns true when no row exists for (source, ref)", () => {
    expect(isObservationFresh(db, "github:notification:owner/repo", "notification:1")).toBe(
      true,
    );
  });

  it("returns false when a pending row exists", () => {
    recordObservation(db, {
      source: "github:notification:owner/repo",
      ref: "notification:42",
      changeType: "created",
      actor: "user",
      payload: { foo: "bar" },
    });
    expect(
      isObservationFresh(db, "github:notification:owner/repo", "notification:42"),
    ).toBe(false);
  });

  it("returns false when only a consumed row exists (no re-emit on re-poll)", () => {
    recordObservation(db, {
      source: "github:notification:owner/repo",
      ref: "notification:99",
      changeType: "created",
      actor: "user",
      payload: { foo: "bar" },
    });
    db.prepare(
      "UPDATE observations SET consumed_at = CURRENT_TIMESTAMP, consumed_by = 'test' WHERE source = ? AND ref = ?",
    ).run("github:notification:owner/repo", "notification:99");
    expect(
      isObservationFresh(db, "github:notification:owner/repo", "notification:99"),
    ).toBe(false);
  });

  it("scopes by (source, ref) pair", () => {
    recordObservation(db, {
      source: "github:notification:owner/repo",
      ref: "notification:1",
      changeType: "created",
      actor: "user",
      payload: {},
    });
    // Different source — fresh
    expect(isObservationFresh(db, "github:workflow:owner/repo", "notification:1")).toBe(
      true,
    );
    // Different ref — fresh
    expect(isObservationFresh(db, "github:notification:owner/repo", "notification:2")).toBe(
      true,
    );
  });
});

describe("isWorkflowRepoCold", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns true when no workflow observations exist for the repo", () => {
    expect(isWorkflowRepoCold(db, "owner/repo")).toBe(true);
  });

  it("returns false once any workflow observation has been recorded", () => {
    recordObservation(db, {
      source: "github:workflow:owner/repo",
      ref: "workflow_run:1",
      changeType: "modified",
      actor: "user",
      payload: {},
    });
    expect(isWorkflowRepoCold(db, "owner/repo")).toBe(false);
  });

  it("scopes by repository — observations on a different repo do not warm this one", () => {
    recordObservation(db, {
      source: "github:workflow:other/repo",
      ref: "workflow_run:99",
      changeType: "modified",
      actor: "user",
      payload: {},
    });
    expect(isWorkflowRepoCold(db, "owner/repo")).toBe(true);
    expect(isWorkflowRepoCold(db, "other/repo")).toBe(false);
  });

  it("ignores notification-source observations — they don't warm the workflow path", () => {
    recordObservation(db, {
      source: "github:notification:owner/repo",
      ref: "notification:1",
      changeType: "created",
      actor: "user",
      payload: {},
    });
    expect(isWorkflowRepoCold(db, "owner/repo")).toBe(true);
  });
});

describe("GitHubPoller integration — runner-injected end-to-end", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let putSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    putSpy = vi.fn();
    // EventBus uses an internal priority heap; for these tests we only
    // care about put() being called with the right arguments.
    eventBus = { put: putSpy } as unknown as EventBus;
  });

  afterEach(() => {
    db.close();
  });

  function makeNotifResponse(
    items: Array<Partial<{ id: string; reason: string; subject: object; repository: object }>>,
  ): GhExecResult {
    const notifications = items.map((item, idx) => ({
      id: item.id ?? String(idx + 1),
      unread: true,
      reason: item.reason ?? "review_requested",
      updated_at: "2026-04-28T10:00:00Z",
      subject: item.subject ?? {
        title: "PR title",
        type: "PullRequest",
        url: "https://api.github.com/repos/owner/repo/pulls/1",
      },
      repository: item.repository ?? { full_name: "owner/repo" },
    }));
    const stdout = [
      "HTTP/2.0 200 OK",
      'Etag: W/"new-etag"',
      "Content-Type: application/json",
      "",
      JSON.stringify(notifications),
    ].join("\n");
    return { stdout, stderr: "", exitCode: 0 };
  }

  function makeNotModifiedResponse(): GhExecResult {
    return {
      stdout: "HTTP/2.0 304 Not Modified\nEtag: W/\"new-etag\"\n\n",
      stderr: "",
      exitCode: 0,
    };
  }

  it("emits HIGH event for review_requested on first poll, suppresses re-emit on second", async () => {
    const responses: GhExecResult[] = [
      // Initial poll: notifications API returns one review_requested
      makeNotifResponse([{ id: "1", reason: "review_requested" }]),
    ];
    const runner: GhRunner = vi.fn(async () => {
      const r = responses.shift();
      if (!r) throw new Error("runner queue exhausted");
      return r;
    });

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      pollIntervalSeconds: 600,
      runner,
    });
    await poller.start();
    await poller.stop();

    expect(putSpy).toHaveBeenCalledTimes(1);
    const event = putSpy.mock.calls[0][0];
    expect(event.type).toBe("github.pull_request.review_requested");

    // Re-poll same notification — observations(source, ref) pre-check
    // must suppress the second emit even though GitHub returns the same
    // unread notification.
    responses.push(makeNotifResponse([{ id: "1", reason: "review_requested" }]));
    // Reset ETag so the gh runner is invoked again (otherwise we'd 304).
    db.prepare("DELETE FROM runtime_state WHERE key = 'github_poller.notifications_etag'").run();

    await (poller as unknown as { poll: () => Promise<void> }).poll();
    expect(putSpy).toHaveBeenCalledTimes(1); // unchanged — no re-emit
  });

  it("processes ETag 304 responses without parsing or emit", async () => {
    const responses: GhExecResult[] = [
      // Initial poll returns one notification — establishes ETag
      makeNotifResponse([{ id: "1", reason: "review_requested" }]),
      // Second poll returns 304 Not Modified
      makeNotModifiedResponse(),
    ];
    const runner: GhRunner = vi.fn(async () => responses.shift()!);

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      pollIntervalSeconds: 600,
      runner,
    });
    await poller.start();
    expect(putSpy).toHaveBeenCalledTimes(1);

    await (poller as unknown as { poll: () => Promise<void> }).poll();
    // 304 returns silently — no additional work, no emit
    expect(putSpy).toHaveBeenCalledTimes(1);
    await poller.stop();
  });

  it("does NOT emit HIGH events for mention reason (NORMAL priority, observation only)", async () => {
    const responses: GhExecResult[] = [
      makeNotifResponse([{ id: "42", reason: "mention" }]),
    ];
    const runner: GhRunner = vi.fn(async () => responses.shift()!);

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      pollIntervalSeconds: 600,
      runner,
    });
    await poller.start();
    await poller.stop();

    // Mention is NORMAL — observation recorded but no EventBus emit
    expect(putSpy).not.toHaveBeenCalled();
    const obs = db
      .prepare("SELECT source, ref FROM observations WHERE source LIKE 'github:notification%'")
      .all() as Array<{ source: string; ref: string }>;
    expect(obs).toHaveLength(1);
    expect(obs[0].ref).toBe("notification:42");
  });

  it("direct repo config scopes notifications and polls workflow runs for that repo", async () => {
    const runner: GhRunner = vi.fn(async (args) => {
      const joined = args.join(" ");
      if (joined === "api repos/owner/repo --jq .default_branch") {
        return { stdout: "main\n", stderr: "", exitCode: 0 };
      }
      if (joined === "api notifications --include") {
        return makeNotifResponse([
          {
            id: "1",
            reason: "review_requested",
            repository: { full_name: "owner/repo" },
          },
          {
            id: "2",
            reason: "review_requested",
            repository: { full_name: "other/repo" },
          },
        ]);
      }
      if (joined === "api repos/owner/repo/actions/runs?status=failure&per_page=30") {
        return { stdout: JSON.stringify({ workflow_runs: [] }), stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected gh args: ${joined}`);
    });

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      repoFullNames: ["owner/repo"],
      pollIntervalSeconds: 600,
      runner,
    });
    await poller.start();
    await poller.stop();

    expect(putSpy).toHaveBeenCalledTimes(1);
    const event = putSpy.mock.calls[0][0];
    expect(event.data.repository).toBe("owner/repo");

    const obs = db
      .prepare("SELECT source, ref FROM observations WHERE source LIKE 'github:notification:%' ORDER BY ref")
      .all() as Array<{ source: string; ref: string }>;
    expect(obs).toEqual([
      { source: "github:notification:owner/repo", ref: "notification:1" },
    ]);
    expect(runner).toHaveBeenCalledWith([
      "api",
      "repos/owner/repo/actions/runs?status=failure&per_page=30",
    ]);
  });

  it("backs off exponentially on auth failure (gh exit nonzero, no HTTP status parsed)", async () => {
    const failResponse: GhExecResult = {
      stdout: "",
      stderr: "gh: To get started with GitHub CLI, please run:  gh auth login",
      exitCode: 4,
    };
    const responses: GhExecResult[] = [failResponse, failResponse, failResponse];
    const runner: GhRunner = vi.fn(async () => responses.shift() ?? failResponse);

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      pollIntervalSeconds: 600,
      runner,
    });
    await poller.start();

    // After failed initial poll, skipRemaining > 0 so the next poll() bails
    // before invoking the runner.
    const callsBefore = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await (poller as unknown as { poll: () => Promise<void> }).poll();
    const callsAfter = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore); // skipped
    await poller.stop();
  });

  it("does not register cursor rows in runtime_state (cursor was removed in favor of observation-existence cold-start)", async () => {
    // Verify the legacy `github_poller.workflow_cursor:*` key is not
    // written — we replaced the cursor approach with a check on the
    // observations table to fix a long-running-workflow drop bug.
    const runner: GhRunner = vi.fn(async () => makeNotModifiedResponse());
    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      pollIntervalSeconds: 600,
      runner,
    });
    await poller.start();
    await poller.stop();

    const cursorRows = db
      .prepare(
        "SELECT key FROM runtime_state WHERE key LIKE 'github_poller.workflow_cursor:%'",
      )
      .all();
    expect(cursorRows).toHaveLength(0);
  });

  it("workflow_runs cold-start: records observations without emit on first poll, emits only for new runs after", async () => {
    function makeWorkflowRunsResponse(runs: Array<Partial<{
      id: number;
      head_branch: string;
      conclusion: string;
      status: string;
    }>>): GhExecResult {
      const workflow_runs = runs.map((run, idx) => ({
        id: run.id ?? idx + 1,
        name: "ci",
        display_title: "Build",
        status: run.status ?? "completed",
        conclusion: run.conclusion ?? "failure",
        head_branch: run.head_branch ?? "main",
        html_url: `https://github.com/owner/repo/actions/runs/${run.id ?? idx + 1}`,
        updated_at: "2026-04-28T10:00:00Z",
        event: "push",
      }));
      return {
        stdout: JSON.stringify({ workflow_runs }),
        stderr: "",
        exitCode: 0,
      };
    }

    // Inject pre-built repo binding so we can skip git/gh resolution.
    const binding = {
      localPath: "/tmp/fake",
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
      defaultBranch: "main",
    };

    // Initial poll: 2 historical default-branch failures already on GitHub.
    // Cold-start path should record them WITHOUT emitting EventBus events.
    const responses: GhExecResult[] = [
      makeNotModifiedResponse(), // notifications poll: 304
      makeWorkflowRunsResponse([
        { id: 100, head_branch: "main", conclusion: "failure" },
        { id: 101, head_branch: "main", conclusion: "failure" },
      ]),
    ];
    const runner: GhRunner = vi.fn(async () => {
      const r = responses.shift();
      if (!r) throw new Error("runner queue exhausted");
      return r;
    });

    // Seed an etag so the notifications poll returns 304 without invoking
    // classification logic — keeps this test focused on the workflow path.
    db.prepare(
      "INSERT INTO runtime_state (key, value_json) VALUES ('github_poller.notifications_etag', '\"prior-etag\"')",
    ).run();

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [], // resolved via repoBindings instead
      repoBindings: [binding],
      pollIntervalSeconds: 600,
      runner,
    });
    await poller.start();

    // Cold-start: NO emit despite default-branch failures.
    expect(putSpy).not.toHaveBeenCalled();
    // But observations were recorded.
    const initialObs = db
      .prepare("SELECT ref FROM observations WHERE source = 'github:workflow:owner/repo' ORDER BY ref")
      .all() as Array<{ ref: string }>;
    expect(initialObs).toHaveLength(2);

    // Second poll: a NEW failure (id=102) appears alongside the old ones.
    // Only the new ref should emit a HIGH event.
    responses.push(
      makeNotModifiedResponse(),
      makeWorkflowRunsResponse([
        { id: 102, head_branch: "main", conclusion: "failure" },
        { id: 100, head_branch: "main", conclusion: "failure" },
        { id: 101, head_branch: "main", conclusion: "failure" },
      ]),
    );
    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(putSpy).toHaveBeenCalledTimes(1);
    const event = putSpy.mock.calls[0][0];
    expect(event.type).toBe("github.workflow_run.failed");
    expect(event.data.runId).toBe(102);

    // Third poll: same set, no new failures. No additional emits.
    responses.push(
      makeNotModifiedResponse(),
      makeWorkflowRunsResponse([
        { id: 102, head_branch: "main", conclusion: "failure" },
        { id: 100, head_branch: "main", conclusion: "failure" },
      ]),
    );
    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(putSpy).toHaveBeenCalledTimes(1); // unchanged
    await poller.stop();
  });

  it("workflow_runs feature-branch failures: record observation, no EventBus emit even when warm", async () => {
    function makeWorkflowRunsResponse(runs: Array<Partial<{ id: number; head_branch: string }>>): GhExecResult {
      const workflow_runs = runs.map((run, idx) => ({
        id: run.id ?? idx + 1,
        name: "ci",
        display_title: "Build",
        status: "completed",
        conclusion: "failure",
        head_branch: run.head_branch ?? "feat/foo",
        html_url: `https://github.com/owner/repo/actions/runs/${run.id ?? idx + 1}`,
        updated_at: "2026-04-28T10:00:00Z",
        event: "push",
      }));
      return { stdout: JSON.stringify({ workflow_runs }), stderr: "", exitCode: 0 };
    }

    const binding = {
      localPath: "/tmp/fake",
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
      defaultBranch: "main",
    };

    // Pre-warm: insert a sentinel observation so the next poll uses the
    // hot path (not cold-start).
    recordObservation(db, {
      source: "github:workflow:owner/repo",
      ref: "workflow_run:1",
      changeType: "modified",
      actor: "user",
      payload: {},
    });

    const responses: GhExecResult[] = [
      makeNotModifiedResponse(),
      makeWorkflowRunsResponse([
        { id: 200, head_branch: "feat/dev" },
      ]),
    ];
    const runner: GhRunner = vi.fn(async () => responses.shift()!);

    db.prepare(
      "INSERT INTO runtime_state (key, value_json) VALUES ('github_poller.notifications_etag', '\"prior-etag\"')",
    ).run();

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      repoBindings: [binding],
      pollIntervalSeconds: 600,
      runner,
    });
    await poller.start();
    await poller.stop();

    // Feature-branch failure: observation recorded, no EventBus emit.
    expect(putSpy).not.toHaveBeenCalled();
    const obs = db
      .prepare(
        "SELECT ref FROM observations WHERE source = 'github:workflow:owner/repo' ORDER BY ref",
      )
      .all() as Array<{ ref: string }>;
    expect(obs.map((o) => o.ref)).toContain("workflow_run:200");
  });
});

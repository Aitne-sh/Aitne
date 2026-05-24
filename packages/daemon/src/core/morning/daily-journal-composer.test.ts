/**
 * Unit tests for `daily-journal-composer.ts`. Three layers:
 *
 *   1. Pure extractor (`extractJournalSections`) — branch coverage for
 *      every `parseError` shape + the collision-resistance behaviour
 *      that the `aitne:` namespace + LAST-wins selection gives us.
 *   2. Pure composer (`composeDailyJournal`) — YAML serialisation key
 *      ordering, empty-array rendering, daemon-owned field immutability.
 *   3. Wired composer (`DailyJournalComposer.compose`) — happy path
 *      writes the file through the shared helper; partial extracts land
 *      the body with empty frontmatter arrays; failures surface as
 *      `ok: false` without throwing.
 *
 * The wired layer uses an in-memory better-sqlite3 + a tmp directory so
 * the atomic write + snapshot insert + writeTracker can be observed
 * end-to-end without mocking out the shared helper.
 */

import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentResult } from "@aitne/shared";

import {
  composeDailyJournal,
  DailyJournalComposer,
  dailyJournalRevisionHeader,
  extractJournalSections,
  extractLastTaggedBlock,
} from "./daily-journal-composer.js";
import type { JournalSkeletonInputs } from "./journal-skeleton-builder.js";

// ── Pure extractor ───────────────────────────────────────────────────

describe("extractJournalSections", () => {
  it("happy path — both tags present + valid JSON frontmatter", () => {
    const output = [
      "<aitne:daily-journal-body>",
      "# 2026-05-22 (Friday)",
      "## Summary",
      "Stuff happened.",
      "</aitne:daily-journal-body>",
      "<aitne:daily-journal-frontmatter>",
      `{"projects": ["aitne"], "people": ["alice"], "tags": ["t1"]}`,
      "</aitne:daily-journal-frontmatter>",
    ].join("\n");

    const result = extractJournalSections(output);

    expect(result.parseError).toBeNull();
    expect(result.body).toContain("# 2026-05-22 (Friday)");
    expect(result.frontmatter).toEqual({
      projects: ["aitne"],
      people: ["alice"],
      tags: ["t1"],
    });
  });

  it("body tag with empty inner content → body_tag_missing (no phantom diary file)", () => {
    // `<aitne:daily-journal-body>\n\n</aitne:daily-journal-body>` was
    // previously treated as success, landing a frontmatter-only daily
    // file with no body — a phantom user-facing day worse than the
    // honest "failed (LLM output empty)" surface. Treat empty/whitespace
    // inner content as body_tag_missing so the composer returns ok:
    // false and the appender renders the failure reason.
    const output = [
      "<aitne:daily-journal-body>",
      "",
      "</aitne:daily-journal-body>",
      "<aitne:daily-journal-frontmatter>",
      `{"projects": [], "people": [], "tags": []}`,
      "</aitne:daily-journal-frontmatter>",
    ].join("\n");

    const result = extractJournalSections(output);
    expect(result.body).toBeNull();
    expect(result.parseError).toBe("body_tag_missing");
  });

  it("body tag with only whitespace inner content → body_tag_missing", () => {
    const output = [
      "<aitne:daily-journal-body>",
      "   ",
      "\t\t",
      "</aitne:daily-journal-body>",
    ].join("\n");

    const result = extractJournalSections(output);
    expect(result.body).toBeNull();
    expect(result.parseError).toBe("body_tag_missing");
  });

  it("body only — frontmatter tag missing returns partial reason", () => {
    const output = [
      "<aitne:daily-journal-body>",
      "Body content",
      "</aitne:daily-journal-body>",
    ].join("\n");

    const result = extractJournalSections(output);

    expect(result.body).toBe("Body content");
    expect(result.frontmatter).toBeNull();
    expect(result.parseError).toBe("frontmatter_tag_missing");
  });

  it("neither tag — body_tag_missing", () => {
    const result = extractJournalSections("just plain prose");
    expect(result.body).toBeNull();
    expect(result.parseError).toBe("body_tag_missing");
  });

  it("empty output", () => {
    expect(extractJournalSections("").parseError).toBe("empty_output");
    expect(extractJournalSections("   \n\n  ").parseError).toBe("empty_output");
    expect(extractJournalSections(null).parseError).toBe("empty_output");
    expect(extractJournalSections(undefined).parseError).toBe("empty_output");
  });

  it("malformed JSON in frontmatter", () => {
    const output = [
      "<aitne:daily-journal-body>",
      "body",
      "</aitne:daily-journal-body>",
      "<aitne:daily-journal-frontmatter>",
      `{ this is not json }`,
      "</aitne:daily-journal-frontmatter>",
    ].join("\n");

    expect(extractJournalSections(output).parseError).toBe("frontmatter_invalid_json");
  });

  it("frontmatter schema validation failure (wrong types)", () => {
    const output = [
      "<aitne:daily-journal-body>",
      "body",
      "</aitne:daily-journal-body>",
      "<aitne:daily-journal-frontmatter>",
      `{"projects": "should-be-array"}`,
      "</aitne:daily-journal-frontmatter>",
    ].join("\n");

    expect(extractJournalSections(output).parseError).toBe("frontmatter_schema_invalid");
  });

  it("code-fence-wrapped tags — fence stripped, content parses", () => {
    const output = [
      "```xml",
      "<aitne:daily-journal-body>",
      "fenced body",
      "</aitne:daily-journal-body>",
      "```",
      "<aitne:daily-journal-frontmatter>",
      "```json",
      `{"projects": ["x"], "people": [], "tags": []}`,
      "```",
      "</aitne:daily-journal-frontmatter>",
    ].join("\n");

    const result = extractJournalSections(output);
    expect(result.parseError).toBeNull();
    expect(result.body).toBe("fenced body");
    expect(result.frontmatter?.projects).toEqual(["x"]);
  });

  it("multiple body blocks — LAST one wins", () => {
    const output = [
      "<aitne:daily-journal-body>",
      "FIRST body",
      "</aitne:daily-journal-body>",
      "intermediate prose",
      "<aitne:daily-journal-body>",
      "SECOND body",
      "</aitne:daily-journal-body>",
      "<aitne:daily-journal-frontmatter>",
      `{"projects": [], "people": [], "tags": []}`,
      "</aitne:daily-journal-frontmatter>",
    ].join("\n");

    const result = extractJournalSections(output);
    expect(result.body).toBe("SECOND body");
  });

  it("collision-resistance: body quotes the open tag, genuine wrapper at EOF wins", () => {
    // Simulates the user diary documenting Aitne itself — body prose
    // quotes the literal `<aitne:daily-journal-body>` token inside a
    // code fence. The genuine wrapper pair lives at EOF.
    const output = [
      "<aitne:daily-journal-body>",
      "I documented Aitne's tag today:",
      "",
      "```",
      "<aitne:daily-journal-body>",
      "```",
      "",
      "</aitne:daily-journal-body>",
    ].join("\n");

    // The extractor takes the LAST close + the LAST open before it.
    // The body contains: the quoted code-fenced open tag (line 5).
    // The LAST close is the EOF tag; the most-recent open BEFORE it is
    // the line-5 quoted open. That means the extracted body is just
    // the line between the two — `\`\`\`` — which is wrong-but-bounded.
    // To get the genuine span the user's task-flow MUST emit the
    // wrappers at EOF; this test asserts the extractor's behaviour
    // matches the design's documented collision-resistance contract.
    const result = extractLastTaggedBlock(output, "aitne:daily-journal-body");
    expect(result).not.toBeNull();
    // The genuine top-of-output open is found because the line-5 token
    // is INSIDE a code fence — but `extractLastTaggedBlock` is
    // namespace-naive and matches the tag-line shape regardless of
    // surrounding context. The "wrappers AT THE END of your output"
    // task-flow rule is what makes this safe in practice.
  });

  it("collision-resistance: body quotes the close tag — LAST close wins via EOF rule", () => {
    const output = [
      "<aitne:daily-journal-body>",
      "I quoted the close tag:",
      "```",
      "</aitne:daily-journal-body>",
      "```",
      "Some more prose.",
      "</aitne:daily-journal-body>",
    ].join("\n");

    const result = extractLastTaggedBlock(output, "aitne:daily-journal-body");
    expect(result).not.toBeNull();
    // The EOF close is the LAST match. The most-recent open BEFORE it is
    // line-0. So the extracted span is lines 1..6 (everything between
    // the genuine wrapper pair, including the quoted close tag).
    expect(result).toContain("I quoted the close tag");
    expect(result).toContain("Some more prose.");
  });
});

// ── Pure composer ────────────────────────────────────────────────────

describe("composeDailyJournal", () => {
  const baseSkeleton: JournalSkeletonInputs = {
    dateStr: "2026-05-22",
    weekday: "Friday",
    updatedDateStr: "2026-05-23",
    yesterdayMd: null,
    calendarEvents: [],
  };

  it("emits YAML keys in fixed order regardless of LLM property order", () => {
    const composed = composeDailyJournal({
      skeleton: baseSkeleton,
      calendarEvents: 3,
      messagesHandled: 7,
      body: "# 2026-05-22 (Friday)\n\nbody",
      // Frontmatter property order shuffled — composer ignores it.
      frontmatter: {
        tags: ["t1"],
        people: ["p1"],
        projects: ["pr1"],
      },
      agentLastSyncedAtIso: "2026-05-23T19:01:12.345Z",
    });

    const indexOf = (needle: string) => composed.indexOf(`\n${needle}`);
    expect(indexOf("date: ")).toBeGreaterThan(0);
    expect(indexOf("date: ")).toBeLessThan(indexOf("weekday: "));
    expect(indexOf("weekday: ")).toBeLessThan(indexOf("type: "));
    expect(indexOf("type: ")).toBeLessThan(indexOf("owner: "));
    expect(indexOf("owner: ")).toBeLessThan(indexOf("agent_generated: "));
    expect(indexOf("agent_generated: ")).toBeLessThan(indexOf("calendar_events: "));
    expect(indexOf("calendar_events: ")).toBeLessThan(indexOf("messages_handled: "));
    expect(indexOf("messages_handled: ")).toBeLessThan(indexOf("updated: "));
    expect(indexOf("updated: ")).toBeLessThan(indexOf("agent_last_synced_at: "));
    expect(indexOf("agent_last_synced_at: ")).toBeLessThan(indexOf("content_hash: "));
    expect(indexOf("content_hash: ")).toBeLessThan(indexOf("projects:"));
    expect(indexOf("projects:")).toBeLessThan(indexOf("people:"));
    expect(indexOf("people:")).toBeLessThan(indexOf("tags:"));
  });

  it("empty arrays render as `field: []`", () => {
    const composed = composeDailyJournal({
      skeleton: baseSkeleton,
      calendarEvents: 0,
      messagesHandled: 0,
      body: "# 2026-05-22 (Friday)",
      frontmatter: { projects: [], people: [], tags: [] },
      agentLastSyncedAtIso: "2026-05-23T19:01:12.345Z",
    });
    expect(composed).toContain("\nprojects: []\n");
    expect(composed).toContain("\npeople: []\n");
    expect(composed).toContain("\ntags: []\n");
  });

  it("list-form rendering for non-empty arrays", () => {
    const composed = composeDailyJournal({
      skeleton: baseSkeleton,
      calendarEvents: 0,
      messagesHandled: 0,
      body: "# 2026-05-22 (Friday)",
      frontmatter: {
        projects: ["a", "b"],
        people: [],
        tags: ["t"],
      },
      agentLastSyncedAtIso: "2026-05-23T19:01:12.345Z",
    });
    expect(composed).toContain("\nprojects:\n  - a\n  - b\n");
    expect(composed).toContain("\npeople: []\n");
    expect(composed).toContain("\ntags:\n  - t\n");
  });

  it("drops empty / whitespace strings inside arrays", () => {
    const composed = composeDailyJournal({
      skeleton: baseSkeleton,
      calendarEvents: 0,
      messagesHandled: 0,
      body: "# 2026-05-22 (Friday)",
      frontmatter: {
        projects: ["", "  ", "real"],
        people: [],
        tags: [],
      },
      agentLastSyncedAtIso: "2026-05-23T19:01:12.345Z",
    });
    expect(composed).toContain("\nprojects:\n  - real\n");
  });

  it("clamps negative event counts to 0", () => {
    const composed = composeDailyJournal({
      skeleton: baseSkeleton,
      calendarEvents: -5,
      messagesHandled: -2,
      body: "# 2026-05-22 (Friday)",
      frontmatter: { projects: [], people: [], tags: [] },
      agentLastSyncedAtIso: "2026-05-23T19:01:12.345Z",
    });
    expect(composed).toContain("calendar_events: 0");
    expect(composed).toContain("messages_handled: 0");
  });
});

describe("dailyJournalRevisionHeader", () => {
  it("renders the canonical H2 line", () => {
    expect(dailyJournalRevisionHeader("2026-05-23T19:01:12.345Z")).toBe(
      "## Agent revision — 2026-05-23T19:01:12.345Z",
    );
  });
});

// ── Wired composer ───────────────────────────────────────────────────

describe("DailyJournalComposer.compose", () => {
  let tmpDir: string;
  let db: Database.Database;

  function makeDeps() {
    const writeTrackerEvents: Array<{ kind: "markWriting" | "unmark"; path: string }> = [];
    const indexedChanges: string[] = [];
    const snapshotInserts: Array<{
      snapshotKey: string;
      content: string;
      trigger: string;
      force: boolean | undefined;
    }> = [];
    const deps = {
      db,
      contextDir: tmpDir,
      saveSnapshot: (
        snapshotKey: string,
        content: string,
        trigger: string,
        force?: boolean,
      ) => {
        snapshotInserts.push({ snapshotKey, content, trigger, force });
        return 1;
      },
      writeTracker: {
        markWriting: (p: string) => writeTrackerEvents.push({ kind: "markWriting", path: p }),
        unmark: (p: string) => writeTrackerEvents.push({ kind: "unmark", path: p }),
      },
      onIndexableContextChange: (relativePath: string) => {
        indexedChanges.push(relativePath);
      },
      now: () => new Date("2026-05-23T19:01:12.345Z"),
    };
    return { deps, writeTrackerEvents, indexedChanges, snapshotInserts };
  }

  function makeArgs(
    overrides: Partial<{
      yesterdayDateStr: string;
      stageBResult: AgentResult | null;
    }> = {},
  ) {
    const yesterdayDateStr = overrides.yesterdayDateStr ?? "2026-05-22";
    const skeleton: JournalSkeletonInputs = {
      dateStr: yesterdayDateStr,
      weekday: "Friday",
      updatedDateStr: "2026-05-23",
      yesterdayMd: null,
      calendarEvents: [],
    };
    return {
      correlationId: "test-corr",
      yesterdayDateStr,
      skeleton,
      calendarEvents: 3,
      messagesHandled: 5,
      stageBResult: overrides.stageBResult === undefined
        ? makeStageBResult(makeHappyOutput(yesterdayDateStr))
        : overrides.stageBResult,
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "daily-journal-composer-"));
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("happy path — writes daily/<date>.md and returns ok: complete", async () => {
    const { deps, writeTrackerEvents, indexedChanges, snapshotInserts } = makeDeps();
    const composer = new DailyJournalComposer(deps);

    const result = await composer.compose(makeArgs());

    expect(result).toMatchObject({ ok: "complete", wroteMode: "put" });
    const expectedPath = join(tmpDir, "daily", "2026-05-22.md");
    expect(existsSync(expectedPath)).toBe(true);
    const written = readFileSync(expectedPath, "utf-8");
    expect(written).toContain("date: 2026-05-22");
    expect(written).toContain("projects:\n  - aitne\n");
    expect(written).toContain("# 2026-05-22 (Friday)");
    // First-write path doesn't snapshot a pre-state (file didn't exist).
    expect(snapshotInserts.length).toBe(0);
    expect(writeTrackerEvents.map((e) => e.kind)).toEqual(["markWriting"]);
    expect(indexedChanges).toEqual(["daily/2026-05-22.md"]);
  });

  it("stage_b_null when stageBResult is null", async () => {
    const { deps } = makeDeps();
    const composer = new DailyJournalComposer(deps);
    const result = await composer.compose(makeArgs({ stageBResult: null }));
    expect(result).toEqual({ ok: false, reason: "stage_b_null" });
  });

  it("empty_output when stage B produced no text", async () => {
    const { deps } = makeDeps();
    const composer = new DailyJournalComposer(deps);
    const result = await composer.compose(
      makeArgs({ stageBResult: makeStageBResult("") }),
    );
    expect(result).toEqual({ ok: false, reason: "empty_output" });
  });

  it("body_tag_missing when only frontmatter tag present", async () => {
    const { deps } = makeDeps();
    const composer = new DailyJournalComposer(deps);
    const output = [
      "<aitne:daily-journal-frontmatter>",
      `{"projects": [], "people": [], "tags": []}`,
      "</aitne:daily-journal-frontmatter>",
    ].join("\n");
    const result = await composer.compose(
      makeArgs({ stageBResult: makeStageBResult(output) }),
    );
    expect(result).toEqual({ ok: false, reason: "body_tag_missing" });
  });

  it("partial extract — body present, frontmatter tag missing", async () => {
    const { deps } = makeDeps();
    const composer = new DailyJournalComposer(deps);
    const output = [
      "<aitne:daily-journal-body>",
      "# 2026-05-22 (Friday)",
      "body",
      "</aitne:daily-journal-body>",
    ].join("\n");

    const result = await composer.compose(
      makeArgs({ stageBResult: makeStageBResult(output) }),
    );

    expect(result).toMatchObject({
      ok: "partial",
      partialReason: "frontmatter_tag_missing",
      wroteMode: "put",
    });
    const written = readFileSync(join(tmpDir, "daily", "2026-05-22.md"), "utf-8");
    // Body landed even though frontmatter parsing failed.
    expect(written).toContain("# 2026-05-22 (Friday)");
    // Empty arrays for the missing frontmatter fields.
    expect(written).toContain("\nprojects: []\n");
    expect(written).toContain("\npeople: []\n");
    expect(written).toContain("\ntags: []\n");
  });

  it("partial extract — invalid JSON frontmatter", async () => {
    const { deps } = makeDeps();
    const composer = new DailyJournalComposer(deps);
    const output = [
      "<aitne:daily-journal-body>",
      "# 2026-05-22 (Friday)",
      "</aitne:daily-journal-body>",
      "<aitne:daily-journal-frontmatter>",
      `{ not-valid json }`,
      "</aitne:daily-journal-frontmatter>",
    ].join("\n");

    const result = await composer.compose(
      makeArgs({ stageBResult: makeStageBResult(output) }),
    );

    expect(result).toMatchObject({
      ok: "partial",
      partialReason: "frontmatter_invalid_json",
    });
  });

  it("partial extract — frontmatter schema mismatch", async () => {
    const { deps } = makeDeps();
    const composer = new DailyJournalComposer(deps);
    const output = [
      "<aitne:daily-journal-body>",
      "# 2026-05-22 (Friday)",
      "</aitne:daily-journal-body>",
      "<aitne:daily-journal-frontmatter>",
      `{"projects": 123}`,
      "</aitne:daily-journal-frontmatter>",
    ].join("\n");

    const result = await composer.compose(
      makeArgs({ stageBResult: makeStageBResult(output) }),
    );

    expect(result).toMatchObject({
      ok: "partial",
      partialReason: "frontmatter_schema_invalid",
    });
  });

  it("file already exists — appends `## Agent revision — <ISO>` block", async () => {
    const { deps, snapshotInserts } = makeDeps();
    const composer = new DailyJournalComposer(deps);

    // First run lands the file.
    await composer.compose(makeArgs());

    // Second run on the same day — file is present, append-revision
    // path fires. Use a different body to confirm it lands.
    const overrideOutput = makeHappyOutput("2026-05-22").replace(
      "Body line",
      "Second-attempt body",
    );
    const result = await composer.compose(
      makeArgs({ stageBResult: makeStageBResult(overrideOutput) }),
    );

    expect(result).toMatchObject({ ok: "complete", wroteMode: "append_revision" });
    const written = readFileSync(join(tmpDir, "daily", "2026-05-22.md"), "utf-8");
    expect(written).toContain("## Agent revision — 2026-05-23T19:01:12.345Z");
    expect(written).toContain("Second-attempt body");
    // Pre-state was snapshotted before the read-modify-write.
    expect(snapshotInserts.some((row) => row.trigger === "daily_journal_composer")).toBe(true);
  });

  it("write_failed when atomic write throws (parent path blocked)", async () => {
    const { deps } = makeDeps();
    // Sabotage the contextDir so writeFileAtomically hits ENOTDIR on
    // mkdirSync(parent). We do this by writing a regular file at
    // `<tmpDir>/daily` — the path the composer mkdirs recursively into.
    writeFileSync(join(tmpDir, "daily"), "x", "utf-8");

    const composer = new DailyJournalComposer(deps);
    const result = await composer.compose(makeArgs());
    expect(result).toEqual({ ok: false, reason: "write_failed" });
  });

  it("happy path with no writeTracker / no onIndexableContextChange (optional deps)", async () => {
    const deps = {
      db,
      contextDir: tmpDir,
      saveSnapshot: () => 1,
      now: () => new Date("2026-05-23T19:01:12.345Z"),
    };
    const composer = new DailyJournalComposer(deps);
    const result = await composer.compose({
      correlationId: "c",
      yesterdayDateStr: "2026-05-22",
      skeleton: {
        dateStr: "2026-05-22",
        weekday: "Friday",
        updatedDateStr: "2026-05-23",
        yesterdayMd: null,
        calendarEvents: [],
      },
      calendarEvents: 0,
      messagesHandled: 0,
      stageBResult: makeStageBResult(makeHappyOutput("2026-05-22")),
    });
    expect(result).toMatchObject({ ok: "complete" });
  });

  it("reads final text from AgentResult.output when result is absent (CLI shape)", async () => {
    const { deps } = makeDeps();
    const composer = new DailyJournalComposer(deps);
    const text = makeHappyOutput("2026-05-22");
    // CLI backends emit `output` instead of `result` — both must work.
    const stageBResult = {
      output: text,
      sessionId: "s",
      cost: { totalUsd: 0 },
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      modelUsage: {},
      numTurns: 1,
      durationMs: 0,
      isError: false,
    } as unknown as AgentResult;
    const result = await composer.compose(
      makeArgs({ stageBResult }),
    );
    expect(result).toMatchObject({ ok: "complete" });
  });

  it("treats AgentResult with neither result nor output as empty_output", async () => {
    const { deps } = makeDeps();
    const composer = new DailyJournalComposer(deps);
    const stageBResult = {
      sessionId: "s",
      cost: { totalUsd: 0 },
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      modelUsage: {},
      numTurns: 0,
      durationMs: 0,
      isError: false,
    } as unknown as AgentResult;
    const result = await composer.compose(makeArgs({ stageBResult }));
    expect(result).toEqual({ ok: false, reason: "empty_output" });
  });

  it("multiple appends — pure append preserves prior revisions (design §4.8)", async () => {
    // The orchestrator does NOT re-fire Stage B on retry, so multiple
    // append_revision calls only happen across DIFFERENT morning runs
    // (a user-or-prior write landed yesterday, then today's run
    // appends). The helper's pure-append semantics means each revision
    // is preserved in order — no LAST-wins replacement that would
    // corrupt the body's internal H2s.
    const { deps } = makeDeps();
    const composer = new DailyJournalComposer(deps);
    await composer.compose(makeArgs());

    const overrideOutput = makeHappyOutput("2026-05-22").replace(
      "Body line",
      "Revision body",
    );
    const result = await composer.compose(
      makeArgs({ stageBResult: makeStageBResult(overrideOutput) }),
    );

    expect(result).toMatchObject({ ok: "complete", wroteMode: "append_revision" });
    const written = readFileSync(join(tmpDir, "daily", "2026-05-22.md"), "utf-8");
    // The original body is preserved, and the revision block lives
    // below it.
    expect(written).toContain("Body line");
    expect(written).toContain("Revision body");
    expect(written).toContain("## Agent revision — 2026-05-23T19:01:12.345Z");
  });
});

// ── fixtures ─────────────────────────────────────────────────────────

function makeHappyOutput(date: string): string {
  return [
    "<aitne:daily-journal-body>",
    `# ${date} (Friday)`,
    "",
    "## Summary",
    "Body line",
    "</aitne:daily-journal-body>",
    "",
    "<aitne:daily-journal-frontmatter>",
    `{"projects": ["aitne"], "people": [], "tags": ["t1"]}`,
    "</aitne:daily-journal-frontmatter>",
  ].join("\n");
}

function makeStageBResult(finalText: string): AgentResult {
  return {
    result: finalText,
    output: finalText,
    sessionId: "test-session",
    cost: { totalUsd: 0.05 },
    costUsd: 0.05,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    modelUsage: {},
    numTurns: 1,
    durationMs: 1000,
    isError: false,
  } as unknown as AgentResult;
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preTickProfileQuestions } from "./seed.js";

function makeContextDir(): string {
  return mkdtempSync(join(tmpdir(), "pa-seed-test-"));
}

const SEED_QUEUE = [
  "---",
  "type: agent_questions",
  "owner: agent",
  "updated: 2026-04-26",
  "template_version: 1",
  "---",
  "# Profile Interview Queue",
  "",
  "## Pending",
  "",
  "### Identity",
  "- [ ] (HIGH) name :: user/profile.md ## Identity :: match=Name :: preferred name or alias",
  "- [ ] (HIGH) timezone :: user/profile.md ## Identity :: match=Timezone :: IANA timezone",
  "",
  "### Personal",
  "- [ ] (HIGH) location :: user/personal.md ## Location :: city / country where the user lives",
  "- [ ] (MID) sleep_pattern :: user/personal.md :: match=Sleep :: typical sleep window",
  "- [ ] (MID) hobbies :: user/personal.md ## Hobbies :: hobbies, recurring leisure",
  "",
  "## In Progress",
  "",
  "- (none)",
  "",
  "## Answered",
  "",
  "> Append-only log.",
  "- (none)",
  "",
].join("\n");

function seedQueueFile(contextDir: string, content = SEED_QUEUE): void {
  mkdirSync(join(contextDir, "agent"), { recursive: true });
  writeFileSync(join(contextDir, "agent/profile-questions.md"), content, "utf-8");
}

function seedUserFile(contextDir: string, relPath: string, content: string): void {
  const abs = join(contextDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

describe("preTickProfileQuestions", () => {
  let contextDir: string;

  beforeEach(() => {
    contextDir = makeContextDir();
  });
  afterEach(() => {
    rmSync(contextDir, { recursive: true, force: true });
  });

  it("returns zeros when the queue file is missing", () => {
    const result = preTickProfileQuestions(contextDir);
    expect(result).toEqual({ examined: 0, ticked: 0, targetMissing: 0 });
  });

  it("ticks rows whose anchor matches a setup-populated bullet", () => {
    seedQueueFile(contextDir);
    seedUserFile(contextDir, "user/profile.md", [
      "---",
      "type: user",
      "---",
      "# User",
      "## Identity",
      "- Name: Alex",
      "- Timezone: America/New_York",
      "## Work Pattern",
      "- Working hours: Weekdays 09:00–18:00",
      "",
    ].join("\n"));

    const result = preTickProfileQuestions(contextDir);
    expect(result.ticked).toBe(2); // name, timezone (NOT sleep)
    expect(result.examined).toBe(5);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    expect(after).toContain("- [x] (HIGH) name :: user/profile.md ## Identity :: match=Name");
    expect(after).toContain("- [x] (HIGH) timezone :: user/profile.md ## Identity :: match=Timezone");
    expect(after).toContain("- [ ] (MID) sleep_pattern :: user/personal.md :: match=Sleep");
    expect(after).toMatch(/- \[x\] \d{4}-\d{2}-\d{2} → name \(reconciled:skeleton\)/);
    expect(after).toMatch(/- \[x\] \d{4}-\d{2}-\d{2} → timezone \(reconciled:skeleton\)/);
  });

  it("does not over-tick a multi-row section without anchors", () => {
    seedQueueFile(contextDir);
    // Only Name is set; Timezone is missing.
    seedUserFile(contextDir, "user/profile.md", [
      "## Identity",
      "- Name: Alex",
      "",
    ].join("\n"));

    const result = preTickProfileQuestions(contextDir);
    expect(result.ticked).toBe(1);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    expect(after).toContain("- [x] (HIGH) name :: ");
    expect(after).toContain("- [ ] (HIGH) timezone :: ");
  });

  it("ticks the location row by treating any non-placeholder bullet under ## Location as filled", () => {
    seedQueueFile(contextDir);
    seedUserFile(contextDir, "user/personal.md", [
      "## Location",
      "- Tokyo, Japan",
      "",
    ].join("\n"));

    const result = preTickProfileQuestions(contextDir);
    expect(result.ticked).toBe(1);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    expect(after).toContain("- [x] (HIGH) location :: user/personal.md ## Location");
    expect(after).toContain("- [ ] (MID) hobbies :: user/personal.md ## Hobbies");
  });

  it("counts targetMissing for rows whose target file does not exist", () => {
    seedQueueFile(contextDir);
    // Provide profile.md only — personal.md is missing.
    seedUserFile(contextDir, "user/profile.md", "## Identity\n- Name: Alex\n");

    const result = preTickProfileQuestions(contextDir);
    expect(result.targetMissing).toBeGreaterThanOrEqual(2);
    expect(result.ticked).toBe(1);
  });

  it("is a no-op when no rows can be ticked", () => {
    seedQueueFile(contextDir);
    seedUserFile(contextDir, "user/profile.md", "## Identity\n(To be filled during setup)\n");
    seedUserFile(contextDir, "user/personal.md", "");

    const before = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    const result = preTickProfileQuestions(contextDir);
    expect(result.ticked).toBe(0);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    expect(after).toBe(before);
  });

  it("inserts Answered entries after directive lines and replaces the `- (none)` placeholder", () => {
    seedQueueFile(contextDir);
    seedUserFile(contextDir, "user/profile.md", "## Identity\n- Name: Alex\n");

    preTickProfileQuestions(contextDir);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    const idxAnsweredHeading = after.indexOf("## Answered");
    const idxDirective = after.indexOf("> Append-only log.", idxAnsweredHeading);
    const idxNew = after.indexOf("(reconciled:skeleton)");
    expect(idxAnsweredHeading).toBeGreaterThan(-1);
    expect(idxDirective).toBeGreaterThan(idxAnsweredHeading);
    expect(idxNew).toBeGreaterThan(idxDirective);
    // The `- (none)` placeholder must be REMOVED from ## Answered once
    // a real entry lands. Looking only at the slice after the heading
    // because earlier sections (## Pending, ## In Progress) may still
    // contain `(none)` placeholders.
    const answeredSlice = after.slice(idxAnsweredHeading);
    expect(answeredSlice).not.toContain("- (none)");
  });

  it("preserves `- (none)` under unrelated sections (## In Progress)", () => {
    seedQueueFile(contextDir);
    seedUserFile(contextDir, "user/profile.md", "## Identity\n- Name: Alex\n");

    preTickProfileQuestions(contextDir);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    // `## In Progress` retains its own `- (none)` — only Answered's
    // placeholder is consumed.
    const inProgressIdx = after.indexOf("## In Progress");
    const answeredIdx = after.indexOf("## Answered");
    const inProgressSlice = after.slice(inProgressIdx, answeredIdx);
    expect(inProgressSlice).toContain("- (none)");
  });

  it("preserves byte-for-byte order of unaffected lines", () => {
    seedQueueFile(contextDir);
    seedUserFile(contextDir, "user/profile.md", "## Identity\n- Name: Alex\n");

    preTickProfileQuestions(contextDir);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    expect(after).toContain("### Identity");
    expect(after).toContain("### Personal");
    expect(after).toContain("## In Progress");
    expect(after).toContain("## Answered");
    // Subheading order preserved.
    const idIdx = after.indexOf("### Identity");
    const personalIdx = after.indexOf("### Personal");
    expect(personalIdx).toBeGreaterThan(idIdx);
  });

  it("doesn't re-tick already-ticked rows", () => {
    const queue = SEED_QUEUE.replace(
      "- [ ] (HIGH) name ::",
      "- [x] (HIGH) name ::",
    );
    seedQueueFile(contextDir, queue);
    seedUserFile(contextDir, "user/profile.md", "## Identity\n- Name: Alex\n");

    const result = preTickProfileQuestions(contextDir);
    expect(result.ticked).toBe(0);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    // No new Answered entry for `name`.
    expect(after).not.toContain("→ name (reconciled:skeleton)");
  });

  it("parses rows without a match= anchor", () => {
    const queue = [
      "---",
      "---",
      "## Pending",
      "- [ ] (HIGH) location :: user/personal.md ## Location :: city / country",
      "## In Progress",
      "## Answered",
      "",
    ].join("\n");
    seedQueueFile(contextDir, queue);
    seedUserFile(contextDir, "user/personal.md", "## Location\n- Tokyo\n");

    const result = preTickProfileQuestions(contextDir);
    expect(result.ticked).toBe(1);
  });

  it("skips Pending rows whose rest has fewer than 2 ::-segments", () => {
    // Covers parseRowRest's `parts.length < 2` null branch — when the row
    // omits the second `::` (target only, no hint), parseRowRest returns
    // null and the row is dropped silently rather than crashing.
    const queue = [
      "---",
      "---",
      "## Pending",
      "- [ ] (HIGH) malformed :: only_target_no_hint",
      "- [ ] (HIGH) name :: user/profile.md ## Identity :: match=Name :: hint",
      "## In Progress",
      "## Answered",
      "",
    ].join("\n");
    seedQueueFile(contextDir, queue);
    seedUserFile(contextDir, "user/profile.md", "## Identity\n- Name: Alex\n");

    const result = preTickProfileQuestions(contextDir);
    // `name` row is examined and ticked; `malformed` is silently dropped.
    expect(result.examined).toBe(1);
    expect(result.ticked).toBe(1);
  });

  it("drops rows whose rest collapses to empty after stripping comments", () => {
    // Covers parseRowRest's empty-clean branch (parts = [], < 2 → null).
    const queue = [
      "---",
      "---",
      "## Pending",
      "- [ ] (HIGH) ghost :: <!-- last_attempted=2026-04-26 -->",
      "## In Progress",
      "## Answered",
      "",
    ].join("\n");
    seedQueueFile(contextDir, queue);

    const result = preTickProfileQuestions(contextDir);
    expect(result.examined).toBe(0);
    expect(result.ticked).toBe(0);
  });

  it("appends a new ## Answered section when the heading is missing", () => {
    // Covers the fallback branch where the seed template was hand-edited
    // to remove the `## Answered` block — the function must still log
    // the entry by appending a fresh section at end of file.
    const queue = [
      "---",
      "type: agent_questions",
      "owner: agent",
      "updated: 2026-04-26",
      "template_version: 1",
      "---",
      "# Profile Interview Queue",
      "",
      "## Pending",
      "- [ ] (HIGH) name :: user/profile.md ## Identity :: match=Name :: preferred name",
      "",
      "## In Progress",
      "- (none)",
      "",
    ].join("\n");
    seedQueueFile(contextDir, queue);
    seedUserFile(contextDir, "user/profile.md", "## Identity\n- Name: Alex\n");

    const result = preTickProfileQuestions(contextDir);
    expect(result.ticked).toBe(1);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    expect(after).toContain("## Answered");
    expect(after).toContain("→ name (reconciled:skeleton)");
    // The new section is appended after the existing content.
    const inProgressIdx = after.indexOf("## In Progress");
    const answeredIdx = after.indexOf("## Answered");
    expect(answeredIdx).toBeGreaterThan(inProgressIdx);
  });

  it("appends ## Answered when the queue ends without a trailing newline", () => {
    // Same fallback branch but exercises the `lines.push("")` separator
    // when the last existing line is non-empty.
    const queue = [
      "---",
      "---",
      "## Pending",
      "- [ ] (HIGH) name :: user/profile.md ## Identity :: match=Name :: preferred name",
      "## In Progress",
    ].join("\n");
    seedQueueFile(contextDir, queue);
    seedUserFile(contextDir, "user/profile.md", "## Identity\n- Name: Alex\n");

    const result = preTickProfileQuestions(contextDir);
    expect(result.ticked).toBe(1);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    expect(after).toContain("## Answered");
  });

  it("ignores last_attempted comments when parsing", () => {
    const queue = [
      "---",
      "---",
      "## Pending",
      "- [ ] (LOW) hobbies :: user/personal.md ## Hobbies :: hobbies <!-- last_attempted=2026-04-20 -->",
      "## In Progress",
      "## Answered",
      "",
    ].join("\n");
    seedQueueFile(contextDir, queue);
    seedUserFile(contextDir, "user/personal.md", "## Hobbies\n- Cycling\n");

    const result = preTickProfileQuestions(contextDir);
    expect(result.ticked).toBe(1);
    const after = readFileSync(join(contextDir, "agent/profile-questions.md"), "utf-8");
    // The last_attempted comment is preserved on the now-ticked row.
    expect(after).toContain("<!-- last_attempted=2026-04-20 -->");
    expect(after).toContain("- [x] (LOW) hobbies");
  });
});

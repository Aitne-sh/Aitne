import { describe, it, expect } from "vitest";
import {
  buildSummarizerPrompt,
  __PAYLOAD_CAPS_FOR_TEST,
} from "./summarizer-prompts.js";

describe("buildSummarizerPrompt", () => {
  it("dispatches obsidian sources to the obsidian template", () => {
    const prompt = buildSummarizerPrompt({
      source: "obsidian:external",
      ref: "notes/x.md",
      changeType: "modified",
      payload: { diffPreview: "TODO: refactor today" },
    });
    expect(prompt.family).toBe("obsidian");
    expect(prompt.systemPrompt).toContain("[summarizer/obsidian/");
    expect(prompt.userMessage).toContain("notes/x.md");
    expect(prompt.userMessage).toContain("TODO: refactor today");
  });

  it("dispatches git sources to the git template (object commitInfo, legacy shape)", () => {
    const prompt = buildSummarizerPrompt({
      source: "git:/path/to/repo",
      ref: "abc123",
      changeType: "modified",
      payload: {
        repoPath: "/path/to/repo",
        commitInfo: { subject: "fix: handle null in parser", body: "Closes #123" },
        changedFiles: ["a.ts", "b.ts", "README.md"],
      },
    });
    expect(prompt.family).toBe("git");
    expect(prompt.userMessage).toContain("fix: handle null in parser");
    expect(prompt.userMessage).toContain("a.ts");
  });

  it("dispatches git sources to the git template (string commitInfo, production shape)", () => {
    // Mirrors GitWatcher.checkLocalHead's payload shape — `commitInfo`
    // is the joined `git log` + `git diff --stat` string from
    // getCommitRangeInfo. The previous renderer treated it as an
    // object, dropping subject/body silently in production.
    const commitInfoString = [
      "abc1234 fix: handle null in parser (alice, 2 hours ago)",
      "",
      " src/parse.ts | 4 ++--",
      " 1 file changed, 2 insertions(+), 2 deletions(-)",
    ].join("\n");
    const prompt = buildSummarizerPrompt({
      source: "git:/path/to/repo",
      ref: "abc1234",
      changeType: "modified",
      payload: {
        repoPath: "/path/to/repo",
        commitInfo: commitInfoString,
        changedFiles: ["src/parse.ts"],
      },
    });
    expect(prompt.family).toBe("git");
    expect(prompt.userMessage).toContain("fix: handle null in parser");
    expect(prompt.userMessage).toContain("1 file changed");
    expect(prompt.userMessage).toContain("src/parse.ts");
  });

  it("dispatches mail sources to the mail template and surfaces the subject", () => {
    const prompt = buildSummarizerPrompt({
      source: "mail:gmail",
      ref: "msg-1",
      changeType: "created",
      payload: { from: "boss@example.com", subject: "Urgent: review deck", body: "Need by EOD" },
    });
    expect(prompt.family).toBe("mail");
    expect(prompt.userMessage).toContain("Urgent: review deck");
    expect(prompt.userMessage).toContain("boss@example.com");
  });

  it("dispatches calendar sources and embeds the delta JSON", () => {
    const prompt = buildSummarizerPrompt({
      source: "calendar",
      ref: "evt-9",
      changeType: "modified",
      payload: { title: "Team standup", delta: { startTime: "shifted" } },
    });
    expect(prompt.family).toBe("calendar");
    expect(prompt.userMessage).toContain("Team standup");
    expect(prompt.userMessage).toContain("shifted");
  });

  it("falls through to the generic template for unknown sources", () => {
    const prompt = buildSummarizerPrompt({
      source: "exotic:source",
      ref: "thing",
      changeType: "created",
      payload: { whatever: 42 },
    });
    expect(prompt.family).toBe("generic");
    expect(prompt.userMessage).toContain("exotic:source");
  });

  it("redacts likely API keys in the embedded payload", () => {
    const prompt = buildSummarizerPrompt({
      source: "obsidian:external",
      ref: "secrets.md",
      changeType: "modified",
      payload: { diffPreview: "key=sk-ant-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
    });
    expect(prompt.userMessage).not.toContain("sk-ant-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
    expect(prompt.userMessage).toContain("[REDACTED]");
  });

  it("truncates payloads above the per-source byte cap and labels the truncation", () => {
    // Build content that won't be flagged as a secret pattern by the
    // redactor: short space-separated tokens of natural prose.
    const word = "the quick brown fox jumps over the lazy dog ";
    const big = word.repeat(Math.ceil((__PAYLOAD_CAPS_FOR_TEST.obsidian + 1024) / word.length));
    const prompt = buildSummarizerPrompt({
      source: "obsidian:external",
      ref: "huge.md",
      changeType: "modified",
      payload: { diffPreview: big },
    });
    expect(prompt.userMessage).toContain("(truncated to");
    // payloadBytes covers the truncated body plus the truncation marker;
    // allow a small slack budget for the marker text.
    expect(prompt.payloadBytes).toBeLessThanOrEqual(__PAYLOAD_CAPS_FOR_TEST.obsidian + 128);
  });

  it("emits a stable system prompt prefix per source family for prompt caching", () => {
    const a = buildSummarizerPrompt({
      source: "obsidian:external",
      ref: "a.md",
      changeType: "modified",
      payload: { diffPreview: "alpha" },
    });
    const b = buildSummarizerPrompt({
      source: "obsidian:primary",
      ref: "b.md",
      changeType: "created",
      payload: { diffPreview: "beta" },
    });
    expect(a.systemPrompt).toEqual(b.systemPrompt);
    expect(a.userMessage).not.toEqual(b.userMessage);
  });
});

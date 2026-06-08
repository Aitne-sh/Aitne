import { describe, it, expect } from "vitest";
import type { AgentTaskEvent } from "@aitne/shared";
import {
  parseRepositoryRunTaskContext,
  repositoryRunInstructionFilename,
  safeRepositoryRunDirName,
  parseGithubRepoSlug,
  normalizeRepositoryClassification,
  normalizeRepositoryCategory,
} from "./dispatcher-repository-helpers.js";

describe("parseRepositoryRunTaskContext", () => {
  const baseValidCtx = {
    triggerSource: "manual" as const,
    repositoryId: "repo-1",
    slug: "owner/repo",
    prompt: "do the work",
    workdirMode: "temp" as const,
  };

  it("returns null for null / non-object input", () => {
    expect(parseRepositoryRunTaskContext(null as unknown as AgentTaskEvent["taskContext"])).toBeNull();
    expect(
      parseRepositoryRunTaskContext(undefined as unknown as AgentTaskEvent["taskContext"]),
    ).toBeNull();
    expect(
      parseRepositoryRunTaskContext("string" as unknown as AgentTaskEvent["taskContext"]),
    ).toBeNull();
  });

  it("returns null for an unrecognised triggerSource", () => {
    expect(
      parseRepositoryRunTaskContext({
        ...baseValidCtx,
        triggerSource: "automatic",
      } as AgentTaskEvent["taskContext"]),
    ).toBeNull();
  });

  it("accepts each of the three valid triggerSources", () => {
    for (const triggerSource of [
      "manual",
      "trigger_manual_fire",
      "repository_trigger",
    ] as const) {
      const ctx = parseRepositoryRunTaskContext({
        ...baseValidCtx,
        triggerSource,
      } as AgentTaskEvent["taskContext"]);
      expect(ctx?.triggerSource).toBe(triggerSource);
    }
  });

  it("returns null when required fields are missing or mistyped", () => {
    expect(
      parseRepositoryRunTaskContext({
        ...baseValidCtx,
        repositoryId: 42,
      } as unknown as AgentTaskEvent["taskContext"]),
    ).toBeNull();
    expect(
      parseRepositoryRunTaskContext({
        ...baseValidCtx,
        slug: 42,
      } as unknown as AgentTaskEvent["taskContext"]),
    ).toBeNull();
    expect(
      parseRepositoryRunTaskContext({
        ...baseValidCtx,
        prompt: undefined,
      } as unknown as AgentTaskEvent["taskContext"]),
    ).toBeNull();
    expect(
      parseRepositoryRunTaskContext({
        ...baseValidCtx,
        workdirMode: "bogus",
      } as unknown as AgentTaskEvent["taskContext"]),
    ).toBeNull();
  });

  it("normalises optional string fields to null when empty / missing", () => {
    const ctx = parseRepositoryRunTaskContext({
      ...baseValidCtx,
      localPath: "",
      githubRepo: "",
    } as AgentTaskEvent["taskContext"]);
    expect(ctx).not.toBeNull();
    expect(ctx?.localPath).toBeNull();
    expect(ctx?.githubRepo).toBeNull();
    expect(ctx?.instructionMd).toBeNull();
    expect(ctx?.timeoutMinutes).toBeNull();
  });

  it("preserves valid optional fields", () => {
    const ctx = parseRepositoryRunTaskContext({
      ...baseValidCtx,
      workdirMode: "local-clone",
      localPath: "/tmp/repo",
      githubRepo: "owner/repo",
      instructionMd: "# heading",
      timeoutMinutes: 30,
      triggerId: "trig-1",
      triggerName: "nightly",
      triggerEventType: "schedule",
      triggerEventPayload: { foo: "bar" },
    } as AgentTaskEvent["taskContext"]);
    expect(ctx).toEqual({
      triggerSource: "manual",
      repositoryId: "repo-1",
      slug: "owner/repo",
      localPath: "/tmp/repo",
      githubRepo: "owner/repo",
      workdirMode: "local-clone",
      prompt: "do the work",
      instructionMd: "# heading",
      timeoutMinutes: 30,
      triggerId: "trig-1",
      triggerName: "nightly",
      triggerEventType: "schedule",
      triggerEventPayload: { foo: "bar" },
    });
  });

  it("omits trigger* optional keys when the input does not carry them", () => {
    const ctx = parseRepositoryRunTaskContext(
      baseValidCtx as AgentTaskEvent["taskContext"],
    );
    expect(ctx).not.toBeNull();
    expect(ctx).not.toHaveProperty("triggerId");
    expect(ctx).not.toHaveProperty("triggerName");
    expect(ctx).not.toHaveProperty("triggerEventType");
    expect(ctx).not.toHaveProperty("triggerEventPayload");
  });

  it("preserves triggerEventPayload: null when the key exists with null value", () => {
    const ctx = parseRepositoryRunTaskContext({
      ...baseValidCtx,
      triggerEventPayload: null,
    } as AgentTaskEvent["taskContext"]);
    expect(ctx).not.toBeNull();
    expect(ctx).toHaveProperty("triggerEventPayload", null);
  });
});

describe("repositoryRunInstructionFilename", () => {
  it("returns the backend-appropriate filename", () => {
    expect(repositoryRunInstructionFilename("codex")).toBe("AGENTS.md");
    expect(repositoryRunInstructionFilename("gemini")).toBe("GEMINI.md");
    expect(repositoryRunInstructionFilename("claude")).toBe("CLAUDE.md");
    // OpenCode auto-discovers AGENTS.md, same as Codex — must match
    // `cliInstructionFileName` in skills-compiler.ts, otherwise repository
    // sessions land with no readable instruction file.
    expect(repositoryRunInstructionFilename("opencode")).toBe("AGENTS.md");
  });
});

describe("safeRepositoryRunDirName", () => {
  it("lowercases and replaces unsafe characters", () => {
    expect(safeRepositoryRunDirName("Owner/Repo Name")).toBe("owner-repo-name");
    expect(safeRepositoryRunDirName("a.b_c-d")).toBe("a.b_c-d");
  });

  it("trims leading and trailing dashes", () => {
    expect(safeRepositoryRunDirName("---foo---")).toBe("foo");
  });

  it("returns 'repository' for an empty or all-unsafe slug", () => {
    expect(safeRepositoryRunDirName("")).toBe("repository");
    expect(safeRepositoryRunDirName("///")).toBe("repository");
  });
});

describe("parseGithubRepoSlug", () => {
  it("returns [null, null] for null input", () => {
    expect(parseGithubRepoSlug(null)).toEqual([null, null]);
  });

  it("returns [null, null] for malformed input", () => {
    expect(parseGithubRepoSlug("no-slash")).toEqual([null, null]);
    expect(parseGithubRepoSlug("owner/")).toEqual([null, null]);
    expect(parseGithubRepoSlug("/repo")).toEqual([null, null]);
    expect(parseGithubRepoSlug("a/b/c")).toEqual([null, null]);
  });

  it("splits a valid owner/repo slug", () => {
    expect(parseGithubRepoSlug("anthropics/claude-code")).toEqual([
      "anthropics",
      "claude-code",
    ]);
  });
});

describe("normalizeRepositoryClassification", () => {
  it("returns 'project' iff the value is exactly 'project'", () => {
    expect(normalizeRepositoryClassification("project")).toBe("project");
    expect(normalizeRepositoryClassification("repo-only")).toBe("repo-only");
    expect(normalizeRepositoryClassification(undefined)).toBe("repo-only");
    expect(normalizeRepositoryClassification(42)).toBe("repo-only");
  });
});

describe("normalizeRepositoryCategory", () => {
  it("accepts the five known categories verbatim", () => {
    for (const cat of [
      "work",
      "personal",
      "research",
      "client",
      "other",
    ] as const) {
      expect(normalizeRepositoryCategory(cat)).toBe(cat);
    }
  });

  it("falls back to 'other' for unknown values", () => {
    expect(normalizeRepositoryCategory("unknown")).toBe("other");
    expect(normalizeRepositoryCategory(null)).toBe("other");
    expect(normalizeRepositoryCategory(undefined)).toBe("other");
  });
});

import { describe, it, expect } from "vitest";
import {
  DEFAULT_NOTE_STEP_FIELDS,
  buildNotePatchBody,
  canContinue,
  notePathIssueMessage,
  validateExternalVaultPathClient,
} from "./note-step.logic";

describe("validateExternalVaultPathClient", () => {
  const baseInput = {
    dataDir: "/Users/test/.personal-agent",
    primaryVaultPath: "/Users/test/Documents/AgentVault",
  };

  it("returns 'empty' for a blank path", () => {
    expect(
      validateExternalVaultPathClient({ ...baseInput, path: "" }),
    ).toBe("empty");
    expect(
      validateExternalVaultPathClient({ ...baseInput, path: "   " }),
    ).toBe("empty");
  });

  it("rejects relative paths", () => {
    expect(
      validateExternalVaultPathClient({ ...baseInput, path: "relative-vault" }),
    ).toBe("not_absolute");
  });

  it("accepts absolute paths and tilde-expanded paths", () => {
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "/Users/test/Documents/MyVault",
      }),
    ).toBeNull();
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "~/Documents/MyVault",
      }),
    ).toBeNull();
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "~\\Documents\\MyVault",
      }),
    ).toBeNull();
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "C:\\Users\\test\\Documents\\MyVault",
      }),
    ).toBeNull();
  });

  it("rejects paths overlapping the data directory", () => {
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "/Users/test/.personal-agent",
      }),
    ).toBe("overlaps_data_dir");
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "/Users/test/.personal-agent/subdir",
      }),
    ).toBe("overlaps_data_dir");
  });

  it("rejects paths overlapping the primary vault", () => {
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "/Users/test/Documents/AgentVault",
      }),
    ).toBe("overlaps_primary_vault");
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "/Users/test/Documents/AgentVault/notes",
      }),
    ).toBe("overlaps_primary_vault");
  });

  it("ignores trailing slashes when comparing prefixes", () => {
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "/Users/test/.personal-agent/x",
        dataDir: "/Users/test/.personal-agent/",
      }),
    ).toBe("overlaps_data_dir");
  });

  it("detects Windows overlap case-insensitively", () => {
    expect(
      validateExternalVaultPathClient({
        path: "c:/users/test/documents/agentvault/notes",
        dataDir: "C:\\Users\\test\\.personal-agent",
        primaryVaultPath: "C:\\Users\\test\\Documents\\AgentVault",
      }),
    ).toBe("overlaps_primary_vault");
  });

  it("permits a path that merely starts-with-text but is not a prefix", () => {
    // Sibling path that begins with the same characters as primaryVaultPath
    // but is a different directory. False-positive guard: the slash makes
    // the prefix check exact.
    expect(
      validateExternalVaultPathClient({
        ...baseInput,
        path: "/Users/test/Documents/AgentVaultExtra",
      }),
    ).toBeNull();
  });

  it("does not require a primaryVaultPath to evaluate", () => {
    expect(
      validateExternalVaultPathClient({
        path: "/Users/test/Documents/MyVault",
        dataDir: "/Users/test/.personal-agent",
        primaryVaultPath: null,
      }),
    ).toBeNull();
  });
});

describe("notePathIssueMessage", () => {
  it("emits a distinct message per issue", () => {
    const messages = new Set<string>();
    for (const issue of [
      "empty",
      "not_absolute",
      "overlaps_data_dir",
      "overlaps_primary_vault",
    ] as const) {
      const m = notePathIssueMessage(issue);
      expect(m.length).toBeGreaterThan(0);
      messages.add(m);
    }
    expect(messages.size).toBe(4);
  });
});

describe("canContinue", () => {
  it("permits empty (implicit skip) so the step is optional", () => {
    expect(canContinue({ pathIssue: "empty", saving: false })).toBe(true);
  });

  it("blocks while a save is in flight", () => {
    expect(canContinue({ pathIssue: null, saving: true })).toBe(false);
  });

  it("blocks on validation issues other than empty", () => {
    expect(
      canContinue({ pathIssue: "overlaps_data_dir", saving: false }),
    ).toBe(false);
    expect(
      canContinue({ pathIssue: "not_absolute", saving: false }),
    ).toBe(false);
    expect(
      canContinue({ pathIssue: "overlaps_primary_vault", saving: false }),
    ).toBe(false);
  });

  it("permits a clean valid path", () => {
    expect(canContinue({ pathIssue: null, saving: false })).toBe(true);
  });
});

describe("buildNotePatchBody", () => {
  it("trims the path", () => {
    expect(
      buildNotePatchBody({
        externalObsidianVaultPath: "  /Users/test/Vault  ",
        externalObsidianWatch: true,
      }),
    ).toEqual({
      externalObsidianVaultPath: "/Users/test/Vault",
      externalObsidianWatch: true,
    });
  });

  it("converts empty input into a null path so the daemon clears the field", () => {
    expect(
      buildNotePatchBody({
        externalObsidianVaultPath: "",
        externalObsidianWatch: false,
      }),
    ).toEqual({
      externalObsidianVaultPath: null,
      externalObsidianWatch: false,
    });
  });

  it("DEFAULT_NOTE_STEP_FIELDS has watching enabled", () => {
    expect(DEFAULT_NOTE_STEP_FIELDS.externalObsidianWatch).toBe(true);
  });
});

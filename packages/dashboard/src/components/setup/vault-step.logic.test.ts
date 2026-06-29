import { describe, it, expect } from "vitest";
import {
  buildVaultMigrationBody,
  canContinue,
  decideVaultMigration,
  validatePrimaryVaultPathClient,
  vaultPathIssueMessage,
} from "./vault-step.logic";

describe("validatePrimaryVaultPathClient", () => {
  const baseInput = { dataDir: "/Users/test/.personal-agent" };

  it("returns 'empty' for a blank path", () => {
    expect(validatePrimaryVaultPathClient({ ...baseInput, path: "" })).toBe(
      "empty",
    );
    expect(validatePrimaryVaultPathClient({ ...baseInput, path: "   " })).toBe(
      "empty",
    );
  });

  it("rejects a relative path", () => {
    expect(
      validatePrimaryVaultPathClient({ ...baseInput, path: "relative" }),
    ).toBe("not_absolute");
  });

  it("accepts absolute and tilde-prefixed paths", () => {
    expect(
      validatePrimaryVaultPathClient({
        ...baseInput,
        path: "/Users/test/Documents/Vault",
      }),
    ).toBeNull();
    expect(
      validatePrimaryVaultPathClient({
        ...baseInput,
        path: "~/Documents/Vault",
      }),
    ).toBeNull();
    expect(
      validatePrimaryVaultPathClient({
        ...baseInput,
        path: "~\\Documents\\Vault",
      }),
    ).toBeNull();
    expect(
      validatePrimaryVaultPathClient({
        ...baseInput,
        path: "C:\\Users\\test\\Documents\\Vault",
      }),
    ).toBeNull();
  });

  it("rejects paths overlapping the data directory", () => {
    expect(
      validatePrimaryVaultPathClient({
        ...baseInput,
        path: "/Users/test/.personal-agent",
      }),
    ).toBe("overlaps_data_dir");
    expect(
      validatePrimaryVaultPathClient({
        ...baseInput,
        path: "/Users/test/.personal-agent/sub",
      }),
    ).toBe("overlaps_data_dir");
  });

  it("normalises trailing slashes", () => {
    expect(
      validatePrimaryVaultPathClient({
        path: "/Users/test/.personal-agent/x",
        dataDir: "/Users/test/.personal-agent/",
      }),
    ).toBe("overlaps_data_dir");
  });

  it("detects Windows dataDir overlap case-insensitively", () => {
    expect(
      validatePrimaryVaultPathClient({
        path: "c:/users/test/.personal-agent/vault",
        dataDir: "C:\\Users\\test\\.personal-agent",
      }),
    ).toBe("overlaps_data_dir");
  });

  it("does not false-positive on prefix-substrings that are not directory prefixes", () => {
    expect(
      validatePrimaryVaultPathClient({
        ...baseInput,
        path: "/Users/test/.personal-agent-extra",
      }),
    ).toBeNull();
  });

  it("ignores an empty dataDir (degenerate config branch)", () => {
    expect(
      validatePrimaryVaultPathClient({
        path: "/Users/test/Documents/Vault",
        dataDir: "",
      }),
    ).toBeNull();
  });
});

describe("vaultPathIssueMessage", () => {
  it("emits a distinct message per issue", () => {
    const messages = new Set<string>();
    for (const issue of [
      "empty",
      "not_absolute",
      "overlaps_data_dir",
    ] as const) {
      const m = vaultPathIssueMessage(issue);
      expect(m.length).toBeGreaterThan(0);
      messages.add(m);
    }
    expect(messages.size).toBe(3);
  });
});

describe("canContinue", () => {
  it("permits plain mode regardless of path state", () => {
    expect(
      canContinue({ vaultMode: "plain", pathIssue: "empty", saving: false }),
    ).toBe(true);
    expect(
      canContinue({ vaultMode: "plain", pathIssue: null, saving: false }),
    ).toBe(true);
  });

  it("requires a valid path in obsidian mode", () => {
    expect(
      canContinue({
        vaultMode: "obsidian",
        pathIssue: "empty",
        saving: false,
      }),
    ).toBe(false);
    expect(
      canContinue({
        vaultMode: "obsidian",
        pathIssue: "not_absolute",
        saving: false,
      }),
    ).toBe(false);
  });

  it("permits a clean obsidian path", () => {
    expect(
      canContinue({ vaultMode: "obsidian", pathIssue: null, saving: false }),
    ).toBe(true);
  });

  it("blocks while a save is in flight", () => {
    expect(
      canContinue({ vaultMode: "plain", pathIssue: null, saving: true }),
    ).toBe(false);
  });
});

describe("buildVaultMigrationBody", () => {
  it("emits the plain shape without a path", () => {
    expect(
      buildVaultMigrationBody({ vaultMode: "plain", primaryVaultPath: "" }),
    ).toEqual({ targetVaultMode: "plain", conflictPolicy: "abort" });
  });

  it("emits the obsidian shape with the trimmed path", () => {
    expect(
      buildVaultMigrationBody({
        vaultMode: "obsidian",
        primaryVaultPath: "  /Users/test/Documents/Vault  ",
      }),
    ).toEqual({
      targetVaultMode: "obsidian",
      targetVaultPath: "/Users/test/Documents/Vault",
      conflictPolicy: "abort",
    });
  });
});

describe("decideVaultMigration", () => {
  it("no-ops when both modes are plain", () => {
    expect(
      decideVaultMigration({
        pendingMode: "plain",
        pendingPath: "",
        currentMode: "plain",
        currentPath: null,
      }),
    ).toEqual({ kind: "no_migration_needed" });
  });

  it("rolls back to plain when leaving obsidian", () => {
    expect(
      decideVaultMigration({
        pendingMode: "plain",
        pendingPath: "",
        currentMode: "obsidian",
        currentPath: "/Users/me/Vault",
      }),
    ).toEqual({ kind: "migrate", mode: "plain", path: "" });
  });

  it("no-ops in obsidian mode when path is empty (defensive)", () => {
    expect(
      decideVaultMigration({
        pendingMode: "obsidian",
        pendingPath: "",
        currentMode: "plain",
        currentPath: null,
      }),
    ).toEqual({ kind: "no_migration_needed" });
    expect(
      decideVaultMigration({
        pendingMode: "obsidian",
        pendingPath: "   ",
        currentMode: "plain",
        currentPath: null,
      }),
    ).toEqual({ kind: "no_migration_needed" });
  });

  it("migrates from plain to obsidian with a chosen path", () => {
    expect(
      decideVaultMigration({
        pendingMode: "obsidian",
        pendingPath: "/Users/me/Vault",
        currentMode: "plain",
        currentPath: null,
      }),
    ).toEqual({ kind: "migrate", mode: "obsidian", path: "/Users/me/Vault" });
  });

  it("re-targets when the obsidian path changes", () => {
    expect(
      decideVaultMigration({
        pendingMode: "obsidian",
        pendingPath: "/Users/me/Vault2",
        currentMode: "obsidian",
        currentPath: "/Users/me/Vault1",
      }),
    ).toEqual({
      kind: "migrate",
      mode: "obsidian",
      path: "/Users/me/Vault2",
    });
  });

  it("no-ops when the obsidian path matches the current config", () => {
    expect(
      decideVaultMigration({
        pendingMode: "obsidian",
        pendingPath: "/Users/me/Vault",
        currentMode: "obsidian",
        currentPath: "/Users/me/Vault",
      }),
    ).toEqual({ kind: "no_migration_needed" });
  });

  it("trims whitespace before comparing paths", () => {
    expect(
      decideVaultMigration({
        pendingMode: "obsidian",
        pendingPath: "  /Users/me/Vault  ",
        currentMode: "obsidian",
        currentPath: "/Users/me/Vault",
      }),
    ).toEqual({ kind: "no_migration_needed" });
  });
});

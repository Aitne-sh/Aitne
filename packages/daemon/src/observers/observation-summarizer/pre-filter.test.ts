import { describe, it, expect } from "vitest";
import { preFilterObservation, DEFAULT_LARGE_FILE_BYTES } from "./pre-filter.js";

describe("preFilterObservation", () => {
  it("skips agent-actor observations regardless of source", () => {
    const decision = preFilterObservation({
      source: "obsidian:primary",
      ref: "today.md",
      changeType: "modified",
      actor: "agent",
      payload: null,
    });
    expect(decision).toEqual({ kind: "skipped", reason: "agent_actor" });
  });

  it("returns deterministic done summary for deletions", () => {
    const decision = preFilterObservation({
      source: "obsidian:external",
      ref: "notes/old-note.md",
      changeType: "deleted",
      actor: "user",
      payload: null,
    });
    expect(decision).toEqual({
      kind: "done",
      summaryText: "[deleted] notes/old-note.md",
      noveltyScore: 1,
    });
  });

  it("skips paths inside vendored directories", () => {
    const cases = [
      "node_modules/foo/index.js",
      "src/.git/HEAD",
      "dist/bundle.js",
      "subdir/coverage/lcov.info",
    ];
    for (const ref of cases) {
      const decision = preFilterObservation({
        source: "git:/repo",
        ref,
        changeType: "modified",
        actor: "user",
        payload: null,
      });
      expect(decision.kind).toBe("skipped");
    }
  });

  it("skips lock files and OS metadata files by basename", () => {
    const cases: Array<{ ref: string; reason: "deny_basename" | "deny_pattern" }> = [
      { ref: "package-lock.json", reason: "deny_pattern" },
      { ref: "pnpm-lock.yaml", reason: "deny_pattern" },
      { ref: "Cargo.lock", reason: "deny_pattern" },
      { ref: ".DS_Store", reason: "deny_basename" },
      { ref: "Thumbs.db", reason: "deny_basename" },
      { ref: "logs/server.log", reason: "deny_pattern" },
    ];
    for (const c of cases) {
      const decision = preFilterObservation({
        source: "obsidian:external",
        ref: c.ref,
        changeType: "modified",
        actor: "user",
        payload: null,
      });
      expect(decision).toEqual({ kind: "skipped", reason: c.reason });
    }
  });

  it("skips paths that match the credential / secret-file deny list", () => {
    const cases: string[] = [
      "/Users/x/.ssh/id_rsa",
      ".ssh/known_hosts",
      "/Users/x/.aws/credentials",
      "/Users/x/.gnupg/private-keys-v1.d/secret",
      "/Users/x/Library/Keychains/login.keychain-db",
      "config/.env",
      "deploy/.env.production",
    ];
    for (const ref of cases) {
      const decision = preFilterObservation({
        source: "obsidian:external",
        ref,
        changeType: "modified",
        actor: "user",
        payload: { diffPreview: "anything" },
      });
      expect(decision).toEqual({ kind: "skipped", reason: "secret_path" });
    }
  });

  it("emits metadata-only done for files larger than the cap", () => {
    const decision = preFilterObservation({
      source: "obsidian:external",
      ref: "big.md",
      changeType: "modified",
      actor: "user",
      payload: { sizeBytes: DEFAULT_LARGE_FILE_BYTES + 1 },
    });
    expect(decision.kind).toBe("done");
    if (decision.kind === "done") {
      expect(decision.summaryText.startsWith("[large file ")).toBe(true);
      expect(decision.summaryText).toContain("big.md");
      expect(decision.noveltyScore).toBe(0);
    }
  });

  it("respects a custom largeFileBytes config knob", () => {
    const decision = preFilterObservation(
      {
        source: "obsidian:external",
        ref: "small.md",
        changeType: "modified",
        actor: "user",
        payload: { sizeBytes: 200 },
      },
      { largeFileBytes: 100 },
    );
    expect(decision.kind).toBe("done");
  });

  it("proceeds for normal user file edits", () => {
    const decision = preFilterObservation({
      source: "obsidian:external",
      ref: "notes/today-thoughts.md",
      changeType: "modified",
      actor: "user",
      payload: { diffPreview: "TODO: review the deploy" },
    });
    expect(decision).toEqual({ kind: "proceed" });
  });

  it("boosts novelty floor to 3 for VIP mail senders (case-insensitive)", () => {
    const decision = preFilterObservation(
      {
        source: "mail:gmail",
        ref: "msg-123",
        changeType: "created",
        actor: "system",
        payload: { from: "ALICE@example.com", subject: "quick check" },
      },
      { vipMailSenders: ["alice@example.com"] },
    );
    expect(decision).toEqual({ kind: "proceed", noveltyFloor: 3 });
  });

  it("does not boost when VIP list is empty", () => {
    const decision = preFilterObservation(
      {
        source: "mail:gmail",
        ref: "msg-123",
        changeType: "created",
        actor: "system",
        payload: { from: "alice@example.com" },
      },
      {},
    );
    expect(decision).toEqual({ kind: "proceed" });
  });

  it("extracts sender from RFC 5322 angle-bracket format", () => {
    const decision = preFilterObservation(
      {
        source: "mail:gmail",
        ref: "msg-123",
        changeType: "created",
        actor: "system",
        payload: { from: "Alice <alice@example.com>" },
      },
      { vipMailSenders: ["alice@example.com"] },
    );
    expect(decision).toEqual({ kind: "proceed", noveltyFloor: 3 });
  });

  it("ignores VIP boost when source is non-mail even if a matching email is in the payload", () => {
    const decision = preFilterObservation(
      {
        source: "obsidian:external",
        ref: "people/alice.md",
        changeType: "modified",
        actor: "user",
        payload: { from: "alice@example.com" },
      },
      { vipMailSenders: ["alice@example.com"] },
    );
    expect(decision).toEqual({ kind: "proceed" });
  });
});

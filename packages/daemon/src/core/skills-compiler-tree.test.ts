import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMPTY_MAIL_ACCOUNTS_MD,
  pruneStaleBuiltinSkillDirs,
  renderMailAccountsMd,
} from "./skills-compiler-tree.js";
import type { MailAccount } from "../services/mail/provider.js";

function makeMailAccount(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: "acct-1",
    kind: "gmail",
    email: "user@example.com",
    authStatus: "healthy",
    idleEnabled: false,
    active: true,
    createdAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("renderMailAccountsMd", () => {
  it("renders an empty table (header + separator only) when no accounts are passed", () => {
    const out = renderMailAccountsMd([]);
    expect(out).toContain("| accountId | kind | email | transport |");
    expect(out).toContain("|---|---|---|---|");
    // No data rows — the only backtick-quoted ids should be zero. Use a
    // count rather than `not.toMatch` so we don't accidentally allow a
    // single stray row to slip through.
    const rowMatches = out.match(/^\| `[^`]+\|/gm) ?? [];
    expect(rowMatches.length).toBe(0);
  });

  it("renders one row per account with backtick-quoted ids and kind/email columns", () => {
    const out = renderMailAccountsMd([
      makeMailAccount({ id: "g1", kind: "gmail", email: "a@x.com" }),
      makeMailAccount({ id: "o1", kind: "outlook", email: "b@y.com" }),
    ]);
    expect(out).toContain("| `g1` | gmail | a@x.com");
    expect(out).toContain("| `o1` | outlook | b@y.com");
  });

  it("appends ` (label)` after the email when an account has a non-empty label", () => {
    const out = renderMailAccountsMd([
      makeMailAccount({ id: "a", email: "owner@example.com", label: "Personal" }),
    ]);
    expect(out).toContain("owner@example.com (Personal)");
  });

  it("omits the label suffix when label is undefined", () => {
    const out = renderMailAccountsMd([
      makeMailAccount({ id: "a", email: "owner@example.com" }),
    ]);
    // Catches a regression that would render `email ()` from a falsy-but-string label.
    expect(out).not.toMatch(/owner@example\.com \(/);
  });

  it("emits `IDLE` for idleEnabled=true accounts and `poll` otherwise", () => {
    const out = renderMailAccountsMd([
      makeMailAccount({ id: "idle", idleEnabled: true }),
      makeMailAccount({ id: "polling", idleEnabled: false }),
    ]);
    // Anchored on the trailing pipe to ensure we're matching the transport
    // column, not a stray `IDLE` substring elsewhere.
    expect(out).toMatch(/\| `idle` \| .* \| IDLE \|/);
    expect(out).toMatch(/\| `polling` \| .* \| poll \|/);
  });
});

describe("EMPTY_MAIL_ACCOUNTS_MD", () => {
  it("instructs the agent to refuse account guessing and stop", () => {
    // Pinned because the materializer falls back to this constant when the
    // active-mail-accounts list is empty; a wording drift that softens the
    // refusal would invite the agent to invent account ids.
    expect(EMPTY_MAIL_ACCOUNTS_MD).toContain("# Mail accounts");
    expect(EMPTY_MAIL_ACCOUNTS_MD).toContain("do NOT guess account ids");
    expect(EMPTY_MAIL_ACCOUNTS_MD).toContain("stop");
  });
});

describe("pruneStaleBuiltinSkillDirs", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-prune-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  // `listBuiltinSlugs` (and therefore `pruneStaleBuiltinSkillDirs`)
  // recognises a directory as a built-in slug only when it carries an
  // actual SKILL.md — empty fixture dirs no longer count, which keeps
  // category subdirectories like `wiki/` from being treated as a slug.
  it("removes built-in dirs not in `keep`", () => {
    const source = join(workspace, "agent-assets", "skills");
    const dest = join(workspace, "session", ".claude", "skills");
    mkdirSync(join(source, "alpha"), { recursive: true });
    mkdirSync(join(source, "beta"), { recursive: true });
    writeFileSync(join(source, "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
    writeFileSync(join(source, "beta", "SKILL.md"), "---\nname: beta\n---\n");
    mkdirSync(join(dest, "alpha"), { recursive: true });
    mkdirSync(join(dest, "beta"), { recursive: true });
    pruneStaleBuiltinSkillDirs(dest, source, ["alpha"]);
    expect(existsSync(join(dest, "alpha"))).toBe(true);
    expect(existsSync(join(dest, "beta"))).toBe(false);
  });

  it("leaves user-authored dirs alone (not in source tree)", () => {
    const source = join(workspace, "agent-assets", "skills");
    const dest = join(workspace, "session", ".claude", "skills");
    mkdirSync(join(source, "alpha"), { recursive: true });
    writeFileSync(join(source, "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
    mkdirSync(join(dest, "alpha"), { recursive: true });
    mkdirSync(join(dest, "user-skill"), { recursive: true });
    pruneStaleBuiltinSkillDirs(dest, source, []);
    expect(existsSync(join(dest, "alpha"))).toBe(false);
    expect(existsSync(join(dest, "user-skill"))).toBe(true);
  });

  // WIKI_BUILDER_DESIGN.md §9.1 — wiki slugs live nested under
  // `skills/wiki/<slug>/`. The prune helper must treat those nested
  // slugs as built-ins so a stale wiki-* dir in the session workdir
  // gets cleaned up when the manifest narrows.
  it("recognises category-nested slugs (skills/wiki/<slug>) as built-ins", () => {
    const source = join(workspace, "agent-assets", "skills");
    const dest = join(workspace, "session", ".claude", "skills");
    mkdirSync(join(source, "wiki", "wiki-vault-rules"), { recursive: true });
    writeFileSync(
      join(source, "wiki", "wiki-vault-rules", "SKILL.md"),
      "---\nname: wiki-vault-rules\n---\n",
    );
    mkdirSync(join(dest, "wiki-vault-rules"), { recursive: true });
    pruneStaleBuiltinSkillDirs(dest, source, []);
    expect(existsSync(join(dest, "wiki-vault-rules"))).toBe(false);
  });

  it("is a no-op when `dest` does not exist", () => {
    const source = join(workspace, "agent-assets", "skills");
    mkdirSync(source, { recursive: true });
    expect(() =>
      pruneStaleBuiltinSkillDirs(
        join(workspace, "missing"),
        source,
        ["anything"],
      ),
    ).not.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  renameFrontmatterSourceKey,
  rewriteEntityFilesForSourceRename,
} from "./entity-source-rename.js";

const BASIC = `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom: zm_xyz789
---

# Body
`;

const NESTED = `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom:
    external_id: zm_xyz789
    duration: PT30M
  google_calendar:
    external_id: gc_abc
---

# Body
`;

const NEW_KEY_PRESENT = `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom: zm_old
  Zoom Workplace: zm_new
---
`;

describe("renameFrontmatterSourceKey", () => {
  it("renames an inline source key and preserves the value", () => {
    const out = renameFrontmatterSourceKey(BASIC, "zoom", "Zoom Workplace");
    expect(out.kind).toBe("rewrote");
    if (out.kind !== "rewrote") return;
    // Quote is required for keys with whitespace.
    expect(out.body).toContain('  "Zoom Workplace": zm_xyz789');
    // The original key must be gone.
    expect(out.body).not.toMatch(/^\s\s+zoom:/m);
  });

  it("renames a nested-record key and keeps every field below it", () => {
    const out = renameFrontmatterSourceKey(NESTED, "zoom", "ZoomCloud");
    expect(out.kind).toBe("rewrote");
    if (out.kind !== "rewrote") return;
    // Plain key — no quoting needed.
    expect(out.body).toContain("\n  ZoomCloud:\n");
    expect(out.body).toContain("    external_id: zm_xyz789");
    expect(out.body).toContain("    duration: PT30M");
    // Sibling source remains untouched.
    expect(out.body).toContain("  google_calendar:");
  });

  it("returns `old_key_missing` when the source isn't present", () => {
    expect(
      renameFrontmatterSourceKey(BASIC, "notion", "Notion HQ").kind,
    ).toBe("old_key_missing");
  });

  it("returns `new_key_exists` to avoid silently merging records", () => {
    expect(
      renameFrontmatterSourceKey(NEW_KEY_PRESENT, "zoom", "Zoom Workplace").kind,
    ).toBe("new_key_exists");
  });

  it("returns `no_frontmatter` for files without a `---` fence", () => {
    expect(renameFrontmatterSourceKey("# no frontmatter\n", "x", "y").kind).toBe(
      "no_frontmatter",
    );
  });

  it("returns `no_frontmatter` when the closing fence is missing", () => {
    expect(
      renameFrontmatterSourceKey("---\ndomain: work\n# never closes\n", "zoom", "z")
        .kind,
    ).toBe("no_frontmatter");
  });

  it("is a noop when oldKey === newKey", () => {
    expect(
      renameFrontmatterSourceKey(BASIC, "zoom", "zoom").kind,
    ).toBe("old_key_missing");
  });

  it("does not touch keys outside the `sources:` block", () => {
    // A top-level key sharing the name 'zoom' would not exist in valid
    // frontmatter, but we want the parser to ignore lines outside the
    // sources block regardless. Adding a stray nested key under another
    // top-level proves it.
    const body = `---
domain: work
type: meeting
slug: standup
title: Daily Standup
notes:
  zoom: this is irrelevant
sources:
  zoom: zm_xyz
---
`;
    const out = renameFrontmatterSourceKey(body, "zoom", "Zoom2");
    expect(out.kind).toBe("rewrote");
    if (out.kind !== "rewrote") return;
    // The non-source `zoom` remains.
    expect(out.body).toContain("  zoom: this is irrelevant");
    // The renamed source key landed.
    expect(out.body).toContain("  Zoom2: zm_xyz");
  });

  it("skips comment lines inside frontmatter without affecting matching", () => {
    // Lines starting with `#` (after optional indent) are YAML comments —
    // the walker must `continue` past them rather than mistreating
    // them as keys.
    const body = `---
# top-of-file comment
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  # comment inside the sources block
  zoom: zm_abc
---
`;
    const out = renameFrontmatterSourceKey(body, "zoom", "Webex");
    expect(out.kind).toBe("rewrote");
    if (out.kind !== "rewrote") return;
    expect(out.body).toContain("  Webex: zm_abc");
    // Comments survive the rewrite.
    expect(out.body).toContain("# top-of-file comment");
    expect(out.body).toContain("  # comment inside the sources block");
  });

  it("ignores indent-2 lines that do not match the key pattern at all", () => {
    // A list-style entry under sources at exactly 2 spaces of indent
    // (e.g. `  - foo`) does not parse as `key:` — parseChildKey
    // returns null and the walker skips it. This is the sole indent-2
    // path that reaches L96 with a null keyName.
    const body = `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  - leftover-list-item
  zoom: zm_abc
---
`;
    const out = renameFrontmatterSourceKey(body, "zoom", "Webex");
    expect(out.kind).toBe("rewrote");
  });

  it("ignores child lines that do not parse as a key (parseChildKey returns null)", () => {
    // A continuation line under a source record (multiline scalar) has
    // no `key:` shape — `parseChildKey` returns null and the walker
    // skips it. We add a sources entry whose nested record's first
    // line is followed by a continuation that the regex won't match.
    const body = `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom:
    notes: |
      first line
      second line
  webex: w_abc
---
`;
    // A valid rename should still find `zoom` and rewrite it without
    // tripping on the multiline continuation.
    const out = renameFrontmatterSourceKey(body, "zoom", "ZoomCloud");
    expect(out.kind).toBe("rewrote");
  });

  it("handles CRLF line endings", () => {
    const body = BASIC.replace(/\n/g, "\r\n");
    const out = renameFrontmatterSourceKey(body, "zoom", "Zoom Pro");
    expect(out.kind).toBe("rewrote");
    if (out.kind !== "rewrote") return;
    expect(out.body).toContain('  "Zoom Pro": zm_xyz789');
  });

  it("matches case-insensitively when file uses lower and oldKey is mixed", () => {
    // The managed task may have been registered as "Zoom" but the
    // entity-mirror saw `sources.zoom` in the file. The rewriter must
    // still find and rename it.
    const out = renameFrontmatterSourceKey(BASIC, "Zoom", "Webex");
    expect(out.kind).toBe("rewrote");
    if (out.kind !== "rewrote") return;
    expect(out.body).toContain("  Webex: zm_xyz789");
    expect(out.body).not.toMatch(/^\s\s+zoom:/m);
  });

  it("returns `multiple_variants` when the file has both `zoom` and `ZOOM`", () => {
    const body = `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom: zm_lower
  ZOOM: zm_upper
---
`;
    const out = renameFrontmatterSourceKey(body, "Zoom", "Webex");
    expect(out.kind).toBe("multiple_variants");
    if (out.kind !== "multiple_variants") return;
    expect(out.variants.sort()).toEqual(["ZOOM", "zoom"]);
  });

  it("returns `new_key_exists` when matched old + exact new co-exist", () => {
    // The matched old key (case-insensitive) AND the exact target case
    // both exist — refuse to merge.
    const body = `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom: zm_old
  Webex: wb_new
---
`;
    const out = renameFrontmatterSourceKey(body, "Zoom", "Webex");
    expect(out.kind).toBe("new_key_exists");
  });

  it("permits standardising casing when no other variant exists", () => {
    const body = `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  Zoom: zm_xyz
---
`;
    const out = renameFrontmatterSourceKey(body, "Zoom", "zoom");
    // Different normalized? `Zoom`.toLowerCase() = `zoom` = `zoom`.toLowerCase()
    // — the matched key IS the new key after normalization. We DO want
    // the rename through (the user's standardising). But our `=== newKey`
    // check rejects only EXACT case duplicates; here `Zoom !== zoom`,
    // so the rewrite proceeds.
    expect(out.kind).toBe("rewrote");
    if (out.kind !== "rewrote") return;
    expect(out.body).toContain("  zoom: zm_xyz");
  });
});

describe("rewriteEntityFilesForSourceRename", () => {
  let db: Database.Database;
  let contextDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    contextDir = mkdtempSync(join(tmpdir(), "aitne-entity-rename-"));
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(contextDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  function seedEntity(
    relativePath: string,
    body: string,
    sourceKey: string,
  ): void {
    const absolute = join(contextDir, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, { encoding: "utf-8" });
    db.prepare(
      `INSERT INTO entities (path, domain, type, slug, title)
       VALUES (?, 'work', 'meeting', ?, ?)`,
    ).run(relativePath, "standup", "Standup");
    db.prepare(
      `INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)`,
    ).run(relativePath, sourceKey);
  }

  it("returns an empty result when oldKey === newKey", async () => {
    const out = await rewriteEntityFilesForSourceRename({
      db,
      contextDir,
      oldKey: "zoom",
      newKey: "zoom",
    });
    expect(out).toEqual({
      rewrote: [],
      skippedNewKeyExists: [],
      skippedMultipleVariants: [],
      skippedOldKeyMissing: [],
      errors: [],
    });
  });

  it("rewrites a matching entity file and returns its path", async () => {
    seedEntity(
      "work/meetings/standup.md",
      `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom: zm_abc
---
`,
      "zoom",
    );

    const out = await rewriteEntityFilesForSourceRename({
      db,
      contextDir,
      oldKey: "zoom",
      newKey: "Zoom Workplace",
    });
    expect(out.rewrote).toEqual(["work/meetings/standup.md"]);
    const after = readFileSync(
      join(contextDir, "work/meetings/standup.md"),
      "utf-8",
    );
    expect(after).toContain('  "Zoom Workplace": zm_abc');
  });

  it("notifies an injected AgentWriteTracker on each rewrite", async () => {
    seedEntity(
      "work/meetings/standup.md",
      `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom: zm_abc
---
`,
      "zoom",
    );

    const markWriting = vi.fn();
    await rewriteEntityFilesForSourceRename({
      db,
      contextDir,
      oldKey: "zoom",
      newKey: "Webex",
      writeTracker: { markWriting } as unknown as Parameters<
        typeof rewriteEntityFilesForSourceRename
      >[0]["writeTracker"],
    });
    expect(markWriting).toHaveBeenCalledTimes(1);
    const [path, body] = markWriting.mock.calls[0]!;
    expect(path).toBe(join(contextDir, "work/meetings/standup.md"));
    expect(body).toContain("  Webex: zm_abc");
  });

  it("records `errors` when reading a missing file fails", async () => {
    // Sidecar row points at a path that has been deleted from disk —
    // reachable when the entity-mirror has been ahead of an external
    // file mover. Surface the ENOENT as an error reason rather than
    // throwing the whole rewrite.
    db.prepare(
      `INSERT INTO entities (path, domain, type, slug, title)
       VALUES (?, 'work', 'meeting', 'standup', 'Standup')`,
    ).run("work/meetings/missing.md");
    db.prepare(
      `INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)`,
    ).run("work/meetings/missing.md", "zoom");

    const out = await rewriteEntityFilesForSourceRename({
      db,
      contextDir,
      oldKey: "zoom",
      newKey: "Webex",
    });
    expect(out.rewrote).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.path).toBe("work/meetings/missing.md");
    // Node's fs error code for missing files.
    expect(out.errors[0]?.reason).toBe("ENOENT");
  });

  it("records `errors` when writeFileAtomically fails", async () => {
    // Hits the catch branch around the atomic write. Mock
    // `writeFileAtomically` to throw — relying on a clobbered parent
    // dir is too brittle on macOS APFS.
    seedEntity(
      "work/meetings/standup.md",
      `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom: zm_abc
---
`,
      "zoom",
    );
    const atomicWrite = await import("../atomic-write.js");
    const spy = vi
      .spyOn(atomicWrite, "writeFileAtomically")
      .mockImplementation(() => {
        throw new Error("disk full");
      });
    try {
      const out = await rewriteEntityFilesForSourceRename({
        db,
        contextDir,
        oldKey: "zoom",
        newKey: "Webex",
      });
      expect(out.rewrote).toEqual([]);
      expect(out.errors).toEqual([
        { path: "work/meetings/standup.md", reason: "disk full" },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("preserves a non-Error throw from writeFileAtomically as a string reason", async () => {
    // Defensive arm of the rewrite catch:
    // `err instanceof Error ? err.message : String(err)`.
    seedEntity(
      "work/meetings/standup.md",
      `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  zoom: zm_abc
---
`,
      "zoom",
    );
    const atomicWrite = await import("../atomic-write.js");
    const spy = vi
      .spyOn(atomicWrite, "writeFileAtomically")
      .mockImplementation(() => {
        // Raw string throw — the catch must fall through to String(err).
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "not-even-an-error";
      });
    try {
      const out = await rewriteEntityFilesForSourceRename({
        db,
        contextDir,
        oldKey: "zoom",
        newKey: "Webex",
      });
      expect(out.errors).toEqual([
        { path: "work/meetings/standup.md", reason: "not-even-an-error" },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies `old_key_missing` outcomes as skippedOldKeyMissing", async () => {
    // The sidecar row points at a path whose frontmatter no longer
    // contains the matching key (the entity-mirror is lagging the file
    // edit). The walker must NOT error or rewrite — it logs the path
    // for surfacing only.
    seedEntity(
      "work/meetings/standup.md",
      `---
domain: work
type: meeting
slug: standup
title: Daily Standup
sources:
  webex: w_abc
---
`,
      "zoom",
    );

    const out = await rewriteEntityFilesForSourceRename({
      db,
      contextDir,
      oldKey: "zoom",
      newKey: "Webex",
    });
    expect(out.skippedOldKeyMissing).toEqual(["work/meetings/standup.md"]);
    expect(out.rewrote).toEqual([]);
  });

  it("classifies `no_frontmatter` outcomes as skippedOldKeyMissing", async () => {
    // Same skipped-bucket as old_key_missing — both describe a file
    // whose state the rewriter can't act on but doesn't consider an
    // error. (Switch case fall-through.)
    seedEntity("work/meetings/standup.md", "# no frontmatter\n", "zoom");

    const out = await rewriteEntityFilesForSourceRename({
      db,
      contextDir,
      oldKey: "zoom",
      newKey: "Webex",
    });
    expect(out.skippedOldKeyMissing).toEqual(["work/meetings/standup.md"]);
  });

  it("classifies `new_key_exists` and `multiple_variants` into their own buckets", async () => {
    seedEntity(
      "work/meetings/a.md",
      `---
domain: work
type: meeting
slug: a
title: A
sources:
  zoom: z_a
  Webex: w_a
---
`,
      "zoom",
    );
    seedEntity(
      "work/meetings/b.md",
      `---
domain: work
type: meeting
slug: b
title: B
sources:
  zoom: z_b
  ZOOM: zu_b
---
`,
      "zoom",
    );

    const out = await rewriteEntityFilesForSourceRename({
      db,
      contextDir,
      oldKey: "zoom",
      newKey: "Webex",
    });
    expect(out.skippedNewKeyExists).toEqual(["work/meetings/a.md"]);
    expect(out.skippedMultipleVariants).toHaveLength(1);
    expect(out.skippedMultipleVariants[0]?.path).toBe("work/meetings/b.md");
    expect(out.skippedMultipleVariants[0]?.variants.sort()).toEqual([
      "ZOOM",
      "zoom",
    ]);
  });
});

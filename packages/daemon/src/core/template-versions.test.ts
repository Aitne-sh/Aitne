import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  PENDING_UPGRADES_KEY,
  checkTemplateUpgrades,
  findPendingTemplateUpgrades,
  readFileTemplateVersion,
  readPendingTemplateUpgrades,
  readTemplateManifest,
  writePendingTemplateUpgrades,
} from "./template-versions.js";
import { applySchema } from "../db/schema.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function writeTemplate(
  root: string,
  rel: string,
  body: string,
): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf-8");
}

describe("readFileTemplateVersion", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-tmpl-ver-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses a numeric template_version from frontmatter", () => {
    writeTemplate(
      tmp,
      "a.md",
      "---\ntype: rule\ntemplate_version: 3\nowner: shared\n---\n# A\n",
    );
    expect(readFileTemplateVersion(join(tmp, "a.md"))).toBe(3);
  });

  it("returns null when frontmatter is absent", () => {
    writeTemplate(tmp, "a.md", "# A\n");
    expect(readFileTemplateVersion(join(tmp, "a.md"))).toBeNull();
  });

  it("returns null when template_version field is missing", () => {
    writeTemplate(
      tmp,
      "a.md",
      "---\ntype: rule\nowner: shared\n---\n# A\n",
    );
    expect(readFileTemplateVersion(join(tmp, "a.md"))).toBeNull();
  });

  it("returns null when the file does not exist", () => {
    expect(readFileTemplateVersion(join(tmp, "missing.md"))).toBeNull();
  });

  it("returns null when template_version sits after the closing delimiter", () => {
    // Value outside frontmatter must not match — the module explicitly
    // stops scanning at the closing ---.
    writeTemplate(
      tmp,
      "a.md",
      "---\ntype: rule\n---\n# A\ntemplate_version: 9\n",
    );
    expect(readFileTemplateVersion(join(tmp, "a.md"))).toBeNull();
  });

  it("rejects non-integer template_version values", () => {
    writeTemplate(
      tmp,
      "a.md",
      "---\ntemplate_version: 3.14\n---\n# A\n",
    );
    expect(readFileTemplateVersion(join(tmp, "a.md"))).toBeNull();
  });

  it("returns null when readFileSync throws (e.g. path is a directory)", () => {
    // A directory at the spot where a file is expected — existsSync
    // returns true but readFileSync throws EISDIR.
    mkdirSync(join(tmp, "is-a-dir"), { recursive: true });
    expect(readFileTemplateVersion(join(tmp, "is-a-dir"))).toBeNull();
  });

  it("returns null when frontmatter never closes (no second ---)", () => {
    writeTemplate(
      tmp,
      "a.md",
      "---\ntype: rule\nowner: shared\n# missing closer and no version\n",
    );
    expect(readFileTemplateVersion(join(tmp, "a.md"))).toBeNull();
  });

  it("only reads the bounded 64 KB header when the file is huge", () => {
    // Frontmatter sits at the top; the 64 KB cap means a multi-MB body is
    // ignored for parsing. The version must still be returned.
    const padding = "x".repeat(70_000);
    writeTemplate(
      tmp,
      "big.md",
      `---\ntemplate_version: 7\n---\n# A\n${padding}\n`,
    );
    expect(readFileTemplateVersion(join(tmp, "big.md"))).toBe(7);
  });
});

describe("readTemplateManifest", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-tmpl-mf-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses a well-formed manifest", () => {
    writeFileSync(
      join(tmp, "_manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        templates: {
          "rules/x.md": { version: 2 },
        },
      }),
    );
    const manifest = readTemplateManifest(tmp);
    expect(manifest?.manifestVersion).toBe(1);
    expect(manifest?.templates["rules/x.md"].version).toBe(2);
  });

  it("returns null when the manifest file is missing", () => {
    expect(readTemplateManifest(tmp)).toBeNull();
  });

  it("returns null when the manifest is malformed JSON", () => {
    writeFileSync(join(tmp, "_manifest.json"), "{ not json ");
    expect(readTemplateManifest(tmp)).toBeNull();
  });

  it("rejects manifests whose entries have no numeric version", () => {
    writeFileSync(
      join(tmp, "_manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        templates: { "x.md": { version: "one" } },
      }),
    );
    expect(readTemplateManifest(tmp)).toBeNull();
  });

  it("rejects manifests with path traversal keys", () => {
    writeFileSync(
      join(tmp, "_manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        templates: { "../escape.md": { version: 1 } },
      }),
    );
    expect(readTemplateManifest(tmp)).toBeNull();
  });

  it("rejects manifests whose templates field is not an object", () => {
    writeFileSync(
      join(tmp, "_manifest.json"),
      JSON.stringify({ manifestVersion: 1, templates: ["a.md"] }),
    );
    // Arrays are typeof "object" but Object.entries returns numeric
    // indices — those entries fail the per-entry validation. Either way
    // the manifest must be rejected.
    expect(readTemplateManifest(tmp)).toBeNull();
  });

  it("rejects manifests whose templates field is explicitly null", () => {
    writeFileSync(
      join(tmp, "_manifest.json"),
      JSON.stringify({ manifestVersion: 1, templates: null }),
    );
    expect(readTemplateManifest(tmp)).toBeNull();
  });

  it("rejects manifests whose entry is null", () => {
    writeFileSync(
      join(tmp, "_manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        templates: { "a.md": null },
      }),
    );
    expect(readTemplateManifest(tmp)).toBeNull();
  });

  it("rejects manifests whose entry is a primitive (not object)", () => {
    writeFileSync(
      join(tmp, "_manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        templates: { "a.md": 5 },
      }),
    );
    expect(readTemplateManifest(tmp)).toBeNull();
  });

  it("rejects manifests with non-numeric manifestVersion", () => {
    writeFileSync(
      join(tmp, "_manifest.json"),
      JSON.stringify({ manifestVersion: "1", templates: {} }),
    );
    expect(readTemplateManifest(tmp)).toBeNull();
  });
});

describe("findPendingTemplateUpgrades", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-tmpl-pend-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports files whose user-side version trails the manifest", () => {
    writeTemplate(
      tmp,
      "rules/management.md",
      "---\ntype: rule\ntemplate_version: 1\nowner: shared\n---\n# M\n",
    );
    const manifest = {
      manifestVersion: 1,
      templates: { "rules/management.md": { version: 3 } },
    };
    const pending = findPendingTemplateUpgrades(manifest, tmp);
    expect(pending).toEqual([
      { path: "rules/management.md", from: 1, to: 3 },
    ]);
  });

  it("skips files whose user-side version matches the manifest", () => {
    writeTemplate(
      tmp,
      "rules/management.md",
      "---\ntype: rule\ntemplate_version: 2\nowner: shared\n---\n# M\n",
    );
    const manifest = {
      manifestVersion: 1,
      templates: { "rules/management.md": { version: 2 } },
    };
    expect(findPendingTemplateUpgrades(manifest, tmp)).toEqual([]);
  });

  it("skips files whose user-side version is ahead of the manifest", () => {
    // A user who advanced template_version manually signals 'do not
    // touch' — we stay out of their way.
    writeTemplate(
      tmp,
      "rules/management.md",
      "---\ntype: rule\ntemplate_version: 99\nowner: shared\n---\n# M\n",
    );
    const manifest = {
      manifestVersion: 1,
      templates: { "rules/management.md": { version: 2 } },
    };
    expect(findPendingTemplateUpgrades(manifest, tmp)).toEqual([]);
  });

  it("skips files missing from the user's vault", () => {
    const manifest = {
      manifestVersion: 1,
      templates: { "rules/absent.md": { version: 5 } },
    };
    expect(findPendingTemplateUpgrades(manifest, tmp)).toEqual([]);
  });

  it("skips files with no template_version marker (treated as user-rewritten)", () => {
    writeTemplate(
      tmp,
      "rules/management.md",
      "---\ntype: rule\nowner: shared\n---\n# user rewrote\n",
    );
    const manifest = {
      manifestVersion: 1,
      templates: { "rules/management.md": { version: 3 } },
    };
    expect(findPendingTemplateUpgrades(manifest, tmp)).toEqual([]);
  });

  it("returns pending entries sorted by path", () => {
    writeTemplate(tmp, "z.md", "---\ntemplate_version: 1\n---\n");
    writeTemplate(tmp, "a.md", "---\ntemplate_version: 1\n---\n");
    const manifest = {
      manifestVersion: 1,
      templates: {
        "z.md": { version: 2 },
        "a.md": { version: 2 },
      },
    };
    const pending = findPendingTemplateUpgrades(manifest, tmp);
    expect(pending.map((p) => p.path)).toEqual(["a.md", "z.md"]);
  });
});

describe("checkTemplateUpgrades + runtime_state integration", () => {
  let tmp: string;
  let db: Database.Database;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-tmpl-ck-"));
    db = seedDb();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  it("writes an empty snapshot when templatesRoot is null", () => {
    const pending = checkTemplateUpgrades(db, null, tmp);
    expect(pending).toEqual([]);
    const snap = readPendingTemplateUpgrades(db);
    expect(snap?.pending).toEqual([]);
    expect(typeof snap?.checkedAt).toBe("string");
  });

  it("writes an empty snapshot when the manifest is missing", () => {
    const templatesRoot = join(tmp, "templates");
    mkdirSync(templatesRoot, { recursive: true });
    const pending = checkTemplateUpgrades(db, templatesRoot, tmp);
    expect(pending).toEqual([]);
    expect(readPendingTemplateUpgrades(db)?.pending).toEqual([]);
  });

  it("round-trips a pending list through runtime_state", () => {
    const templatesRoot = join(tmp, "templates");
    const contextDir = join(tmp, "ctx");
    mkdirSync(templatesRoot, { recursive: true });
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(
      join(templatesRoot, "_manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        templates: { "rules/x.md": { version: 2 } },
      }),
    );
    writeTemplate(
      contextDir,
      "rules/x.md",
      "---\ntemplate_version: 1\n---\n# X\n",
    );

    const pending = checkTemplateUpgrades(db, templatesRoot, contextDir);
    expect(pending).toEqual([{ path: "rules/x.md", from: 1, to: 2 }]);

    const snap = readPendingTemplateUpgrades(db);
    expect(snap?.pending).toEqual([{ path: "rules/x.md", from: 1, to: 2 }]);
  });

  it("replaces a previous pending snapshot on re-run", () => {
    writePendingTemplateUpgrades(db, [
      { path: "stale.md", from: 1, to: 2 },
    ]);
    checkTemplateUpgrades(db, null, tmp);
    expect(readPendingTemplateUpgrades(db)?.pending).toEqual([]);
  });
});

describe("shipped manifest consistency", () => {
  // Manifest is auto-generated but drift happens when a template bumps
  // its frontmatter version without the manifest being regenerated (or
  // vice versa). This test reads the real shipped manifest + templates
  // and asserts every entry agrees with the file on disk.
  it("every manifest entry matches the file's template_version", () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
    );
    const templatesRoot = join(repoRoot, "agent-assets", "templates");
    const manifest = readTemplateManifest(templatesRoot);
    expect(manifest).not.toBeNull();

    const mismatches: string[] = [];
    for (const [rel, entry] of Object.entries(manifest!.templates)) {
      const onDisk = readFileTemplateVersion(join(templatesRoot, rel));
      if (onDisk !== entry.version) {
        mismatches.push(
          `${rel}: manifest=${entry.version} file=${onDisk}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("every versioned template file appears in the manifest", () => {
    // A template with template_version in its frontmatter MUST have a
    // manifest entry so the boot check can detect upgrades on it.
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
    );
    const templatesRoot = join(repoRoot, "agent-assets", "templates");
    const manifest = readTemplateManifest(templatesRoot);
    expect(manifest).not.toBeNull();
    const manifestPaths = new Set(Object.keys(manifest!.templates));

    function walk(dir: string, prefix: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push(...walk(full, rel));
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          out.push(rel);
        }
      }
      return out;
    }

    const orphaned: string[] = [];
    for (const rel of walk(templatesRoot, "")) {
      const v = readFileTemplateVersion(join(templatesRoot, rel));
      if (v === null) continue;
      if (!manifestPaths.has(rel)) orphaned.push(rel);
    }
    expect(orphaned).toEqual([]);
  });
});

describe("PENDING_UPGRADES_KEY is stable", () => {
  it("uses a namespaced key that will not collide", () => {
    expect(PENDING_UPGRADES_KEY).toBe("templates.pending");
  });
});

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  detectOrphanOverlays,
  discardOrphanOverlay,
  scanAndRecordOrphanOverlays,
} from "./orphan-overlay.js";

let db: Database.Database;
let dataDir: string;
let skillsRoot: string;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  dataDir = mkdtempSync(join(tmpdir(), "orphan-data-"));
  skillsRoot = mkdtempSync(join(tmpdir(), "orphan-skills-"));
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(skillsRoot, { recursive: true, force: true });
});

function writeOverlay(
  slug: string,
  sectionId: string,
  envelope: unknown,
): string {
  const dir = join(dataDir, "skill-curation-overlays", slug);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${sectionId}.json`);
  writeFileSync(p, JSON.stringify(envelope, null, 2), "utf-8");
  return p;
}

function writeCurationDeclaration(slug: string, sections: unknown[]): void {
  const dir = join(skillsRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "curation.json"),
    JSON.stringify({ version: 1, sections }, null, 2),
    "utf-8",
  );
}

const VALID_KNOWLEDGE_LAYOUT = {
  schema_version: 1,
  skill_slug: "user-profile",
  section_id: "topic-files",
  kind: "knowledge_layout",
  payload: {
    kind: "knowledge_layout",
    files: [
      {
        path: "user/profile.md",
        purpose: "identity, preferences, learned context bullets",
        sections: [
          { heading: "## Identity", contains: "name, location, languages spoken" },
        ],
      },
    ],
  },
  applied_proposal_id: 1,
  applied_at: 1000,
};

describe("detectOrphanOverlays", () => {
  it("returns no orphans when overlays match a current declaration", () => {
    writeCurationDeclaration("user-profile", [
      {
        id: "topic-files",
        kind: "knowledge_layout",
        anchor: "<!-- CURATION:knowledge_layout id=\"topic-files\" -->",
        human_label: "Topic files",
        description: "What lives where",
        scope_paths: ["user/*.md"],
      },
    ]);
    writeOverlay("user-profile", "topic-files", VALID_KNOWLEDGE_LAYOUT);

    const r = detectOrphanOverlays(dataDir, skillsRoot);
    expect(r.orphans).toEqual([]);
    expect(r.scanned_overlays).toBe(1);
  });

  it("flags overlays whose declaration was removed", () => {
    writeCurationDeclaration("user-profile", []);
    // The CurationDeclaration schema requires at least one section, so we
    // need to write a different (still legal) declaration that omits this
    // section while declaring another.
    writeCurationDeclaration("user-profile", [
      {
        id: "other-section",
        kind: "convention_notes",
        anchor: "<!-- CURATION:convention_notes id=\"other-section\" -->",
        human_label: "Other",
        description: "Other",
        scope_paths: ["user/*.md"],
      },
    ]);
    writeOverlay("user-profile", "topic-files", VALID_KNOWLEDGE_LAYOUT);

    const r = detectOrphanOverlays(dataDir, skillsRoot);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0].reason).toBe("section_not_declared");
    expect(r.orphans[0].slug).toBe("user-profile");
    expect(r.orphans[0].section_id).toBe("topic-files");
    expect(r.orphans[0].kind).toBe("knowledge_layout");
  });

  it("flags every overlay when the skill has no curation.json", () => {
    writeOverlay("ghost-skill", "topic-files", VALID_KNOWLEDGE_LAYOUT);
    const r = detectOrphanOverlays(dataDir, skillsRoot);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0].reason).toBe("skill_has_no_curation");
  });

  it("flags overlays whose envelope is corrupt", () => {
    writeCurationDeclaration("user-profile", [
      {
        id: "topic-files",
        kind: "knowledge_layout",
        anchor: "<!-- CURATION:knowledge_layout id=\"topic-files\" -->",
        human_label: "Topic files",
        description: "What lives where",
        scope_paths: ["user/*.md"],
      },
    ]);
    const dir = join(dataDir, "skill-curation-overlays", "user-profile");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "topic-files.json"), "{ not json", "utf-8");
    // Corrupt overlays whose section IS declared still pass the
    // declaration check (kind=null skips the kind comparison) and so are
    // NOT flagged. Walk a different file that doesn't match: write a
    // second overlay whose section_id is undeclared.
    writeOverlay("user-profile", "absent-section", { not: "an envelope" });

    const r = detectOrphanOverlays(dataDir, skillsRoot);
    const reasons = r.orphans.map((o) => `${o.section_id}:${o.reason}`);
    expect(reasons).toContain("absent-section:section_not_declared");
  });

  it("flags overlays whose declared kind no longer matches the envelope kind", () => {
    writeCurationDeclaration("user-profile", [
      {
        id: "topic-files",
        // Declaration now claims this is convention_notes, but the
        // overlay envelope on disk says knowledge_layout.
        kind: "convention_notes",
        anchor: "<!-- CURATION:convention_notes id=\"topic-files\" -->",
        human_label: "Topic files",
        description: "Renamed kind",
        scope_paths: ["user/*.md"],
      },
    ]);
    writeOverlay("user-profile", "topic-files", VALID_KNOWLEDGE_LAYOUT);
    const r = detectOrphanOverlays(dataDir, skillsRoot);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0].reason).toBe("kind_mismatch");
  });

  it("returns empty when the overlays directory is absent", () => {
    rmSync(dataDir, { recursive: true });
    const r = detectOrphanOverlays(dataDir, skillsRoot);
    expect(r.scanned_overlays).toBe(0);
    expect(r.orphans).toEqual([]);
  });

  it("skips non-directory entries at the overlays root (covers 74)", () => {
    // A stray loose file under PA_DATA_DIR/skill-curation-overlays/ must be ignored.
    mkdirSync(join(dataDir, "skill-curation-overlays"), { recursive: true });
    writeFileSync(join(dataDir, "skill-curation-overlays", "loose.txt"), "ignored", "utf-8");
    // Write one real overlay to confirm we still walk valid slug dirs.
    writeOverlay("ghost", "section", VALID_KNOWLEDGE_LAYOUT);
    const r = detectOrphanOverlays(dataDir, skillsRoot);
    expect(r.scanned_overlays).toBe(1);
    expect(r.orphans.map((o) => o.slug)).toEqual(["ghost"]);
  });

  it("skips non-file and non-.json entries within a slug directory (covers 79-80)", () => {
    const slugDir = join(dataDir, "skill-curation-overlays", "ghost");
    mkdirSync(slugDir, { recursive: true });
    // history/ subdir → not a file, must be skipped
    mkdirSync(join(slugDir, "history"));
    // a .txt file → not .json, must be skipped
    writeFileSync(join(slugDir, "notes.txt"), "stray", "utf-8");
    // one valid overlay JSON
    writeFileSync(
      join(slugDir, "section.json"),
      JSON.stringify(VALID_KNOWLEDGE_LAYOUT),
      "utf-8",
    );
    const r = detectOrphanOverlays(dataDir, skillsRoot);
    expect(r.scanned_overlays).toBe(1);
    expect(r.orphans.map((o) => o.section_id)).toEqual(["section"]);
  });
});

describe("scanAndRecordOrphanOverlays", () => {
  it("persists the report to runtime_state and emits one log line per orphan", () => {
    writeOverlay("ghost", "section", VALID_KNOWLEDGE_LAYOUT);
    const r = scanAndRecordOrphanOverlays(db, dataDir, skillsRoot);
    expect(r.orphans).toHaveLength(1);
    const row = db
      .prepare(
        `SELECT value_json FROM runtime_state WHERE key = 'skill_curation.orphan_overlays'`,
      )
      .get() as { value_json: string };
    const parsed = JSON.parse(row.value_json) as { orphans: unknown[] };
    expect(parsed.orphans).toHaveLength(1);
  });
});

describe("discardOrphanOverlay", () => {
  it("deletes the overlay file when an orphan match is found", () => {
    const path = writeOverlay("ghost", "section", VALID_KNOWLEDGE_LAYOUT);
    expect(existsSync(path)).toBe(true);
    const r = discardOrphanOverlay(dataDir, skillsRoot, "ghost", "section");
    expect(r.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to discard when the overlay is not an orphan", () => {
    writeCurationDeclaration("user-profile", [
      {
        id: "topic-files",
        kind: "knowledge_layout",
        anchor: "<!-- CURATION:knowledge_layout id=\"topic-files\" -->",
        human_label: "Topic files",
        description: "What lives where",
        scope_paths: ["user/*.md"],
      },
    ]);
    writeOverlay("user-profile", "topic-files", VALID_KNOWLEDGE_LAYOUT);
    const r = discardOrphanOverlay(dataDir, skillsRoot, "user-profile", "topic-files");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_orphan");
  });

  it("refuses to discard when no overlay exists at all", () => {
    const r = discardOrphanOverlay(dataDir, skillsRoot, "no-skill", "no-section");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_orphan");
  });

});

// Mock-based race-condition tests for the TOCTOU branches at lines 196-197
// and 204-205. Both sit between detect (which just ran) and the final
// fs.delete — natural reproduction would require an actual filesystem
// race, so we drive the underlying fs primitives via vi.doMock + dynamic
// import of the orphan-overlay module.
describe("discardOrphanOverlay — TOCTOU race branches (mocked fs)", () => {
  let mockDataDir: string;
  let mockSkillsRoot: string;

  beforeEach(() => {
    mockDataDir = mkdtempSync(join(tmpdir(), "orphan-mock-data-"));
    mockSkillsRoot = mkdtempSync(join(tmpdir(), "orphan-mock-skills-"));
  });
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    rmSync(mockDataDir, { recursive: true, force: true });
    rmSync(mockSkillsRoot, { recursive: true, force: true });
  });

  it("returns overlay_missing when existsSync(orphan_path) returns false (covers 196-197)", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const orphanPath = join(mockDataDir, "skill-curation-overlays", "ghost", "section.json");
    realFs.mkdirSync(join(mockDataDir, "skill-curation-overlays", "ghost"), { recursive: true });
    realFs.writeFileSync(orphanPath, JSON.stringify(VALID_KNOWLEDGE_LAYOUT), "utf-8");

    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...realFs,
      default: realFs,
      existsSync: (p: string) => {
        if (p === orphanPath) return false;
        return realFs.existsSync(p);
      },
    }));
    const mod = await import("./orphan-overlay.js");
    const r = mod.discardOrphanOverlay(mockDataDir, mockSkillsRoot, "ghost", "section");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("overlay_missing");
  });

  it("returns stat_failed when statSync throws (covers 204-205)", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const orphanPath = join(mockDataDir, "skill-curation-overlays", "ghost2", "section.json");
    realFs.mkdirSync(join(mockDataDir, "skill-curation-overlays", "ghost2"), { recursive: true });
    realFs.writeFileSync(orphanPath, JSON.stringify(VALID_KNOWLEDGE_LAYOUT), "utf-8");

    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...realFs,
      default: realFs,
      statSync: (p: string) => {
        if (p === orphanPath) {
          throw new Error("EACCES simulated by mock");
        }
        return realFs.statSync(p);
      },
    }));
    const mod = await import("./orphan-overlay.js");
    const r = mod.discardOrphanOverlay(mockDataDir, mockSkillsRoot, "ghost2", "section");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stat_failed");
  });

  it("returns not_file when statSync reports a directory (adjacent branch in same block)", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const orphanPath = join(mockDataDir, "skill-curation-overlays", "ghost3", "section.json");
    realFs.mkdirSync(join(mockDataDir, "skill-curation-overlays", "ghost3"), { recursive: true });
    realFs.writeFileSync(orphanPath, JSON.stringify(VALID_KNOWLEDGE_LAYOUT), "utf-8");

    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...realFs,
      default: realFs,
      statSync: (p: string) => {
        if (p === orphanPath) {
          return { isFile: () => false } as ReturnType<typeof realFs.statSync>;
        }
        return realFs.statSync(p);
      },
    }));
    const mod = await import("./orphan-overlay.js");
    const r = mod.discardOrphanOverlay(mockDataDir, mockSkillsRoot, "ghost3", "section");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_file");
  });
});

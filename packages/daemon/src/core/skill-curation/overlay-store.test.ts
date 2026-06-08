import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_CURATION_SCHEMA_VERSION } from "@aitne/shared";
import {
  isKnownSectionKind,
  migrateOverlay,
  OverlayStore,
  payloadHash,
} from "./overlay-store.js";

let dataDir: string;
let skillsRoot: string;
let store: OverlayStore;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "overlay-store-"));
  dataDir = join(root, "data");
  skillsRoot = join(root, "skills");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });
  store = new OverlayStore(dataDir, skillsRoot);
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(skillsRoot, { recursive: true, force: true });
});

const samplePayload = {
  kind: "convention_notes" as const,
  notes: [{ topic: "Date prefix", rule: "Entries are written as [YYYY-MM-DD]." }],
};

const sampleEnvelope = {
  schema_version: SKILL_CURATION_SCHEMA_VERSION,
  skill_slug: "user-profile",
  section_id: "learned-context-format",
  kind: "convention_notes" as const,
  payload: samplePayload,
  applied_proposal_id: 1,
  applied_at: 1717000000000,
};

describe("OverlayStore.read precedence", () => {
  it("returns null when neither overlay nor seed exists", () => {
    expect(store.read("user-profile", "x", "convention_notes")).toBeNull();
  });

  it("falls back to seed when no overlay", () => {
    const seedDir = join(skillsRoot, "user-profile", "seeds");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(
      join(seedDir, "learned-context-format.seed.json"),
      JSON.stringify(samplePayload),
      "utf-8",
    );
    const env = store.read("user-profile", "learned-context-format", "convention_notes");
    expect(env).not.toBeNull();
    expect(env?.payload.kind).toBe("convention_notes");
    expect(env?.applied_proposal_id).toBeNull();
  });

  it("prefers overlay over seed", () => {
    const seedDir = join(skillsRoot, "user-profile", "seeds");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(
      join(seedDir, "learned-context-format.seed.json"),
      JSON.stringify({ kind: "convention_notes", notes: [{ topic: "Old", rule: "Plain rule." }] }),
      "utf-8",
    );
    store.write(sampleEnvelope, null);
    const env = store.read("user-profile", "learned-context-format", "convention_notes");
    expect(env?.payload).toEqual(samplePayload);
  });
});

describe("OverlayStore.read — kind-mismatch guards", () => {
  it("throws when overlay envelope kind disagrees with caller's kind (covers 79-83)", () => {
    // The on-disk overlay claims kind=convention_notes but the caller asks
    // for knowledge_layout — refuse rather than silently mis-rendering.
    store.write(sampleEnvelope, null);
    expect(() =>
      store.read("user-profile", "learned-context-format", "knowledge_layout"),
    ).toThrow(/overlay kind mismatch/);
  });

  it("throws when seed kind disagrees with caller's kind (covers 104-107)", () => {
    // No overlay on disk → falls through to readSeed. Seed file is a valid
    // CurationPayload of kind=convention_notes but the caller asks for
    // knowledge_layout, so the kind-equality check throws.
    const seedDir = join(skillsRoot, "user-profile", "seeds");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(
      join(seedDir, "wrong-kind.seed.json"),
      JSON.stringify({
        kind: "convention_notes",
        notes: [{ topic: "Date prefix", rule: "Entries are written as [YYYY-MM-DD]." }],
      }),
      "utf-8",
    );
    expect(() =>
      store.read("user-profile", "wrong-kind", "knowledge_layout"),
    ).toThrow(/seed kind mismatch/);
  });
});

describe("OverlayStore.write", () => {
  it("snapshots prior overlay to history when proposalId provided", () => {
    store.write(sampleEnvelope, null);
    const updated = {
      ...sampleEnvelope,
      payload: {
        kind: "convention_notes" as const,
        notes: [{ topic: "Date prefix", rule: "Entries use [YYYY-MM-DD] prefix at the head." }],
      },
      applied_proposal_id: 2,
    };
    store.write(updated, 1);
    const histPath = store.paths.historyPath(sampleEnvelope.skill_slug, 1);
    expect(existsSync(histPath)).toBe(true);
    const histContent = JSON.parse(readFileSync(histPath, "utf-8"));
    expect(histContent.payload).toEqual(samplePayload);
  });
});

describe("OverlayStore.restoreFromHistory", () => {
  it("restores prior overlay via history snapshot", () => {
    store.write(sampleEnvelope, null);
    const updated = { ...sampleEnvelope, applied_proposal_id: 99 };
    store.write(updated, 1);
    store.restoreFromHistory("user-profile", "learned-context-format", 1);
    const env = store.read("user-profile", "learned-context-format", "convention_notes");
    expect(env?.applied_proposal_id).toBe(1);
  });

  it("throws when no history snapshot", () => {
    expect(() => store.restoreFromHistory("user-profile", "x", 999)).toThrow();
  });
});

describe("OverlayStore.delete", () => {
  it("removes the overlay file", () => {
    store.write(sampleEnvelope, null);
    expect(store.hasOverlay("user-profile", "learned-context-format")).toBe(true);
    store.delete("user-profile", "learned-context-format");
    expect(store.hasOverlay("user-profile", "learned-context-format")).toBe(false);
  });
});

describe("payloadHash", () => {
  it("is stable across key order", () => {
    const a = { kind: "convention_notes" as const, notes: [{ rule: "A.", topic: "T" }] };
    const b = { kind: "convention_notes" as const, notes: [{ topic: "T", rule: "A." }] };
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it("differs for distinct payloads", () => {
    const a = { kind: "convention_notes" as const, notes: [{ topic: "T", rule: "A." }] };
    const b = { kind: "convention_notes" as const, notes: [{ topic: "T", rule: "B." }] };
    expect(payloadHash(a)).not.toBe(payloadHash(b));
  });
});

describe("migrateOverlay", () => {
  it("returns same envelope at current version", () => {
    expect(migrateOverlay(sampleEnvelope)).toEqual(sampleEnvelope);
  });

  it("throws on downgrade", () => {
    expect(() =>
      migrateOverlay({ ...sampleEnvelope, schema_version: SKILL_CURATION_SCHEMA_VERSION + 1 }),
    ).toThrow(/downgrade/);
  });

  it("throws on too-old schema with no registered migrator (covers 183-186)", () => {
    // SKILL_CURATION_SCHEMA_VERSION is the current version (currently 1).
    // schema_version=0 is older with no migrator chain registered.
    expect(() =>
      migrateOverlay({ ...sampleEnvelope, schema_version: 0 }),
    ).toThrow(/no migrator registered/);
  });
});

describe("isKnownSectionKind", () => {
  it("accepts known kinds, rejects others", () => {
    expect(isKnownSectionKind("convention_notes")).toBe(true);
    expect(isKnownSectionKind("garbage")).toBe(false);
  });
});

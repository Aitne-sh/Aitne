// P22 §1.5, §5.4 — overlay store.
//
// Layout (under PA_DATA_DIR — CONTEXT_VAULT_REDESIGN_PLAN.md v4 V11 moved
// these out of `<dataDir>/skills/overlays/` because overlays are operational
// metadata, not vault content; user skill MD files moved into the vault at
// `<contextDir>/policies/skills/` but the JSON envelopes stay here):
//
//   ~/.personal-agent/skill-curation-overlays/<slug>/<section_id>.json   ← active overlay
//   ~/.personal-agent/skill-curation-overlays/<slug>/history/<proposal_id>.json
//
// Read precedence at session-materialization time:
//
//   1. Active overlay JSON       (operator-applied or auto-applied)
//   2. Repo seed JSON             (agent-assets/skills/<slug>/curation.seed.json)
//   3. Empty (anchor renders to nothing — strip the line)
//
// Schema-version migration is a stub for v1 — only one schema version exists.
// When a future migrator chain lands under `migrate/v<n>-to-v<n+1>.ts` the
// `migrateOverlay()` helper folds them in. Migrated overlays are NOT written
// back to disk on cold boot — only after the user explicitly accepts the next
// proposal that touches that section (§5.4).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  CurationPayload,
  type CurationPayloadValue,
  OverlayEnvelope,
  type OverlayEnvelopeValue,
  SECTION_KINDS,
  type SectionKind,
  SKILL_CURATION_SCHEMA_VERSION,
} from "@aitne/shared";

/** Operational overlay root under PA_DATA_DIR. Shared with `orphan-overlay.ts`
 *  and the migration runner — kept out of the vault per v4 V11. */
export const SKILL_CURATION_OVERLAYS_DIR = "skill-curation-overlays";

export interface OverlayStorePaths {
  /** PA_DATA_DIR / skill-curation-overlays / <slug> */
  overlaysDir(slug: string): string;
  /** PA_DATA_DIR / skill-curation-overlays / <slug> / <section_id>.json */
  overlayPath(slug: string, sectionId: string): string;
  /** PA_DATA_DIR / skill-curation-overlays / <slug> / history / <proposal_id>.json */
  historyPath(slug: string, proposalId: number): string;
  /** agent-assets / skills / <slug> / curation.seed.json */
  seedPath(slug: string, sectionId: string): string;
}

export class OverlayStore {
  /**
   * @param dataDir Resolved PA_DATA_DIR (e.g. ~/.personal-agent expanded).
   * @param skillsRoot Repo `agent-assets/skills/` (for seed JSON fallback).
   */
  constructor(
    private readonly dataDir: string,
    private readonly skillsRoot: string,
  ) {}

  paths: OverlayStorePaths = {
    overlaysDir: (slug) => join(this.dataDir, SKILL_CURATION_OVERLAYS_DIR, slug),
    overlayPath: (slug, sectionId) =>
      join(this.dataDir, SKILL_CURATION_OVERLAYS_DIR, slug, `${sectionId}.json`),
    historyPath: (slug, proposalId) =>
      join(this.dataDir, SKILL_CURATION_OVERLAYS_DIR, slug, "history", `${proposalId}.json`),
    seedPath: (slug, sectionId) =>
      join(this.skillsRoot, slug, "seeds", `${sectionId}.seed.json`),
  };

  hasOverlay(slug: string, sectionId: string): boolean {
    return existsSync(this.paths.overlayPath(slug, sectionId));
  }

  /** Returns the current overlay (or null when neither overlay nor seed exist). */
  read(slug: string, sectionId: string, kind: SectionKind): OverlayEnvelopeValue | null {
    const overlayPath = this.paths.overlayPath(slug, sectionId);
    if (existsSync(overlayPath)) {
      const env = parseEnvelope(readFileSync(overlayPath, "utf-8"));
      if (env.kind !== kind) {
        throw new Error(
          `overlay kind mismatch for ${slug}/${sectionId} (file=${env.kind}, expected=${kind})`,
        );
      }
      return migrateOverlay(env);
    }
    const seed = this.readSeed(slug, sectionId, kind);
    return seed;
  }

  /** Returns the payload only (overlay > seed > null). */
  readPayload(slug: string, sectionId: string, kind: SectionKind): CurationPayloadValue | null {
    const env = this.read(slug, sectionId, kind);
    return env ? env.payload : null;
  }

  readSeed(slug: string, sectionId: string, kind: SectionKind): OverlayEnvelopeValue | null {
    const seedPath = this.paths.seedPath(slug, sectionId);
    if (!existsSync(seedPath)) return null;
    const raw = readFileSync(seedPath, "utf-8");
    const json = JSON.parse(raw);
    // A seed JSON is a bare payload (no envelope) by convention — wrap it.
    const payload = CurationPayload.parse(json);
    if (payload.kind !== kind) {
      throw new Error(
        `seed kind mismatch for ${slug}/${sectionId} (seed=${payload.kind}, expected=${kind})`,
      );
    }
    return {
      schema_version: SKILL_CURATION_SCHEMA_VERSION,
      skill_slug: slug,
      section_id: sectionId,
      kind,
      payload,
      applied_proposal_id: null,
      applied_at: null,
    };
  }

  /** P22 §5.1 — write a new overlay envelope (snapshotting prior to history). */
  write(envelope: OverlayEnvelopeValue, snapshotProposalId: number | null): void {
    const dir = this.paths.overlaysDir(envelope.skill_slug);
    mkdirSync(dir, { recursive: true });
    const target = this.paths.overlayPath(envelope.skill_slug, envelope.section_id);
    if (snapshotProposalId !== null && existsSync(target)) {
      const histDir = dirname(this.paths.historyPath(envelope.skill_slug, snapshotProposalId));
      mkdirSync(histDir, { recursive: true });
      writeFileSync(
        this.paths.historyPath(envelope.skill_slug, snapshotProposalId),
        readFileSync(target, "utf-8"),
        "utf-8",
      );
    }
    writeFileSync(target, JSON.stringify(envelope, null, 2), "utf-8");
  }

  /** Restore the overlay from a history snapshot (revert path). */
  restoreFromHistory(slug: string, sectionId: string, proposalId: number): void {
    const histPath = this.paths.historyPath(slug, proposalId);
    if (!existsSync(histPath)) {
      throw new Error(`no history snapshot for proposal ${proposalId}`);
    }
    const dir = this.paths.overlaysDir(slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.paths.overlayPath(slug, sectionId), readFileSync(histPath, "utf-8"), "utf-8");
  }

  /** Discard an overlay (orphan-overlay one-click discard, §5.4). */
  delete(slug: string, sectionId: string): void {
    const target = this.paths.overlayPath(slug, sectionId);
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

function parseEnvelope(raw: string): OverlayEnvelopeValue {
  const json = JSON.parse(raw);
  return OverlayEnvelope.parse(json);
}

/** Hash used by §5.1 step 3 conflict check. Stable JSON serialization. */
export function payloadHash(payload: CurationPayloadValue): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** Guard rail for §5.4 schema migrations. v1 is the current schema; any
 *  overlay claiming a higher version → load failure. Lower versions go
 *  through the (currently empty) migrator chain. */
export function migrateOverlay(env: OverlayEnvelopeValue): OverlayEnvelopeValue {
  if (env.schema_version === SKILL_CURATION_SCHEMA_VERSION) return env;
  if (env.schema_version > SKILL_CURATION_SCHEMA_VERSION) {
    throw new Error(
      `overlay schema_version=${env.schema_version} > current=${SKILL_CURATION_SCHEMA_VERSION} (downgrade)`,
    );
  }
  // No migrators yet — guard for future use.
  throw new Error(
    `overlay schema_version=${env.schema_version} is too old; no migrator registered`,
  );
}

export function isKnownSectionKind(value: string): value is SectionKind {
  return (SECTION_KINDS as readonly string[]).includes(value);
}

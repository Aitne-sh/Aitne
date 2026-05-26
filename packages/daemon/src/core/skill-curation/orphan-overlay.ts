// P22 §5.4 — orphan overlay detector.
//
// An overlay is "orphaned" when its on-disk overlay JSON
// (`PA_DATA_DIR/skill-curation-overlays/<slug>/<section_id>.json`) has no matching
// declaration in the skill's `curation.json`. This happens when a framework
// PR removes a section from `curation.json` while a previously-applied
// overlay still exists on disk for that section.
//
// Per design §5.4: overlays are NEVER auto-deleted — the user always
// confirms. This module only detects + logs; the discard path is gated by
// an explicit owner action via `POST /api/skill-curation/orphans/discard`.
//
// Logging cadence: at startup the daemon walks the overlay directory once
// and emits one `skill_curation.declaration.orphan_overlay` log per orphan
// found. Subsequent detections (e.g. after a `git pull` that removes a
// section while the daemon is running) surface via the API endpoint that
// re-walks on demand — there's no chokidar watch on `agent-assets/skills/`
// because curation.json declarations are part of the framework, not user
// data, and changes only occur on operator-initiated upgrades.
//
// The renderer falls back to the "anchor missing → strip line" path when
// an orphan overlay is detected, so the rendered SKILL.md gracefully
// degrades to the seed (or empty) until the overlay is discarded.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  type CurationDeclarationValue,
  OverlayEnvelope,
  type SectionKind,
} from "@aitne/shared";
import { readFileSync } from "node:fs";
import { loadAllCurationDeclarations } from "./declarations.js";
import { OverlayStore, SKILL_CURATION_OVERLAYS_DIR } from "./overlay-store.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("skill-curation-orphan");

export interface OrphanOverlay {
  slug: string;
  section_id: string;
  kind: SectionKind | null;
  applied_proposal_id: number | null;
  applied_at: number | null;
  reason: "section_not_declared" | "skill_has_no_curation" | "kind_mismatch";
  overlay_path: string;
}

export interface OrphanOverlaysReport {
  orphans: OrphanOverlay[];
  scanned_overlays: number;
}

/** Walks `PA_DATA_DIR/skill-curation-overlays/<slug>/*.json` and cross-references
 *  each envelope against the current `curation.json` declaration for that slug.
 *  Returns one record per orphan. Does not mutate disk. */
export function detectOrphanOverlays(
  dataDir: string,
  skillsRoot: string,
): OrphanOverlaysReport {
  const overlaysRoot = join(dataDir, SKILL_CURATION_OVERLAYS_DIR);
  if (!existsSync(overlaysRoot)) return { orphans: [], scanned_overlays: 0 };

  const declarations = new Map<string, CurationDeclarationValue | null>();
  for (const loaded of loadAllCurationDeclarations(skillsRoot)) {
    declarations.set(loaded.slug, loaded.declaration);
  }

  const orphans: OrphanOverlay[] = [];
  let scanned = 0;

  for (const slugEntry of readdirSync(overlaysRoot, { withFileTypes: true })) {
    if (!slugEntry.isDirectory()) continue;
    const slug = slugEntry.name;
    const slugDir = join(overlaysRoot, slug);
    for (const file of readdirSync(slugDir, { withFileTypes: true })) {
      // Skip the history/ subdirectory and any non-JSON entries.
      if (!file.isFile()) continue;
      if (!file.name.endsWith(".json")) continue;
      scanned++;
      const overlayPath = join(slugDir, file.name);
      const sectionId = file.name.slice(0, -".json".length);

      // Best-effort envelope parse — corrupt overlays are flagged as orphans
      // with `kind=null` so the user sees them in the UI rather than having
      // them silently fail at materialization time.
      let envelopeKind: SectionKind | null = null;
      let appliedProposalId: number | null = null;
      let appliedAt: number | null = null;
      try {
        const raw = readFileSync(overlayPath, "utf-8");
        const env = OverlayEnvelope.parse(JSON.parse(raw));
        envelopeKind = env.kind;
        appliedProposalId = env.applied_proposal_id;
        appliedAt = env.applied_at;
      } catch {
        // Corrupt overlay → still flagged as orphan, with null kind.
      }

      const decl = declarations.get(slug);
      if (decl === undefined || decl === null) {
        // Skill has no curation.json → every overlay is orphaned.
        orphans.push({
          slug,
          section_id: sectionId,
          kind: envelopeKind,
          applied_proposal_id: appliedProposalId,
          applied_at: appliedAt,
          reason: "skill_has_no_curation",
          overlay_path: overlayPath,
        });
        continue;
      }
      const declared = decl.sections.find((s) => s.id === sectionId);
      if (!declared) {
        orphans.push({
          slug,
          section_id: sectionId,
          kind: envelopeKind,
          applied_proposal_id: appliedProposalId,
          applied_at: appliedAt,
          reason: "section_not_declared",
          overlay_path: overlayPath,
        });
        continue;
      }
      if (envelopeKind !== null && envelopeKind !== declared.kind) {
        orphans.push({
          slug,
          section_id: sectionId,
          kind: envelopeKind,
          applied_proposal_id: appliedProposalId,
          applied_at: appliedAt,
          reason: "kind_mismatch",
          overlay_path: overlayPath,
        });
      }
    }
  }

  return { orphans, scanned_overlays: scanned };
}

/** Boot-time scan: emits one log line per orphan + persists a summary in
 *  `runtime_state.skill_curation.orphan_overlays` so the dashboard banner
 *  can read it without re-walking the FS. */
export function scanAndRecordOrphanOverlays(
  db: Database.Database,
  dataDir: string,
  skillsRoot: string,
): OrphanOverlaysReport {
  const report = detectOrphanOverlays(dataDir, skillsRoot);
  for (const o of report.orphans) {
    logger.warn(
      {
        slug: o.slug,
        section_id: o.section_id,
        kind: o.kind,
        reason: o.reason,
        applied_proposal_id: o.applied_proposal_id,
      },
      "skill_curation.declaration.orphan_overlay",
    );
  }
  db.prepare(
    `INSERT INTO runtime_state (key, value_json, updated_at)
     VALUES ('skill_curation.orphan_overlays', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(JSON.stringify({ orphans: report.orphans, scanned_at: Date.now() }));
  return report;
}

/** Owner-confirmed discard. Removes the on-disk overlay JSON. The renderer
 *  falls back to seed (or empty) on the next session materialization. The
 *  history snapshot is preserved so the user can recover the value via a
 *  manual file copy if needed. */
export function discardOrphanOverlay(
  dataDir: string,
  skillsRoot: string,
  slug: string,
  sectionId: string,
): { ok: true; discarded_path: string } | { ok: false; reason: string } {
  // Re-detect to make sure the orphan still exists (race-safe).
  const report = detectOrphanOverlays(dataDir, skillsRoot);
  const orphan = report.orphans.find(
    (o) => o.slug === slug && o.section_id === sectionId,
  );
  if (!orphan) {
    return { ok: false, reason: "not_orphan" };
  }
  const store = new OverlayStore(dataDir, skillsRoot);
  if (!existsSync(orphan.overlay_path)) {
    return { ok: false, reason: "overlay_missing" };
  }
  // Sanity check that the file we're about to delete is the overlay we
  // detected (defense against TOCTOU between detect + discard).
  try {
    const st = statSync(orphan.overlay_path);
    if (!st.isFile()) return { ok: false, reason: "not_file" };
  } catch {
    return { ok: false, reason: "stat_failed" };
  }
  store.delete(slug, sectionId);
  logger.info(
    { slug, section_id: sectionId, reason: orphan.reason },
    "skill_curation.declaration.orphan_overlay_discarded",
  );
  return { ok: true, discarded_path: orphan.overlay_path };
}

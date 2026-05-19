// P22 §1.5 — anchor splicer.
//
// Substitutes `<!-- CURATION:<kind> id="<id>" -->` anchors in a SKILL.md
// body with the rendered overlay content. Pure function — no I/O, no
// dependency on the file system. Callers (SkillsCompiler) load overlays
// and pass the resolved payload map; this module produces the spliced
// markdown.
//
// When an anchor has no payload (no overlay AND no seed), the anchor LINE
// is removed entirely. Removing only the anchor would leave an orphan
// heading; the §1.6 rule "anchor MUST be the only content between its
// owning heading and the next heading" lets us do this safely AND we
// keep the heading line so the SKILL.md author retains editorial control.
//
// When an anchor has a kind/id mismatch with the declaration, the line
// is removed and a `splicer_kind_mismatch` log line is emitted via the
// caller-provided `onWarning` callback.

import type { CurationPayloadValue, SectionKind } from "@aitne/shared";
import { renderCurationSection } from "./render/index.js";

const ANCHOR_RE = /<!--\s*CURATION:([a-z_]+)\s+id="([a-z0-9-]+)"\s*-->/i;

export interface SplicerWarning {
  code: "splicer_orphan_anchor" | "splicer_kind_mismatch" | "splicer_render_error";
  anchorId: string;
  message: string;
}

export type ResolveOverlay = (
  sectionId: string,
  kind: SectionKind,
) => CurationPayloadValue | null;

export interface SpliceResult {
  body: string;
  warnings: SplicerWarning[];
}

export function spliceCurationAnchors(
  md: string,
  resolveOverlay: ResolveOverlay,
  options: { knownSectionIds?: Set<string> } = {},
): SpliceResult {
  const warnings: SplicerWarning[] = [];
  const lines = md.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const m = ANCHOR_RE.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const kind = m[1].toLowerCase() as SectionKind;
    const id = m[2];
    if (options.knownSectionIds && !options.knownSectionIds.has(id)) {
      warnings.push({ code: "splicer_orphan_anchor", anchorId: id, message: `no declaration for "${id}"` });
      // Drop the line.
      continue;
    }
    let payload: CurationPayloadValue | null;
    try {
      payload = resolveOverlay(id, kind);
    } catch (err) {
      warnings.push({
        code: "splicer_render_error",
        anchorId: id,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!payload) {
      // No overlay, no seed — strip the anchor entirely.
      continue;
    }
    if (payload.kind !== kind) {
      warnings.push({
        code: "splicer_kind_mismatch",
        anchorId: id,
        message: `anchor kind=${kind} but overlay payload kind=${payload.kind}`,
      });
      continue;
    }
    try {
      const rendered = renderCurationSection(kind, payload);
      out.push(rendered);
    } catch (err) {
      warnings.push({
        code: "splicer_render_error",
        anchorId: id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { body: out.join("\n"), warnings };
}

export function hasCurationAnchors(md: string): boolean {
  return ANCHOR_RE.test(md);
}

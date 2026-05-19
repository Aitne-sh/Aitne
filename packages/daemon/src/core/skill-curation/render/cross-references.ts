// P22 §1.4.5 — cross_references renderer.
//
// Single-line bullets. No prose, no code fences.

import type { CrossReferencesValue } from "@aitne/shared";

export const RENDERER_VERSION = "cross_references/1";

export function renderCrossReferences(payload: CrossReferencesValue): string {
  return payload.refs
    .map((ref) => `- \`${ref.from_path}\` ↔ \`${ref.to_path}\` — ${ref.relation}`)
    .join("\n");
}

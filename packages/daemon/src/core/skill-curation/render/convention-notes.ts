// P22 §1.4.5 — convention_notes renderer.
//
// Bullet list, **topic** bolded, rule body, optional example after "Example:".

import type { ConventionNotesValue } from "@aitne/shared";

export const RENDERER_VERSION = "convention_notes/1";

export function renderConventionNotes(payload: ConventionNotesValue): string {
  return payload.notes
    .map((note) => {
      const example = note.example ? ` Example: \`${note.example}\`.` : "";
      return `- **${note.topic}.** ${note.rule}${example}`;
    })
    .join("\n");
}

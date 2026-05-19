export type JournalMirrorRendering = "plain" | "obsidian";

export interface RenderJournalMirrorOptions {
  rendering: JournalMirrorRendering;
}

/**
 * B-007 Phase 3 / B-005 split:
 * the morning routine synthesizes `context/daily/*.md`; journal services only
 * mirror that already-rendered content to another root.
 *
 * Rendering is therefore intentionally pass-through for now. Future B-005
 * work can extend this module with backend-specific transforms without
 * reintroducing synthesis responsibility here.
 */
export function renderJournalMirrorContent(
  content: string,
  opts: RenderJournalMirrorOptions,
): string {
  switch (opts.rendering) {
    case "plain":
    case "obsidian":
      return content;
  }
}

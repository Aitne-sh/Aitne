/**
 * Operating-playbook registry — the single typed source of truth for the
 * curated methodology fragments a user-deployed recurring/scheduled Agent can
 * declare (AGENT_PROMPT_QUALITY_DESIGN.md §3.2 / Phase 2).
 *
 * Playbooks are delivered *by injection only*: a declarative `playbooks: []`
 * field on the Agent definition (see `agent-definitions.ts`) that the dispatcher
 * injects *by content* into the deployed prompt at fire time — a hard, platform
 * -enforced guarantee, and the single copy in the agent's context. (The original
 * Phase-1 by-reference `playbooks` skill was retired once injection existed, to
 * avoid materializing the same text into the session a second time — see
 * AGENT_PROMPT_QUALITY_DESIGN.md §4.)
 *
 * This module mirrors the on-disk content-file stems so the schema enum, the
 * fire-time injector, and the authoring lint all agree on one list. A test
 * (`skills-manifest.test.ts`) pins `PLAYBOOK_SLUGS` byte-for-byte against the
 * `agent-assets/playbooks/` directory so the two can never drift (same precedent
 * as the recurrence-rule pin).
 *
 * Dependency-free of daemon internals: `@aitne/shared` owns the vocabulary, the
 * daemon owns the resolution to an absolute path + the read.
 */

/**
 * Playbook slugs, in declaration order. Each equals a content-file stem under
 * `agent-assets/playbooks/<slug>.md` and the `name:` frontmatter of that file.
 * Adding a playbook = add the `.md` + a slug here + a registry entry below; the
 * pin test enforces the 1:1 mapping.
 */
export const PLAYBOOK_SLUGS = ["research", "markdown-note", "monitoring"] as const;

export type PlaybookSlug = (typeof PLAYBOOK_SLUGS)[number];

/** Metadata the injector + authoring surfaces need for one playbook. */
export interface PlaybookMeta {
  /** Registry slug (== reference-file stem, == what an Agent declares). */
  readonly slug: PlaybookSlug;
  /**
   * Human label for the injected block header (`### <label> playbook`) and any
   * dashboard chips rendered from a definition's `playbooks:` list.
   */
  readonly label: string;
  /** Content filename under `agent-assets/playbooks/`. */
  readonly referenceFile: string;
}

/** slug → metadata. The daemon resolves `referenceFile` against workspaceDir. */
export const PLAYBOOK_REGISTRY: Record<PlaybookSlug, PlaybookMeta> = {
  research: {
    slug: "research",
    label: "Research",
    referenceFile: "research.md",
  },
  "markdown-note": {
    slug: "markdown-note",
    label: "Markdown-note",
    referenceFile: "markdown-note.md",
  },
  monitoring: {
    slug: "monitoring",
    label: "Monitoring / digest",
    referenceFile: "monitoring.md",
  },
};

/** Type guard: is `value` a known playbook slug? */
export function isPlaybookSlug(value: unknown): value is PlaybookSlug {
  return typeof value === "string" && (PLAYBOOK_SLUGS as readonly string[]).includes(value);
}

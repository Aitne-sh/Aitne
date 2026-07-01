import { describe, expect, it } from "vitest";
import {
  PLAYBOOK_REGISTRY,
  PLAYBOOK_SLUGS,
  isPlaybookSlug,
  type PlaybookSlug,
} from "./playbooks.js";

describe("playbook registry", () => {
  it("declares the Phase-1 playbook set in a stable order", () => {
    expect([...PLAYBOOK_SLUGS]).toEqual(["research", "markdown-note", "monitoring"]);
  });

  it("has one registry entry per slug, keyed by slug", () => {
    expect(Object.keys(PLAYBOOK_REGISTRY).sort()).toEqual([...PLAYBOOK_SLUGS].sort());
    for (const slug of PLAYBOOK_SLUGS) {
      const meta = PLAYBOOK_REGISTRY[slug];
      expect(meta.slug).toBe(slug);
      expect(meta.label.length).toBeGreaterThan(0);
      // The reference filename is exactly `<slug>.md` — the pin that lets the
      // fire-time injector resolve a slug to its bundled file.
      expect(meta.referenceFile).toBe(`${slug}.md`);
    }
  });

  it("uses human labels that match the SKILL.md section headings", () => {
    expect(PLAYBOOK_REGISTRY.research.label).toBe("Research");
    expect(PLAYBOOK_REGISTRY["markdown-note"].label).toBe("Markdown-note");
    expect(PLAYBOOK_REGISTRY.monitoring.label).toBe("Monitoring / digest");
  });

  describe("isPlaybookSlug", () => {
    it("returns true for every registry slug", () => {
      for (const slug of PLAYBOOK_SLUGS) {
        expect(isPlaybookSlug(slug)).toBe(true);
      }
    });

    it("returns false for unknown strings and non-strings", () => {
      expect(isPlaybookSlug("engineering")).toBe(false);
      expect(isPlaybookSlug("")).toBe(false);
      expect(isPlaybookSlug(undefined)).toBe(false);
      expect(isPlaybookSlug(null)).toBe(false);
      expect(isPlaybookSlug(42)).toBe(false);
    });

    it("narrows the type so a checked value can index the registry", () => {
      const candidate: unknown = "monitoring";
      if (isPlaybookSlug(candidate)) {
        const slug: PlaybookSlug = candidate;
        expect(PLAYBOOK_REGISTRY[slug].label).toBe("Monitoring / digest");
      }
    });
  });
});

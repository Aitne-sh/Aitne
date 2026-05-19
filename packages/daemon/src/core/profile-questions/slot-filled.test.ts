import { describe, it, expect } from "vitest";
import { isSlotFilled } from "./slot-filled.js";

describe("isSlotFilled", () => {
  describe("section presence", () => {
    it("reports sectionPresent=false when the section heading is missing", () => {
      const body = "# Profile\n\n## Other\n- something\n";
      expect(isSlotFilled(body, "Identity", null)).toEqual({
        filled: false,
        sectionPresent: false,
      });
    });

    it("strips YAML frontmatter before searching", () => {
      const body = [
        "---",
        "type: user",
        "owner: shared",
        "---",
        "# Profile",
        "## Identity",
        "- Name: Alex",
        "",
      ].join("\n");
      expect(isSlotFilled(body, "Identity", "Name")).toEqual({
        filled: true,
        sectionPresent: true,
      });
    });

    it("reports sectionPresent=true when section exists but is empty", () => {
      const body = "# Profile\n\n## Identity\n\n## Work Pattern\n- Working hours: 09–18\n";
      expect(isSlotFilled(body, "Identity", null)).toEqual({
        filled: false,
        sectionPresent: true,
      });
    });
  });

  describe("placeholder detection", () => {
    it("ignores '(To be filled during setup)' plain text", () => {
      const body = "## Identity\n(To be filled during setup)\n\n## Other\n";
      expect(isSlotFilled(body, "Identity", null)).toEqual({
        filled: false,
        sectionPresent: true,
      });
    });

    it("ignores common placeholder bullets without anchor", () => {
      const cases = [
        "## Identity\n- (none)\n",
        "## Identity\n- (Not yet configured)\n",
        "## Identity\n- TBD\n",
        "## Identity\n- TODO\n",
        "## Identity\n- > Add a fact when you learn it\n",
      ];
      for (const body of cases) {
        expect(isSlotFilled(body, "Identity", null).filled).toBe(false);
      }
    });

    it("treats non-placeholder bullets as substantive without anchor", () => {
      const body = "## Hobbies\n- Cycling on weekends\n";
      expect(isSlotFilled(body, "Hobbies", null)).toEqual({
        filled: true,
        sectionPresent: true,
      });
    });
  });

  describe("anchor matching", () => {
    const identityBody = [
      "## Identity",
      "- Name: Alex",
      "- Timezone: America/New_York",
      "",
    ].join("\n");

    it("matches the anchor key case-insensitively", () => {
      expect(isSlotFilled(identityBody, "Identity", "Name").filled).toBe(true);
      expect(isSlotFilled(identityBody, "Identity", "name").filled).toBe(true);
      expect(isSlotFilled(identityBody, "Identity", "TIMEZONE").filled).toBe(true);
    });

    it("does not over-tick on a sibling key", () => {
      // `Working hours: 09–18` should not satisfy `match=Sleep`.
      const body = [
        "## Work Pattern",
        "- Working hours: Weekdays 09:00–18:00",
        "- Quiet hours: 22:00–08:00",
        "",
      ].join("\n");
      expect(isSlotFilled(body, "Work Pattern", "Sleep").filled).toBe(false);
      expect(isSlotFilled(body, "Work Pattern", "Working hours").filled).toBe(
        true,
      );
    });

    it("requires `<anchor>:` separator (not naked-substring)", () => {
      // "- Naming convention: …" must not satisfy match=Name.
      const body = "## Identity\n- Naming convention: kebab-case\n";
      expect(isSlotFilled(body, "Identity", "Name").filled).toBe(false);
    });

    it("ignores bullets that have a colon but wrong key", () => {
      const body = "## Identity\n- Wakes around 06:00\n";
      expect(isSlotFilled(body, "Identity", "Name").filled).toBe(false);
    });

    it("returns sectionPresent even when no anchor matches", () => {
      const body = "## Identity\n- Wakes around 06:00\n";
      expect(isSlotFilled(body, "Identity", "Name")).toEqual({
        filled: false,
        sectionPresent: true,
      });
    });
  });

  describe("nested headings", () => {
    it("includes deeper subheadings inside the target section", () => {
      const body = [
        "## Family",
        "### Immediate",
        "- Sister (Sarah): two kids as of 2026-04",
        "### Extended",
        "- Cousin Aiko",
        "## Work",
        "- (unrelated)",
        "",
      ].join("\n");
      expect(isSlotFilled(body, "Family", null)).toEqual({
        filled: true,
        sectionPresent: true,
      });
    });

    it("stops at sibling headings of equal depth", () => {
      const body = [
        "## Family",
        "## Hobbies",
        "- Cycling",
        "",
      ].join("\n");
      expect(isSlotFilled(body, "Family", null).filled).toBe(false);
    });
  });

  describe("section==null (whole-file scan)", () => {
    it("returns filled when any non-placeholder bullet exists in the file", () => {
      const body = "# Title\n\n- Name: Alex\n";
      expect(isSlotFilled(body, null, null).filled).toBe(true);
    });

    it("with anchor and section==null still scans the whole file", () => {
      const body = [
        "## Identity",
        "## Hidden",
        "- Name: Alex",
        "",
      ].join("\n");
      expect(isSlotFilled(body, null, "Name").filled).toBe(true);
    });
  });

  describe("CRLF and whitespace tolerance", () => {
    it("handles \\r\\n line endings", () => {
      const body = "## Identity\r\n- Name: Alex\r\n";
      expect(isSlotFilled(body, "Identity", "Name").filled).toBe(true);
    });

    it("trims trailing whitespace on heading and bullet text", () => {
      const body = "## Identity   \n- Name:  Alex   \n";
      expect(isSlotFilled(body, "Identity", "Name").filled).toBe(true);
    });

    it("strips frontmatter with CRLF", () => {
      const body = "---\r\ntype: user\r\n---\r\n## Identity\r\n- Name: Alex\r\n";
      expect(isSlotFilled(body, "Identity", "Name").filled).toBe(true);
    });
  });

  describe("accepts asterisk and plus bullet markers", () => {
    it("matches `* Name: ...`", () => {
      const body = "## Identity\n* Name: Alex\n";
      expect(isSlotFilled(body, "Identity", "Name").filled).toBe(true);
    });

    it("matches `+ Name: ...`", () => {
      const body = "## Identity\n+ Name: Alex\n";
      expect(isSlotFilled(body, "Identity", "Name").filled).toBe(true);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PREVIOUS_WEEK_BLOCK_MAX_CHARS,
  getPreviousWeekIsoKey,
  isoYearWeekFromUtc,
  loadPreviousWeekDigest,
  renderPreviousWeekBlock,
} from "./previous-week-digest.js";

describe("previous-week-digest", () => {
  let contextDir: string;

  beforeEach(() => {
    contextDir = join(tmpdir(), `pa-prev-week-${Date.now()}-${Math.random()}`);
    mkdirSync(join(contextDir, "weekly"), { recursive: true });
  });

  afterEach(() => {
    rmSync(contextDir, { recursive: true, force: true });
  });

  // ── isoYearWeekFromUtc ─────────────────────────────────────────────

  describe("isoYearWeekFromUtc", () => {
    it("returns zero-padded ISO week strings", () => {
      // Mon 2026-01-05 is week 02 of ISO year 2026 (Jan 1 was a Thursday,
      // so 2025-12-29..2026-01-04 is W01, 2026-01-05..11 is W02).
      expect(isoYearWeekFromUtc(2026, 1, 5)).toBe("2026-W02");
    });

    it("handles Jan-1-belongs-to-previous-year edge case", () => {
      // 2022-01-01 was a Saturday → still inside ISO 2021-W52.
      expect(isoYearWeekFromUtc(2022, 1, 1)).toBe("2021-W52");
    });

    it("handles year boundary that lands in week 1 of the next ISO year", () => {
      // 2024-12-30 was a Monday → ISO 2025-W01.
      expect(isoYearWeekFromUtc(2024, 12, 30)).toBe("2025-W01");
    });

    it("handles ISO year with 53 weeks", () => {
      // 2020 had 53 ISO weeks. 2020-12-31 was a Thursday → 2020-W53.
      expect(isoYearWeekFromUtc(2020, 12, 31)).toBe("2020-W53");
    });

    it("returns W01 for early-year dates inside week 1", () => {
      // 2026-01-01 is a Thursday → inside W01 of 2026.
      expect(isoYearWeekFromUtc(2026, 1, 1)).toBe("2026-W01");
    });
  });

  // ── getPreviousWeekIsoKey ──────────────────────────────────────────

  describe("getPreviousWeekIsoKey", () => {
    // Pin tests to UTC so the runner's system TZ cannot shift the local
    // calendar date and bend the ISO-week assertion. The helper is the
    // single source of "which weekly file does today's morning_routine
    // inject", so every weekday of the same ISO week must resolve to
    // the same previous-week key.
    const FIXTURES_2026_W21 = [
      ["Monday", "2026-05-18T12:00:00Z"],
      ["Tuesday", "2026-05-19T12:00:00Z"],
      ["Wednesday", "2026-05-20T12:00:00Z"],
      ["Thursday", "2026-05-21T12:00:00Z"],
      ["Friday", "2026-05-22T12:00:00Z"],
      ["Saturday", "2026-05-23T12:00:00Z"],
      ["Sunday", "2026-05-24T12:00:00Z"],
    ] as const;

    for (const [label, iso] of FIXTURES_2026_W21) {
      it(`returns the previous-week key on ${label} of the same ISO week (2026-W21 → 2026-W20)`, () => {
        // The whole point of dropping Monday-only injection: morning_routine
        // sees the SAME previous-week file every weekday Mon–Sun. The
        // earlier `now - 3 days` heuristic silently returned the current
        // ISO week on Thu+, which is the bug this test pins.
        expect(getPreviousWeekIsoKey("UTC", new Date(iso))).toBe("2026-W20");
      });
    }

    it("rolls forward to the next previous-week key after Sunday boundary", () => {
      // Sunday 2026-05-24 → previous = W20. Monday 2026-05-25 starts W22
      // → previous = W21 (the just-ended week). The helper must flip on
      // the Monday boundary, not before.
      expect(getPreviousWeekIsoKey("UTC", new Date("2026-05-24T12:00:00Z"))).toBe(
        "2026-W20",
      );
      expect(getPreviousWeekIsoKey("UTC", new Date("2026-05-25T12:00:00Z"))).toBe(
        "2026-W21",
      );
    });

    it("crosses ISO year boundary correctly (Mon 2027-W01 → 2026-W53)", () => {
      const newYearMon = new Date("2027-01-04T12:00:00Z");
      expect(getPreviousWeekIsoKey("UTC", newYearMon)).toBe("2026-W53");
    });

    it("respects timezone for date arithmetic around midnight", () => {
      // 2026-05-25T15:00 UTC is Mon 2026-05-25 in LA (08:00) and
      // Tue 2026-05-26 in Tokyo (00:00). Both calendar dates land inside
      // ISO W22, so both must return W21 as the previous-week key.
      const instant = new Date("2026-05-25T15:00:00Z");
      expect(getPreviousWeekIsoKey("Asia/Tokyo", instant)).toBe("2026-W21");
      expect(getPreviousWeekIsoKey("America/Los_Angeles", instant)).toBe(
        "2026-W21",
      );
    });
  });

  // ── loadPreviousWeekDigest ─────────────────────────────────────────

  describe("loadPreviousWeekDigest", () => {
    it("returns null when the weekly file does not exist", async () => {
      const digest = await loadPreviousWeekDigest(contextDir, "2026-W20");
      expect(digest).toBeNull();
    });

    it("returns null when the file is empty", async () => {
      writeFileSync(join(contextDir, "weekly", "2026-W20.md"), "");
      const digest = await loadPreviousWeekDigest(contextDir, "2026-W20");
      expect(digest).toBeNull();
    });

    it("returns null when none of the three target sections are present", async () => {
      const body = [
        "---",
        "type: weekly",
        "owner: agent",
        "updated: 2026-05-15",
        "---",
        "# Weekly Review 2026-W20",
        "",
        "## Highlights",
        "- shipped the migration",
        "",
        "## Completed",
        "- swapped the schema",
      ].join("\n");
      writeFileSync(join(contextDir, "weekly", "2026-W20.md"), body);
      const digest = await loadPreviousWeekDigest(contextDir, "2026-W20");
      expect(digest).toBeNull();
    });

    it("extracts all three sections, headers excluded, bodies trimmed", async () => {
      const body = [
        "---",
        "type: weekly",
        "owner: agent",
        "updated: 2026-05-15",
        "---",
        "# Weekly Review 2026-W20",
        "",
        "## Highlights",
        "- shipped the migration",
        "",
        "## Open Loops",
        "- Sarah's reply still pending",
        "",
        "## Carry Over to Next Week",
        "- Sarah's reply — blocking the rollout",
        "- API review feedback — pending PM sign-off",
        "",
        "## Next Week Focus",
        "- Land the auth refactor",
        "- Prep the Q3 roadmap",
        "",
        "## Lessons for Next Week",
        "- Tue/Wed mornings ate into focus time → block 9-11 on calendar",
        "- Email replies after 14:00 slid to next day → process first wave by 11:00",
        "",
      ].join("\n");
      writeFileSync(join(contextDir, "weekly", "2026-W20.md"), body);
      const digest = await loadPreviousWeekDigest(contextDir, "2026-W20");
      expect(digest).not.toBeNull();
      expect(digest!.period).toBe("2026-W20");
      expect(digest!.carryOver).toBe(
        "- Sarah's reply — blocking the rollout\n- API review feedback — pending PM sign-off",
      );
      expect(digest!.focus).toBe(
        "- Land the auth refactor\n- Prep the Q3 roadmap",
      );
      expect(digest!.lessons).toBe(
        "- Tue/Wed mornings ate into focus time → block 9-11 on calendar\n- Email replies after 14:00 slid to next day → process first wave by 11:00",
      );
      // generatedAt is a real ISO-8601 timestamp from the file mtime.
      expect(digest!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("returns empty bodies for sections present but empty (Lessons only)", async () => {
      const body = [
        "# Weekly Review 2026-W20",
        "",
        "## Lessons for Next Week",
        "- (none — quiet week)",
        "",
      ].join("\n");
      writeFileSync(join(contextDir, "weekly", "2026-W20.md"), body);
      const digest = await loadPreviousWeekDigest(contextDir, "2026-W20");
      expect(digest).not.toBeNull();
      expect(digest!.carryOver).toBe("");
      expect(digest!.focus).toBe("");
      expect(digest!.lessons).toBe("- (none — quiet week)");
    });

    it("stops body extraction at the next H2 (does not bleed into following sections)", async () => {
      const body = [
        "# Weekly Review 2026-W20",
        "",
        "## Next Week Focus",
        "- Top 1",
        "- Top 2",
        "",
        "## Carry Over to Next Week",
        "- Item A — reason",
        "",
        "## Lessons for Next Week",
        "- pattern → action",
        "",
        "## Some Trailing Section",
        "- Don't bleed me in",
      ].join("\n");
      writeFileSync(join(contextDir, "weekly", "2026-W20.md"), body);
      const digest = await loadPreviousWeekDigest(contextDir, "2026-W20");
      expect(digest).not.toBeNull();
      expect(digest!.focus).toBe("- Top 1\n- Top 2");
      expect(digest!.carryOver).toBe("- Item A — reason");
      expect(digest!.lessons).toBe("- pattern → action");
      expect(digest!.lessons).not.toContain("Trailing");
    });

    it("uses the source file mtime for generated_at", async () => {
      const filePath = join(contextDir, "weekly", "2026-W20.md");
      writeFileSync(
        filePath,
        ["# Weekly Review 2026-W20", "", "## Next Week Focus", "- A"].join("\n"),
      );
      // Force a known mtime (2026-05-15 19:00 UTC).
      const t = new Date("2026-05-15T19:00:00Z");
      utimesSync(filePath, t, t);
      const digest = await loadPreviousWeekDigest(contextDir, "2026-W20");
      expect(digest!.generatedAt).toBe("2026-05-15T19:00:00.000Z");
    });

    it("returns null when the weekly entry exists but is a directory (readFile throws EISDIR)", async () => {
      // existsSync passes (the path resolves), but readFile/stat raise
      // because the entry is a directory — both errors collapse to the
      // single try/catch and return null.
      mkdirSync(join(contextDir, "weekly", "2026-W20.md"));
      const digest = await loadPreviousWeekDigest(contextDir, "2026-W20");
      expect(digest).toBeNull();
    });
  });

  // ── renderPreviousWeekBlock ────────────────────────────────────────

  describe("renderPreviousWeekBlock", () => {
    it("renders the documented XML shape with all three sub-blocks", () => {
      const rendered = renderPreviousWeekBlock({
        period: "2026-W20",
        generatedAt: "2026-05-15T19:00:00.000Z",
        carryOver: "- Item A — reason\n- Item B — reason",
        focus: "- Top 1\n- Top 2",
        lessons: "- pattern A → action A\n- pattern B → action B",
      });
      expect(rendered).toContain(
        '<previous_week period="2026-W20" generated_at="2026-05-15T19:00:00.000Z">',
      );
      expect(rendered).toContain("<carry_over>");
      expect(rendered).toContain("    - Item A — reason");
      expect(rendered).toContain("</carry_over>");
      expect(rendered).toContain("<focus>");
      expect(rendered).toContain("    - Top 1");
      expect(rendered).toContain("</focus>");
      expect(rendered).toContain("<lessons>");
      expect(rendered).toContain("    - pattern A → action A");
      expect(rendered).toContain("</lessons>");
      expect(rendered).toContain("</previous_week>");
    });

    it("renders `(none recorded)` placeholder when any sub-block body is empty", () => {
      const rendered = renderPreviousWeekBlock({
        period: "2026-W20",
        generatedAt: "2026-05-15T19:00:00.000Z",
        carryOver: "- Item A",
        focus: "",
        lessons: "",
      });
      expect(rendered).toMatch(/<focus>\n\s+\(none recorded\)\n\s+<\/focus>/);
      expect(rendered).toMatch(/<lessons>\n\s+\(none recorded\)\n\s+<\/lessons>/);
    });

    it("renders `(none recorded)` for all three sections when the digest is fully empty", () => {
      // Pins the empty-string branch of `body || \"(none recorded)\"` for
      // carry_over — the other two sub-blocks were already covered by the
      // partial-empty test above, but the carry_over arm only fires when
      // the carryOver field itself is empty.
      const rendered = renderPreviousWeekBlock({
        period: "2026-W20",
        generatedAt: "2026-05-15T19:00:00.000Z",
        carryOver: "",
        focus: "",
        lessons: "",
      });
      expect(rendered).toMatch(/<carry_over>\n\s+\(none recorded\)\n\s+<\/carry_over>/);
      expect(rendered).toMatch(/<focus>\n\s+\(none recorded\)\n\s+<\/focus>/);
      expect(rendered).toMatch(/<lessons>\n\s+\(none recorded\)\n\s+<\/lessons>/);
    });

    it("preserves blank lines inside a section body (does not prefix empty lines)", () => {
      // The `indent` helper short-circuits empty lines so the indented
      // output keeps the paragraph break visible without trailing
      // whitespace. Pins the `line.length === 0` truthy branch.
      const rendered = renderPreviousWeekBlock({
        period: "2026-W20",
        generatedAt: "2026-05-15T19:00:00.000Z",
        carryOver: "- Item A\n\n- Item B",
        focus: "- Focus",
        lessons: "- Lesson",
      });
      // Each non-empty bullet gets 4-space indent; the blank line between
      // them stays a bare empty line (no prefix).
      expect(rendered).toContain("    - Item A\n\n    - Item B");
    });

    it("preserves sections that fit within their proportional budget and replaces zero-budget sections with the marker", () => {
      // Total > PREVIOUS_WEEK_BLOCK_MAX_CHARS forces truncation, but the
      // proportional split allocates effectively zero bytes to the two
      // tiny sections. truncate() then exercises both edge branches:
      //   • lessons (budget == text.length == 1) — text-fits-budget short
      //     circuit, returns the body verbatim.
      //   • focus (budget == 0) — marker-length floor, returns "...".
      // The long carryOver section follows the normal slice + marker path.
      const longCarryOver = "x".repeat(5000);
      const rendered = renderPreviousWeekBlock({
        period: "2026-W20",
        generatedAt: "2026-05-15T19:00:00.000Z",
        carryOver: longCarryOver,
        focus: "f",
        lessons: "l",
      });
      const focusBody = rendered.match(/<focus>([\s\S]*?)<\/focus>/)?.[1];
      const lessonsBody = rendered.match(/<lessons>([\s\S]*?)<\/lessons>/)?.[1];
      const carryBody = rendered.match(/<carry_over>([\s\S]*?)<\/carry_over>/)?.[1];
      expect(focusBody?.trim()).toBe("...");
      expect(lessonsBody?.trim()).toBe("l");
      expect(carryBody?.trim().endsWith("...")).toBe(true);
    });

    it("truncates oversize bodies with an explicit ellipsis marker", () => {
      const oversize = Array.from({ length: 200 })
        .map((_, i) => `- Item ${i} — a fairly long reason that pads the byte count`)
        .join("\n");
      const rendered = renderPreviousWeekBlock({
        period: "2026-W20",
        generatedAt: "2026-05-15T19:00:00.000Z",
        carryOver: oversize,
        focus: oversize,
        lessons: oversize,
      });
      // All three sub-blocks should be truncated with the explicit marker.
      const carryBlock = rendered.match(/<carry_over>([\s\S]*?)<\/carry_over>/)?.[1];
      const focusBlock = rendered.match(/<focus>([\s\S]*?)<\/focus>/)?.[1];
      const lessonsBlock = rendered.match(/<lessons>([\s\S]*?)<\/lessons>/)?.[1];
      expect(carryBlock).toContain("...");
      expect(focusBlock).toContain("...");
      expect(lessonsBlock).toContain("...");
      // The total body payload stays within the documented cap (give a
      // small overhead for indentation + ellipsis markers).
      const bodyStart = rendered.indexOf("<carry_over>");
      const bodyEnd = rendered.lastIndexOf("</lessons>");
      expect(bodyEnd - bodyStart).toBeLessThanOrEqual(
        PREVIOUS_WEEK_BLOCK_MAX_CHARS + 400,
      );
    });
  });
});

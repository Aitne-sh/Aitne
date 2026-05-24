import { describe, expect, it } from "vitest";
import {
  normalizeRoadmapForWrite,
  validateRoadmap,
  validateRoadmapTransition,
} from "./roadmap-validate.js";

const canonicalRoadmap = [
  "# Roadmap",
  "> Last synced: 2026-04-20",
  "",
  "## Annual Goals",
  "",
  "## Quarterly Focus",
  "",
  "## Long-term Plans",
  "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->",
  "",
  "## Agent Action Plan",
  "### 2026-05-10 ~ 05-15: LA Trip  <!-- id: rm-20260419-a3f1c2 -->",
  "Source: Travel Bookings",
  "Destination: Los Angeles, CA",
  "",
  "**Preparation Timeline:**",
  "- 2026-04-20 [notify] [provisional — confirm with user]: Start ESTA prep",
  "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel",
  "",
  "**Agent Notes:**",
  "- Booking found.",
  "",
  "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->",
  "Source: scheduled.task — wake-up 2026-04-22 09:00",
  "Status: ⏳ pending",
  "",
  "## Recurring",
  "- Every Friday: weekly review",
  "",
].join("\n");

describe("validateRoadmap", () => {
  it("accepts canonical roadmap bodies", () => {
    expect(validateRoadmap(canonicalRoadmap).ok).toBe(true);
  });

  it("normalizes user-authored Long-term Plans lines before validation", () => {
    const body = canonicalRoadmap.replace(
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->",
      "- [2026-05] LA trip candidate  <!-- id: rm-20260419-111111 -->",
    );

    const normalized = normalizeRoadmapForWrite(body, { today: "2026-04-19" });
    expect(normalized.content).toContain(
      "- [2026-05] LA trip candidate — Source: dashboard 2026-04-19 — Review: 2026-04-20 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->",
    );
    expect(validateRoadmap(normalized.content).ok).toBe(true);
  });

  it("leaves bodies without a Long-term Plans section unchanged during normalization", () => {
    const body = "# Roadmap\n> Last synced: 2026-04-20\n\n## Notes\n- scratch";
    expect(normalizeRoadmapForWrite(body)).toEqual({
      content: body,
      changed: false,
      warnings: [],
    });
  });

  it("uses the configured default Long-term Plans source while normalizing for write", () => {
    const body = canonicalRoadmap.replace(
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->",
      "- [2026-05] LA trip candidate  <!-- id: rm-20260419-111111 -->",
    );

    const normalized = normalizeRoadmapForWrite(body, {
      today: "2026-04-19",
      defaultLongTermPlanSource: "manual",
    });

    expect(normalized.content).toContain("Source: manual 2026-04-19");
    expect(normalized.warnings).toEqual([
      "line 9: Long-term Plans entry normalized with missing schema fields",
    ]);
  });

  it("rejects bodies that do not start with the roadmap heading", () => {
    const result = validateRoadmap(canonicalRoadmap.replace("# Roadmap", "# Notes"));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("must start");
  });

  it("rejects bodies without a Last synced line", () => {
    const result = validateRoadmap("# Roadmap");
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("line 2");
  });

  it("rejects missing Last synced", () => {
    const body = canonicalRoadmap.replace("> Last synced: 2026-04-20\n", "");
    const result = validateRoadmap(normalizeRoadmapForWrite(body).content);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("line 2");
  });

  it("rejects malformed Last synced lines", () => {
    const body = [
      "# Roadmap",
      "> Last synced: not-a-date",
      "",
      "## Annual Goals",
      "",
      "## Quarterly Focus",
      "",
      "## Long-term Plans",
      "",
      "## Agent Action Plan",
      "",
      "## Recurring",
      "",
    ].join("\n");

    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("line 2");
  });

  it("rejects missing required sections", () => {
    const body = canonicalRoadmap.replace("## Recurring\n- Every Friday: weekly review\n", "");
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Missing required section `## Recurring`");
  });

  it("rejects malformed Long-term Plans bullets", () => {
    const body = canonicalRoadmap.replace(
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0",
      "- [soon] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Invalid horizon tag");
  });

  it("rejects non-canonical Long-term Plans lines during validation", () => {
    const body = canonicalRoadmap.replace(
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->",
      "- [2026-Q3] US study prep  <!-- id: rm-20260419-111111 -->",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("not in canonical schema");
  });

  it("rejects Long-term Plans lines missing ids once any managed id exists", () => {
    const body = canonicalRoadmap.replace(
      "  <!-- id: rm-20260419-111111 -->",
      "",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Long-term Plans line is missing roadmap id marker");
  });

  it("rejects a Long-term Plans header that only matches after trimming", () => {
    const body = canonicalRoadmap.replace("## Long-term Plans", "## Long-term Plans ");
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Missing `## Long-term Plans` section");
  });

  it("rejects an Agent Action Plan header that only matches after trimming", () => {
    const body = canonicalRoadmap.replace("## Agent Action Plan", "## Agent Action Plan ");
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Missing `## Agent Action Plan` section");
  });

  it("rejects malformed Long-term Plans id comments", () => {
    const body = canonicalRoadmap.replace(
      "rm-20260419-111111",
      "not-an-id",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Malformed roadmap id marker");
  });

  it("rejects Scheduled entries without task ids", () => {
    const body = canonicalRoadmap.replace(
      "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->",
      "### Scheduled: Call mom next week  <!-- id: rm-20260419-b8e7d4 -->",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Malformed Agent Action Plan heading");
  });

  it("rejects unknown Preparation Timeline tags", () => {
    const body = canonicalRoadmap.replace("[notify]", "[foo]");
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Malformed Preparation Timeline row");
  });

  // The bare "Malformed Preparation Timeline row" message gives the
  // agent zero signal about which part of the row was wrong, so a
  // roadmap_refresh session retries the PUT until it times out. The
  // enriched message must carry both the expected shape and the
  // verbatim received line so the agent self-corrects on the next turn.
  it("malformed Preparation Timeline error carries expected shape + received line", () => {
    const body = canonicalRoadmap.replace("[notify]", "[foo]");
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    const message = result.error?.message ?? "";
    expect(message).toContain("[notify|today|check|schedule]");
    expect(message).toContain("Received:");
    expect(message).toContain("[foo]");
  });

  it("truncates pathologically long Preparation Timeline rows in the error", () => {
    const longTail = "x".repeat(400);
    const malformed = `- not a real timeline row ${longTail}`;
    const body = canonicalRoadmap.replace(
      "- 2026-04-20 [notify] [provisional — confirm with user]: Start ESTA prep",
      malformed,
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    const message = result.error?.message ?? "";
    expect(message).toContain("Malformed Preparation Timeline row");
    expect(message).toContain("…");
    expect(message).not.toContain(longTail);
  });

  it("rejects invalid ReviewCount values", () => {
    const body = canonicalRoadmap.replace("ReviewCount: 0", "ReviewCount: 4");
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("ReviewCount");
  });

  it("accepts user-authored extra sections beyond the required five", () => {
    const body = canonicalRoadmap.replace(
      "## Recurring",
      "## Notes\n- Personal scratchpad.\n\n## Recurring",
    );
    expect(validateRoadmap(body).ok).toBe(true);
  });

  it("rejects a body where the required sections appear out of order", () => {
    const body = canonicalRoadmap.replace(
      "## Long-term Plans\n- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->\n",
      "",
    ).replace(
      "## Recurring",
      "## Long-term Plans\n- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->\n\n## Recurring",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Required sections must appear in this order/);
  });

  it("rejects an event AAP entry whose next line is not `Source:`", () => {
    const body = canonicalRoadmap.replace(
      "### 2026-05-10 ~ 05-15: LA Trip  <!-- id: rm-20260419-a3f1c2 -->\nSource: Travel Bookings",
      "### 2026-05-10 ~ 05-15: LA Trip  <!-- id: rm-20260419-a3f1c2 -->\nDestination: Los Angeles, CA",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/require `Source:` on the next line/);
  });

  it("rejects an event AAP entry at section end without a source line", () => {
    const body = canonicalRoadmap.replace(
      [
        "### 2026-05-10 ~ 05-15: LA Trip  <!-- id: rm-20260419-a3f1c2 -->",
        "Source: Travel Bookings",
        "Destination: Los Angeles, CA",
        "",
        "**Preparation Timeline:**",
        "- 2026-04-20 [notify] [provisional — confirm with user]: Start ESTA prep",
        "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel",
        "",
        "**Agent Notes:**",
        "- Booking found.",
        "",
        "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->",
        "Source: scheduled.task — wake-up 2026-04-22 09:00",
        "Status: ⏳ pending",
        "",
        "## Recurring",
      ].join("\n"),
      [
        "### 2026-05-10: LA Trip  <!-- id: rm-20260419-a3f1c2 -->",
        "## Recurring",
      ].join("\n"),
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/require `Source:` on the next line/);
  });

  it("rejects a scheduled AAP entry whose next line does not match the scheduled.task shape", () => {
    const body = canonicalRoadmap.replace(
      "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->\nSource: scheduled.task — wake-up 2026-04-22 09:00",
      "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->\nSource: something else",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Scheduled entries require/);
  });

  it("rejects a scheduled AAP entry at section end without a source line", () => {
    const body = canonicalRoadmap.replace(
      [
        "### 2026-05-10 ~ 05-15: LA Trip  <!-- id: rm-20260419-a3f1c2 -->",
        "Source: Travel Bookings",
        "Destination: Los Angeles, CA",
        "",
        "**Preparation Timeline:**",
        "- 2026-04-20 [notify] [provisional — confirm with user]: Start ESTA prep",
        "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel",
        "",
        "**Agent Notes:**",
        "- Booking found.",
        "",
        "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->",
        "Source: scheduled.task — wake-up 2026-04-22 09:00",
        "Status: ⏳ pending",
        "",
        "## Recurring",
      ].join("\n"),
      [
        "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->",
        "## Recurring",
      ].join("\n"),
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Scheduled entries require/);
  });

  it("ignores a Preparation Timeline marker when it appears before any AAP heading", () => {
    const body = canonicalRoadmap.replace(
      "## Agent Action Plan\n",
      "## Agent Action Plan\n**Preparation Timeline:**\n- not a managed row\n\n",
    );
    expect(validateRoadmap(body).ok).toBe(true);
  });

  it("accepts bodies without any id markers", () => {
    const body = canonicalRoadmap.replace(/\s+<!-- id: rm-\d{8}-[a-f0-9]{6} -->/g, "");
    const result = validateRoadmap(body);
    expect(result.ok).toBe(true);
  });

  it("rejects missing ids once the roadmap has id markers", () => {
    const body = canonicalRoadmap.replace(
      "  <!-- id: rm-20260419-b8e7d4 -->",
      "",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("missing roadmap id marker");
  });

  it("rejects duplicate ids", () => {
    const body = canonicalRoadmap.replace(
      "rm-20260419-b8e7d4",
      "rm-20260419-a3f1c2",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Duplicate roadmap entry id");
  });

  it("rejects malformed id comments", () => {
    const body = canonicalRoadmap.replace(
      "rm-20260419-b8e7d4",
      "not-an-id",
    );
    const result = validateRoadmap(body);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Malformed roadmap id marker");
  });

  it("does not treat comments in user-authored sections as roadmap entry ids", () => {
    const bodyWithUserComment = canonicalRoadmap
      .replace(/\s+<!-- id: rm-\d{8}-[a-f0-9]{6} -->/g, "")
      .replace(
        "## Annual Goals",
        "## Annual Goals\n- User note <!-- id: not-a-roadmap-entry -->",
      );
    const result = validateRoadmap(bodyWithUserComment);
    expect(result.ok).toBe(true);
  });

  it("transition guard accepts unchanged completed rows", () => {
    const result = validateRoadmapTransition(canonicalRoadmap, canonicalRoadmap, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(true);
  });

  it("transition guard rejects dropped completed rows for surviving entries", () => {
    const next = canonicalRoadmap.replace(
      "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel\n",
      "",
    );
    const result = validateRoadmapTransition(canonicalRoadmap, next, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Completed Preparation Timeline row");
  });

  it("transition guard accepts event removal outside the retention window", () => {
    const previous = canonicalRoadmap.replace(
      "### 2026-05-10 ~ 05-15: LA Trip",
      "### 2026-04-01: LA Trip",
    );
    const next = previous.replace(
      [
        "### 2026-04-01: LA Trip  <!-- id: rm-20260419-a3f1c2 -->",
        "Source: Travel Bookings",
        "Destination: Los Angeles, CA",
        "",
        "**Preparation Timeline:**",
        "- 2026-04-20 [notify] [provisional — confirm with user]: Start ESTA prep",
        "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel",
        "",
        "**Agent Notes:**",
        "- Booking found.",
        "",
      ].join("\n"),
      "",
    );

    const result = validateRoadmapTransition(previous, next, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(true);
  });

  it("transition guard accepts future event removal beyond the planning horizon", () => {
    const previous = canonicalRoadmap.replace(
      "### 2026-05-10 ~ 05-15: LA Trip",
      "### 2026-12-31: Far Future Trip",
    );
    const next = previous.replace(
      [
        "### 2026-12-31: Far Future Trip  <!-- id: rm-20260419-a3f1c2 -->",
        "Source: Travel Bookings",
        "Destination: Los Angeles, CA",
        "",
        "**Preparation Timeline:**",
        "- 2026-04-20 [notify] [provisional — confirm with user]: Start ESTA prep",
        "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel",
        "",
        "**Agent Notes:**",
        "- Booking found.",
        "",
      ].join("\n"),
      "",
    );

    const result = validateRoadmapTransition(previous, next, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(true);
  });

  it("transition guard rejects event removal inside the retention window", () => {
    const next = canonicalRoadmap.replace(
      [
        "### 2026-05-10 ~ 05-15: LA Trip  <!-- id: rm-20260419-a3f1c2 -->",
        "Source: Travel Bookings",
        "Destination: Los Angeles, CA",
        "",
        "**Preparation Timeline:**",
        "- 2026-04-20 [notify] [provisional — confirm with user]: Start ESTA prep",
        "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel",
        "",
        "**Agent Notes:**",
        "- Booking found.",
        "",
      ].join("\n"),
      "",
    );

    const result = validateRoadmapTransition(canonicalRoadmap, next, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("was removed before its retention window");
  });

  it("transition guard accepts old completed scheduled task removal", () => {
    const previous = canonicalRoadmap.replace(
      "Source: scheduled.task — wake-up 2026-04-22 09:00\nStatus: ⏳ pending",
      "Source: scheduled.task — wake-up 2026-04-19 09:00\nStatus: completed 2026-04-19",
    );
    const next = previous.replace(
      [
        "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->",
        "Source: scheduled.task — wake-up 2026-04-19 09:00",
        "Status: completed 2026-04-19",
        "",
      ].join("\n"),
      "",
    );

    const result = validateRoadmapTransition(previous, next, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(true);
  });

  it("transition guard accepts old failed scheduled task removal", () => {
    const previous = canonicalRoadmap.replace(
      "Source: scheduled.task — wake-up 2026-04-22 09:00\nStatus: ⏳ pending",
      "Source: scheduled.task — wake-up 2026-04-19 09:00\nStatus: failed 2026-04-19",
    );
    const next = previous.replace(
      [
        "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->",
        "Source: scheduled.task — wake-up 2026-04-19 09:00",
        "Status: failed 2026-04-19",
        "",
      ].join("\n"),
      "",
    );

    const result = validateRoadmapTransition(previous, next, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(true);
  });

  it("transition guard rejects pending scheduled task removal", () => {
    const next = canonicalRoadmap.replace(
      [
        "### Scheduled: Call mom next week  (task #42)  <!-- id: rm-20260419-b8e7d4 -->",
        "Source: scheduled.task — wake-up 2026-04-22 09:00",
        "Status: ⏳ pending",
        "",
      ].join("\n"),
      "",
    );

    const result = validateRoadmapTransition(canonicalRoadmap, next, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("was removed before its retention window");
  });

  it("transition guard rejects long-term plan removal", () => {
    const next = canonicalRoadmap.replace(
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->\n",
      "",
    );

    const result = validateRoadmapTransition(canonicalRoadmap, next, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("was removed before its retention window");
  });

  it("transition guard ignores entries without ids", () => {
    const body = canonicalRoadmap.replace(/\s+<!-- id: rm-\d{8}-[a-f0-9]{6} -->/g, "");
    const result = validateRoadmapTransition(body, "# Roadmap", {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(true);
  });

  it("transition guard handles bodies without managed sections", () => {
    const result = validateRoadmapTransition("# Roadmap\n", "# Roadmap\n", {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(true);
  });

  it("transition guard handles Agent Action Plan entries with missing source lines", () => {
    const previous = [
      "# Roadmap",
      "## Long-term Plans",
      "",
      "## Agent Action Plan",
      "",
      "### 2026-05-10: LA Trip  <!-- id: rm-20260419-a3f1c2 -->",
      "",
    ].join("\n");

    const result = validateRoadmapTransition(previous, previous, {
      today: "2026-04-21",
    });
    expect(result.ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  appendRoadmapIdComment,
  extractRoadmapIdFromLine,
  extractRoadmapIds,
  findDuplicateRoadmapId,
  findMalformedRoadmapIdComment,
  generateRoadmapId,
  hasMalformedRoadmapIdComment,
  isRoadmapId,
  looksFabricatedRoadmapId,
  RoadmapIdGenerationError,
  stripRoadmapIdComment,
} from "./roadmap-ids.js";

describe("roadmap id helpers", () => {
  it("classifies valid and invalid ids", () => {
    expect(isRoadmapId("rm-20260419-a3f1c2")).toBe(true);
    expect(isRoadmapId("rm-20260419-A3F1C2")).toBe(false);
    expect(isRoadmapId("not-an-id")).toBe(false);
  });

  it("generates ids in rm-YYYYMMDD-6hex format", () => {
    const id = generateRoadmapId({
      creationDate: "2026-04-19",
      randomBytes: () => Buffer.from([0xa3, 0xf1, 0xc2]),
    });
    expect(id).toBe("rm-20260419-a3f1c2");
  });

  it("extracts ids from headings and bullets", () => {
    const body = [
      "### 2026-05-10: LA Trip  <!-- id: rm-20260419-a3f1c2 -->",
      "- [2026-05] LA trip — Source: dm 2026-04-19 — Review: 2026-04-20 — ReviewCount: 0  <!-- id: rm-20260419-b8e7d4 -->",
    ].join("\n");

    expect(extractRoadmapIdFromLine(body.split("\n")[0])).toBe(
      "rm-20260419-a3f1c2",
    );
    expect(extractRoadmapIds(body).map((ref) => ref.id)).toEqual([
      "rm-20260419-a3f1c2",
      "rm-20260419-b8e7d4",
    ]);
    expect(extractRoadmapIdFromLine("### Heading")).toBeNull();
  });

  it("appends an id comment after stripping any existing id marker", () => {
    expect(
      appendRoadmapIdComment(
        "### 2026-05-10: LA Trip  <!-- id: rm-20260419-000000 -->",
        "rm-20260419-a3f1c2",
      ),
    ).toBe("### 2026-05-10: LA Trip  <!-- id: rm-20260419-a3f1c2 -->");
  });

  it("strips valid and malformed roadmap id comments from line endings", () => {
    expect(stripRoadmapIdComment(
      "### Heading  <!-- id: rm-20260419-a3f1c2 -->  ",
    )).toEqual({
      line: "### Heading",
      id: "rm-20260419-a3f1c2",
    });
    expect(stripRoadmapIdComment("### Heading")).toEqual({
      line: "### Heading",
      id: null,
    });
    expect(stripRoadmapIdComment("### Heading  <!-- id: not-an-id -->")).toEqual({
      line: "### Heading",
      id: null,
    });
  });

  it("rejects invalid ids when appending comments", () => {
    expect(() => appendRoadmapIdComment("### Heading", "not-an-id")).toThrow(
      "Invalid roadmap id",
    );
  });

  it("finds duplicate roadmap ids and reports first and duplicate lines", () => {
    const body = [
      "### First  <!-- id: rm-20260419-a3f1c2 -->",
      "### Other  <!-- id: rm-20260419-b8e7d4 -->",
      "### Duplicate  <!-- id: rm-20260419-a3f1c2 -->",
    ].join("\n");
    expect(findDuplicateRoadmapId(body)).toEqual({
      id: "rm-20260419-a3f1c2",
      firstLine: 1,
      duplicateLine: 3,
    });
    expect(findDuplicateRoadmapId("### First  <!-- id: rm-20260419-a3f1c2 -->")).toBeNull();
  });

  it("finds malformed roadmap id comments", () => {
    const body = [
      "### First  <!-- id: rm-20260419-a3f1c2 -->",
      "### Broken  <!-- id: not-an-id -->",
    ].join("\n");
    expect(hasMalformedRoadmapIdComment("### Broken  <!-- id: not-an-id -->")).toBe(true);
    expect(hasMalformedRoadmapIdComment("### Plain")).toBe(false);
    expect(findMalformedRoadmapIdComment(body)).toEqual({
      line: 2,
      text: "### Broken  <!-- id: not-an-id -->",
    });
    expect(findMalformedRoadmapIdComment("### Plain")).toBeNull();
  });

  it("retries collisions and fails after the attempt cap", () => {
    expect(() =>
      generateRoadmapId({
        creationDate: "2026-04-19",
        existingIds: ["rm-20260419-a3f1c2"],
        randomBytes: () => Buffer.from([0xa3, 0xf1, 0xc2]),
        maxAttempts: 2,
      }),
    ).toThrow(RoadmapIdGenerationError);
  });

  it("uses secure random bytes by default", () => {
    expect(generateRoadmapId({ creationDate: "2026-04-19" })).toMatch(
      /^rm-20260419-[a-f0-9]{6}$/,
    );
  });

  it("rejects invalid creation dates", () => {
    expect(() =>
      generateRoadmapId({
        creationDate: "2026-99-99",
        randomBytes: () => Buffer.from([0xa3, 0xf1, 0xc2]),
      }),
    ).toThrow("Invalid roadmap id creation date");
    expect(() =>
      generateRoadmapId({
        creationDate: "20260419",
        randomBytes: () => Buffer.from([0xa3, 0xf1, 0xc2]),
      }),
    ).toThrow("Invalid roadmap id creation date");
  });

  describe("looksFabricatedRoadmapId", () => {
    // Verbatim Sonnet fabrications observed in roadmap.md after the
    // 2026-04-28 incident (POST /context/roadmap/id 401 spiral).
    it.each([
      ["1a2b3c", true],
      ["4d5e6f", true],
      ["9a0b1c", true],
      ["0d1e2f", true],
      ["6d7e8f", true],
      ["7a8b9c", true],
      ["3a4b5c", true],
    ])("flags Sonnet's digit-letter alternation pattern: %s", (suffix, expected) => {
      expect(looksFabricatedRoadmapId(`rm-20260428-${suffix}`)).toBe(expected);
    });

    // Real daemon-minted suffixes (3 random bytes, hex-encoded). The
    // heuristic should NOT flag these even though some happen to
    // include both digits and letters.
    it.each([
      ["17dc8d", false],
      ["28609a", false],
      ["a23f71", false],
      ["c62b36", false],
      ["31a6bd", false],
      ["ea5cfa", false],
      ["aaaaaa", false], // all-letter suffix
      ["111111", false], // all-digit suffix
      ["a0b1c2", false], // letter-first alternation (different shape)
    ])("does not flag random / non-alternation suffix: %s", (suffix, expected) => {
      expect(looksFabricatedRoadmapId(`rm-20260428-${suffix}`)).toBe(expected);
    });

    it("returns false for malformed roadmap ids (defensive)", () => {
      expect(looksFabricatedRoadmapId("not-an-id")).toBe(false);
      expect(looksFabricatedRoadmapId("rm-20260428-1a2b3")).toBe(false); // 5 chars
      expect(looksFabricatedRoadmapId("rm-20260428-1a2b3cd")).toBe(false); // 7 chars
      expect(looksFabricatedRoadmapId("rm-2026-1a2b3c")).toBe(false); // bad date
      expect(looksFabricatedRoadmapId("")).toBe(false);
    });
  });
});

import { describe, expect, it } from "vitest";

import type { LessonStore } from "@/lib/api-types";
import {
  capLevel,
  capPercent,
  storeCapLevel,
  storeStatusLine,
  storeTitle,
} from "./lessons.logic";

function store(over: Partial<LessonStore>): LessonStore {
  return {
    scope: "agent",
    path: "policies/agent-lessons.md",
    exists: true,
    lastModified: "2026-06-07T00:00:00.000Z",
    bytes: 100,
    capBytes: 8192,
    entries: 3,
    maxEntries: 40,
    active: 3,
    provisional: 0,
    overCap: false,
    ...over,
  };
}

describe("lessons.logic", () => {
  describe("capPercent", () => {
    it("rounds and clamps to [0, 100]", () => {
      expect(capPercent(50, 100)).toBe(50);
      expect(capPercent(8192, 8192)).toBe(100);
      expect(capPercent(9000, 8192)).toBe(100);
      expect(capPercent(1, 3)).toBe(33);
    });
    it("returns 0 for a non-positive cap", () => {
      expect(capPercent(10, 0)).toBe(0);
      expect(capPercent(10, -5)).toBe(0);
    });
  });

  describe("capLevel", () => {
    it("buckets by severity threshold", () => {
      expect(capLevel(0)).toBe("ok");
      expect(capLevel(79)).toBe("ok");
      expect(capLevel(80)).toBe("warn");
      expect(capLevel(99)).toBe("warn");
      expect(capLevel(100)).toBe("full");
    });
  });

  describe("storeCapLevel", () => {
    it("is ok well under both caps", () => {
      expect(storeCapLevel(store({}))).toBe("ok");
    });
    it("warns when bytes approach the byte cap", () => {
      expect(storeCapLevel(store({ bytes: 7000, capBytes: 8192 }))).toBe("warn");
    });
    it("warns when entries approach the entry cap", () => {
      expect(storeCapLevel(store({ entries: 36, maxEntries: 40 }))).toBe("warn");
    });
    it("reports full when the daemon flags overCap even if percents round under 100", () => {
      expect(
        storeCapLevel(store({ bytes: 50, capBytes: 8192, overCap: true })),
      ).toBe("full");
    });
    it("takes the worse of the two cap levels", () => {
      expect(
        storeCapLevel(store({ bytes: 50, capBytes: 8192, entries: 41, maxEntries: 40 })),
      ).toBe("full");
    });
  });

  describe("storeTitle", () => {
    it("labels the global scope", () => {
      expect(storeTitle("agent")).toBe("Global — all agents & routines");
    });
    it("strips the agent: prefix for a per-agent scope", () => {
      expect(storeTitle("agent:report-writer")).toBe("report-writer");
    });
    it("passes through an unknown scope unchanged", () => {
      expect(storeTitle("channel:slack")).toBe("channel:slack");
    });
  });

  describe("storeStatusLine", () => {
    it("notes a not-yet-created store", () => {
      expect(storeStatusLine(store({ exists: false }))).toContain("Not created");
    });
    it("summarises active + provisional + bytes", () => {
      const line = storeStatusLine(store({ active: 3, provisional: 1, bytes: 200 }));
      expect(line).toContain("3 active");
      expect(line).toContain("1 provisional");
      expect(line).toContain("200/8192 B");
    });
    it("omits provisional when none and flags over cap", () => {
      const line = storeStatusLine(
        store({ active: 5, provisional: 0, overCap: true }),
      );
      expect(line).not.toContain("provisional");
      expect(line).toContain("over cap");
    });
  });
});

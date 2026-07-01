import { describe, it, expect } from "vitest";
import { parseTaskRef, formatTaskRef, ownerRouteForRef } from "./refs.js";
import type { TaskRef } from "./types.js";

describe("parseTaskRef", () => {
  it("parses colon-form refs with numeric ids", () => {
    expect(parseTaskRef("rs:42")).toEqual({ prefix: "rs", id: "42", raw: "rs:42" });
    expect(parseTaskRef("as:8190")).toEqual({ prefix: "as", id: "8190", raw: "as:8190" });
    expect(parseTaskRef("trigger:9")).toEqual({ prefix: "trigger", id: "9", raw: "trigger:9" });
  });

  it("parses slug + uuid refs", () => {
    expect(parseTaskRef("agent:weekly-digest")).toEqual({
      prefix: "agent",
      id: "weekly-digest",
      raw: "agent:weekly-digest",
    });
    expect(parseTaskRef("cluster:flights-jun")).toEqual({
      prefix: "cluster",
      id: "flights-jun",
      raw: "cluster:flights-jun",
    });
    expect(parseTaskRef("bt:9f8c1a2b-uuid")).toEqual({
      prefix: "bt",
      id: "9f8c1a2b-uuid",
      raw: "bt:9f8c1a2b-uuid",
    });
    expect(parseTaskRef("bx:abc.def")).toEqual({ prefix: "bx", id: "abc.def", raw: "bx:abc.def" });
    expect(parseTaskRef("obj:o1")).toEqual({ prefix: "obj", id: "o1", raw: "obj:o1" });
  });

  it("parses the literal managed-task id `mt_<n>`", () => {
    expect(parseTaskRef("mt_3")).toEqual({ prefix: "mt", id: "mt_3", raw: "mt_3" });
    expect(parseTaskRef("  mt_42  ")).toEqual({ prefix: "mt", id: "mt_42", raw: "mt_42" });
  });

  it("normalises the colon form `mt:<n>` to `mt_<n>`", () => {
    expect(parseTaskRef("mt:7")).toEqual({ prefix: "mt", id: "mt_7", raw: "mt_7" });
  });

  it("rejects a non-numeric mt colon id", () => {
    expect(parseTaskRef("mt:abc")).toBeNull();
  });

  it("rejects malformed / unknown / unsafe refs", () => {
    expect(parseTaskRef("")).toBeNull();
    expect(parseTaskRef("   ")).toBeNull();
    expect(parseTaskRef("rs")).toBeNull(); // no colon
    expect(parseTaskRef(":42")).toBeNull(); // colon at position 0
    expect(parseTaskRef("bogus:1")).toBeNull(); // unknown prefix
    expect(parseTaskRef("rs:abc")).toBeNull(); // numeric prefix needs digits
    expect(parseTaskRef("trigger:abc")).toBeNull(); // numeric prefix needs digits
    expect(parseTaskRef("agent:")).toBeNull(); // empty id
    expect(parseTaskRef("agent:a/b")).toBeNull(); // path separator
    expect(parseTaskRef("agent:..")).toBeNull(); // traversal
    expect(parseTaskRef("cluster:a b")).toBeNull(); // whitespace in token
  });
});

describe("formatTaskRef", () => {
  it("builds colon-form refs", () => {
    expect(formatTaskRef("rs", 42)).toBe("rs:42");
    expect(formatTaskRef("agent", "weekly-digest")).toBe("agent:weekly-digest");
    expect(formatTaskRef("as", 8190)).toBe("as:8190");
  });

  it("builds the `mt_<n>` form from a number or the full id", () => {
    expect(formatTaskRef("mt", 3)).toBe("mt_3");
    expect(formatTaskRef("mt", "mt_3")).toBe("mt_3");
    expect(formatTaskRef("mt", "5")).toBe("mt_5");
  });

  it("round-trips with parseTaskRef", () => {
    for (const raw of ["rs:1", "mt_9", "agent:x", "as:2", "cluster:c", "bt:u", "bx:v", "trigger:9", "obj:o"]) {
      const parsed = parseTaskRef(raw) as TaskRef;
      expect(formatTaskRef(parsed.prefix, parsed.id)).toBe(parsed.raw);
    }
  });
});

describe("ownerRouteForRef", () => {
  it("resolves per-row owner routes for writable prefixes", () => {
    expect(ownerRouteForRef(parseTaskRef("rs:42") as TaskRef)).toBe("/api/recurring-schedules/42");
    expect(ownerRouteForRef(parseTaskRef("mt_3") as TaskRef)).toBe("/api/managed-tasks/mt_3");
    expect(ownerRouteForRef(parseTaskRef("agent:wd") as TaskRef)).toBe("/api/agents/wd");
    expect(ownerRouteForRef(parseTaskRef("as:8") as TaskRef)).toBe("/api/schedule/8");
    expect(ownerRouteForRef(parseTaskRef("bt:u") as TaskRef)).toBe("/api/background-task/u");
    expect(ownerRouteForRef(parseTaskRef("bx:v") as TaskRef)).toBe("/api/browser-task/v");
    expect(ownerRouteForRef(parseTaskRef("trigger:9") as TaskRef)).toBe("/api/triggers/9");
  });

  it("returns null for read-only / reserved prefixes", () => {
    expect(ownerRouteForRef(parseTaskRef("cluster:c") as TaskRef)).toBeNull();
    expect(ownerRouteForRef(parseTaskRef("obj:o") as TaskRef)).toBeNull();
  });
});

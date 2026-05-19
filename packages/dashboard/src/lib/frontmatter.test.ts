import { describe, expect, it } from "vitest";
import { extractFrontmatter, inferKind } from "./frontmatter.js";

describe("extractFrontmatter", () => {
  it("returns null when content has no frontmatter", () => {
    expect(extractFrontmatter("# hello")).toBeNull();
    expect(extractFrontmatter("")).toBeNull();
    expect(extractFrontmatter("---\nno closing")).toBeNull();
  });

  it("returns null when block is empty", () => {
    expect(extractFrontmatter("---\n---\nbody")).toBeNull();
  });

  it("parses a typical agent daily note frontmatter", () => {
    const content = [
      "---",
      "date: 2026-04-19",
      "weekday: Sunday",
      "type: daily",
      "agent_generated: true",
      "agent_last_synced_at: 2026-04-20T14:25:00Z",
      'content_hash: ""',
      'projects: ["408019"]',
      "people: []",
      'tags: ["study", "deadline"]',
      "calendar_events: 1",
      "messages_handled: 2",
      "---",
      "",
      "# 2026-04-19 (Sunday)",
      "",
      "body text",
    ].join("\n");

    const result = extractFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.body).toContain("# 2026-04-19 (Sunday)");
    expect(result!.body).toContain("body text");

    const map = Object.fromEntries(result!.fields.map((f) => [f.key, f.value]));
    expect(map.date).toBe("2026-04-19");
    expect(map.weekday).toBe("Sunday");
    expect(map.type).toBe("daily");
    expect(map.agent_generated).toBe(true);
    expect(map.agent_last_synced_at).toBe("2026-04-20T14:25:00Z");
    expect(map.content_hash).toBe("");
    expect(map.projects).toEqual(["408019"]);
    expect(map.people).toEqual([]);
    expect(map.tags).toEqual(["study", "deadline"]);
    expect(map.calendar_events).toBe(1);
    expect(map.messages_handled).toBe(2);
  });

  it("preserves order of fields", () => {
    const content = "---\nb: 2\na: 1\nc: 3\n---\n";
    const result = extractFrontmatter(content);
    expect(result!.fields.map((f) => f.key)).toEqual(["b", "a", "c"]);
  });

  it("parses block-style list", () => {
    const content = [
      "---",
      "tags:",
      "  - study",
      "  - deadline",
      "name: foo",
      "---",
      "",
    ].join("\n");
    const result = extractFrontmatter(content);
    const map = Object.fromEntries(result!.fields.map((f) => [f.key, f.value]));
    expect(map.tags).toEqual(["study", "deadline"]);
    expect(map.name).toBe("foo");
  });

  it("parses unindented block-style list", () => {
    const content = [
      "---",
      "tags:",
      "- study",
      "- deadline",
      "---",
      "",
    ].join("\n");
    const result = extractFrontmatter(content);
    const map = Object.fromEntries(result!.fields.map((f) => [f.key, f.value]));
    expect(map.tags).toEqual(["study", "deadline"]);
  });

  it("parses quoted strings and strips quotes", () => {
    const content = `---\ntitle: "Hello, world"\nalt: 'single'\n---\n`;
    const result = extractFrontmatter(content);
    const map = Object.fromEntries(result!.fields.map((f) => [f.key, f.value]));
    expect(map.title).toBe("Hello, world");
    expect(map.alt).toBe("single");
  });

  it("handles CRLF line endings", () => {
    const content = "---\r\nname: foo\r\nvalue: 1\r\n---\r\nbody";
    const result = extractFrontmatter(content);
    expect(result).not.toBeNull();
    const map = Object.fromEntries(result!.fields.map((f) => [f.key, f.value]));
    expect(map.name).toBe("foo");
    expect(map.value).toBe(1);
    expect(result!.body).toBe("body");
  });

  it("parses negative and decimal numbers", () => {
    const content = "---\na: -5\nb: 3.14\nc: -0.5\n---\n";
    const result = extractFrontmatter(content);
    const map = Object.fromEntries(result!.fields.map((f) => [f.key, f.value]));
    expect(map.a).toBe(-5);
    expect(map.b).toBeCloseTo(3.14);
    expect(map.c).toBeCloseTo(-0.5);
  });

  it("parses null indicators", () => {
    const content = "---\nempty1: null\nempty2: ~\n---\n";
    const result = extractFrontmatter(content);
    const map = Object.fromEntries(result!.fields.map((f) => [f.key, f.value]));
    expect(map.empty1).toBeNull();
    expect(map.empty2).toBeNull();
  });

  it("does not treat values inside quoted strings as array delimiters", () => {
    const content = `---\ntags: ["a, b", "c"]\n---\n`;
    const result = extractFrontmatter(content);
    const map = Object.fromEntries(result!.fields.map((f) => [f.key, f.value]));
    expect(map.tags).toEqual(["a, b", "c"]);
  });
});

describe("inferKind", () => {
  it("classifies strings by ISO-ness", () => {
    expect(inferKind("2026-04-19")).toBe("date");
    expect(inferKind("2026-04-20T14:25:00Z")).toBe("datetime");
    expect(inferKind("2026-04-20T14:25:00+09:00")).toBe("datetime");
    expect(inferKind("2026-04-20T14:25:00")).toBe("datetime");
    expect(inferKind("Sunday")).toBe("text");
  });

  it("classifies primitives", () => {
    expect(inferKind(true)).toBe("boolean");
    expect(inferKind(42)).toBe("number");
    expect(inferKind([])).toBe("list");
    expect(inferKind(["a"])).toBe("list");
    expect(inferKind(null)).toBe("empty");
    expect(inferKind("")).toBe("empty");
  });
});

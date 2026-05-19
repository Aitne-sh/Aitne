import { describe, it, expect } from "vitest";
import {
  DEFAULT_AGENT_DISPLAY_NAME,
  normalizeAgentDisplayName,
  validateAgentDisplayName,
  formatAgentOutboundLabel,
} from "./agent-identity.js";

describe("normalizeAgentDisplayName", () => {
  it("returns default for null/undefined/empty", () => {
    expect(normalizeAgentDisplayName(null)).toBe(DEFAULT_AGENT_DISPLAY_NAME);
    expect(normalizeAgentDisplayName(undefined)).toBe(DEFAULT_AGENT_DISPLAY_NAME);
    expect(normalizeAgentDisplayName("")).toBe(DEFAULT_AGENT_DISPLAY_NAME);
    expect(normalizeAgentDisplayName("   ")).toBe(DEFAULT_AGENT_DISPLAY_NAME);
  });

  it("trims whitespace and collapses internal spaces", () => {
    expect(normalizeAgentDisplayName("  My  Bot  ")).toBe("My Bot");
  });

  it("unwraps bracket-enclosed names", () => {
    expect(normalizeAgentDisplayName("[Agent]")).toBe("Agent");
    expect(normalizeAgentDisplayName("[ Agent ]")).toBe("Agent");
  });

  it("does not unwrap partial brackets", () => {
    expect(normalizeAgentDisplayName("[Agent")).toBe("[Agent");
    expect(normalizeAgentDisplayName("Agent]")).toBe("Agent]");
  });

  it("returns default if brackets contain only whitespace", () => {
    expect(normalizeAgentDisplayName("[  ]")).toBe(DEFAULT_AGENT_DISPLAY_NAME);
  });
});

describe("validateAgentDisplayName", () => {
  it("returns null for valid names", () => {
    expect(validateAgentDisplayName("Bot")).toBeNull();
    expect(validateAgentDisplayName("My Personal Agent")).toBeNull();
  });

  it("rejects names longer than 40 characters", () => {
    expect(validateAgentDisplayName("a".repeat(41))).toMatch(/40 characters/);
  });

  it("rejects names with angle brackets", () => {
    expect(validateAgentDisplayName("Bot<script>")).toMatch(/angle brackets/);
    expect(validateAgentDisplayName("<Agent>")).toMatch(/angle brackets/);
  });

  it("normalizes away newlines before validation", () => {
    // Newlines are collapsed to spaces by normalizeAgentDisplayName,
    // so they never reach the angle-bracket/newline regex check
    expect(validateAgentDisplayName("Bot\nName")).toBeNull();
  });
});

describe("formatAgentOutboundLabel", () => {
  it("wraps the normalized name in brackets", () => {
    expect(formatAgentOutboundLabel("Bot")).toBe("[Bot]");
  });

  it("uses default when name is empty", () => {
    expect(formatAgentOutboundLabel(null)).toBe(`[${DEFAULT_AGENT_DISPLAY_NAME}]`);
  });
});

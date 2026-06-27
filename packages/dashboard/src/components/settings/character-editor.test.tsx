import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CHARACTER_MAX_LENGTH,
  CharacterEditor,
  isCharacterOverCap,
} from "./character-editor";

/**
 * Static-markup smoke tests for the shared CharacterEditor. Exercises
 * counter text + the three color branches (below / at / over cap) and
 * the exported `isCharacterOverCap` predicate.
 */

describe("CharacterEditor — counter", () => {
  it("renders 0/1000 for an empty value", () => {
    const html = renderToStaticMarkup(
      <CharacterEditor value="" onChange={() => {}} />,
    );
    expect(html).toContain("0/1000");
  });

  it("renders N/1000 with muted color below the cap (N=999)", () => {
    const html = renderToStaticMarkup(
      <CharacterEditor value={"x".repeat(999)} onChange={() => {}} />,
    );
    expect(html).toContain("999/1000");
    // Below-cap color is muted-foreground; neither amber nor destructive.
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("text-warning");
    expect(html).not.toContain("text-destructive");
  });

  it("renders N/1000 with amber color exactly at the cap (N=1000)", () => {
    const html = renderToStaticMarkup(
      <CharacterEditor value={"x".repeat(1000)} onChange={() => {}} />,
    );
    expect(html).toContain("1000/1000");
    expect(html).toContain("text-warning");
    expect(html).not.toContain("text-destructive");
  });

  it("renders N/1000 with destructive color over the cap (N=1001)", () => {
    const html = renderToStaticMarkup(
      <CharacterEditor value={"x".repeat(1001)} onChange={() => {}} />,
    );
    expect(html).toContain("1001/1000");
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("text-warning");
  });

  it("renders the textarea with the provided placeholder", () => {
    const html = renderToStaticMarkup(
      <CharacterEditor
        value=""
        onChange={() => {}}
        placeholder="My custom placeholder"
      />,
    );
    expect(html).toContain("My custom placeholder");
  });

  it("exports the cap as a constant matching the server-side 1000-char Zod max", () => {
    expect(CHARACTER_MAX_LENGTH).toBe(1000);
  });
});

describe("isCharacterOverCap", () => {
  it("returns false for empty and below-cap values", () => {
    expect(isCharacterOverCap("")).toBe(false);
    expect(isCharacterOverCap("x".repeat(999))).toBe(false);
  });

  it("returns false exactly at the cap (inclusive)", () => {
    expect(isCharacterOverCap("x".repeat(1000))).toBe(false);
  });

  it("returns true just over the cap", () => {
    expect(isCharacterOverCap("x".repeat(1001))).toBe(true);
  });
});

// Silence an unused-import lint while keeping `vi` available for future
// interactive tests (userEvent pattern) if the dashboard gains jsdom.
void vi;

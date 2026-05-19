import { describe, it, expect } from "vitest";
import {
  AGENT_DISPLAY_NAME_MAX_LENGTH,
  SUPPORTED_LANGUAGES,
  buildBasicsPatchBody,
  canContinue,
  hydrateLanguageSelection,
  isCustomLanguageInvalid,
  resolveLanguage,
} from "./basics-step.logic";

describe("resolveLanguage", () => {
  it("returns the dropdown value for known tags", () => {
    expect(resolveLanguage("en", "")).toBe("en");
    expect(resolveLanguage("ja", "")).toBe("ja");
  });

  it("returns the trimmed custom value when __custom__ is selected", () => {
    expect(resolveLanguage("__custom__", "  zh-Hans  ")).toBe("zh-Hans");
  });

  it("returns an empty string for an empty custom selection", () => {
    expect(resolveLanguage("__custom__", "")).toBe("");
    expect(resolveLanguage("__custom__", "   ")).toBe("");
  });
});

describe("isCustomLanguageInvalid", () => {
  it("is false when a known dropdown tag is selected", () => {
    expect(isCustomLanguageInvalid("en", "garbage")).toBe(false);
  });

  it("is false for an empty custom field (incomplete, not invalid)", () => {
    expect(isCustomLanguageInvalid("__custom__", "")).toBe(false);
  });

  it("rejects a malformed BCP-47 tag", () => {
    expect(isCustomLanguageInvalid("__custom__", "ENGLISH")).toBe(true);
    expect(isCustomLanguageInvalid("__custom__", "1234")).toBe(true);
  });

  it("accepts canonical BCP-47 tags", () => {
    expect(isCustomLanguageInvalid("__custom__", "zh-Hans")).toBe(false);
    expect(isCustomLanguageInvalid("__custom__", "en-US")).toBe(false);
    expect(isCustomLanguageInvalid("__custom__", "pt")).toBe(false);
  });
});

describe("canContinue", () => {
  it("requires a non-empty trimmed agent name", () => {
    expect(
      canContinue({
        agentDisplayName: "",
        resolvedLanguage: "en",
        saving: false,
      }),
    ).toBe(false);
    expect(
      canContinue({
        agentDisplayName: "   ",
        resolvedLanguage: "en",
        saving: false,
      }),
    ).toBe(false);
  });

  it("rejects an agent name longer than the documented max", () => {
    expect(
      canContinue({
        agentDisplayName: "x".repeat(AGENT_DISPLAY_NAME_MAX_LENGTH + 1),
        resolvedLanguage: "en",
        saving: false,
      }),
    ).toBe(false);
  });

  it("requires a valid BCP-47 language tag", () => {
    expect(
      canContinue({
        agentDisplayName: "Aitne",
        resolvedLanguage: "",
        saving: false,
      }),
    ).toBe(false);
    expect(
      canContinue({
        agentDisplayName: "Aitne",
        resolvedLanguage: "ENGLISH",
        saving: false,
      }),
    ).toBe(false);
  });

  it("blocks while a save is in flight", () => {
    expect(
      canContinue({
        agentDisplayName: "Aitne",
        resolvedLanguage: "en",
        saving: true,
      }),
    ).toBe(false);
  });

  it("permits a clean form", () => {
    expect(
      canContinue({
        agentDisplayName: "Aitne",
        resolvedLanguage: "en",
        saving: false,
      }),
    ).toBe(true);
  });
});

describe("buildBasicsPatchBody", () => {
  it("trims the agent name and returns the resolved language", () => {
    expect(
      buildBasicsPatchBody({
        agentDisplayName: "  Aitne  ",
        resolvedLanguage: "en-US",
      }),
    ).toEqual({ agentDisplayName: "Aitne", primaryLanguage: "en-US" });
  });
});

describe("hydrateLanguageSelection", () => {
  it("falls back to en when no language is stored", () => {
    expect(hydrateLanguageSelection(null)).toEqual({ primary: "en", custom: "" });
    expect(hydrateLanguageSelection(undefined)).toEqual({ primary: "en", custom: "" });
    expect(hydrateLanguageSelection("")).toEqual({ primary: "en", custom: "" });
  });

  it("returns the stored tag verbatim when it is in the dropdown", () => {
    expect(hydrateLanguageSelection("ja")).toEqual({ primary: "ja", custom: "" });
  });

  it("routes unknown tags to the custom branch", () => {
    expect(hydrateLanguageSelection("zh-Hans")).toEqual({
      primary: "__custom__",
      custom: "zh-Hans",
    });
  });
});

describe("SUPPORTED_LANGUAGES", () => {
  it("ends with the __custom__ sentinel option", () => {
    const last = SUPPORTED_LANGUAGES[SUPPORTED_LANGUAGES.length - 1];
    expect(last.tag).toBe("__custom__");
  });

  it("starts with English so first-time users see a usable default", () => {
    expect(SUPPORTED_LANGUAGES[0].tag).toBe("en");
  });
});

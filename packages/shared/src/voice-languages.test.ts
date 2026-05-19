import { describe, it, expect } from "vitest";
import {
  VOICE_LANGUAGE_FULL,
  VOICE_LANGUAGE_TOP,
  isSupportedVoiceLanguage,
  localeToVoiceLanguage,
} from "./voice-languages.js";

describe("voice-languages", () => {
  it("includes the languages the user research validated as multilingual", () => {
    const codes = new Set(VOICE_LANGUAGE_FULL.map((l) => l.code));
    for (const expected of ["ja", "en", "zh", "ko", "es", "fr", "de", "ar", "hi"]) {
      expect(codes.has(expected)).toBe(true);
    }
  });

  it("top list is a strict subset of the full list", () => {
    const fullCodes = new Set(VOICE_LANGUAGE_FULL.map((l) => l.code));
    for (const top of VOICE_LANGUAGE_TOP) {
      expect(fullCodes.has(top.code)).toBe(true);
    }
  });

  it("has unique language codes across the full list", () => {
    const codes = VOICE_LANGUAGE_FULL.map((l) => l.code);
    expect(codes.length).toBe(new Set(codes).size);
  });

  it("isSupportedVoiceLanguage accepts known codes and rejects others", () => {
    expect(isSupportedVoiceLanguage("ja")).toBe(true);
    expect(isSupportedVoiceLanguage("en")).toBe(true);
    expect(isSupportedVoiceLanguage("xx")).toBe(false);
    expect(isSupportedVoiceLanguage("")).toBe(false);
    expect(isSupportedVoiceLanguage("JA")).toBe(false);
  });

  describe("localeToVoiceLanguage", () => {
    it("maps BCP-47 tags by primary subtag", () => {
      expect(localeToVoiceLanguage("ja")).toBe("ja");
      expect(localeToVoiceLanguage("ja-JP")).toBe("ja");
      expect(localeToVoiceLanguage("en-US")).toBe("en");
      expect(localeToVoiceLanguage("zh-CN")).toBe("zh");
      // Regional Chinese variants resolve via prefix extraction.
      expect(localeToVoiceLanguage("zh-Hans")).toBe("zh");
      expect(localeToVoiceLanguage("zh-Hant-TW")).toBe("zh");
    });

    it("strips POSIX encoding suffixes and accepts underscores", () => {
      expect(localeToVoiceLanguage("ja_JP.UTF-8")).toBe("ja");
      expect(localeToVoiceLanguage("en_GB.utf8")).toBe("en");
    });

    it("rewrites legacy aliases", () => {
      expect(localeToVoiceLanguage("iw")).toBe("he");
      expect(localeToVoiceLanguage("in_ID")).toBe("id");
      expect(localeToVoiceLanguage("ji")).toBe("yi");
      expect(localeToVoiceLanguage("nb-NO")).toBe("no");
    });

    it("returns null for unsupported locales", () => {
      expect(localeToVoiceLanguage("xx-YY")).toBe(null);
      expect(localeToVoiceLanguage("")).toBe(null);
      expect(localeToVoiceLanguage(null)).toBe(null);
      expect(localeToVoiceLanguage(undefined)).toBe(null);
    });

    it("returns null when the locale's primary subtag extracts to an empty string", () => {
      // Inputs whose dot-then-dash strip yields a zero-length head — the
      // empty-head guard short-circuits before the supportedCodes check.
      expect(localeToVoiceLanguage(".UTF-8")).toBe(null);
      expect(localeToVoiceLanguage("-en")).toBe(null);
    });
  });
});

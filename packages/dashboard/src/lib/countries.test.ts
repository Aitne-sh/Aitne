import { describe, it, expect } from "vitest";
import {
  COUNTRIES,
  composeE164,
  detectCountryFromPhone,
  getCountryByIso2,
  stripDialCode,
} from "./countries";

describe("countries data", () => {
  it("loads a meaningful country list with flags precomputed", () => {
    expect(COUNTRIES.length).toBeGreaterThan(150);
    for (const c of COUNTRIES) {
      expect(c.iso2).toMatch(/^[A-Z]{2}$/);
      expect(c.dial).toMatch(/^\d+$/);
      expect(c.flag).not.toBe("");
      // Flag emoji is two regional-indicator code points → 8 UTF-16 code units.
      expect(Array.from(c.flag).length).toBe(2);
    }
  });

  it("getCountryByIso2 looks up by upper-case ISO2", () => {
    expect(getCountryByIso2("JP")?.dial).toBe("81");
    expect(getCountryByIso2("jp")?.dial).toBe("81");
    expect(getCountryByIso2("US")?.dial).toBe("1");
  });
});

describe("detectCountryFromPhone (longest-prefix match)", () => {
  it("returns the matching country for plain ISO numbers", () => {
    expect(detectCountryFromPhone("+8189...")?.iso2).toBe("JP");
    expect(detectCountryFromPhone("+44 7700 900123")?.iso2).toBe("GB");
  });

  it("prefers a more specific dial code over the bare +1", () => {
    // Bahamas is +1242. The bare US is +1. Longest-prefix-wins must pick BS.
    expect(detectCountryFromPhone("+12421234567")?.iso2).toBe("BS");
  });

  it("resolves bare +1 NANP numbers to US, not Canada", () => {
    // San Diego area code (858) — this used to detect as CA because the
    // alphabetical order of COUNTRIES placed Canada before the United
    // States and the longest-prefix sort was stable. The DIAL_CODE_PRIORITY
    // tiebreaker now disambiguates +1 in favor of US.
    expect(detectCountryFromPhone("+18589107283")?.iso2).toBe("US");
    expect(detectCountryFromPhone("+15551234567")?.iso2).toBe("US");
  });

  it("resolves bare +7 to Russia, not Kazakhstan", () => {
    // RU and KZ share +7. The tiebreaker prefers RU.
    expect(detectCountryFromPhone("+79991234567")?.iso2).toBe("RU");
  });

  it("returns null for empty input", () => {
    expect(detectCountryFromPhone("")).toBeNull();
  });

  it("returns null when no country dial code prefixes the digits", () => {
    // No country dial code starts with "999..." so this should fail to match.
    expect(detectCountryFromPhone("9999999999")).toBeNull();
  });
});

describe("stripDialCode + composeE164 round-trip", () => {
  it("strips the dial code from an E.164 phone for the matching country", () => {
    const jp = getCountryByIso2("JP")!;
    expect(stripDialCode("+818012345678", jp)).toBe("8012345678");
  });

  it("returns the local digits if the country doesn't match the prefix", () => {
    const jp = getCountryByIso2("JP")!;
    // Phone is US, country is JP — strip just removes the + and non-digits.
    expect(stripDialCode("+15551234567", jp)).toBe("15551234567");
  });

  it("composeE164 builds a clean +<dial><local> string", () => {
    const jp = getCountryByIso2("JP")!;
    expect(composeE164(jp, "8012345678")).toBe("+818012345678");
    // Local part with stray formatting characters is sanitized.
    expect(composeE164(jp, "(80) 1234-5678")).toBe("+818012345678");
    // Empty local still emits the dial-only prefix so partial typing works.
    expect(composeE164(jp, "")).toBe("+81");
  });

  it("round-trips a full E.164 value through detect → strip → compose", () => {
    const original = "+18589107283";
    const country = detectCountryFromPhone(original)!;
    expect(country).not.toBeNull();
    const local = stripDialCode(original, country);
    expect(composeE164(country, local)).toBe(original);
  });
});

import { describe, it, expect } from "vitest";
import {
  buildPhraseMatcher,
  generateMagicPhrase,
  isPhraseWrappedInExtraText,
} from "./magic-phrase.js";

describe("generateMagicPhrase", () => {
  it("returns a 4-word hyphen-joined phrase from the wordlist", () => {
    const phrase = generateMagicPhrase();
    const parts = phrase.split("-");
    expect(parts.length).toBe(4);
    for (const part of parts) {
      expect(part).toMatch(/^[a-z]+$/);
    }
  });

  it("produces non-deterministic output across calls", () => {
    // Probabilistic: with 64^4 = 16.7M possible phrases, generating 50
    // and finding zero collisions is essentially certain. If the CSPRNG
    // ever degrades, this will catch it.
    const phrases = new Set<string>();
    for (let i = 0; i < 50; i++) {
      phrases.add(generateMagicPhrase());
    }
    expect(phrases.size).toBe(50);
  });
});

describe("buildPhraseMatcher", () => {
  it("matches the exact phrase", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("apple-banana-cherry-date")).toBe(true);
  });

  it("ignores case differences in the inbound text", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("APPLE-BANANA-CHERRY-DATE")).toBe(true);
    expect(match("Apple-Banana-Cherry-Date")).toBe(true);
  });

  it("ignores punctuation, spaces, and emoji when the phrase is the only content", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("apple banana cherry date")).toBe(true);
    expect(match("apple, banana, cherry, date!")).toBe(true);
    expect(match(" Apple Banana Cherry Date 🙂 ")).toBe(true);
  });

  // SECURITY REGRESSION TEST for evaluation finding C1.
  //
  // The previous matcher used `.includes()`, which let an attacker pack
  // ~8000 distinct 4-word substrings into one Slack-sized message and
  // brute-force the 24-bit search space in a few hundred messages
  // (~14% per session). The matcher now uses normalised equality, so
  // wrapping the phrase in any extra prose must reject.
  it("REJECTS phrases embedded inside a longer message (C1 regression)", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("My pairing phrase is apple-banana-cherry-date please")).toBe(false);
    expect(match("hi 🙂 apple banana cherry date thanks")).toBe(false);
    expect(match("apple-banana-cherry-date and a tail")).toBe(false);
    expect(match("prefix apple-banana-cherry-date")).toBe(false);
  });

  // The "de Bruijn-style" attack from the evaluation: a single message
  // containing a long sequence of words. With contains, a 200-word message
  // tested ~197 4-tuples; with equality, it tests exactly 0 (because the
  // normalised text isn't equal to any single 4-tuple).
  it("REJECTS a long sequence of concatenated words (C1 regression)", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    const longSequence = Array.from({ length: 200 }, (_, i) =>
      ["apple", "banana", "cherry", "date", "fig"][i % 5],
    ).join("-");
    expect(match(longSequence)).toBe(false);
  });

  it("rejects messages missing one of the words", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("apple banana cherry")).toBe(false);
    expect(match("apple banana cherry zebra")).toBe(false);
  });

  it("rejects an empty message", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("")).toBe(false);
  });

  it("rejects when the phrase words appear out of order", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("date cherry banana apple")).toBe(false);
  });

  // ── Canonical normalization invariants ────────────────────────────────
  // The matcher strips everything outside `[a-z0-9]` after lowercasing,
  // then compares the result against the same transformation of the
  // expected phrase. Pin every documented input shape the user might
  // reasonably produce.
  it("matches when the user concatenates words without any separator", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("applebananacherrydate")).toBe(true);
  });

  it("matches when the user mixes separator styles (underscore, slash, dot)", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("apple_banana_cherry_date")).toBe(true);
    expect(match("apple.banana.cherry.date")).toBe(true);
    expect(match("apple/banana/cherry/date")).toBe(true);
  });

  it("matches when the user pads with leading/trailing whitespace, tabs, and newlines", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("\n\tapple-banana-cherry-date  \r\n")).toBe(true);
  });

  // ── Unicode adversarial inputs ────────────────────────────────────────
  // The filter is ASCII-only by design (homoglyphs and combining marks
  // are not normalized to ASCII equivalents). These tests document the
  // contract — homoglyph attacks REJECT (not silently match) and
  // invisible-character padding STILL matches.

  it("matches when the user inserts zero-width joiners between words", () => {
    // U+200D (ZWJ) is non-printing; the filter strips it.
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("apple‍banana‍cherry‍date")).toBe(true);
  });

  it("matches when the user wraps the phrase in BiDi marks (RLM, LRM) and BOM", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    // U+200E LRM, U+200F RLM, U+FEFF BOM — all stripped.
    expect(match("‎apple-banana-cherry-date‏")).toBe(true);
    expect(match("﻿apple-banana-cherry-date")).toBe(true);
  });

  it("REJECTS a Cyrillic homoglyph attack (`а` U+0430 vs ASCII `a`)", () => {
    // The user copies the phrase from a confusable domain that replaced
    // `a` with Cyrillic `а`. After filtering, the Cyrillic letter is
    // dropped entirely (not in `[a-z]`) — the normalized candidate ends
    // up shorter than the expected. timingSafeEqual short-circuits on
    // length mismatch. Lock this rejection so a future regex change to
    // `\p{L}` (Unicode letters) silently letting through homoglyphs
    // breaks this test.
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    // First `a` of `apple` replaced with Cyrillic `а`.
    expect(match("аpple-banana-cherry-date")).toBe(false);
    // Every `a` replaced.
    expect(match("аpple-bаnаnа-cherry-dаte")).toBe(false);
  });

  it("REJECTS a fullwidth-ASCII spoof (`ａｐｐｌｅ` U+FF41..)", () => {
    // Same threat shape as Cyrillic homoglyphs — visually identical, but
    // codepoints outside `[a-z]`. After stripping, the candidate length
    // diverges from expected.
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("ａｐｐｌｅ-banana-cherry-date")).toBe(false);
  });

  it("REJECTS accented-letter substitutions (combining marks strip the base letter signal)", () => {
    // `á` (NFC) is U+00E1 — outside `[a-z]`, fully stripped. `a` + U+0301
    // (NFD combining acute) keeps the `a` but strips the combiner, which
    // happens to MATCH (the base letter survives). Pin both shapes so
    // either treatment surfaces in a precise test failure if the rule
    // changes.
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    // NFC accented letter — dropped entirely → length mismatch.
    expect(match("ápple-banana-cherry-date")).toBe(false);
    // NFD (base + combiner) — base letter survives the strip; combiner is
    // dropped; result equals the expected. Documents the asymmetry.
    expect(match("ápple-banana-cherry-date")).toBe(true);
  });

  it("REJECTS same-length-but-different-content (timingSafeEqual fires)", () => {
    // Defensive: candidate normalizes to the same byte length as expected
    // but differs by one character. timingSafeEqual must reject.
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    // "apple-banana-cherry-dats" — last char 's' replaces 'e'.
    expect(match("apple-banana-cherry-dats")).toBe(false);
  });

  it("REJECTS when the phrase is the trivial empty string", () => {
    // `buildPhraseMatcher("")` short-circuits to always-false (the
    // `if (!expected) return false` branch). Pin this so a future
    // optimization that drops the guard cannot silently make every
    // pre-pairing message match.
    const match = buildPhraseMatcher("");
    expect(match("apple-banana-cherry-date")).toBe(false);
    expect(match("")).toBe(false);
    expect(match("anything at all")).toBe(false);
  });

  it("REJECTS when the phrase is pure punctuation (normalizes to empty)", () => {
    // Same branch as the empty-phrase case, reached via normalization
    // rather than a literal empty string.
    const match = buildPhraseMatcher("!!!---???");
    expect(match("!!!---???")).toBe(false);
    expect(match("")).toBe(false);
  });

  it("REJECTS when the candidate is pure whitespace / punctuation", () => {
    const match = buildPhraseMatcher("apple-banana-cherry-date");
    expect(match("   ")).toBe(false);
    expect(match("!!!---???")).toBe(false);
    expect(match("‍‎﻿")).toBe(false); // invisible chars only
  });
});

// ── Word list integrity (drift guard) ────────────────────────────────────
// The wordlist's 64-entry invariant is enforced at module load (throw).
// These tests cover the *content* invariants that the security argument
// in the file's JSDoc depends on — see "Word list rationale" §1.

describe("WORDS list integrity", () => {
  // The list isn't exported, so we exercise it indirectly through
  // `generateMagicPhrase`. Repeatedly generate phrases until each unique
  // word appears, then validate.
  function collectSeenWords(samples: number): Set<string> {
    const seen = new Set<string>();
    for (let i = 0; i < samples; i++) {
      for (const w of generateMagicPhrase().split("-")) {
        seen.add(w);
      }
    }
    return seen;
  }

  it("every observed word is ASCII-lowercase letters only (no diacritics, no digits, no homoglyphs)", () => {
    // The JSDoc claims ASCII-only legibility. If a future maintainer adds
    // a diacritic-bearing word, this regression catches it before it ships.
    const observed = collectSeenWords(500);
    for (const word of observed) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });

  it("observed words are at least 2 characters long (avoids single-letter homophones)", () => {
    const observed = collectSeenWords(500);
    for (const word of observed) {
      expect(word.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("observed words are reasonably short (≤ 8 chars — keeps phrases typeable)", () => {
    const observed = collectSeenWords(500);
    for (const word of observed) {
      expect(word.length).toBeLessThanOrEqual(8);
    }
  });

  it("samples enough generates to observe at least 40 distinct words (entropy sanity)", () => {
    // 500 generates × 4 words each = 2000 word picks across 64 entries.
    // Coupon-collector expectation hits all 64 around ~300 picks; observing
    // ≥40 distinct words proves the CSPRNG isn't degenerating to a constant
    // (which would have collapsed the 24-bit security budget to ~0).
    const observed = collectSeenWords(500);
    expect(observed.size).toBeGreaterThanOrEqual(40);
  });
});

// ── End-to-end: generate → match round-trip ──────────────────────────────
// A real-world bug class: the generator emits a phrase the matcher can't
// match back (e.g. matcher normalizes more aggressively than the
// generator). Hammer the round-trip to catch any such drift.

describe("generate → match round-trip", () => {
  it("every freshly generated phrase matches itself verbatim", () => {
    for (let i = 0; i < 100; i++) {
      const phrase = generateMagicPhrase();
      const match = buildPhraseMatcher(phrase);
      expect(match(phrase)).toBe(true);
    }
  });

  it("every freshly generated phrase matches its concatenated form", () => {
    for (let i = 0; i < 50; i++) {
      const phrase = generateMagicPhrase();
      const concatenated = phrase.replace(/-/g, "");
      const match = buildPhraseMatcher(phrase);
      expect(match(concatenated)).toBe(true);
    }
  });

  it("a freshly generated phrase does NOT match an unrelated freshly generated phrase", () => {
    // 64^4 = 16.7M possibilities — accidental collision odds across one
    // run are negligible (we'd need ~4096 phrases for a 50% birthday
    // collision). 50 attempts gives an essentially-zero false positive.
    for (let i = 0; i < 50; i++) {
      const a = generateMagicPhrase();
      const b = generateMagicPhrase();
      if (a === b) continue; // collision — skip this iteration (won't happen at 50 samples)
      const match = buildPhraseMatcher(a);
      expect(match(b)).toBe(false);
    }
  });
});

describe("isPhraseWrappedInExtraText", () => {
  it("returns true when the phrase is wrapped in meaningful extra prose", () => {
    expect(
      isPhraseWrappedInExtraText(
        "apple-banana-cherry-date",
        "my pairing phrase is apple-banana-cherry-date please please please",
      ),
    ).toBe(true);
  });

  it("returns false for the exact phrase (handled by the equality matcher)", () => {
    expect(
      isPhraseWrappedInExtraText("apple-banana-cherry-date", "apple-banana-cherry-date"),
    ).toBe(false);
  });

  it("returns false for an exact phrase with just one trailing character (length within 1.5×)", () => {
    // 16 expected chars × 1.5 = 24 → ceil = 24. Candidate of length 17
    // (one extra char) is well within the guard, so no hint should fire.
    expect(
      isPhraseWrappedInExtraText("apple-banana-cherry-date", "apple-banana-cherry-date!"),
    ).toBe(false);
  });

  it("returns false for a completely wrong phrase, even when long", () => {
    expect(
      isPhraseWrappedInExtraText(
        "apple-banana-cherry-date",
        "the quick brown fox jumps over the lazy dog and then some more",
      ),
    ).toBe(false);
  });

  it("returns false when the expected phrase normalizes to empty", () => {
    expect(isPhraseWrappedInExtraText("", "any candidate string at all")).toBe(false);
    expect(isPhraseWrappedInExtraText("!!!---???", "wrapped !!!---??? here")).toBe(false);
  });

  it("returns false when the candidate normalizes to empty", () => {
    expect(isPhraseWrappedInExtraText("apple-banana-cherry-date", "")).toBe(false);
    expect(isPhraseWrappedInExtraText("apple-banana-cherry-date", "   ")).toBe(false);
    expect(isPhraseWrappedInExtraText("apple-banana-cherry-date", "!!!---???")).toBe(false);
  });

  it("returns false when the candidate is long but does not contain the phrase", () => {
    // The candidate is well above the 1.5× length guard, but the phrase
    // is not a substring of the normalized form. Wrong, not wrapped.
    expect(
      isPhraseWrappedInExtraText(
        "apple-banana-cherry-date",
        "lots of other words that just happen to be long without phrase",
      ),
    ).toBe(false);
  });

  it("returns true even when the wrapper uses mixed punctuation/case (normalization survives)", () => {
    expect(
      isPhraseWrappedInExtraText(
        "apple-banana-cherry-date",
        "Hello! My phrase: APPLE / BANANA / CHERRY / DATE — thanks 🙂🙂🙂",
      ),
    ).toBe(true);
  });
});

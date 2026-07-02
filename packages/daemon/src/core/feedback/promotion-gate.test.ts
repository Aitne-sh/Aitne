import { describe, expect, it } from "vitest";

import {
  applyContradictionGuard,
  computeInitialCf,
  computeWeightedEvidence,
  contradictionOverrideBar,
  evaluatePromotion,
  isExplicitDirective,
  isIgnoredSignal,
  saturate,
  signalWeight,
  SOURCE_CF_FACTOR,
  type GateSignal,
} from "./promotion-gate.js";

const sig = (
  source: GateSignal["source"],
  valence: GateSignal["valence"],
): GateSignal => ({ source, valence });

describe("promotion-gate", () => {
  describe("signalWeight", () => {
    it("weights an explicit directive 1.0 even with a neutral valence", () => {
      expect(signalWeight(sig("explicit", "neutral"))).toBe(1.0);
      expect(signalWeight(sig("explicit", "positive"))).toBe(1.0);
    });
    it("weights a correction 1.0", () => {
      expect(signalWeight(sig("behavioral", "correction"))).toBe(1.0);
    });
    it("weights an ignored (neutral) signal 0.25", () => {
      expect(signalWeight(sig("behavioral", "neutral"))).toBe(0.25);
    });
    it("weights self_critique 0.5", () => {
      expect(signalWeight(sig("self_critique", "positive"))).toBe(0.5);
    });
    it("weights a neutral self_critique 0.5 — only behavioral neutral is 'ignored'", () => {
      // A neutral-toned self-critique note is a deliberate signal, not silence;
      // it must not collapse to the 0.25 ignored weight.
      expect(signalWeight(sig("self_critique", "neutral"))).toBe(0.5);
    });
    it("weights a replied/positive behavioral signal 0.5 (incl. null valence)", () => {
      expect(signalWeight(sig("behavioral", "positive"))).toBe(0.5);
      expect(signalWeight(sig("behavioral", null))).toBe(0.5);
    });
  });

  describe("isIgnoredSignal / isExplicitDirective", () => {
    it("isIgnoredSignal is true only for a behavioral neutral reaction", () => {
      expect(isIgnoredSignal(sig("behavioral", "neutral"))).toBe(true);
      expect(isIgnoredSignal(sig("behavioral", "positive"))).toBe(false);
      // Neutral on a non-behavioral source is NOT an ignore.
      expect(isIgnoredSignal(sig("explicit", "neutral"))).toBe(false);
      expect(isIgnoredSignal(sig("self_critique", "neutral"))).toBe(false);
    });
    it("isExplicitDirective covers explicit source and corrections", () => {
      expect(isExplicitDirective(sig("explicit", "preference" as never))).toBe(
        true,
      );
      expect(isExplicitDirective(sig("behavioral", "correction"))).toBe(true);
      expect(isExplicitDirective(sig("behavioral", "positive"))).toBe(false);
    });
  });

  it("computeWeightedEvidence sums per-signal weights", () => {
    expect(
      computeWeightedEvidence([
        sig("explicit", "correction"), // 1.0
        sig("behavioral", "positive"), // 0.5
        sig("behavioral", "neutral"), // 0.25
      ]),
    ).toBe(1.75);
  });

  describe("evaluatePromotion", () => {
    it("returns no-signals provisional for an empty candidate", () => {
      expect(evaluatePromotion([], 2)).toEqual({
        promotable: false,
        provisional: true,
        conf: "low",
        weightedEv: 0,
        reason: "no-signals",
      });
    });

    it("never promotes an ignored-only candidate regardless of count", () => {
      const verdict = evaluatePromotion(
        [
          sig("behavioral", "neutral"),
          sig("behavioral", "neutral"),
          sig("behavioral", "neutral"),
          sig("behavioral", "neutral"), // weighted 1.0 — still below, and ignored-only
        ],
        1, // even a threshold this low must not let silence initiate a lesson
      );
      expect(verdict).toMatchObject({
        promotable: false,
        provisional: true,
        reason: "ignored-non-initiating",
      });
    });

    it("promotes an explicit directive on first occurrence with high conf", () => {
      const verdict = evaluatePromotion([sig("explicit", "preference" as never)], 2);
      expect(verdict).toMatchObject({
        promotable: true,
        provisional: false,
        conf: "high",
        reason: "explicit-directive",
      });
    });

    it("promotes a lone explicit signal even when its valence is neutral", () => {
      // Regression: a neutral valence must not make an explicit owner directive
      // read as an 'ignored-only' candidate and get held provisional.
      const verdict = evaluatePromotion([sig("explicit", "neutral")], 2);
      expect(verdict).toMatchObject({
        promotable: true,
        provisional: false,
        conf: "high",
        reason: "explicit-directive",
        weightedEv: 1.0,
      });
    });

    it("an ignore strengthens a correction-started lesson (mixed promotes)", () => {
      const verdict = evaluatePromotion(
        [sig("behavioral", "correction"), sig("behavioral", "neutral")],
        2,
      );
      expect(verdict).toMatchObject({
        promotable: true,
        conf: "high",
        reason: "explicit-directive",
        weightedEv: 1.25,
      });
    });

    it("promotes behavioral corroboration at the weighted threshold", () => {
      const verdict = evaluatePromotion(
        [sig("behavioral", "positive"), sig("self_critique", "positive")], // 1.0
        1,
      );
      expect(verdict).toMatchObject({
        promotable: true,
        provisional: false,
        conf: "medium",
        reason: "evidence-threshold",
      });
    });

    it("holds a sub-threshold non-ignored candidate as provisional", () => {
      const verdict = evaluatePromotion(
        [sig("behavioral", "positive"), sig("behavioral", "neutral")], // 0.75 < 2
        2,
      );
      expect(verdict).toMatchObject({
        promotable: false,
        provisional: true,
        conf: "low",
        reason: "below-threshold",
        weightedEv: 0.75,
      });
    });
  });

  describe("cf0 (SELF_IMPROVEMENT_PHASE2 §2.1)", () => {
    it("saturate maps weighted evidence into [0,1) with K as half-point", () => {
      expect(saturate(2, 2)).toBe(0.5);
      expect(saturate(0, 2)).toBe(0);
      expect(saturate(6, 2)).toBeCloseTo(0.75, 6);
    });

    it("saturate guards non-positive K to the documented default", () => {
      expect(saturate(2, 0)).toBe(0.5);
      expect(saturate(2, -1)).toBe(0.5);
    });

    it("saturate clamps negative evidence to zero", () => {
      expect(saturate(-3, 2)).toBe(0);
    });

    it("computeInitialCf = round2(saturate · sourceFactor)", () => {
      expect(computeInitialCf(2, "explicit", 2)).toBe(0.5);
      expect(computeInitialCf(2, "self_critique", 2)).toBe(
        Math.round(0.5 * SOURCE_CF_FACTOR.self_critique * 100) / 100,
      );
      expect(computeInitialCf(2, "behavioral", 2)).toBe(0.35);
      // single explicit correction: 1/(1+2) · 1.0 ≈ 0.33 (the documented
      // D7 asymmetry — below the contradiction guard, which explicit
      // directives bypass anyway)
      expect(computeInitialCf(1, "explicit", 2)).toBe(0.33);
    });
  });

  describe("applyContradictionGuard (§2.2 anti-whiplash)", () => {
    const promotable = evaluatePromotion(
      [sig("behavioral", "positive"), sig("behavioral", "positive"), sig("behavioral", "positive"), sig("behavioral", "positive")],
      2,
    ); // weightedEv 2.0, evidence-threshold

    it("holds a promotable non-explicit candidate below the 1.5x bar", () => {
      // bar = 1.5 · 2 · 0.8 = 2.4 > 2.0
      const held = applyContradictionGuard(promotable, 0.8, {
        guardCf: 0.6,
        threshold: 2,
      });
      expect(held).toMatchObject({
        promotable: false,
        provisional: true,
        reason: "contradiction",
      });
    });

    it("promotes once evidence clears the bar", () => {
      const strong = evaluatePromotion(
        Array.from({ length: 6 }, () => sig("behavioral", "positive")),
        2,
      ); // weightedEv 3.0 ≥ 2.4
      expect(
        applyContradictionGuard(strong, 0.8, { guardCf: 0.6, threshold: 2 }),
      ).toBe(strong);
    });

    it("ignores suspects below the guard cf", () => {
      expect(
        applyContradictionGuard(promotable, 0.5, { guardCf: 0.6, threshold: 2 }),
      ).toBe(promotable);
    });

    it("explicit directives bypass the guard (a user correction always wins)", () => {
      const explicit = evaluatePromotion([sig("explicit", "correction")], 2);
      expect(
        applyContradictionGuard(explicit, 1, { guardCf: 0.6, threshold: 2 }),
      ).toBe(explicit);
    });

    it("passes a non-promotable verdict through untouched", () => {
      const held = evaluatePromotion([sig("behavioral", "positive")], 2);
      expect(
        applyContradictionGuard(held, 1, { guardCf: 0.6, threshold: 2 }),
      ).toBe(held);
    });

    it("contradictionOverrideBar is the documented 1.5·K·cf", () => {
      expect(contradictionOverrideBar(2, 0.8)).toBeCloseTo(2.4, 6);
    });
  });
});

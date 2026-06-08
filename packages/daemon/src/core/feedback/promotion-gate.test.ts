import { describe, expect, it } from "vitest";

import {
  computeWeightedEvidence,
  evaluatePromotion,
  isExplicitDirective,
  isIgnoredSignal,
  signalWeight,
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
});

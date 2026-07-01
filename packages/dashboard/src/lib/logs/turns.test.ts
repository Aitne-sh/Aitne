import { describe, it, expect } from "vitest";
import { readMaxTurns, turnsCell } from "./turns";

describe("readMaxTurns", () => {
  it("returns null for null / empty / malformed detail", () => {
    expect(readMaxTurns(null)).toBeNull();
    expect(readMaxTurns(undefined)).toBeNull();
    expect(readMaxTurns("")).toBeNull();
    expect(readMaxTurns("{not json")).toBeNull();
  });

  it("returns null when detail has no prePass block", () => {
    expect(readMaxTurns(JSON.stringify({ failureKind: "quota" }))).toBeNull();
    expect(readMaxTurns(JSON.stringify({ prePass: null }))).toBeNull();
    expect(readMaxTurns(JSON.stringify("scalar"))).toBeNull();
  });

  it("returns null for a missing / non-positive / non-finite maxTurns", () => {
    expect(readMaxTurns(JSON.stringify({ prePass: {} }))).toBeNull();
    expect(readMaxTurns(JSON.stringify({ prePass: { maxTurns: 0 } }))).toBeNull();
    expect(readMaxTurns(JSON.stringify({ prePass: { maxTurns: -5 } }))).toBeNull();
    expect(readMaxTurns(JSON.stringify({ prePass: { maxTurns: "20" } }))).toBeNull();
  });

  it("extracts a positive maxTurns from detail.prePass", () => {
    expect(readMaxTurns(JSON.stringify({ prePass: { maxTurns: 20 } }))).toBe(20);
  });
});

describe("turnsCell", () => {
  it("renders an em dash when the row has no turn count", () => {
    expect(turnsCell({ num_turns: null, detail: null })).toEqual({
      used: null,
      cap: null,
      atLimit: false,
      label: "—",
    });
  });

  it("renders the bare count when no envelope is persisted", () => {
    expect(turnsCell({ num_turns: 8, detail: null })).toEqual({
      used: 8,
      cap: null,
      atLimit: false,
      label: "8",
    });
    // detail present but no prePass.maxTurns → still bare.
    expect(
      turnsCell({ num_turns: 8, detail: JSON.stringify({ prePass: {} }) }).label,
    ).toBe("8");
  });

  it("renders used / cap with headroom when under the envelope", () => {
    const cell = turnsCell({
      num_turns: 8,
      detail: JSON.stringify({ prePass: { maxTurns: 20 } }),
    });
    expect(cell).toEqual({ used: 8, cap: 20, atLimit: false, label: "8 / 20" });
  });

  it("flags atLimit when the row spent its whole envelope", () => {
    const cell = turnsCell({
      num_turns: 10,
      detail: JSON.stringify({ prePass: { maxTurns: 10 } }),
    });
    expect(cell).toEqual({ used: 10, cap: 10, atLimit: true, label: "10 / 10" });
  });

  it("treats a non-finite num_turns as absent", () => {
    expect(
      turnsCell({ num_turns: Number.NaN, detail: null }).label,
    ).toBe("—");
  });
});

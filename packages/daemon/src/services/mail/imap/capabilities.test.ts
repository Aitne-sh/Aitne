import { describe, expect, it } from "vitest";
import {
  parseCapabilitiesJson,
  probeCapabilities,
  serializeCapabilities,
} from "./capabilities.js";

describe("probeCapabilities", () => {
  it("returns all-false set for nullish input", () => {
    for (const input of [null, undefined]) {
      const caps = probeCapabilities(input);
      expect(caps).toEqual({
        qresync: false,
        threadReferences: false,
        specialUse: false,
        uidplus: false,
        idle: false,
        move: false,
        all: [],
      });
    }
  });

  it("extracts known capabilities from an array", () => {
    const caps = probeCapabilities([
      "IMAP4rev1",
      "IDLE",
      "UIDPLUS",
      "QRESYNC",
      "THREAD=REFERENCES",
      "SPECIAL-USE",
      "MOVE",
    ]);
    expect(caps.idle).toBe(true);
    expect(caps.uidplus).toBe(true);
    expect(caps.qresync).toBe(true);
    expect(caps.threadReferences).toBe(true);
    expect(caps.specialUse).toBe(true);
    expect(caps.move).toBe(true);
    expect(caps.all).toEqual([
      "IDLE",
      "IMAP4REV1",
      "MOVE",
      "QRESYNC",
      "SPECIAL-USE",
      "THREAD=REFERENCES",
      "UIDPLUS",
    ]);
  });

  it("accepts ImapFlow's Map<string, boolean | number> shape", () => {
    // ImapFlow exposes client.capabilities as a Map. Its keys are
    // already capability names (values are just arg counts or booleans),
    // so we only consume the keys.
    const map = new Map<string, boolean | number>([
      ["IDLE", true],
      ["UIDPLUS", 1],
      ["QRESYNC", true],
    ]);
    const caps = probeCapabilities(map);
    expect(caps.idle).toBe(true);
    expect(caps.uidplus).toBe(true);
    expect(caps.qresync).toBe(true);
    expect(caps.specialUse).toBe(false);
  });

  it("treats capability names as case-insensitive", () => {
    const caps = probeCapabilities(["idle", "Uidplus", "qresync"]);
    expect(caps.idle).toBe(true);
    expect(caps.uidplus).toBe(true);
    expect(caps.qresync).toBe(true);
  });

  it("ignores non-string and empty entries", () => {
    const caps = probeCapabilities([
      "IDLE",
      "",
      123 as unknown as string,
      null as unknown as string,
    ]);
    expect(caps.idle).toBe(true);
    expect(caps.all).toEqual(["IDLE"]);
  });

  it("deduplicates repeated capabilities", () => {
    const caps = probeCapabilities(["IDLE", "idle", "IDLE"]);
    expect(caps.all).toEqual(["IDLE"]);
  });
});

describe("serializeCapabilities / parseCapabilitiesJson", () => {
  it("round-trips a full capability set", () => {
    const original = probeCapabilities([
      "IDLE",
      "UIDPLUS",
      "QRESYNC",
      "THREAD=REFERENCES",
      "SPECIAL-USE",
      "MOVE",
    ]);
    const roundTripped = parseCapabilitiesJson(serializeCapabilities(original));
    expect(roundTripped).toEqual(original);
  });

  it("returns null for nullish or empty input", () => {
    expect(parseCapabilitiesJson(null)).toBeNull();
    expect(parseCapabilitiesJson(undefined)).toBeNull();
    expect(parseCapabilitiesJson("")).toBeNull();
  });

  it("returns null for unparseable JSON", () => {
    expect(parseCapabilitiesJson("{not json")).toBeNull();
  });

  it("returns null when shape is wrong", () => {
    expect(parseCapabilitiesJson(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseCapabilitiesJson(JSON.stringify(null))).toBeNull();
    expect(parseCapabilitiesJson(JSON.stringify(["IDLE"]))).toBeNull();
  });

  it("tolerates older persisted JSON that predates newer capability fields", () => {
    // Forward-compat: if we later add a new field to ImapCapabilitySet, rows
    // persisted before the change only carry `all` plus the capability flags
    // that existed at write time. parseCapabilitiesJson must rebuild the
    // full set from `all` so downstream readers never see undefined fields.
    const olderSchema = JSON.stringify({
      // No `move` field — mimics a hypothetical pre-`move` persisted row.
      qresync: true,
      threadReferences: false,
      specialUse: true,
      uidplus: true,
      idle: true,
      all: ["IDLE", "MOVE", "QRESYNC", "SPECIAL-USE", "UIDPLUS"],
    });
    const caps = parseCapabilitiesJson(olderSchema);
    expect(caps).not.toBeNull();
    expect(caps?.move).toBe(true); // re-derived from `all`
    expect(caps?.idle).toBe(true);
    expect(caps?.qresync).toBe(true);
  });
});

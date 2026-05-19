import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { SotBindings } from "@aitne/shared";
import { applySchema } from "./schema.js";
import {
  SOT_BINDINGS_SETTINGS_KEY,
  readSotBindings,
  writeSotBindings,
} from "./sot-bindings-store.js";

describe("sot-bindings-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  const sample: SotBindings = [
    {
      category: "tasks",
      sotApp: "notion",
      mirrorPath: "context/work/tasks-index.md",
      policy: null,
      writer: "agent",
    },
    {
      category: "meetings",
      sotApp: "google_calendar",
      mirrorPath: "context/work/meetings/",
      policy: "Calendar holds slot only",
      writer: "shared",
    },
  ];

  it("returns empty array when settings row is missing", () => {
    expect(readSotBindings(db)).toEqual([]);
  });

  it("write then read round-trips a binding list", () => {
    writeSotBindings(db, sample);
    expect(readSotBindings(db)).toEqual(sample);
  });

  it("write canonicalizes (NFC + trim) free-form labels via Zod", () => {
    const dirty: SotBindings = [
      {
        // Two trailing spaces and a wide-space variant exercise the trim
        // + NFC pass enforced by trimmedLabel in management-domains.ts.
        category: "  tasks  ",
        sotApp: " notion",
        mirrorPath: null,
        policy: null,
        writer: "agent",
      },
    ];
    const stored = writeSotBindings(db, dirty);
    expect(stored[0].category).toBe("tasks");
    expect(stored[0].sotApp).toBe("notion");
    expect(readSotBindings(db)[0].category).toBe("tasks");
  });

  it("write rejects an invalid binding (Zod throws)", () => {
    expect(() =>
      writeSotBindings(db, [
        {
          category: "tasks",
          sotApp: "notion",
          mirrorPath: null,
          policy: null,
          // @ts-expect-error — invalid writer literal.
          writer: "robot",
        },
      ]),
    ).toThrow();
  });

  it("write replaces (does not merge) the previous bindings", () => {
    writeSotBindings(db, sample);
    writeSotBindings(db, [sample[0]]);
    expect(readSotBindings(db)).toHaveLength(1);
    expect(readSotBindings(db)[0].category).toBe("tasks");
  });

  it("returns empty array when stored JSON is malformed", () => {
    db.prepare(
      "INSERT INTO settings (key, value_json) VALUES (?, ?)",
    ).run(SOT_BINDINGS_SETTINGS_KEY, "{not-json");
    expect(readSotBindings(db)).toEqual([]);
  });

  it("returns empty array when stored value fails Zod (corrupt manual edit)", () => {
    db.prepare(
      "INSERT INTO settings (key, value_json) VALUES (?, ?)",
    ).run(
      SOT_BINDINGS_SETTINGS_KEY,
      JSON.stringify([{ writer: "agent" }]),
    );
    expect(readSotBindings(db)).toEqual([]);
  });
});

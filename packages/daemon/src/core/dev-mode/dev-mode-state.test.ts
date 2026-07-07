import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  clearDevModeState,
  isDevModeActive,
  readDevModeState,
  writeDevModeState,
} from "./dev-mode-state.js";

describe("dev-mode-state pointer", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => db.close());

  it("round-trips the pointer and reports presence", () => {
    expect(readDevModeState(db)).toBeNull();
    expect(isDevModeActive(db)).toBe(false);
    writeDevModeState(db, {
      sessionId: "s1",
      repositoryId: "local:test",
      slug: "test",
      enteredAt: 123,
    });
    expect(readDevModeState(db)).toEqual({
      sessionId: "s1",
      repositoryId: "local:test",
      slug: "test",
      enteredAt: 123,
    });
    expect(isDevModeActive(db)).toBe(true);
    clearDevModeState(db);
    expect(readDevModeState(db)).toBeNull();
  });

  it("coerces a malformed/partial pointer defensively", () => {
    // Missing required fields → treated as absent.
    db.prepare(
      "INSERT INTO runtime_state (key, value_json, updated_at) VALUES ('current_dev_mode', ?, CURRENT_TIMESTAMP)",
    ).run(JSON.stringify({ sessionId: 42 }));
    expect(readDevModeState(db)).toBeNull();

    // Optional fields default when the wrong type.
    db.prepare(
      "UPDATE runtime_state SET value_json = ? WHERE key = 'current_dev_mode'",
    ).run(JSON.stringify({ sessionId: "s2", repositoryId: "r2" }));
    expect(readDevModeState(db)).toEqual({
      sessionId: "s2",
      repositoryId: "r2",
      slug: null,
      enteredAt: 0,
    });
  });
});

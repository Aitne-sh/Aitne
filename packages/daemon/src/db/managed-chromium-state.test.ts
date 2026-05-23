import Database from "better-sqlite3";
import { describe, expect, it, beforeEach } from "vitest";

import { applySchema } from "./schema.js";
import {
  clearManagedChromiumState,
  readManagedChromiumState,
  updateManagedChromiumState,
} from "./managed-chromium-state.js";
import { writeRuntimeState } from "./runtime-state.js";
import {
  DEFAULT_MANAGED_CHROMIUM_STATE,
  MANAGED_CHROMIUM_STATE_KEY,
} from "../services/browser-history/managed-chromium/types.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("managed-chromium-state", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns the default shape when no row is present", () => {
    const state = readManagedChromiumState(db);
    expect(state).toEqual(DEFAULT_MANAGED_CHROMIUM_STATE);
  });

  it("returns the default shape when the row is malformed", () => {
    writeRuntimeState(db, MANAGED_CHROMIUM_STATE_KEY, { not: "valid" });
    const state = readManagedChromiumState(db);
    expect(state).toEqual(DEFAULT_MANAGED_CHROMIUM_STATE);
  });

  it("persists mutations atomically", () => {
    updateManagedChromiumState(db, (draft) => {
      draft.enabled = true;
      draft.state = "needs_setup";
    });
    const out = readManagedChromiumState(db);
    expect(out.enabled).toBe(true);
    expect(out.state).toBe("needs_setup");
  });

  it("validates the resulting shape against the schema", () => {
    expect(() =>
      updateManagedChromiumState(db, (draft) => {
        (draft as unknown as { state: string }).state = "not-a-state";
      }),
    ).toThrowError();
  });

  it("clear removes the row", () => {
    updateManagedChromiumState(db, (draft) => {
      draft.enabled = true;
    });
    clearManagedChromiumState(db);
    const after = readManagedChromiumState(db);
    expect(after.enabled).toBe(false);
  });

  it("preserves per-kind lastDmAt across updates", () => {
    updateManagedChromiumState(db, (draft) => {
      draft.enabled = true;
      draft.lastDmAt["sync_silent"] = 12345;
    });
    updateManagedChromiumState(db, (draft) => {
      draft.consecutiveFailures = 1;
    });
    const out = readManagedChromiumState(db);
    expect(out.lastDmAt["sync_silent"]).toBe(12345);
    expect(out.consecutiveFailures).toBe(1);
  });
});

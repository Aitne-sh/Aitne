import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  clearDegradedMode,
  clearSetupCompleted,
  clearUserPaused,
  deleteRuntimeState,
  getDegradedMode,
  getUserPaused,
  isDegraded,
  isSetupCompleted,
  isUserPaused,
  markSetupCompleted,
  readRuntimeState,
  setDegradedMode,
  setUserPaused,
  writeRuntimeState,
  DEGRADED_MODE_KEY,
  SETUP_COMPLETED_KEY,
  USER_PAUSED_KEY,
} from "./runtime-state.js";

describe("runtime-state kv helpers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips string values", () => {
    writeRuntimeState(db, "cursor", "abc");
    expect(readRuntimeState<string>(db, "cursor")).toBe("abc");
  });

  it("round-trips object values", () => {
    writeRuntimeState(db, "cursor", { offset: 42 });
    expect(readRuntimeState<{ offset: number }>(db, "cursor")).toEqual({ offset: 42 });
  });

  it("returns null for missing keys", () => {
    expect(readRuntimeState(db, "nope")).toBeNull();
  });

  it("deletes values", () => {
    writeRuntimeState(db, "x", 1);
    deleteRuntimeState(db, "x");
    expect(readRuntimeState(db, "x")).toBeNull();
  });

  it("returns null and logs when the SELECT itself fails", () => {
    writeRuntimeState(db, "alive", { ok: 1 });
    db.close();
    // Any read after close throws inside `db.prepare(...).get(...)` —
    // the catch should swallow it and return null.
    expect(readRuntimeState(db, "alive")).toBeNull();
  });

  it("returns null when the stored JSON is corrupt", () => {
    // Inject a row whose value_json is unparseable (skipping the writer).
    db.prepare(
      "INSERT INTO runtime_state (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("corrupt", "{not-json");

    // The corrupt-row catch path returns null without throwing — and the
    // ERROR log surfaces it for operator triage.
    expect(readRuntimeState(db, "corrupt")).toBeNull();
  });
});

describe("Management Mode degraded-mode helpers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("isDegraded returns false when no state is set", () => {
    expect(isDegraded(db)).toBe(false);
    expect(getDegradedMode(db)).toBeNull();
  });

  it("setDegradedMode persists to runtime_state", () => {
    setDegradedMode(db, {
      reason: "primary_vault_unreachable",
      path: "/tmp/vault",
      since: "2026-04-18T10:00:00Z",
    });

    expect(isDegraded(db)).toBe(true);
    const state = getDegradedMode(db);
    expect(state).toEqual({
      reason: "primary_vault_unreachable",
      path: "/tmp/vault",
      since: "2026-04-18T10:00:00Z",
    });
  });

  it("stores under DEGRADED_MODE_KEY", () => {
    setDegradedMode(db, { reason: "r", path: null, since: "t" });
    expect(readRuntimeState(db, DEGRADED_MODE_KEY)).not.toBeNull();
  });

  it("clearDegradedMode removes persisted state", () => {
    setDegradedMode(db, {
      reason: "primary_vault_not_configured",
      path: null,
      since: "2026-04-18T11:00:00Z",
    });
    expect(isDegraded(db)).toBe(true);

    clearDegradedMode(db);
    expect(isDegraded(db)).toBe(false);
    expect(getDegradedMode(db)).toBeNull();
  });

  it("setDegradedMode overwrites an existing entry", () => {
    setDegradedMode(db, { reason: "first", path: null, since: "2026-04-18T10:00:00Z" });
    setDegradedMode(db, { reason: "second", path: "/x", since: "2026-04-18T11:00:00Z" });
    expect(getDegradedMode(db)?.reason).toBe("second");
    expect(getDegradedMode(db)?.path).toBe("/x");
  });
});

describe("Management Mode setup-completed latch", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("defaults to not-completed", () => {
    expect(isSetupCompleted(db)).toBe(false);
  });

  it("markSetupCompleted persists under SETUP_COMPLETED_KEY", () => {
    markSetupCompleted(db);
    expect(isSetupCompleted(db)).toBe(true);
    expect(readRuntimeState(db, SETUP_COMPLETED_KEY)).toBe(true);
  });

  it("is latched — markSetupCompleted is idempotent and does not un-latch", () => {
    markSetupCompleted(db);
    markSetupCompleted(db);
    expect(isSetupCompleted(db)).toBe(true);
  });

  it("clearSetupCompleted removes the setup-completed marker for explicit resets", () => {
    markSetupCompleted(db);
    clearSetupCompleted(db);
    expect(isSetupCompleted(db)).toBe(false);
    expect(readRuntimeState(db, SETUP_COMPLETED_KEY)).toBeNull();
  });
});

describe("user-paused (messaging-bang-commands.md §6.1)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("defaults to not paused", () => {
    expect(isUserPaused(db)).toBe(false);
    expect(getUserPaused(db)).toBeNull();
  });

  it("setUserPaused persists state under USER_PAUSED_KEY", () => {
    const state = {
      since: "2026-05-01T03:02:00.000Z",
      source: "!stop",
      byPlatform: "slack",
    };
    setUserPaused(db, state);
    expect(isUserPaused(db)).toBe(true);
    expect(getUserPaused(db)).toEqual(state);
    expect(readRuntimeState(db, USER_PAUSED_KEY)).toEqual(state);
  });

  it("clearUserPaused removes persisted state", () => {
    setUserPaused(db, {
      since: "2026-05-01T03:02:00.000Z",
      source: "!stop",
      byPlatform: "telegram",
    });
    clearUserPaused(db);
    expect(isUserPaused(db)).toBe(false);
    expect(getUserPaused(db)).toBeNull();
  });
});

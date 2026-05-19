import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  readIntegrationState,
  readIntegrations,
  updateIntegrationState,
  writeIntegrations,
} from "./integrations-store.js";

describe("integrations-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("readIntegrations returns all keys disabled when row is missing", () => {
    const state = readIntegrations(db);
    expect(state.gmail.mode).toBe("disabled");
    expect(state.google_calendar.mode).toBe("disabled");
  });

  it("readIntegrations hydrates from stored JSON", () => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value_json) VALUES ('integrations', ?)",
    ).run(
      JSON.stringify({
        gmail: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-04-19T00:00:00.000Z",
        },
      }),
    );
    const state = readIntegrations(db);
    expect(state.gmail.mode).toBe("delegated");
    expect(state.gmail.delegatedBackend).toBe("claude");
    // Missing keys fill from defaults.
    expect(state.google_calendar.mode).toBe("disabled");
  });

  it("readIntegrations recovers from corrupt JSON", () => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value_json) VALUES ('integrations', ?)",
    ).run("{ not json");
    const state = readIntegrations(db);
    expect(state.gmail.mode).toBe("disabled");
  });

  it("readIntegrations handles stored JSON null", () => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value_json) VALUES ('integrations', 'null')",
    ).run();
    const state = readIntegrations(db);
    expect(state.gmail.mode).toBe("disabled");
    expect(state.google_calendar.mode).toBe("disabled");
  });

  it("readIntegrations drops invalid per-key rows but keeps siblings", () => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value_json) VALUES ('integrations', ?)",
    ).run(
      JSON.stringify({
        gmail: {
          mode: "broken",
          deniedTools: [],
          lastChangedAt: "2026-04-19T00:00:00.000Z",
        },
        google_calendar: {
          mode: "direct",
          deniedTools: [],
          lastChangedAt: "2026-04-19T00:00:00.000Z",
        },
      }),
    );
    const state = readIntegrations(db);
    expect(state.gmail.mode).toBe("disabled"); // fell through to default
    expect(state.google_calendar.mode).toBe("direct");
  });

  it("writeIntegrations merges partial updates without wiping siblings", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    const first = readIntegrations(db);
    expect(first.gmail.mode).toBe("direct");
    expect(first.google_calendar.mode).toBe("disabled");

    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T01:00:00.000Z",
      },
    });
    const merged = readIntegrations(db);
    expect(merged.gmail.mode).toBe("direct");
    expect(merged.google_calendar.delegatedBackend).toBe("codex");
  });

  it("writeIntegrations validates delegated requires backend", () => {
    expect(() =>
      writeIntegrations(db, {
        gmail: {
          mode: "delegated",
          deniedTools: [],
          lastChangedAt: "2026-04-19T00:00:00.000Z",
        },
      }),
    ).toThrow();
  });

  it("updateIntegrationState stamps lastChangedAt when omitted", () => {
    const before = Date.now();
    const next = updateIntegrationState(db, "gmail", { mode: "direct", deniedTools: [] });
    const after = Date.now();
    const stamped = new Date(next.gmail.lastChangedAt).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after + 5);
  });

  it("updateIntegrationState preserves caller-supplied lastChangedAt", () => {
    const next = updateIntegrationState(db, "gmail", {
      mode: "direct",
      deniedTools: [],
      lastChangedAt: "2026-04-19T00:00:00.000Z",
    });
    expect(next.gmail.lastChangedAt).toBe("2026-04-19T00:00:00.000Z");
  });

  it("updateIntegrationState throws on unknown key", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateIntegrationState(db, "slack" as any, { mode: "direct", deniedTools: [] }),
    ).toThrow(/Unknown integration key/);
  });

  it("readIntegrationState forwards through readIntegrations", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    expect(readIntegrationState(db, "gmail").mode).toBe("direct");
    expect(readIntegrationState(db, "google_calendar").mode).toBe("disabled");
  });
});

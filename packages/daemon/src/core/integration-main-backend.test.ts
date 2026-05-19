import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import {
  readIntegrations,
  writeIntegrations,
} from "../db/integrations-store.js";
import {
  readProbe,
  writeProbe,
} from "../db/integration-probe-store.js";
import {
  cascadeNativeBindingsOnMainSwitch,
  checkDelegatedCompatForNewMain,
  readMainBackend,
} from "./integration-main-backend.js";

describe("checkDelegatedCompatForNewMain", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty when no integration is delegated", () => {
    const reports = checkDelegatedCompatForNewMain(db, "codex");
    expect(reports).toEqual([]);
  });

  it("reports compatibleWithNewMain: true when new main has a registry connector", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const reports = checkDelegatedCompatForNewMain(db, "codex");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      key: "gmail",
      delegatedBackend: "claude",
      compatibleWithNewMain: true,
    });
  });

  // The `compatibleWithNewMain: false` branch is reserved for future
  // integrations whose `backendConnectors` omit a backend. Today every
  // (integrationKey, BackendId) pair has a connector — gmail, calendar,
  // and notion all ship with claude + codex + gemini — so swapping main
  // never invalidates a delegated integration.

  it("does not mutate DB state — delegatedBackend is preserved", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    // Seed a probe row — the simplified helper no longer invalidates it.
    writeProbe(db, {
      integration: "gmail",
      backend: "claude",
      presentTools: ["mcp__claude_ai_Gmail__search_threads"],
      capabilities: [],
      missingRequired: [],
      present: true,
      probedAt: "2026-04-18T00:00:00Z",
    });

    checkDelegatedCompatForNewMain(db, "codex");

    // delegatedBackend preserved
    expect(readIntegrations(db).gmail.delegatedBackend).toBe("claude");
    // probe cache untouched
    expect(readProbe(db, "gmail", "claude")).not.toBeNull();
  });

  it("covers multiple delegated integrations independently", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const reports = checkDelegatedCompatForNewMain(db, "claude");
    const byKey = Object.fromEntries(reports.map((r) => [r.key, r]));
    expect(byKey.gmail.compatibleWithNewMain).toBe(true);
    expect(byKey.google_calendar.compatibleWithNewMain).toBe(true);
  });
});

// ── INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 ────────────────────────────────

describe("cascadeNativeBindingsOnMainSwitch (§11.4)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("flips native rows whose nativeBackend differs from the new main to disabled", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });

    const flipped = cascadeNativeBindingsOnMainSwitch(db, "codex");
    expect(flipped.map((f) => f.key).sort()).toEqual([
      "gmail",
      "google_calendar",
    ]);
    for (const entry of flipped) {
      expect(entry.priorNativeBackend).toBe("claude");
      expect(entry.newMainBackend).toBe("codex");
    }

    const stateAfter = readIntegrations(db);
    expect(stateAfter.gmail.mode).toBe("disabled");
    expect(stateAfter.gmail.nativeBackend).toBeUndefined();
    expect(stateAfter.google_calendar.mode).toBe("disabled");
  });

  it("leaves native rows whose nativeBackend matches the new main untouched", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });

    const flipped = cascadeNativeBindingsOnMainSwitch(db, "claude");
    expect(flipped).toEqual([]);
    expect(readIntegrations(db).gmail.mode).toBe("native");
    expect(readIntegrations(db).gmail.nativeBackend).toBe("claude");
  });

  it("does not affect non-native rows", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });

    const flipped = cascadeNativeBindingsOnMainSwitch(db, "codex");
    expect(flipped).toEqual([]);
    expect(readIntegrations(db).gmail.mode).toBe("delegated");
    expect(readIntegrations(db).google_calendar.mode).toBe("direct");
  });
});

describe("readMainBackend", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns the schema-seeded default backend", () => {
    // `applySchema` seeds the singleton row with default_backend='claude'.
    // The helper round-trips that value through `isBackendId`.
    expect(readMainBackend(db)).toBe("claude");
  });

  it("returns null when the singleton row is absent", () => {
    db.prepare("DELETE FROM backend_global_defaults WHERE singleton = 1").run();
    expect(readMainBackend(db)).toBeNull();
  });

  it("returns the configured backend id after an update", () => {
    db.prepare(
      `UPDATE backend_global_defaults
          SET default_backend = 'codex', updated_at = datetime('now')
        WHERE singleton = 1`,
    ).run();
    expect(readMainBackend(db)).toBe("codex");
  });

  it("returns null when default_backend is not a recognised BackendId (forward-compat)", () => {
    // The schema enforces a FK to `backends.id`; bypass by dropping the FK
    // for this test row via PRAGMA foreign_keys=OFF + a raw write. This
    // simulates registry drift after a backend is renamed in code but the
    // DB still carries the legacy value.
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `UPDATE backend_global_defaults
          SET default_backend = 'mystery', updated_at = datetime('now')
        WHERE singleton = 1`,
    ).run();
    db.pragma("foreign_keys = ON");
    expect(readMainBackend(db)).toBeNull();
  });
});

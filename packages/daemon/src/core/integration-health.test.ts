import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { writeProbe } from "../db/integration-probe-store.js";
import { evaluateProbe } from "./integration-probe.js";
import { buildIntegrationHealthMap } from "./integration-health.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("buildIntegrationHealthMap", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("emits an entry for every registered integration", () => {
    const map = buildIntegrationHealthMap(db, process.cwd());
    expect(Object.keys(map).sort()).toEqual([
      // BROWSER_HISTORY_INTEGRATION_PLAN — high-sensitivity browsing
      // integration; direct-only (no delegated, no native).
      "browser_history",
      "git",
      "github",
      "gmail",
      "google_calendar",
      "notion",
      // SETUP-FLOW-REDESIGN-PLAN §6.1 — Outlook integrations joined the
      // registry in v1 (direct-or-disabled, no MCP connectors).
      "outlook_calendar",
      "outlook_mail",
    ]);
  });

  it("returns mode-only entries for direct integrations (features null)", () => {
    writeIntegrations(db, {
      gmail: { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T00:00:00Z" },
    });
    const map = buildIntegrationHealthMap(db, process.cwd());
    expect(map.gmail).toEqual({
      mode: "direct",
      delegatedBackend: null,
      // INTEGRATION_NATIVE_MODE_DESIGN.md §9.3 — `nativeBackend` mirrors
      // `delegatedBackend`. Direct mode carries null for both.
      nativeBackend: null,
      subTier: null,
      toolNamespace: null,
      features: null,
      lastProbeAt: null,
      variantsMissing: null,
    });
  });

  it("returns mode-only entries for disabled integrations (the install default)", () => {
    const map = buildIntegrationHealthMap(db, process.cwd());
    expect(map.gmail.mode).toBe("disabled");
    expect(map.gmail.features).toBeNull();
  });

  it("falls back to descriptor defaults when no probe row exists for a delegated integration", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const map = buildIntegrationHealthMap(db, process.cwd());
    expect(map.gmail.delegatedBackend).toBe("claude");
    expect(map.gmail.toolNamespace).toBe("mcp__claude_ai_Gmail__");
    expect(map.gmail.subTier).toBe("draft-only");
    expect(map.gmail.lastProbeAt).toBeNull();
    // Descriptor defaults — Claude Gmail's optional caps; send/delete absent.
    expect(map.gmail.features?.search).toBe(true);
    expect(map.gmail.features?.draft).toBe(true);
    expect(map.gmail.features).not.toHaveProperty("send");
  });

  it("classifies Codex Gmail as full-auto sub-tier", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const map = buildIntegrationHealthMap(db, process.cwd());
    expect(map.gmail.subTier).toBe("full-auto");
    expect(map.gmail.features?.send).toBe(true);
  });

  it("uses the cached probe when one exists for the active backend", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    writeProbe(
      db,
      evaluateProbe({
        // Live tool list claims search and read are present, but draft is
        // missing — degraded delegation.
        tools: [
          "mcp__claude_ai_Gmail__search_threads",
          "mcp__claude_ai_Gmail__get_thread",
          "mcp__claude_ai_Gmail__list_labels",
          "mcp__claude_ai_Gmail__label_message",
          "mcp__claude_ai_Gmail__label_thread",
          "mcp__claude_ai_Gmail__unlabel_message",
          "mcp__claude_ai_Gmail__unlabel_thread",
        ],
        integration: "gmail",
        backend: "claude",
        probedAt: "2026-04-19T12:00:00Z",
      }),
    );
    const map = buildIntegrationHealthMap(db, process.cwd());
    expect(map.gmail.lastProbeAt).toBe("2026-04-19T12:00:00Z");
    expect(map.gmail.features?.search).toBe(true);
    expect(map.gmail.features?.draft).toBe(false);
  });

  it("returns google_calendar without a sub-tier even when delegated", () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const map = buildIntegrationHealthMap(db, process.cwd());
    expect(map.google_calendar.subTier).toBeNull();
    expect(map.google_calendar.toolNamespace).toBe(
      "mcp__claude_ai_Google_Calendar__",
    );
  });

  it("populates variantsMissing=[] when every required variant file is on disk", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const map = buildIntegrationHealthMap(db, process.cwd());
    expect(map.gmail.variantsMissing).toEqual([]);
  });

  it("returns variantsMissing=null for non-delegated integrations (no check)", () => {
    writeIntegrations(db, {
      gmail: { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T00:00:00Z" },
    });
    const map = buildIntegrationHealthMap(db, process.cwd());
    expect(map.gmail.variantsMissing).toBeNull();
  });

  it("lists missing variant paths when the workspace lacks required files (notion)", () => {
    writeIntegrations(db, {
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const map = buildIntegrationHealthMap(db, "/tmp/pa-nonexistent-root");
    expect(map.notion.variantsMissing?.length).toBeGreaterThan(0);
    for (const p of map.notion.variantsMissing ?? []) {
      expect(p).toContain("/tmp/pa-nonexistent-root");
    }
  });

  it("DELEGATED-MODE-V2 §11 Phase 3 — gmail / google_calendar now also surface missing variants when their `SKILL.delegated.<sessionBackend>.md` files are absent from the workspace", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const map = buildIntegrationHealthMap(db, "/tmp/pa-nonexistent-root");
    expect(map.gmail.variantsMissing?.length).toBeGreaterThan(0);
  });

  // The "no connector descriptor for this backend" graceful-degradation
  // branch is reserved for future integrations that omit a backend.
  // Today every (integrationKey, BackendId) pair has a connector —
  // gemini delegation for gmail / calendar / notion all return populated
  // toolNamespace + subTier values.
});

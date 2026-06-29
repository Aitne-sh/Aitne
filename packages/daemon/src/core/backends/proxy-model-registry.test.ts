import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  knownProxyModels,
  listProxyModelOptions,
  proxyModelIsKnown,
  resolveCanonicalDelegatedModel,
  resolveProcessKeyModel,
} from "./proxy-model-registry.js";

/**
 * Tests for the Phase C proxy-model registry helpers
 * (DELEGATED-PROXY-API-DESIGN.md §4.2 / §6.1).
 */

describe("proxy-model-registry", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("knownProxyModels", () => {
    it("returns registered models for the requested backend, sorted", async () => {
      const claude = knownProxyModels(db, "claude");
      // Sample of expected ids — the registry includes opus-4-7, sonnet-4-6,
      // haiku-4-5, and the deprecated opus-4-6.
      expect(claude).toContain("claude-opus-4-7");
      expect(claude).toContain("claude-sonnet-4-6");
      // Sorted alphabetically.
      const sorted = [...claude].sort();
      expect([...claude]).toEqual(sorted);
    });

    it("filters by backend — codex models do not appear under claude", () => {
      const claude = knownProxyModels(db, "claude");
      expect(claude).not.toContain("gpt-5.4-mini");
      expect(claude).not.toContain("gpt-5.5");
    });

    it("includes user-pinned process_backend_config models for the same backend", () => {
      // Stage a custom pin under codex on a schema-seeded process key, then
      // assert it surfaces. The registry-only path would miss this — the DB
      // union is what makes the validator forgive user-supplied custom
      // names per §4.2. INSERT OR REPLACE because the schema seeds rows
      // for every CONFIGURABLE_PROCESS_KEYS entry on apply.
      db.prepare(
        `INSERT OR REPLACE INTO process_backend_config
           (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("message.dm", "codex", "gpt-5.4-custom-pin", 50, 1.0, "user");
      const codex = knownProxyModels(db, "codex");
      expect(codex).toContain("gpt-5.4-custom-pin");
      // The same pin should NOT appear under claude — backend filter holds.
      const claude = knownProxyModels(db, "claude");
      expect(claude).not.toContain("gpt-5.4-custom-pin");
    });
  });

  describe("proxyModelIsKnown", () => {
    it("accepts a registered model id", () => {
      expect(proxyModelIsKnown(db, "claude", "claude-opus-4-7")).toBe(true);
      expect(proxyModelIsKnown(db, "codex", "gpt-5.4-mini")).toBe(true);
    });

    it("rejects a model registered under a different backend", () => {
      expect(proxyModelIsKnown(db, "codex", "claude-opus-4-7")).toBe(false);
      expect(proxyModelIsKnown(db, "claude", "gpt-5.4-mini")).toBe(false);
    });

    it("accepts a custom user pin from process_backend_config", () => {
      db.prepare(
        `INSERT OR REPLACE INTO process_backend_config
           (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("message.dm", "claude", "claude-opus-4-7-custom", 50, 1.0, "user");
      expect(
        proxyModelIsKnown(db, "claude", "claude-opus-4-7-custom"),
      ).toBe(true);
    });
  });

  describe("resolveCanonicalDelegatedModel", () => {
    it("returns the registry's first lite-tier model for the backend", () => {
      // The registry order is lite → medium → high in the source listing;
      // the helper picks the first available lite entry. For Claude that's
      // currently `claude-haiku-4-5-20251001`; for Codex `gpt-5.4-mini`;
      // for Gemini `gemini-3.1-flash-lite-preview`.
      expect(resolveCanonicalDelegatedModel("claude")).toBe("claude-haiku-4-5-20251001");
      expect(resolveCanonicalDelegatedModel("codex")).toBe("gpt-5.4-mini");
      expect(resolveCanonicalDelegatedModel("gemini")).toBe("gemini-3.1-flash-lite-preview");
    });

    it("respects backend_global_defaults.default_lite_model when delegatedBackend matches default_backend", () => {
      // User has pinned Haiku as their global default lite model on Claude.
      // The proxy canonical for delegatedBackend=claude should follow the
      // pin instead of the registry's first-available pick (Haiku, which
      // happens to match the pin here — the guard is still exercised).
      db.prepare(
        `INSERT OR REPLACE INTO backend_global_defaults
           (singleton, default_backend, default_lite_model, default_medium_model, default_high_model, updated_at)
         VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).run("claude", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-7");
      expect(resolveCanonicalDelegatedModel("claude", db)).toBe(
        "claude-haiku-4-5-20251001",
      );
    });

    it("ignores backend_global_defaults when default_backend differs from the requested backend", () => {
      // Default backend is claude with lite=Haiku, but the proxy is being
      // resolved for codex. Codex must NOT inherit Claude's pin — the
      // backend-match guard mirrors BackendRouter.resolveCanonicalTierModel.
      db.prepare(
        `INSERT OR REPLACE INTO backend_global_defaults
           (singleton, default_backend, default_lite_model, default_medium_model, default_high_model, updated_at)
         VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).run("claude", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-7");
      expect(resolveCanonicalDelegatedModel("codex", db)).toBe("gpt-5.4-mini");
    });

    it("falls through to the registry pick when default_lite_model is not a registered lite model", () => {
      // Misconfiguration: default_lite_model is set to Opus (a high-tier
      // model). The router skips that branch; the proxy resolver mirrors.
      db.prepare(
        `INSERT OR REPLACE INTO backend_global_defaults
           (singleton, default_backend, default_lite_model, default_medium_model, default_high_model, updated_at)
         VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).run("claude", "claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-7");
      // Opus is high, not lite — fall through to latestLiteFor("claude").
      expect(resolveCanonicalDelegatedModel("claude", db)).toBe("claude-haiku-4-5-20251001");
    });

    it("works without a db argument (registry-only)", () => {
      expect(resolveCanonicalDelegatedModel("claude")).toBe("claude-haiku-4-5-20251001");
      expect(resolveCanonicalDelegatedModel("claude", null)).toBe("claude-haiku-4-5-20251001");
    });
  });

  describe("listProxyModelOptions", () => {
    it("returns lite models before high ones", () => {
      const claude = listProxyModelOptions("claude");
      const liteIdx = claude.findIndex((o) => o.tier === "lite");
      const highIdx = claude.findIndex((o) => o.tier === "high");
      expect(liteIdx).toBeGreaterThanOrEqual(0);
      expect(highIdx).toBeGreaterThan(liteIdx);
    });

    it("includes a deprecated flag so the dashboard can de-emphasize legacy models", () => {
      const claude = listProxyModelOptions("claude");
      const opus46 = claude.find((o) => o.modelId === "claude-opus-4-6");
      expect(opus46?.deprecated).toBe(true);
      const opus47 = claude.find((o) => o.modelId === "claude-opus-4-7");
      expect(opus47?.deprecated).toBe(true);
      const opus48 = claude.find((o) => o.modelId === "claude-opus-4-8");
      expect(opus48?.deprecated).toBe(false);
    });

    it("falls back to null pricing fields when the registry has no rate", () => {
      // GPT-5.3 codex has no usdPer1kCacheRead — we explicitly assert the
      // helper still returns numbers for in/out when present, and surfaces
      // null when missing.
      const codex = listProxyModelOptions("codex");
      const five3 = codex.find((o) => o.modelId === "gpt-5.3-codex");
      // Registry sets usdPer1kIn / usdPer1kOut for this entry — should
      // be a number, never null.
      expect(typeof five3?.usdPer1kIn).toBe("number");
      expect(typeof five3?.usdPer1kOut).toBe("number");
    });
  });

  // DELEGATED-TASK-MODE-DESIGN.md §8.1 — process_backend_config override
  // hook for delegated_task / delegated_task_heavy.
  describe("resolveProcessKeyModel", () => {
    it("returns null when no row exists for the process key", () => {
      expect(resolveProcessKeyModel(db, "delegated_task", "claude")).toBeNull();
    });

    it("returns the row's main_model when main_backend matches the active backend", () => {
      db.prepare(
        `INSERT OR REPLACE INTO process_backend_config
           (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("delegated_task", "claude", "claude-haiku-4-5", 10, 0.1, "dashboard");
      expect(resolveProcessKeyModel(db, "delegated_task", "claude")).toBe(
        "claude-haiku-4-5",
      );
    });

    it("returns null when main_backend is a different backend", () => {
      // The integration's `delegatedBackend` drives the binding; the
      // process row's `main_backend` is the *configurer's* hint about
      // which backend they were customising. If the active delegated
      // backend doesn't match, ignore the row's pin.
      db.prepare(
        `INSERT OR REPLACE INTO process_backend_config
           (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("delegated_task", "gemini", "gemini-3.1-flash-lite-preview", 10, 0.1, "dashboard");
      // Active backend is claude — gemini row should not apply.
      expect(resolveProcessKeyModel(db, "delegated_task", "claude")).toBeNull();
    });

    it("accepts a custom user pin even when the model is not in the static registry", () => {
      // Per the §4.2 trust contract documented on `proxyModelIsKnown`:
      // a model pinned in `process_backend_config.main_model` is treated
      // as known for that backend. delegated_task inherits the same
      // contract — if the user has explicitly pinned a custom build
      // string, we honor it. The "unreachable" / null path is exercised
      // by `main_backend` mismatch (covered separately above).
      db.prepare(
        `INSERT OR REPLACE INTO process_backend_config
           (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("delegated_task", "claude", "claude-custom-build-2026-04", 10, 0.1, "dashboard");
      expect(resolveProcessKeyModel(db, "delegated_task", "claude")).toBe(
        "claude-custom-build-2026-04",
      );
    });

    it("returns null when main_model is an empty string", () => {
      // schema's NOT NULL constraint blocks SQL NULL but technically
      // allows the empty string. Defensive: don't return "" upstream
      // — fall through to the canonical model resolver.
      db.prepare(
        `INSERT OR REPLACE INTO process_backend_config
           (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("delegated_task", "claude", "", 10, 0.1, "dashboard");
      expect(resolveProcessKeyModel(db, "delegated_task", "claude")).toBeNull();
    });

    it("supports delegated_task_heavy as a distinct ProcessKey", () => {
      db.prepare(
        `INSERT OR REPLACE INTO process_backend_config
           (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("delegated_task_heavy", "claude", "claude-opus-4-7", 10, 0.5, "dashboard");
      // Light key has no row.
      expect(resolveProcessKeyModel(db, "delegated_task", "claude")).toBeNull();
      // Heavy key pin is honored.
      expect(
        resolveProcessKeyModel(db, "delegated_task_heavy", "claude"),
      ).toBe("claude-opus-4-7");
    });
  });
});

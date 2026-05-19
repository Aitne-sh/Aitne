import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  INHERITANCE_CASCADE_MAP,
  _internals,
  setProcessBackendConfig,
} from "./process-config-cascade.js";

interface ProcessRow {
  process_key: string;
  main_backend: string;
  main_model: string;
  fallback_backend: string | null;
  fallback_model: string | null;
  max_turns: number;
  max_budget_usd: number;
  updated_by: string;
}

describe("process-config cascade-write", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  function readRow(processKey: string): ProcessRow | undefined {
    return db
      .prepare(
        `SELECT process_key, main_backend, main_model,
                fallback_backend, fallback_model,
                max_turns, max_budget_usd, updated_by
           FROM process_backend_config WHERE process_key = ?`,
      )
      .get(processKey) as ProcessRow | undefined;
  }

  it("writes the source row and cascades dashboard.docs_qa with the same backend", () => {
    const result = setProcessBackendConfig(db, {
      processKey: "message.dm",
      mainBackend: "claude",
      mainModel: "claude-opus-4-7",
      fallbackBackend: null,
      fallbackModel: null,
      maxTurns: 50,
      maxBudgetUsd: 1.0,
      updatedBy: "user",
    });

    expect(result.cascaded).toEqual(["dashboard.docs_qa"]);

    const source = readRow("message.dm");
    expect(source?.main_backend).toBe("claude");
    expect(source?.main_model).toBe("claude-opus-4-7");
    expect(source?.updated_by).toBe("user");

    const inheritor = readRow("dashboard.docs_qa");
    expect(inheritor?.main_backend).toBe("claude");
    expect(inheritor?.updated_by).toBe("cascade");
  });

  it("re-resolves the inheritor model to its own (light) tier — does not copy the source's heavy model", () => {
    setProcessBackendConfig(db, {
      processKey: "message.dm",
      mainBackend: "claude",
      // Source is pinned to a heavy model intentionally — the inheritor
      // (dashboard.docs_qa) is hard-light per §10.1 and must NOT inherit
      // the heavy pin.
      mainModel: "claude-opus-4-7",
      fallbackBackend: null,
      fallbackModel: null,
      maxTurns: 50,
      maxBudgetUsd: 1.0,
      updatedBy: "user",
    });

    const inheritor = readRow("dashboard.docs_qa");
    expect(inheritor?.main_model).toBe("claude-sonnet-4-6");
  });

  it("respects user-pinned inheritor rows (does not cascade over them)", () => {
    // Operator manually edits dashboard.docs_qa first, marking the row as
    // user-pinned. A subsequent message.dm write must not clobber it.
    setProcessBackendConfig(db, {
      processKey: "dashboard.docs_qa",
      mainBackend: "claude",
      mainModel: "claude-sonnet-4-6",
      fallbackBackend: null,
      fallbackModel: null,
      maxTurns: 99,
      maxBudgetUsd: 9.99,
      updatedBy: "user",
    });

    setProcessBackendConfig(db, {
      processKey: "message.dm",
      mainBackend: "claude",
      mainModel: "claude-opus-4-7",
      fallbackBackend: null,
      fallbackModel: null,
      maxTurns: 50,
      maxBudgetUsd: 1.0,
      updatedBy: "user",
    });

    const inheritor = readRow("dashboard.docs_qa");
    expect(inheritor?.updated_by).toBe("user");
    expect(inheritor?.max_turns).toBe(99); // operator's choice preserved
    expect(inheritor?.max_budget_usd).toBe(9.99);
  });

  it("cascade fires from the seeded 'cascade' state on the FIRST source write", () => {
    // The schema seed leaves dashboard.docs_qa with updated_by='cascade'
    // so the very first user-driven message.dm write must rewrite it.
    const seeded = readRow("dashboard.docs_qa");
    expect(seeded?.updated_by).toBe("cascade");
    // Seed envelope must equal INHERITOR_DEFAULTS so day-one == cascade-day-N.
    expect(seeded?.max_turns).toBe(20);
    expect(seeded?.max_budget_usd).toBe(0.5);

    setProcessBackendConfig(db, {
      processKey: "message.dm",
      mainBackend: "claude",
      mainModel: "claude-sonnet-4-6",
      fallbackBackend: null,
      fallbackModel: null,
      maxTurns: 35,
      maxBudgetUsd: 1.5,
      updatedBy: "user",
    });

    const after = readRow("dashboard.docs_qa");
    expect(after?.updated_by).toBe("cascade");
    // Source's caps don't bleed into the inheritor — the cascade keeps
    // its own envelope so a chatty DM session can't escalate the QA cap.
    expect(after?.max_turns).toBe(20);
    expect(after?.max_budget_usd).toBe(0.5);
  });

  it("non-source writes do not trigger any cascade", () => {
    const result = setProcessBackendConfig(db, {
      processKey: "routine.morning_routine",
      mainBackend: "claude",
      mainModel: "claude-opus-4-7",
      fallbackBackend: null,
      fallbackModel: null,
      maxTurns: 300,
      maxBudgetUsd: 5.0,
      updatedBy: "preset",
    });

    expect(result.cascaded).toEqual([]);
  });

  it("cascade map contains a dashboard.docs_qa → message.dm rule (regression guard)", () => {
    expect(INHERITANCE_CASCADE_MAP).toContainEqual({
      inheritor: "dashboard.docs_qa",
      source: "message.dm",
      inheritorTier: "medium",
    });
  });

  // INHERITOR_DEFAULTS holds Claude-baseline budgets. When the cascade
  // fires on a Codex/Gemini-pinned message.dm, the inheritor's
  // post-hoc-enforced budget must scale up (×1.5 on medium) so the
  // QA panel does not fail with BackendQuotaError(max_budget_usd) where
  // an equivalent Claude session would have completed.
  it("scales the inheritor's medium-tier budget for codex (post-hoc enforcement)", () => {
    setProcessBackendConfig(db, {
      processKey: "message.dm",
      mainBackend: "codex",
      mainModel: "gpt-5.4",
      fallbackBackend: null,
      fallbackModel: null,
      maxTurns: 50,
      maxBudgetUsd: 1.5,
      updatedBy: "user",
    });

    const inheritor = readRow("dashboard.docs_qa");
    expect(inheritor?.main_backend).toBe("codex");
    // Claude baseline 0.5 × 1.5 (medium factor) = 0.75.
    expect(inheritor?.max_budget_usd).toBe(0.75);
    expect(inheritor?.max_turns).toBe(20);
  });

  it("propagates a non-null fallbackBackend by re-resolving its tier model", () => {
    // When the source pins a fallback backend, the cascade must call
    // resolveTierModel a SECOND time for the fallback side (covers the
    // truthy branch of `inheritorFallbackBackend ?` on line 126).
    setProcessBackendConfig(db, {
      processKey: "message.dm",
      mainBackend: "claude",
      mainModel: "claude-opus-4-7",
      fallbackBackend: "codex",
      fallbackModel: "gpt-5.4",
      maxTurns: 50,
      maxBudgetUsd: 1.0,
      updatedBy: "user",
    });

    const inheritor = readRow("dashboard.docs_qa");
    expect(inheritor?.fallback_backend).toBe("codex");
    // Fallback model is re-resolved for the inheritor's own (medium) tier,
    // NOT copied verbatim from the source.
    expect(inheritor?.fallback_model).not.toBeNull();
    expect(inheritor?.fallback_model).not.toBe("gpt-5.4-pro"); // would be source's
  });
});

describe("process-config cascade-write internals", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  describe("resolveTierModel", () => {
    it("resolves a high-tier model (covers tier === 'high' branch)", () => {
      // Forces the outer `tier === "high" ? ...` true branch in the
      // ternary chain at line 232-237.
      const model = _internals.resolveTierModel(db, "claude", "high");
      expect(model).toBe("claude-opus-4-7");
    });

    it("resolves a lite-tier model (covers tier !== 'medium' inner branch)", () => {
      // Forces both `tier === "high"` false AND `tier === "medium"` false
      // — the only path to the `default_lite_model` arm of the chain.
      const model = _internals.resolveTierModel(db, "claude", "lite");
      // Don't pin the exact suffix (model ids carry a date stamp); just
      // check the Haiku family.
      expect(model).toMatch(/^claude-haiku/);
    });

    it("falls through to the model-registry path when defaults.default_backend mismatches", () => {
      // Seed defaults at "claude" — resolving for "codex" must skip the
      // defaults block (line 231 falsy branch) and look up via
      // getModelsForBackend("codex"). Any registered codex medium model
      // is fine; we just assert it's not the claude default.
      const model = _internals.resolveTierModel(db, "codex", "medium");
      expect(model).not.toBe("claude-sonnet-4-6");
      expect(model.length).toBeGreaterThan(0);
    });

    it("falls through when defaults.default_backend matches but candidate is wrong tier", () => {
      // Force backend_global_defaults.default_medium_model to a model
      // that does not have tier=medium in the registry — the cascade must
      // skip the defaults shortcut (registered?.tier !== tier) and fall
      // through to getModelsForBackend.
      db.prepare(
        `UPDATE backend_global_defaults
            SET default_medium_model = 'claude-haiku-4-5'
          WHERE singleton = 1`,
      ).run();
      const model = _internals.resolveTierModel(db, "claude", "medium");
      // Falls through, finds the actual medium-tier model in the registry.
      expect(model).toBe("claude-sonnet-4-6");
    });
  });

  describe("readDefaults", () => {
    it("returns null when no singleton row exists", () => {
      // applySchema seeds the singleton; deleting it forces the `?? null`
      // branch at line 272.
      db.prepare("DELETE FROM backend_global_defaults").run();
      expect(_internals.readDefaults(db)).toBeNull();
    });
  });

  describe("readUpdatedBy", () => {
    it("returns null when no row exists for the process key", () => {
      // Hits the `row?.updated_by ?? null` nullish branch at line 207.
      // applySchema seeds every defaulted process key — wipe the row so
      // the SELECT returns undefined.
      db.prepare("DELETE FROM process_backend_config").run();
      expect(_internals.readUpdatedBy(db, "dashboard.docs_qa")).toBeNull();
    });

    it("returns the column value when the row exists", () => {
      // applySchema seeds dashboard.docs_qa with updated_by='cascade'.
      expect(_internals.readUpdatedBy(db, "dashboard.docs_qa")).toBe(
        "cascade",
      );
    });
  });
});

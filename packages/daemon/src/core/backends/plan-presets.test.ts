import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  applyDefaultPresets,
  inferTierForModel,
  previewMainSwitchImpact,
  resolveDefaultBindingFor,
  setMainBackend,
} from "./plan-presets.js";
import type { BackendId } from "@aitne/shared";
import {
  DEFAULT_CLAUDE_HIGH_MODEL,
  DEFAULT_CLAUDE_LITE_MODEL,
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  DEFAULT_CODEX_LITE_MODEL,
  DEFAULT_CODEX_MEDIUM_MODEL,
  DEFAULT_GEMINI_LITE_MODEL,
  DEFAULT_GEMINI_MEDIUM_MODEL,
  DEFAULT_OPENCODE_HIGH_MODEL,
  DEFAULT_OPENCODE_LITE_MODEL,
  DEFAULT_OPENCODE_MEDIUM_MODEL,
} from "./model-registry.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

describe("resolveDefaultBindingFor", () => {
  it("seeds Sonnet and the bare medium nominal for un-overridden medium keys on Claude", () => {
    // `message.mention` rides the bare medium-tier envelope (no entry in
    // ENVELOPE_OVERRIDES_BY_PROCESS_KEY), so it pins the tier nominal.
    // (message.dm USED to be this fixture but now carries a $5.00
    // override — see the dedicated test below.)
    const binding = resolveDefaultBindingFor("claude", "message.mention");
    expect(binding.model).toBe(DEFAULT_CLAUDE_MEDIUM_MODEL);
    expect(binding.maxTurns).toBe(50);
    expect(binding.maxBudgetUsd).toBe(1.0);
  });

  // message.dm carries a wider $5.00 per-turn ceiling than the medium
  // nominal because each turn re-processes the full DM history and
  // routinely runs $0.70-0.80 on Sonnet — legitimate multi-step turns
  // tipped over $1.00 mid-turn and surfaced BackendQuotaError(
  // max_budget_usd). A `force: true` reset MUST land on 50/$5.00, not
  // the medium nominal 50/$1.00. Kept in lock-step with the schema seed.
  it("preserves the message.dm $5.00 envelope override on top of the medium tier", () => {
    const binding = resolveDefaultBindingFor("claude", "message.dm");
    expect(binding.model).toBe(DEFAULT_CLAUDE_MEDIUM_MODEL);
    expect(binding.maxTurns).toBe(50);
    expect(binding.maxBudgetUsd).toBe(5.0);
  });

  it("seeds Haiku and a tighter envelope for lite-tier keys on Claude", () => {
    const binding = resolveDefaultBindingFor("claude", "gmail_classify");
    expect(binding.model).toBe(DEFAULT_CLAUDE_LITE_MODEL);
    expect(binding.maxTurns).toBe(20);
    expect(binding.maxBudgetUsd).toBe(0.2);
  });

  it("seeds Opus and a generous envelope for high-tier keys on Claude", () => {
    // `routine.morning_routine_initial` was the canonical high-tier
    // process key used to exercise this path until Phase 7 (2026-05-16)
    // retired it; `setup` and `knowledge.import` were the last two
    // seeded high-tier surfaces until 2026-05-16, when both were
    // demoted to medium tier (Sonnet) as part of the "no Opus by
    // default" pass. `delegated_task_heavy` is now the only `high`-
    // tagged process key in the registry — it is opt-in (gated by the
    // `delegatedTaskHeavyEnabled` config flag) but still resolves
    // through the same high-tier seed path, so it's the right surface
    // to exercise here.
    const binding = resolveDefaultBindingFor("claude", "delegated_task_heavy");
    expect(binding.model).toBe(DEFAULT_CLAUDE_HIGH_MODEL);
    expect(binding.maxTurns).toBe(80);
    expect(binding.maxBudgetUsd).toBe(3.0);
  });

  // The roadmap-refresh envelope override exists because the session
  // itself drives Calendar/Mail/Notion MCP fan-out in `native` integration
  // mode (no `routine.fetch_window` pre-pass attached). A `force: true`
  // reset MUST land on 60/$3.00, not the medium tier's nominal 50/$1.00 —
  // otherwise BackendQuotaError(max_budget_usd) returns on the next
  // native-mode roadmap dispatch. The envelope is kept in lock-step with
  // the schema seed; if either side moves, this test pins them.
  it("preserves the roadmap-refresh envelope override on top of the medium tier", () => {
    const binding = resolveDefaultBindingFor(
      "claude",
      "routine.roadmap_refresh",
    );
    expect(binding.model).toBe(DEFAULT_CLAUDE_MEDIUM_MODEL);
    expect(binding.maxTurns).toBe(60);
    expect(binding.maxBudgetUsd).toBe(3.0);
  });

  // morning-routine-optimization.md Phase 5 — Stage A / Stage B envelope
  // overrides. Stage B's $0.30 cap is the realigned value after production
  // observed Stage B's ~21 KB prompt + Haiku cache_creation tripping the
  // previous $0.10 cap mid-turn (BackendQuotaError(max_budget_usd))
  // before the daily/<yesterday>.md PUT could fire. Pinned here so a
  // future `force: true` reset cannot silently regress it to the
  // lite-tier nominal $0.20, and so the lock-step invariant with the
  // schema seed is enforced at test time.
  it("preserves the morning-routine Stage A envelope override", () => {
    const binding = resolveDefaultBindingFor(
      "claude",
      "routine.morning_routine_today",
    );
    expect(binding.model).toBe(DEFAULT_CLAUDE_MEDIUM_MODEL);
    expect(binding.maxTurns).toBe(50);
    expect(binding.maxBudgetUsd).toBe(1.5);
  });

  it("preserves the morning-routine Stage B envelope override", () => {
    const binding = resolveDefaultBindingFor(
      "claude",
      "routine.morning_routine_journal",
    );
    expect(binding.model).toBe(DEFAULT_CLAUDE_LITE_MODEL);
    expect(binding.maxTurns).toBe(20);
    expect(binding.maxBudgetUsd).toBe(0.3);
  });

  // wiki.lint sits on medium tier but with a tighter 40/$0.50 envelope.
  // Lint is a structured pass over the index + recent log entries; it
  // does not need the full medium-tier headroom and a runaway prompt
  // should fail fast.
  it("preserves the wiki.lint envelope override on top of the medium tier", () => {
    const binding = resolveDefaultBindingFor("claude", "wiki.lint");
    expect(binding.model).toBe(DEFAULT_CLAUDE_MEDIUM_MODEL);
    expect(binding.maxTurns).toBe(40);
    expect(binding.maxBudgetUsd).toBe(0.5);
  });

  // Codex enforces the per-turn budget post-hoc (the CLI runs to
  // completion, then the daemon rejects if actual cost > cap). The
  // Claude-baseline lite ceiling fails Codex sessions that an
  // equivalent Claude run would have truncated mid-turn, so the
  // post-hoc cap scales up by the BACKEND_BUDGET_FACTOR (lite × 2.5).
  // Uses `gmail_classify` (lite tier, no per-process override) so this
  // test pins the pure tier-default scaling rather than an override.
  it("scales lite-tier envelopes for codex (post-hoc enforcement)", () => {
    const binding = resolveDefaultBindingFor("codex", "gmail_classify");
    expect(binding.maxTurns).toBe(20);
    expect(binding.maxBudgetUsd).toBe(0.5);
  });

  it("scales medium-tier envelopes for gemini (post-hoc enforcement)", () => {
    // Uses `message.mention` (medium tier, no per-process override) so
    // this test pins the pure tier-default scaling (1.0 × 1.5) rather
    // than message.dm's $5.00 override.
    const binding = resolveDefaultBindingFor("gemini", "message.mention");
    expect(binding.maxTurns).toBe(50);
    expect(binding.maxBudgetUsd).toBe(1.5);
  });

  it("scales high-tier envelopes for codex (post-hoc enforcement)", () => {
    // `routine.morning_routine_initial` was the canonical high-tier
    // fixture until Phase 7 retired it; `knowledge.import` took over
    // until 2026-05-16, when both `knowledge.import` and `setup` were
    // demoted to medium tier as part of the "no Opus by default" pass.
    // `delegated_task_heavy` is now the only `high`-tagged process key
    // and is the right fixture for the high-tier scaling assertion.
    const binding = resolveDefaultBindingFor("codex", "delegated_task_heavy");
    expect(binding.maxTurns).toBe(80);
    expect(binding.maxBudgetUsd).toBe(5);
  });

  // OpenCode rides the same Anthropic SDK as Claude — it aborts
  // mid-turn at the cap, so the post-hoc factor is 1 (no scaling).
  // Uses `gmail_classify` (lite tier, no per-process override) so this
  // test pins the pure tier-default rather than an override.
  it("keeps Claude-baseline envelopes for opencode (in-flight enforcement)", () => {
    const binding = resolveDefaultBindingFor("opencode", "gmail_classify");
    expect(binding.maxTurns).toBe(20);
    expect(binding.maxBudgetUsd).toBe(0.2);
  });
});

describe("applyDefaultPresets", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("rewrites configurable rows when force=true even over operator-pinned 'user' rows", () => {
    // Simulate an operator pin so we can verify force:true clobbers it.
    db.prepare(
      `UPDATE process_backend_config
          SET updated_by = 'user', main_backend = 'gemini'
        WHERE process_key = 'message.dm'`,
    ).run();

    const result = applyDefaultPresets(db, {
      defaultBackend: "claude",
      force: true,
    });
    expect(result.backend).toBe("claude");
    expect(result.processRowsUpdated).toBeGreaterThan(0);
    expect(result.processRowsSkipped).toBe(0);
    expect(result.defaultsUpdated).toBe(true);

    // Spot-check the operator-pinned row was rewritten with updated_by='preset'.
    const dmRow = db
      .prepare(
        `SELECT updated_by, main_backend FROM process_backend_config WHERE process_key = 'message.dm'`,
      )
      .get() as { updated_by: string; main_backend: string };
    expect(dmRow.updated_by).toBe("preset");
    expect(dmRow.main_backend).toBe("claude");
  });

  // End-to-end pin: force=true MUST land roadmap-refresh on the
  // override envelope, not the medium tier default. This is the
  // regression that the per-key override exists to prevent.
  it("force=true lands routine.roadmap_refresh on the 60/$3.00 envelope, not the medium default", () => {
    applyDefaultPresets(db, { defaultBackend: "claude", force: true });
    const row = db
      .prepare(
        `SELECT main_model, max_turns, max_budget_usd
           FROM process_backend_config
          WHERE process_key = 'routine.roadmap_refresh'`,
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(row.main_model).toBe(DEFAULT_CLAUDE_MEDIUM_MODEL);
    expect(row.max_turns).toBe(60);
    expect(row.max_budget_usd).toBe(3.0);
  });

  // WIKI_BUILDER_DESIGN.md Phase 3 — lint's tight 40/$0.50 envelope is a
  // deliberate divergence from the medium tier default (50/$1.00). Without
  // an explicit override entry, force=true would silently widen it back to
  // the medium default. Same lock-step regression as roadmap-refresh.
  it("force=true lands wiki.lint on the 40/$0.50 envelope, not the medium default", () => {
    applyDefaultPresets(db, { defaultBackend: "claude", force: true });
    const row = db
      .prepare(
        `SELECT main_model, max_turns, max_budget_usd
           FROM process_backend_config
          WHERE process_key = 'wiki.lint'`,
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(row.main_model).toBe(DEFAULT_CLAUDE_MEDIUM_MODEL);
    expect(row.max_turns).toBe(40);
    expect(row.max_budget_usd).toBe(0.5);
  });

  // Structural fix for the Codex/Gemini/OpenCode main-backend switch:
  // schema-seeded rows must cascade on a `force:false` apply so the
  // operator's wizard choice actually lands across every process key
  // (previously the seed was `updated_by='user'` and all rows survived
  // a main switch, pinning routine.fetch_window etc. to claude even
  // after switching to codex — breaking native-mode google_calendar
  // pre-pass).
  it("rewrites schema-seeded 'preset' rows when force is false", () => {
    const result = applyDefaultPresets(db, {
      defaultBackend: "gemini",
      force: false,
    });
    expect(result.processRowsUpdated).toBeGreaterThan(0);
    expect(result.processRowsSkipped).toBe(0);

    const fetchWindow = db
      .prepare(
        `SELECT main_backend, updated_by FROM process_backend_config WHERE process_key = 'routine.fetch_window'`,
      )
      .get() as { main_backend: string; updated_by: string };
    expect(fetchWindow.main_backend).toBe("gemini");
    expect(fetchWindow.updated_by).toBe("preset");
  });

  // Lock-step regression test for ENVELOPE_OVERRIDES_BY_PROCESS_KEY.
  //
  // Before the schema-seed marker fix (`'user'` → `'preset'`),
  // schema-seed envelope values were locked in for the install's
  // lifetime — `applyDefaultPresets(force:false)` could not touch them.
  // With the fix, apply-defaults now re-seeds every preset row. That
  // means ENVELOPE_OVERRIDES_BY_PROCESS_KEY must list EVERY process key
  // whose schema-seed envelope differs from its tier default, or the
  // re-seed silently shrinks/widens the envelope to the tier nominal.
  //
  // This test walks every schema-seeded row, snapshots its envelope
  // before any apply call, runs apply-defaults(force:false) on the
  // same backend (claude — the install default), and asserts every
  // envelope round-trips unchanged. If a future process key gets a
  // custom schema-seed envelope without a matching entry in
  // ENVELOPE_OVERRIDES_BY_PROCESS_KEY, this test fires.
  it("preserves every schema-seed envelope across apply-defaults force:false", () => {
    const before = db
      .prepare(
        `SELECT process_key, max_turns, max_budget_usd
           FROM process_backend_config
          WHERE updated_by IN ('preset', 'cascade')
          ORDER BY process_key`,
      )
      .all() as { process_key: string; max_turns: number; max_budget_usd: number }[];

    expect(before.length).toBeGreaterThan(0); // sanity: schema actually seeded rows

    applyDefaultPresets(db, { defaultBackend: "claude", force: false });

    const after = db
      .prepare(
        `SELECT process_key, max_turns, max_budget_usd
           FROM process_backend_config
          ORDER BY process_key`,
      )
      .all() as { process_key: string; max_turns: number; max_budget_usd: number }[];

    const afterByKey = new Map(after.map((r) => [r.process_key, r]));

    for (const seeded of before) {
      const reseeded = afterByKey.get(seeded.process_key);
      expect(
        reseeded,
        `process key ${seeded.process_key} disappeared after apply-defaults`,
      ).toBeDefined();
      expect(
        reseeded?.max_turns,
        `${seeded.process_key} max_turns drifted: schema ${seeded.max_turns} → after ${reseeded?.max_turns}. Add an entry to ENVELOPE_OVERRIDES_BY_PROCESS_KEY.`,
      ).toBe(seeded.max_turns);
      expect(
        reseeded?.max_budget_usd,
        `${seeded.process_key} max_budget_usd drifted: schema ${seeded.max_budget_usd} → after ${reseeded?.max_budget_usd}. Add an entry to ENVELOPE_OVERRIDES_BY_PROCESS_KEY.`,
      ).toBe(seeded.max_budget_usd);
    }
  });

  // Same invariant for `force:true` (Reset to defaults) — every
  // schema-seed envelope must survive a reset. This protects against
  // an operator clicking "Reset" and silently losing a tighter
  // envelope (e.g., the 1-turn ceiling on observation.summarize that
  // is defense-in-depth for the prompt's "no tools" contract).
  it("preserves every schema-seed envelope across apply-defaults force:true", () => {
    const before = db
      .prepare(
        `SELECT process_key, max_turns, max_budget_usd
           FROM process_backend_config
          ORDER BY process_key`,
      )
      .all() as { process_key: string; max_turns: number; max_budget_usd: number }[];

    applyDefaultPresets(db, { defaultBackend: "claude", force: true });

    const after = db
      .prepare(
        `SELECT process_key, max_turns, max_budget_usd
           FROM process_backend_config
          ORDER BY process_key`,
      )
      .all() as { process_key: string; max_turns: number; max_budget_usd: number }[];

    const afterByKey = new Map(after.map((r) => [r.process_key, r]));

    for (const seeded of before) {
      const reseeded = afterByKey.get(seeded.process_key);
      expect(reseeded).toBeDefined();
      expect(
        reseeded?.max_turns,
        `${seeded.process_key} max_turns drifted under force:true`,
      ).toBe(seeded.max_turns);
      expect(
        reseeded?.max_budget_usd,
        `${seeded.process_key} max_budget_usd drifted under force:true`,
      ).toBe(seeded.max_budget_usd);
    }
  });

  // Inverse invariant: an operator pin set via /settings/models
  // (updated_by='user') must survive a `force:false` main-backend
  // switch. This is what protects an operator who deliberately pinned a
  // process key to a non-default backend (e.g., cheaper Haiku for
  // routine.fetch_window) from a wizard re-run silently wiping their
  // choice.
  it("preserves operator-pinned 'user' rows when force is false", () => {
    db.prepare(
      `UPDATE process_backend_config
          SET updated_by = 'user', main_backend = 'gemini'
        WHERE process_key = 'message.dm'`,
    ).run();

    const result = applyDefaultPresets(db, {
      defaultBackend: "claude",
      force: false,
    });
    expect(result.processRowsSkipped).toBeGreaterThan(0);

    const dmRow = db
      .prepare(
        `SELECT main_backend, updated_by FROM process_backend_config WHERE process_key = 'message.dm'`,
      )
      .get() as { main_backend: string; updated_by: string };
    expect(dmRow.main_backend).toBe("gemini");
    expect(dmRow.updated_by).toBe("user");
  });

  it("falls back to claude when no defaultBackend is given and the singleton row was deleted", () => {
    db.prepare(`DELETE FROM backend_global_defaults WHERE singleton = 1`).run();
    const result = applyDefaultPresets(db, {});
    expect(result.backend).toBe("claude");
  });

  it("uses backend_global_defaults.default_backend when no override is supplied", () => {
    db.prepare(
      `UPDATE backend_global_defaults SET default_backend = 'gemini' WHERE singleton = 1`,
    ).run();
    const result = applyDefaultPresets(db, {});
    expect(result.backend).toBe("gemini");
  });

  // Cross-backend routing matrix. Each row exercises the full wizard
  // flow for a single backend: setMainBackend writes default_backend,
  // then applyDefaultPresets(force:false) cascades every preset row.
  // Asserts that the core operator-facing ProcessKeys (DM,
  // morning_routine, hourly_check, today_refresh, hourly_check.triage,
  // routine.fetch_window) end up routed to the chosen backend with the
  // correct per-tier model. This is the integration-level regression
  // guard for the schema-seed marker fix: a future change that breaks
  // the cascade for one backend (e.g., a new ENVELOPE override
  // accidentally hardcoded to claude) fires here.
  describe("per-backend cascade — every core ProcessKey routes to the chosen main", () => {
    const matrix: Array<{
      backend: BackendId;
      mediumModel: string;
      liteModel: string;
    }> = [
      {
        backend: "claude",
        mediumModel: DEFAULT_CLAUDE_MEDIUM_MODEL,
        liteModel: DEFAULT_CLAUDE_LITE_MODEL,
      },
      {
        backend: "codex",
        mediumModel: DEFAULT_CODEX_MEDIUM_MODEL,
        liteModel: DEFAULT_CODEX_LITE_MODEL,
      },
      {
        backend: "gemini",
        mediumModel: DEFAULT_GEMINI_MEDIUM_MODEL,
        liteModel: DEFAULT_GEMINI_LITE_MODEL,
      },
      {
        backend: "opencode",
        mediumModel: DEFAULT_OPENCODE_MEDIUM_MODEL,
        liteModel: DEFAULT_OPENCODE_LITE_MODEL,
      },
    ];

    for (const { backend, mediumModel, liteModel } of matrix) {
      it(`${backend}: medium-tier ProcessKeys route to ${backend} with the canonical medium model`, () => {
        setMainBackend(db, backend);
        applyDefaultPresets(db, { defaultBackend: backend, force: false });

        const mediumKeys = [
          "message.dm",
          "message.mention",
          "dashboard.chat",
          "routine.morning_routine",
          "routine.hourly_check",
          "routine.evening_review",
          "routine.weekly_review",
          "routine.monthly_review",
        ];
        const rows = db
          .prepare(
            `SELECT process_key, main_backend, main_model
               FROM process_backend_config
              WHERE process_key IN (${mediumKeys.map(() => "?").join(", ")})`,
          )
          .all(...mediumKeys) as { process_key: string; main_backend: string; main_model: string }[];
        for (const row of rows) {
          expect(
            row.main_backend,
            `${row.process_key} backend on ${backend} cascade`,
          ).toBe(backend);
          expect(
            row.main_model,
            `${row.process_key} model on ${backend} cascade`,
          ).toBe(mediumModel);
        }
      });

      it(`${backend}: lite-tier ProcessKeys route to ${backend} with the canonical lite model`, () => {
        setMainBackend(db, backend);
        applyDefaultPresets(db, { defaultBackend: backend, force: false });

        const liteKeys = [
          "routine.fetch_window",
          "routine.hourly_check.triage",
          "observation.summarize",
          "gmail_classify",
          "calendar.change",
        ];
        const rows = db
          .prepare(
            `SELECT process_key, main_backend, main_model
               FROM process_backend_config
              WHERE process_key IN (${liteKeys.map(() => "?").join(", ")})`,
          )
          .all(...liteKeys) as { process_key: string; main_backend: string; main_model: string }[];
        for (const row of rows) {
          expect(
            row.main_backend,
            `${row.process_key} backend on ${backend} cascade`,
          ).toBe(backend);
          expect(
            row.main_model,
            `${row.process_key} model on ${backend} cascade`,
          ).toBe(liteModel);
        }
      });

      it(`${backend}: routine.today_refresh keeps its tighter 20-turn envelope under ${backend} cascade`, () => {
        setMainBackend(db, backend);
        applyDefaultPresets(db, { defaultBackend: backend, force: false });

        const row = db
          .prepare(
            `SELECT main_backend, main_model, max_turns, max_budget_usd
               FROM process_backend_config
              WHERE process_key = 'routine.today_refresh'`,
          )
          .get() as {
            main_backend: string;
            main_model: string;
            max_turns: number;
            max_budget_usd: number;
          };
        expect(row.main_backend).toBe(backend);
        expect(row.main_model).toBe(mediumModel);
        expect(row.max_turns).toBe(20);
        // Claude / OpenCode keep the Claude-baseline $0.50 cap because
        // the SDK aborts mid-turn at the budget. Codex / Gemini scale up
        // (×1.5 on the medium tier) so the post-hoc check matches the
        // effective spend a Claude session lands on after the SDK
        // truncates — $0.50 × 1.5 = $0.75.
        const expectedBudget =
          backend === "codex" || backend === "gemini" ? 0.75 : 0.5;
        expect(row.max_budget_usd).toBe(expectedBudget);
      });
    }
  });

  it("can seed OpenCode model defaults without special-case process logic", () => {
    const result = applyDefaultPresets(db, {
      defaultBackend: "opencode",
      force: true,
    });
    expect(result.backend).toBe("opencode");
    expect(result.defaultsUpdated).toBe(true);

    const defaults = db
      .prepare(
        `SELECT default_backend, default_lite_model, default_medium_model, default_high_model
           FROM backend_global_defaults WHERE singleton = 1`,
      )
      .get() as {
        default_backend: string;
        default_lite_model: string;
        default_medium_model: string;
        default_high_model: string;
      };
    expect(defaults).toEqual({
      default_backend: "opencode",
      default_lite_model: DEFAULT_OPENCODE_LITE_MODEL,
      default_medium_model: DEFAULT_OPENCODE_MEDIUM_MODEL,
      default_high_model: DEFAULT_OPENCODE_HIGH_MODEL,
    });

    const dmRow = db
      .prepare(
        `SELECT main_backend, main_model FROM process_backend_config WHERE process_key = 'message.dm'`,
      )
      .get() as { main_backend: string; main_model: string };
    expect(dmRow).toEqual({
      main_backend: "opencode",
      main_model: DEFAULT_OPENCODE_MEDIUM_MODEL,
    });
  });

});

describe("setMainBackend", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("writes default_backend without touching per-process rows", () => {
    applyDefaultPresets(db, { defaultBackend: "claude", force: true });
    db.prepare(
      `UPDATE process_backend_config
          SET updated_by = 'user', main_backend = 'gemini'
        WHERE process_key = 'message.dm'`,
    ).run();

    setMainBackend(db, "codex");

    const defaults = db
      .prepare(
        `SELECT default_backend FROM backend_global_defaults WHERE singleton = 1`,
      )
      .get() as { default_backend: string };
    expect(defaults.default_backend).toBe("codex");

    // Per-process row untouched
    const pinned = db
      .prepare(
        `SELECT main_backend, updated_by FROM process_backend_config WHERE process_key = 'message.dm'`,
      )
      .get() as { main_backend: string; updated_by: string };
    expect(pinned.main_backend).toBe("gemini");
    expect(pinned.updated_by).toBe("user");
  });

  it("flips backends.enabled = 1 for the chosen main backend", () => {
    // Schema-seeded codex row exists with enabled=0
    setMainBackend(db, "codex");
    const row = db
      .prepare(`SELECT enabled FROM backends WHERE id = 'codex'`)
      .get() as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it("is idempotent — calling twice keeps enabled = 1", () => {
    setMainBackend(db, "codex");
    setMainBackend(db, "codex");
    const row = db
      .prepare(`SELECT enabled FROM backends WHERE id = 'codex'`)
      .get() as { enabled: number };
    expect(row.enabled).toBe(1);
  });
});

describe("previewMainSwitchImpact", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
    // Schema seeds rows as 'preset'; no reset needed. Test setup adds
    // explicit 'user' rows below to simulate operator pins.
  });

  afterEach(() => {
    db.close();
  });

  it("returns the user-pinned cross-backend rows that would survive a switch", () => {
    db.prepare(
      `UPDATE process_backend_config
          SET updated_by = 'user', main_backend = 'gemini', main_model = 'gemini-3.1-flash'
        WHERE process_key = 'message.dm'`,
    ).run();
    db.prepare(
      `UPDATE process_backend_config
          SET updated_by = 'user', main_backend = 'codex', main_model = 'gpt-5.4-mini'
        WHERE process_key = 'gmail_classify'`,
    ).run();

    const preview = previewMainSwitchImpact(db, "codex");
    // Only the gemini-pinned row is "cross-backend" w.r.t. the codex target.
    const slugs = preview.preservedCrossBackendPins.map((row) => row.processKey);
    expect(slugs).toContain("message.dm");
    expect(slugs).not.toContain("gmail_classify");
  });

  it("ignores rows with an unknown main_backend literal", () => {
    // FK is enforced — drop it temporarily so we can simulate a stale row
    // that points at a deleted backend id.
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `UPDATE process_backend_config
          SET updated_by = 'user', main_backend = 'lol-not-a-backend'
        WHERE process_key = 'message.dm'`,
    ).run();
    db.pragma("foreign_keys = ON");

    const preview = previewMainSwitchImpact(db, "codex");
    expect(
      preview.preservedCrossBackendPins.find(
        (row) => row.processKey === "message.dm",
      ),
    ).toBeUndefined();
  });

  it("returns an empty list when there are no user-pinned rows", () => {
    const preview = previewMainSwitchImpact(db, "codex");
    expect(preview.preservedCrossBackendPins).toEqual([]);
  });
});

describe("applyDefaultPresets falls back to claude when readActiveBackend throws", () => {
  it("treats a missing backend_global_defaults table as 'no default backend' and falls back to claude", () => {
    // Pin the catch branch in readActiveBackend (defensive against a
    // mid-startup race where the singleton table has been dropped or
    // not yet created when applyDefaultPresets runs). When the
    // SELECT throws, the function returns null, the caller falls back
    // to "claude", and the run still succeeds.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    db.exec("DROP TABLE backend_global_defaults");

    // The applyDefaultPresets transaction will repopulate the table via
    // INSERT, so we have to recreate the schema for that path. The
    // simplest way to isolate the catch is to spy on the prepare so
    // only the SELECT used by readActiveBackend throws, leaving the
    // write path intact.
    db.exec(
      `CREATE TABLE backend_global_defaults (
        singleton INTEGER PRIMARY KEY DEFAULT 1,
        default_backend TEXT,
        default_lite_model TEXT,
        default_medium_model TEXT,
        default_high_model TEXT,
        updated_at TEXT
      )`,
    );
    const realPrepare = db.prepare.bind(db);
    let threwOnce = false;
    db.prepare = ((sql: string) => {
      if (
        !threwOnce
        && typeof sql === "string"
        && sql.includes("SELECT default_backend FROM backend_global_defaults")
      ) {
        threwOnce = true;
        throw new Error("simulated mid-startup race");
      }
      return realPrepare(sql);
    }) as typeof db.prepare;

    const result = applyDefaultPresets(db);
    // Without an explicit `defaultBackend`, the catch path returns
    // null and the caller defaults to "claude".
    expect(result.backend).toBe("claude");
    db.close();
  });
});

describe("inferTierForModel", () => {
  it("returns the registered tier for a known (backend, model)", () => {
    expect(inferTierForModel("claude", DEFAULT_CLAUDE_LITE_MODEL)).toBe("lite");
    expect(inferTierForModel("claude", DEFAULT_CLAUDE_MEDIUM_MODEL)).toBe(
      "medium",
    );
    expect(inferTierForModel("claude", DEFAULT_CLAUDE_HIGH_MODEL)).toBe("high");
  });

  it("returns null for an unknown model id", () => {
    expect(inferTierForModel("claude", "definitely-not-a-real-model")).toBeNull();
  });
});

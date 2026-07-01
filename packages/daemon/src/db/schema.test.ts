import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { DEFAULT_CLAUDE_HIGH_MODEL } from "../core/backends/model-registry.js";

// ── Schema shape tests (via applySchema) ──────────────────────────────────────

describe("applySchema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates all expected tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    for (const table of [
      "agent_actions",
      "agent_schedule",
      "auth_telemetry_counters",
      "backend_global_defaults",
      "backends",
      "books",
      "browser_pending_offers",
      "browser_reload_signals",
      "browser_research_clusters",
      "browser_shopping_sessions",
      "browser_visits",
      "chat_attachments",
      "conversation_sessions",
      "dm_conversation_log",
      "entities",
      "entity_source_keys",
      "integration_probes",
      "integration_snapshots",
      "integration_writes",
      "mail_accounts",
      "mail_messages_index",
      "managed_tasks",
      "managed_task_seq",
      "management_parse_failures",
      "md_file_snapshots",
      "messages",
      "mcp_servers",
      "mcp_tool_calls",
      "migration_backups",
      "notification_log",
      "observations",
      "owner_channels",
      "parse_failures",
      "process_backend_config",
      "browser_task",
      "browser_task_action_log",
      "browser_task_clarifications",
      "browser_task_final_confirm_tokens",
      "reading_highlights",
      "receipts",
      "recurring_schedules",
      "repositories",
      "repository_management",
      "repository_triggers",
      "runtime_state",
      "settings",
      "travel_bookings",
    ]) {
      expect(names, `missing table: ${table}`).toContain(table);
    }

    // No schema-version tracking table — the app applies the full schema
    // in one shot rather than running incremental migrations.
    expect(names).not.toContain("schema_versions");
  });

  it("creates FTS5 virtual tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("fts_actions");
    expect(names).toContain("fts_messages");
    expect(names).toContain("fts_mail_messages");
  });

  it("creates all expected indices", () => {
    const indices = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = indices.map((i) => i.name);

    for (const idx of [
      "idx_sessions_lookup",
      "idx_sessions_scope",
      "idx_conv_sessions_scope_active",
      "idx_dm_log_platform",
      "idx_dm_log_scope",
      "idx_messages_dispatch",
      "idx_messages_session",
      "idx_actions_date",
      "idx_agent_actions_backend_time",
      "idx_recurring_enabled",
      "idx_schedule_pending",
      "idx_notification_dispatch",
      "idx_snapshots_file",
      "idx_obs_pending",
      "idx_obs_unique_pending",
      "idx_obs_observed_at",
      "idx_auth_telemetry_bucket",
      "idx_books_status",
      "idx_books_title_author",
      "idx_browser_visits_amazon",
      "idx_browser_visits_root_task",
      "idx_browser_visits_ts",
      "idx_reading_highlights_book",
      "idx_mail_messages_thread",
      "idx_mail_messages_received",
      "idx_mail_messages_unread",
      "idx_parse_failures_account_msg",
      "idx_parse_failures_created_at",
      "idx_parse_failures_account",
      "idx_management_parse_failures_created_at",
      "idx_travel_bookings_account_msg",
      "idx_travel_bookings_start",
      "idx_travel_bookings_status",
      "idx_travel_bookings_type",
      "idx_travel_bookings_account",
      "idx_receipts_category",
      "idx_receipts_saved",
      "idx_receipts_account",
      "idx_migration_backups_status_expires",
      "idx_mcp_servers_enabled",
      "idx_mcp_tool_calls_server",
      "idx_chat_attachments_session",
      "idx_chat_attachments_message",
      "idx_chat_attachments_turn",
      "idx_integration_probes_recency",
      "idx_integration_snapshots_imminent",
      "idx_integration_snapshots_fetched_at",
      "idx_integration_writes_expires",
      "idx_managed_tasks_app",
      "idx_managed_tasks_output_path",
      "idx_entities_domain_type_date",
      "idx_entities_status",
      "idx_entity_source_keys_lookup",
      "idx_repositories_github",
      "idx_repositories_local",
      "idx_triggers_event",
      "idx_triggers_repo",
      // BROWSER_TASK_REDESIGN_PLAN.md §6.4 / §6.6 / §6.7 + §5 lite-final-
      // confirm — every browser-task index is asserted here so a
      // regression that silently drops one (e.g. typoed rename, missed
      // ALTER) trips this test instead of producing a slow lookup at
      // runtime.
      "idx_browser_task_created_at",
      "idx_browser_task_state_created",
      "idx_browser_task_non_terminal",
      "idx_browser_task_action_log_task",
      "idx_browser_task_action_log_at",
      "idx_browser_task_clarifications_task",
      "idx_browser_task_clarifications_unresolved",
      "idx_final_confirm_tokens_status_expires",
      "idx_final_confirm_tokens_task",
    ]) {
      expect(names, `missing index: ${idx}`).toContain(idx);
    }
  });

  it("creates FTS5 sync triggers", () => {
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = triggers.map((t) => t.name);

    for (const trg of [
      "trg_actions_ai",
      "trg_actions_ad",
      "trg_messages_ai",
      "trg_messages_ad",
      "trg_mail_messages_ai",
      "trg_mail_messages_ad",
      "trg_mail_messages_au",
    ]) {
      expect(names, `missing trigger: ${trg}`).toContain(trg);
    }
  });

  it("is idempotent — calling applySchema twice does not throw", () => {
    expect(() => applySchema(db)).not.toThrow();
  });

  it("enforces conversation_sessions status check constraint", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO conversation_sessions (platform, channel_id, status) VALUES ('slack', 'C123', 'invalid')",
      ).run();
    }).toThrow();
  });

  it("enforces conversation_sessions scope check constraint", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO conversation_sessions (platform, channel_id, scope) VALUES ('slack', 'C123', 'bad_scope')",
      ).run();
    }).toThrow();
  });

  it("accepts the docs_qa scope on conversation_sessions", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO conversation_sessions (platform, channel_id, scope, scope_key) VALUES ('dashboard', 'qa-1', 'docs_qa', 'docs_qa')",
      ).run();
    }).not.toThrow();
  });

  it("allows duplicate correlation_id on agent_schedule", () => {
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, correlation_id) VALUES (datetime('now'), 'wake', 'corr-1')",
    ).run();
    expect(() => {
      db.prepare(
        "INSERT INTO agent_schedule (scheduled_for, task_type, correlation_id) VALUES (datetime('now'), 'wake', 'corr-1')",
      ).run();
    }).not.toThrow();
  });

  it("enforces one active session per scope (unique partial index)", () => {
    db.prepare(
      "INSERT INTO conversation_sessions (platform, channel_id, scope, scope_key, status) VALUES ('slack', 'D1', 'owner_dm', 'owner', 'active')",
    ).run();
    expect(() => {
      db.prepare(
        "INSERT INTO conversation_sessions (platform, channel_id, scope, scope_key, status) VALUES ('telegram', 'D2', 'owner_dm', 'owner', 'active')",
      ).run();
    }).toThrow();
  });

  it("FTS5 triggers populate fts_actions on insert", () => {
    db.prepare(
      "INSERT INTO agent_actions (action_type, trigger, detail) VALUES ('test_action', 'test', '{\"key\": \"value\"}')",
    ).run();
    const results = db
      .prepare("SELECT * FROM fts_actions WHERE fts_actions MATCH 'test_action'")
      .all();
    expect(results).toHaveLength(1);
  });

  it("FTS5 triggers populate fts_messages on insert", () => {
    db.prepare(
      "INSERT INTO conversation_sessions (platform, channel_id) VALUES ('slack', 'C123')",
    ).run();
    db.prepare(
      "INSERT INTO messages (session_id, role, content, platform) VALUES (1, 'user', 'hello world test message', 'slack')",
    ).run();
    const results = db
      .prepare("SELECT * FROM fts_messages WHERE fts_messages MATCH 'hello'")
      .all();
    expect(results).toHaveLength(1);
  });

  it("observations unique-pending partial index allows reuse after consumption", () => {
    db.prepare(
      "INSERT INTO observations (source, ref, change_type, actor) VALUES ('obsidian:external', 'x.md', 'modified', 'user')",
    ).run();
    db.prepare(
      "UPDATE observations SET consumed_at = datetime('now'), consumed_by = 'test' WHERE source = 'obsidian:external' AND ref = 'x.md'",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO observations (source, ref, change_type, actor) VALUES ('obsidian:external', 'x.md', 'modified', 'user')",
        )
        .run(),
    ).not.toThrow();
  });

  // ── Seed data ───────────────────────────────────────────────────────────────

  it("seeds backend rows: claude enabled, others disabled", () => {
    const rows = db
      .prepare("SELECT id, enabled, auth_status FROM backends ORDER BY id")
      .all() as { id: string; enabled: number; auth_status: string }[];
    expect(rows).toEqual([
      { id: "claude",   enabled: 1, auth_status: "unknown" },
      { id: "codex",    enabled: 0, auth_status: "unknown" },
      { id: "gemini",   enabled: 0, auth_status: "unknown" },
      { id: "opencode", enabled: 0, auth_status: "unknown" },
    ]);
  });

  it("seeds backend_global_defaults with the canonical Claude lite / medium / high models", () => {
    const row = db
      .prepare(
        "SELECT default_backend, default_lite_model, default_medium_model, default_high_model, advisor_enabled FROM backend_global_defaults WHERE singleton = 1",
      )
      .get() as {
        default_backend: string;
        default_lite_model: string;
        default_medium_model: string;
        default_high_model: string;
        advisor_enabled: number;
      };
    expect(row).toEqual({
      default_backend: "claude",
      default_lite_model: "claude-haiku-4-5-20251001",
      default_medium_model: "claude-sonnet-5",
      default_high_model: "claude-opus-4-8",
      advisor_enabled: 0,
    });
  });

  it("seeds process_backend_config with correct per-process models and budgets", () => {
    const morning = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'routine.morning_routine'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(morning.main_model).toBe("claude-sonnet-5");
    expect(morning.max_turns).toBe(50);
    expect(morning.max_budget_usd).toBe(2.0);

    // routine.evening_review — realigned to $2.00 (migration 0017) to match
    // its morning_routine sibling; a connector-capable, many-turn medium
    // routine. Lock-step with ENVELOPE_OVERRIDES_BY_PROCESS_KEY in
    // plan-presets.ts.
    const eveningReview = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'routine.evening_review'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(eveningReview.main_model).toBe("claude-sonnet-5");
    expect(eveningReview.max_turns).toBe(50);
    expect(eveningReview.max_budget_usd).toBe(2.0);

    // morning-routine-optimization.md Phase 5 — Stage A / Stage B seed
    // rows. Stage B's $0.30 cap is the realigned value after production
    // observed Stage B's ~21 KB prompt + Haiku cache_creation tripping
    // the previous $0.10 cap mid-turn (BackendQuotaError(max_budget_usd))
    // before the daily/<yesterday>.md PUT could fire. Pinned here in
    // lock-step with ENVELOPE_OVERRIDES_BY_PROCESS_KEY in plan-presets.ts.
    const morningStageA = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'routine.morning_routine_today'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(morningStageA.main_model).toBe("claude-sonnet-5");
    expect(morningStageA.max_turns).toBe(50);
    expect(morningStageA.max_budget_usd).toBe(1.5);

    const morningStageB = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'routine.morning_routine_journal'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(morningStageB.main_model).toBe("claude-haiku-4-5-20251001");
    expect(morningStageB.max_turns).toBe(20);
    expect(morningStageB.max_budget_usd).toBe(0.3);

    const todayRefresh = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'routine.today_refresh'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(todayRefresh.main_model).toBe("claude-sonnet-5");
    expect(todayRefresh.max_turns).toBe(20);
    expect(todayRefresh.max_budget_usd).toBe(0.5);

    // Roadmap refresh seeds wider than the medium-tier nominal envelope
    // (50/$1.00) because the synthesis session itself drives the
    // Calendar (90d) / Mail / Notion MCP fan-out in `native` integration
    // mode (no `routine.fetch_window` pre-pass). 60/$3.00 must stay
    // pinned in lock-step with
    // `ENVELOPE_OVERRIDES_BY_PROCESS_KEY["routine.roadmap_refresh"]` so
    // a `force: true` reset cannot silently clobber it back to the
    // tier default.
    const roadmapRefresh = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'routine.roadmap_refresh'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(roadmapRefresh.main_model).toBe("claude-sonnet-5");
    expect(roadmapRefresh.max_turns).toBe(60);
    expect(roadmapRefresh.max_budget_usd).toBe(3.0);

    const dm = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'message.dm'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(dm.main_model).toBe("claude-sonnet-5");
    expect(dm.max_turns).toBe(50);
    // Wider $5.00 per-turn ceiling than the $1.00 medium nominal — DM
    // turns re-process the full history and tipped over $1.00 mid-turn.
    // Lock-step with ENVELOPE_OVERRIDES_BY_PROCESS_KEY + migration 0006.
    expect(dm.max_budget_usd).toBe(5.0);

    const gitProjectInit = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'git.project.init'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    // git.project.init seeds with the medium-tier model (Sonnet) — operators
    // can pin Opus per-row from /settings/models when they want deeper
    // reasoning on a one-shot init. The $1 cap is sized so it binds first
    // on Sonnet (matching the original Opus-era effective bound).
    expect(gitProjectInit.main_model).toBe("claude-sonnet-5");
    expect(gitProjectInit.max_turns).toBe(50);
    expect(gitProjectInit.max_budget_usd).toBe(1.0);

    const gitProjectUpdate = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'git.project.update'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(gitProjectUpdate.main_model).toBe("claude-sonnet-5");
    expect(gitProjectUpdate.max_turns).toBe(30);
    expect(gitProjectUpdate.max_budget_usd).toBe(0.5);

    // BROWSER_TASK_REDESIGN_PLAN.md §5 / §6.1 — open-ended browser
    // sub-agent. Medium tier (Sonnet), 30 turns / $1.00 envelope sized
    // for the multimodal-input cost of ~5 screenshots over a 10-turn
    // flow. Lock-step with the §5 envelope spec.
    const browserTask = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'browser_task'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(browserTask.main_model).toBe("claude-sonnet-5");
    expect(browserTask.max_turns).toBe(30);
    expect(browserTask.max_budget_usd).toBe(1.0);

    // Delegated/simple surfaces seed with Haiku, tighter envelope.
    const gmailClassify = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'gmail_classify'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(gmailClassify.main_model).toBe("claude-haiku-4-5-20251001");
    expect(gmailClassify.max_turns).toBe(20);
    expect(gmailClassify.max_budget_usd).toBe(0.2);

    // docs/design/appendices/routine-data-acquisition.md §6.2 / F1 — pre-pass fetcher
    // ProcessKey seed row. Lite tier (Haiku), 20-turn / $0.50 envelope
    // sized for the worst-case routine fan-out (morning: 2 mail
    // providers × N accounts + calendar + notion). The lite-tier
    // nominal ($0.20) under-provisioned real fan-outs and tripped
    // BackendQuotaError mid-fetch, so the schema seed and
    // `ENVELOPE_OVERRIDES_BY_PROCESS_KEY` widen this to $0.50.
    const fetchWindow = db
      .prepare(
        "SELECT main_model, max_turns, max_budget_usd FROM process_backend_config WHERE process_key = 'routine.fetch_window'",
      )
      .get() as { main_model: string; max_turns: number; max_budget_usd: number };
    expect(fetchWindow.main_model).toBe("claude-haiku-4-5-20251001");
    // 20 → 10 per PREPASS_COST_REDUCTION_PLAN.md N4 (live P99 = 8 turns
    // over 502 per-integration fan-out runs).
    expect(fetchWindow.max_turns).toBe(10);
    expect(fetchWindow.max_budget_usd).toBe(0.5);
  });

  // docs/design/appendices/routine-data-acquisition.md §6.9 / P6 / Phase 1 F9 — no
  // routine-family ProcessKey seed row may bind to the high (Opus)
  // tier. Operators can pin per-row from /settings/models, but the
  // install-time seed must never burn Opus headroom by default.
  it("no routine.* seed row binds to DEFAULT_CLAUDE_HIGH_MODEL (P6 tier ceiling)", () => {
    // Pull the constant from the daemon's model registry rather than a
    // hardcoded literal — a future Opus bump must propagate to BOTH
    // schema.ts and this test in lock-step. The literal form silently
    // false-passes the moment the seed and the constant diverge.
    const routineRows = db
      .prepare(
        "SELECT process_key, main_model FROM process_backend_config WHERE process_key LIKE 'routine.%'",
      )
      .all() as { process_key: string; main_model: string }[];
    expect(routineRows.length).toBeGreaterThan(0); // sanity check the seed loaded
    for (const row of routineRows) {
      expect(
        row.main_model,
        `${row.process_key} seeds at high tier (${row.main_model}); P6 forbids that`,
      ).not.toBe(DEFAULT_CLAUDE_HIGH_MODEL);
    }
  });

  it("seeds integrations setting as all-disabled", () => {
    const intRow = db
      .prepare("SELECT value_json FROM settings WHERE key = 'integrations'")
      .get() as { value_json: string } | undefined;
    expect(intRow).toBeDefined();
    const integrations = JSON.parse(intRow!.value_json) as Record<
      string,
      { mode: string }
    >;
    expect(integrations.gmail.mode).toBe("disabled");
    expect(integrations.google_calendar.mode).toBe("disabled");
  });

  it("process_backend_config.updated_by defaults to 'user'", () => {
    const col = db.pragma("table_info(process_backend_config)") as {
      name: string;
      dflt_value: string | null;
    }[];
    const updatedBy = col.find((c) => c.name === "updated_by");
    expect(updatedBy?.dflt_value).toBe("'user'");
  });

  it("agent_actions has all expected columns including advisor_call_count", () => {
    const cols = db.pragma("table_info(agent_actions)") as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const col = cols.find((c) => c.name === "advisor_call_count");
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe("0");
    expect(col?.notnull).toBe(1);
  });

  it("agent_actions exposes a metadata JSON column with default '{}'", () => {
    // docs/design/appendices/morning-routine-optimization.md §"PATCH
    // /api/agent-actions/self" — the column is the chokepointed agent-
    // write side-channel; the daemon's ⑥ AgentJournalAppender reads
    // structured fields from it rather than parsing LLM prose.
    const cols = db.pragma("table_info(agent_actions)") as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const col = cols.find((c) => c.name === "metadata");
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe("'{}'");
    expect(col?.notnull).toBe(0);
  });

  it("backends has auth_last_verified_at column", () => {
    const cols = db.pragma("table_info(backends)") as { name: string }[];
    expect(cols.some((c) => c.name === "auth_last_verified_at")).toBe(true);
  });

  it("auth_telemetry_counters source column is part of primary key", () => {
    const cols = db.pragma("table_info(auth_telemetry_counters)") as {
      name: string;
      type: string;
      dflt_value: string | null;
      notnull: number;
      pk: number;
    }[];
    const src = cols.find((c) => c.name === "source");
    expect(src).toBeDefined();
    expect(src?.dflt_value).toBe("'reactive'");
    expect(src?.pk).toBeGreaterThan(0);
  });

  it("backend_global_defaults has no plan columns (API-key-first design)", () => {
    const cols = db.pragma("table_info(backend_global_defaults)") as {
      name: string;
    }[];
    const names = cols.map((c) => c.name);
    expect(names).not.toContain("claude_plan");
    expect(names).not.toContain("codex_plan");
    expect(names).not.toContain("gemini_plan");
    expect(names).not.toContain("subscription_plan");
  });

  it("owner_channels.last_inbound_at allows NULL", () => {
    const cols = db.pragma("table_info(owner_channels)") as {
      name: string;
      notnull: number;
    }[];
    const col = cols.find((c) => c.name === "last_inbound_at");
    expect(col?.notnull).toBe(0);
  });

  it("mail_accounts has imap_capabilities_json column (no is_primary)", () => {
    const cols = db.pragma("table_info(mail_accounts)") as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("imap_capabilities_json");
    expect(names).not.toContain("is_primary");
  });

  it("mail_messages_index uses provider_msg_id (not gmail_message_id)", () => {
    const cols = db.pragma("table_info(mail_messages_index)") as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("provider_msg_id");
    expect(names).not.toContain("gmail_message_id");
  });

  it("receipts has composite UNIQUE(account_id, provider_msg_id, attachment_id)", () => {
    db.prepare(
      "INSERT INTO receipts (provider_msg_id, attachment_id, filename, mime_type, account_id) VALUES ('m1','a1','f.pdf','application/pdf','acc1')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO receipts (provider_msg_id, attachment_id, filename, mime_type, account_id) VALUES ('m1','a1','f.pdf','application/pdf','acc1')",
        )
        .run(),
    ).toThrow();
    // Different account_id: should succeed
    expect(() =>
      db
        .prepare(
          "INSERT INTO receipts (provider_msg_id, attachment_id, filename, mime_type, account_id) VALUES ('m1','a1','f.pdf','application/pdf','acc2')",
        )
        .run(),
    ).not.toThrow();
  });

  it("lifecycle tables (books, reading_highlights) are present", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('books', 'reading_highlights') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "books",
      "reading_highlights",
    ]);
  });

  // ── Management Registry & Entities (docs/design/21-management-registry-and-entities.md) ──

  describe("managed_tasks", () => {
    function insertSchedule(): number {
      const info = db
        .prepare(
          "INSERT INTO recurring_schedules (task_type, task_description, recurrence_rule) VALUES ('scheduled.task', 'mt_test', json('{}'))",
        )
        .run();
      return info.lastInsertRowid as number;
    }

    it("accepts a valid row with output_path", () => {
      const sid = insertSchedule();
      expect(() =>
        db
          .prepare(
            "INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence, output_path, schedule_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("mt_1", "Zoom recordings", "zoom", "zoom", "daily 10:00", "work/meetings/", sid),
      ).not.toThrow();
    });

    it("permits NULL output_path", () => {
      const sid = insertSchedule();
      expect(() =>
        db
          .prepare(
            "INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence, output_path, schedule_id) VALUES (?, ?, ?, ?, ?, NULL, ?)",
          )
          .run("mt_2", "Pending output", "gmail", "gmail", "hourly", sid),
      ).not.toThrow();
    });

    it("CHECK rejects output_path that doesn't end with /", () => {
      const sid = insertSchedule();
      expect(() =>
        db
          .prepare(
            "INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence, output_path, schedule_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("mt_3", "Bad path", "zoom", "zoom", "daily", "work/meetings", sid),
      ).toThrow();
    });

    it("UNIQUE schedule_id rejects two managed tasks for the same schedule", () => {
      const sid = insertSchedule();
      db.prepare(
        "INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence, schedule_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("mt_4", "first", "zoom", "zoom", "daily", sid);
      expect(() =>
        db
          .prepare(
            "INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence, schedule_id) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("mt_5", "second", "zoom", "zoom", "weekly", sid),
      ).toThrow();
    });

    it("UNIQUE (app_normalized, cadence) rejects semantic-duplicate registrations", () => {
      const sid1 = insertSchedule();
      const sid2 = insertSchedule();
      db.prepare(
        "INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence, schedule_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("mt_6", "first", "Zoom", "zoom", "daily 10:00", sid1);
      expect(() =>
        db
          .prepare(
            "INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence, schedule_id) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("mt_7", "second", "ZOOM", "zoom", "daily 10:00", sid2),
      ).toThrow();
    });

    it("FK cascade: deleting recurring_schedules removes the managed task", () => {
      const sid = insertSchedule();
      db.prepare(
        "INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence, schedule_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("mt_8", "cascade", "zoom", "zoom", "daily", sid);
      db.prepare("DELETE FROM recurring_schedules WHERE id = ?").run(sid);
      const remaining = db
        .prepare("SELECT id FROM managed_tasks WHERE id = ?")
        .get("mt_8");
      expect(remaining).toBeUndefined();
    });

    it("created_at and updated_at default to CURRENT_TIMESTAMP", () => {
      const sid = insertSchedule();
      db.prepare(
        "INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence, schedule_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("mt_9", "defaults", "zoom", "zoom", "daily", sid);
      const row = db
        .prepare(
          "SELECT created_at, updated_at, consecutive_failures FROM managed_tasks WHERE id = ?",
        )
        .get("mt_9") as {
          created_at: string;
          updated_at: string;
          consecutive_failures: number;
        };
      expect(row.created_at).toBeTruthy();
      expect(row.updated_at).toBeTruthy();
      expect(row.consecutive_failures).toBe(0);
    });
  });

  describe("managed_task_seq", () => {
    it("seeds a singleton row with next_id = 1", () => {
      const row = db
        .prepare("SELECT singleton, next_id FROM managed_task_seq")
        .all() as { singleton: number; next_id: number }[];
      expect(row).toEqual([{ singleton: 1, next_id: 1 }]);
    });

    it("CHECK (singleton = 1) rejects a second row", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO managed_task_seq (singleton, next_id) VALUES (2, 99)",
          )
          .run(),
      ).toThrow();
    });

    it("seed insert is idempotent under a second applySchema()", () => {
      expect(() => applySchema(db)).not.toThrow();
      const row = db
        .prepare("SELECT singleton, next_id FROM managed_task_seq")
        .all();
      expect(row).toHaveLength(1);
    });
  });

  describe("entities & entity_source_keys", () => {
    it("entities accepts a row with the expected columns", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO entities (path, domain, type, slug, title, status, date, last_synced_at, sources_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "work/meetings/2026-12-04-foo.md",
            "work",
            "meeting",
            "2026-12-04-foo",
            "Foo 1on1",
            "upcoming",
            "2026-12-04",
            "2026-12-04T10:00:00Z",
            '{"zoom": {"external_id": "zm_xyz"}}',
          ),
      ).not.toThrow();
    });

    it("entities sources_json defaults to empty object", () => {
      db.prepare(
        "INSERT INTO entities (path, domain, type, slug, title) VALUES (?, ?, ?, ?, ?)",
      ).run("work/projects/foo.md", "work", "project", "foo", "Foo");
      const row = db
        .prepare("SELECT sources_json FROM entities WHERE path = ?")
        .get("work/projects/foo.md") as { sources_json: string };
      expect(row.sources_json).toBe("{}");
    });

    it("entity_source_keys composite PK rejects duplicates", () => {
      db.prepare(
        "INSERT INTO entities (path, domain, type, slug, title) VALUES (?, ?, ?, ?, ?)",
      ).run("work/meetings/foo.md", "work", "meeting", "foo", "Foo");
      db.prepare(
        "INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)",
      ).run("work/meetings/foo.md", "zoom");
      expect(() =>
        db
          .prepare(
            "INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)",
          )
          .run("work/meetings/foo.md", "zoom"),
      ).toThrow();
    });

    it("entity_source_keys cascades when the parent entity is deleted", () => {
      db.prepare(
        "INSERT INTO entities (path, domain, type, slug, title) VALUES (?, ?, ?, ?, ?)",
      ).run("work/meetings/cascade.md", "work", "meeting", "cascade", "C");
      db.prepare(
        "INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?), (?, ?)",
      ).run(
        "work/meetings/cascade.md",
        "zoom",
        "work/meetings/cascade.md",
        "gdocs",
      );
      db.prepare("DELETE FROM entities WHERE path = ?").run(
        "work/meetings/cascade.md",
      );
      const remaining = db
        .prepare(
          "SELECT path FROM entity_source_keys WHERE path = ?",
        )
        .all("work/meetings/cascade.md");
      expect(remaining).toEqual([]);
    });

    it("entity_source_keys rejects orphan source-key rows", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)",
          )
          .run("nonexistent/path.md", "zoom"),
      ).toThrow();
    });
  });

  // ── Unified Repositories (docs/design/appendices/unified-repositories.md) ──
  // Pins the install-time schema for the three unified-repositories tables.
  // Tables / indices are listed above; the assertions here cover the CHECK
  // constraints, partial UNIQUE indices, and FK CASCADE behaviour that the
  // table-presence test cannot. Foreign-key enforcement is on at the harness
  // level (line 13 sets `PRAGMA foreign_keys = ON`).
  describe("unified repositories (C4)", () => {
    function insertRepo(overrides: Record<string, unknown> = {}): void {
      const now = Date.now();
      const row = {
        id: "r1",
        github_owner: null,
        github_repo: null,
        github_account: null,
        local_path: "/Users/me/proj",
        local_only: 1,
        display_name: null,
        classification: "repo-only",
        category: "other",
        poll_priority: "normal",
        poll_interval_sec: null,
        created_at: now,
        updated_at: now,
        ...overrides,
      };
      db.prepare(
        `INSERT INTO repositories (
            id, github_owner, github_repo, github_account, local_path, local_only,
            display_name, classification, category, poll_priority, poll_interval_sec,
            created_at, updated_at
         ) VALUES (
            @id, @github_owner, @github_repo, @github_account, @local_path, @local_only,
            @display_name, @classification, @category, @poll_priority, @poll_interval_sec,
            @created_at, @updated_at
         )`,
      ).run(row);
    }

    function insertTrigger(overrides: Record<string, unknown>): () => unknown {
      const now = Date.now();
      const row = {
        id: "t-default",
        repository_id: "r-default",
        name: "n",
        enabled: 1,
        event_type: "git.push.detected",
        filters_json: "{}",
        backend: "claude",
        model: "claude-sonnet-4-6",
        workdir_mode: "temp",
        prompt: "p",
        instruction_md: "i",
        created_at: now,
        updated_at: now,
        ...overrides,
      };
      return () =>
        db
          .prepare(
            `INSERT INTO repository_triggers (
                id, repository_id, name, enabled, event_type, filters_json,
                backend, model, workdir_mode, prompt, instruction_md,
                created_at, updated_at
             ) VALUES (
                @id, @repository_id, @name, @enabled, @event_type, @filters_json,
                @backend, @model, @workdir_mode, @prompt, @instruction_md,
                @created_at, @updated_at
             )`,
          )
          .run(row);
    }

    // ── repositories: CHECK constraints ──

    it("accepts a local-only row", () => {
      expect(() => insertRepo()).not.toThrow();
    });

    it("accepts a GitHub-paired row with no local clone", () => {
      expect(() =>
        insertRepo({
          id: "r2",
          github_owner: "acme",
          github_repo: "widgets",
          local_path: null,
          local_only: 0,
        }),
      ).not.toThrow();
    });

    it("rejects rows with neither GitHub pair nor local_path", () => {
      expect(() =>
        insertRepo({ id: "r3", local_path: null, local_only: 0 }),
      ).toThrow();
    });

    it("rejects partial GitHub pair (owner without repo)", () => {
      expect(() =>
        insertRepo({
          id: "r4",
          github_owner: "acme",
          github_repo: null,
          local_path: "/x",
          local_only: 0,
        }),
      ).toThrow();
    });

    it("rejects local_only=1 with GitHub fields populated", () => {
      expect(() =>
        insertRepo({
          id: "r5",
          github_owner: "acme",
          github_repo: "widgets",
          local_path: "/x",
          local_only: 1,
        }),
      ).toThrow();
    });

    it.each([
      ["classification", "rogue"],
      ["category", "rogue"],
      ["poll_priority", "urgent"],
    ])("rejects invalid %s value", (col, val) => {
      expect(() => insertRepo({ id: `r-${col}`, [col]: val })).toThrow();
    });

    // ── repositories: partial UNIQUE indices ──

    it("UNIQUE partial index rejects duplicate (github_owner, github_repo)", () => {
      const base = {
        github_owner: "acme",
        github_repo: "widgets",
        local_path: null,
        local_only: 0,
      };
      insertRepo({ id: "r9", ...base });
      expect(() => insertRepo({ id: "r10", ...base })).toThrow();
    });

    it("UNIQUE partial index does NOT block multiple rows with null GitHub fields", () => {
      insertRepo({ id: "r9a", local_path: "/Users/me/a" });
      expect(() =>
        insertRepo({ id: "r9b", local_path: "/Users/me/b" }),
      ).not.toThrow();
    });

    it("UNIQUE partial index rejects duplicate local_path", () => {
      insertRepo({ id: "r11", local_path: "/Users/me/dup" });
      expect(() =>
        insertRepo({ id: "r12", local_path: "/Users/me/dup" }),
      ).toThrow();
    });

    it("UNIQUE partial index does NOT block multiple rows with null local_path", () => {
      insertRepo({
        id: "r11a",
        github_owner: "a",
        github_repo: "x",
        local_path: null,
        local_only: 0,
      });
      expect(() =>
        insertRepo({
          id: "r11b",
          github_owner: "a",
          github_repo: "y",
          local_path: null,
          local_only: 0,
        }),
      ).not.toThrow();
    });

    // ── repository_triggers: CHECK + FK CASCADE ──

    it("rejects temp workdir_mode without instruction_md", () => {
      insertRepo({ id: "r15" });
      expect(
        insertTrigger({ id: "t2", repository_id: "r15", instruction_md: null }),
      ).toThrow();
    });

    it("accepts local-clone workdir_mode with null instruction_md", () => {
      insertRepo({ id: "r15b" });
      expect(
        insertTrigger({
          id: "t2b",
          repository_id: "r15b",
          workdir_mode: "local-clone",
          instruction_md: null,
        }),
      ).not.toThrow();
    });

    it("rejects invalid backend value", () => {
      insertRepo({ id: "r16" });
      expect(
        insertTrigger({ id: "t3", repository_id: "r16", backend: "rogue" }),
      ).toThrow();
    });

    it("FK CASCADE: deleting a repository removes its triggers", () => {
      insertRepo({ id: "r13" });
      insertTrigger({ id: "t1", repository_id: "r13" })();
      db.prepare("DELETE FROM repositories WHERE id = 'r13'").run();
      const remaining = db
        .prepare("SELECT id FROM repository_triggers WHERE id = 't1'")
        .get();
      expect(remaining).toBeUndefined();
    });

    // ── repository_management: CHECK + FK CASCADE ──

    it("FK CASCADE: deleting a repository removes its management row", () => {
      insertRepo({ id: "r14" });
      const now = Date.now();
      db.prepare(
        `INSERT INTO repository_management
          (repository_id, enabled, created_at, updated_at)
          VALUES ('r14', 1, ?, ?)`,
      ).run(now, now);
      db.prepare("DELETE FROM repositories WHERE id = 'r14'").run();
      const remaining = db
        .prepare(
          "SELECT repository_id FROM repository_management WHERE repository_id = 'r14'",
        )
        .get();
      expect(remaining).toBeUndefined();
    });

    it.each(["ok", "failed", "skipped_no_activity"] as const)(
      "accepts last_scan_status=%p",
      (status) => {
        const id = `r17-${status}`;
        insertRepo({ id });
        const now = Date.now();
        expect(() =>
          db
            .prepare(
              `INSERT INTO repository_management
                (repository_id, enabled, last_scan_status, created_at, updated_at)
                VALUES (?, 1, ?, ?, ?)`,
            )
            .run(id, status, now, now),
        ).not.toThrow();
      },
    );

    it("rejects unknown last_scan_status", () => {
      insertRepo({ id: "r18" });
      const now = Date.now();
      expect(() =>
        db
          .prepare(
            `INSERT INTO repository_management
              (repository_id, enabled, last_scan_status, created_at, updated_at)
              VALUES ('r18', 1, 'rogue', ?, ?)`,
          )
          .run(now, now),
      ).toThrow();
    });

    it("accepts NULL last_scan_status", () => {
      insertRepo({ id: "r19" });
      const now = Date.now();
      expect(() =>
        db
          .prepare(
            `INSERT INTO repository_management
              (repository_id, enabled, last_scan_status, created_at, updated_at)
              VALUES ('r19', 1, NULL, ?, ?)`,
          )
          .run(now, now),
      ).not.toThrow();
    });
  });
});

import type Database from "better-sqlite3";
import {
  DEFAULT_CLAUDE_HIGH_MODEL,
  DEFAULT_CLAUDE_LITE_MODEL,
  DEFAULT_CLAUDE_MEDIUM_MODEL,
} from "../core/backends/model-registry.js";

// Seed-row default models are interpolated from MODEL_REGISTRY's canonical
// constants instead of hardcoded literals so a default-model bump is a
// one-line edit in `model-registry.ts` (the registry is also the source of
// truth for tier resolution; see docs/maintenance.md §1). Both constants
// are internal `as const` strings — no untrusted input feeds these
// interpolations, so there is no SQL-injection surface.
const SCHEMA = `
-- ── Conversation & Messaging ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_id TEXT,
    scope TEXT NOT NULL DEFAULT 'thread'
        CHECK (scope IN ('thread', 'owner_dm', 'dashboard_chat', 'docs_qa')),
    scope_key TEXT NOT NULL DEFAULT '',
    backend_session_id TEXT,
    backend TEXT,
    -- Medium-tier alias to match recurring_schedules / agent_schedule.
    -- Production INSERTs always pass model explicitly (session-manager.ts);
    -- this DEFAULT is the safety-net path. The 'sonnet' alias is resolved
    -- at runtime by claude-code-core.ts:resolveActualModelId so the row
    -- forward-tracks DEFAULT_CLAUDE_MEDIUM_MODEL bumps.
    model TEXT DEFAULT 'sonnet',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'closed')),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    is_dm INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_lookup
    ON conversation_sessions(platform, channel_id, thread_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_scope
    ON conversation_sessions(scope, scope_key, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_sessions_scope_active
    ON conversation_sessions(scope, scope_key)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS dm_conversation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'platform_dm'
        CHECK (scope IN ('platform_dm', 'owner_dm')),
    scope_key TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dm_log_platform
    ON dm_conversation_log(platform, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_log_scope
    ON dm_conversation_log(scope, scope_key, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES conversation_sessions(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    platform TEXT NOT NULL,
    sender_id TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSON DEFAULT '{}',
    backend TEXT,
    model_id TEXT,
    notification_dispatch_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_dispatch
    ON messages(notification_dispatch_id)
    WHERE notification_dispatch_id IS NOT NULL;

-- ── Agent Actions & Schedule ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    action_type TEXT NOT NULL,
    trigger TEXT,
    model_used TEXT,
    cost_usd REAL,
    tokens_input INTEGER,
    tokens_output INTEGER,
    duration_ms INTEGER,
    num_turns INTEGER,
    -- DELEGATED-TASK-MODE-DESIGN.md §11.1 — 'in_progress' is a transient
    -- state for delegated_task.exec rows: written before subprocess spawn
    -- so step rows can record the header id, then flipped to
    -- success/failed at completion. The boot-time janitor closes any rows
    -- that survive a crash. All other action_types should still settle to
    -- one of the four terminal states.
    result TEXT CHECK (result IN ('success', 'failed', 'partial', 'skipped', 'in_progress')),
    detail JSON,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    error TEXT,
    context_updated INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER,
    cache_read_tokens INTEGER,
    model_usage_json TEXT,
    backend TEXT,
    cost_source TEXT,
    advisor_call_count INTEGER NOT NULL DEFAULT 0,
    -- ── Trigger provenance (docs/design/19-dashboard-ia-and-triggers.md) ──
    -- source_kind tags the upstream surface that produced this action:
    --   'trigger'      — fired by an automation_triggers row
    --   'message'      — owner DM / mention / dashboard chat
    --   'cron'         — built-in routine (morning, hourly, evening, ...)
    --   'observation'  — hourly-check consumed pending observations
    --   'manual'       — Run-now / dashboard-driven invocation
    --   NULL           — legacy / not yet classified
    -- source_ref is the id of the upstream entity (e.g. trigger id).
    -- These columns are nullable; dispatcher populates them as wiring lands.
    source_kind TEXT,
    source_ref TEXT,
    -- Agent-self-reported structured metadata. Written by the running
    -- session via PATCH /api/agent-actions/self so daemon-side
    -- consumers (morning-routine AgentJournalAppender, anomaly
    -- surfacing, audit log) read structured fields instead of parsing
    -- LLM final-text prose. See docs/design/appendices/morning-routine-
    -- optimization.md "Data-flow principle: prose vs structured".
    -- detail remains the daemon-write telemetry channel; metadata is
    -- the chokepointed agent-write side-channel so the two
    -- responsibilities do not collide.
    metadata JSON DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_actions_date ON agent_actions(date(started_at));
CREATE INDEX IF NOT EXISTS idx_agent_actions_backend_time
    ON agent_actions(backend, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_source
    ON agent_actions(source_kind, source_ref, started_at DESC)
    WHERE source_kind IS NOT NULL;

-- recurring_schedules is created before agent_schedule so the FK reference
-- in agent_schedule is syntactically valid. SQLite doesn't validate FK
-- targets at CREATE TABLE time so the reverse FK in recurring_schedules is fine.
CREATE TABLE IF NOT EXISTS recurring_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,
    task_description TEXT,
    -- Optional override for the agent task body. When NULL, dispatch falls back
    -- to task_description (preserves behavior for system-generated rows that
    -- only carry a short label, and for skill-created schedules predating
    -- this column). When set, replaces task_description as the task-slot
    -- value the dispatcher injects into the task-flow template.
    task_prompt TEXT,
    task_context JSON DEFAULT '{}',
    -- NULL means "no operator override — let BackendRouter resolve tier
    -- from process-key defaults / process_backend_config". Concrete
    -- 'sonnet' / 'opus' is reserved for explicit operator escape hatches
    -- (PATCH /api/recurring-schedules with model field). Defaulting to
    -- 'sonnet' here forced the row's requestedModel downstream and
    -- silently bypassed process_backend_config overrides for
    -- agent.task / agent.dm_task.
    model TEXT,
    -- Abstract tier override added 2026-05. NULL means "no operator
    -- override — let BackendRouter resolve the tier from process-key
    -- defaults / process_backend_config (medium for agent.task /
    -- agent.dm_task)". When set, the scheduler propagates the value
    -- as event.requestedTier, which the dispatcher passes to
    -- BackendRouter.resolveBinding ahead of the legacy model-derived
    -- tier. Use this instead of \`model\` to scale a hot recurring task
    -- down to Haiku (or up to Opus) without binding to a specific
    -- Claude model id — e.g. a docker health-check that fires hourly
    -- can pin \`tier_override = 'lite'\` and stay on the Haiku envelope
    -- regardless of which backend the operator has bound to
    -- agent.task in /settings/models. CHECK keeps a typo from
    -- silently pinning a row to an unrecognised tier.
    tier_override TEXT CHECK (tier_override IS NULL OR tier_override IN ('lite', 'medium', 'high')),
    -- SCHEDULE_API_REDESIGN_PLAN §4.3a — snapshot of the operator's
    -- backend pin at write time. Companions \`model\` so a registered
    -- full model id (e.g. 'claude-opus-4-7') resolves to a (backend,
    -- model) tuple at dispatch instead of being silently dropped.
    -- NULL means "no backend pin": legacy alias rows ('sonnet'/'opus')
    -- and pure-tier rows leave it NULL and the scheduler falls through
    -- to process-key defaults. CHECK matches \`BackendId\` in
    -- @aitne/shared so a typo can't smuggle through a non-existent
    -- backend tag.
    backend_id TEXT
        CHECK (backend_id IS NULL OR backend_id IN ('claude', 'codex', 'gemini', 'opencode')),
    recurrence_rule JSON NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_scheduled_id INTEGER,
    next_run_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (last_scheduled_id) REFERENCES agent_schedule(id)
);
CREATE INDEX IF NOT EXISTS idx_recurring_enabled
    ON recurring_schedules(enabled, next_run_at)
    WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS agent_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduled_for TIMESTAMP NOT NULL,
    task_type TEXT NOT NULL,
    task_description TEXT,
    -- Optional override for the agent task body. See recurring_schedules
    -- for the full rationale. NULL = dispatch uses task_description.
    task_prompt TEXT,
    task_context JSON DEFAULT '{}',
    correlation_id TEXT,
    -- See recurring_schedules.model: NULL means "no override". The
    -- scheduler propagates a non-NULL value as event.requestedModel,
    -- which the dispatcher converts into a hard requestedTier that
    -- supersedes process_backend_config. Default-to-'sonnet' would
    -- pin every materialised row to the light tier and defeat the
    -- per-process backend pinning UI.
    model TEXT,
    -- Mirrors recurring_schedules.tier_override (see header note).
    -- Propagated from a recurring parent row at reconciliation time,
    -- or set directly on a one-shot row via POST /api/schedule.
    tier_override TEXT CHECK (tier_override IS NULL OR tier_override IN ('lite', 'medium', 'high')),
    -- SCHEDULE_API_REDESIGN_PLAN §4.3a — see recurring_schedules
    -- header. Propagated verbatim from the recurring parent at
    -- materialization time (one-shot rows set it directly via POST
    -- /api/schedule once Phase D is in). When non-NULL, the
    -- scheduler emits both requestedBackendId and requestedModelId
    -- so the dispatcher's override block (which guards on BOTH
    -- fields together) actually applies the pin instead of silently
    -- dropping it.
    backend_id TEXT
        CHECK (backend_id IS NULL OR backend_id IN ('claude', 'codex', 'gemini', 'opencode')),
    status TEXT DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'skipped', 'failed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    recurring_schedule_id INTEGER REFERENCES recurring_schedules(id)
);
CREATE INDEX IF NOT EXISTS idx_schedule_pending
    ON agent_schedule(scheduled_for) WHERE status = 'pending';

-- ── Automation Triggers (docs/design/19-dashboard-ia-and-triggers.md) ────────
--
-- A Trigger is a per-domain rule: when an event happens, run the LLM with a
-- user-defined free-form prompt. There is no action_kind enum — the LLM
-- decides what to do (DM owner, write MD, run analysis) by reading the prompt
-- and using whatever skills are in scope.
--
-- v1 scope: only cron event types are dispatched; for them, a paired
-- recurring_schedule row carries the schedule and the prompt is propagated
-- via task_description. Realtime events (push.failed, pr.opened, ...) are
-- accepted by the schema but not yet wired to observers — see Phase 2.5.
CREATE TABLE IF NOT EXISTS automation_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    event_type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    -- For cron triggers, the recurring_schedules row that drives firing.
    -- ON DELETE SET NULL so a manual recurring_schedule cleanup doesn't
    -- cascade into orphaned triggers; the trigger row stays as a record.
    recurring_schedule_id INTEGER REFERENCES recurring_schedules(id) ON DELETE SET NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_automation_triggers_domain
    ON automation_triggers(domain, enabled);

-- ── Notifications & Channels ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_id TEXT NOT NULL DEFAULT '',
    notification_type TEXT,
    priority TEXT CHECK (priority IN ('critical', 'high', 'normal', 'low')),
    platform TEXT,
    delivery_channel TEXT,
    delivery_message_id TEXT,
    content_summary TEXT,
    user_reaction TEXT,
    reacted_at TIMESTAMP,
    status TEXT DEFAULT 'delivered'
        CHECK (status IN ('delivered', 'batched', 'suppressed', 'failed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notification_dispatch
    ON notification_log(dispatch_id, platform);

CREATE TABLE IF NOT EXISTS owner_channels (
    platform TEXT PRIMARY KEY,
    sender_id TEXT,
    channel_id TEXT NOT NULL,
    last_inbound_at TIMESTAMP,
    last_outbound_at TIMESTAMP,
    metadata JSON DEFAULT '{}'
);

-- ── Persistent State & Context ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS md_file_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    trigger TEXT NOT NULL,
    session_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_snapshots_file
    ON md_file_snapshots(file_path, created_at DESC);

CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    change_type TEXT NOT NULL
        CHECK (change_type IN ('created', 'modified', 'deleted')),
    actor TEXT NOT NULL DEFAULT 'user'
        CHECK (actor IN ('user', 'agent', 'system', 'unknown')),
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    payload TEXT,
    consumed_at TIMESTAMP,
    consumed_by TEXT,
    -- cost-reduction-structural section A -- pre-summarization at insert time.
    -- The summarizer worker (observers/observation-summarizer.ts) drains
    -- pending rows asynchronously and populates these columns; the
    -- hourly_check skill consumes the summary instead of fetching raw
    -- content unless novelty_score >= 2. NULL novelty_score + non-
    -- 'done' status means hourly_check falls back to legacy fetch-on-doubt.
    summary_text TEXT,
    novelty_score INTEGER CHECK (novelty_score IS NULL OR (novelty_score >= 0 AND novelty_score <= 3)),
    summary_at TEXT,
    summary_backend TEXT,
    summary_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (summary_status IN ('pending', 'done', 'skipped', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_obs_pending
    ON observations(consumed_at) WHERE consumed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_unique_pending
    ON observations(source, ref) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_obs_observed_at
    ON observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_obs_summary_status
    ON observations(summary_status, observed_at);

CREATE TABLE IF NOT EXISTS runtime_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_bang_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    backend_id TEXT NOT NULL CHECK (backend_id IN ('claude', 'codex', 'gemini', 'opencode')),
    model_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    -- JSON array of skill slugs to materialize into the per-turn workdir.
    -- NULL = legacy default (notify only). [] = no skills.
    enabled_skills_json TEXT,
    -- Custom CLAUDE.md / AGENTS.md / GEMINI.md profile body. Replaces the
    -- conversational profile when non-NULL; safety preamble + character
    -- block + skills section are still emitted around it.
    instruction_md TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_bang_commands_enabled
    ON user_bang_commands(enabled, command);

-- ── Unified Repositories (docs/design/appendices/unified-repositories.md) ───
--
-- One Repository row replaces the legacy split between gitRepos,
-- gitWatchedRepos, and githubRepos. A row pairs an optional GitHub
-- remote and an optional local clone; at least one side must be present
-- (CHECK constraint). local_only = 1 is an explicit user choice that
-- forbids ever pairing a GitHub remote — the second CHECK enforces that
-- the boolean and the columns agree.

CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    github_owner TEXT,
    github_repo TEXT,
    github_account TEXT,
    local_path TEXT,
    local_only INTEGER NOT NULL DEFAULT 0
        CHECK (local_only IN (0, 1)),
    display_name TEXT,
    classification TEXT NOT NULL DEFAULT 'repo-only'
        CHECK (classification IN ('project', 'repo-only')),
    category TEXT NOT NULL DEFAULT 'other'
        CHECK (category IN ('work', 'personal', 'research', 'client', 'other')),
    poll_priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (poll_priority IN ('high', 'normal')),
    poll_interval_sec INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (github_owner IS NULL AND github_repo IS NULL)
        OR (github_owner IS NOT NULL AND github_repo IS NOT NULL)
    ),
    CHECK (
        (github_owner IS NOT NULL AND github_repo IS NOT NULL)
        OR local_path IS NOT NULL
    ),
    CHECK (
        (local_only = 1 AND github_owner IS NULL AND github_repo IS NULL)
        OR local_only = 0
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_github
    ON repositories (github_owner, github_repo)
    WHERE github_owner IS NOT NULL AND github_repo IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_local
    ON repositories (local_path)
    WHERE local_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS repository_triggers (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL
        REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
        CHECK (enabled IN (0, 1)),
    event_type TEXT NOT NULL,
    filters_json TEXT NOT NULL DEFAULT '{}',
    backend TEXT NOT NULL
        CHECK (backend IN ('claude', 'codex', 'gemini', 'opencode')),
    model TEXT NOT NULL,
    workdir_mode TEXT NOT NULL
        CHECK (workdir_mode IN ('temp', 'local-clone')),
    prompt TEXT NOT NULL,
    instruction_md TEXT,
    last_fired_at INTEGER,
    fire_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (workdir_mode = 'temp' AND instruction_md IS NOT NULL)
        OR workdir_mode = 'local-clone'
    )
);
CREATE INDEX IF NOT EXISTS idx_triggers_repo
    ON repository_triggers (repository_id);
CREATE INDEX IF NOT EXISTS idx_triggers_event
    ON repository_triggers (event_type, enabled);

CREATE TABLE IF NOT EXISTS repository_management (
    repository_id TEXT PRIMARY KEY
        REFERENCES repositories(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0
        CHECK (enabled IN (0, 1)),
    init_completed_at INTEGER,
    last_scan_at INTEGER,
    last_scan_status TEXT
        CHECK (last_scan_status IS NULL OR last_scan_status IN ('ok', 'failed', 'skipped_no_activity')),
    scan_failure_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- ── Full-text Search (FTS5) ───────────────────────────────────────────────────

CREATE VIRTUAL TABLE IF NOT EXISTS fts_actions USING fts5(
    action_type, detail,
    content='agent_actions', content_rowid='id',
    tokenize='trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
    content,
    content='messages', content_rowid='id',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_actions_ai AFTER INSERT ON agent_actions BEGIN
    INSERT INTO fts_actions(rowid, action_type, detail)
    VALUES (new.id, new.action_type, json_extract(new.detail, '$'));
END;
CREATE TRIGGER IF NOT EXISTS trg_actions_ad AFTER DELETE ON agent_actions BEGIN
    INSERT INTO fts_actions(fts_actions, rowid, action_type, detail)
    VALUES ('delete', old.id, old.action_type, json_extract(old.detail, '$'));
END;
CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO fts_messages(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO fts_messages(fts_messages, rowid, content)
    VALUES ('delete', old.id, old.content);
END;

-- ── Docs & QA full-text index (DOCS_QA_DESIGN.md §7) ─────────────────────────
--
-- Contentless FTS5 table — the source of truth lives on disk under
-- docs/user/, the indexer re-builds rows on boot scan and on chokidar
-- file events. Column order matches the bm25 weights vector
-- (3.0, 2.5, 2.0, 1.5, 1.2, 1.0) applied at query time. Unindexed columns
-- (slug, tags, process_keys, config_keys, category, section, status, anchors)
-- are filter-only and are never ranked.

CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs USING fts5(
    slug UNINDEXED,
    title, keywords, aliases, summary, ask_examples, body,
    tags UNINDEXED, process_keys UNINDEXED, config_keys UNINDEXED,
    category UNINDEXED, section UNINDEXED, status UNINDEXED,
    anchors UNINDEXED,
    related UNINDEXED,
    tokenize='trigram'
);

-- ── Docs term subindex (DOCS-QA-SEARCH-PRECISION-PLAN.md §6) ────────────
--
-- Term-granular companion to fts_docs. Populated by indexer.ts at the
-- same time as fts_docs. One row per doc-level "header" (frontmatter
-- title + aliases + keywords merged) plus one row per H2/H3 section.
-- Query path: /api/docs/term-search hits this table first; the body
-- index is a fallback. Tokenizer is unicode61 because term lookups are
-- almost always Latin-script identifier-style queries; CJK fallback is
-- handled by the trigram body index.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_doc_terms USING fts5(
    slug UNINDEXED,
    anchor UNINDEXED,
    term, aliases, summary,
    category UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
);

-- ── Body word index — DOCS-QA-SEARCH-PRECISION-PLAN.md §7 ───────────────
--
-- Word-boundary English companion to fts_docs (which keeps trigram
-- tokenization for CJK substring fallback). Carries the same ranked-
-- text columns as fts_docs plus the two filter columns the search
-- route actually uses (category, tags) so the ASCII branch can stay
-- a single-table query. Storing UNINDEXED columns on a contentless
-- FTS5 table costs only the raw bytes — they are not tokenized, do
-- not participate in BM25, and do not enlarge the FTS index.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs_word USING fts5(
    slug UNINDEXED,
    title, keywords, aliases, summary, ask_examples, body,
    category UNINDEXED, tags UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
);

-- Side-table per Q7: lets /api/docs/health report indexer drift and the
-- P5 lint pass detect docs whose on-disk hash diverges from the indexed
-- copy. (slug, body_hash, frontmatter_hash) is the change-detection
-- triple; indexed_at is informational.
CREATE TABLE IF NOT EXISTS docs_revisions (
    slug TEXT PRIMARY KEY,
    body_hash TEXT NOT NULL,
    frontmatter_hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── Multi-backend Config ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backends (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    auth_method TEXT,
    auth_status TEXT NOT NULL DEFAULT 'unknown',
    auth_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    web_search_enabled INTEGER NOT NULL DEFAULT 0,
    auth_detail TEXT,
    auth_first_expired_at TEXT,
    auth_notified_at TEXT,
    auth_notification_count INTEGER NOT NULL DEFAULT 0,
    auth_last_success_at TEXT,
    auth_keepalive_notified_at TEXT,
    auth_last_verified_at TEXT
);

CREATE TABLE IF NOT EXISTS backend_global_defaults (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    default_backend TEXT NOT NULL,
    default_lite_model TEXT NOT NULL,
    default_medium_model TEXT NOT NULL,
    default_high_model TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    advisor_enabled INTEGER NOT NULL DEFAULT 0,
    advisor_model TEXT,
    FOREIGN KEY (default_backend) REFERENCES backends(id)
);

CREATE TABLE IF NOT EXISTS process_backend_config (
    process_key TEXT PRIMARY KEY,
    main_backend TEXT NOT NULL,
    main_model TEXT NOT NULL,
    fallback_backend TEXT,
    fallback_model TEXT,
    max_turns INTEGER NOT NULL DEFAULT 50,
    max_budget_usd REAL NOT NULL DEFAULT 1.00,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL DEFAULT 'user',
    FOREIGN KEY (main_backend) REFERENCES backends(id),
    FOREIGN KEY (fallback_backend) REFERENCES backends(id)
);

-- ── Wiki Builder ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wiki_workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal', 'external')),
    root_path TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    dispatch_mode TEXT NOT NULL DEFAULT 'parallel' CHECK (dispatch_mode IN ('parallel', 'serial')),
    concurrency_cap INTEGER NOT NULL DEFAULT 3 CHECK (concurrency_cap BETWEEN 1 AND 10),
    dm_agent_write_enabled INTEGER NOT NULL DEFAULT 0,
    bridge_enabled INTEGER NOT NULL DEFAULT 0,
    -- WIKI_BUILDER_DESIGN.md Phase 5 — bridge feature gate and measurement
    -- knobs. \`bridge_measurement_only\` (default 1) keeps the bridge in
    -- "observe but don't write" mode for the §P5.A 2-week measurement
    -- period; flipped to 0 once the trigger / dedup / threshold answers
    -- have been quantified. \`bridge_min_confidence\` is the per-workspace
    -- quality threshold (§10.3 Q6). Proposals at or above the threshold
    -- become writes (or candidate rows when measurement-only); proposals
    -- below it are dropped silently.
    bridge_measurement_only INTEGER NOT NULL DEFAULT 1 CHECK (bridge_measurement_only IN (0, 1)),
    bridge_min_confidence REAL NOT NULL DEFAULT 0.70 CHECK (bridge_min_confidence BETWEEN 0 AND 1),
    full_compile_approval_threshold_usd REAL NOT NULL DEFAULT 2.00,
    -- WIKI_BUILDER_DESIGN.md §P2.A / §14 Q5 — external-mode write strategy
    -- ('fs' direct, 'cli' via Obsidian CLI, 'auto' resolved on first write)
    -- and the per-workspace toggle that gates the pre-compile git auto-
    -- commit for git-tracked external vaults. Internal-mode workspaces
    -- read these as defaults but never exercise them.
    write_strategy TEXT NOT NULL DEFAULT 'fs' CHECK (write_strategy IN ('fs', 'cli', 'auto')),
    git_pre_compile_enabled INTEGER NOT NULL DEFAULT 1 CHECK (git_pre_compile_enabled IN (0, 1)),
    schema_version INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    last_ingest_at TEXT,
    last_compile_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- WIKI_BUILDER_DESIGN.md §P5.C — multi-workspace. Phase 1 carried a
-- \`UNIQUE INDEX (active) WHERE active = 1\` (the old constraint) so only
-- one workspace could be active at a time. Phase 5 unlocks it: every
-- DB at boot drops the old unique variant (idempotent, no-op when it
-- was never created) and re-creates a plain index on \`active\` so the
-- list query still uses an index without forcing single-active.
DROP INDEX IF EXISTS idx_wiki_workspaces_active;
CREATE INDEX IF NOT EXISTS idx_wiki_workspaces_active_v2
    ON wiki_workspaces(active);
CREATE INDEX IF NOT EXISTS idx_wiki_workspaces_name
    ON wiki_workspaces(name);

-- WIKI_BUILDER_DESIGN.md §P5.B — bridge dedup. Lives in its own table
-- (rather than encoding the hash inside \`agent_actions.detail\`) so the
-- \`content_hash\` unique index can earn its keep without bloating the
-- broad audit table. Each row binds a hashed bridge candidate to the
-- workspace and source that produced it; replays at the same source
-- short-circuit on the unique constraint. Loop guard rejects sources
-- whose \`source_ref\` matches the bridge filename prefix before the row
-- is ever inserted — see core/wiki/bridge.ts.
CREATE TABLE IF NOT EXISTS wiki_bridge_dedup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES wiki_workspaces(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    bridge_path TEXT,
    confidence REAL,
    accepted INTEGER NOT NULL DEFAULT 1 CHECK (accepted IN (0, 1)),
    detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (workspace_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_wiki_bridge_dedup_workspace
    ON wiki_bridge_dedup(workspace_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_wiki_bridge_dedup_source
    ON wiki_bridge_dedup(workspace_id, source_kind, source_ref);

-- WIKI_BUILDER_DESIGN.md §12 / §P4.A — Full-text search across wiki content.
-- Content-less FTS5 index maintained by wiki-fts.ts (the canonical store
-- is the filesystem, not a SQL table, so the mail-style INSERT/UPDATE/
-- DELETE trigger chain does not apply — wiki.ts API route handlers call
-- upsertWikiFulltextRow / deleteWikiFulltextRow directly after a successful
-- disk write). Boot-time backfill via wiki-fts.ts:backfillWikiFulltext.
-- Tokenizer matches fts_mail_messages (line 684 above) for consistency.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_wiki USING fts5(
    workspace_id UNINDEXED,
    path UNINDEXED,
    layer UNINDEXED,
    title,
    body,
    mtime UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- ── Auth Telemetry ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth_telemetry_counters (
    backend_id TEXT NOT NULL,
    counter_key TEXT NOT NULL,
    bucket_hour TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'reactive',
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (backend_id, counter_key, bucket_hour, source)
);
CREATE INDEX IF NOT EXISTS idx_auth_telemetry_bucket
    ON auth_telemetry_counters(bucket_hour);

-- ── Life Management ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    source TEXT NOT NULL DEFAULT 'kindle',
    status TEXT DEFAULT 'reading',
    started_at TEXT,
    completed_at TEXT,
    rating INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_title_author
    ON books(title, COALESCE(author, ''));

CREATE TABLE IF NOT EXISTS reading_highlights (
    id INTEGER PRIMARY KEY,
    book_id INTEGER REFERENCES books(id),
    content TEXT NOT NULL,
    location TEXT,
    note TEXT,
    highlighted_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reading_highlights_book
    ON reading_highlights(book_id);

-- ── Multi-provider Mail ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mail_accounts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    email TEXT NOT NULL,
    label TEXT,
    auth_type TEXT NOT NULL,
    auth_status TEXT NOT NULL DEFAULT 'healthy',
    secret_blob_name TEXT NOT NULL,
    poll_cursor_json TEXT,
    poll_interval_seconds INTEGER NOT NULL DEFAULT 300,
    idle_enabled INTEGER NOT NULL DEFAULT 0,
    idle_fallback_until TEXT,
    unified_poll INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at_utc TEXT NOT NULL,
    last_error TEXT,
    last_error_at_utc TEXT,
    last_poll_at_utc TEXT,
    consecutive_error_count INTEGER NOT NULL DEFAULT 0,
    imap_capabilities_json TEXT,
    UNIQUE(kind, email)
);

CREATE TABLE IF NOT EXISTS mail_messages_index (
    account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    provider_msg_id TEXT NOT NULL,
    rfc822_msg_id TEXT,
    thread_id TEXT,
    folder TEXT NOT NULL,
    received_at_utc TEXT NOT NULL,
    subject TEXT,
    from_email TEXT,
    to_emails_json TEXT,
    snippet TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    flags_json TEXT,
    has_attachment INTEGER NOT NULL DEFAULT 0,
    deleted_at_utc TEXT,
    observed_at_utc TEXT NOT NULL,
    PRIMARY KEY (account_id, provider_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread
    ON mail_messages_index(account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_received
    ON mail_messages_index(received_at_utc);
CREATE INDEX IF NOT EXISTS idx_mail_messages_unread
    ON mail_messages_index(account_id, is_read, received_at_utc)
    WHERE is_read = 0 AND deleted_at_utc IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS fts_mail_messages USING fts5(
    account_id UNINDEXED,
    provider_msg_id UNINDEXED,
    subject,
    snippet,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_mail_messages_ai
    AFTER INSERT ON mail_messages_index
    WHEN NEW.deleted_at_utc IS NULL
    BEGIN
        INSERT INTO fts_mail_messages(account_id, provider_msg_id, subject, snippet)
        VALUES (NEW.account_id, NEW.provider_msg_id,
                COALESCE(NEW.subject, ''), COALESCE(NEW.snippet, ''));
    END;
CREATE TRIGGER IF NOT EXISTS trg_mail_messages_ad
    AFTER DELETE ON mail_messages_index
    BEGIN
        DELETE FROM fts_mail_messages
         WHERE account_id = OLD.account_id
           AND provider_msg_id = OLD.provider_msg_id;
    END;
CREATE TRIGGER IF NOT EXISTS trg_mail_messages_au
    AFTER UPDATE OF subject, snippet, deleted_at_utc ON mail_messages_index
    BEGIN
        DELETE FROM fts_mail_messages
         WHERE account_id = OLD.account_id
           AND provider_msg_id = OLD.provider_msg_id;
        INSERT INTO fts_mail_messages(account_id, provider_msg_id, subject, snippet)
        SELECT NEW.account_id, NEW.provider_msg_id,
               COALESCE(NEW.subject, ''), COALESCE(NEW.snippet, '')
         WHERE NEW.deleted_at_utc IS NULL;
    END;

CREATE TABLE IF NOT EXISTS parse_failures (
    id INTEGER PRIMARY KEY,
    account_id TEXT,
    provider_msg_id TEXT,
    sender TEXT,
    subject TEXT,
    snippet TEXT,
    error_reason TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_parse_failures_account_msg
    ON parse_failures(account_id, provider_msg_id)
    WHERE provider_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_parse_failures_created_at
    ON parse_failures(created_at);
CREATE INDEX IF NOT EXISTS idx_parse_failures_account
    ON parse_failures(account_id);

CREATE TABLE IF NOT EXISTS travel_bookings (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    provider TEXT NOT NULL,
    destination TEXT,
    start_date TEXT,
    end_date TEXT,
    confirmation_number TEXT,
    amount INTEGER,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT DEFAULT 'upcoming',
    provider_msg_id TEXT,
    account_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_bookings_account_msg
    ON travel_bookings(account_id, provider_msg_id)
    WHERE provider_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_travel_bookings_start ON travel_bookings(start_date);
CREATE INDEX IF NOT EXISTS idx_travel_bookings_status ON travel_bookings(status);
CREATE INDEX IF NOT EXISTS idx_travel_bookings_type ON travel_bookings(type);
CREATE INDEX IF NOT EXISTS idx_travel_bookings_account ON travel_bookings(account_id);

CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY,
    provider_msg_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER,
    category TEXT,
    obsidian_path TEXT,
    saved_at TEXT,
    account_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(account_id, provider_msg_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_receipts_category ON receipts(category);
CREATE INDEX IF NOT EXISTS idx_receipts_saved
    ON receipts(saved_at) WHERE saved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_account ON receipts(account_id);

-- ── Management Mode ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS migration_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    backup_path TEXT NOT NULL,
    files_count INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'rolled_back', 'expired')),
    expires_at TEXT NOT NULL,
    rollback_completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_migration_backups_status_expires
    ON migration_backups(status, expires_at);

-- ── MCP Servers ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
    command TEXT,
    args TEXT,
    cwd TEXT,
    url TEXT,
    env_keys TEXT NOT NULL DEFAULT '[]',
    header_keys TEXT NOT NULL DEFAULT '[]',
    backends TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    risk_tier TEXT NOT NULL DEFAULT 'approve' CHECK (risk_tier IN ('read', 'approve')),
    tool_allowlist TEXT,
    last_probe_at INTEGER,
    last_probe_status TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    event_type TEXT,
    session_id TEXT,
    ok INTEGER,
    error TEXT,
    called_at INTEGER NOT NULL,
    duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_server
    ON mcp_tool_calls(server_id, called_at DESC);

-- ── Chat Attachments ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_attachments (
    id TEXT PRIMARY KEY,
    session_id INTEGER,
    message_id INTEGER,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    provenance TEXT NOT NULL,
    path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    safe_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    turn_token TEXT,
    caption TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_session
    ON chat_attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message
    ON chat_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_turn
    ON chat_attachments(turn_token) WHERE turn_token IS NOT NULL;

-- ── Voice Transcripts (local Whisper) ────────────────────────────────────────
-- Cached transcription of inbound audio attachments produced by the
-- VoiceTranscriber service. Keyed 1:1 to chat_attachments.id so a
-- re-dispatch of the same turn does not re-run inference. See
-- docs/design/appendices/voice-transcription.md.
CREATE TABLE IF NOT EXISTS voice_transcripts (
    attachment_id TEXT PRIMARY KEY
        REFERENCES chat_attachments(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    language TEXT,
    duration_sec REAL,
    transcript TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Integration Delegation ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS integration_probes (
    integration_key TEXT NOT NULL,
    backend_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    probed_at TEXT NOT NULL,
    PRIMARY KEY (integration_key, backend_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_probes_recency
    ON integration_probes(probed_at);

-- ── Integration Drift Detection (INTEGRATION-DRIFT-DETECTION-PLAN.md §4) ─────
-- Mode-agnostic snapshot store. Each (integration, window_key) partition
-- holds the last-fetched payload set; reconcile diffs incoming items against
-- it. window_key partitions diffs so a deletion in a narrow window does not
-- emit a phantom 'deleted' for an item still alive in a wider window. The
-- per-integration normalizer's inWindow predicate further distinguishes
-- "slid out of window" prunes from real upstream deletions.
--
-- payload_json carries only the fields needed for diff + render (target
-- <2 KB). actor_hint pre-marks items the caller wrote itself; the reconciler
-- still consults integration_writes (below) as the authoritative source.
CREATE TABLE IF NOT EXISTS integration_snapshots (
    integration  TEXT NOT NULL,
    window_key   TEXT NOT NULL,
    item_id      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    item_start   TEXT,
    fetched_at   TEXT NOT NULL,
    actor_hint   TEXT NOT NULL DEFAULT 'user'
        CHECK (actor_hint IN ('user', 'agent', 'system', 'unknown')),
    PRIMARY KEY (integration, window_key, item_id)
);
-- Imminent-event scheduler scans this index range to find calendar events
-- starting in [now, now+15min] without a full table scan.
CREATE INDEX IF NOT EXISTS idx_integration_snapshots_imminent
    ON integration_snapshots(integration, item_start)
    WHERE item_start IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_integration_snapshots_fetched_at
    ON integration_snapshots(integration, window_key, fetched_at);

-- Generalises AgentWriteTracker (in-memory, path-keyed) to integration
-- writes with (integration, item_id) keys that survive process restarts.
-- Reconcile consults this on every created/modified diff entry: a row
-- whose expires_at > now tags the diff actor='agent' instead of 'user',
-- so the agent's own calendar/mail/notion writes do not surface as
-- user-originated observations on the next reconcile.
--
-- TTL default is set per-integration in code (15 min for calendar, 30 min
-- for slower-cadence integrations like Gmail/Notion). Cleanup runs as part
-- of the daily retention pass.
CREATE TABLE IF NOT EXISTS integration_writes (
    integration TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    written_at  TEXT NOT NULL,
    written_by  TEXT NOT NULL DEFAULT 'agent',
    expires_at  TEXT NOT NULL,
    PRIMARY KEY (integration, item_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_writes_expires
    ON integration_writes(expires_at);

-- ── Browser History Integration (P1 infra + observability) ─────────────────

CREATE TABLE IF NOT EXISTS browser_visits (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    browser TEXT NOT NULL,
    profile TEXT,
    url_hash TEXT NOT NULL,
    domain TEXT NOT NULL,
    category TEXT NOT NULL,
    meaningful INTEGER DEFAULT 0,
    dwell_sec INTEGER,
    foreground_sec INTEGER,
    transition INTEGER,
    is_reload INTEGER DEFAULT 0,
    root_task_id INTEGER,
    http_status INTEGER,
    title TEXT,
    search_query TEXT,
    amazon_asin TEXT,
    amazon_locale TEXT,
    UNIQUE(browser, profile, ts, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_browser_visits_ts
    ON browser_visits(ts);
CREATE INDEX IF NOT EXISTS idx_browser_visits_root_task
    ON browser_visits(root_task_id) WHERE root_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_browser_visits_amazon
    ON browser_visits(amazon_asin) WHERE amazon_asin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_browser_visits_meaningful
    ON browser_visits(meaningful, ts) WHERE meaningful = 1;

CREATE TABLE IF NOT EXISTS browser_research_clusters (
    slug TEXT PRIMARY KEY,
    root_task_id INTEGER NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    visits_total INTEGER NOT NULL,
    meaningful_visits_total INTEGER NOT NULL,
    meaningful_foreground_sec_total INTEGER NOT NULL,
    distinct_meaningful_domains INTEGER NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('active', 'dormant', 'concluded', 'muted')),
    last_dm_at INTEGER,
    last_research_offer_at INTEGER,
    last_wiki_offer_at INTEGER,
    research_offer_accepted_at INTEGER,
    wiki_summary_written_at INTEGER,
    agent_summary_revision INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS browser_pending_offers (
    slug TEXT NOT NULL,
    -- BROWSER_HISTORY_INTEGRATION_PLAN seventh-pass — the 'offered'
    -- kind is the two-option offer state (user asked, no reply yet);
    -- accept endpoint narrows it to research_assist / wiki_summary
    -- on dispatch. P3b-era rows with the kind-specific values still
    -- parse. Existing installs are migrated via the entry
    -- 0001-browser-pending-offers-add-offered-kind in migrations.ts.
    kind TEXT NOT NULL
        CHECK (kind IN ('offered', 'research_assist', 'wiki_summary')),
    offered_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (slug, kind)
);

CREATE TABLE IF NOT EXISTS browser_reload_signals (
    date TEXT NOT NULL,
    url_pattern TEXT NOT NULL,
    reload_count INTEGER NOT NULL,
    PRIMARY KEY (date, url_pattern)
);

CREATE TABLE IF NOT EXISTS browser_shopping_sessions (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    vendor TEXT NOT NULL,
    asin_set TEXT NOT NULL,
    comparison_minutes INTEGER NOT NULL,
    locale TEXT
);

-- ── Managed Chromium Automation (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.14, Phase B-2) ──
-- Per-workflow run audit row. Originally populated by the
-- workflow-runner; BROWSER_TASK_REDESIGN_PLAN.md §9 Phase 6 retired
-- both the runner and the \`/api/browser-automation/{workflows,recent-
-- runs}\` routes that fronted it. The table is INTENTIONALLY retained
-- as a read-only historical store so users with pre-Phase-6 audit rows
-- can still query their history out-of-band (sqlite shell). No live
-- code writes to it; new audit lives in \`browser_task_action_log\`.
-- The \`outcome\` CHECK constraint stays unchanged to preserve the
-- shape of historical rows; the Zod mirror that paired with it was
-- removed in the Phase 6.5 dead-code rip-out (shared/browser-history-
-- schemas.ts).
-- \`target_urls\` and \`blocked_requests\` were JSON arrays at write
-- time. \`screenshot_path\` and \`trace_path\` were NULL when the
-- workflow did not capture either (e.g., input_validation_error
-- outcomes that short-circuited before Playwright ran).
CREATE TABLE IF NOT EXISTS browser_automation_workflows (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id       TEXT NOT NULL UNIQUE,
    workflow_name     TEXT NOT NULL,
    params_hash       TEXT NOT NULL,
    target_urls       TEXT NOT NULL,
    blocked_requests  TEXT NOT NULL,
    duration_ms       INTEGER NOT NULL,
    outcome           TEXT NOT NULL CHECK (outcome IN (
        'success',
        'unknown_workflow',
        'input_validation_error',
        'output_validation_error',
        'url_not_allowlisted',
        'user_allowlist_blocked',
        'host_not_extractable',
        'rate_limited',
        'site_not_connected',
        'playwright_launch_timeout',
        'playwright_error',
        'timeout',
        -- ── Phase B-3 (gated write automation) outcomes ──
        -- Retained for historical audit rows. The B-3 approvals surface
        -- (workflow runner + frozen registry + approvals table) was
        -- retired in BROWSER_TASK_REDESIGN_PLAN.md §9 Phase 6; no new
        -- rows with these outcomes are written post-Phase-6.
        -- \`needs_approval\` — workflow was rejected because the caller
        --   did not present a valid approval token. (Historical: the
        --   companion pending row in browser_automation_approvals was
        --   dropped by migration 0004 in the same plan.)
        -- \`approval_expired\` — caller presented a token bound to an
        --   approval whose 5-min TTL elapsed before redemption.
        -- \`approval_token_invalid\` — token shape was wrong, did not
        --   match any pending approval, or referenced an approval that
        --   was already consumed / denied.
        -- \`payment_path_blocked\` — primary URL matched the hard-coded
        --   payment URL pattern set (/checkout, /payment, /place-order,
        --   /buy, /place-bid). B-3 could not touch payment paths even
        --   with a valid approval token; those belonged to B-4
        --   purchase workflows (§17.5) which use the DM-token gate.
        'needs_approval',
        'approval_expired',
        'approval_token_invalid',
        'payment_path_blocked',
        -- ── Phase B-4 (experimental purchase) runner-level outcomes ──
        -- MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17 / §13 steps 49-60.
        --
        -- These fire BEFORE the workflow's run() is invoked — the master
        -- toggle is off, per-site B-4 is not opted-in, a token is already
        -- pending for this site_key (per-site concurrency cap 1), or the
        -- per-site per-day token / spend cap is exhausted. In-flight
        -- branches (user replied wrong, timeout, page mutated under the
        -- pause, displayed total mismatch) surface through the workflow's
        -- structured outputSchema.status and the runner-level outcome
        -- stays \`success\` for those.
        --
        -- The DM-token gate itself is enforced inside the workflow via
        -- purchase-handler.awaitReply(jti); there is no runner-level
        -- \`purchase_token_invalid\` outcome because the agent CANNOT
        -- supply a token at the route layer (B-4's consent model is
        -- "daemon mints the token AFTER the pre-confirm screenshot;
        -- the user types it back in DM").
        'purchase_b4_disabled',
        'purchase_site_not_enabled',
        'purchase_pending_exists',
        'purchase_daily_cap_exceeded'
    )),
    started_at        INTEGER NOT NULL,
    finished_at       INTEGER NOT NULL,
    screenshot_path   TEXT,
    trace_path        TEXT
);
CREATE INDEX IF NOT EXISTS idx_browser_automation_workflows_started_at
    ON browser_automation_workflows(started_at);
CREATE INDEX IF NOT EXISTS idx_browser_automation_workflows_name
    ON browser_automation_workflows(workflow_name, started_at DESC);

-- BROWSER_TASK_REDESIGN_PLAN.md §9 Phase 6.5 follow-up retired the
-- Phase-B-2 per-domain user allowlist (\`browser_automation_allowlist\`).
-- The workflow-runner's deny-on-unknown gate that consumed it was
-- deleted in Phase 6; the four \`/api/browser-automation/allowlist*\`
-- routes that mutated it likewise. Fresh installs no longer materialise
-- the table; upgrading installs drop it via migration
-- 0005-drop-browser-automation-allowlist. The browser-task surface
-- gates host access through the registered \`site-registry.ts\`
-- \`allowedHostPattern\` plus per-request \`extraAllowedHosts\` (the
-- §14.1 subset rules in BROWSER_TASK_REDESIGN_PLAN.md), not a runtime
-- DB allowlist.
--
-- BROWSER_TASK_REDESIGN_PLAN.md §6.8 / Phase 6 retired the Phase-B-3
-- approvals surface (workflow runner + frozen registry). The
-- \`browser_automation_approvals\` table is no longer created on fresh
-- installs; upgrading installs drop it via migration
-- 0004-drop-browser-automation-approvals. The lite-final-confirm token
-- table that replaces it lives below alongside the Phase B-4 purchase
-- tokens — both write paths are owned by \`final-confirm-handler.ts\` /
-- \`purchase-handler.ts\` and dispatch via \`jti\` prefix on incoming
-- \`!~xxxxxxxx\` DM replies.

-- ── Phase B-4 (experimental purchase) — DM-issued single-use tokens ──
--
-- MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.6.
--
-- Every B-4 workflow (variant='purchase') goes through a strict
-- screenshot-first DM-confirmation flow. The daemon mints a token
-- ("!~<8 base32 chars>") AFTER taking the pre-confirm screenshot,
-- DMs the screenshot + token to the user's primary channels, and the
-- workflow pauses (§5.5 carve-out) on purchase-handler.awaitReply(jti).
-- The user reads the actual cart screenshot, types the exact token
-- back, and the messaging adapter's incoming-token-handler atomically
-- flips consumed_at from NULL to now. Workflow resumes, re-checks
-- the cart hasn't mutated, clicks confirm, captures post-confirm
-- screenshot, persists confirmed_amount_minor + order_id.
--
-- Schema invariants:
--   - jti is the server-side opaque id used for joins / audit; the
--     dashboard only ever sees jti, never the raw token.
--   - token carries the raw !~xxxxxxxx string while the row is
--     pending. The daily cleanup cron rotates token to NULL once
--     consumed_at or cancelled_at plus 1 day has elapsed, bounding
--     the window during which a stale DM-history token could be replayed
--     against a daemon bug. UNIQUE so a colliding mint (cosmically
--     unlikely under 40-bit entropy but cheap to enforce) fails the
--     INSERT at issuance time and the handler retries.
--   - delivered_channels is a JSON array of "<platform>:<channel_id>"
--     refs the daemon DMed to. The validation path checks the inbound
--     channel against this list — a reply on a non-delivered channel
--     cancels with a wrong_channel audit row (§17.4).
--   - cancel_reason is a closed CHECK set so a hand-written cancel
--     path cannot land an unrecognised category in the audit trail.
--   - confirmed_amount_minor / order_id / post_screenshot_path
--     populate only on the confirmed terminal path; everything else
--     leaves them NULL.
--
-- The runner-level outcome on browser_automation_workflows for any
-- B-4 invocation is either success (workflow ran to completion;
-- inspect output schema status for the cart-confirm verdict) or one
-- of purchase_b4_disabled / purchase_site_not_enabled /
-- purchase_pending_exists / purchase_daily_cap_exceeded for the
-- pre-flight rejections.
CREATE TABLE IF NOT EXISTS browser_automation_purchase_tokens (
    jti                       TEXT PRIMARY KEY,
    -- Raw "!~xxxxxxxx" string. NULL after the daily cleanup rotates
    -- consumed/cancelled rows. UNIQUE while non-null — collision at
    -- mint time fails the INSERT and the handler retries.
    token                     TEXT UNIQUE,
    workflow_invocation_id    TEXT NOT NULL,
    site_key                  TEXT NOT NULL,
    url_pattern               TEXT NOT NULL,
    -- The actually-displayed total at screenshot time, in minor units
    -- (e.g., yen = JPY x 1; cents = USD x 100). The agent's input
    -- expectedMaxAmountMinor is a sanity check the workflow uses
    -- BEFORE minting (abort if exceeds); the token's
    -- max_amount_minor is the daemon-computed exact figure.
    max_amount_minor          INTEGER NOT NULL,
    currency                  TEXT NOT NULL,
    pre_screenshot_path       TEXT NOT NULL,
    notes_for_user            TEXT,
    delivered_channels        TEXT NOT NULL,
    issued_at                 INTEGER NOT NULL,
    expires_at                INTEGER NOT NULL,
    consumed_at               INTEGER,
    consumed_via_channel      TEXT,
    cancelled_at              INTEGER,
    cancel_reason             TEXT CHECK (cancel_reason IS NULL OR cancel_reason IN (
        'user_reply',
        'wrong_token',
        'wrong_channel',
        'timeout',
        'explicit',
        'amount_mismatch',
        'amount_exceeds_token',
        'page_changed',
        'playwright_error',
        'daily_cap_exceeded',
        'b4_disabled',
        'site_not_enabled',
        'supervisor_orphan_sweep',
        'dashboard_cancel'
    )),
    confirmed_amount_minor    INTEGER,
    order_id                  TEXT,
    post_screenshot_path      TEXT,
    -- Derived status — kept on the row so dashboard filters do not
    -- have to recompute. The application layer (purchase-tokens-store)
    -- writes this in lockstep with the timestamp columns; the CHECK
    -- closes the set so a hand-written status that drifts from the
    -- timestamps fails at the DB layer.
    status                    TEXT NOT NULL CHECK (status IN (
        'pending',
        'confirmed',
        'cancelled',
        'expired'
    ))
);
CREATE INDEX IF NOT EXISTS idx_purchase_tokens_site_at
    ON browser_automation_purchase_tokens(site_key, issued_at);
CREATE INDEX IF NOT EXISTS idx_purchase_tokens_status_expires
    ON browser_automation_purchase_tokens(status, expires_at);

-- ── B-4 reply audit trail ─────────────────────────────────────────────
--
-- Every inbound message classified as a !~xxxxxxxx-shaped reply lands
-- here, whether or not it matched a pending token. Powers the audit
-- view + spoofing/replay analysis. Stores message_body_hash
-- (sha256 of the raw body) NOT the raw token — even on the misclassify
-- path the raw string never persists outside browser_automation_purchase_tokens.token.
CREATE TABLE IF NOT EXISTS browser_automation_purchase_replies (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at       INTEGER NOT NULL,
    channel_ref       TEXT NOT NULL,
    message_body_hash TEXT NOT NULL,
    matched_jti       TEXT,
    outcome           TEXT NOT NULL CHECK (outcome IN (
        'consumed',
        'wrong_channel',
        'expired',
        'already_consumed',
        'already_cancelled',
        'no_match',
        'cancel_workflow',
        'shape_invalid'
    ))
);
CREATE INDEX IF NOT EXISTS idx_purchase_replies_received_at
    ON browser_automation_purchase_replies(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_replies_matched
    ON browser_automation_purchase_replies(matched_jti)
    WHERE matched_jti IS NOT NULL;

-- ── B-4 per-site enable + caps ────────────────────────────────────────
--
-- MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.8.
--
-- Per-site_key row. A site with enabled=0 cannot mint tokens — the
-- runner returns purchase_site_not_enabled before Playwright is
-- launched. Caps are enforced atomically at token-issuance time inside
-- the same transaction that inserts the purchase_tokens row.
--
-- currency is the canonical ISO-4217 code for that site (mirrors
-- the agent's params.currency). Caps are denominated in minor units
-- of that currency (¥ = JPY × 1; ¢ = USD × 100). Cross-currency math
-- never happens — every cap query filters on (site_key, currency)
-- before SUM().
CREATE TABLE IF NOT EXISTS browser_automation_b4_site_config (
    site_key                       TEXT PRIMARY KEY,
    enabled                        INTEGER NOT NULL DEFAULT 0
        CHECK (enabled IN (0, 1)),
    currency                       TEXT NOT NULL,
    daily_token_cap                INTEGER NOT NULL DEFAULT 5
        CHECK (daily_token_cap >= 1 AND daily_token_cap <= 100),
    daily_spend_cap_minor          INTEGER NOT NULL DEFAULT 30000
        CHECK (daily_spend_cap_minor >= 0),
    per_tx_cap_minor_override      INTEGER
        CHECK (per_tx_cap_minor_override IS NULL OR per_tx_cap_minor_override >= 0),
    updated_at                     INTEGER NOT NULL
);

-- ── B-4 primary-channel selection ─────────────────────────────────────
--
-- MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.8 "Primary channel
-- configuration: list of owner DM channels with a primary:boolean flag
-- per channel. Only primary channels receive B-4 confirmation requests.
-- At least one primary channel is required for B-4 to be enabled."
--
-- One row per (platform, channel_id) pair the user has flagged as
-- primary. The token-handler reads this set when minting a token; if
-- the originating channel of the request is primary, the token is
-- DM'd to that channel only (single-channel ergonomic flow). For
-- scheduled-task-driven B-4 invocations (no originating channel) the
-- token is fanned out to every primary channel and the validation
-- path follows the "approved on <channel>" rule (§17.3).
--
-- Stored as a separate table (not a column on owner_channels) so the
-- additive CREATE-IF-NOT-EXISTS upgrade path applies without an
-- ALTER on the pre-existing owner_channels table.
CREATE TABLE IF NOT EXISTS browser_automation_purchase_primary_channels (
    platform     TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    set_at       INTEGER NOT NULL,
    PRIMARY KEY (platform, channel_id)
);

-- ── Browser-task surface (BROWSER_TASK_REDESIGN_PLAN.md §6.4 / §6.6 / §6.7) ──
--
-- Open-ended natural-language browser sub-agent dispatched by
-- POST /api/browser-task. A fresh Claude-only IAgentCore drives a single
-- Playwright BrowserContext via the in-process \`aitne-browser\` MCP server.
-- The agent calls a fixed envelope of tools (navigate / screenshot /
-- dom_snapshot / click / type / press_key / wait_for / extract /
-- ask_user / yield_for_clarification / finish); the runner enforces
-- allowlist composition, the final-confirm gate, the §14 hardening
-- floor, and writes one audit row per step.
--
-- Three tables — all additive via CREATE-IF-NOT-EXISTS:
--   * browser_task                 — the task row + its terminal state
--   * browser_task_action_log      — per-step audit (one row per tool call)
--   * browser_task_clarifications  — ask_user round-trip queue
-- and one parallel-to-B-4 token table for the lite-final-confirm flow:
--   * browser_task_final_confirm_tokens
--
-- State machine (§4): pending → running → {awaiting_user|final_confirm}*
--   → {completed|failed|timeout|cancelled|abandoned}. The CHECK pins the
-- closed set so a hand-written transition cannot land an unknown state
-- in the audit trail.
--
-- Boot-recovery (§6.5): every row in {pending, running, awaiting_user,
-- final_confirm} is flipped to (failed, 'daemon_restarted') on next boot
-- — the in-memory BrowserContext is unrecoverable across restarts.
--
-- Foreign-key shape: the API serves screenshots via the existing
-- trace-store layer (\`<PA_DATA_DIR>/automation-traces/<taskId>/...\`), so
-- \`screenshot_key\` on the action log is the relative filename only — the
-- task id forms the directory.
CREATE TABLE IF NOT EXISTS browser_task (
    -- uuid v4 (crypto.randomUUID); shared with the trace-store sub-dir name.
    id                          TEXT PRIMARY KEY,
    -- Natural-language task description, the body of the sub-agent's
    -- prompt. Capped 1..4096 chars at the route layer.
    description                 TEXT NOT NULL,
    -- Matches \`site-registry.ts\`. Nullable so a future Phase 4.1 anon
    -- read path can land without a schema change; the Phase 1 route layer
    -- still rejects null with 400 (\`generic_anon\` deferred per §8).
    site_key                    TEXT,
    -- JSON array<string>. §14.1 enforces: count <= 5, host-only shape,
    -- eTLD+1 subset against the siteKey OR the \`EXTRA_ALLOWED_ETLD_HELPERS\`
    -- set, scheme floor (https for auth profiles, http(s) otherwise).
    -- Captured at task creation and never mutated mid-task (§14.1.5).
    extra_allowed_hosts_json    TEXT,
    -- "<platform>:<channel_id>". NULL when no DM channel is associable
    -- (synthetic test runs); the runner falls back to
    -- \`listPrimaryChannels()\` when emitting an ask_user / final-confirm DM.
    -- §14.8: the value is intersected with primary-channels ∪ session
    -- channel at task-creation time, never widened mid-task.
    originating_channel         TEXT,
    -- FK to agent_schedule when the task was inserted via \`scheduleAt\`.
    -- Nullable for immediate-run tasks. ON DELETE SET NULL so deleting a
    -- schedule row (rare) leaves the task row's history intact.
    schedule_row_id             INTEGER REFERENCES agent_schedule(id) ON DELETE SET NULL,
    -- §5 final-confirm gate toggle. Defaults true at the route layer.
    -- Stored as INTEGER 0/1 (SQLite has no bool).
    require_final_confirm       INTEGER NOT NULL DEFAULT 1
        CHECK (require_final_confirm IN (0, 1)),
    -- State machine — see §4.
    state                       TEXT NOT NULL CHECK (state IN (
        'pending',
        'running',
        'awaiting_user',
        'final_confirm',
        'completed',
        'failed',
        'timeout',
        'cancelled',
        'abandoned'
    )),
    -- Free-form categorical detail. Typically populated on non-success
    -- terminal states (the success path carries its narrative in
    -- \`report\`); the column accepts any short string the runner / boot
    -- recovery / route handler chooses to record so a future success-
    -- side audit hint stays cheap to add. Examples (non-success today):
    --   'daemon_restarted', 'queue_timeout', 'cancelled_in_queue',
    --   'site_unregistered', 'backend_unavailable', 'not_implemented',
    --   'ask_user_without_yield', 'tool_loop_detected',
    --   'blocked_request_spike', 'max_turns_exceeded',
    --   'clarification_deadline', 'runner_unavailable'.
    outcome_detail              TEXT,
    -- Sub-agent's markdown report on the \`completed\` path. Null otherwise.
    report                      TEXT,
    -- Composed effective allowlist regex captured at task start (§14.1.5).
    -- Persisted so the dashboard can render "why was this URL blocked".
    -- TEXT (regex source) — the runner re-compiles to a RegExp on resume.
    effective_allowlist_regex   TEXT,
    -- Defence-in-depth: per-task CDP-blocked-request counter. The runner
    -- aborts at >100 per §14.2; persisted so the dashboard surfaces the
    -- spike post-mortem.
    blocked_requests_count      INTEGER NOT NULL DEFAULT 0
        CHECK (blocked_requests_count >= 0),
    -- Cumulative untrusted-content cap (§14.6). 128 KB ceiling; the
    -- counter is persisted so the cap survives a session resume from
    -- yield_for_clarification.
    extract_chars_total         INTEGER NOT NULL DEFAULT 0
        CHECK (extract_chars_total >= 0),
    created_at                  INTEGER NOT NULL,
    started_at                  INTEGER,
    finished_at                 INTEGER
);
CREATE INDEX IF NOT EXISTS idx_browser_task_created_at
    ON browser_task(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_browser_task_state_created
    ON browser_task(state, created_at DESC);
-- The non-terminal index powers the "needs your attention" awaiting-count
-- query (§9a.4) without scanning every historical row.
CREATE INDEX IF NOT EXISTS idx_browser_task_non_terminal
    ON browser_task(state)
    WHERE state IN ('pending', 'running', 'awaiting_user', 'final_confirm');

CREATE TABLE IF NOT EXISTS browser_task_action_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT NOT NULL REFERENCES browser_task(id) ON DELETE CASCADE,
    step_index      INTEGER NOT NULL,
    -- Tool name as the agent called it (e.g. 'navigate', 'click', or
    -- 'browser_internal' for the §14.3/§14.4 defence-in-depth handlers
    -- that fire outside the agent's tool envelope).
    tool_name       TEXT NOT NULL,
    -- JSON-stringified args, redacted at insert time (text/screenshot
    -- payloads truncated, secrets passed through the existing redaction
    -- coverage guard).
    args_json       TEXT NOT NULL,
    -- ok | denied | error | allowlist_block | payment_block | timeout |
    -- popup_blocked | dialog_dismissed | filechooser_cancelled |
    -- download_blocked | extract_cap_exceeded | tool_loop_detected
    outcome         TEXT NOT NULL,
    blocked_reason  TEXT,
    -- Relative filename under \`automation-traces/<task_id>/\`. Null when
    -- the tool did not produce a screenshot.
    screenshot_key  TEXT,
    duration_ms     INTEGER NOT NULL CHECK (duration_ms >= 0),
    at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_task_action_log_task
    ON browser_task_action_log(task_id, step_index);
CREATE INDEX IF NOT EXISTS idx_browser_task_action_log_at
    ON browser_task_action_log(at DESC);

CREATE TABLE IF NOT EXISTS browser_task_clarifications (
    -- uuid v4. Shared verbatim between the runner, the ask_user DM, and
    -- the POST /clarify path.
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES browser_task(id) ON DELETE CASCADE,
    question        TEXT NOT NULL,
    context_summary TEXT,
    screenshot_key  TEXT,
    asked_at        INTEGER NOT NULL,
    -- asked_at + 5 min (CLARIFICATION_TTL_MS). The deadline scanner
    -- sweeps overdue rows on the same 30 s tick that handles the
    -- pending-queue timeout.
    deadline_at     INTEGER NOT NULL,
    answer          TEXT,
    answered_at     INTEGER,
    resolved        INTEGER NOT NULL DEFAULT 0
        CHECK (resolved IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_browser_task_clarifications_task
    ON browser_task_clarifications(task_id);
-- Partial index over the unresolved set — the deadline scanner sweeps
-- this once every 30 s.
CREATE INDEX IF NOT EXISTS idx_browser_task_clarifications_unresolved
    ON browser_task_clarifications(deadline_at)
    WHERE resolved = 0;

-- ── Lite-final-confirm tokens (BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.11) ──
--
-- Parallel primitive to B-4's \`browser_automation_purchase_tokens\`. Same
-- \`!~xxxxxxxx\` UX, same single-use + 5-min TTL CAS, same DM-with-
-- screenshot dispatch — but no purchase site config + no amount + no
-- spend caps. The two coexist with distinct DB tables and distinct
-- dispatch paths so a future B-4 spend-cap change cannot accidentally
-- widen the lite path.
--
-- Dispatch coexistence (§14.11 / Q#6): incoming \`!~xxxxxxxx\` replies are
-- routed by \`jti\` prefix — \`purchase-handler\` and \`final-confirm-handler\`
-- jointly inspect the inbound and dispatch to the correct waiter. The
-- strict-cancel-on-non-token-reply contract is replicated symmetrically.
CREATE TABLE IF NOT EXISTS browser_task_final_confirm_tokens (
    jti                       TEXT PRIMARY KEY,
    -- Raw "!~xxxxxxxx" string while pending. UNIQUE so a colliding mint
    -- (cosmically unlikely under 40-bit entropy) fails at INSERT.
    token                     TEXT UNIQUE,
    task_id                   TEXT NOT NULL REFERENCES browser_task(id) ON DELETE CASCADE,
    -- The action's natural-language summary (e.g. "post 'Hello world' to X").
    -- Surfaced verbatim in the DM so the user knows what they're confirming.
    action_summary            TEXT NOT NULL,
    -- Relative trace-store filename — the would-be-clicked element's
    -- screenshot captured immediately before the gate trips.
    pre_screenshot_path       TEXT NOT NULL,
    -- JSON array<string> of "<platform>:<channel_id>". Same shape as
    -- B-4's \`delivered_channels\`. Validation rejects replies on
    -- non-delivered channels (defence against DM forwarding).
    delivered_channels        TEXT NOT NULL,
    issued_at                 INTEGER NOT NULL,
    expires_at                INTEGER NOT NULL,
    consumed_at               INTEGER,
    consumed_via_channel      TEXT,
    cancelled_at              INTEGER,
    -- Closed cancel-reason set so a hand-written cancel path cannot land
    -- an unrecognised category in the audit trail.
    cancel_reason             TEXT CHECK (cancel_reason IS NULL OR cancel_reason IN (
        'user_reply',
        'wrong_token',
        'wrong_channel',
        'timeout',
        'explicit',
        'task_cancelled',
        'dashboard_cancel'
    )),
    status                    TEXT NOT NULL CHECK (status IN (
        'pending',
        'confirmed',
        'cancelled',
        'expired'
    ))
);
CREATE INDEX IF NOT EXISTS idx_final_confirm_tokens_status_expires
    ON browser_task_final_confirm_tokens(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_final_confirm_tokens_task
    ON browser_task_final_confirm_tokens(task_id);

-- INTEGRATION-DRIFT-PHASE-7-PLAN.md §3.2 — persistent dedup for the
-- 15-minute imminent-meeting reminder. Pre-Phase-7 the scheduler kept
-- an in-memory Set, which was lost on every daemon restart and re-DMed
-- every imminent event whose start lay within the next 15 minutes. The
-- table is a separate primary-key store (not a column on
-- integration_snapshots) so adding it is idempotent under the project's
-- CREATE-IF-NOT-EXISTS-only policy regardless of prior schema state.
-- Cleanup runs daily via retention.ts (rows older than 24 h are pruned;
-- a calendar event cannot stay imminent longer than 15 min so 24 h is a
-- comfortable safety margin).
CREATE TABLE IF NOT EXISTS imminent_event_notifications (
    item_id     TEXT PRIMARY KEY,
    notified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imminent_event_notifications_notified_at
    ON imminent_event_notifications(notified_at);

-- ── Management Registry & Entities (docs/design/21-management-registry-and-entities.md) ──
--
-- L1 — Section B authoritative storage for managed tasks (§9.2).
-- The file at <contextDir>/policies/management.md is a deterministic render
-- from this table; user hand-edits are parsed back via the registry
-- watcher (§7.2 management-registry.ts), with parse failures triggering
-- a re-render from this table (FR-13).
--
-- Hard-delete on stop (§8.5 ADR): rows are removed when the user stops a
-- managed task. History is recovered from \`agent_actions\` rows tagged
-- \`management_task.*\` plus \`md_file_snapshots\` for the file itself.
--
-- The (app_normalized, cadence) UNIQUE constraint is the DB-layer
-- defense for §NFR-3 / §12 ("two registrations from two devices") —
-- since stops are hard-delete, the constraint applies to all rows.
CREATE TABLE IF NOT EXISTS managed_tasks (
    -- 'mt_<n>' allocated from managed_task_seq. Never reused so historical
    -- agent_actions references stay unambiguous after a stop+re-register.
    id TEXT PRIMARY KEY,
    -- Free-text user-typed description rendered in management.md's "Intent"
    -- column. Length-capped via APP/INTENT validators in management-domains.ts.
    intent TEXT NOT NULL,
    -- User-typed app label as it appears in management.md's "App" column.
    app TEXT NOT NULL,
    -- Lower-cased + whitespace-collapsed dedup key (normalizeAppLabel).
    -- Indexed below for the registration-time semantic-dedup probe.
    app_normalized TEXT NOT NULL,
    -- Human-readable cadence string (e.g. "daily 10:00 (Asia/Tokyo)").
    -- The cron form lives on recurring_schedules; this column preserves
    -- the user's natural-language phrasing for the rendered table.
    cadence TEXT NOT NULL,
    -- Primary L2 directory (e.g. 'work/meetings/'). The leading 'context/'
    -- is implicit. NULL is permitted only between row creation and the
    -- first successful run (§FR-16); the scheduled-managed-task skill
    -- backfills it on first fire. The CHECK enforces the trailing-slash
    -- invariant from §9.1; the <domain>/<type-plural> shape is enforced
    -- by the API layer via isValidOutputPath().
    output_path TEXT,
    -- One-to-one with the underlying recurring_schedules row. ON DELETE
    -- CASCADE means deleting the schedule cleans up the managed-task row.
    -- The user-facing stop flow (§10.3) deletes managed_tasks first and
    -- the API route then deletes the matching recurring_schedules row in
    -- the same transaction; the FK + UNIQUE here are the integrity floor.
    schedule_id INTEGER NOT NULL UNIQUE
        REFERENCES recurring_schedules(id) ON DELETE CASCADE,
    -- ISO-8601 UTC. Set by scheduled-managed-task on every fire.
    last_run_at TEXT,
    -- Free text 'ok (3 new)' / 'failed: ...' (≤120 chars; enforced by
    -- managedTaskRunResultSchema rather than a CHECK).
    last_result TEXT,
    -- Bumped on each failed fire; reset on success. Used by §10.4's
    -- three-strikes notify rule.
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (output_path IS NULL OR output_path LIKE '%/'),
    -- §NFR-3 / §12 — defense-in-depth dedup floor.
    --
    -- IMPORTANT: this UNIQUE keys on the *human-readable* cadence string
    -- ("daily 10:00 (Asia/Tokyo)"), NOT on the resolved cron. So two
    -- semantically-equivalent natural-language phrasings -- "every day
    -- at 10am" vs the same intent rephrased -- slip past this check;
    -- the LLM-judged semantic dedup at registration time (§10.1 step 2)
    -- is the primary defense.
    --
    -- The constraint still helps: it catches exact-string retries and
    -- prevents accidental dual-DM duplicates from racing into the DB.
    -- Future work (tracked in OQ alongside output_path multi-paths) is to
    -- denormalize the cron string onto this table and switch the
    -- UNIQUE key to (app_normalized, cron). That is a Phase 3 / route-
    -- layer concern, not a P1 schema change, since both sides need to
    -- agree on cron-normalization rules first.
    UNIQUE (app_normalized, cadence)
);
CREATE INDEX IF NOT EXISTS idx_managed_tasks_app
    ON managed_tasks(app_normalized);
CREATE INDEX IF NOT EXISTS idx_managed_tasks_output_path
    ON managed_tasks(output_path)
    WHERE output_path IS NOT NULL;

-- §9.2 — sequence allocator for stable mt_<n> ids that survive deletes.
-- Singleton row enforced via PK CHECK; the seed below is idempotent
-- (INSERT OR IGNORE) so re-applying the schema is a no-op.
CREATE TABLE IF NOT EXISTS managed_task_seq (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_id INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO managed_task_seq (singleton, next_id) VALUES (1, 1);

-- §7.6 — entity-mirror table. NOT authoritative (the L2 .md file is);
-- this is a watcher-maintained SQLite mirror that backs the §7.6 lookup
-- contract (GET /api/entities). On boot, the entity-mirror reconciler
-- walks the L2 directory tree and rebuilds this table; if the mirror
-- diverges from disk, the file wins and the table is rewritten.
--
-- 'path' is the relative-to-contextDir form ('work/meetings/foo.md'),
-- matching parseEntityPath() output and the .sources frontmatter
-- structure documented in §9.3.
CREATE TABLE IF NOT EXISTS entities (
    path TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    -- Singular form ('meeting', 'trip', ...) — matches frontmatter.type.
    type TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT,
    -- ISO date when present in frontmatter; NULL when the entity has
    -- no calendar-style anchor (e.g. an open-ended project).
    date TEXT,
    last_synced_at TEXT,
    -- Verbatim mirror of frontmatter.sources (JSON object). Indexed
    -- key membership lives in entity_source_keys (sidecar) so the §7.6
    -- (source_key, external_id) lookup runs through a real index.
    sources_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_entities_domain_type_date
    ON entities(domain, type, date);
CREATE INDEX IF NOT EXISTS idx_entities_status
    ON entities(status)
    WHERE status IS NOT NULL;

-- §7.6.1 — sidecar M:N index from entity path → source-key. SQLite's
-- json_each is a virtual table and not indexable, so this sidecar
-- provides the (source_key, ...) seek path. Insert/update is atomic
-- with the parent entities upsert; ON DELETE CASCADE keeps the two
-- in lockstep when an entity row is removed.
--
-- 'source_key' is the verbatim user-typed key (the JSON path into
-- 'sources_json' uses it as-is). 'source_key_normalized' is the
-- lower-cased dedup form — joins from the activity-view + by-source
-- lookups match through it so a third casing variant (ZOOM vs Zoom vs
-- zoom) doesn't silently drop a row from the rendered view.
CREATE TABLE IF NOT EXISTS entity_source_keys (
    path TEXT NOT NULL REFERENCES entities(path) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    source_key_normalized TEXT GENERATED ALWAYS AS (LOWER(source_key)) STORED,
    PRIMARY KEY (path, source_key)
);
CREATE INDEX IF NOT EXISTS idx_entity_source_keys_lookup
    ON entity_source_keys(source_key, path);
CREATE INDEX IF NOT EXISTS idx_entity_source_keys_normalized
    ON entity_source_keys(source_key_normalized, path);

-- §9.1 parse rules — drop-with-warning destination for management.md hand-edit
-- failures. The mail-side \`parse_failures\` table above is shaped for IMAP
-- ingestion (account_id, provider_msg_id); reusing it would have forced
-- nullable mail columns onto a vault-rules failure record. A dedicated
-- table keeps the shapes loose-coupled and lets dashboard consumers query
-- one or the other without UNION gymnastics.
--
-- Rows are surfaced on the dashboard's degraded-mode banner (P6) and in the
-- §14.3 metric \`aitne_management_parse_failures_total\` (P8). Retention:
-- swept by the existing daily retention job alongside other transient
-- diagnostics — see core/retention.ts (additive at P8).
CREATE TABLE IF NOT EXISTS management_parse_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Section identifier ('A', 'B', 'C') so the dashboard can surface the
    -- right hint. NULL when the failure is at file level (frontmatter, etc).
    section TEXT,
    -- Free-text reason, stable across releases (callers grep by prefix).
    reason TEXT NOT NULL,
    -- Verbatim raw line / cell that failed; helps the user repair the edit.
    raw TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_management_parse_failures_created_at
    ON management_parse_failures(created_at DESC);

-- ── Skill curation (P22 — appendix p22-skill-self-optimization.md) ──────────
--
-- Three tables that drive the self-curation loop. Signals are the evidence
-- stream — Preview release ships only structure_diff (the hourly walker);
-- search_miss / agent_feedback / owner_correction signal types were
-- removed when the feature pivoted to "silent background optimization,
-- no user feedback collection". Proposals are the optimizer agent's typed-
-- payload submissions; runs are an explicit envelope for correlating
-- proposals + run-token validation.

CREATE TABLE IF NOT EXISTS skill_curation_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_slug TEXT NOT NULL,
    section_id TEXT,
    signal_type TEXT NOT NULL CHECK (signal_type IN ('structure_diff')),
    payload_json TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    consumed_at INTEGER,
    consumed_by_proposal_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skill_signals_unconsumed
    ON skill_curation_signals(skill_slug, consumed_at)
    WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_skill_signals_observed_at
    ON skill_curation_signals(observed_at);

CREATE TABLE IF NOT EXISTS skill_curation_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    skill_slug TEXT NOT NULL,
    section_id TEXT NOT NULL,
    section_kind TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    renderer_version_at_proposal TEXT NOT NULL,
    prev_payload_json TEXT NOT NULL,
    new_payload_json TEXT NOT NULL,
    rendered_md TEXT NOT NULL,
    diff_additions INTEGER NOT NULL,
    diff_modifications INTEGER NOT NULL,
    diff_removals INTEGER NOT NULL,
    diff_kind TEXT NOT NULL CHECK (diff_kind IN (
        'additive_only', 'cosmetic_only', 'mixed', 'destructive'
    )),
    rationale TEXT NOT NULL,
    signals_json TEXT NOT NULL,
    smoke_passed_at INTEGER,
    smoke_failures_json TEXT,
    -- Per P22 §4 (post-approval-removal): every proposal that survives the
    -- chokepoint is 'applied' immediately; the only system-driven roll-back
    -- is 'auto_reverted' (set by the §5.3 sweep). All other terminal
    -- statuses describe rejection causes — the row is still persisted so
    -- failed attempts remain inspectable from the dashboard.
    status TEXT NOT NULL CHECK (status IN (
        'applied', 'auto_reverted', 'conflict',
        'smoke_failed', 'diff_caps', 'render_budget'
    )),
    proposed_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    applied_overlay_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status
    ON skill_curation_proposals(status, proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_skill_section
    ON skill_curation_proposals(skill_slug, section_id, proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_run
    ON skill_curation_proposals(run_id);

CREATE TABLE IF NOT EXISTS skill_curation_runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finalized_at INTEGER,
    cadence TEXT NOT NULL,
    backend TEXT NOT NULL,
    model TEXT NOT NULL,
    target_skills_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
        'running', 'finalized', 'aborted'
    )),
    proposal_count INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    -- 0 = scheduler/cadence-driven, 1 = owner-clicked "Run now" (P22 §6.4).
    -- Manual runs reset the cadence interval gate (auto-cron sleeps for one
    -- cadence interval after a manual click).
    is_manual INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_skill_runs_started
    ON skill_curation_runs(started_at DESC);

-- ── Seed data ─────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO backends
    (id, enabled, auth_status, auth_notification_count, web_search_enabled, created_at, updated_at)
VALUES
    ('claude',   1, 'unknown', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('codex',    0, 'unknown', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('gemini',   0, 'unknown', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('opencode', 0, 'unknown', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO backend_global_defaults
    (singleton, default_backend, default_lite_model, default_medium_model, default_high_model, advisor_enabled, updated_at)
VALUES
    (1, 'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', '${DEFAULT_CLAUDE_MEDIUM_MODEL}', '${DEFAULT_CLAUDE_HIGH_MODEL}', 0, CURRENT_TIMESTAMP);

-- Per-process seeds. Two tiers are wired in at install time:
--   - Sonnet (DEFAULT_CLAUDE_MEDIUM_MODEL) for "main agent work" surfaces
--     where output quality drives the operator's daily experience: DMs,
--     dashboard chat, hourly check, daily/weekly/monthly review, morning
--     routine, scheduled tasks, git.project.* one-shots. Standard
--     50-turn / $1.00 envelope (git.project.* span 30–100 turns and
--     $0.50–$2.00 — retemplate is widest because re-template work is
--     unbounded by shape). EXCEPTION: message.dm carries a wider $5.00
--     per-turn ceiling (see the per-row note below) — its full-history
--     re-processing tipped legitimate turns over the $1.00 nominal.
--   - Haiku (DEFAULT_CLAUDE_LITE_MODEL) for "delegated/simple" surfaces —
--     Gmail classification, GitHub event triage, git-poll observers,
--     calendar-change handlers. Tight 20-turn / $0.20 envelope keeps an
--     autonomous loop bounded.
-- No row seeds at the Opus tier (DEFAULT_CLAUDE_HIGH_MODEL). The setup
-- wizard (setup) and knowledge import (knowledge.import) were both
-- high-tier surfaces until 2026-05-16, when they were demoted to
-- medium tier (Sonnet) to align with Aitne's "no Opus by default"
-- cost posture. Setup's two-turn contract is enforced by the
-- task-flow's "Hard rules for Turn 1" gate, not by the model tier;
-- knowledge import keeps a per-run dashboard model picker so operators
-- can opt into Opus for an individual upload. The only remaining
-- high-tagged process key is \`delegated_task_heavy\`, which is itself
-- opt-in via the \`delegatedTaskHeavyEnabled\` config flag.
-- \`routine.morning_routine_initial\` was the third high-tier surface
-- until docs/design/appendices/morning-routine-optimization.md Phase 7
-- (2026-05-16) retired it; the first-run morning branch now runs on
-- the medium-tier \`routine.morning_routine_today\` row above with a
-- daemon-prepared <roadmap_skeleton> block doing the deterministic
-- prep that previously justified the Opus turn. Operators can pin
-- any row to Opus per-row from /settings/models when one-shot quality
-- matters most.
--
-- updated_by='preset' (matching the marker \`applyDefaultPresets\` writes,
-- see process-config-cascade.ts:93-95). This is the structural fix that
-- lets the setup wizard's main-backend switch (Codex / Gemini / OpenCode)
-- cascade these rows naturally — \`applyDefaultPresets({force:false})\`
-- only protects rows marked 'user' (operator-pinned via /settings/models).
-- Previously the seed used 'user', so every row was permanently pinned
-- to Claude regardless of the operator's main-backend choice.
-- dashboard.docs_qa stays 'cascade' (DOCS_QA_DESIGN.md §10.2; inherits
-- from message.dm on first DM write).
INSERT OR IGNORE INTO process_backend_config
    (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
VALUES
    -- message.dm carries a wider $5.00 envelope (vs the $1.00 medium
    -- nominal its siblings keep). DM turns are the operator's primary
    -- conversational surface: they re-process the full DM history (which
    -- can carry prior browser-task reports + screenshots) on every turn
    -- and routinely run $0.70-0.80 on Sonnet, hugging the old $1.00 cap.
    -- Legitimate multi-step turns (dispatch a browser task, answer a
    -- follow-up, do real tool work) tipped over $1.00 and surfaced a
    -- BackendQuotaError(max_budget_usd) to the user even when the work
    -- itself succeeded. $5.00 is a per-turn CEILING, not a target —
    -- actual spend is governed by the turn's work. Kept in lock-step
    -- with ENVELOPE_OVERRIDES_BY_PROCESS_KEY in plan-presets.ts and
    -- bumped for upgrading installs by migration 0006.
    ('message.dm',              'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  5.00, 'preset'),
    ('message.mention',         'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    ('dashboard.chat',          'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    -- DOCS_QA_DESIGN.md §10.2 — seeded with updated_by='cascade' so the
    -- first user-driven write to message.dm cascades into this row. If we
    -- seeded as 'user', the cascade would skip and dashboard.docs_qa
    -- would silently drift on day one. Envelope (20 turns, $0.50) matches
    -- INHERITOR_DEFAULTS in process-config-cascade.ts.
    ('dashboard.docs_qa',       'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  20,  0.50, 'cascade'),
    -- Above medium nominal: V2-disabled monolithic path absorbs fetch
    -- + synthesis in one session and tripped $1 on Sonnet. Lock-step
    -- with ENVELOPE_OVERRIDES_BY_PROCESS_KEY in plan-presets.ts.
    ('routine.morning_routine', 'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  2.00, 'preset'),
    -- morning-routine-optimization.md Phase 5 — stage-split keys. The
    -- parent envelope above stays seeded so the pre-routine gate
    -- (which selects on action_type='routine.morning_routine') and any
    -- legacy tooling that resolves the parent key keep working; the
    -- two stage keys below carry the actual LLM dispatch budgets.
    -- Stage A originally seeded $0.50 on the projection that the
    -- task-flow would shrink to 6-8 KB (design §"Cost projection",
    -- ~55-65%). That shrink never landed — the Stage A task-flow is
    -- still ~34 KB and loads 9 skills, so even the design's own
    -- typical-day p95 ($0.52) and initial-day worst case ($0.70) sit
    -- at/above $0.50. The cap is realigned to $1.50 — 3x the design's
    -- typical p95 (matching the headroom convention used by
    -- routine.today_refresh) and below the parent envelope so Stage A
    -- still can't silently consume the parent's headroom.
    --
    -- Stage B was originally seeded at $0.10 on the same 15 KB prompt
    -- projection that Stage A overshot. Production showed Stage B's
    -- assembled prompt at ~21 KB; Haiku cache_creation alone (charged
    -- at 1.25x input) consumes ~$0.06 on cold start and a single Bash
    -- tool round-trip tipped over $0.10 mid-turn, producing
    -- BackendQuotaError(max_budget_usd) before Stage B could PUT
    -- daily/<yesterday>.md. Realigned to $0.30 — 3x observed typical
    -- spend, matching the same headroom convention as
    -- routine.today_refresh, below the lite-tier nominal ceiling.
    --
    -- Keep these envelopes in lock-step with
    -- ENVELOPE_OVERRIDES_BY_PROCESS_KEY in plan-presets.ts (the same
    -- lock-step invariant the routine.roadmap_refresh row documents
    -- above).
    ('routine.morning_routine_today',   'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}', 50, 1.50, 'preset'),
    ('routine.morning_routine_journal', 'claude', '${DEFAULT_CLAUDE_LITE_MODEL}',   20, 0.30, 'preset'),
    ('routine.hourly_check',    'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    -- $0.30 budget: a typical drift-triggered refresh on Sonnet runs ~$0.10
    -- in 4 turns; the previous $0.10 cap left zero headroom and any larger
    -- today.md / longer drift summary tipped over the SDK max_budget guard
    -- and surfaced as BackendQuotaError(max_budget_usd). 3x observed cost
    -- matches the headroom convention used by dashboard.docs_qa.
    ('routine.today_refresh',   'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  20,  0.30, 'preset'),
    ('routine.evening_review',  'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    ('routine.weekly_review',   'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    -- routine.monthly_review: row seeded but the routine is gated OFF by
    -- default (see runtime-settings.ts:monthlyReviewEnabled). The row is
    -- retained so a user who flips the kill switch via PATCH /api/config
    -- inherits sensible turn / budget defaults without a re-seed.
    -- Re-enabling is conditional on the Mirror+Prune redesign documented
    -- in agent-assets/task-flows/routine.monthly_review.md.
    ('routine.monthly_review',  'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    -- Roadmap refresh sits in the routine family but is not registered
    -- in ROUTINE_WINDOWS, so the lite-tier routine.fetch_window pre-pass
    -- is not attached. In native integration mode the synthesis session
    -- itself drives the Calendar (90d) / Mail / Notion MCP fan-out --
    -- that fan-out tipped the medium-tier nominal $1.00 cap on Sonnet
    -- 4.6 and surfaced as BackendQuotaError(max_budget_usd). 60 turns
    -- / $3.00 matches the high-tier envelope ceiling, sized so the cap
    -- still binds well before runaway but accommodates a native-mode
    -- session that combines fetch + synthesise in one run. Direct /
    -- delegated installs do not consume the headroom -- their per-turn
    -- cost stays well under the seed.
    -- Keep this row (max_turns, max_budget_usd) in lock-step with
    -- ENVELOPE_OVERRIDES_BY_PROCESS_KEY[routine.roadmap_refresh] in
    -- plan-presets.ts; otherwise a force=true reset would silently
    -- clobber the envelope back to the medium tier default.
    ('routine.roadmap_refresh', 'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  60,  3.00, 'preset'),
    -- Delegated / simple backend surfaces — Haiku (lite tier), tighter envelope.
    ('calendar.change',         'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('gmail_classify',          'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('github.pull_request.review_requested', 'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('github.assigned',         'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('github.security_alert',   'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('github.workflow_run.failed', 'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('git.push.detected',       'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('git.local_ahead.stale',   'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('git.push.force_pushed',   'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('git.branch.created',      'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('git.tag.created',         'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    ('git.merge_to_default',    'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    -- git.project.init / .update / .retemplate are operator-driven one-shot
    -- runs whose output goes straight into curated project docs. All three
    -- seed at medium tier (Sonnet); operators who want a heavier model can
    -- pin per-row from /settings/models. Envelopes are sized so the $
    -- cap binds first on Sonnet (per-turn ~5x cheaper than Opus, so the
    -- previous Opus-era caps were retuned: init 50/$2 → 50/$1 and
    -- retemplate 200/$5 → 100/$2 — same effective bound, no free 5x
    -- runaway headroom). Update was always Sonnet, unchanged.
    ('git.project.init',        'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    ('git.project.update',      'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  30,  0.50, 'preset'),
    ('git.project.retemplate',  'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}', 100,  2.00, 'preset'),
    ('git.lifecycle.poll',      'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20, 0.20, 'preset'),
    -- WIKI_BUILDER_DESIGN.md Phase 1 — internal wiki builder processes.
    -- These are not delegated; each surface gets an independently tunable
    -- backend/model/envelope row in /settings/models and /settings/wiki.
    ('wiki.ingest_url',         'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  30,  1.00, 'preset'),
    ('wiki.compile',            'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}', 100,  5.00, 'preset'),
    ('wiki.ask',                'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    -- WIKI_BUILDER_DESIGN.md Phase 3 — operational triad. Lint scans the
    -- index + recent log entries (small fan-out, structured output);
    -- trace/connect read targeted slices of 10_raw/20_wiki and synthesize
    -- one 30_outputs answer. All three sit in the same Sonnet medium
    -- band as ingest/compile/ask; envelopes mirror the closest existing
    -- analogue (wiki.ask for trace/connect; tighter for lint).
    ('wiki.lint',               'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  40,  0.50, 'preset'),
    ('wiki.trace',              'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    ('wiki.connect',            'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    ('agent.task',              'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  50,  1.00, 'preset'),
    -- P22 — skill self-optimization. Medium tier with a small envelope; the
    -- workdir is read-only besides the curation API, so the optimizer only
    -- needs enough turns to GET signals + payloads and POST proposals. The
    -- per-run rate limit (max 20 proposals) keeps this bounded even on a
    -- runaway prompt.
    ('routine.skill_curation',  'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}',  60,  0.50, 'preset'),
    -- cost-reduction-structural §A — per-observation summarizer. Lite tier
    -- (Haiku-class) with a tight 1-turn / $0.05 envelope. The summarizer
    -- is a single non-tool model call per observation; turns/budget are
    -- intentionally tight so a runaway prompt or accidental loop is
    -- bounded inside the worker's per-call timeout.
    ('observation.summarize',   'claude', '${DEFAULT_CLAUDE_LITE_MODEL}',     1,  0.05, 'preset'),
    -- cost-reduction-structural §B — Stage 2 lite-tier triage. Strict
    -- JSON-only output (~2K input / ~50 output) decides log_only vs
    -- escalate. 1-turn / $0.05 mirrors observation.summarize: the
    -- dispatcher clamps allowedToolsOverride to [] (Claude only) and
    -- the seeded max_turns=1 caps every backend at one assistant turn,
    -- so this envelope is the absolute ceiling — defense-in-depth on
    -- top of the prompt's "no tools" contract.
    ('routine.hourly_check.triage', 'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 1,  0.05, 'preset'),
    -- docs/design/appendices/routine-data-acquisition.md §6.2 / §6.9 — pre-pass window
    -- fetcher dispatched before each routine session. Lite tier
    -- (Haiku-class) per P3 ("Lite for Fetch"). Envelope sized for the
    -- worst-case routine (morning_routine: fan-out across 2 mail
    -- providers × N accounts + 2 calendar providers + notion). 20
    -- turns is enough headroom for ~6 partials × 3 tool calls each;
    -- $0.50 caps the fan-out so a misconfigured account list cannot
    -- drain budget. The lite-tier nominal ($0.20) under-provisioned
    -- real morning fan-outs and tripped BackendQuotaError(max_budget_usd)
    -- mid-fetch, so this envelope is widened via the per-process
    -- override in plan-presets.ts (ENVELOPE_OVERRIDES_BY_PROCESS_KEY).
    ('routine.fetch_window',    'claude', '${DEFAULT_CLAUDE_LITE_MODEL}', 20,  0.50, 'preset'),
    -- BROWSER_HISTORY_INTEGRATION_PLAN P3:
    --   research_cluster_update — nightly per-cluster journal append.
    --     Lite tier (Haiku-class) — templated DM dispatcher with a
    --     single PUT to context/research/<slug>.md. 5 turns / $0.05 is
    --     enough headroom; the §10.3 safety floor refuses Codex
    --     outright, so the seeded claude row is the only eligible
    --     binding until the operator widens via /settings/models.
    --   research_dispatch — accept path. Medium tier (Sonnet). Uses
    --     WebSearch + WebFetch for parallel external research; budget
    --     mirrors evening_review (50/$1.00) since the work shape is
    --     similar (multi-source synthesis + structured write).
    --   research_wiki_summary — accept path for wiki summary. Medium
    --     tier; smaller envelope (30/$0.50) — the agent composes from
    --     the cluster journal it already wrote, so WebFetch fan-out is
    --     bounded.
    ('routine.research_cluster_update', 'claude', '${DEFAULT_CLAUDE_LITE_MODEL}',    5,  0.05, 'preset'),
    ('routine.research_dispatch',       'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}', 50,  1.00, 'preset'),
    ('routine.research_wiki_summary',   'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}', 30,  0.50, 'preset'),
    -- BROWSER_TASK_REDESIGN_PLAN.md §5 — open-ended browser sub-agent.
    -- Medium tier (Sonnet) by default; the §6.1 safety floor pins claude
    -- as the only eligible backend. 30 turns / $1.00 envelope absorbs
    -- the multimodal-input cost of 4-5 screenshots over a 10-turn flow
    -- without tripping BackendQuotaError ($0.50 was the initial target
    -- but landed too close to the cap on Sonnet 4.6 with PNG <= 1MB
    -- attachments).
    --
    -- Keep this row's (max_turns, max_budget_usd) in sync with §5's
    -- envelope spec — a future widening to support multi-tab tasks
    -- needs both this seed and the spec to move together.
    ('browser_task',                    'claude', '${DEFAULT_CLAUDE_MEDIUM_MODEL}', 30,  1.00, 'preset');

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES (
    'integrations',
    json_object(
        'gmail',            json_object('mode', 'disabled', 'lastChangedAt', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        'google_calendar',  json_object('mode', 'disabled', 'lastChangedAt', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        'notion',           json_object('mode', 'disabled', 'lastChangedAt', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        'git',              json_object('mode', 'direct',   'lastChangedAt', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        'github',           json_object('mode', 'direct',   'lastChangedAt', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ),
    CURRENT_TIMESTAMP
);

-- ── Stage C DM-freshness rollup (STAGE-C-DM-FRESHNESS-PLAN §Task 4) ────────
-- Per-day rollup of DM dispatches that recorded freshness telemetry. The
-- view filters on the JSON probe (\`dm_freshness IS NOT NULL\`) rather than
-- a specific event-type whitelist so it picks up every DM action_type the
-- dispatch path tags — this avoids drift if a future event type joins the
-- DM dispatch surface. Read by GET /api/dashboard/dm-freshness; the
-- endpoint additionally exposes p50/p95 lag computed in JS because SQLite
-- has no native percentile_cont.
CREATE VIEW IF NOT EXISTS dm_freshness_metrics AS
SELECT
    date(started_at) AS day,
    COUNT(*) AS total_dm_turns,
    SUM(CASE WHEN json_extract(detail, '$.dm_freshness.resumed') = 1 THEN 1 ELSE 0 END) AS resumed_turns,
    AVG(CAST(json_extract(detail, '$.dm_freshness.agent_log_lag_minutes') AS REAL)) AS avg_lag_minutes,
    SUM(CASE WHEN json_extract(detail, '$.dm_freshness.trigger_matched') = 1 THEN 1 ELSE 0 END) AS trigger_matched_turns,
    SUM(CASE
        WHEN json_extract(detail, '$.dm_freshness.trigger_matched') = 1
         AND json_extract(detail, '$.dm_freshness.refetched_today') = 1
        THEN 1 ELSE 0 END) AS refetch_hits,
    SUM(CAST(json_extract(detail, '$.dm_freshness.loud_writes_since_session_start') AS INTEGER)) AS total_loud_writes_seen,
    SUM(CAST(json_extract(detail, '$.dm_freshness.quiet_writes_since_session_start') AS INTEGER)) AS total_quiet_writes_seen
FROM agent_actions
WHERE json_extract(detail, '$.dm_freshness') IS NOT NULL
GROUP BY day
ORDER BY day DESC;
`;

/** Apply the complete schema and seed data to a database. Idempotent. */
export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA);
}

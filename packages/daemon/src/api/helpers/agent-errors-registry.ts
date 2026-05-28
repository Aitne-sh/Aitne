import type { AgentErrorRegistryEntry } from "./agent-errors-types.js";

// ── Registry ─────────────────────────────────────────────────────────────────
//
// Per-endpoint code → (hint template, skillAnchor, default constraint) table.
// `hint` is the prose remediation an LLM reads; `expected` and `constraint`
// can be filled in by the call site when value-dependent, otherwise the
// registry defaults apply.

/**
 * Authoritative registry of every agent-consumable error code. Adding a new
 * code requires a registry entry; the helper logs a warning and emits a
 * placeholder hint when an unregistered code is passed (so a typo doesn't
 * silently ship a useless error).
 *
 * Codes are namespaced by resource:
 * - `schedule.*`        — POST /api/schedule + POST /api/schedule/batch
 * - `agent_actions.*`   — PATCH /api/agent-actions/self
 *
 * The codes here must be reachable via a crafted bad request — every test
 * file for these endpoints carries a coverage assertion against the registry
 * (see schedule-batch.test.ts / agent-actions.test.ts).
 */
export const AGENT_ERROR_REGISTRY = {
  // ── POST /api/schedule + /api/schedule/batch row-level codes ─────────────
  "schedule.body_not_object": {
    expected: "JSON object",
    hint:
      "Request body must be a JSON object. For /api/schedule/batch wrap rows in '{\"rows\":[…]}'. For /api/schedule supply the row fields directly at the top level.",
    skillAnchor: "schedule#request-shape",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#body_not_object",
    constraint: { type: "object", required: true },
  },
  "schedule.rows_field_missing": {
    expected: "array of row objects under 'rows'",
    hint:
      "Wrap your row objects in a 'rows' array: POST {\"rows\":[{…},{…}]}. An empty array is accepted as a documented no-op.",
    skillAnchor: "schedule#batch-shape",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#rows_field_missing",
    constraint: { type: "array", required: true },
  },
  "schedule.rows_too_many": {
    expected: "at most 50 rows per batch",
    hint:
      "Split the batch into chunks of at most 50 rows. The morning routine's typical batch size is 4-8 rows; 50 is a generous cap.",
    skillAnchor: "schedule#batch-shape",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#rows_too_many",
    constraint: { type: "array", maximum: 50 },
  },
  "schedule.scheduled_for_invalid": {
    expected: "ISO8601 timestamp parseable by Date()",
    hint:
      "Use an ISO 8601 string with timezone offset, e.g. '2026-05-15T14:30:00-04:00'. Convert relative expressions via <current_time> in your context.",
    skillAnchor: "schedule#scheduledFor-bounds",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#scheduled_for_invalid",
    constraint: { type: "iso8601", required: true },
  },
  "schedule.scheduled_for_in_past": {
    expected: "ISO8601 timestamp >= now",
    hint:
      "scheduledFor must be at least 1 minute in the future. Pick a time later today or tomorrow, then resubmit.",
    skillAnchor: "schedule#scheduledFor-bounds",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#scheduled_for_in_past",
    constraint: { type: "iso8601" },
  },
  "schedule.task_type_unknown": {
    expected: "one of 'wake' | 'dm_session' | 'check' | 'dm'",
    hint:
      "taskType is the dispatcher's switch. Pick: 'wake' = future agent session that decides+acts at fire time (most common); 'dm_session' = agent session that composes ONE DM and exits (notifications with model judgment); 'dm' = precomposed DM with no LLM call at fire time (use this on POST /api/schedule/dm, NOT POST /api/schedule); 'check' = non-LLM probe (rare — internal). When in doubt for routines, use 'wake'.",
    skillAnchor: "schedule#taskType",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#task_type_unknown",
    constraint: { type: "enum", enum: ["wake", "dm_session", "check", "dm"], required: true },
  },
  "schedule.description_too_short": {
    expected: "string with >= 20 characters",
    hint:
      "The wake-up agent has NO memory — description is its only context. Include what + why + who + expected output. Bad: 'Meeting prep'. Good: '15-min reminder for the 14:00 design review. Attendees: Sarah, Mike. Notify the user via Slack.'",
    skillAnchor: "schedule#description-shape",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#description_too_short",
    constraint: { type: "string", minLength: 20, required: true },
  },
  "schedule.prompt_too_short": {
    expected: "string with >= 20 characters when set",
    hint:
      "If you supply prompt as an override for description, it must also be >= 20 chars. Or omit it and the row falls back to description.",
    skillAnchor: "schedule#description-shape",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#prompt_too_short",
    constraint: { type: "string", minLength: 20 },
  },
  "schedule.task_context_field_missing": {
    expected: "string with >= 30 characters explaining why this task is being scheduled",
    hint:
      "Stage A must populate taskContext.background and taskContext.expected_output so the future session can produce high-quality output without re-deriving context. Example background: 'User flagged Q2 roadmap risks in yesterday's DM; pre-brief should surface the two open items before the 15:00 standup.'",
    skillAnchor: "schedule#taskContext-required-fields",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#task_context_field_missing",
    constraint: { type: "string", minLength: 30, required: true },
  },
  "schedule.task_context_field_too_short": {
    expected: "non-trivial string content",
    hint:
      "Required taskContext fields must carry real content. background needs >=30 chars, expected_output needs >=20 chars. Omitting them is not an option — they're how the future session reconstructs context.",
    skillAnchor: "schedule#taskContext-required-fields",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#task_context_field_too_short",
    constraint: { type: "string" },
  },
  "schedule.task_context_field_wrong_type": {
    expected: "matching type per the schema",
    hint:
      "taskContext fields have typed slots: background = string (>=30 chars); expected_output = string (>=20 chars); references = string[] (paths or URLs the future session should read); tier_override = null | 'lite' | 'medium' | 'high'; tone = free string ('terse', 'celebratory', etc.); deadline = ISO8601 string or null. The response's `received` shows the actual JS type the daemon saw — coerce to the expected one and resubmit.",
    skillAnchor: "schedule#taskContext-required-fields",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#task_context_field_wrong_type",
  },
  "schedule.model_unknown": {
    // Free-form token after SCHEDULE_API_REDESIGN_PLAN §4.3. The route
    // attaches a `validValues` payload listing every alias + every
    // currently-registered model per backend, so the LLM's retry can
    // pick from the live list rather than guessing.
    expected: "'sonnet' | 'opus' | a registered model id | omitted",
    hint:
      "Pass one of: a legacy alias ('sonnet'/'opus' — rewritten to tier 'medium'/'high'); a full registered model id (e.g. 'claude-opus-4-8', 'gpt-5.4'); the composite form '<backendId>/<modelId>' when an id collides across backends; or omit `model` and use `tier` (recommended). The response's validValues lists every alias + every currently-registered model per backend — pick from that list and resubmit.",
    skillAnchor: "schedule#model-selection",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#model_unknown",
    constraint: { type: "string", maxLength: 120 },
  },
  "schedule.model_ambiguous": {
    // Today unreachable from the live registry (`claude-opus-4-8` vs
    // opencode's `anthropic/claude-opus-4-8` differ), but the registry
    // is editable and a future entry could collide. The route's
    // validValues carries the per-backend matches list so the caller's
    // retry can disambiguate via the composite form.
    expected: "an unambiguous model token (use '<backendId>/<modelId>')",
    hint:
      "The model id you supplied is registered under more than one backend. Resubmit using the composite '<backendId>/<modelId>' form (e.g. 'claude/claude-opus-4-8') so the daemon doesn't have to guess which backend you meant. The response's validValues.matches lists the colliding entries.",
    skillAnchor: "schedule#model-selection",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#model_ambiguous",
    constraint: { type: "string" },
  },
  "schedule.model_deprecated": {
    // Severity is `warning` per SCHEDULE_API_REDESIGN_PLAN §5.0.5 — the
    // row is still created and surfaced via `envelope.warnings[]`. A
    // hard reject would brick long-lived recurring rules on a registry
    // version bump; nudging via warning lets the LLM refine on the next
    // turn without losing the immediate write.
    expected: "a non-deprecated model id (or omit and use `tier`)",
    hint:
      "The model id you supplied is registered but flagged deprecated — the registry may remove it on a future release. The row was still persisted. Consider switching to a non-deprecated id from the response's validValues.availableModels list, or use `tier` instead so the dispatcher picks the latest non-deprecated model for the resolved process key.",
    skillAnchor: "schedule#model-selection",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#model_deprecated",
    severity: "warning",
    constraint: { type: "string" },
  },
  "schedule.backend_id_unknown": {
    // Defensive — `validateModelToken` returns BackendId-narrowed
    // values from `BACKEND_IDS`. A composite-form token whose prefix
    // isn't a real backend is treated as a fall-through (the suffix is
    // re-scanned across all backends). This code is therefore reserved
    // for direct API consumers that hand-construct a backend tag, or
    // for the route's defense-in-depth final guard.
    expected: "'claude' | 'codex' | 'gemini' | 'opencode'",
    hint:
      "The backend id portion of the composite-form token did not match a registered backend. Use one of the four BackendId values listed in validValues — the daemon does not dispatch to any others.",
    skillAnchor: "schedule#model-selection",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#backend_id_unknown",
    constraint: { type: "enum", enum: ["claude", "codex", "gemini", "opencode"] },
  },
  "schedule.tier_unknown": {
    expected: "'lite' | 'medium' | 'high' | omitted",
    hint:
      "tier is the abstract cost knob — prefer this over `model` for new schedules. Omit to use the dispatcher's process-key default (medium). Use 'lite' for hourly polling/health checks (Haiku-class) and 'high' for one-off generative work (Opus-class).",
    skillAnchor: "schedule#tier-selection",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#tier_unknown",
    constraint: { type: "enum", enum: ["lite", "medium", "high"] },
  },
  "schedule.tier_and_model_conflict": {
    // SCHEDULE_API_REDESIGN_PLAN §4.3 / §12.2 — recommendation accepted
    // as hard-reject so the row's intent is self-documenting (a row
    // that carries both gives no signal about which the operator
    // actually wanted). The LLM's error loop adapts in one retry.
    expected: "exactly one of `tier` OR `model` (not both)",
    hint:
      "You supplied BOTH `tier` and `model`. Pick one: use `tier` ('lite' | 'medium' | 'high') as the abstract cost knob — this is the recommended path because the dispatcher picks the latest non-deprecated model per backend automatically. Use `model` only when you must pin a specific id (e.g. reproducing a past run on a deprecated id). On PATCH, you can clear one and set the other in the same request (pass `null` to clear).",
    skillAnchor: "schedule#tier-vs-model",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#tier_and_model_conflict",
  },
  "schedule.batch_atomic_invalid": {
    expected: "boolean (default true)",
    hint:
      "atomic controls rollback. true (default) wraps all rows in one transaction; any row error rolls back all inserts. false commits successful rows individually. Use true for morning routine to retry the whole batch as one unit.",
    skillAnchor: "schedule#batch-shape",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#batch_atomic_invalid",
    constraint: { type: "boolean" },
  },

  // ── recurring_schedules.* / recurrenceRule field-level codes ──────────────
  //
  // POST /api/recurring-schedules + PATCH /api/recurring-schedules/:id
  // call `translateZodError` with a fieldCodeMap that maps each
  // recurrenceRule sub-field onto the codes below. SCHEDULE_API_REDESIGN_PLAN
  // §5.4 — the legacy single-issue `recurring_schedules.validation_error`
  // collapse is gone; every Zod failure now carries the specific code
  // the LLM needs to retry.
  "schedule.frequency_unknown": {
    expected: "'hourly' | 'daily' | 'weekly' | 'monthly'",
    hint:
      "recurrenceRule.frequency must be one of: 'hourly' (every N hours at :MM), 'daily' (one fire per day at HH:MM), 'weekly' (HH:MM on the listed daysOfWeek), 'monthly' (HH:MM on the listed daysOfMonth). See validValues for the exact enum.",
    skillAnchor: "recurring#frequency",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#frequency_unknown",
    constraint: { type: "enum", enum: ["hourly", "daily", "weekly", "monthly"] },
  },
  "schedule.frequency_field_mismatch": {
    expected: "field set that matches the chosen frequency",
    hint:
      "Each frequency requires a specific combination of fields. hourly: no `time`, no day-of-* fields, no `onMissingDay` — use `intervalHours` (1..23, default 1) + `minuteOfHour` (0..59, default 0). daily: `time` only (HH:MM). weekly: `time` + `daysOfWeek` (0=Sun..6=Sat). monthly: `time` + `daysOfMonth` (1..31), `onMissingDay` optional ('skip' | 'lastDayOfMonth', default 'lastDayOfMonth'). See validValues.requiredFor / forbiddenFor for the exact matrix.",
    skillAnchor: "recurring#frequency-fields",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#frequency_field_mismatch",
  },
  "schedule.interval_hours_out_of_range": {
    expected: "integer in [1, 23]",
    hint:
      "intervalHours sets the hourly cadence — N=1 fires every hour, N=2 every two hours anchored at midnight in the rule's timezone. The cap is 23 because N=24 collapses to a daily fire; if you want daily, switch frequency to 'daily' and set `time`. Sub-hour intervals are not supported.",
    skillAnchor: "recurring#hourly",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#interval_hours_out_of_range",
    constraint: { type: "integer", minimum: 1, maximum: 23 },
  },
  "schedule.minute_of_hour_out_of_range": {
    expected: "integer in [0, 59]",
    hint:
      "minuteOfHour pins which minute the hourly cadence lands on. Default 0 (fires at :00). Example: minuteOfHour=15 with intervalHours=2 fires at 00:15, 02:15, 04:15, …",
    skillAnchor: "recurring#hourly",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#minute_of_hour_out_of_range",
    constraint: { type: "integer", minimum: 0, maximum: 59 },
  },
  "schedule.time_format_invalid": {
    expected: "string matching ^\\d{2}:\\d{2}$ (24h)",
    hint:
      "recurrenceRule.time is 24-hour HH:MM local to the rule's timezone — e.g. '09:00', '21:30'. No seconds, no AM/PM, no offset.",
    skillAnchor: "recurring#time",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#time_format_invalid",
    constraint: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
  },
  "schedule.days_of_week_invalid": {
    expected: "non-empty array of distinct integers in [0, 6]",
    hint:
      "daysOfWeek is required for frequency='weekly' and forbidden otherwise. Integers 0..6 map to Sun..Sat (see validValues.labels). Duplicates are rejected at the schema layer — a duplicate is always a caller bug, never intent. Example: [1,3,5] = Mon/Wed/Fri.",
    skillAnchor: "recurring#weekly",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#days_of_week_invalid",
    constraint: { type: "array", minimum: 1, maximum: 7 },
  },
  "schedule.days_of_month_invalid": {
    expected: "non-empty array of distinct integers in [1, 31]",
    hint:
      "daysOfMonth is required for frequency='monthly' and forbidden otherwise. Integers 1..31. Duplicates are rejected. Days 29-31 may fall outside short months — control the behavior via `onMissingDay` ('skip' to drop those months, 'lastDayOfMonth' to fire on the actual last day instead).",
    skillAnchor: "recurring#monthly",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#days_of_month_invalid",
    constraint: { type: "array", minimum: 1, maximum: 31 },
  },
  "schedule.on_missing_day_unknown": {
    expected: "'skip' | 'lastDayOfMonth' (or omit; defaults to 'lastDayOfMonth')",
    hint:
      "onMissingDay only applies to frequency='monthly'. 'skip' drops months that don't contain the requested day (e.g. [31] skips Feb/Apr/Jun/Sep/Nov). 'lastDayOfMonth' fires on the actual last day of those months instead (the bit-compatible default — preserves the pre-redesign clamp behavior).",
    skillAnchor: "recurring#on-missing-day",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#on_missing_day_unknown",
    constraint: { type: "enum", enum: ["skip", "lastDayOfMonth"] },
  },
  "schedule.on_missing_day_unused": {
    // SCHEDULE_API_REDESIGN_PLAN §5 — `onMissingDay` only changes
    // behavior when `daysOfMonth` contains a day that doesn't exist in
    // every month (29, 30, 31). Setting it on `[1,15]` is a no-op
    // intent signal — accept the row but nudge the caller via the
    // warnings[] channel so future PATCHes converge on the right
    // shape. Warning-level: the row is still persisted (201/200),
    // `retryable` ignores it.
    expected: "onMissingDay omitted, OR daysOfMonth contains 29, 30, or 31",
    hint:
      "You set `onMissingDay` but `daysOfMonth` has no entry in [29, 30, 31] — the field has no effect because every month already contains the requested day. Either drop `onMissingDay` to keep the row clean, or extend `daysOfMonth` (e.g. add 31 if this is meant to be a month-end rule).",
    skillAnchor: "recurring#on-missing-day",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#on_missing_day_unused",
    severity: "warning",
  },
  "schedule.timezone_unknown": {
    expected: "valid IANA timezone string",
    hint:
      "recurrenceRule.timezone must parse via Intl.DateTimeFormat with a real IANA zone (e.g. 'Asia/Tokyo', 'America/New_York', 'UTC'). When omitted, the daemon falls back to the configured primary timezone, then the system zone.",
    skillAnchor: "recurring#timezone",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#timezone_unknown",
    constraint: { type: "string" },
  },
  "schedule.recurrence_rule_invalid": {
    expected: "well-formed RecurrenceRule object",
    hint:
      "recurrenceRule must be an object with `frequency` plus the per-frequency fields. The route emits more specific codes (schedule.frequency_unknown / schedule.frequency_field_mismatch / schedule.time_format_invalid / …) when it can identify the offending field; this fallback fires on structurally-invalid bodies the Zod traversal could not localise.",
    skillAnchor: "recurring#shape",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#recurrence_rule_invalid",
  },
  "schedule.recurring_id_invalid": {
    // Mirrors the existing `recurring_schedules.invalid_id` legacy
    // path so the dashboard's id-form switch keeps working while the
    // structured envelope migrates over. New consumers read errors[0].code.
    expected: "positive integer id",
    hint:
      "The id path segment must parse as a positive integer. Use the value returned by POST /api/recurring-schedules (item.id), not a slug or 0.",
    skillAnchor: "recurring#identifiers",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#recurring_id_invalid",
    legacyErrorCode: "invalid_id",
    constraint: { type: "integer", minimum: 1 },
  },
  "schedule.recurring_not_found": {
    expected: "recurring schedule id that exists",
    hint:
      "No recurring schedule exists with this id. List /api/recurring-schedules to see the current rows, or POST a new one. Deleted rows are gone permanently — the table does not soft-delete.",
    skillAnchor: "recurring#identifiers",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#recurring_not_found",
    legacyErrorCode: "not_found",
  },
  "schedule.recurring_no_changes": {
    // Mirrors the existing PATCH refine "At least one field must be
    // provided for update". Emitted from the recurring update path's
    // Zod translator when the body is `{}`.
    expected: "at least one field set on the PATCH body",
    hint:
      "An empty PATCH body is rejected — supply at least one of `description`, `prompt`, `recurrenceRule`, `model`, `tier`, `taskContext`, `enabled`. PATCH does not re-materialize the already-pending agent_schedule row unless you change `recurrenceRule` or `enabled`.",
    skillAnchor: "recurring#patch-semantics",
    docsUrl: "agent-assets/skills/schedule/references/errors.md#recurring_no_changes",
  },

  // ── PATCH /api/agent-actions/self codes ──────────────────────────────────
  "agent_actions.session_identity_missing": {
    expected:
      "x-pa-event-correlation-id and x-process-key headers identifying the running session",
    hint:
      "The pa-api shim auto-injects these from PA_EVENT_CORRELATION_ID and PA_PROCESS_KEY when running inside a dispatcher-spawned session. If you are calling this endpoint directly from the dashboard or a test, supply both headers explicitly.",
    skillAnchor: "agent-actions#self-write-auth",
    retryable: false,
  },
  "agent_actions.session_row_not_found": {
    expected: "an in-flight agent_actions row matching (event_id, action_type)",
    hint:
      "No row was found for the running session's correlation id + process key. Either the dispatcher has not yet inserted the row, or the row's result column is already terminal (success/failed). Verify the dispatcher writes an in_progress row before launching the session.",
    skillAnchor: "agent-actions#self-write-auth",
    retryable: false,
  },
  "agent_actions.metadata_field_invalid": {
    expected: "object with optional dayType/anomalies/filesTouched/inboxStats/scheduleBatchSize",
    hint:
      "The metadata body slot is shallow-merged into the row's metadata column. Pass an object literal; arrays go inside named keys (e.g. anomalies:[...]). Non-JSON-serialisable values (functions, Symbols) are rejected.",
    skillAnchor: "agent-actions#metadata-shape",
    constraint: { type: "object", required: true },
  },
  "agent_actions.body_not_object": {
    expected: "JSON object",
    hint:
      "Body must be {\"metadata\":{…}}. The metadata key is required; other top-level keys are ignored.",
    skillAnchor: "agent-actions#metadata-shape",
    constraint: { type: "object", required: true },
  },
  // `agent_actions.cross_row_write_forbidden` is NOT registered. The
  // morning-routine-optimization rev4 banner records why the cross-row
  // 403 contract was withdrawn rather than shipped: Aitne is
  // single-owner, daemon is 127.0.0.1-only, correlation_ids are UUIDs,
  // and the realistic failure modes (pa-api shim bug, dispatcher env
  // bug) are not defended by cryptographic token binding. The endpoint
  // stays at the shipped header-lookup shape and emits 404
  // `agent_actions.session_row_not_found` when the lookup misses;
  // there is no 403 path for cross-row attempts. Keeping the code
  // unregistered preserves this file's reachability invariant (every
  // registered code must be reachable from a crafted request).

  // ── /api/context/* — MD-centric memory CRUD (the only legal write path
  //    for agent context. See docs/design/06-memory.md). Every entry
  //    carries a `legacyErrorCode` because the dashboard's knowledge-page
  //    error branches (`context-files-content.tsx`) still switch on the
  //    pre-envelope short codes ("forbidden", "morning_routine_lock_held",
  //    "validation_error", …).
  "context.path_invalid": {
    expected: "context-relative path within the allowed write whitelist",
    hint:
      "The path failed safePath(): it escaped getContextDir() or pointed outside the allowed file set. Use a path like 'state/today', 'plans/roadmap', 'plans/projects/<slug>', 'identity/profile' — no '..', no absolute paths. Read GET /api/context/list/plans/projects to discover live slugs.",
    skillAnchor: "context#allowed-paths",
    legacyErrorCode: "invalid_path",
    constraint: { type: "string" },
  },
  "context.path_required": {
    expected: "non-empty 'path' query / route parameter",
    hint:
      "The endpoint needs a context path (e.g. 'state/today', 'plans/projects/launch-prep'). For wildcard read/write routes the path is the URL tail after /api/context/; for snapshot restore the path is captured from the snapshot row.",
    skillAnchor: "context#allowed-paths",
    legacyErrorCode: "path_required",
    constraint: { type: "string", required: true },
  },
  "context.path_not_found": {
    expected: "an existing context MD file at the resolved path",
    hint:
      "GET / PATCH / DELETE on a path that does not exist on disk. Use GET /api/context/list/plans/projects (or .../list/policies) to discover available paths, or PUT first to create the file.",
    skillAnchor: "context#allowed-paths",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "context.write_forbidden": {
    expected: "path inside the daemon's write whitelist",
    hint:
      "This file is read-only from the agent side. The whitelist covers state/today, plans/roadmap, plans/projects/*, policies/management-captures/*, identity/*, journal/agent, state/profile-questions, journal/weekly/*, journal/monthly/*, knowledge/dossiers/*, knowledge/entities/<domain>/<type-plural>/* (e.g. knowledge/entities/work/meetings/<slug>), state/inbox/*, state/scratch/*, and policies/routines/custom/*. Legacy paths (today.md, roadmap.md, user/*, rules/*, agent/journal) are server-side aliased for one minor release but the canonical names above are the future contract. Files outside this set are owned by the daemon or operator — GET /api/context/list/plans/projects to find a writable parent, or NOTIFY the user.",
    skillAnchor: "context#write-whitelist",
    legacyErrorCode: "forbidden",
    retryable: false,
  },
  "context.lock_held": {
    expected: "morning-routine lock not held by another holder",
    hint:
      "Another session is currently running the morning routine. Wait for it to finish (the holder block in the response carries the lockId and acquiredAt). Acquire-lock requests on a held lock return 409.",
    skillAnchor: "context#locks",
    legacyErrorCode: "lock_held",
    retryable: true,
  },
  "context.lock_not_held": {
    expected: "valid lockId held by this caller",
    hint:
      "Release was rejected — the lockId in the body did not match the current holder. The release contract is single-shot: each acquire returns exactly one lockId; releasing twice or releasing without the id returns 400. If the dispatcher did not capture the id, re-acquire and immediately release.",
    skillAnchor: "context#locks",
    legacyErrorCode: "lock_not_held",
    retryable: false,
  },
  "context.morning_routine_lock_held": {
    expected: "morning_routine lock released OR X-Lock-Id matching the holder",
    hint:
      "today.md write rejected because the morning routine is in progress. If you are the routine, pass X-Lock-Id: <id> with the lockId from POST /context/lock/morning-routine. If you are not the routine, wait for it to finish (typically <2 minutes) and retry.",
    skillAnchor: "context#locks",
    legacyErrorCode: "morning_routine_lock_held",
    retryable: true,
  },
  "context.roadmap_write_lock_held": {
    expected: "roadmap write lock released OR X-Lock-Id matching the holder",
    hint:
      "roadmap.md write rejected because another flow is currently rewriting roadmap. Pass X-Lock-Id: <id> from POST /context/lock/roadmap if you acquired it, or wait for the holder (typically routine.roadmap_refresh) to finish.",
    skillAnchor: "context#locks",
    legacyErrorCode: "roadmap_write_lock_held",
    retryable: true,
  },
  "context.body_not_object": {
    expected: "JSON object body",
    hint:
      "PUT / PATCH / lock-release / archive-today bodies must be a JSON object. Wrap your payload in '{}'. An empty body is rejected by PUT (content required) but accepted by lock-release as a no-op.",
    skillAnchor: "context#request-shape",
    legacyErrorCode: "validation_error",
    constraint: { type: "object", required: true },
  },
  "context.invalid_body_field": {
    expected: "field value matching the route schema",
    hint:
      "One or more body fields failed schema validation. Inspect the per-issue `field` (Zod path) and `received` (the value you sent) plus `validValues` for enum fields. For PATCH /api/context/<path> the shape is {section, mode: 'append'|'replace'|'clear'|'clear_before'|'append_to_file', content?, cutoff?, maxEntries?}; for PUT it is {content}. For append-only files like journal/agent.md prefer mode='append_to_file' (section optional).",
    skillAnchor: "context#request-shape",
    legacyErrorCode: "validation_error",
  },
  "context.invalid_json_body": {
    expected: "syntactically valid JSON",
    hint:
      "Body failed JSON.parse(). Check for trailing commas, single quotes, or unescaped newlines in string content. Use jq -nc for compact valid JSON before piping into curl --data-binary.",
    skillAnchor: "context#request-shape",
    legacyErrorCode: "invalid_json_body",
  },
  "context.snapshot_id_invalid": {
    expected: "positive safe integer matching md_file_snapshots.id",
    hint:
      "Snapshot id must be a positive integer (no decimals, no scientific notation). GET /api/context/snapshots/:path to list available snapshot ids.",
    skillAnchor: "context#snapshots",
    legacyErrorCode: "invalid_id",
    constraint: { type: "integer", minimum: 1 },
  },
  "context.snapshot_not_found": {
    expected: "an existing row in md_file_snapshots",
    hint:
      "No snapshot exists with that id. Snapshots are pruned over time — verify the id from a fresh GET /api/context/snapshots/:path before restoring.",
    skillAnchor: "context#snapshots",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "context.roadmap_id_generation_failed": {
    expected: "successful id generation after collision retries",
    hint:
      "The daemon exhausted retries trying to mint a non-colliding 4-char suffix for the roadmap id. This indicates an unusually full roadmap day or a corrupt randomBytes injection. Retry once; if it fails again, file an issue — DO NOT manually mint an id, the IDs must be daemon-issued so audit hooks fire.",
    skillAnchor: "context#roadmap-ids",
    legacyErrorCode: "roadmap_id_generation_failed",
    retryable: true,
  },
  "context.creation_date_invalid": {
    expected: "YYYY-MM-DD calendar date string",
    hint:
      "Roadmap-id creationDate must be a calendar date in YYYY-MM-DD form (no time component). Use localDateStr(now, <timezone>) shape; omit the field entirely to let the daemon stamp it from config.timezone.",
    skillAnchor: "context#roadmap-ids",
    legacyErrorCode: "validation_error",
    constraint: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  },
  "context.directory_invalid": {
    expected: "directory listed in the allowed-directory set",
    hint:
      "Directory listings are restricted to the curated allow-list returned in the 400 response's `allowed` field (e.g. 'plans/projects', 'policies/management-captures', 'identity', 'knowledge/dossiers'). Pick from that list — wildcards and absolute paths are rejected.",
    skillAnchor: "context#allowed-paths",
    legacyErrorCode: "invalid_directory",
  },
  "context.content_validation_failed": {
    expected: "content matching the file's schema (today/roadmap/projects/...)",
    hint:
      "The body content failed validateContextContent(). The response's `message` field carries the specific reason: today.md H1 date mismatch, frontmatter shape, roadmap row schema, project doc skeleton, etc. Read the message verbatim and adjust the offending section — do NOT retry without changing the content.",
    skillAnchor: "context#content-validation",
    legacyErrorCode: "validation_error",
  },
  // morning-routine-optimization.md §"PUT /api/context/daily/<date>
  // skeleton-preservation validator" — Stage B (the lite-tier journal
  // author) MUST preserve the seven skeleton-owned frontmatter fields
  // byte-for-byte from the `<journal_skeleton>` it received in its
  // prompt: date, weekday, type, owner, agent_generated,
  // calendar_events, messages_handled. `type` and `owner` are pinned
  // by the existing context-frontmatter validator; the remaining five
  // are pinned here with per-field structured errors so Stage B can
  // self-correct in one retry rather than guessing which field
  // drifted. Body is NOT validated against the skeleton (Stage B
  // authors the body per rules/journal-format.md).
  "context.daily_skeleton_field_drift": {
    expected: "skeleton-owned frontmatter field present and well-typed",
    hint:
      "A required skeleton-owned frontmatter field is missing or malformed on the daily/<date>.md write. The errors array carries one entry per offending field with the exact `received` value and the `expected` shape. Re-emit the file with the missing fields restored from the `<journal_skeleton>` you were given — the skeleton's frontmatter is preserved byte-for-byte; do not paraphrase it. Body authoring is yours per rules/journal-format.md.",
    skillAnchor: "context#daily-skeleton-fields",
    legacyErrorCode: "daily_skeleton_drift",
    retryable: true,
  },
  "context.vault_unreachable": {
    expected: "primary vault filesystem reachable",
    hint:
      "The vault path resolved by config.primaryVault is currently unreachable (mount lost, drive not present, etc.). Reads work; writes are blocked until the path returns. Surface the situation to the operator — do NOT retry blindly. See `state.reason` and `state.path` in the response for details.",
    skillAnchor: "context#vault-degraded",
    legacyErrorCode: "primary_vault_unreachable",
    retryable: false,
  },
  "context.migration_in_progress": {
    expected: "no /api/setup/migrate-context run in flight",
    hint:
      "Context writes are temporarily globally blocked because the setup migration is moving the data directory. Wait until the migration completes (typically <10s for normal installs; up to a minute for large vaults) and retry. Reads remain available.",
    skillAnchor: "context#migration-gate",
    legacyErrorCode: "migration_in_progress",
    retryable: true,
  },
  "context.stub_target_unsupported": {
    expected: "one of the REPAIRABLE_STUB_TARGETS paths",
    hint:
      "POST /api/context/repair-stub only accepts a curated allow-list of paths (e.g. 'policies/management-captures/_index', 'identity/_index'). The response's expected list (if surfaced) or the REPAIRABLE_STUB_TARGETS constant in context-health.ts is authoritative. For any other file, PUT the content directly via /api/context/<path>.",
    skillAnchor: "context#stub-repair",
    legacyErrorCode: "unsupported_stub_target",
    retryable: false,
  },
  "context.template_unavailable": {
    expected: "agent-assets/templates directory resolvable",
    hint:
      "Skeleton template root unresolved on this install — typically a setup-time misconfiguration (agent-assets/ not bundled, or PA_DATA_DIR points at a wrong tree). The agent has no recovery path here: skip the stub-repair step, continue the routine with the unrepaired stub, and surface ONE notification to the user suggesting `aitne doctor`. Do NOT loop on this code.",
    skillAnchor: "context#stub-repair",
    legacyErrorCode: "templates_unavailable",
    retryable: false,
  },
  "context.template_not_found": {
    expected: "matching template file under agent-assets/templates/",
    hint:
      "No skeleton template exists for the requested stub path. Either the path you passed is wrong, or this particular stub doesn't have a template (and should be authored directly). Check REPAIRABLE_STUB_TARGETS for the supported set.",
    skillAnchor: "context#stub-repair",
    legacyErrorCode: "template_not_found",
    retryable: false,
  },
  "context.append_only_violation": {
    expected: "section header retained — only body content may change",
    hint:
      "This file is append-only (e.g. agent/journal.md uses mode='append_to_file' or mode='append'). PATCH replace/clear modes are rejected. Use mode='append' or mode='append_to_file' to add content; never overwrite past entries.",
    skillAnchor: "context#patch-modes",
    legacyErrorCode: "append_only",
    retryable: false,
  },
  "context.write_conflict": {
    expected: "If-Match / parent revision matching current on-disk state",
    hint:
      "PATCH rejected — the file changed since you fetched it. Recovery in 3 steps: (1) GET /api/context/<path> again and capture the new `ETag` response header; (2) re-derive your patch against the fresh content (section may have moved, bullets may have been added); (3) re-PATCH with `If-Match: <new ETag>`. Bare curl without the If-Match header always 409s on tracked files (today.md, roadmap.md, projects/*). If the conflict repeats twice on the same field, another writer is racing — wait 10s before the third attempt, or fall back to mode='append_to_file' to dodge the section-level conflict entirely.",
    skillAnchor: "context#write-conflict",
    legacyErrorCode: "conflict",
    retryable: true,
  },
  "context.unsupported_operation": {
    expected: "endpoint capable of handling this file extension",
    hint:
      "PATCH is unsupported for .base files — they are full-replace only. Use PUT /api/context/<path>.base with the complete new content instead. Other operation/file combinations carry their own message in the response.",
    skillAnchor: "context#file-extensions",
    legacyErrorCode: "unsupported_operation",
    retryable: false,
  },
  "context.section_not_found": {
    expected: "matching ## heading in the file",
    hint:
      "PATCH targeted a section heading that does not exist in the file. Section matching rules: case-sensitive, exact literal '## <name>' (the leading `## ` and a single space are mandatory; '##  X' with two spaces, '### X' deeper, or '##X' tight all miss). Recovery in order: (1) GET the file and read the current ## headings — pick the actual one verbatim; (2) if the section truly belongs in a new heading, use mode='append_to_file' with the heading included in `content` (e.g. `\\n## New Section\\n<body>`); (3) for structural rewrites, PUT the full file body. Do not approximate the heading — title-cased / pluralised guesses keep missing.",
    skillAnchor: "context#patch-modes",
    legacyErrorCode: "section_not_found",
    retryable: false,
  },
  "context.cutoff_required": {
    expected: "ISO date string under 'cutoff' when mode='clear_before'",
    hint:
      "mode='clear_before' requires a cutoff date so the daemon knows which dated bullets to drop. Use YYYY-MM-DD (or a full ISO timestamp); rows with a stamp older than cutoff are removed.",
    skillAnchor: "context#patch-modes",
    legacyErrorCode: "cutoff_required",
    constraint: { type: "iso8601", required: true },
  },

  // ── /api/obsidian/* — external Obsidian vault proxy. The agent calls
  //    these from the `obsidian-*` skills; every entry surfaces a
  //    `legacyErrorCode` because adapter tests assert on the bare
  //    `data.error === "obsidian_not_running"` shape.
  "obsidian.not_configured": {
    expected: "external Obsidian vault configured in setup",
    hint:
      "No external Obsidian vault is configured for this install — `externalObsidianVaultPath`/`externalObsidianVaultName` are unset. Stop calling /api/obsidian/* in this session; either route the work to /api/wiki/* (internal vault), /api/context/* (management store), or notify the user that Obsidian is not configured. GET /api/health → integrationStatuses.obsidian for the live state.",
    skillAnchor: "obsidian-vault-rules#external-vault-setup",
    legacyErrorCode: "obsidian_not_configured",
    retryable: false,
  },
  "obsidian.not_running": {
    expected: "Obsidian.app process running on the host",
    hint:
      "The Obsidian CLI requires the Obsidian desktop app to be running (Catalyst feature). Notify the user that Obsidian is not running and ask them to launch it, then retry after they confirm. Do NOT silently retry — there is no automatic recovery path.",
    skillAnchor: "obsidian-vault-rules#obsidian-must-be-running",
    legacyErrorCode: "obsidian_not_running",
    retryable: false,
  },
  "obsidian.invalid_path": {
    expected: "vault-relative path: word chars / spaces / hyphens / dots / forward slashes, no '..', no leading '/'",
    hint:
      "Vault paths reject `..`, absolute paths, and characters outside `[a-z0-9 _\\-./CJK]`. Use 'folder/subfolder/My Note' shape (no leading slash, no .md extension required for the CLI). Search via GET /api/obsidian/search?q=… to discover a real path before writing.",
    skillAnchor: "obsidian-vault-rules#path-rules",
    legacyErrorCode: "invalid file path",
    constraint: { type: "string", maxLength: 500 },
  },
  "obsidian.invalid_note_name": {
    expected: "vault-relative note name: same rules as path",
    hint:
      "Note names for create take the same shape as paths: no '..', no leading '/', characters limited to `[a-z0-9 _\\-./CJK]`. Use 'Daily/2026-05-15' or 'My Note' — the CLI appends .md automatically.",
    skillAnchor: "obsidian-vault-rules#path-rules",
    legacyErrorCode: "invalid note name",
    constraint: { type: "string", maxLength: 500 },
  },
  "obsidian.name_and_content_required": {
    expected: "both 'name' (string) and 'content' (string) in the JSON body",
    hint:
      "POST /api/obsidian/notes requires `{ name: '<vault-path>', content: '<markdown>' }`. Both fields are mandatory and must be non-empty strings. To create an empty note, pass content: '' (empty string), not omit the field.",
    skillAnchor: "obsidian-vault-rules#create-note",
    legacyErrorCode: "name and content are required",
    constraint: { type: "object", required: true },
  },
  "obsidian.content_required": {
    expected: "'content' string in the JSON body",
    hint:
      "PUT / PATCH /api/obsidian/notes endpoints require `{ content: '<markdown>' }`. Pass an empty string to clear content; omitting the field is a different error. PATCH /obsidian/notes also needs `file`; PATCH /obsidian/daily only needs `content`.",
    skillAnchor: "obsidian-vault-rules#update-note",
    legacyErrorCode: "content is required",
    constraint: { type: "string", required: true },
  },
  "obsidian.file_and_content_required": {
    expected: "both 'file' (vault path) and 'content' (string) in the JSON body",
    hint:
      "PATCH /api/obsidian/notes (append) requires `{ file: '<vault-path>', content: '<markdown to append>' }`. Use PATCH /api/obsidian/daily (no `file`) to append to today's daily note instead.",
    skillAnchor: "obsidian-vault-rules#append-note",
    legacyErrorCode: "file and content are required",
    constraint: { type: "object", required: true },
  },
  "obsidian.query_required": {
    expected: "non-empty 'q' query parameter",
    hint:
      "GET /api/obsidian/search?q=<term> needs a non-empty query string. The Obsidian CLI search is FTS-style — pass a phrase, tag like `#project`, or path fragment. Empty string is rejected; use the notes endpoint for path-only enumeration.",
    skillAnchor: "obsidian-vault-rules#search",
    legacyErrorCode: "query parameter 'q' is required",
    constraint: { type: "string", required: true, minLength: 1 },
  },
  "obsidian.not_found": {
    expected: "an existing note at the resolved vault path",
    hint:
      "The note does not exist. The Obsidian CLI collapses 'no such note' and 'read failure' into one error — GET /api/obsidian/search?q=<word-from-title> to discover the correct path, then retry. Do NOT keep retrying the same path.",
    skillAnchor: "obsidian-vault-rules#read-note",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "obsidian.upstream_error": {
    expected: "successful Obsidian CLI invocation",
    hint:
      "Obsidian CLI returned a non-zero error. `message` is the raw CLI stderr — read it before retrying. Branches: 'note locked' / 'vault busy' → another writer is mid-flight, wait 5s and retry ONCE; 'note has unsaved changes' → the note is open in the Obsidian UI with edits the CLI refuses to overwrite, notify the user with 'Please save or close <path> in Obsidian, then retry' and skip this write; 'unauthorized' / 'token expired' → CLI auth lost, notify with 'Re-link Obsidian CLI: open Obsidian → Settings → Catalyst → CLI → regenerate token' and stop calling /api/obsidian/* this turn; 'plugin not running' → user closed Obsidian, see obsidian.not_running. Do NOT loop without changing call shape.",
    skillAnchor: "obsidian-vault-rules#errors",
    legacyErrorCode: "obsidian_error",
    retryable: true,
  },

  // ── /api/calendar/* — Google Calendar + Outlook Calendar (direct mode).
  //    Delegated/native mode is gated by the route-gate middleware
  //    before these handlers run; the codes below are reached only in
  //    direct mode or when the integration is misconfigured.
  "calendar.not_configured": {
    expected: "Google Calendar configured (direct mode) on this install",
    hint:
      "Google Calendar is not configured for direct access — either OAuth is not set up, the service is disabled, or the integration is in delegated/native mode (in which case the route is already 410-gated). Notify the user that calendar is unavailable and skip the calendar branch of the routine. GET /api/health.integrationStatuses.google.services.calendar shows the live state.",
    skillAnchor: "calendar#configuration",
    legacyErrorCode: "calendar_not_configured",
    retryable: false,
  },
  "calendar.invalid_date_format": {
    expected: "'today' or YYYY-MM-DD date string",
    hint:
      "The `date` query parameter must be the literal 'today' or a calendar date like '2026-05-15'. Other shapes (ISO timestamps, '5/15/26', RFC-3339) are rejected. Use localDateStr(now, <timezone>) shape.",
    skillAnchor: "calendar#list-events",
    legacyErrorCode: "invalid date format — expected YYYY-MM-DD or 'today'",
    constraint: { type: "string", pattern: "^(today|\\d{4}-\\d{2}-\\d{2})$", required: true },
  },
  "calendar.invalid_send_updates": {
    expected: "one of 'all' | 'externalOnly' | 'none'",
    hint:
      "The `sendUpdates` query parameter controls invite emails. Pass 'none' (silent — typical for batch agent edits), 'externalOnly' (notify external attendees but not internal), or 'all' (notify everyone). Omit the param to default to 'none'.",
    skillAnchor: "calendar#sendUpdates",
    legacyErrorCode: "invalid sendUpdates — must be 'all', 'externalOnly', or 'none'",
    constraint: { type: "enum", enum: ["all", "externalOnly", "none"] },
  },
  "calendar.not_found": {
    expected: "an existing event at the supplied calendarId + eventId",
    hint:
      "Google returned 404 for this event. The event may have been deleted by another client, or the eventId is wrong. Re-list with GET /api/calendar/events?date=<day> to find the current id, or skip if the event no longer exists.",
    skillAnchor: "calendar#event-id",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "calendar.upstream_error": {
    expected: "successful Google Calendar API call",
    hint:
      "Google Calendar returned an error. `message` is Google's verbatim text. Branches: 429 / 'rateLimitExceeded' / 'userRateLimitExceeded' → backoff 60s and retry ONCE, then skip calendar for this turn. 412 / 'preconditionFailed' → another client edited the event between your GET and PATCH; GET the event again to refresh the etag and replay the same change ONCE. 401 / 'authError' → OAuth refresh token revoked or expired; notify the user to re-link Google in /settings/integrations and skip — agent cannot refresh interactively. 403 / 'insufficientPermissions' → the integration scope was downgraded; same fix as 401. 404 → event was deleted between your last list and this call; drop it and continue. Cap retries at one per code per turn.",
    skillAnchor: "calendar#errors",
    legacyErrorCode: "calendar_error",
    retryable: true,
  },
  "calendar.validation_error": {
    expected: "request body matching the calendar event schema",
    hint:
      "Body failed Zod validation. The response's `details` array carries per-field issues — read each `path` + `message` and fix. Common issues: start/end must be `{ dateTime: ISO, timeZone: 'IANA/Name' }` OR `{ date: 'YYYY-MM-DD' }` (all-day), not both; attendees must be array of `{ email }` objects.",
    skillAnchor: "calendar#event-shape",
    legacyErrorCode: "validation_error",
  },
  "calendar.outlook_not_configured": {
    expected: "an active Outlook mail account (calendar reuses its MSAL token)",
    hint:
      "Outlook Calendar piggybacks on the first active Outlook mail account's MSAL token. Either no Outlook account is set up, or the cached token can't acquire Calendars.ReadWrite. Notify the user to add an Outlook account in /settings/mail and confirm calendar scopes were granted.",
    skillAnchor: "calendar#outlook-setup",
    legacyErrorCode: "outlook_not_configured",
    retryable: false,
  },
  "calendar.outlook_disabled": {
    expected: "outlook_calendar integration mode != 'disabled'",
    hint:
      "Outlook Calendar is set to 'disabled' in /settings/integrations. Skip the calendar branch for Outlook routines. Don't re-enable from the agent side — the user controls integration modes via the dashboard.",
    skillAnchor: "calendar#outlook-mode",
    legacyErrorCode: "outlook_calendar_disabled",
    retryable: false,
  },
  "calendar.outlook_delegated": {
    expected: "outlook_calendar integration mode = 'direct' for this route",
    hint:
      "Outlook Calendar is in 'delegated' mode — direct reads are blocked. Route cross-backend work through POST /api/integrations/outlook_calendar/exec (task-mode chokepoint; the legacy /invoke RPC was retired) or wait for the delegated sync worker's next cadence to land observations.",
    skillAnchor: "calendar#outlook-mode",
    legacyErrorCode: "outlook_calendar_delegated",
    retryable: false,
  },

  // ── /api/wiki/* — internal/external wiki. Mostly already structured
  //    (forbidden codes, invalid_body with zod issues). Entries below
  //    enrich the terse spots and the layer-auth 403s.
  "wiki.not_enabled": {
    expected: "an active wiki_workspaces row matching the URL workspace name",
    hint:
      "The wiki is opt-in; either no workspace named `<workspace>` exists, or it has `active=0`. Use GET /api/wiki/workspaces to list available workspaces. To enable, open /settings/wiki in the dashboard and click 'Enable Wiki' — the agent cannot enable it.",
    skillAnchor: "wiki-vault-rules#enable",
    legacyErrorCode: "wiki_not_enabled",
    retryable: false,
  },
  "wiki.workspace_not_found": {
    expected: "an existing workspace row, including archived ones for DELETE/PATCH",
    hint:
      "No workspace named `<workspace>` exists at all (not even archived). GET /api/wiki/workspaces to list ids and names. To create the default workspace, POST /api/wiki/workspaces with an empty body.",
    skillAnchor: "wiki-vault-rules#workspace-crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "wiki.invalid_body": {
    expected: "request body matching the workspace/file/bridge zod schema",
    hint:
      "Body failed Zod validation. The response's `issues` array carries per-field paths — read each `path`/`message` and fix that field exactly. Common shapes by endpoint: (a) POST /wiki/workspaces external — `{ kind: 'external', rootPath: '<abs>', language?, name? }`; (b) POST /wiki/<ws>/files — `{ path: '<layer>/<slug>.md', content: '<markdown>', frontmatter? }`; (c) PATCH /wiki/<ws>/files/<path> — `{ content: '<markdown>' }`; (d) bridge proposals — `{ rawPath, wikiPath, confidence: 0-1, evidence: string }`. Do NOT retry without changing the listed fields.",
    skillAnchor: "wiki-vault-rules#schemas",
    legacyErrorCode: "invalid_body",
  },
  "wiki.invalid_root_path": {
    expected: "writable directory outside primary vault / external obsidian / dataDir / other wiki",
    hint:
      "Wiki root path validation rejects paths that overlap with the management vault, the external Obsidian vault, the daemon's data dir, or another active wiki workspace. POST /api/fs/probe?path=<absolute> first to see which collision applies, then pick a sibling path.",
    skillAnchor: "wiki-vault-rules#root-path",
    legacyErrorCode: "invalid_root_path",
    retryable: false,
  },
  "wiki.invalid_json": {
    expected: "syntactically valid JSON body or empty body",
    hint:
      "POST /api/wiki/workspaces accepts either no body (default-workspace quick path) or a JSON object — anything else fails JSON.parse(). Check for trailing commas, single quotes, or unescaped newlines.",
    skillAnchor: "wiki-vault-rules#workspace-crud",
    legacyErrorCode: "invalid_json",
  },
  "wiki.append_only_raw": {
    expected: "POST to a new path in 10_raw/ (never overwrite)",
    hint:
      "Files in 10_raw/ are create-only (the source-of-truth layer). POSTing to an existing 10_raw/<slug>.md file is rejected. If you need to add to an existing source, append a new dated note under 30_outputs/ or create a 20_wiki/ article that links to it.",
    skillAnchor: "wiki-vault-rules#layer-rules",
    legacyErrorCode: "append_only",
    retryable: false,
  },
  "wiki.append_only_log": {
    expected: "PATCH to log.md (POST overwrite is rejected)",
    hint:
      "log.md grows append-only via PATCH. POST overwrites are rejected once log.md exists. Use PATCH /api/wiki/<workspace>/files/log.md with `{ content: '<new line>' }` to add entries.",
    skillAnchor: "wiki-vault-rules#log",
    legacyErrorCode: "append_only",
    retryable: false,
  },
  "wiki.raw_patch_forbidden": {
    expected: "POST (create) rather than PATCH for 10_raw/ files",
    hint:
      "10_raw/ files cannot be patched after creation — they are immutable sources. Use POST to create a new sibling note instead of mutating an existing one.",
    skillAnchor: "wiki-vault-rules#layer-rules",
    legacyErrorCode: "append_only",
    retryable: false,
  },
  "wiki.invalid_path": {
    expected: "vault-relative path inside a known layer (00_inbox/10_raw/20_wiki/30_outputs/90_meta or log.md)",
    hint:
      "Wiki paths must live inside the four-layer schema. The classifier rejects unknown roots, paths containing '..' or '\\', and shapes that don't match the per-layer regex (e.g. 30_outputs/ requires `<YYYY-MM-DD>-<kind>-<slug>.md`). See wiki-vault-rules for the layer table.",
    skillAnchor: "wiki-vault-rules#path-shapes",
    legacyErrorCode: "invalid_path",
  },
  "wiki.invalid_layer": {
    expected: "path classifying into a known layer",
    hint:
      "Path is well-formed but the leading directory doesn't match any of `00_inbox/`, `10_raw/`, `20_wiki/`, `30_outputs/`, `90_meta/`, or the bare `log.md`. Move the file under the right layer for its kind (raw source → 10_raw, article → 20_wiki, etc.).",
    skillAnchor: "wiki-vault-rules#layer-rules",
    legacyErrorCode: "invalid_layer",
  },
  "wiki.file_not_found": {
    expected: "an existing file under the workspace root",
    hint:
      "GET on a wiki path that does not exist on disk. Use GET /api/wiki/<workspace>/index to list files, or GET /api/wiki/<workspace>/search?q=… to find it by title. POST first to create it if you intended a write.",
    skillAnchor: "wiki-vault-rules#read-file",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "wiki.not_file": {
    expected: "the resolved path is a regular file",
    hint:
      "GET hit a directory rather than a file. Append the file name (e.g. `20_wiki/<slug>.md`) instead of the directory path.",
    skillAnchor: "wiki-vault-rules#read-file",
    legacyErrorCode: "not_file",
    retryable: false,
  },
  "wiki.forbidden_missing_process_key": {
    expected: "x-process-key header on every wiki call",
    hint:
      "Wiki endpoints gate on `x-process-key` for layer-aware auth. The pa-api shim auto-injects this from `PA_PROCESS_KEY`; if you are calling outside a dispatcher session, supply the header explicitly (e.g. `x-process-key: wiki.compile` for compile, `wiki.ingest_url` for raw ingest, `message.dm` for bridge proposals).",
    skillAnchor: "wiki-vault-rules#process-keys",
    legacyErrorCode: "forbidden",
    retryable: false,
  },
  "wiki.forbidden_read": {
    expected: "x-process-key with a `wiki.*` or DM-read prefix",
    hint:
      "GET on wiki files requires either a wiki-tier process key (`wiki.compile`, `wiki.ask`, …) or a DM-read process key (`message.dm`, `message.mention`, `dashboard.chat`). The agent's current process key did not match either set.",
    skillAnchor: "wiki-vault-rules#process-keys",
    legacyErrorCode: "forbidden",
    retryable: false,
  },
  "wiki.forbidden_write": {
    expected: "process key authorized to write to this layer",
    hint:
      "Writes are layer-gated: `wiki.ingest_url` → 10_raw/; `wiki.compile` → 20_wiki/ + 90_meta/; `wiki.ask`/`wiki.trace`/`wiki.connect` → 30_outputs/; `wiki.lint` → 90_meta/health/. DM-tier callers can ONLY write bridge files in 10_raw/ AND only when both `bridge_enabled` and `dm_agent_write_enabled` are on. The `code` field disambiguates which gate failed.",
    skillAnchor: "wiki-vault-rules#process-keys",
    legacyErrorCode: "forbidden",
    retryable: false,
  },
  "wiki.import_conflict": {
    expected: "no destination-side filename collisions in the existing vault",
    hint:
      "Import-migrate aborted because flattened filenames collide with existing files in 20_wiki/. The response's `conflicts` array lists each collision. Re-run with `?allowConflicts=true` to overwrite, or pre-rename the conflicting files in the source vault first.",
    skillAnchor: "wiki-vault-rules#import",
    legacyErrorCode: "import_conflict",
    retryable: true,
  },
  "wiki.import_split_unsupported": {
    expected: "decision = 'adopt' or 'migrate'",
    hint:
      "The 'split' import decision is reserved for the multi-workspace phase and not yet implemented. Re-POST with `decision: 'adopt'` (keep source layout) or `decision: 'migrate'` (flatten to the standard schema).",
    skillAnchor: "wiki-vault-rules#import",
    legacyErrorCode: "import_split_unsupported",
    retryable: false,
  },

  // ── /api/fs/probe — wiki vault path picker.
  "fs.missing_path": {
    expected: "non-empty 'path' query parameter",
    hint:
      "GET /api/fs/probe?path=<absolute-path>. The path must be absolute (no `..`, no `~`) and is checked against the wiki/primary-vault collision matrix. POST /api/system/pick-directory is the OS-native picker — use it first to get a valid absolute path.",
    skillAnchor: "wiki-vault-rules#root-path-picker",
    legacyErrorCode: "missing_path",
    constraint: { type: "string", required: true },
  },
  "fs.invalid_path": {
    expected: "absolute path that is not on the system blocklist",
    hint:
      "The path failed `normalizeRequestedPath()`: it was relative, contained `..` traversal, started with a system prefix (`/etc`, `/var`, `/System`, …), or matched a known secret-file pattern. Pick a path inside the user's home directory or an external mount; the response's `error`/`message` carries the specific reason.",
    skillAnchor: "wiki-vault-rules#root-path-picker",
    retryable: false,
  },

  // ── /api/chat/attachments — Phase 1 attachment upload/download.
  "attachments.too_many_uploads": {
    expected: "fewer than 5 concurrent uploads per principal",
    hint:
      "Throttled — there are already 5 in-flight uploads on this auth key. Wait for one to complete (200/4xx response) before starting another. Multipart parses count from the first byte until the response is sent.",
    skillAnchor: "attachments#upload",
    legacyErrorCode: "too_many_uploads",
    retryable: true,
  },
  "attachments.invalid_content_type": {
    expected: "Content-Type: multipart/form-data; boundary=…",
    hint:
      "Attachment uploads must be multipart/form-data with a single `file` field. application/json, x-www-form-urlencoded, and raw binary are rejected. Use `curl -F 'file=@<path>' -F 'caption=<text>'` for shell uploads.",
    skillAnchor: "attachments#upload",
    legacyErrorCode: "invalid_request",
    retryable: false,
  },
  "attachments.invalid_multipart": {
    expected: "well-formed multipart body with at least one 'file' field",
    hint:
      "Busboy failed to parse the request — the multipart boundary is malformed, the body was empty before the file field, or the stream closed early. Re-send with a clean -F flag; do not concatenate two -F uploads in one request.",
    skillAnchor: "attachments#upload",
    legacyErrorCode: "invalid_multipart",
    retryable: true,
  },
  "attachments.missing_turn_token": {
    expected: "X-Turn-Token header from the currently-running session",
    hint:
      "Outbound (agent→user) attachment uploads require X-Turn-Token. The dispatcher mints one per session and the pa-api shim auto-injects `PA_TURN_TOKEN`. If you're calling outside a session, this endpoint is the wrong one — use POST /api/chat/attachments (inbound) instead.",
    skillAnchor: "attachments#outbound",
    legacyErrorCode: "missing_turn_token",
    retryable: false,
  },
  "attachments.invalid_turn_token": {
    expected: "X-Turn-Token bound to an active session",
    hint:
      "The supplied token doesn't correspond to a currently-running turn. The dispatcher rotates tokens per turn; an attachment from a previous turn is rejected. Re-fetch the token from the current session env (`PA_TURN_TOKEN`) and retry.",
    skillAnchor: "attachments#outbound",
    legacyErrorCode: "invalid_turn_token",
    retryable: false,
  },
  "attachments.ingest_rejected": {
    expected: "file matching the accepted MIME / size constraints",
    hint:
      "The attachment store rejected the file. The `error` field carries the IngestRejectedError reason (disallowed_mime, too_large, mime_mismatch, magic_bytes_mismatch, …); the `message` is verbatim. Common cases: images > 5 MB, non-image > 25 MB, declared application/pdf but magic bytes say PNG.",
    skillAnchor: "attachments#limits",
    retryable: false,
  },
  "attachments.ingest_failed": {
    expected: "successful blob write",
    hint:
      "Internal error storing the attachment. Check daemon logs for the stack; not retryable from the agent side. Notify the user and skip the attach step rather than looping.",
    skillAnchor: "attachments#errors",
    legacyErrorCode: "ingest_failed",
    retryable: false,
  },
  "attachments.not_found": {
    expected: "an existing attachment id from the recent upload response",
    hint:
      "GET / DELETE /chat/attachments/:id for an unknown id. Attachment ids are returned from POST /chat/attachments — store the id immediately and quote it verbatim. Attachments may also have been pruned (TTL).",
    skillAnchor: "attachments#crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "attachments.already_bound": {
    expected: "attachment not yet bound to a message",
    hint:
      "DELETE on an attachment that's already attached to a sent message is rejected — deletion would break the message thread. Detach via the chat history flow instead, or leave it in place.",
    skillAnchor: "attachments#crud",
    legacyErrorCode: "already_bound",
    retryable: false,
  },

  // ── /api/github/* and /webhook/github — webhook receiver + API proxy.
  "github.rate_limited": {
    expected: "fewer than 60 requests per minute per peer (300 global)",
    hint:
      "Webhook receiver rate limit hit (per-peer 60 req/min, global 300 req/min). GitHub auto-retries webhook deliveries with backoff, so this is harmless for real deliveries. If the agent itself is calling here (replay/testing), do NOT tight-loop — drop the GitHub branch of this routine and continue with the rest. Retry the same call only after >=60s have elapsed.",
    skillAnchor: "github#webhook",
    legacyErrorCode: "rate_limited",
    retryable: true,
  },
  "github.webhook_not_configured": {
    expected: "PA_GITHUB_WEBHOOK_SECRET set in the keychain",
    hint:
      "The webhook secret is unset, so signature verification cannot run. The user must set it in /settings/integrations → GitHub. Skip webhook-related work until the secret is configured.",
    skillAnchor: "github#webhook-setup",
    legacyErrorCode: "webhook_not_configured",
    retryable: false,
  },
  "github.invalid_signature": {
    expected: "X-Hub-Signature-256 matching HMAC-SHA256(body, secret)",
    hint:
      "Signature mismatch — either the wrong secret was configured or the request was tampered with. Verify the GitHub webhook secret in /settings/integrations matches the one configured on github.com side.",
    skillAnchor: "github#webhook-auth",
    legacyErrorCode: "invalid_signature",
    retryable: false,
  },
  "github.missing_event_type": {
    expected: "X-GitHub-Event header set",
    hint:
      "Webhook payload received without the X-GitHub-Event header. Real GitHub deliveries always set it; if you are replaying for testing, add it to the request.",
    skillAnchor: "github#webhook",
    legacyErrorCode: "missing_event_type",
    retryable: false,
  },
  "github.invalid_json": {
    expected: "syntactically valid JSON webhook body",
    hint:
      "The webhook body failed JSON.parse(). Genuine GitHub webhooks are always valid JSON; if you are replaying, check the body wasn't double-encoded or truncated.",
    skillAnchor: "github#webhook",
    legacyErrorCode: "invalid_json",
    retryable: false,
  },
  "github.not_configured": {
    expected: "GitHub token in the OS keychain",
    hint:
      "No GitHub token is stored. The user must add one in /settings/integrations → GitHub → 'Add token'. Until then, /api/github/* proxy routes 503 — skip the GitHub branch of any routine.",
    skillAnchor: "github#token",
    legacyErrorCode: "github_not_configured",
    retryable: false,
  },
  "github.repository_not_found": {
    expected: "repository id or slug registered in the unified repositories table",
    hint:
      "The supplied `repo=`/`repositoryId=` does not match any row. Use GET /api/repositories to list registered repos; the value can be a row id, a local absolute path, or `github:owner/repo`. To register a new repo, POST /api/repositories.",
    skillAnchor: "repositories#identifiers",
    legacyErrorCode: "repository_not_found",
    retryable: false,
  },
  "github.repository_not_registered": {
    expected: "(owner, repo) pair registered in the unified repositories table",
    hint:
      "The combination of owner/repo does not match a registered repository. Register the repo first via POST /api/repositories, then retry. Owner+repo must be the canonical GitHub slug — branches and forks need their own rows.",
    skillAnchor: "repositories#github-side",
    legacyErrorCode: "repository_not_registered",
    retryable: false,
  },
  "github.side_required": {
    expected: "repository row with non-null githubOwner + githubRepo",
    hint:
      "The repository is registered locally but has no GitHub side (it's a `local:*` row). GitHub API calls only work on rows with a GitHub slug; either register the GitHub side via PATCH /api/repositories/:id or pick a different repo.",
    skillAnchor: "repositories#dual-sided",
    legacyErrorCode: "github_side_required",
    retryable: false,
  },
  "github.validation_error": {
    expected: "owner+repo or repositoryId in the request",
    hint:
      "Specify the target repo either as `?owner=<owner>&repo=<repo>` or `?repositoryId=<id-or-slug>`. The dual form exists for legacy callers; new code should pass `repositoryId` only.",
    skillAnchor: "repositories#identifiers",
    legacyErrorCode: "validation_error",
    retryable: false,
  },
  "github.pull_number_and_comment_required": {
    expected: "'pull_number' (number) and 'comment' (string) in the JSON body",
    hint:
      "POST /api/github/pulls/comment requires `{ owner, repo, pull_number, comment }` (or `repositoryId` instead of owner+repo). pull_number is the PR number (not the global issue id). comment is the markdown body of the new comment.",
    skillAnchor: "github#pull-comment",
    legacyErrorCode: "pull_number and comment are required",
    constraint: { type: "object", required: true },
  },
  "github.api_error": {
    expected: "successful Octokit response",
    hint:
      "GitHub API returned an error. Inspect `message` (Octokit's verbatim error text) AND `status` (the HTTP code) to disambiguate. Common cases: 401 (token expired — notify the user to refresh in /settings/integrations → GitHub, then skip; the agent cannot self-recover); 403 (secondary rate limit — wait 60s and retry once, then skip if it persists); 404 (repo/PR deleted or token lost visibility — verify the slug, do NOT loop); 422 (validation — `message` names the offending field; typical causes: closing an already-closed PR, commenting on a locked PR, merge with conflicts; do NOT retry the same body); 5xx (GitHub maintenance — retry once after 60s, then skip).",
    skillAnchor: "github#errors",
    legacyErrorCode: "github_api_error",
    retryable: true,
  },

  // ── /api/git/* — local clone proxy (log/diff/show).
  "git.invalid_repo": {
    expected: "repo identifier resolving to a clone in the unified repositories table",
    hint:
      "?repo= must be either an absolute local path matching a row's `local_path`, or a repository id (e.g. `github:acme/widgets`, `local:abc123…`). GitHub-only rows without a clone 404 here. The response's `allowed` array (on /git/log) lists currently-registered local paths.",
    skillAnchor: "repositories#local-path",
    legacyErrorCode: "invalid or missing repo",
    retryable: false,
  },
  "git.invalid_ref": {
    expected: "ref free of shell metachars; not starting with '-'",
    hint:
      "The `?ref=` query parameter is sanitized — it cannot contain `;&|`$` or start with `-` (which would be interpreted as a git flag). Use plain refs like `HEAD~1..HEAD`, `main..feature`, or a 40-char sha range.",
    skillAnchor: "git#diff",
    legacyErrorCode: "invalid ref format",
    retryable: false,
  },
  "git.invalid_hash": {
    expected: "hash free of shell metachars; not starting with '-'",
    hint:
      "The `?hash=` query parameter is sanitized — same rules as ref. Use a 7-40 char hex sha, or `HEAD`/`HEAD~N`. No flag-style strings.",
    skillAnchor: "git#show",
    legacyErrorCode: "invalid hash format",
    retryable: false,
  },
  "git.exec_failed": {
    expected: "successful git invocation on the resolved clone",
    hint:
      "git exited non-zero. `message` is git's verbatim stderr — read it first. Branches: 'unknown revision' / 'bad revision' → the ref doesn't exist locally; cannot retry, instead either narrow to a known sha range (HEAD~10..HEAD) or skip this repo for the turn. 'fatal: not a git repository' → the localPath is no longer a clone (deleted or moved); update the row via PATCH /api/repositories/:id. 'fatal: bad object' / 'object file is empty' → repository corruption; surface to the user with 'Run `git fsck` in <localPath>' and skip. 'unable to read tree' on porcelain queries → uncommitted state; either stash or skip the file-tree query. Do NOT auto-retry — git failures are deterministic given the inputs.",
    skillAnchor: "git#errors",
    retryable: false,
  },

  // ── /api/notion/* — Notion CRUD + search/query.
  "notion.not_configured": {
    expected: "Notion integration token in the OS keychain",
    hint:
      "Notion is not configured. The user must add an integration token in /settings/integrations → Notion and share at least one database with the integration. Until then, /api/notion/* 503s — skip Notion work.",
    skillAnchor: "notion#configuration",
    legacyErrorCode: "notion_not_configured",
    retryable: false,
  },
  "notion.database_not_found": {
    expected: "database label registered in notion_databases config",
    hint:
      "The `?database=<label>` query did not match a registered alias. The 404 response's `available` array lists configured labels (e.g. 'tasks', 'projects'). To register a new database, edit notion_databases in /settings/integrations → Notion.",
    skillAnchor: "notion#database-labels",
    legacyErrorCode: "database_not_found",
    retryable: false,
  },
  "notion.invalid_json_parameter": {
    expected: "URL-encoded JSON in the 'filter' or 'sorts' query parameters",
    hint:
      "GET /api/notion/query accepts `?filter=<json>` and `?sorts=<json>`. The JSON must be URL-encoded — use `encodeURIComponent(JSON.stringify(filterObj))`. Notion filter shape: `{ property: '<name>', <type>: { <op>: <value> } }`. Empty filter: omit the param.",
    skillAnchor: "notion#query",
    legacyErrorCode: "invalid_json_parameter",
    retryable: false,
  },
  "notion.invalid_type": {
    expected: "type query parameter = 'page' | 'data_source'",
    hint:
      "Notion search supports two filter types. Omit the parameter to search both, or pass `type=page` (titles) / `type=data_source` (databases). Anything else is rejected.",
    skillAnchor: "notion#search",
    legacyErrorCode: "invalid_type",
    constraint: { type: "enum", enum: ["page", "data_source"] },
  },
  "notion.invalid_page_id": {
    expected: "32-hex UUID or 8-4-4-4-12 hyphenated UUID",
    hint:
      "Notion page ids are UUIDs — either 32 hex chars without hyphens or canonical 8-4-4-4-12 form. URL-style ids ('My-Page-abc123…') must be stripped of the title prefix; copy the id from the page's Share menu → Copy link → trailing 32-hex string.",
    skillAnchor: "notion#page-id",
    legacyErrorCode: "invalid_page_id",
    constraint: { type: "string", pattern: "^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$" },
  },
  "notion.not_found": {
    expected: "an existing Notion page accessible to the configured integration",
    hint:
      "Notion returned 404 / object_not_found. Either the id is wrong, the page is in trash, or the integration token doesn't have access to it. Share the parent page/database with the integration from the Notion UI, then retry.",
    skillAnchor: "notion#permissions",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "notion.invalid_parent": {
    expected: "parent as database label, { database: '<label>' }, { data_source_id: '<uuid>' }, or { page_id: '<uuid>' }",
    hint:
      "Page create needs an explicit parent. Three accepted shapes: string database label ('tasks'), `{ database: 'tasks' }`, `{ data_source_id: '<uuid>' }`, or `{ page_id: '<uuid>' }`. Database labels must be pre-registered (404 above) before using them here.",
    skillAnchor: "notion#create-page",
    legacyErrorCode: "invalid_parent",
    constraint: { required: true },
  },
  "notion.empty_body": {
    expected: "at least one field to update in the PATCH body",
    hint:
      "PATCH /api/notion/pages/:id rejects empty bodies — supply at least one of properties / icon / cover / in_trash. To rename a page, send `{ properties: { title: [{ text: { content: '<new title>' } }] } }`.",
    skillAnchor: "notion#update-page",
    legacyErrorCode: "empty_body",
    retryable: false,
  },
  "notion.content_required": {
    expected: "'content' string in the PATCH body for append/replace_all/replace_range modes",
    hint:
      "PATCH /api/notion/pages/:id/content modes 'append', 'replace_all', 'replace_range' all need `content: '<markdown>'`. 'update' mode uses `updates: [{ oldStr, newStr }]` instead. Pass an empty string for content to clear; do not omit the field.",
    skillAnchor: "notion#content-modes",
    constraint: { type: "string", required: true },
  },
  "notion.content_range_required": {
    expected: "'content' AND 'contentRange' strings in 'replace_range' mode",
    hint:
      "`mode: 'replace_range'` also needs `contentRange` — the substring of the current page content to replace with `content`. Use 'update' mode if you have many small edits; replace_range is for one contiguous swap.",
    skillAnchor: "notion#content-modes",
    constraint: { type: "object", required: true },
  },
  "notion.updates_required": {
    expected: "non-empty 'updates' array in 'update' mode",
    hint:
      "`mode: 'update'` needs `updates: [{ oldStr: '<find>', newStr: '<replace>', replaceAll?: false }, …]` with at least one entry. Use this for multi-spot find-and-replace; for a single large edit use 'replace_range' or 'replace_all'.",
    skillAnchor: "notion#content-modes",
    constraint: { type: "array", required: true, minimum: 1 },
  },
  "notion.updates_element_invalid": {
    expected: "every updates element has non-empty 'oldStr' (string) and 'newStr' (string)",
    hint:
      "Each entry of `updates[]` must carry both fields. oldStr cannot be empty — that would match everywhere. The response's `message` carries the offending index.",
    skillAnchor: "notion#content-modes",
    constraint: { type: "object" },
  },
  "notion.invalid_mode": {
    expected: "mode = 'append' | 'replace_all' | 'replace_range' | 'update'",
    hint:
      "PATCH content has exactly four modes. Pick: 'append' (add to end), 'replace_all' (rewrite), 'replace_range' (swap one contiguous chunk), 'update' (multi-spot find-replace). Anything else is rejected.",
    skillAnchor: "notion#content-modes",
    legacyErrorCode: "invalid_mode",
    constraint: { type: "enum", enum: ["append", "replace_all", "replace_range", "update"] },
  },
  "notion.upstream_error": {
    expected: "successful Notion API response",
    hint:
      "Notion API call failed. The `error` field tells you which operation tripped (query/search/get/create/update/archive/content_update); the `message` is Notion's verbatim API response. Common cases: 401 (token revoked or rotated — notify the user to re-add in /settings/integrations → Notion, then skip Notion work this turn); 403 (page not shared with the integration — guide the user to open the page in Notion → ··· menu → Add connections → pick the integration, then retry once); 404 (page in trash or id wrong — verify with a search call before retrying); 409 (conflict_error on concurrent edits — re-fetch the page and replay the edit once); 429 (rate limit — Notion caps at 3 req/sec/integration; back off 60s then retry once). Do NOT loop without changing the call shape.",
    skillAnchor: "notion#errors",
    retryable: true,
  },

  // ── /api/mail/* — multi-provider mail proxy (Gmail, Outlook, IMAP, …).
  "mail.not_configured": {
    expected: "at least one active mail account in the account registry",
    hint:
      "No mail accounts are set up. The user must add one in /settings/mail (Gmail OAuth, Outlook MSAL, IMAP credentials, etc.). Until then, /api/mail/* 503s — skip the mail branch.",
    skillAnchor: "mail#accounts",
    legacyErrorCode: "mail_not_configured",
    retryable: false,
  },
  "mail.blob_store_unavailable": {
    expected: "encrypted blob store wired into the daemon",
    hint:
      "Internal config error — the per-account secrets store is missing. The user must run `aitne doctor` to diagnose; agent cannot recover. Skip mail work this turn.",
    skillAnchor: "mail#secrets",
    legacyErrorCode: "blob_store_unavailable",
    retryable: false,
  },
  "mail.unsupported_kind": {
    expected: "kind = 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'imap'",
    hint:
      "Mail account creation needs an explicit provider kind. Pick from the supported list — the request body's `kind` is the dispatch switch. Use 'imap' for any custom IMAP server (Fastmail, ProtonMail bridge, etc.).",
    skillAnchor: "mail#account-create",
    legacyErrorCode: "unsupported_kind",
    constraint: { type: "enum", enum: ["gmail", "outlook", "yahoo", "icloud", "imap"] },
  },
  "mail.outlook_client_config_missing": {
    expected: "OUTLOOK_CLIENT_ID env var or pre-registered tenant config",
    hint:
      "Outlook MSAL needs a registered app's client_id. The user must register an app in Azure AD and set OUTLOOK_CLIENT_ID before /api/mail/accounts can create Outlook rows. Skip Outlook setup; notify the user.",
    skillAnchor: "mail#outlook-setup",
    legacyErrorCode: "outlook_client_config_missing",
    retryable: false,
  },
  "mail.account_not_found": {
    expected: "account id from POST /api/mail/accounts",
    hint:
      "No mail account row matches this id. GET /api/mail/accounts to list current ids. Note that DELETE returns 204 + the row drops; reusing the same id afterward will 404.",
    skillAnchor: "mail#account-crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "mail.oauth_timeout": {
    expected: "user completes the OAuth consent flow within the timeout",
    hint:
      "OAuth pairing timed out waiting for the user to grant consent in the browser. Notify the user that they need to finish the consent flow (open the link the dashboard surfaced) and retry the pair step.",
    skillAnchor: "mail#oauth",
    legacyErrorCode: "oauth_timeout",
    retryable: true,
  },
  "mail.invalid_body": {
    expected: "JSON body matching the per-endpoint shape",
    hint:
      "Mail endpoint body missing or malformed — `message` names the specific offender (e.g. 'clientId required', 'read: boolean required', 'add/remove labels required'). Common shapes by endpoint: POST /mail/accounts — `{ kind, displayName?, ... }` (provider-specific extras); PATCH /mail/messages/:id/read — `{ read: boolean }`; PATCH /mail/messages/:id/labels — `{ add?: string[], remove?: string[] }` (at least one); POST /mail/send — see mail.validation_failed for the send contract. Read `message` verbatim, supply the missing field, and resubmit; do NOT retry the same body.",
    skillAnchor: "mail#request-shapes",
    legacyErrorCode: "invalid_body",
    constraint: { type: "object", required: true },
  },
  "mail.not_implemented": {
    expected: "operation supported by the resolved provider",
    hint:
      "This operation is not available on the resolved provider. `message` names the gap (e.g. 'untrash not supported on imap', 'listDrafts not supported on imap'). Known gaps: IMAP cannot manage drafts (no DRAFTS folder semantics — compose via SMTP send instead); IMAP cannot untrash once a message hits `\\Deleted` + EXPUNGE; Yahoo/iCloud have no thread API (use search by subject as a fallback); only Gmail exposes label semantics, others use folder moves. If the agent's intent requires this provider's data, skip the operation and surface to the user — do NOT retry the same call.",
    skillAnchor: "mail#provider-matrix",
    legacyErrorCode: "not_implemented",
    retryable: false,
  },
  "mail.provider_auth_error": {
    expected: "valid OAuth/IMAP credentials for the resolved account",
    hint:
      "Provider returned 401/403 — credentials are revoked, expired, or insufficient. Notify the user to re-link the account in /settings/mail; the agent cannot refresh OAuth interactively. Skip mail operations until the user confirms.",
    skillAnchor: "mail#errors",
    legacyErrorCode: "provider_auth_error",
    retryable: false,
  },
  "mail.validation_failed": {
    expected: "send body matching the validateSendInput contract",
    hint:
      "Send-mail body failed validation. The `errors` array carries per-field issues; fix every listed entry before retrying. Required fields: `to` (non-empty array of string emails or `{ email, name? }` objects), at least one of `subject`/`body`/`draftId`. Optional: `cc`/`bcc` (same shape as `to`), `replyTo` (single recipient), `inReplyTo` (RFC 822 message-id of the parent for thread continuation), `attachments` (array of `{ filename, mimeType, contentBase64 }` — all three are required per attachment). Address fields reject bare names without `@`; encode display names via the `{ email, name }` form, not RFC-2822 `Name <addr>` strings.",
    skillAnchor: "mail#send",
    legacyErrorCode: "validation_failed",
  },
  "mail.upstream_error": {
    expected: "successful provider API response",
    hint:
      "Mail provider returned an unexpected error. `error` is the per-route tag (`mail_list_failed`, `mail_send_failed`, …); `message` is the provider's verbatim text. Transient = 5xx, ECONNRESET, ETIMEDOUT, IMAP NO/BAD with text mentioning 'temporary' — retry ONCE after 30s, then skip. Permanent = 4xx, IMAP NO with mailbox/permission text, SMTP 5xx — do NOT retry; notify the user with the verbatim `message` and skip the mail branch. After two consecutive retries on the same account, treat as permanent regardless of code.",
    skillAnchor: "mail#errors",
    retryable: true,
  },

  // ── /api/knowledge/* — knowledge bus inputs.
  "knowledge.event_bus_unavailable": {
    expected: "EventBus wired into the API server",
    hint:
      "The event bus is not constructed — daemon is starting up or in degraded mode. Wait ~5s and retry; if it persists, the agent should skip and notify the user. Do not loop tight.",
    skillAnchor: "knowledge#bus",
    legacyErrorCode: "event_bus_unavailable",
    retryable: true,
  },
  "knowledge.empty_file": {
    expected: "non-empty file payload",
    hint:
      "The uploaded file was 0 bytes after multipart parse — likely a curl typo (`-F 'file=@'` with empty path) or a download race. Re-fetch the source and resubmit.",
    skillAnchor: "knowledge#upload",
    legacyErrorCode: "empty_file",
    constraint: { type: "string", minLength: 1 },
  },

  // ── /api/observations/* — Phase 9 pending/consume.
  "observations.invalid_actor": {
    expected: "actor = 'user' | 'agent' | 'system'",
    hint:
      "The `?actor=` filter accepts only `user`, `agent`, or `system`. `user` is the hourly-check default (excludes agent's own writes). Omit to get all observations.",
    skillAnchor: "observations#actor-filter",
    legacyErrorCode: "invalid_actor",
    constraint: { type: "enum", enum: ["user", "agent", "system"] },
  },
  "observations.invalid_json_body": {
    expected: "syntactically valid JSON consume body",
    hint:
      "POST /api/observations/consume body failed JSON parse. The body shape is `{ ids: number[], cursor?: string }`. Verify quoting and array shape before re-sending.",
    skillAnchor: "observations#consume",
    legacyErrorCode: "invalid_json_body",
    retryable: false,
  },

  // ── /api/recurring-schedules/* — recurring schedule CRUD.
  "recurring_schedules.invalid_id": {
    expected: "positive integer id from GET /api/recurring-schedules",
    hint:
      "The `:id` route param must be a positive integer. GET /api/recurring-schedules to list ids. URL-encoded ids and decimal ids are rejected.",
    skillAnchor: "recurring-schedules#crud",
    legacyErrorCode: "invalid_id",
    constraint: { type: "integer", minimum: 1 },
  },
  "recurring_schedules.not_found": {
    expected: "an existing recurring_schedules row",
    hint:
      "PATCH/DELETE on an id that doesn't exist. GET /api/recurring-schedules to discover current ids; rows are pruned when the user disables them via the dashboard.",
    skillAnchor: "recurring-schedules#crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "recurring_schedules.validation_error": {
    expected: "body matching recurringScheduleSchema (cron-like + payload)",
    hint:
      "Zod validation failed. The `details` field lists per-field issues. Required shape: `{ cron: '<cron expr>', taskType: 'wake'|'dm_session'|…, description: '<20+ chars>', taskContext: {...} }`. Use a cron expression validator (e.g. crontab.guru) before submitting.",
    skillAnchor: "recurring-schedules#schema",
    legacyErrorCode: "validation_error",
  },

  // ── /api/travel-bookings/* — travel booking CRUD (read-only for agent
  //    except PATCH status / destination). Ingested by the mail observer
  //    via gmail-classifier reservation extraction; the agent rarely
  //    creates these directly.
  "travel_bookings.invalid_type": {
    expected: "one of 'flight' | 'hotel' | 'restaurant' | 'train' | 'bus' | 'other'",
    hint:
      "The `?type=` filter must be a registered travel kind. The 400 response carries the `validTypes` array verbatim — pick from it or omit the filter to get all kinds. Spelling matters: 'plane' / 'flights' are rejected; use 'flight'.",
    skillAnchor: "gmail-lifestyle#travel-bookings-filters",
    legacyErrorCode: "invalid_type",
    constraint: { type: "enum", enum: ["flight", "hotel", "restaurant", "train", "bus", "other"] },
  },
  "travel_bookings.invalid_status": {
    expected: "one of 'upcoming' | 'completed' | 'cancelled' | 'all' (filter) or 'upcoming' | 'completed' | 'cancelled' (PATCH)",
    hint:
      "Status values are constrained. Filter (?status=) accepts 'all' as the no-op; PATCH body { status } does NOT — pick one of the three concrete states. The 400 response's `validStatuses` / `valid` array carries the live list.",
    skillAnchor: "gmail-lifestyle#travel-bookings-status",
    legacyErrorCode: "invalid_status",
  },
  "travel_bookings.invalid_id": {
    expected: "positive integer id from GET /api/travel-bookings",
    hint:
      "PATCH /api/travel-bookings/:id needs a numeric row id. GET /api/travel-bookings to discover live ids; the response items carry `.id`. URL-encoded and decimal ids are rejected.",
    skillAnchor: "gmail-lifestyle#travel-bookings-crud",
    legacyErrorCode: "invalid_id",
    constraint: { type: "integer", minimum: 1 },
  },
  "travel_bookings.invalid_json": {
    expected: "syntactically valid JSON body",
    hint:
      "PATCH body failed JSON.parse(). Check for trailing commas, single quotes, or unescaped newlines. Use jq -nc to validate before piping into curl --data-binary.",
    skillAnchor: "gmail-lifestyle#travel-bookings-request-shape",
    legacyErrorCode: "invalid_json",
    retryable: false,
  },
  "travel_bookings.no_updates": {
    expected: "PATCH body containing at least one of { status, destination }",
    hint:
      "PATCH /api/travel-bookings/:id rejects empty bodies. Supply at least one mutable field — currently `status` ('upcoming'|'completed'|'cancelled') or `destination` (string). Other columns are immutable; re-ingest from mail to change them.",
    skillAnchor: "gmail-lifestyle#travel-bookings-patch",
    legacyErrorCode: "no_updates",
    retryable: false,
  },
  "travel_bookings.not_found": {
    expected: "an existing travel_bookings row matching :id",
    hint:
      "PATCH targeted a row id that does not exist. GET /api/travel-bookings to discover current ids; rows can be pruned when a cancellation mail is reconciled. Do not retry the same id.",
    skillAnchor: "gmail-lifestyle#travel-bookings-crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },

  // ── /api/receipts/* — receipt attachment registry. Mostly read-only; the
  //    agent PATCHes obsidianPath/category when the morning routine files a
  //    receipt under the Obsidian vault. Download proxies to the mail
  //    provider for the originating account.
  "receipts.invalid_id": {
    expected: "positive integer id from GET /api/receipts",
    hint:
      "The `:id` route param must be a positive integer. GET /api/receipts to list current ids; receipts are pruned when the source mail is deleted. URL-encoded and decimal ids are rejected.",
    skillAnchor: "gmail-lifestyle#receipts-crud",
    legacyErrorCode: "invalid_id",
    constraint: { type: "integer", minimum: 1 },
  },
  "receipts.not_found": {
    expected: "an existing receipts row matching :id",
    hint:
      "No receipt row exists with that id. Re-list with GET /api/receipts (filters: ?category=, ?saved=true|false) to find the right id. Rows are removed when the source mail message is purged by IMAP reconciliation.",
    skillAnchor: "gmail-lifestyle#receipts-crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "receipts.no_updates": {
    expected: "PATCH body containing at least one of { obsidianPath, category }",
    hint:
      "PATCH /api/receipts/:id needs at least one mutable field. Currently `obsidianPath` (sets saved_at to now) or `category` ('document'|'travel'). Pass both to file a receipt under Obsidian and re-tag in one shot.",
    skillAnchor: "gmail-lifestyle#receipts-patch",
    legacyErrorCode: "no_updates",
    retryable: false,
  },
  "receipts.attachment_too_large": {
    expected: "receipt attachment <= 100 MB",
    hint:
      "Download blocked by the 100 MB ceiling to avoid OOM. The `maxBytes` field carries the limit. For attachments above this, ask the user to download via the mail provider's web UI instead. Do not retry — the size won't shrink.",
    skillAnchor: "gmail-lifestyle#receipts-download-limits",
    legacyErrorCode: "attachment_too_large",
    retryable: false,
  },
  "receipts.mail_not_configured": {
    expected: "mail registry available with at least one active account",
    hint:
      "Receipt download proxies through the originating mail account. The mail registry is not wired in — either no accounts are configured yet, or the daemon is in degraded mode. Notify the user; skip receipt downloads this turn.",
    skillAnchor: "gmail-lifestyle#receipts-download",
    legacyErrorCode: "mail_not_configured",
    retryable: false,
  },
  "receipts.orphaned_receipt": {
    expected: "receipt row with a non-null account_id linked to an active mail account",
    hint:
      "The receipt has account_id=NULL, so the daemon can't pick a provider to fetch the attachment. This typically means the originating mail account was deleted. Either re-ingest the receipt from the new account, or skip the download — there is no recovery from this state without re-ingest.",
    skillAnchor: "gmail-lifestyle#receipts-account-link",
    legacyErrorCode: "orphaned_receipt",
    retryable: false,
  },
  "receipts.account_not_found": {
    expected: "account_id matching an active row in the mail account registry",
    hint:
      "The receipt's account_id does not resolve to any registered mail account. The account was likely removed in /settings/mail. Either re-add it (the user must re-link) or skip the download.",
    skillAnchor: "gmail-lifestyle#receipts-account-link",
    legacyErrorCode: "account_not_found",
    retryable: false,
  },
  "receipts.attachment_download_not_supported": {
    expected: "originating provider supports per-attachment download",
    hint:
      "This provider (e.g. an IMAP server without UID FETCH attachment selectors) cannot download individual attachments. The `provider` field names the kind. Ask the user to fetch the attachment via the provider's native UI; do not retry.",
    skillAnchor: "gmail-lifestyle#receipts-download",
    legacyErrorCode: "attachment_download_not_supported",
    retryable: false,
  },
  "receipts.attachment_not_found": {
    expected: "provider returns a non-null attachment payload for the recorded (msg, attachment) pair",
    hint:
      "The mail provider returned null when asked for the attachment — typically the source message was deleted or moved out of the All Mail label. Skip the download and offer to remove the orphan row by PATCHing category='deleted' or by user action.",
    skillAnchor: "gmail-lifestyle#receipts-download",
    legacyErrorCode: "attachment_not_found",
    retryable: false,
  },

  // ── /api/books/* — reading list + highlights. Source of truth for the
  //    `/wiki reading` skill and the morning routine's "what did I read"
  //    block. Read-only except PATCH metadata + import Kindle clippings.
  "books.invalid_id": {
    expected: "positive integer id from GET /api/books",
    hint:
      "Book id must be a positive integer. GET /api/books?limit=200 to list current ids; URL-encoded and decimal ids are rejected.",
    skillAnchor: "books#crud",
    legacyErrorCode: "invalid_id",
    constraint: { type: "integer", minimum: 1 },
  },
  "books.not_found": {
    expected: "an existing books row matching :id",
    hint:
      "No book row exists with that id. GET /api/books to discover current ids, or POST /api/books/import-clippings / import-notebook-html to create rows from Kindle exports.",
    skillAnchor: "books#crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "books.invalid_json": {
    expected: "syntactically valid JSON body",
    hint:
      "Body failed JSON.parse(). Check for trailing commas, single quotes, or unescaped newlines in the clipping/HTML text. Use jq -nc to validate before piping into curl --data-binary.",
    skillAnchor: "books#request-shape",
    legacyErrorCode: "invalid_json",
    retryable: false,
  },
  "books.invalid_status": {
    expected: "one of 'reading' | 'completed' | 'abandoned'",
    hint:
      "Book status whitelist. The 400 response carries the `valid` array verbatim. To delete a book, use 'abandoned' (no DELETE endpoint by design — keeps the highlights linkable).",
    skillAnchor: "books#status",
    legacyErrorCode: "invalid_status",
    constraint: { type: "enum", enum: ["reading", "completed", "abandoned"] },
  },
  "books.rating_must_be_1_to_5": {
    expected: "integer between 1 and 5 (inclusive) for the `rating` field",
    hint:
      "Rating uses a 5-star scale. Pass an integer 1–5; decimals and out-of-range values are rejected. Omit the field if you don't want to rate the book.",
    skillAnchor: "books#rating",
    legacyErrorCode: "rating_must_be_1_to_5",
    constraint: { type: "integer", minimum: 1, maximum: 5 },
  },
  "books.no_updates": {
    expected: "PATCH body containing at least one of { status, rating, notes }",
    hint:
      "PATCH /api/books/:id needs at least one mutable field. Currently `status` ('reading'|'completed'|'abandoned'), `rating` (1–5), or `notes` (free string). Setting status='completed' also stamps completed_at automatically.",
    skillAnchor: "books#patch",
    legacyErrorCode: "no_updates",
    retryable: false,
  },
  "books.payload_too_large": {
    expected: "request body <= 10 MB",
    hint:
      "Clipping/notebook-HTML imports cap at 10 MB. Typical Kindle My Clippings.txt is under 5 MB; a 10 MB+ payload suggests duplicate concatenation or stray binary data. Split the file or ask the user to re-export.",
    skillAnchor: "books#import-limits",
    legacyErrorCode: "payload_too_large",
    retryable: false,
  },
  "books.data_required": {
    expected: "non-empty 'data' string in the import-clippings body",
    hint:
      "POST /api/books/import-clippings requires `{ data: '<clippings.txt content>' }`. Pass the raw text content (the parser handles ==== separators and the standard Kindle header lines).",
    skillAnchor: "books#import-clippings",
    legacyErrorCode: "data_required",
    constraint: { type: "string", required: true, minLength: 1 },
  },
  "books.html_required": {
    expected: "non-empty 'html' string in the import-notebook-html body",
    hint:
      "POST /api/books/import-notebook-html requires `{ html: '<email HTML>', subject?, date? }`. Pass the raw HTML payload from the Kindle 'Export Notebook' email; subject/date are used as fallbacks when the HTML lacks an explicit title or timestamp.",
    skillAnchor: "books#import-notebook-html",
    legacyErrorCode: "html_required",
    constraint: { type: "string", required: true, minLength: 1 },
  },
  "books.unrecognized_format": {
    expected: "Kindle notebook HTML matching the parser's known shapes",
    hint:
      "HTML didn't match any known Kindle notebook export shape. Three likely causes: (a) Amazon changed the export template — the agent cannot adapt, surface to the user and ask for a re-export; (b) the HTML was already converted to plain text before upload (e.g. via a 'Save as PDF'/'Print to plain text' detour) — request the original .html attachment from the Kindle 'Export Notebook' email; (c) wrong source (Goodreads, Apple Books, etc.) — only Kindle is supported here. Recovery for the user: open https://read.amazon.com → pick the book → Notebook (right rail) → Export → 'Send as email' → forward the .html attachment without modification. Do NOT retry without a different payload.",
    skillAnchor: "books#import-notebook-html",
    legacyErrorCode: "unrecognized_format",
    retryable: false,
  },

  // ── /api/repositories/* — unified Git + GitHub repository CRUD,
  //    triggers, and daily management. The agent touches these from
  //    the `repository.*` skills, `git.project.refresh_architecture`,
  //    and the morning routine's "what changed in my repos?" block.
  //    See docs/design/appendices/unified-repositories.md.
  "repositories.not_found": {
    expected: "an existing repositories row matching :id, slug, or `github:owner/repo`",
    hint:
      "GET /api/repositories to list current rows. The `:id` route param accepts the row id, the `localPath` absolute path, or a `github:<owner>/<repo>` slug. Rows are removed via DELETE — the agent cannot recreate one without explicit user intent.",
    skillAnchor: "repositories#crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "repositories.event_bus_unavailable": {
    expected: "EventBus wired into the API server",
    hint:
      "The daemon is starting up or in degraded mode — the EventBus that schedules repository runs is not yet available. Wait ~5s and retry once; if it persists, skip the repository run and notify the user.",
    skillAnchor: "repositories#run",
    legacyErrorCode: "event_bus_unavailable",
    retryable: true,
  },
  "repositories.validation_error": {
    expected: "request body fields satisfying the run/trigger contract",
    hint:
      "A required field is missing or has the wrong shape — `message` names the offender (e.g. 'name is required', 'backend must be claude/codex/gemini', 'prompt is required'). Read the message verbatim and supply the field. Most repository POST bodies need at minimum `{ backend, model, workdirMode, prompt }` (run) or `{ name, eventType, backend, model, workdirMode, prompt }` (trigger).",
    skillAnchor: "repositories#schemas",
    legacyErrorCode: "validation_error",
  },
  "repositories.model_invalid": {
    expected: "model registered for the chosen backend in process_backend_config",
    hint:
      "The (backend, model) pair is rejected because the model isn't listed in the backend's model registry. GET /api/backends/models?backend=<backend> to list valid models for that backend. Common: passing 'sonnet' alias to codex/gemini — they need full ids like 'claude-sonnet-4-6' or 'gemini-2.5-pro'.",
    skillAnchor: "repositories#run",
    legacyErrorCode: "model_invalid",
    retryable: false,
  },
  "repositories.local_clone_required": {
    expected: "repositories row with a non-null localPath",
    hint:
      "The operation needs a local git clone — management init/scan/refresh-architecture and `workdirMode='local-clone'` runs all require it. Either POST /api/repositories/:id/link-local first with a clone path, or pick `workdirMode='temp'` for run-in-temp.",
    skillAnchor: "repositories#dual-sided",
    legacyErrorCode: "local_clone_required",
    retryable: false,
  },
  "repositories.instruction_required": {
    expected: "`instructionMd` string when workdirMode='temp'",
    hint:
      "run-in-temp needs an explicit instruction markdown — the temp clone has no project context to ground the agent. Either provide `instructionMd` (markdown the agent will read first) or switch to `workdirMode='local-clone'` if a clone is registered.",
    skillAnchor: "repositories#run",
    legacyErrorCode: "instruction_required",
    retryable: false,
  },
  "repositories.already_in_flight": {
    expected: "no in-flight git.project.refresh_architecture row for this repo",
    hint:
      "An architecture refresh is already pending or running. Two concurrent runs would race on the overview.md chokepoint write and burn model quota. Poll GET /api/repositories/:id/management → architectureRefresh.status until it leaves 'pending'/'running', or just wait for the next dashboard refresh.",
    skillAnchor: "repositories#refresh-architecture",
    legacyErrorCode: "already_in_flight",
    retryable: true,
  },
  "repositories.no_overview": {
    expected: "overview.md exists for this repository",
    hint:
      "PUT /architecture-section can only replace the Architecture block of an existing overview.md. Run POST /api/repositories/:id/management/init first to create the skeleton, then retry the PUT.",
    skillAnchor: "repositories#architecture-section",
    legacyErrorCode: "no_overview",
    retryable: false,
  },
  "repositories.payload_too_large": {
    expected: "architecture-section markdown body within the size limit",
    hint:
      "The markdown body exceeds the per-section byte cap. Shorten the section — focus on stable architecture (modules, dataflow, key invariants), not change history. Split overlapping content out into other overview sections via init/scan instead.",
    skillAnchor: "repositories#architecture-section",
    legacyErrorCode: "payload_too_large",
    retryable: false,
  },
  "repositories.management_init_failed": {
    expected: "successful init of git/<slug>/overview.md",
    hint:
      "Init failed mid-pipeline (skeleton write OR architecture-refresh enqueue). `message` carries the underlying error verbatim. Diagnose by branch: 'ENOENT' / 'EACCES' on the localPath → user must remount the clone or fix permissions; 'fatal:' from git → the clone is corrupt (suggest `git fsck`); 'UNIQUE constraint failed' → an in-flight init/refresh already exists, wait for it to terminal then re-call; any other text → schema drift, do not loop. Skip the repository for this turn and surface ONE notification with the verbatim `message`.",
    skillAnchor: "repositories#management-init",
    legacyErrorCode: "management_init_failed",
    retryable: false,
  },
  "repositories.architecture_refresh_enqueue_failed": {
    expected: "successful insert of a git.project.refresh_architecture schedule row",
    hint:
      "Could not enqueue the architecture-refresh agent run. The underlying error is in `message`. Don't auto-retry — typically a schema/migration drift or an EventBus shutdown. Surface to the user.",
    skillAnchor: "repositories#refresh-architecture",
    legacyErrorCode: "architecture_refresh_enqueue_failed",
    retryable: false,
  },
  "repositories.architecture_section_write_failed": {
    expected: "successful in-process write of overview.md's Architecture block",
    hint:
      "The Architecture section write to overview.md failed. `message` carries the underlying file/IO error. Inspect `git/<slug>/overview.md` manually if writable; otherwise surface to the user.",
    skillAnchor: "repositories#architecture-section",
    legacyErrorCode: "architecture_section_write_failed",
    retryable: false,
  },
  "repositories.management_scan_failed": {
    expected: "successful management scan run",
    hint:
      "Daily management scan failed mid-run. `message` carries the underlying error. Common causes and the right next step: 'git fetch failed' / network text → clone is offline; skip until network returns, do not retry this turn. 'journal write failed' (EACCES/ENOSPC) → vault is read-only or full; surface to the user with the verbatim path and stop scanning. GitHub rate-limited → the secondary limit hit (see github.rate_limited); next cron tick (1h+) will succeed naturally. The scan row is marked 'failed' for audit even though the row itself is unrecoverable — do NOT enqueue a manual retry, let the daily cron fire.",
    skillAnchor: "repositories#management-scan",
    legacyErrorCode: "management_scan_failed",
    retryable: false,
  },
  "repositories.internal_error": {
    expected: "no unexpected exception inside the store",
    hint:
      "RepositoryStore threw an unrecognised error. `message` carries the verbatim exception. This is typically a schema/migration drift; do not retry without operator action.",
    skillAnchor: "repositories#errors",
    legacyErrorCode: "internal_error",
    retryable: false,
  },

  // ── /api/mcp/* — MCP server CRUD + probe (B-003). The agent rarely
  //    calls these directly; most are dashboard mutations. Included for
  //    completeness so any agent-initiated probe / status read gets a
  //    structured envelope rather than a bare 4xx.
  "mcp.not_found": {
    expected: "an existing mcp_servers row matching :id",
    hint:
      "GET /api/mcp/servers to list current ids. MCP server rows are added via POST /api/mcp/servers; the agent cannot create them — surface to the user if a referenced server is missing.",
    skillAnchor: "mcp#crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "mcp.invalid_input": {
    expected: "request body matching the MCP server / patch / secret schema",
    hint:
      "Body failed Zod validation. The `issues` array carries per-field paths — fix each one and resubmit. Common: transport must be 'stdio'|'sse'|'http'|'docker'; backends must be a non-empty array of registered backend ids; envKeys/headerKeys must be non-empty strings.",
    skillAnchor: "mcp#schemas",
    legacyErrorCode: "invalid_input",
  },
  "mcp.duplicate": {
    expected: "no existing mcp_servers row with the same id",
    hint:
      "An MCP server with this id already exists. Either PATCH /api/mcp/servers/:id to update the existing row, or pick a different id (ids are user-visible — e.g. 'my-notion', 'acme-mcp/coda').",
    skillAnchor: "mcp#duplicate",
    legacyErrorCode: "duplicate",
    retryable: false,
  },
  "mcp.internal_error": {
    expected: "no unexpected exception inside the MCP registry",
    hint:
      "Internal error during MCP CRUD. Inspect daemon logs for the stack; the route does not surface implementation detail to the agent. Do not retry — typically a schema/migration drift or a corrupted secrets blob.",
    skillAnchor: "mcp#errors",
    legacyErrorCode: "internal_error",
    retryable: false,
  },
  "mcp.server_disabled": {
    expected: "MCP server row with enabled=1",
    hint:
      "Probe is rejected because the server is currently disabled. Enable via POST /api/mcp/servers/:id/enable (Approve tier — the dashboard owns this), or notify the user to enable it before retrying.",
    skillAnchor: "mcp#probe",
    legacyErrorCode: "server_disabled",
    retryable: false,
  },
  "mcp.probe_failed": {
    expected: "MCP probe completes without throwing at the transport layer",
    hint:
      "The probe transport threw an unexpected error (not a normal `{ ok: false }` probe result, which is persisted normally). `message` carries the verbatim failure. Common: the configured command/binary is missing, the URL is unreachable, or an env-key secret is unset.",
    skillAnchor: "mcp#probe",
    legacyErrorCode: "probe_failed",
    retryable: true,
  },
  "mcp.unknown_key": {
    expected: "keyName declared in the server's envKeys or headerKeys",
    hint:
      "Secret keyName must match one of the strings configured on the server. PATCH /api/mcp/servers/:id with the new key in envKeys (for stdio servers) or headerKeys (for HTTP/SSE) before writing the secret value.",
    skillAnchor: "mcp#secrets",
    legacyErrorCode: "unknown_key",
    retryable: false,
  },
  "mcp.gemini_cli_not_found": {
    expected: "`gemini` CLI binary resolvable on the daemon's PATH",
    hint:
      "POST /api/mcp/gemini-install needs the Gemini CLI installed and on PATH. Notify the user to install it from https://github.com/google-gemini/gemini-cli and re-run `aitne doctor` to confirm resolution.",
    skillAnchor: "mcp#gemini-install",
    legacyErrorCode: "gemini_cli_not_found",
    retryable: false,
  },
  "mcp.install_failed": {
    expected: "successful `gemini extensions install` / `gemini mcp add` invocation",
    hint:
      "Gemini CLI exited non-zero. `stdout`/`stderr` on the response are verbatim — read both. Common branches: 'not authenticated' / 'login required' → user must run `gemini auth login` first, the agent cannot complete OAuth interactively; 'ECONNREFUSED' / 'ENOTFOUND' → npm registry/network blocked, surface and skip; 'already installed' at a different version → DELETE /api/mcp/servers/:id then re-POST with the desired version, OR install via the dashboard's /settings/integrations → MCP card which handles version pinning. Idempotent re-runs short-circuit with `alreadyInstalled: true`, so reaching this code means a real failure — do NOT retry the same call.",
    skillAnchor: "mcp#gemini-install",
    legacyErrorCode: "install_failed",
    retryable: false,
  },

  // ── /api/skills/* — user skill CRUD + multipart upload. The agent
  //    doesn't typically write skills (the user owns the curated set),
  //    but skill discovery is read-tier from the dashboard.
  "skills.invalid_form": {
    expected: "multipart/form-data body with at least a `file` field",
    hint:
      "Skill upload requires multipart/form-data. application/json and x-www-form-urlencoded are rejected. Use `curl -F 'file=@SKILL.md' -F 'name=<slug>'` for shell uploads.",
    skillAnchor: "skills#upload",
    legacyErrorCode: "invalid_form",
    retryable: false,
  },
  "skills.file_field_required": {
    expected: "multipart 'file' part containing the SKILL.md content",
    hint:
      "The multipart parsed but did not include a `file` field. Add `-F 'file=@<path>'` (or the equivalent in your client) — the file part is required.",
    skillAnchor: "skills#upload",
    legacyErrorCode: "file field required",
    retryable: false,
  },
  "skills.builtin_protected": {
    expected: "skill name not matching a built-in slug",
    hint:
      "Built-in skills are read-only — they ship with the daemon and are owned by `agent-assets/skills/`. Pick a different slug for user skills (e.g. add a prefix like `user-` or `<your-handle>-`). GET /skills/sources to see built-in slugs.",
    skillAnchor: "skills#builtin-protection",
    legacyErrorCode: "builtin_protected",
    retryable: false,
  },
  "skills.file_too_large": {
    expected: "uploaded SKILL.md file <= 256 KB",
    hint:
      "SKILL.md uploads cap at 256 KB. A larger file usually means embedded binary content or accidentally-included generated output. Trim the file and re-upload; consider linking out to longer prose rather than inlining.",
    skillAnchor: "skills#upload-limits",
    legacyErrorCode: "file_too_large",
    retryable: false,
  },
  "skills.invalid_encoding": {
    expected: "valid UTF-8 file content",
    hint:
      "The uploaded file is not valid UTF-8 — likely a binary file renamed to .md. Re-export as plain UTF-8 text. macOS Notes / Pages exports particularly often include BOMs and surrogate pairs that trip the validator.",
    skillAnchor: "skills#upload",
    legacyErrorCode: "invalid_encoding",
    retryable: false,
  },
  "skills.empty_content": {
    expected: "non-empty SKILL.md body after parsing the frontmatter",
    hint:
      "The skill file parsed successfully but has no body content after the YAML frontmatter. Add at least one prose paragraph after the `---` block; that's the actual skill instructions the agent will read.",
    skillAnchor: "skills#shape",
    legacyErrorCode: "empty_content",
    retryable: false,
  },
  "skills.invalid_name": {
    expected: "skill name matching `[a-z0-9][a-z0-9-]*` (kebab-case)",
    hint:
      "Skill slugs are restricted to lowercase letters, digits, and hyphens (no underscores, dots, or uppercase). The first character must not be a hyphen. Pick a kebab-case slug such as `my-skill` or `obsidian-graduate-v2`.",
    skillAnchor: "skills#naming",
    legacyErrorCode: "invalid_name",
    retryable: false,
  },
  "skills.invalid_description": {
    expected: "single-line description field (no \\r or \\n)",
    hint:
      "Frontmatter description must be one line. Embedded newlines break the regex-based parser the daemon uses to update skills. Re-write the description as a single sentence; long prose goes in the body.",
    skillAnchor: "skills#frontmatter",
    legacyErrorCode: "invalid_description",
    retryable: false,
  },
  "skills.validation_error": {
    expected: "JSON body matching skillCreateSchema / skillUpdateSchema",
    hint:
      "Zod validation failed. The `details` array carries per-field paths — fix and resubmit. POST /skills needs `{ name, description, content, allowedTools? }`; PUT /skills/:name accepts a partial { description?, content?, allowedTools? }.",
    skillAnchor: "skills#schemas",
    legacyErrorCode: "validation_error",
  },
  "skills.not_found": {
    expected: "an existing skill at agent-assets/skills/<slug>/SKILL.md (built-in) or user-skills/<slug>/SKILL.md",
    hint:
      "GET /skills to list current slugs. Built-ins are read-only; user skills can be created via POST /skills or POST /skills/upload. Do not retry the same slug — verify spelling first.",
    skillAnchor: "skills#crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "skills.already_exists": {
    expected: "skill slug not yet present in user-skills/",
    hint:
      "A user skill with this slug already exists. Either PUT /skills/:name to update it, or DELETE /skills/:name first if you want a fresh create. POST /skills/upload overwrites by default.",
    skillAnchor: "skills#crud",
    legacyErrorCode: "already_exists",
    retryable: false,
  },
  "skills.write_failed": {
    expected: "successful disk write to the user-skills directory",
    hint:
      "Internal write error — the user-skills directory may be on a read-only mount or out of space. `message` carries the verbatim cause. Do not auto-retry; surface to the user.",
    skillAnchor: "skills#errors",
    legacyErrorCode: "write_failed",
    retryable: false,
  },
  "skills.delete_failed": {
    expected: "successful rmSync on the user-skills/<slug>/ directory",
    hint:
      "Internal delete error — `message` carries the verbatim cause. Common: file locked by an editor, permission denied. Do not auto-retry; surface to the user.",
    skillAnchor: "skills#errors",
    legacyErrorCode: "delete_failed",
    retryable: false,
  },

  // ── /api/managed-tasks/* — recurring management commitments
  //    (`management.md` ↔ `managed_tasks` ↔ `recurring_schedules`).
  //    Agent-callable via the management skill. Codes mirror existing
  //    pre-envelope error strings so the dashboard's history card and
  //    activity-view tests keep matching.
  "managed_tasks.invalid_id": {
    expected: "managed-task id matching `mt_<n>` (alphanumeric)",
    hint:
      "Managed-task ids are `mt_<n>` (e.g. `mt_1`, `mt_42`). GET /api/managed-tasks to list current ids. Pass the id verbatim — do NOT URL-encode the underscore.",
    skillAnchor: "managed-tasks#id-format",
    legacyErrorCode: "invalid_id",
    retryable: false,
  },
  "managed_tasks.not_found": {
    expected: "an existing managed_tasks row matching :id",
    hint:
      "Either the id is wrong or the row was already deleted (DELETE /api/managed-tasks/:id). GET /api/managed-tasks to list current rows. Stopped rows are pruned — `mt_<n>` is not reused; pick a different id rather than re-creating with the same one.",
    skillAnchor: "managed-tasks#crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "managed_tasks.validation_error": {
    expected: "JSON body matching managedTaskCreate/Patch/RunResult schema",
    hint:
      "Zod validation failed. `details` carries per-field issues. Common: cadence must match `daily|weekly|monthly|<RRULE>`; intent must be a non-empty string; recurrenceRule must include freq + interval. Read each `path`/`message` and resubmit.",
    skillAnchor: "managed-tasks#schemas",
    legacyErrorCode: "validation_error",
  },
  "managed_tasks.invalid_limit": {
    expected: "positive integer <= 200 in the `limit` query parameter",
    hint:
      "`?limit=` accepts an integer between 1 and 200. Pass `?limit=50` for the default page size; values above 200 are rejected to keep `agent_actions` scans bounded. URL-encoded or decimal values are rejected.",
    skillAnchor: "managed-tasks#pagination",
    legacyErrorCode: "invalid_limit",
    constraint: { type: "integer", minimum: 1, maximum: 200 },
  },
  "managed_tasks.invalid_cursor": {
    expected: "positive integer in the `before_id` query parameter",
    hint:
      "Pagination cursor is the smallest id in the previous page (returned as `nextCursor`). Pass it verbatim — URL-encoded and decimal values are rejected. Omit the parameter for the first page.",
    skillAnchor: "managed-tasks#pagination",
    legacyErrorCode: "invalid_cursor",
    constraint: { type: "integer", minimum: 1 },
  },
  "managed_tasks.cap_reached": {
    expected: "active managed-tasks count below the configured cap",
    hint:
      "The active-tasks cap (default 20; configured via `managedTasksMaxActive` in /settings) is hit. Either DELETE one before registering a new task, or raise the cap via /settings → Management. Surface to the user; the cap is intentional.",
    skillAnchor: "managed-tasks#capacity",
    legacyErrorCode: "cap_reached",
    retryable: false,
  },
  "managed_tasks.duplicate": {
    expected: "no managed_tasks row with the same (app_normalized, cadence) pair",
    hint:
      "A managed task already covers this (app, cadence) — the response's `item` carries the existing row. To replace it, DELETE the existing id first. To extend it (e.g. change cadence), PATCH /api/managed-tasks/:id on the existing row.",
    skillAnchor: "managed-tasks#duplicate-handling",
    legacyErrorCode: "duplicate",
    retryable: false,
  },
  "managed_tasks.internal_error": {
    expected: "no unexpected exception inside the transaction",
    hint:
      "Internal error inside a managed-tasks CRUD/run-now/rename-app/run-result transaction. The error is logged server-side; the route does not surface implementation detail. Do not auto-retry — typically a schema/migration drift.",
    skillAnchor: "managed-tasks#errors",
    legacyErrorCode: "internal_error",
    retryable: false,
  },

  // ── /api/apple-calendar/* — iCloud CalDAV provider sibling of
  //    /api/calendar/* (Google). Use this branch when management.md's
  //    SOT for schedule is `apple_calendar`; do NOT cross-call /api/calendar/*.
  "apple_calendar.not_configured": {
    expected: "Apple Calendar credentials saved + service initialised",
    hint:
      "Apple Calendar is unavailable — either no credentials are saved (POST /apple-calendar/credentials with `{ email, appPassword }`) or the cached service rejected the iCloud handshake. Notify the user to add an app-specific password from https://appleid.apple.com → App-Specific Passwords. Skip Apple Calendar branches of routines until reconfigured.",
    skillAnchor: "apple-calendar#configuration",
    legacyErrorCode: "apple_calendar_not_configured",
    retryable: false,
  },
  "apple_calendar.auth_failed": {
    expected: "iCloud CalDAV accepts the Apple ID + app-specific password",
    hint:
      "Apple ID auth failed. Common causes: regular password used instead of an app-specific one; password was revoked from appleid.apple.com; account requires reauth after iCloud security update. Re-issue an app-specific password and POST /apple-calendar/credentials again — there's no silent recovery.",
    skillAnchor: "apple-calendar#auth",
    legacyErrorCode: "auth_failed",
    retryable: false,
  },
  "apple_calendar.validation_error": {
    expected: "request body matching the Apple Calendar schema",
    hint:
      "Zod validation failed (`.strict()`) — Apple Calendar deliberately rejects Google-shaped extras like `attendees`, `reminders`, `recurrence`, `visibility`. Drop those fields. The `details` array carries per-field paths. iCloud event create body: `{ summary, start, end, description?, location? }`.",
    skillAnchor: "apple-calendar#event-shape",
    legacyErrorCode: "validation_error",
  },
  "apple_calendar.invalid_date": {
    expected: "'today' or YYYY-MM-DD `date` query parameter",
    hint:
      "The `?date=` query rejects shapes other than the literal 'today' or a calendar date like '2026-05-15'. Use localDateStr(now, <timezone>) shape — RFC-3339 timestamps are rejected.",
    skillAnchor: "apple-calendar#list-events",
    constraint: { type: "string", pattern: "^(today|\\d{4}-\\d{2}-\\d{2})$" },
  },
  "apple_calendar.not_found": {
    expected: "an existing iCloud event matching :id",
    hint:
      "The event id does not resolve to any iCloud event. Recurring-instance ids cannot be modified directly (use the master event id). Re-list with GET /apple-calendar/events?date=<day> to find the master id.",
    skillAnchor: "apple-calendar#event-id",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "apple_calendar.recurring_instance_unsupported": {
    expected: "master event id (not a per-instance recurrence override)",
    hint:
      "iCloud CalDAV cannot mutate single instances of a recurring event in this build. Either edit the master (changes apply to the whole series) or skip the modification and notify the user. The `message` field carries the offending instance id verbatim.",
    skillAnchor: "apple-calendar#recurring",
    legacyErrorCode: "recurring_instance_unsupported",
    retryable: false,
  },
  "apple_calendar.upstream_error": {
    expected: "successful iCloud CalDAV round-trip",
    hint:
      "iCloud CalDAV returned an error (surfaced as 502 to the agent). `message` is iCloud's verbatim text. Branches: 5xx → Apple maintenance window or transient; retry once after 60s, then skip. 401 → app-specific password revoked or expired; notify the user with this exact prompt: 'Apple Calendar access expired — please go to https://appleid.apple.com → App-Specific Passwords, issue a new password, and paste it into /settings/integrations → Apple Calendar.' Then skip. 412 → etag mismatch from concurrent edit; GET the event again to refresh the etag and replay the change ONCE. Do NOT chain more than one retry per error code in a single turn.",
    skillAnchor: "apple-calendar#errors",
    legacyErrorCode: "apple_calendar_error",
    retryable: true,
  },

  // ── /api/agent/*, /api/schedule (legacy), /api/schedule/dm, /api/notify,
  //    /api/agent/regenerate, /api/action/log — leftover agent-route codes
  //    that pre-date the schedule.* batch envelope. Still agent-callable
  //    from skills (manual schedule edits, run-now, regenerate).
  "agent.daemon_starting": {
    expected: "daemon startup complete",
    hint:
      "Daemon still initialising (typical window: 1-3 s after process spawn). Wait ~3s and retry ONCE; if the second attempt also returns daemon_starting, abandon this turn — startup that takes >30s indicates a stuck migration or a port conflict the agent cannot resolve. Surface ONE notification suggesting `aitne status` / `aitne doctor`, then exit. Never tight-loop on this code.",
    skillAnchor: "agent#startup-gate",
    legacyErrorCode: "daemon_starting",
    retryable: true,
  },
  "agent.hourly_check_unavailable": {
    expected: "triggerHourlyCheck wired into the API server",
    hint:
      "POST /agent/run-now/hourly was called before the hourly-check engine was wired (typically only the first ~1s of boot). Wait ~3s and retry.",
    skillAnchor: "agent#run-now",
    legacyErrorCode: "hourly_check_unavailable",
    retryable: true,
  },
  "agent.roadmap_maintenance_unavailable": {
    expected: "triggerRoadmapMaintenance wired into the API server",
    hint:
      "Roadmap maintenance dispatcher not yet wired. Wait ~3s and retry; this fires only during boot.",
    skillAnchor: "agent#roadmap-maintenance",
    legacyErrorCode: "roadmap_maintenance_unavailable",
    retryable: true,
  },
  "agent.roadmap_maintenance_failed": {
    expected: "successful roadmap maintenance pass",
    hint:
      "Maintenance threw mid-pass; `message` carries the underlying error. Common: roadmap.md lock contention, schema drift, or malformed roadmap row. Do not auto-retry — inspect daemon logs.",
    skillAnchor: "agent#roadmap-maintenance",
    legacyErrorCode: "roadmap_maintenance_failed",
    retryable: false,
  },
  "agent.invalid_requested_model": {
    expected: "'sonnet' | 'opus' | omitted",
    hint:
      "`requestedModel` accepts the alias 'sonnet' or 'opus'. Omit to let process_backend_config decide; pin 'opus' for high-complexity multi-file analysis.",
    skillAnchor: "agent#requestedModel",
    legacyErrorCode: "invalid_requestedModel",
    constraint: { type: "enum", enum: ["sonnet", "opus"] },
  },
  "agent.notify_validation_error": {
    expected: "request body matching notifyRequestSchema",
    hint:
      "Body failed Zod validation. `details` carries per-field paths. Required: `message` (string). Optional: `platform`/`platforms`, `priority` ('critical'|'high'|'normal'|'low').",
    skillAnchor: "agent#notify",
    legacyErrorCode: "validation_error",
  },
  "agent.schedule_dm_validation_error": {
    expected: "request body matching scheduleDmRequestSchema",
    hint:
      "POST /schedule/dm body shape: `{ time: ISO8601, message: string, platform?, platforms?, importance? }`. `details` lists per-field paths. Use POST /api/schedule (batch) for LLM runs — /schedule/dm is the no-LLM precomposed-DM path.",
    skillAnchor: "schedule#dm-shape",
    legacyErrorCode: "validation_error",
  },
  "agent.invalid_time": {
    expected: "ISO8601 string parseable by Date() and >= now - 60s",
    hint:
      "`time` failed Date.parse() or was more than 1 minute in the past. `details` disambiguates which check failed. Use `2026-05-15T14:30:00-04:00` shape with explicit timezone offset.",
    skillAnchor: "schedule#scheduledFor-bounds",
    legacyErrorCode: "invalid_time",
    constraint: { type: "iso8601", required: true },
  },
  "agent.invalid_status": {
    expected: "comma-separated subset of 'pending,running,completed,failed,skipped'",
    hint:
      "GET /schedule `?status=` accepts a CSV of the five statuses. `details` names the offending token. Default is 'pending,running'; pass 'completed,failed,skipped' to see history.",
    skillAnchor: "schedule#status-filter",
    legacyErrorCode: "invalid_status",
  },
  "agent.invalid_id": {
    expected: "positive integer id from GET /schedule",
    hint:
      "`:id` must be a positive integer. GET /schedule for current pending ids. URL-encoded and decimal ids are rejected.",
    skillAnchor: "schedule#crud",
    legacyErrorCode: "invalid_id",
    constraint: { type: "integer", minimum: 1 },
  },
  "agent.not_found": {
    expected: "an existing agent_schedule row matching :id",
    hint:
      "PATCH/DELETE on a schedule id that doesn't exist. The row may have been picked up by the scheduler (status moved to running) or already cancelled. GET /schedule for current ids.",
    skillAnchor: "schedule#crud",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "agent.schedule_conflict": {
    expected: "row in 'pending' status (running/completed/failed are immutable)",
    hint:
      "Edits and cancels only work on `pending` schedules. `details` carries the row's current status. Per-state recovery: 'running' → the scheduler has already picked the row up; cannot cancel mid-flight (the running session must finish). If you want a different action, POST /api/schedule with a NEW row scheduled for a later time. 'completed' / 'failed' / 'skipped' → terminal, the row is archive-only; do not retry — its outcome is final. If the conflict was for a cancel intent the user really needs to honour, send them a notification with the schedule id and current status rather than looping.",
    skillAnchor: "schedule#crud",
    legacyErrorCode: "conflict",
    retryable: false,
  },
  "agent.invalid_field": {
    expected: "field set respecting the task_type contract",
    hint:
      "PATCH /schedule/:id field/task_type mismatch — `details` names the offending field. Matrix: task_type='wake' or 'dm_session' or 'check' → set `description` and optionally `prompt`, NOT `message`. task_type='dm' (precomposed) → set `message`, NOT `description` and NOT `prompt` (dm rows do not run a model, so prompt would be ignored and is rejected). `time` and `taskContext` are accepted on all types; `model` is accepted on 'wake'/'dm_session'/'check' but ignored on 'dm'. To switch a row's shape, DELETE and re-create rather than PATCH across the dm boundary.",
    skillAnchor: "schedule#field-by-type",
    legacyErrorCode: "invalid_field",
    retryable: false,
  },
  "agent.no_changes": {
    expected: "PATCH body containing at least one mutable field",
    hint:
      "PATCH /schedule/:id needs at least one of { time, description, message, prompt, model, taskContext }. Omitting all is rejected.",
    skillAnchor: "schedule#crud",
    legacyErrorCode: "no_changes",
    retryable: false,
  },
  "agent.invalid_target": {
    expected: "target = 'today' | 'roadmap'",
    hint:
      "POST /agent/regenerate body needs `{ target: 'today' | 'roadmap' }`. Other values rejected. 'today' refreshes today.md via routine.today_refresh; 'roadmap' refreshes roadmap.md.",
    skillAnchor: "agent#regenerate",
    constraint: { type: "enum", enum: ["today", "roadmap"] },
  },
  "agent.roadmap_refresh_unavailable": {
    expected: "triggerRoadmapRefresh wired into the API server",
    hint:
      "Roadmap refresh dispatcher not currently wired (boot-time only). Wait ~3s and retry; if persistent, surface to user — daemon is in degraded mode.",
    skillAnchor: "agent#regenerate",
    retryable: true,
  },
  "agent.event_bus_unavailable": {
    expected: "EventBus wired into the API server",
    hint:
      "EventBus unavailable, so today.md regeneration cannot be dispatched. Wait ~3s and retry; if persistent, run `aitne status`.",
    skillAnchor: "agent#regenerate",
    retryable: true,
  },
  "agent.action_log_validation_error": {
    expected: "request body matching actionLogRequestSchema",
    hint:
      "Body failed Zod validation. `details` carries per-field paths. Required: `actionType` (string), `result` (string). Use `<resource>.<verb>` shape for actionType (e.g. `mail.archive`).",
    skillAnchor: "agent#action-log",
    legacyErrorCode: "validation_error",
  },

  // ── /api/profile-questions/* — slot-filled probe for the interview queue.
  //    Read-only helper used by the profile-interview skill to ask "is this
  //    slot already populated in user/profile.md?" before generating a
  //    follow-up question. Bare codes prior to this entry left the agent
  //    looping with no clue what shape the path was supposed to take.
  "profile_questions.path_required": {
    expected: "non-empty 'path' query parameter (context-relative)",
    hint:
      "GET /api/profile-questions/slot-filled needs `?path=<relative>` — e.g. `?path=identity/profile`. Trailing `.md` is optional; `.base` files are rejected (use a prose markdown file). Add `&section=<heading>` to scope to one heading and `&anchor=<bullet-key>` to scope to one bullet.",
    skillAnchor: "profile-questions#slot-filled",
    legacyErrorCode: "missing_path",
    constraint: { type: "string", required: true },
  },
  "profile_questions.path_invalid": {
    expected: "context-relative path inside the vault (no '..', no absolute)",
    hint:
      "The path failed traversal validation. Use forward-slash, vault-relative paths only — e.g. `identity/profile`, `identity/people/colleague-jane`. Reject `..` segments, absolute paths, and `.base` files (those are Obsidian view configs, not prose).",
    skillAnchor: "profile-questions#slot-filled",
    legacyErrorCode: "invalid_path",
    constraint: { type: "string" },
    retryable: true,
  },
  "profile_questions.read_failed": {
    expected: "readable file at the resolved path",
    hint:
      "Filesystem read failed mid-probe (EACCES / EIO). The file exists but the daemon couldn't open it. Likely cause: vault was moved or permissions changed while the daemon was running. Re-check the externalObsidianVaultPath config and retry; if persistent, surface to user — daemon needs vault access.",
    skillAnchor: "profile-questions#slot-filled",
    legacyErrorCode: "read_failed",
    retryable: false,
  },

  // ── /api/entities/* — entity registry lookup (tier-1 + tier-2 queries).
  //    Existing `validation_error` / `missing_query` / `ambiguous_query`
  //    paths carry a `message` field already; this registers them so they
  //    flow through the envelope with retryable + hint metadata.
  "entities.missing_query": {
    expected: "either tier-1 (source[, external_id]) or tier-2 (domain, type, date) query parameters",
    hint:
      "GET /api/entities needs a query shape. Tier-1 exact: `?source=<app>&external_id=<eid>`. Tier-1 bias: `?source=<app>` alone (list all entities for the source so you can pick a dominant domain/type). Tier-2: `?domain=<domain>&type=<singular>&date=YYYY-MM-DD`. Don't mix tiers in one call.",
    skillAnchor: "entities#query-shape",
    legacyErrorCode: "missing_query",
    retryable: true,
  },
  "entities.ambiguous_query": {
    expected: "exactly one tier — not both at the same time",
    hint:
      "The request mixed tier-1 (source/external_id) and tier-2 (domain/type/date) parameters. Drop one set: tier-1 is for known external ids (e.g. gmail thread id), tier-2 is for discovery by category. Pick the side that matches your input.",
    skillAnchor: "entities#query-shape",
    legacyErrorCode: "ambiguous_query",
    retryable: true,
  },
  "entities.validation_error": {
    expected: "well-formed query per the tier rules",
    hint:
      "A field violated its constraint. Common causes: `external_id` set without `source` (tier-1 needs both for exact match); tier-2 missing one of domain/type/date; `date` not ISO YYYY-MM-DD; `limit` not a positive integer; unknown `domain` / `type` enum value. The `message` field carries the specific violation — read it verbatim and fix that field only.",
    skillAnchor: "entities#query-shape",
    legacyErrorCode: "validation_error",
    retryable: true,
  },
  "entities.not_found": {
    expected: "an entity row matching the supplied path",
    hint:
      "GET /api/entities/by-path?path=<...> returned no row. The path is a vault-relative markdown path (e.g. `work/meetings/2026-05-15-launch-review.md`). Check the slug spelling, or use GET /api/entities?source=<app> to discover the canonical path the registrar wrote.",
    skillAnchor: "entities#by-path",
    legacyErrorCode: "not_found",
    retryable: false,
  },

  // ── /api/sot-bindings/* — SoT (Source-of-Truth) bindings list
  //    (rules/management.md §A). The PUT replaces the entire list.
  "sot_bindings.invalid_category": {
    expected: "non-empty category slug in the URL",
    hint:
      "GET /api/sot-bindings/:category needs a trimmed category like `email`, `calendar`, `task`. Empty strings (e.g. `/sot-bindings/%20`) are rejected. List all categories first via GET /api/sot-bindings.",
    skillAnchor: "sot-bindings#categories",
    legacyErrorCode: "invalid_category",
    retryable: true,
  },
  "sot_bindings.not_found": {
    expected: "an existing binding row for the supplied category",
    hint:
      "The category has no binding registered yet. Use GET /api/sot-bindings to enumerate the live rows, or PUT /api/sot-bindings to install a new binding (body shape: an array or `{items: [...]}`).",
    skillAnchor: "sot-bindings#categories",
    legacyErrorCode: "not_found",
    retryable: false,
  },
  "sot_bindings.validation_error": {
    expected: "array of binding rows, or `{items: [...]}`",
    hint:
      "PUT body must be a JSON array or `{items: [{category, source, ...}]}`. Each row needs `category` (string) and at least one source descriptor. Duplicates by category are rejected as defense-in-depth — the file render is keyed on category position and silent overwrites would corrupt the user's mental model. Read `details`/`message` for the exact field that failed.",
    skillAnchor: "sot-bindings#put-shape",
    legacyErrorCode: "validation_error",
    constraint: { type: "array", required: true },
    retryable: true,
  },
  "sot_bindings.duplicate_category": {
    expected: "at most one row per category in the PUT body",
    hint:
      "Two or more rows shared the same `category` value. De-dupe in the caller — pick the row you want (most specific) and drop the rest. The duplicate's category value is carried on the response as `category` for log triage.",
    skillAnchor: "sot-bindings#put-shape",
    legacyErrorCode: "duplicate_category",
    retryable: true,
  },
  "sot_bindings.internal_error": {
    expected: "successful DB write",
    hint:
      "The SoT-bindings table write failed at the SQLite layer (disk full, lock contention, or corruption). Retry once; if persistent, run `aitne doctor` to verify the DB and surface to user.",
    skillAnchor: "sot-bindings#put-shape",
    legacyErrorCode: "internal_error",
    retryable: true,
  },

  // ── /api/docs/* — docs corpus search + Q&A bus. The Q&A path is dashboard-
  //    facing but `/docs/by-slug/:slug` is agent-callable for the docs-ask
  //    skill (when the agent is composing answers from indexed prose).
  "docs.doc_not_found": {
    expected: "an existing doc with the supplied slug in fts_docs",
    hint:
      "No doc indexed under `slug`. Slugs come from doc frontmatter and look like `appendices/voice-transcription` or `design/02-event-pipeline`. Search first via GET /api/docs/search?q=<term> to find the canonical slug, or GET /api/docs to list everything.",
    skillAnchor: "docs#by-slug",
    legacyErrorCode: "doc_not_found",
    retryable: false,
  },
  "docs.qa_adapter_unavailable": {
    expected: "DocsQAAdapter wired into the API server",
    hint:
      "The docs-QA bus is not initialized in this daemon instance. Most likely an in-test boot or a degraded startup; the dashboard's QA panel cannot operate. Wait a few seconds and retry; if persistent, run `aitne status` and re-launch the daemon.",
    skillAnchor: "docs#qa-bus",
    legacyErrorCode: "qa_adapter_unavailable",
    retryable: true,
  },
  "docs.channel_not_connected": {
    expected: "channelId minted by GET /docs/qa/stream and still open",
    hint:
      "POST /docs/qa/messages was called with a channelId the adapter does not recognise. The channel must be minted by the SSE stream's first event (D5 SSE-first contract). Open GET /docs/qa/stream first, capture the channelId, then POST messages against it. The channel auto-closes when the SSE EventSource disconnects.",
    skillAnchor: "docs#qa-channel",
    legacyErrorCode: "channel_not_connected",
    retryable: false,
  },
  "docs.validation_error": {
    expected: "request body matching qaMessageSchema (channelId, content, scope, …)",
    hint:
      "QA message body failed Zod validation. Required fields: `channelId` (UUID from the SSE stream), `content` (non-empty string). Optional: `scope`, `context`, `modelId`. Read `details` for the per-field path.",
    skillAnchor: "docs#qa-message-shape",
    legacyErrorCode: "validation_error",
    constraint: { type: "object", required: true },
    retryable: true,
  },
  "docs.model_not_registered": {
    expected: "modelId registered for the active QA backend",
    hint:
      "The picker-supplied `modelId` is not in the registered list for the resolved QA backend. Drop the `modelId` field (the daemon picks the canonical medium-tier model), or pick a registered id from GET /api/docs/qa/config.",
    skillAnchor: "docs#qa-model-pick",
    legacyErrorCode: "model_not_registered",
    retryable: true,
  },
  "docs.model_tier_locked": {
    expected: "modelId at the medium tier (not lite, not high)",
    hint:
      "The QA path is hard-wired to the medium tier to avoid silently draining Opus quota. The supplied `modelId` is registered but at the wrong tier. Pick a medium-tier model from GET /api/docs/qa/config or drop the field entirely.",
    skillAnchor: "docs#qa-model-pick",
    legacyErrorCode: "model_tier_locked",
    retryable: true,
  },

  // ── /api/git/templates/* — project-doc template editor + per-file
  //    re-template reporter (Decision 8). The reporter is called by an
  //    autonomous task flow, so good hints here directly shorten the
  //    re-template loop.
  "git_templates.invalid_kind": {
    expected: "'project' or 'git-repo' in the :kind URL segment",
    hint:
      "The `:kind` segment must be exactly `project` (full project doc template) or `git-repo` (repo-only doc template). Other values (e.g. `repo`, `Git-Repo`) are rejected — these are the only two on-disk templates the daemon ships.",
    skillAnchor: "git-templates#kinds",
    legacyErrorCode: "invalid_kind",
    constraint: { type: "enum", enum: ["project", "git-repo"], required: true },
    retryable: true,
  },
  "git_templates.content_required": {
    expected: "string body at `content` (the template markdown source)",
    hint:
      "PUT /api/git/templates/:kind needs `{ \"content\": \"# Template…\\n…\" }`. The value must be a string — sending a number, array, or omitting the key returns 400. Read the active body first via GET /api/git/templates/:kind to seed your edit.",
    skillAnchor: "git-templates#editor",
    legacyErrorCode: "content_required",
    constraint: { type: "string", required: true },
    retryable: true,
  },
  "git_templates.read_failed": {
    expected: "readable template file (or absent override = bundled fallback)",
    hint:
      "Filesystem read of the template override failed (EACCES / EIO). The bundled template is still usable — drop the override file or PUT a fresh body. `message` carries the underlying fs error verbatim.",
    skillAnchor: "git-templates#editor",
    legacyErrorCode: "read_failed",
    retryable: true,
  },
  "git_templates.write_failed": {
    expected: "successful write to the override path",
    hint:
      "Failed to write the template override (disk full, permissions, or path collision). Verify dataDir is writable (`aitne doctor`), then retry. `message` carries the underlying fs error.",
    skillAnchor: "git-templates#editor",
    legacyErrorCode: "write_failed",
    retryable: true,
  },
  "git_templates.body_too_large": {
    expected: "template body ≤ 64 KB",
    hint:
      "Template payload exceeded the 64 KB cap. Trim boilerplate, or split into two template kinds. Skill / agent-profile prose belongs in agent-assets/ — only the rendered project doc template lives here.",
    skillAnchor: "git-templates#editor",
    legacyErrorCode: "body_too_large",
    retryable: false,
  },
  "git_templates.in_progress": {
    expected: "no in-flight retemplate run",
    hint:
      "A retemplate run is already scheduled / executing (409). Wait for the existing run to finish, or check status via GET /api/git/templates/retemplate/status. The response carries `scheduleId` and `correlationId` for the in-flight run so the dashboard can render 'already running' state.",
    skillAnchor: "git-templates#apply",
    legacyErrorCode: "in_progress",
    retryable: true,
  },
  "git_templates.missing_template": {
    expected: "template file present for the supplied kind",
    hint:
      "The retemplate apply call cannot proceed because the template file isn't readable yet (no override AND the bundled fallback is missing — possibly a corrupt install). Run `aitne doctor` or reinstall. The `kind` field on the response identifies which template was missing.",
    skillAnchor: "git-templates#apply",
    legacyErrorCode: "missing_template",
    retryable: false,
  },
  "git_templates.no_targets": {
    expected: "at least one watched git repository for the apply call",
    hint:
      "No git repositories are registered for the retemplate scope (422). Add a watched repo via POST /api/repositories first, or pick a different kind. GET /api/repositories?filter=git lists the live set.",
    skillAnchor: "git-templates#apply",
    legacyErrorCode: "no_targets",
    retryable: false,
  },
  "git_templates.invalid_slug": {
    expected: "lowercase kebab-case slug ([a-z0-9]([a-z0-9-]*[a-z0-9])?)",
    hint:
      "POST /api/git/templates/retemplate/file body needs `slug` matching `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (or a single `[a-z0-9]` char). Underscores, uppercase, and leading/trailing hyphens are rejected. Slugs come from the apply call's `targets[].slug` — echo that value verbatim.",
    skillAnchor: "git-templates#per-file-report",
    legacyErrorCode: "invalid_slug",
    constraint: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$", required: true },
    retryable: true,
  },
  "git_templates.invalid_status": {
    expected: "one of 'started' | 'completed' | 'skipped' | 'failed'",
    hint:
      "Per-file `status` must be exactly one of the four lifecycle values. `started` is a work-begin marker (no audit row). `completed`/`skipped`/`failed` are terminal — each emits one `agent_actions` row tagged `git.project.retemplate`. Don't invent intermediate states.",
    skillAnchor: "git-templates#per-file-report",
    legacyErrorCode: "invalid_status",
    constraint: { type: "enum", enum: ["started", "completed", "skipped", "failed"], required: true },
    retryable: true,
  },
  "git_templates.no_active_run": {
    expected: "an active retemplate run before posting per-file status",
    hint:
      "No retemplate run is in flight; per-file reports are only accepted while the parent run holds its slot in `runtime_state` (409). The apply call (POST /api/git/templates/:kind/apply) must succeed first and seed the status grid.",
    skillAnchor: "git-templates#per-file-report",
    legacyErrorCode: "no_active_run",
    retryable: false,
  },
  "git_templates.correlation_mismatch": {
    expected: "correlationId matching the in-flight retemplate run",
    hint:
      "The supplied `correlationId` does not match the active run's id (409). Another retemplate run started between your apply and this report. Re-read GET /api/git/templates/retemplate/status to confirm the live run's id, then echo that value in subsequent reports.",
    skillAnchor: "git-templates#per-file-report",
    legacyErrorCode: "correlation_mismatch",
    retryable: false,
  },
  "git_templates.slug_not_in_run": {
    expected: "slug present in the active run's target list",
    hint:
      "The supplied `slug` is not one of the active run's targets (404). Slugs are pinned at apply time — adding a new target mid-run is not supported. Re-check the slug spelling against the apply response's `targets[].slug` array.",
    skillAnchor: "git-templates#per-file-report",
    legacyErrorCode: "slug_not_in_run",
    retryable: false,
  },

  // ── /api/integrations/* — integration mode CRUD + delegated /exec.
  //    Most error paths already carry rich structured fields (key, mode,
  //    supportedModes, …). These entries register the bare 404/500 paths
  //    plus the /exec invalid_json_body that an agent retry could fix.
  "integrations.unknown_integration": {
    expected: "integration key registered in the daemon (e.g. gmail, google_calendar, notion)",
    hint:
      "The `:key` URL segment is not a registered integration. Get the live list from GET /api/integrations (returns every key the daemon knows about, with mode + backend). Keys are case-sensitive snake_case: `gmail`, `google_calendar`, `outlook_mail`, `outlook_calendar`, `notion` — not `Gmail` / `outlook-mail`.",
    skillAnchor: "integrations#keys",
    legacyErrorCode: "unknown_integration",
    retryable: false,
  },
  "integrations.invalid_json_body": {
    expected: "valid JSON object body (parse-able)",
    hint:
      "POST /api/integrations/:key/probe expects either `null`/empty (= cached read), or `{ backend?, tools?, liveProbe? }`. Parse-level failure means the body wasn't valid JSON at all — check Content-Type: application/json and that no trailing commas / unquoted keys snuck in.",
    skillAnchor: "integrations#probe",
    legacyErrorCode: "invalid_json_body",
    constraint: { type: "json", required: true },
    retryable: true,
  },
  "integrations.invalid_limit": {
    expected: "positive integer (default 50, max 200)",
    hint:
      "`?limit=` must parse as an integer ≥ 1. Anything else falls back to 50, but a non-numeric value returns 400. The hard cap is 200 — larger values are silently clamped, smaller positive ints honoured.",
    skillAnchor: "integrations#recent-proxy-calls",
    legacyErrorCode: "invalid_limit",
    constraint: { type: "integer", minimum: 1, maximum: 200 },
    retryable: true,
  },
  "integrations.internal_error": {
    expected: "successful integration state update / probe persistence",
    hint:
      "Server-side failure during integration mode change or probe persistence. Typical causes: a `runtime_state.integration_flip_lock:<key>` left by a crashed flip blocks the next change (resolves after the lock TTL expires, ~60s); descriptor vs DB-row drift (an integration was removed from `packages/shared/src/integrations.ts` but a `direct` row still exists); SQLite write contention during a long-running migration. Retry ONCE after 5s. If still failing, do not loop — stop touching this integration's mode/probe this turn, surface ONE notification quoting the response's `message`, and proceed with other work. The flip lock alone does not block read endpoints, so observation consumption can continue.",
    skillAnchor: "integrations#internal-errors",
    legacyErrorCode: "internal_error",
    retryable: true,
  },
} as const satisfies Record<string, AgentErrorRegistryEntry>;

export type AgentErrorCode = keyof typeof AGENT_ERROR_REGISTRY;

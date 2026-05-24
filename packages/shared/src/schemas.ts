import { z } from "zod";

const notificationPlatformSchema = z.enum([
  "slack",
  "telegram",
  "discord",
  "whatsapp",
]);

// ── Context File API ──

export const contextPutSchema = z.object({
  content: z.string(),
  /**
   * Optimistic-concurrency token. When provided, the server compares this
   * against the current file's mtime and returns 409 on mismatch. Agents
   * can omit it (backward compatible); the dashboard always sends it to
   * guard against lost updates.
   */
  expectedMtime: z.string().optional(),
});

/** Strict timestamp format used by SignalDetector. Lexicographic comparison
 *  only works when both sides use zero-padded YYYY-MM-DD HH:MM:SS. */
const CUTOFF_FORMAT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export const contextPatchSchema = z.object({
  /**
   * Target `## Section` to operate on. Required for all modes except
   * `append_to_file`, which appends to the end of the file without
   * targeting a section.
   */
  section: z.string().optional(),
  mode: z.enum(["append", "replace", "clear", "clear_before", "append_to_file"]),
  content: z.string().optional(),
  /**
   * For clear_before mode: remove entries whose `- [YYYY-MM-DD HH:MM:SS]`
   * timestamp is ≤ this value. Entries without a parseable timestamp or
   * with a timestamp > cutoff are preserved. This enables race-safe
   * consumption of timestamped sections like Raw Signals.
   */
  cutoff: z.string().optional(),
  /**
   * For append mode: after appending, if the section contains more than
   * maxEntries bullet lines (`- ...`), trim the oldest (topmost) to stay
   * within budget. Prevents unbounded section growth.
   */
  maxEntries: z.number().int().positive().optional(),
}).refine(
  (data) => data.mode === "append_to_file" || (data.section !== undefined && data.section.length > 0),
  { message: "section is required for all modes except append_to_file" },
).refine(
  (data) => data.mode === "append" || data.maxEntries === undefined,
  { message: "maxEntries is only valid with mode 'append'" },
).refine(
  (data) => data.mode === "clear_before" || data.cutoff === undefined,
  { message: "cutoff is only valid with mode 'clear_before'" },
).refine(
  (data) => data.mode !== "clear_before" || (data.cutoff !== undefined && CUTOFF_FORMAT_RE.test(data.cutoff)),
  { message: "clear_before requires cutoff in 'YYYY-MM-DD HH:MM:SS' format (zero-padded)" },
).refine(
  // Content-bearing modes must carry a defined string. An omitted `content`
  // silently writes an empty section — agents mis-formatting their PATCH
  // body (e.g. wrong field name) would clobber the section instead of
  // getting an actionable 400. Empty string IS allowed; callers that want
  // to wipe a section should still prefer `clear` for self-documenting
  // intent, but explicit `content: ""` is a legitimate replace.
  (data) =>
    !(data.mode === "append" || data.mode === "replace" || data.mode === "append_to_file")
    || typeof data.content === "string",
  {
    message: "content is required for modes 'append', 'replace', and 'append_to_file'",
    path: ["content"],
  },
);

// ── Agent Internal API ──

export const notifyRequestSchema = z.object({
  message: z.string(),
  platform: notificationPlatformSchema.optional(),
  platforms: z.array(notificationPlatformSchema).optional(),
  priority: z.enum(["critical", "high", "normal", "low"]).optional(),
}).refine(
  (data) => !(data.platform && data.platforms),
  { message: "Use either 'platform' or 'platforms', not both" },
);

export const scheduleRequestSchema = z.object({
  time: z.string(), // ISO8601
  taskType: z.string(),
  description: z
    .string()
    .min(
      20,
      "Description must be at least 20 characters. The wake-up agent has NO memory — the description is its only context.",
    ),
  // Optional override for the actual task body the agent receives. When set,
  // takes precedence over `description` as the `task` slot in the task-flow
  // template. When omitted, `description` doubles as both the user-facing
  // label and the agent body (preserves the long-standing skill API).
  prompt: z
    .string()
    .min(
      20,
      "Prompt must be at least 20 characters. The wake-up agent has NO memory — the prompt is its only context.",
    )
    .optional(),
  // Free-form model token. Accepts:
  //   - the legacy aliases "sonnet" / "opus" (rewritten to tier_override
  //     at the route),
  //   - any registered model id (e.g. "claude-opus-4-7", "gpt-5.4"),
  //   - the disambiguator form "<backendId>/<modelId>" when the same
  //     model id appears under multiple backends.
  // Route-level `validateModelToken` enforces the registry-backed check
  // and turns unknown / ambiguous / deprecated outcomes into
  // schedule.model_unknown / model_ambiguous / model_deprecated codes.
  // Schema-side validation stays at the syntactic length cap — the
  // registry list is dynamic, so a hard enum here would force a deploy
  // to add a new model id.
  // SCHEDULE_API_REDESIGN_PLAN §4.3.
  model: z.string().min(1).max(120).optional(),
  // Abstract tier override — the primary mechanism for pinning a
  // scheduled task to a cost tier. Default (omitted / null) lets the
  // dispatcher resolve via process-key (medium for agent.task). Use
  // `lite` for hourly polling / health checks and `high` for one-off
  // analysis. Mutually exclusive with `model` (per §4.3 — the route
  // emits schedule.tier_and_model_conflict when both are non-null).
  tier: z.enum(["lite", "medium", "high"]).optional(),
  taskContext: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Rich `taskContext` slot for `POST /api/schedule/batch`. Each row's
 * taskContext carries the *background* and *expected_output* a future
 * `scheduled.task` / `scheduled.dm` session needs to produce high-quality
 * output hours later — the daemon could never reconstruct these from the
 * user-facing `description` line alone.
 *
 * See docs/design/appendices/morning-routine-optimization.md §"POST
 * /api/schedule/batch" and §"Data-flow principle: prose vs structured".
 *
 * Required slots:
 * - `background`: why this task is being scheduled; what the future
 *   session needs to know upfront (>=30 chars).
 * - `expected_output`: what the future session should produce (DM shape,
 *   file written, check verdict; >=20 chars).
 *
 * Optional slots:
 * - `references`: stable handles the future session can look up
 *   (`projects/<slug>.md#section`, `calendar:event:<id>`, etc.)
 * - `tone`: free-form tone hint for DM-shaped output.
 * - `tier_override`: **legacy** override for the dispatcher's tier
 *   pick. Pre-dates the `agent_schedule.tier_override` column. The
 *   `/schedule/batch` and `/schedule` routes lift this value into
 *   the column at insert time when the top-level `tier` field is
 *   absent. Prefer the top-level `tier` field on new callers.
 * - `sub_flow`: branch the task-flow rendering when the dispatcher
 *   needs a specialised sub-flow (e.g. `morning_briefing`).
 */
export const scheduleBatchTaskContextSchema = z.object({
  background: z
    .string()
    .min(
      30,
      "taskContext.background must be at least 30 characters. The future session has NO live context — background is how it knows why it was scheduled.",
    ),
  expected_output: z
    .string()
    .min(
      20,
      "taskContext.expected_output must be at least 20 characters. The future session must know what 'done' looks like (DM shape, file written, check verdict).",
    ),
  references: z.array(z.string()).optional(),
  tone: z.string().optional(),
  tier_override: z.enum(["lite", "medium", "high"]).nullable().optional(),
  sub_flow: z.string().optional(),
}).catchall(z.unknown()); // permits ad-hoc keys like scheduledBy, prUrl, importance

export const scheduleBatchRowSchema = z.object({
  scheduledFor: z.string(), // ISO8601 — handler validates Date.parse + future-bound
  taskType: z.enum(["wake", "dm_session", "check", "dm"]),
  taskDescription: z
    .string()
    .min(
      20,
      "taskDescription must be at least 20 characters. The wake-up agent has NO memory — description is its only context.",
    ),
  taskContext: scheduleBatchTaskContextSchema,
  taskPrompt: z
    .string()
    .min(20, "taskPrompt must be at least 20 characters when set.")
    .optional(),
  correlationId: z.string().optional(),
  // See scheduleRequestSchema.model — free-form token validated at the
  // route. Nullable for batch rows so a caller can explicitly clear the
  // override on a row in a mixed batch. SCHEDULE_API_REDESIGN_PLAN §4.3.
  model: z.string().min(1).max(120).nullable().optional(),
  tier: z.enum(["lite", "medium", "high"]).nullable().optional(),
});

export const scheduleBatchRequestSchema = z.object({
  rows: z
    .array(scheduleBatchRowSchema)
    .max(50, "Batch capped at 50 rows. Split into chunks if you have more."),
  /**
   * `true` (default) wraps the inserts in one transaction so a single
   * bad row rolls back all inserts and the agent retries the full batch
   * after correction. `false` commits each successful row individually
   * and reports failures in `errors[]` — useful only in a degraded
   * retry path where partial progress is preferable to total failure.
   */
  atomic: z.boolean().optional(),
});

export const scheduleUpdateRequestSchema = z.object({
  time: z.string().optional(),
  description: z
    .string()
    .min(
      20,
      "Description must be at least 20 characters. The wake-up agent has NO memory — the description is its only context.",
    )
    .optional(),
  // Pass `null` to clear an override and fall back to `description`.
  prompt: z
    .union([
      z
        .string()
        .min(
          20,
          "Prompt must be at least 20 characters. The wake-up agent has NO memory — the prompt is its only context.",
        ),
      z.null(),
    ])
    .optional(),
  message: z.string().min(1).optional(), // for dm type only
  // PATCH form of `scheduleRequestSchema.model`. Pass a free-form token
  // (alias, registered id, or composite `<backend>/<model>`) to set the
  // pin, or `null` to clear it. SCHEDULE_API_REDESIGN_PLAN §4.3 — the
  // route's `validateModelToken` resolves the token and persists
  // `(model, backend_id)` atomically; PATCH-clearing one without the
  // other is not exposed because the two fields are coupled.
  model: z.union([z.string().min(1).max(120), z.null()]).optional(),
  // Pass `null` to clear the tier override and revert to the
  // dispatcher's process-key default; pass a concrete tier to pin.
  // Mutually exclusive with a non-null `model` (route enforces).
  tier: z.enum(["lite", "medium", "high"]).nullable().optional(),
  taskContext: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: "At least one field must be provided for update" },
).refine(
  (data) => !(data.description !== undefined && data.message !== undefined),
  { message: "Cannot set both 'description' and 'message'. Use 'description' for wake-up tasks, 'message' for dm." },
).refine(
  // dm rows do not run an agent, so a prompt override has nothing to
  // override. This catches the cross-type combo at validation time
  // (the route handler also rejects prompt on dm-type rows for the
  // single-field case where the row's task_type is the gate).
  (data) => !(data.prompt !== undefined && data.message !== undefined),
  { message: "Cannot set both 'prompt' and 'message'. 'prompt' is only valid for non-dm schedules." },
);

export const scheduleDmRequestSchema = z.object({
  time: z.string(), // ISO8601 with timezone
  message: z.string().min(1, "Message cannot be empty"),
  platform: notificationPlatformSchema.optional(), // temporary singular form
  platforms: z.array(notificationPlatformSchema).optional(),
  importance: z.enum(["transient", "normal", "strategic"]).optional(),
}).refine(
  (data) => !(data.platform && data.platforms),
  { message: "Use either 'platform' or 'platforms', not both" },
);

export const actionLogRequestSchema = z.object({
  actionType: z.string(),
  detail: z.string(),
  result: z.enum(["success", "failed", "partial", "skipped"]),
});

// ── User Skills API ──

/**
 * Skill slug constraints — kebab-case, 1-64 chars, safe for filesystem & URLs.
 * Explicitly rejects path traversal, whitespace, and uppercase to keep
 * filesystem semantics consistent across macOS (case-insensitive) and Linux.
 */
export const skillNameSchema = z
  .string()
  .min(1, "Skill name cannot be empty")
  .max(64, "Skill name must be at most 64 characters")
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "Skill name must be kebab-case (lowercase letters, digits, hyphens) and start with a letter or digit",
  );

/**
 * Single-line description constraint.
 *
 * The SKILL.md frontmatter serializer writes descriptions inline as a
 * double-quoted YAML scalar. Multi-line descriptions would break the
 * minimal regex-based parser we use, so we reject newlines at the
 * validation layer rather than implementing a full YAML block scalar.
 */
const skillDescriptionSchema = z
  .string()
  .min(1, "description is required")
  .max(500, "description must be at most 500 characters")
  .refine((v) => !/[\r\n]/.test(v), {
    message: "description cannot contain newlines",
  });

/**
 * `allowed-tools` constraint — matches Claude Code's official SKILL.md
 * convention (e.g. `Bash(curl *)`, `Read`, `Grep`). Each entry is a single
 * line with no control characters.
 */
const skillAllowedToolsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .refine((v) => !/[\r\n]/.test(v), {
        message: "tool entries cannot contain newlines",
      }),
  )
  .max(32, "at most 32 allowed-tools entries");

export const skillCreateSchema = z.object({
  name: skillNameSchema,
  description: skillDescriptionSchema,
  content: z.string().min(1, "content cannot be empty"),
  allowedTools: skillAllowedToolsSchema.optional(),
});

export const skillUpdateSchema = z.object({
  description: skillDescriptionSchema.optional(),
  content: z.string().min(1, "content cannot be empty").optional(),
  allowedTools: skillAllowedToolsSchema.optional(),
}).refine(
  (data) =>
    data.description !== undefined ||
    data.content !== undefined ||
    data.allowedTools !== undefined,
  { message: "At least one of 'description', 'content', or 'allowedTools' must be provided" },
);

// The schemas are consumed only as the source of the `z.infer<typeof ...>`
// types exported below; the Zod values are never called at runtime. Prefix
// with `_` so ESLint's no-unused-vars stops flagging the binding.
const _skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  builtin: z.boolean(),
  updatedAt: z.string(),
});

const _skillDetailSchema = z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
  allowedTools: z.array(z.string()),
  builtin: z.boolean(),
  updatedAt: z.string(),
});

// ── Calendar API ──

const calendarEventFields = {
  description: z.string().max(10_000).optional(),
  location: z.string().max(1000).optional(),
  reminders: z.object({
    useDefault: z.boolean(),
    overrides: z.array(z.object({
      method: z.enum(["email", "popup"]),
      minutes: z.number().int().min(0).max(40320),
    })).max(5).optional(),
  }).optional(),
  recurrence: z.array(z.string().max(500)).max(5).optional(),
  attendees: z.array(z.object({
    email: z.string().email(),
  })).max(100).optional(),
  visibility: z.enum(["default", "public", "private", "confidential"]).optional(),
};

export const calendarCreateEventSchema = z.object({
  summary: z.string().min(1).max(1000),
  start: z.string().min(1),
  end: z.string().min(1),
  ...calendarEventFields,
});

export const calendarUpdateEventSchema = z.object({
  summary: z.string().min(1).max(1000).optional(),
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
  ...calendarEventFields,
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: "At least one field must be provided for update" },
);

export const calendarFreeBusySchema = z.object({
  timeMin: z.string().min(1),
  timeMax: z.string().min(1),
  calendarIds: z.array(z.string()).min(1).max(50).optional(),
});

// ── Recurring Schedules ──

const HH_MM_RE = /^\d{2}:\d{2}$/;

/**
 * Recurrence schema. Four `frequency` values:
 *
 *   - `hourly`  — fire every `intervalHours` (1..23, default 1) at
 *                 `minuteOfHour` (0..59, default 0). Anchored to local
 *                 midnight of `timezone` so `intervalHours=2` fires at
 *                 the even hours, predictably. `time`, `daysOfWeek`,
 *                 `daysOfMonth`, `onMissingDay` are forbidden.
 *   - `daily`   — requires `time`. Day-of-* fields and `onMissingDay`
 *                 are forbidden.
 *   - `weekly`  — requires `time` + `daysOfWeek`. `daysOfMonth` and
 *                 `onMissingDay` are forbidden.
 *   - `monthly` — requires `time` + `daysOfMonth`. `onMissingDay`
 *                 controls how 29/30/31 are handled in months that
 *                 don't contain them: `"lastDayOfMonth"` (default —
 *                 bit-identical to the pre-redesign clamp behavior) or
 *                 `"skip"` (no fire that month for the missing day).
 *
 * Day-of-* arrays reject duplicates at the schema layer — duplicates are
 * always a caller bug, never an intent. Calendar-date collisions from
 * `onMissingDay:"lastDayOfMonth"` (e.g. `[28,31]` collapsing to Feb 28)
 * are de-duped by the recurrence engine at expansion time, not here.
 */
export const recurrenceRuleSchema = z.object({
  frequency: z.enum(["hourly", "daily", "weekly", "monthly"]),
  /** HH:MM local time. Required for daily/weekly/monthly; forbidden for hourly. */
  time: z.string().regex(HH_MM_RE, "time must be HH:MM format").optional(),
  /** hourly only — 1..23. Default 1. */
  intervalHours: z.number().int().min(1).max(23).optional(),
  /** hourly only — 0..59. Default 0. */
  minuteOfHour: z.number().int().min(0).max(59).optional(),
  /** IANA timezone (e.g. "America/New_York"). Optional — auto-filled from daemon config when omitted. */
  timezone: z.string().min(1).optional(),
  /** 0=Sun..6=Sat — required when frequency is weekly. Duplicates rejected. */
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .refine((a) => new Set(a).size === a.length, {
      message: "daysOfWeek entries must be unique",
    })
    .optional(),
  /**
   * 1-31 — required when frequency is monthly. Duplicates rejected.
   * Days 29-31 in months that don't contain them are controlled by
   * `onMissingDay`, NOT silently clamped at validation time.
   */
  daysOfMonth: z
    .array(z.number().int().min(1).max(31))
    .min(1)
    .max(31)
    .refine((a) => new Set(a).size === a.length, {
      message: "daysOfMonth entries must be unique",
    })
    .optional(),
  /**
   * Monthly only — policy for days that don't exist in a given month.
   *   `"skip"`            — don't fire that month for the missing day
   *   `"lastDayOfMonth"`  — fire on the actual last day of the month
   *                          (default; preserves prior clamp behavior).
   */
  onMissingDay: z.enum(["skip", "lastDayOfMonth"]).optional(),
}).superRefine((rule, ctx) => {
  switch (rule.frequency) {
    case "hourly": {
      // hourly: forbid time / days* / onMissingDay; allow intervalHours + minuteOfHour
      if (rule.time !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["time"],
          message: "time is not allowed for hourly frequency (use minuteOfHour)",
        });
      }
      if (rule.daysOfWeek !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daysOfWeek"],
          message: "daysOfWeek is not allowed for hourly frequency",
        });
      }
      if (rule.daysOfMonth !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daysOfMonth"],
          message: "daysOfMonth is not allowed for hourly frequency",
        });
      }
      if (rule.onMissingDay !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["onMissingDay"],
          message: "onMissingDay is not allowed for hourly frequency",
        });
      }
      return;
    }
    case "daily": {
      if (rule.time === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["time"],
          message: "time is required for daily frequency",
        });
      }
      if (rule.intervalHours !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["intervalHours"],
          message: "intervalHours is not allowed for daily frequency",
        });
      }
      if (rule.minuteOfHour !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minuteOfHour"],
          message: "minuteOfHour is not allowed for daily frequency",
        });
      }
      if (rule.daysOfWeek !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daysOfWeek"],
          message: "daysOfWeek is not allowed for daily frequency",
        });
      }
      if (rule.daysOfMonth !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daysOfMonth"],
          message: "daysOfMonth is not allowed for daily frequency",
        });
      }
      if (rule.onMissingDay !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["onMissingDay"],
          message: "onMissingDay is not allowed for daily frequency",
        });
      }
      return;
    }
    case "weekly": {
      if (rule.time === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["time"],
          message: "time is required for weekly frequency",
        });
      }
      if (rule.daysOfWeek === undefined || rule.daysOfWeek.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daysOfWeek"],
          message: "daysOfWeek is required for weekly frequency",
        });
      }
      if (rule.intervalHours !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["intervalHours"],
          message: "intervalHours is not allowed for weekly frequency",
        });
      }
      if (rule.minuteOfHour !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minuteOfHour"],
          message: "minuteOfHour is not allowed for weekly frequency",
        });
      }
      if (rule.daysOfMonth !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daysOfMonth"],
          message: "daysOfMonth is not allowed for weekly frequency",
        });
      }
      if (rule.onMissingDay !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["onMissingDay"],
          message: "onMissingDay is not allowed for weekly frequency",
        });
      }
      return;
    }
    case "monthly": {
      if (rule.time === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["time"],
          message: "time is required for monthly frequency",
        });
      }
      if (rule.daysOfMonth === undefined || rule.daysOfMonth.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daysOfMonth"],
          message: "daysOfMonth is required for monthly frequency",
        });
      }
      if (rule.intervalHours !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["intervalHours"],
          message: "intervalHours is not allowed for monthly frequency",
        });
      }
      if (rule.minuteOfHour !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minuteOfHour"],
          message: "minuteOfHour is not allowed for monthly frequency",
        });
      }
      if (rule.daysOfWeek !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daysOfWeek"],
          message: "daysOfWeek is not allowed for monthly frequency",
        });
      }
      return;
    }
  }
});

export const recurringScheduleCreateSchema = z.object({
  taskType: z.string().min(1),
  description: z.string().min(20, "Description must be at least 20 characters. The wake-up agent has NO memory — the description is its only context."),
  // Optional override for the agent task body. See scheduleRequestSchema.prompt.
  prompt: z
    .string()
    .min(20, "Prompt must be at least 20 characters. The wake-up agent has NO memory — the prompt is its only context.")
    .optional(),
  recurrenceRule: recurrenceRuleSchema,
  // See scheduleRequestSchema.model — free-form token; alias rows
  // rewrite to `tier`, registered ids persist alongside `backend_id`.
  // SCHEDULE_API_REDESIGN_PLAN §4.3.
  model: z.string().min(1).max(120).optional(),
  tier: z.enum(["lite", "medium", "high"]).optional(),
  taskContext: z.record(z.string(), z.unknown()).optional(),
});

export const recurringScheduleUpdateSchema = z.object({
  description: z.string().min(20, "Description must be at least 20 characters.").optional(),
  // Pass `null` to clear an override and fall back to `description`.
  prompt: z
    .union([
      z.string().min(20, "Prompt must be at least 20 characters."),
      z.null(),
    ])
    .optional(),
  recurrenceRule: recurrenceRuleSchema.optional(),
  // PATCH variant of `scheduleRequestSchema.model`. Accepts a free-form
  // token (alias / id / composite) or `null` to clear the pin.
  // SCHEDULE_API_REDESIGN_PLAN §4.3 — route resolves `(model, backend_id)`
  // atomically and rejects when paired with a non-null `tier`.
  model: z.union([z.string().min(1).max(120), z.null()]).optional(),
  // Pass `null` to clear the tier override and fall back to the
  // process-key default; pass a concrete tier to pin.
  tier: z.enum(["lite", "medium", "high"]).nullable().optional(),
  taskContext: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: "At least one field must be provided for update" },
);

// ── Automation Triggers (docs/design/19-dashboard-ia-and-triggers.md) ──

const HH_MM_RE_TRIGGER = /^([01]\d|2[0-3]):[0-5]\d$/;

const triggerDomainSchema = z.enum(["git"]);
const triggerEventTypeSchema = z.enum(["cron.daily", "cron.weekly"]);

export const triggerCreateSchema = z.object({
  domain: triggerDomainSchema,
  eventType: triggerEventTypeSchema,
  prompt: z
    .string()
    .min(20, "Prompt must be at least 20 characters. The trigger run starts with no chat memory — the prompt is its only instruction."),
  time: z.string().regex(HH_MM_RE_TRIGGER, "time must be HH:MM format"),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
}).refine(
  (data) => data.eventType !== "cron.weekly" ||
    (data.daysOfWeek !== undefined && data.daysOfWeek.length > 0),
  { message: "daysOfWeek is required for cron.weekly" },
);

export const triggerUpdateSchema = z.object({
  prompt: z
    .string()
    .min(20, "Prompt must be at least 20 characters.")
    .optional(),
  enabled: z.boolean().optional(),
  time: z.string().regex(HH_MM_RE_TRIGGER, "time must be HH:MM format").optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: "At least one field must be provided for update" },
);

// ── Inferred Types ──

export type NotifyRequest = z.infer<typeof notifyRequestSchema>;
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>;
export type ScheduleUpdateRequest = z.infer<typeof scheduleUpdateRequestSchema>;
export type ScheduleDmRequest = z.infer<typeof scheduleDmRequestSchema>;
export type ScheduleBatchRequest = z.infer<typeof scheduleBatchRequestSchema>;
export type ScheduleBatchRow = z.infer<typeof scheduleBatchRowSchema>;
export type ScheduleBatchTaskContext = z.infer<typeof scheduleBatchTaskContextSchema>;
export type ActionLogRequest = z.infer<typeof actionLogRequestSchema>;
export type SkillCreateRequest = z.infer<typeof skillCreateSchema>;
export type SkillUpdateRequest = z.infer<typeof skillUpdateSchema>;
export type SkillSummary = z.infer<typeof _skillSummarySchema>;
export type SkillDetail = z.infer<typeof _skillDetailSchema>;
export type TriggerCreateRequest = z.infer<typeof triggerCreateSchema>;
export type TriggerUpdateRequest = z.infer<typeof triggerUpdateSchema>;
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;

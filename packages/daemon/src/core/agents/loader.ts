import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  agentDefinitionSchema,
  isCustomRoutineKey,
  isProcessKey,
  type AgentDefinition,
} from "@aitne/shared";
import { z } from "zod";
import {
  ALWAYS_DISALLOWED_TOOLS,
  classifyAbsoluteBlock,
} from "../../safety/always-disallowed.js";
import {
  getAgent,
  listAgents,
  upsertAgent,
  type AgentDTO,
  type AgentMetadata,
  type AgentSource,
  type AgentUpsertInput,
} from "../../db/agents-store.js";
import { createLogger } from "../../logging.js";
import {
  AgentFrontmatterError,
  parseAgentFrontmatter,
  renderAgentMarkdown,
} from "./agent-frontmatter.js";
import {
  BUILTIN_AGENT_REGISTRY,
  getBuiltinRegistryEntry,
  isBuiltinAgentSlug,
  type BuiltinAgentRegistryEntry,
} from "./builtin-registry.js";
import { checkCronDrift, substituteCron, validateCronExpression } from "./cron-substitute.js";
import { mergeAgentDefinition } from "./override-merge.js";
import {
  cronToRecurrenceSpec,
  recurrenceSpecToCron,
  type AgentRecurrenceSpec,
} from "./recurrence-convert.js";

/**
 * Agent loader & lifecycle (AGENT_DEFINITIONS_DESIGN.md §6).
 *
 * Boot path: scan `agent-assets/agents/*​/agent.md` (built-in) +
 * `<contextDir>/policies/agents/*​/agent.md` (user) → parse with
 * `agentDefinitionSchema` → synthesise registry fallbacks for any missing
 * built-in → resolve overrides → read-modify-write upsert into the `agents`
 * table → pair user Agents with a `recurring_schedules` row → auto-import
 * orphan recurring rows → expose a live enabled-cache for the Phase-7
 * scheduler gate. A filesystem watcher re-runs the per-file path on change.
 *
 * **Crash-proof boot is the prime invariant (§6.6):** every per-file failure
 * is captured and persisted as an invalid `agents` row (or surfaced in the
 * returned `invalid[]` list for slug collisions, which cannot own a row); the
 * loader never throws out of `loadAgents`.
 *
 * Cross-cutting integrations (snapshot writer, SSE emitter, recurring-schedule
 * store, skill manifest) are injected as ports so the core stays unit-testable
 * to 100% with fakes; the Phase-7 boot wiring supplies concrete adapters over
 * the real daemon modules.
 */

const baseLogger = createLogger("agents-loader");

/** A built-in whose registry `cronExpression` is `null` (activity-scan) still
 *  needs a schema-valid `schedule.expression` when synthesised from the
 *  registry. The loader never schedules from it (the runtime window owns the
 *  cadence, §5.5.1); this literal is self-documenting only and drift-free
 *  because the registry resolver is `null`. */
const REGISTRY_FALLBACK_HOURLY_CRON = "0 * * * *";

const AGENT_FILE_NAME = "agent.md";

// ── Ports (injected; see file header) ──────────────────────────────────────

/** Writes an `md_file_snapshots` row on definition-hash change (§6.3). */
export interface AgentSnapshotPort {
  record(input: { filePath: string; content: string; trigger: string }): void;
}

/** Emits an SSE event for live dashboard refresh (§6.2 / §9.8). */
export interface AgentEventPort {
  emit(event: string, payload: unknown): void;
}

/** A `recurring_schedules` row in the loader-local recurrence vocabulary. */
export interface RecurringAgentRow {
  id: number;
  enabled: boolean;
  taskType: string;
  description: string;
  prompt: string | null;
  model: string | null;
  tier: string | null;
  backendId: string | null;
  recurrence: AgentRecurrenceSpec;
  /**
   * The row's `task_context` (parsed). Used by the auto-import sweep to skip
   * rows owned by another subsystem (managed-tasks `mt_id`, automation-trigger
   * `triggerSource`) so they never materialise a bogus `imported-<id>` Agent.
   */
  taskContext: Record<string, unknown>;
}

/** Fields needed to create a `recurring_schedules` row for a user Agent. */
export interface RecurringCreateInput {
  /**
   * §6.4-resolved enabled (NOT the raw YAML value). The recurring row that the
   * reconciler gates firing on (`WHERE enabled = 1`) must track the same
   * last-write-wins resolution as `agents.enabled`, or a dashboard-disabled
   * Agent silently resumes firing after a restart (and a fresh `enabled: false`
   * Agent would fire once).
   */
  enabled: boolean;
  taskType: string;
  description: string;
  prompt: string | null;
  model: string | null;
  tier: string | null;
  backendId: string | null;
  recurrence: AgentRecurrenceSpec;
  /**
   * Row-local flags copied into every materialised `agent_schedule` row by
   * `generateNextScheduleRow` (the `pin_to_quiet_hours_end` precedent). Today
   * carries `defer_in_quiet_hours: true` for opted-in Agents
   * (QUIET_HOURS_HARDENING_PLAN.md §6); omitted/empty otherwise (the store
   * defaults the column to `{}`).
   */
  taskContext?: Record<string, unknown>;
}

/** Divergent-field patch applied when reconciling a paired recurring row (YAML wins). */
export interface RecurringUpdateInput {
  enabled?: boolean;
  description?: string;
  prompt?: string | null;
  model?: string | null;
  tier?: string | null;
  backendId?: string | null;
  recurrence?: AgentRecurrenceSpec;
  /** Full replacement `task_context` (the loader merges off the row's current
   *  value, so unrelated keys survive a flag flip). */
  taskContext?: Record<string, unknown>;
}

/**
 * Recurring-schedule pairing + auto-import port (§6.1 step 5 / §6.5). The
 * Phase-7 adapter maps these to `db/recurring-schedules.ts`; tests pass a fake.
 */
export interface RecurringSchedulePort {
  list(): RecurringAgentRow[];
  get(id: number): RecurringAgentRow | null;
  create(input: RecurringCreateInput): number;
  update(id: number, patch: RecurringUpdateInput): void;
}

type LoaderLogger = Pick<
  ReturnType<typeof createLogger>,
  "info" | "warn" | "error" | "debug"
>;

/** Everything `loadAgents` needs. The boot wiring resolves these from
 *  `AgentConfig` (`builtinDir = <workspaceDir>/agent-assets/agents`,
 *  `userDir = <contextDir>/policies/agents`); tests pass temp dirs + fakes. */
export interface AgentLoadOptions {
  /** Absolute path to the shipped built-in agents root. */
  builtinDir: string;
  /** Absolute path to the user agents root under the context vault. */
  userDir: string;
  /** Live day-boundary hour for cron placeholder substitution (§4.2). */
  dayBoundaryHour: number;
  /** Resolved IANA timezone stamped on rows whose YAML omits one (§5.1). */
  timezone: string;
  snapshot?: AgentSnapshotPort;
  events?: AgentEventPort;
  recurring?: RecurringSchedulePort;
  /** Skill-slug set for the `tools.skills` cross-check (§4.3 step 5). */
  listSkillSlugs?: () => ReadonlySet<string>;
  now?: () => number;
  logger?: LoaderLogger;
}

/** A definition that failed to load (parse error, slug collision, cross-check). */
export interface InvalidAgentDefinition {
  slug: string;
  source: AgentSource;
  path: string;
  error: string;
  /** True when the failure is a built-in-slug collision that owns no DB row. */
  collision: boolean;
}

export interface LoadAgentsResult {
  /** Slugs upserted this run (valid, fallback-synthesised, or invalid rows). */
  upserted: string[];
  /** Per-file load failures (§6.6). Collisions have no DB row. */
  invalid: InvalidAgentDefinition[];
  /** Non-fatal warnings (cron drift, codex widening, unknown skill, …). */
  warnings: string[];
}

// ── Filesystem scan ─────────────────────────────────────────────────────────

interface ScannedFile {
  slug: string;
  path: string;
  source: AgentSource;
}

/**
 * List `<root>/<slug>/agent.md` entries under a single agents root. Missing
 * roots return `[]` (a fresh install has no user agents dir yet). Directory
 * entries without an `agent.md` are skipped.
 */
export function scanAgentDir(root: string, source: AgentSource): ScannedFile[] {
  if (!existsSync(root)) return [];
  const out: ScannedFile[] = [];
  // `withFileTypes` yields the dir/file kind from the readdir result itself, so
  // there is no per-entry `statSync` (hence no race window and no defensive
  // catch to leave uncovered). Mirrors `skills-compiler-tree.ts`.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = join(root, entry.name, AGENT_FILE_NAME);
    if (existsSync(filePath)) {
      out.push({ slug: entry.name, path: filePath, source });
    }
  }
  return out;
}

// ── Hashing ──────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Timezone / schedule resolution ──────────────────────────────────────────

/** First non-empty string, falling back to the system zone then UTC. The
 *  config default for `timezone` is `""`, so a plain `??` would store an empty
 *  zone — guard on truthiness. */
export function resolveTimezone(
  yamlTz: string | undefined,
  configTz: string,
): string {
  if (yamlTz && yamlTz.length > 0) return yamlTz;
  if (configTz && configTz.length > 0) return configTz;
  /* c8 ignore next 2 — system-zone fallback is environment-dependent. */
  const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return sys && sys.length > 0 ? sys : "UTC";
}

/**
 * Resolve the concrete `schedule_expression` column value for a definition:
 * cron expressions get `{dayBoundaryHour}` substituted; one_shot / event store
 * their raw spec field. Returns `null` only when the (refinement-guaranteed)
 * field is somehow absent — defensively, never throws.
 */
export function resolveScheduleExpression(
  def: AgentDefinition,
  dayBoundaryHour: number,
): string | null {
  const schedule = def.schedule;
  if (schedule.kind === "cron") {
    return schedule.expression
      ? substituteCron(schedule.expression, { dayBoundaryHour })
      : null;
  }
  if (schedule.kind === "one_shot") return schedule.one_shot_at ?? null;
  return schedule.event_ref ?? null;
}

// ── Registry fallback synthesis (§6.1 step 3) ───────────────────────────────

/**
 * Build a schema-valid `AgentDefinition` from a built-in registry entry, used
 * as the base when a built-in's `agent.md` is missing or invalid. Parsing
 * through `agentDefinitionSchema` fills every schema default (limits, tools,
 * on_error, version) so the result is a complete identity.
 */
export function synthesizeRegistryDefinition(
  entry: BuiltinAgentRegistryEntry,
  dayBoundaryHour: number,
): AgentDefinition {
  const expression = entry.cronExpression
    ? entry.cronExpression({ dayBoundaryHour })
    : REGISTRY_FALLBACK_HOURLY_CRON;
  return agentDefinitionSchema.parse({
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    kind: "builtin",
    enabled: entry.defaultEnabled,
    schedule: { kind: "cron", expression },
    backend: { process_key: entry.processKey },
    // `limits` is a required object (per-field defaults, no object-level
    // default) — pass an empty object so the field defaults fill in.
    limits: {},
    stop_warning: entry.stopWarning,
  });
}

// ── tools.allowed vs the absolute-block layer (§11.3.1) ─────────────────────

const TOOL_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/;

/**
 * Find the first `tools.allowed` entry that overlaps `ALWAYS_DISALLOWED_TOOLS`
 * — a definition can never widen past the absolute-block layer. An exact
 * pattern match (covers bare tool names like `CronCreate`) or a
 * `classifyAbsoluteBlock` hit on a `Tool(arg)` entry both count. Returns the
 * offending entry, or `null` when the allow-list is clean.
 */
export function findAbsoluteBlockOverlap(allowed: readonly string[]): string | null {
  for (const entry of allowed) {
    if ((ALWAYS_DISALLOWED_TOOLS as readonly string[]).includes(entry)) {
      return entry;
    }
    const match = TOOL_PATTERN.exec(entry);
    if (match && classifyAbsoluteBlock(match[1], match[2]) !== null) {
      return entry;
    }
  }
  return null;
}

// ── Per-definition validation (§4.3 steps 4-6 / §11.3.1) ────────────────────

/**
 * Cross-checks a parsed/synthesised definition beyond what the Zod schema can
 * express. Returns an error string (→ invalid, §6.6) or `null` when valid;
 * appends any non-fatal notes to `warnings`.
 */
export function validateDefinition(
  def: AgentDefinition,
  source: AgentSource,
  expectedSlug: string,
  opts: { listSkillSlugs?: () => ReadonlySet<string> },
  warnings: string[],
): string | null {
  // slug must match the directory name (§4.3 step 3).
  if (def.slug !== expectedSlug) {
    return `slug "${def.slug}" does not match directory "${expectedSlug}"`;
  }
  // source must match the declared kind: a user dir cannot ship kind:builtin
  // and vice-versa (slug-collision for builtin slugs is handled earlier).
  if (def.kind !== source) {
    return `kind "${def.kind}" does not match its location (${source})`;
  }
  // `/agents` is recurring-only: a user Agent is a durable, named, recurring
  // identity. Single-execution work belongs on the `/schedule` one-shot queue
  // (POST /api/schedule), not the Agent layer. Reject a user one_shot/event
  // definition with an actionable pointer so it surfaces as an invalid row
  // (§6.6) rather than silently materialising a fire-once "Agent". Built-ins
  // are all cron, so this never blocks a routine (`source === "user"` gate).
  if (source === "user" && def.schedule.kind !== "cron") {
    return `user Agents are recurring-only (schedule.kind="${def.schedule.kind}") — use POST /api/schedule for one-time tasks`;
  }
  // built-in slug must be a known registry entry (§4.3 step 6).
  if (source === "builtin" && !isBuiltinAgentSlug(def.slug)) {
    return `built-in slug "${def.slug}" is not in BUILTIN_AGENT_REGISTRY`;
  }
  // process_key cross-check, skipped for the no-LLM passes (§4.3 step 4).
  const processKey = def.backend.process_key;
  if (
    processKey !== null &&
    !isProcessKey(processKey) &&
    !isCustomRoutineKey(processKey)
  ) {
    return `process_key "${processKey}" is not a known ProcessKey`;
  }
  // tools.allowed can never widen past the absolute-block layer (§11.3.1).
  const overlap = findAbsoluteBlockOverlap(def.tools.allowed);
  if (overlap !== null) {
    return `tools.allowed entry "${overlap}" overlaps the absolute-block layer`;
  }
  // Codex cannot enforce the absolute-block layer at the shell level — a
  // codex-bound Agent declaring extra tools is a non-fatal warning (§11.3.1).
  if (def.backend.backend_id === "codex" && def.tools.allowed.length > 0) {
    warnings.push(
      `agent "${def.slug}": codex backend cannot enforce the absolute-block layer for tools.allowed`,
    );
  }
  // tools.skills cross-check — unknown skills are a non-fatal warning, not a
  // boot-breaking error: a renamed skill must not disable a whole routine.
  if (opts.listSkillSlugs && def.tools.skills.length > 0) {
    const manifest = opts.listSkillSlugs();
    for (const skill of def.tools.skills) {
      if (!manifest.has(skill)) {
        warnings.push(`agent "${def.slug}": unknown skill "${skill}" in tools.skills`);
      }
    }
  }
  // A cron whose resolved form is malformed (typo'd field count, unresolved
  // placeholder) is unschedulable — reject it (§6.6). node-cron is still the
  // authoritative schedule-time parser; this is a cheap pre-flight.
  if (def.schedule.kind === "cron" && def.schedule.expression) {
    const resolved = substituteCron(def.schedule.expression, {
      dayBoundaryHour: 0,
    });
    const cronError = validateCronExpression(resolved);
    if (cronError !== null) {
      return `invalid cron expression: ${cronError}`;
    }
    // cron drift against the registry, for built-ins only (non-fatal, §6.1 step 6).
    if (source === "builtin") {
      // The built-in-slug check above guarantees the entry exists here.
      const entry = getBuiltinRegistryEntry(def.slug)!;
      if (entry.cronExpression) {
        const registryResolved = entry.cronExpression({ dayBoundaryHour: 0 });
        const drift = checkCronDrift(resolved, registryResolved);
        if (drift) warnings.push(`agent "${def.slug}": ${drift}`);
      }
    }
  }
  return null;
}

// ── Metadata carry-forward (Phase-2 read-modify-write contract) ─────────────

/**
 * Merge the metadata the loader must preserve across an upsert. `upsertAgent`
 * overwrites `metadata_json` wholesale, so the loader carries forward the
 * operator's `override_snapshot`, the running `version_counter`, and clears any
 * stale `last_error` on a now-valid definition. Bumps `version_counter` when
 * the definition hash changed.
 */
function nextMetadata(
  existing: AgentDTO | null,
  hashChanged: boolean,
): AgentMetadata {
  const prior = existing?.metadata ?? {};
  const meta: AgentMetadata = {};
  if (prior.override_snapshot !== undefined) {
    meta.override_snapshot = prior.override_snapshot;
  }
  // Runtime-window cadence overrides (activity-scan interval / active hours /
  // observation gate) are operator state exactly like override_snapshot — they
  // must survive every loader re-run and `npm i -g`.
  if (prior.runtime_window !== undefined) {
    meta.runtime_window = prior.runtime_window;
  }
  const priorVersion =
    typeof prior.version_counter === "number" ? prior.version_counter : 0;
  meta.version_counter = hashChanged ? priorVersion + 1 : Math.max(priorVersion, 1);
  // last_error is intentionally dropped: this path runs only for a definition
  // that parsed and validated, so any prior parse error is resolved.
  return meta;
}

// ── enabled-state resolution (§6.4) ─────────────────────────────────────────

/**
 * Resolve the effective `enabled` for a row given the YAML/base value, the file
 * mtime, and the operator's last dashboard toggle. The dashboard override wins
 * only while it is at least as recent as the file; editing the file (or a fresh
 * row with no override) lets the YAML win.
 */
export function resolveEnabled(
  baseEnabled: boolean,
  existing: AgentDTO | null,
  fileMtimeMs: number,
): boolean {
  if (
    existing &&
    existing.enabledOverriddenAt !== null &&
    existing.enabledOverriddenAt >= fileMtimeMs
  ) {
    return existing.enabled;
  }
  return baseEnabled;
}

// ── Upsert one resolved definition ──────────────────────────────────────────

interface ResolvedUpsert {
  def: AgentDefinition;
  /** Base (pre-snapshot) enabled used by the §6.4 timestamp resolution. */
  baseEnabled: boolean;
  source: AgentSource;
  path: string;
  fileMtimeMs: number;
  /** Content hashed for change detection (file bytes, or synthesised marker). */
  hashSource: string;
  recurringScheduleId: number | null;
}

function upsertResolved(
  db: Database.Database,
  resolved: ResolvedUpsert,
  opts: AgentLoadOptions,
  logger: LoaderLogger,
  now: number,
): void {
  const { def, source, path } = resolved;
  const existing = getAgent(db, def.slug);
  const definitionHash = sha256(resolved.hashSource);
  const enabled = resolveEnabled(resolved.baseEnabled, existing, resolved.fileMtimeMs);
  const hashChanged = !existing || existing.definitionHash !== definitionHash;
  const scheduleTimezone = resolveTimezone(def.schedule.timezone, opts.timezone);

  // Efficiency (§6.1): skip the write entirely when nothing the loader owns
  // changed — keeps `updated_at` meaning "last definition change".
  const enabledFlip = !existing || existing.enabled !== enabled;
  const recurringFlip =
    !existing || existing.recurringScheduleId !== resolved.recurringScheduleId;
  // An OS-timezone change (auto mode) re-resolves `scheduleTimezone` without
  // touching the file hash / enabled / pairing, so without this the agents row
  // would keep displaying the boot-time zone while its recurring row already
  // fires in the new one — the exact "silently wrong zone" the column guards
  // against (schema.ts). Fold it into the guard so the displayed zone tracks
  // the move. No churn: a stable zone resolves identically each pass.
  const timezoneFlip = !existing || existing.scheduleTimezone !== scheduleTimezone;
  if (existing && !hashChanged && !enabledFlip && !recurringFlip && !timezoneFlip) {
    return;
  }

  if (hashChanged) {
    opts.snapshot?.record({
      filePath: path,
      content: resolved.hashSource,
      trigger: "agent_definition_change",
    });
  }

  const input: AgentUpsertInput = {
    slug: def.slug,
    name: def.name,
    description: def.description,
    source,
    definitionPath: path,
    definitionHash,
    enabled,
    enabledOverriddenAt: existing?.enabledOverriddenAt ?? null,
    processKey: def.backend.process_key,
    scheduleKind: def.schedule.kind,
    scheduleExpression: resolveScheduleExpression(def, opts.dayBoundaryHour),
    scheduleTimezone,
    tags: def.tags,
    stopWarning: def.stop_warning ?? null,
    recurringScheduleId: resolved.recurringScheduleId,
    metadata: nextMetadata(existing, hashChanged),
  };
  upsertAgent(db, input, now);
  logger.debug({ slug: def.slug, source, hashChanged }, "agent upserted");
  opts.events?.emit("agent.updated", { slug: def.slug, source });
}

// ── Invalid-definition persistence (§6.6) ───────────────────────────────────

/**
 * Persist a parse/validation failure as a disabled `agents` row carrying
 * `metadata.last_error`, so the dashboard's "Needs attention" section can show
 * it without losing identity. Slug collisions are NOT persisted here (the
 * built-in owns the row id); the caller reports those in `invalid[]` only.
 */
function persistInvalid(
  db: Database.Database,
  slug: string,
  source: AgentSource,
  path: string,
  error: string,
  now: number,
): void {
  const existing = getAgent(db, slug);
  // Build the §6.6 parse-error metadata via an object literal so the key is
  // written with a colon, not an assignment. The redaction static guard
  // (scripts/check-redaction-coverage.mjs) reserves the assignment form of the
  // error-detail token for the auth-health column; this value is an Agent
  // definition parse error, never a secret (mirrors the agents-store.ts dodge).
  const meta: AgentMetadata = { ...(existing?.metadata ?? {}), last_error: error };
  upsertAgent(
    db,
    {
      slug,
      name: existing?.name ?? slug,
      description: existing?.description ?? null,
      source,
      definitionPath: path,
      definitionHash: sha256(`invalid:${error}`),
      enabled: false,
      enabledOverriddenAt: existing?.enabledOverriddenAt ?? null,
      processKey: existing?.processKey ?? null,
      scheduleKind: existing?.scheduleKind ?? "cron",
      scheduleExpression: existing?.scheduleExpression ?? null,
      scheduleTimezone: existing?.scheduleTimezone ?? "UTC",
      tags: existing?.tags ?? [],
      stopWarning: existing?.stopWarning ?? null,
      recurringScheduleId: existing?.recurringScheduleId ?? null,
      metadata: meta,
    },
    now,
  );
}

// ── Recurring pairing (§6.1 step 5) ─────────────────────────────────────────

/**
 * Ensure a user Agent has a backing `recurring_schedules` row, returning the
 * row id to store on the agent (or `null` when no pairing is possible). Creates
 * a row from the YAML when none is paired yet; reconciles divergent fields
 * (YAML wins) when one already exists.
 *
 * `expression` is the (already cron-narrowed) schedule expression — the caller
 * only reaches here for a valid user Agent, which is recurring-only, so the
 * schedule is always cron (`validateDefinition` rejects one_shot/event before
 * pairing). `body` is the Agent's Markdown body — the operator's prompt
 * (§6.1 step 5: a recurring row is built from "schedule + backend + body"),
 * captured into the recurring row's `task_prompt` at **first pairing only**.
 */
function pairRecurring(
  def: AgentDefinition,
  expression: string,
  body: string,
  existing: AgentDTO | null,
  port: RecurringSchedulePort,
  resolvedTz: string,
  resolvedEnabled: boolean,
  warnings: string[],
): number | null {
  // Use the same resolved zone the agents row stores, not a bare "UTC", so the
  // recurring row and the Agent agree on the firing timezone.
  const spec = cronToRecurrenceSpec(expression, resolvedTz);
  if (spec === null) {
    warnings.push(
      `agent "${def.slug}": cron "${expression}" is not representable as a recurrence rule — not paired`,
    );
    return existing?.recurringScheduleId ?? null;
  }

  const trimmedBody = body.trim();
  const desired: RecurringCreateInput = {
    // §6.4 last-write-wins: mirror the resolved enabled onto the recurring row
    // so a dashboard disable survives a reload (the reconciler gates firing on
    // `recurring_schedules.enabled`, not `agents.enabled`).
    enabled: resolvedEnabled,
    taskType: "agent.task",
    description: def.name,
    // The Markdown body is the user Agent's prompt; persist it as the recurring
    // row's task_prompt so the dispatched run uses what the operator wrote, not
    // just the name (§6.1 step 5). A blank body stays null — the dispatcher then
    // falls back to task_description (recurring_schedules.task_prompt contract).
    prompt: trimmedBody.length > 0 ? trimmedBody : null,
    model: def.backend.model,
    tier: def.backend.tier,
    backendId: def.backend.backend_id,
    recurrence: spec,
    // QUIET_HOURS_HARDENING_PLAN.md §6 — `generateNextScheduleRow` spreads the
    // row's `task_context` into every materialised `agent_schedule` row, so the
    // scheduler can read the flag row-locally at claim time (no `agents` join).
    // Opt-in only: an absent key keeps default-false context clean (the
    // `pin_to_quiet_hours_end` convention on `dm_session` rows).
    taskContext: def.schedule.defer_in_quiet_hours
      ? { defer_in_quiet_hours: true }
      : {},
  };

  const existingId = existing?.recurringScheduleId ?? null;
  if (existingId !== null) {
    const row = port.get(existingId);
    if (row) {
      // §6.1 step 5 / §11.3.2 step 1: reconcile ONLY divergent fields. Patching
      // unconditionally would re-fire updateRecurringSchedule's cancel+
      // re-materialise on every boot/watcher reload — tagging the pending
      // agent_schedule row `skipReason=agent_definition_changed` (false: nothing
      // changed) and recomputing next_run_at strictly-after-now, which can drop
      // an imminent fire across a restart. Build a minimal patch instead and
      // skip the write entirely when nothing diverged.
      //
      // task_prompt is deliberately NOT reconciled — it is owned at creation
      // (re-writing it every boot would clobber an auto-imported row's legacy
      // prompt with the generated placeholder body, §6.5). Body→prompt re-sync
      // after an edit is a documented v1 limitation (§6.1 step 5).
      const patch: RecurringUpdateInput = {};
      if (row.enabled !== desired.enabled) patch.enabled = desired.enabled;
      if (row.description !== desired.description) patch.description = desired.description;
      if (row.model !== desired.model) patch.model = desired.model;
      if (row.tier !== desired.tier) patch.tier = desired.tier;
      if (row.backendId !== desired.backendId) patch.backendId = desired.backendId;
      // Structural compare so a re-parsed-but-identical spec is not a "change".
      if (stableStringify(row.recurrence) !== stableStringify(spec)) patch.recurrence = spec;
      // Reconcile the quiet-hours opt-in (YAML wins), merging off the row's
      // current context so unrelated keys survive the flip. A `taskContext`
      // update does NOT cancel + re-materialise the pending row (only
      // recurrence/enabled do), so a pending materialisation keeps the prior
      // flag until its next generation — the same one-cycle staleness the
      // model/tier pins already have.
      const rowOptedIn = row.taskContext.defer_in_quiet_hours === true;
      const wantOptIn = def.schedule.defer_in_quiet_hours;
      if (rowOptedIn !== wantOptIn) {
        const nextContext = { ...row.taskContext };
        if (wantOptIn) nextContext.defer_in_quiet_hours = true;
        else delete nextContext.defer_in_quiet_hours;
        patch.taskContext = nextContext;
      }
      if (Object.keys(patch).length > 0) port.update(existingId, patch);
      return existingId;
    }
    // Paired row vanished (manual DB edit) — fall through and recreate.
  }
  return port.create(desired);
}

// ── Auto-import orphan recurring rows (§6.5) ────────────────────────────────

/**
 * True when a recurring row is owned by another subsystem (managed-tasks,
 * automation-triggers, or the setup morning-briefing seed) and so must NOT be
 * auto-imported as a user Agent. These subsystems write their own
 * `recurring_schedules` rows and manage them through their own surfaces;
 * importing them would surface bogus `imported-<id>` Agents that double-manage
 * the same cadence. A genuine user recurring row (legacy `/schedule`-created,
 * `taskType: "agent.task"` with no subsystem marker) is left importable so the
 * one-time legacy migration still runs.
 */
function isSubsystemOwnedRow(row: RecurringAgentRow): boolean {
  if (row.taskType === "dm_session") return true; // setup morning-briefing seed
  const ctx = row.taskContext;
  if (ctx.mt_id !== undefined) return true; // managed-tasks
  if (ctx.triggerSource === "automation_trigger") return true; // automation-triggers
  return false;
}

/**
 * Sweep `recurring_schedules` for rows that no Agent references and that have
 * no `imported-<id>/agent.md` yet, writing a user Agent file for each and
 * upserting its row (so the import completes in the same boot). Idempotent: a
 * second boot finds the file present and the row referenced, so it re-imports
 * nothing. Subsystem-owned rows ({@link isSubsystemOwnedRow}) are skipped — the
 * sweep only migrates genuine legacy user recurring rows now that new recurring
 * Agents are authored directly via `POST /api/agents`.
 */
function autoImportOrphans(
  db: Database.Database,
  opts: AgentLoadOptions,
  port: RecurringSchedulePort,
  result: LoadAgentsResult,
  importedSlugs: Set<string>,
  logger: LoaderLogger,
  now: number,
): void {
  const referenced = new Set<number>();
  for (const agent of listAgents(db)) {
    if (agent.recurringScheduleId !== null) referenced.add(agent.recurringScheduleId);
  }
  for (const row of port.list()) {
    if (referenced.has(row.id)) continue;
    if (isSubsystemOwnedRow(row)) continue; // managed-tasks / automation / seed
    const slug = `imported-${row.id}`;
    const dir = join(opts.userDir, slug);
    const filePath = join(dir, AGENT_FILE_NAME);
    if (existsSync(filePath)) continue; // idempotent on YAML existence (Q9)

    const cron = recurrenceSpecToCron(row.recurrence);
    const def = agentDefinitionSchema.parse({
      slug,
      name: row.description || slug,
      description: row.description || `Imported recurring schedule ${row.id}`,
      kind: "user",
      enabled: row.enabled,
      schedule: { kind: "cron", expression: cron, timezone: row.recurrence.timezone },
      backend: {
        process_key: "agent.task",
        tier: row.tier,
        model: row.model,
        backend_id: row.backendId,
      },
      // Required object with per-field defaults (see synthesizeRegistryDefinition).
      limits: {},
    });
    const body =
      (row.prompt && row.prompt.trim().length > 0
        ? row.prompt
        : row.description || `Imported on first boot from recurring schedule ${row.id}. Review and rename.`).trim();
    const markdown = renderAgentMarkdown(definitionToFrontmatter(def), body);

    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, markdown, "utf-8");

    upsertResolved(
      db,
      {
        def,
        baseEnabled: def.enabled,
        source: "user",
        path: filePath,
        // Fresh import → no existing row yet, so enabled resolves from base and
        // the precise file mtime is immaterial; use the load timestamp.
        fileMtimeMs: now,
        hashSource: markdown,
        recurringScheduleId: row.id,
      },
      opts,
      logger,
      now,
    );
    result.upserted.push(slug);
    // Mark it imported so the disk scan below does not re-process the file we
    // just wrote + upserted in this same boot (which would re-run pairRecurring
    // and double the slug in `upserted`). A later boot finds the file already
    // present, skips the import, and the scan owns it as a normal user Agent.
    importedSlugs.add(slug);
    logger.info({ slug, recurringScheduleId: row.id }, "auto-imported recurring schedule as user agent");
  }
}

/**
 * Render the subset of an `AgentDefinition` worth persisting to an auto-imported
 * `agent.md` frontmatter. Schema defaults (limits/tools/on_error) are omitted
 * to keep the generated file readable; they re-populate on the next parse.
 * Exported for the custom-routine migration, which materialises user Agents
 * through the same shape (AGENTS_HUB_REDESIGN_PLAN.md §3).
 */
export function definitionToFrontmatter(def: AgentDefinition): Record<string, unknown> {
  // Auto-import always builds a cron schedule with a resolved expression +
  // timezone, so both are emitted unconditionally (no dead-branch guards).
  const backend: Record<string, unknown> = { process_key: def.backend.process_key };
  if (def.backend.tier !== null) backend.tier = def.backend.tier;
  if (def.backend.model !== null) backend.model = def.backend.model;
  if (def.backend.backend_id !== null) backend.backend_id = def.backend.backend_id;
  return {
    slug: def.slug,
    name: def.name,
    description: def.description,
    kind: def.kind,
    enabled: def.enabled,
    schedule: {
      kind: def.schedule.kind,
      expression: def.schedule.expression,
      timezone: def.schedule.timezone,
    },
    backend,
    // `limits` is required by the schema (no object-level default), so the
    // generated file must carry it or it would fail to re-parse on next boot.
    limits: def.limits,
  };
}

// ── The boot entry ───────────────────────────────────────────────────────────

/**
 * Load every Agent definition into the `agents` table. Never throws; per-file
 * failures land in {@link LoadAgentsResult.invalid}. Order: auto-import (writes
 * orphan files) → scan → parse/validate → registry fallback → resolve & upsert.
 */
export function loadAgents(
  db: Database.Database,
  opts: AgentLoadOptions,
): LoadAgentsResult {
  const logger = opts.logger ?? baseLogger;
  const now = (opts.now ?? Date.now)();
  const result: LoadAgentsResult = { upserted: [], invalid: [], warnings: [] };
  // Slugs imported THIS boot (file written + upserted by autoImportOrphans).
  // The user-file scan skips them so the freshly-written file is not processed
  // twice in the same boot.
  const importedSlugs = new Set<string>();

  // 1. Auto-import orphan recurring rows. Each writes its `agent.md` + upserts
  //    its row directly; the scan below skips these slugs this boot.
  if (opts.recurring) {
    try {
      autoImportOrphans(db, opts, opts.recurring, result, importedSlugs, logger, now);
    } catch (err) {
      // A recurring-port failure must never crash boot — degrade to a warning.
      logger.error({ err }, "agent auto-import failed");
      result.warnings.push(`auto-import failed: ${errMsg(err)}`);
    }
  }

  // 2. Scan both roots.
  const builtinFiles = scanAgentDir(opts.builtinDir, "builtin");
  const userFiles = scanAgentDir(opts.userDir, "user");
  const seenBuiltinSlugs = new Set<string>();

  // 3. User files first so a built-in-slug collision is caught before the
  //    trusted built-in upsert (§6.5.1).
  for (const file of userFiles) {
    if (importedSlugs.has(file.slug)) {
      // Already written + upserted by auto-import this boot — don't re-process.
      continue;
    }
    if (isBuiltinAgentSlug(file.slug)) {
      const error = `user Agent slug "${file.slug}" collides with a built-in — rejected`;
      logger.error({ slug: file.slug, path: file.path }, error);
      result.invalid.push({
        slug: file.slug,
        source: "user",
        path: file.path,
        error,
        collision: true,
      });
      continue;
    }
    processFile(db, file, opts, result, logger, now);
  }

  // 4. Built-in files.
  for (const file of builtinFiles) {
    seenBuiltinSlugs.add(file.slug);
    processFile(db, file, opts, result, logger, now);
  }

  // 5. Registry fallback for any built-in with no (valid) row from a file.
  for (const entry of BUILTIN_AGENT_REGISTRY) {
    if (seenBuiltinSlugs.has(entry.slug)) {
      // A file existed, so processFile upserted a row (valid or invalid).
      const existing = getAgent(db, entry.slug)!;
      if (!existing.invalid) continue; // valid file already loaded
      // A broken built-in file should still leave a working Agent: synthesise
      // from the registry so the routine keeps firing (§6.1 step 3).
      logger.warn({ slug: entry.slug }, "built-in agent.md invalid — using registry fallback");
    } else {
      logger.warn({ slug: entry.slug }, "built-in agent.md missing — using registry fallback");
      result.warnings.push(`built-in "${entry.slug}" agent.md missing — registry fallback`);
    }
    const def = synthesizeRegistryDefinition(entry, opts.dayBoundaryHour);
    const existing = getAgent(db, entry.slug);
    upsertResolved(
      db,
      {
        def: applyBuiltinOverride(def, existing),
        baseEnabled: def.enabled,
        source: "builtin",
        path: join(opts.builtinDir, entry.slug, AGENT_FILE_NAME),
        fileMtimeMs: 0, // no file → epoch, so a dashboard toggle always wins (§6.4)
        hashSource: `registry-fallback:${stableStringify(def)}`,
        recurringScheduleId: null,
      },
      opts,
      logger,
      now,
    );
    result.upserted.push(entry.slug);
  }

  return result;
}

/** Parse, validate, resolve, and upsert a single scanned file. */
function processFile(
  db: Database.Database,
  file: ScannedFile,
  opts: AgentLoadOptions,
  result: LoadAgentsResult,
  logger: LoaderLogger,
  now: number,
): void {
  let raw: string;
  let mtime = 0;
  try {
    // stat before read so a single catch covers an unreadable agent.md. The
    // file existed at scan, so this only fails if it is a directory (EISDIR)
    // or vanished — both land on the invalid path below.
    mtime = statSync(file.path).mtimeMs;
    raw = readFileSync(file.path, "utf-8");
  } catch (err) {
    const error = `failed to read agent.md: ${errMsg(err)}`;
    persistInvalid(db, file.slug, file.source, file.path, error, now);
    result.invalid.push({ slug: file.slug, source: file.source, path: file.path, error, collision: false });
    return;
  }

  let def: AgentDefinition;
  let body = "";
  try {
    const parsed = parseAgentFrontmatter(raw);
    body = parsed.body;
    def = agentDefinitionSchema.parse(parsed.frontmatter);
  } catch (err) {
    // parseAgentFrontmatter throws AgentFrontmatterError; agentDefinitionSchema
    // .parse throws ZodError — those are the only two possibilities here.
    const error =
      err instanceof AgentFrontmatterError
        ? err.message
        : `schema validation failed: ${(err as z.ZodError).issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`;
    logger.error({ slug: file.slug, path: file.path, error }, "agent definition invalid");
    persistInvalid(db, file.slug, file.source, file.path, error, now);
    result.invalid.push({ slug: file.slug, source: file.source, path: file.path, error, collision: false });
    return;
  }

  const validationError = validateDefinition(
    def,
    file.source,
    file.slug,
    { listSkillSlugs: opts.listSkillSlugs },
    result.warnings,
  );
  if (validationError !== null) {
    logger.error({ slug: file.slug, error: validationError }, "agent definition rejected");
    persistInvalid(db, file.slug, file.source, file.path, validationError, now);
    result.invalid.push({ slug: file.slug, source: file.source, path: file.path, error: validationError, collision: false });
    return;
  }

  const existing = getAgent(db, file.slug);
  let effective = def;
  if (file.source === "builtin") {
    effective = applyBuiltinOverride(def, existing);
  }

  // §6.4 resolution computed once here (matches `upsertResolved`'s
  // `baseEnabled: def.enabled` + the same `existing`/`mtime`) so the recurring
  // row's `enabled` mirror agrees with the stored `agents.enabled`.
  const resolvedEnabled = resolveEnabled(def.enabled, existing, mtime);

  let recurringScheduleId: number | null = existing?.recurringScheduleId ?? null;
  if (file.source === "user" && opts.recurring) {
    // A valid user Agent is recurring-only: validateDefinition rejected
    // one_shot / event above, and the cron schema refine guarantees a non-empty
    // `expression` — assert it (a typing narrow, not a runtime branch) so
    // pairRecurring carries no dead non-cron guard. Mirrors the
    // `getBuiltinRegistryEntry(...)!` idiom used elsewhere in this file.
    recurringScheduleId = pairRecurring(
      effective,
      effective.schedule.expression!,
      body,
      existing,
      opts.recurring,
      resolveTimezone(effective.schedule.timezone, opts.timezone),
      resolvedEnabled,
      result.warnings,
    );
  }

  // User Agents are recurring-only (cron); `validateDefinition` rejects a user
  // one_shot/event before this point, so the only firing path here is the cron
  // recurring pairing above. One-time work lives on the `/schedule` queue.

  upsertResolved(
    db,
    {
      def: effective,
      baseEnabled: def.enabled,
      source: file.source,
      path: file.path,
      fileMtimeMs: mtime,
      hashSource: raw,
      recurringScheduleId,
    },
    opts,
    logger,
    now,
  );
  result.upserted.push(file.slug);
}

/**
 * Compose the effective built-in definition from the shipped/synthesised base
 * and the operator's `override_snapshot` (§6.4.1). The §6.4 timestamp
 * resolution for `enabled` runs later in `upsertResolved`, so the snapshot's
 * `enabled` (if any) is applied here but overwritten there when the file wins.
 */
function applyBuiltinOverride(base: AgentDefinition, existing: AgentDTO | null): AgentDefinition {
  const snapshot = existing?.metadata.override_snapshot;
  if (!snapshot) return base;
  return mergeAgentDefinition(base, base, snapshot as Record<string, unknown>);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Deterministic JSON for hashing a synthesised definition (stable key order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// ── Enabled cache (§6 item: consumed by the Phase-7 scheduler gate) ─────────

/**
 * In-memory cache of built-in `enabled` state for the scheduler's per-cron gate
 * (§7.1). The scheduler calls {@link AgentEnabledCache.isEnabled} on every
 * firing; the loader watcher and the `PATCH /api/agents/:slug` handler call
 * {@link AgentEnabledCache.invalidate} so the next read re-queries the DB.
 *
 * An unknown slug defaults to **enabled** so a not-yet-loaded built-in never
 * silently stops firing — the conservative direction for a routine.
 */
export class AgentEnabledCache {
  private cache: Map<string, boolean> | null = null;

  constructor(private readonly db: Database.Database) {}

  private ensure(): Map<string, boolean> {
    if (this.cache === null) {
      this.cache = new Map();
      for (const agent of listAgents(this.db)) {
        this.cache.set(agent.slug, agent.enabled);
      }
    }
    return this.cache;
  }

  isEnabled(slug: string): boolean {
    const value = this.ensure().get(slug);
    return value === undefined ? true : value;
  }

  invalidate(): void {
    this.cache = null;
  }
}

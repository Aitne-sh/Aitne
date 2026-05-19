import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type {
  Event,
  MessageEvent,
  RoutineEvent,
} from "@aitne/shared";
import {
  AGENT_ROLE_DESCRIPTOR,
  APP_NAME,
  formatAgentOutboundLabel,
  formatSqliteDatetime,
  isRoutineEvent,
  isMessageEvent,
  isScheduledDmEvent,
  isScheduledEvent,
  localDateStr,
  normalizeAgentDisplayName,
  nowInTimezone,
  getAgentDayBoundsUtc,
  getAgentDayDateStr,
  getIntegrationDescriptor,
  parseSqliteUtcMs,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { getContextDir } from "../config.js";
import { getDegradedMode } from "../db/runtime-state.js";
import { readIntegrations } from "../db/integrations-store.js";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { POLICY_FILE_MAX_BYTES } from "./policy-files.js";
import { renderOutputLanguagePolicyBlock } from "./output-language-policy.js";
import {
  getPreviousWeekIsoKey,
  loadPreviousWeekDigest,
  renderPreviousWeekBlock,
} from "./previous-week-digest.js";
import {
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  getConversationScope,
} from "../messaging/constants.js";
import type { IContextBuilder } from "./dispatcher.js";
import type { ServiceRegistry } from "../services/service-registry.js";
import type { CalendarEvent } from "../services/calendar.js";
import {
  formatForwardSuffix,
  getProactiveForwardType,
  isProactiveForwardMetadata,
  metadataDispatchIds,
  parseMessageMetadata,
} from "./channel-timeline.js";
import { createLogger } from "../logging.js";
import { truncateRoadmap } from "./roadmap-truncate.js";
import {
  readDefaultWikiWorkspace,
  readWikiWorkspaceByName,
} from "./wiki/workspaces.js";

const logger = createLogger("context-builder");
const YESTERDAY_AGENT_ACTION_LIMIT = 40;
const YESTERDAY_MESSAGE_LIMIT = 60;
const YESTERDAY_DM_LOG_LIMIT = 20;

export class ContextBuilder implements IContextBuilder {
  constructor(
    private readonly config: AgentConfig,
    private readonly db: Database.Database,
    private readonly services: ServiceRegistry,
  ) {}

  /**
   * Resolve the readable primary-vault location for prompt construction.
   *
   * During degraded mode we intentionally return `null` instead of the
   * fallback `<dataDir>/context`: reactive sessions may still run so the
   * user can fix the vault, but they must not see stale context data from
   * a legacy location.
   */
  private get readableContextDir(): string | null {
    if (getDegradedMode(this.db)) {
      return null;
    }
    return getContextDir(this.config);
  }

  async build(
    event: Event,
    opts: {
      /**
       * DM-HISTORY-CONTINUITY-FIX H-3 — when the dispatcher's fresh-execute
       * branch has already resolved that `requiresHistoryInjection=true`
       * (dashboard reset-in-place, day-boundary fall-through, etc.), the
       * cross-session bridge in `buildCrossSessionConversationHistory()`
       * is the source of truth for *every* prior message in scope. The
       * active-session-only `<conversation_history>` block would then
       * duplicate those rows under a second XML tag, with subtly
       * different rendering. Suppress it on those turns so the two
       * sources stay mutually exclusive.
       *
       * Defaults to `false`; only the dispatcher's fresh-execute call
       * site for owner / dashboard DMs sets it.
       */
      skipActiveHistoryBlock?: boolean;
    } = {},
  ): Promise<string> {
    // docs/design/appendices/fetch-window-cost-reduction.md §5 (Phase 2) — the pre-pass
    // fetcher session reads no context MD files (no `<user>` / `<today>` /
    // `<roadmap>` etc.) and writes no context paths. Its entire job is
    // "iterate <acquisition-plan>, call the bound MCP, POST to
    // /api/observations, emit one JSON line, exit." Every always-injected
    // block other than `<event_correlation_id>` + `<integration_modes>` +
    // `<acquisition-plan>` is causally unrelated to that work, so the slim
    // builder bypasses them — saves ~10 K input tokens per session and the
    // backend-neutral surface lands the same saving on Claude / Codex /
    // Gemini / OpenCode (§5.5).
    if (isRoutineEvent(event) && event.routine === "fetch_window") {
      return this.buildFetchWindowContext(event);
    }

    const sections: string[] = [];
    const degradedState = getDegradedMode(this.db);

    if (degradedState) {
      sections.push(
        [
          "<management_mode_degraded>",
          `- reason: ${degradedState.reason}`,
          `- path: ${degradedState.path ?? "(unset)"}`,
          `- since: ${degradedState.since}`,
          "Primary vault reads are disabled while Management Mode is degraded.",
          "Context files were intentionally not loaded to avoid serving stale fallback data.",
          "</management_mode_degraded>",
        ].join("\n"),
      );
    }

    // Always injected (all sessions) — B-007 §5.1 canonical paths.
    const [userMd, rulesMd, todayMd] = await Promise.all([
      this.readFile(CONTEXT_RELATIVE_PATHS.user.profile),
      this.readFile(CONTEXT_RELATIVE_PATHS.rules.management),
      this.readFile(CONTEXT_RELATIVE_PATHS.today),
    ]);
    // Capture the read time as the authoritative "as of when did this
    // conversation see today.md" anchor. Read-time (not mtime) is what the
    // freshness contract needs: mtime advances every quiet append from
    // background routines, but the value that matters here is when THIS
    // session's snapshot was taken. See STAGE-C-DM-FRESHNESS-PLAN §Task 1.
    const todayReadAt = todayMd ? new Date().toISOString() : null;

    if (userMd) sections.push(`<user>\n${userMd}\n</user>`);
    // Authoritative injection of `rules/management.md`. Task-flows
    // (`routine.morning_routine.md`, `setup.update.md`, …) reference
    // `<management_rules>` directly, so the XML form is the contract
    // surface. The policy-files registry (`policy-files.ts`)
    // intentionally does NOT re-emit this file — re-adding it there
    // would duplicate the SoT-bindings text in every session prompt.
    //
    // Size guard: design 21 §0.2 / NFR-1b requires a per-file cap on
    // management.md so a runaway hand-edit or reconciler bug cannot
    // blow up the prompt. Mirrors `POLICY_FILE_MAX_BYTES` from
    // policy-files.ts (re-imported so a future cap bump stays
    // single-source-of-change). Oversize → skip-with-warn, matching
    // the policy-files behaviour the registry entry previously
    // provided.
    //
    // Stage B (morning-routine-optimization.md §"Per-stage input
    // sketches"): `routine.morning_routine_journal` does NOT read
    // SoT bindings — it authors the daily journal from the
    // pre-aggregated `<journal_skeleton>` and `rules/journal-format.md`
    // alone. Skipping the block here keeps Stage B's prompt under the
    // lite-tier cold-start floor and matches the policy-files registry
    // opt-out (`POLICY_KEY_GLOBAL_OPTOUT`) so the two injection paths
    // agree.
    const skipManagementRulesForStageB =
      event.type === "routine.morning_routine_journal";
    if (rulesMd && !skipManagementRulesForStageB) {
      const rulesBytes = Buffer.byteLength(rulesMd, "utf-8");
      if (rulesBytes > POLICY_FILE_MAX_BYTES) {
        logger.warn(
          {
            path: CONTEXT_RELATIVE_PATHS.rules.management,
            size: rulesBytes,
            cap: POLICY_FILE_MAX_BYTES,
          },
          "rules/management.md exceeds per-file cap — skipped from <management_rules>",
        );
      } else {
        sections.push(`<management_rules>\n${rulesMd}\n</management_rules>`);
      }
    }
    if (todayMd) {
      // Truncate ## Agent Log to last N entries for non-evening sessions.
      // Evening review needs the full log to assess the day.
      const skipTruncation =
        isRoutineEvent(event) && event.routine === "evening_review";
      const injected = skipTruncation
        ? todayMd
        : truncateAgentLog(todayMd, 10);
      sections.push(
        `<today snapshot_at="${todayReadAt}">\n${injected}\n</today>`,
      );
    }
    const agentDisplayName = normalizeAgentDisplayName(
      typeof event.data.agentDisplayName === "string"
        ? event.data.agentDisplayName
        : this.config.agentDisplayName,
    );
    // Three-axis identity (see packages/shared/src/branding.ts):
    //   product = the software running this session (rebrand target)
    //   role    = LLM role anchor (kept stable across rebrands)
    //   display_name = how the agent signs messages to the operator
    // Naming each axis explicitly prevents the LLM from conflating brand
    // with role when the operator renames their instance.
    sections.push(
      [
        "<agent_identity>",
        `- product: ${APP_NAME}`,
        `- role: ${AGENT_ROLE_DESCRIPTOR} (acting on behalf of the operator)`,
        `- display_name: ${agentDisplayName}`,
        `- whatsapp_label: ${formatAgentOutboundLabel(agentDisplayName)}`,
        "</agent_identity>",
      ].join("\n"),
    );
    const now = new Date();
    const tz = this.config.timezone || undefined;
    const local = nowInTimezone(tz, now);
    const localTimeStr = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${String(local.hours).padStart(2, "0")}:${String(local.minutes).padStart(2, "0")}`;
    const tzLabel = this.config.timezone || "system";
    sections.push(`<current_time utc="${now.toISOString()}" local="${localTimeStr}" timezone="${tzLabel}" />`);

    // Agent-day date — explicit, unambiguous date for today.md line 1 and
    // every "today" reference in skills. The agent-day starts at
    // `dayBoundaryHour` (default 04:00) in `tzLabel`, so before that boundary
    // the agent-day date is the previous calendar date. Example: at 02:00
    // local on 2026-04-28 with boundary_hour=4, agent_day_date is "2026-04-27".
    // Skills MUST use this attribute (not <current_time>) for any date stamp
    // written to today.md or roadmap.md so the daemon's
    // hasCurrentAgentDayTodayMd / rotateDayFiles checks line up with what
    // the agent writes.
    const dayBoundaryHour = this.config.dayBoundaryHour ?? 4;
    const agentDayDateStr = getAgentDayDateStr(tz, dayBoundaryHour, now);
    const agentDayWeekday = new Date(`${agentDayDateStr}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });
    sections.push(
      `<current_agent_day date="${agentDayDateStr}" weekday="${agentDayWeekday}" boundary_hour="${dayBoundaryHour}" />`,
    );

    sections.push(
      `<event_correlation_id>${event.correlationId}</event_correlation_id>`,
    );
    if (event.type.startsWith("wiki.")) {
      const workspaceName =
        typeof event.data?.workspace === "string" ? event.data.workspace : "default";
      const workspace =
        readWikiWorkspaceByName(this.db, workspaceName) ??
        readDefaultWikiWorkspace(this.db);
      if (workspace) {
        sections.push(
          [
            `<wiki_workspace name="${workspace.name}" kind="${workspace.kind}" root="${workspace.root_path}" language="${workspace.language}" schema_version="${workspace.schema_version}" />`,
            `<wiki_command process_key="${event.type}">`,
            JSON.stringify(event.data ?? {}, null, 2),
            "</wiki_command>",
          ].join("\n"),
        );
      }
    }
    if (typeof event.data?.todayWriteLockId === "string") {
      sections.push(
        `<today_write_lock_id>${event.data.todayWriteLockId}</today_write_lock_id>`,
      );
    }
    if (typeof event.data?.roadmapWriteLockId === "string") {
      sections.push(
        `<roadmap_write_lock_id>${event.data.roadmapWriteLockId}</roadmap_write_lock_id>`,
      );
    }
    // cost-reduction-structural §B — Stage 3 / Stage 2-triage events
    // arrive with a pre-rendered `<gate_decision>` block from the
    // dispatcher. Inject verbatim so the routine can branch on the
    // gate's reason without re-deriving signals.
    if (
      event.data?.gateDecision &&
      typeof event.data.gateDecision === "object" &&
      typeof (event.data.gateDecision as { block?: unknown }).block === "string"
    ) {
      sections.push((event.data.gateDecision as { block: string }).block);
    }
    // docs/design/appendices/routine-data-acquisition.md §6.4 — the pre-pass fetcher
    // (`routine.fetch_window`) receives an `<acquisition-plan>` block
    // assembled by the dispatcher before this session is spawned. The
    // block carries one `<fetch>` element per (integration × mode ×
    // account) tuple the routine needs. Injected verbatim so the
    // fetcher's task-flow body and acquisition partials can iterate
    // over the rows. Always emitted when present, regardless of event
    // type — the surrounding task-flow is the only consumer.
    if (typeof event.data?.acquisitionPlanBlock === "string") {
      sections.push(event.data.acquisitionPlanBlock);
    }
    // docs/design/appendices/routine-data-acquisition.md §6.4 / Phase 4 D1 — the parent
    // routine session receives a `<fetch_report>` block summarising the
    // pre-pass run that immediately preceded it. The block carries the
    // JSON return shape (`fetched`/`posted`/`duplicates`/`errors`) so
    // the routine knows whether to trust pending observations or to
    // proceed cautiously. Injected verbatim — the dispatcher owns the
    // block's wire format.
    if (typeof event.data?.fetchReportBlock === "string") {
      sections.push(event.data.fetchReportBlock);
    }
    // morning-routine-optimization.md Phase 5 — daemon-prepared blocks
    // injected verbatim by `MorningRoutinePipelineOrchestrator` before
    // it spawns the stage sessions. `<handoff_parsed>` goes to Stage A
    // (today.md synthesis) so Step 1's prose parse becomes a structured
    // read; `<journal_skeleton>` goes to Stage B (daily journal
    // author) so the skeleton-owned frontmatter + scratch facts are
    // available without re-aggregating from SQLite. Both are fail-soft
    // — when the orchestrator omits the block (parse failure for
    // handoff; non-Stage-B event for skeleton), no string is pushed.
    if (typeof event.data?.handoffParsedBlock === "string") {
      sections.push(event.data.handoffParsedBlock);
    }
    if (typeof event.data?.journalSkeletonBlock === "string") {
      sections.push(event.data.journalSkeletonBlock);
    }

    // The <obsidian_vault_path> prompt fragment always points at the EXTERNAL
    // Obsidian vault (CLI skill target), never the agent's primary vault.
    // Kept verbatim for skill compatibility even after the field rename.
    if (this.config.externalObsidianVaultPath) {
      sections.push(
        `<obsidian_vault_path>${this.config.externalObsidianVaultPath}</obsidian_vault_path>`,
      );
    }

    // B-007 §3 P6 / §5.9 — expose the two setup-wizard answers to every
    // task-flow so prompts can branch on them without re-reading the DB.
    // `primary_language` governs user-editable prose language; `vault_mode`
    // toggles `[[wikilink]]` emission in synthesized content like daily/*.md.
    const primaryLanguage = this.config.primaryLanguage ?? "en";
    const vaultMode = this.config.vaultMode ?? "plain";
    sections.push(
      `<settings primary_language="${primaryLanguage}" vault_mode="${vaultMode}" />`,
    );

    // Single source of truth for the output-language rule (design
    // `output-language-policy.md`). Refreshed per-turn so it tracks
    // runtime `PATCH /api/config` changes to `primaryLanguage`. Task-flows
    // and skills reference `<output_language_policy>` instead of restating
    // the rule themselves.
    sections.push(renderOutputLanguagePolicyBlock(primaryLanguage));

    // Integration modes — expose the current `direct | delegated | native | disabled`
    // state of every registered integration so task-flows can branch without
    // re-reading the DB or relying on "is this MCP tool in my allowed-tools
    // list" self-introspection, which is unreliable across backends. For
    // delegated keys we emit `<key>_delegated_to="<backend>"`; for native
    // keys we emit `<key>_native_backend="<backend>"` so the native variants
    // can route per integration without reading `~/.personal-agent/integrations.md`
    // themselves (DELEGATED-MODE-V2-DESIGN.md §5.4 + INTEGRATION_NATIVE_MODE_DESIGN.md §8.2).
    sections.push(this.buildIntegrationModesBlock());

    // Routine events: additional context
    if (isRoutineEvent(event)) {
      // Silent-by-default protocol: applies uniformly to every routine
      // event (morning / evening / hourly / weekly / monthly / roadmap /
      // any future routine). The daemon does NOT forward the agent's
      // final text as a user notification for routines; POST /api/notify
      // is the only user-visible channel. Each routine prompt owns its
      // own go/no-go decision for whether to make that call. Injected
      // here instead of duplicated per-prompt so new routines inherit
      // the rule automatically.
      sections.push(
        [
          "<routine_protocol>",
          "This is an autonomous background run. Your final text response",
          "is an internal agent log — the daemon does not forward it to",
          "the user. POST /api/notify is the only user-visible channel for",
          "routine events, so if you don't call it, the user sees nothing.",
          "Each routine prompt owns the go/no-go decision for whether to",
          "call /api/notify.",
          "</routine_protocol>",
        ].join("\n"),
      );

      if (event.routine === "morning_routine") {
        // yesterday.md is created by Dispatcher.rotateDayFiles() before this runs.
        // It contains the previous day's today.md (with ## Handoff section).
        const [yesterdayMd, roadmapMd, activeProjects, yesterdaySqlite] = await Promise.all([
          this.readFile("yesterday.md"),
          this.readFile("roadmap.md"),
          this.buildActiveProjectsSection(),
          this.buildYesterdaySqliteContext(),
        ]);
        if (yesterdayMd)
          sections.push(`<yesterday>\n${yesterdayMd}\n</yesterday>`);
        sections.push(
          `<yesterday_agent_actions>\n${yesterdaySqlite.agentActions}\n</yesterday_agent_actions>`,
        );
        sections.push(
          `<yesterday_messages>\n${yesterdaySqlite.messages}\n</yesterday_messages>`,
        );
        sections.push(
          `<yesterday_dm_conversation_log>\n${yesterdaySqlite.dmConversationLog}\n</yesterday_dm_conversation_log>`,
        );
        if (roadmapMd)
          sections.push(
            `<roadmap>\n${truncateRoadmap(roadmapMd, { timezone: this.config.timezone || undefined })}\n</roadmap>`,
          );
        // morning-routine-optimization.md Phase 7 — on the first-run
        // (no-yesterday) branch the orchestrator pre-builds a
        // `<roadmap_skeleton>` block carrying the daemon-prepared
        // Annual Goals / Quarterly Focus / Preparation Timeline scratch
        // data. Stage A reads it AS WELL AS the truncated `<roadmap>`
        // above so Step 6b can detect the placeholder wizard skeleton
        // and fully populate roadmap.md from these facts. On the
        // recurring branch this key is absent and the block is omitted.
        if (typeof event.data?.roadmapSkeletonBlock === "string") {
          sections.push(event.data.roadmapSkeletonBlock);
        }
        if (activeProjects)
          sections.push(
            `<active_projects>\n${activeProjects}\n</active_projects>`,
          );

        // `docs/design/appendices/weekly-next-week-leverage.md` — every
        // morning of the new ISO week, lift the prior week's import-
        // targeted sections (Carry Over / Next Week Focus / Lessons)
        // from `weekly/YYYY-W{prev}.md` and inject them as a small
        // `<previous_week>` block. Same file Mon–Sun within the week;
        // helper rolls forward automatically when the daemon clock
        // crosses Monday 00:00 local. Null when the prior week's file
        // is missing (e.g. daemon was down through Friday or the
        // catchup window — see schedule-helpers.ts) — block injection
        // is skipped silently and morning_routine proceeds normally.
        const previousWeekKey = getPreviousWeekIsoKey(
          this.config.timezone || undefined,
        );
        const readableContextDir = this.readableContextDir;
        if (readableContextDir) {
          const previousWeekDigest = await loadPreviousWeekDigest(
            readableContextDir,
            previousWeekKey,
          );
          if (previousWeekDigest) {
            sections.push(renderPreviousWeekBlock(previousWeekDigest));
          }
        }

        // Fetch 7-day calendar events for today.md / roadmap.md updates.
        // For direct mode, ContextBuilder pre-fetches inline events via
        // the daemon's CalendarService. For non-direct modes the
        // `routine.morning_routine` pre-pass (ROUTINE_WINDOWS carries
        // `cal_morning_7d` since A8 / Finding 5) posts events to
        // `/api/observations`; the sub-block then points the agent at
        // the observations table instead of emitting a "fetch yourself"
        // directive that would force Sonnet to drive the MCP fan-out.
        sections.push(
          await this.buildCalendarBlock(7, "calendar_events_7d", true),
        );
      } else if (event.routine === "morning_routine_journal") {
        // morning-routine-optimization.md Phase 5 — Stage B (daily
        // journal author). Reads `<journal_skeleton>` (injected via
        // event.data.journalSkeletonBlock above) as primary input and
        // needs `<calendar_events_7d>` to resolve `[[wikilink]]`s for
        // attended events under `vault_mode === "obsidian"`. Deliberately
        // does NOT load yesterday.md, roadmap.md, active_projects, or
        // SQLite yesterday snapshots — Stage A owns the forward-facing
        // synthesis; Stage B's input set is intentionally minimal so the
        // lite-tier cold-start floor is cleared (see design §"Per-stage
        // input sketches").
        sections.push(
          await this.buildCalendarBlock(7, "calendar_events_7d", true),
        );
      } else if (event.routine === "roadmap_refresh") {
        const [roadmapMd, activeProjects] = await Promise.all([
          this.readFile("roadmap.md"),
          this.buildActiveProjectsSection(),
        ]);
        // Roadmap refresh must see the full file — the session
        // regenerates `## Agent Action Plan` wholesale, so any entry the
        // truncator dropped would be erased on PUT. Do NOT truncate here.
        if (roadmapMd) sections.push(`<roadmap>\n${roadmapMd}\n</roadmap>`);
        if (activeProjects)
          sections.push(
            `<active_projects>\n${activeProjects}\n</active_projects>`,
          );

        // 7-day DM rolling-summary window. RFC-B Phase 1 wants the
        // refresh to incorporate long-horizon intent captured in recent
        // DMs; the rolling summaries in dm_conversation_log are the
        // cheapest source (already AI-condensed by the dispatcher).
        const dmLog7d = this.buildRecentDmConversationLog(7);
        sections.push(
          `<recent_dm_conversation_log days="7">\n${dmLog7d}\n</recent_dm_conversation_log>`,
        );

        // 90-day multi-provider calendar window — same shape as morning /
        // evening / weekly / monthly so every review-style routine sees one
        // uniform, mode-aware surface. The block embeds per-(provider, mode)
        // directives: direct mode inlines events, delegated / native mode
        // emit MCP / proxy fetch directives, disabled providers are
        // omitted, and when zero providers are active the helper falls back
        // to the legacy `<calendar_status>not available>` form — which the
        // task-flow prose recognises as the "skip calendar steps" signal.
        // This unification eliminates the pre-fix asymmetry where the
        // 3-arm hardcoded conditional silently filed native bindings under
        // the else branch and emitted "preserve existing roadmap content",
        // bricking roadmap.md generation for native-mode operators.
        sections.push(await this.buildCalendarBlock(90, "calendar_events_90d"));
      } else if (event.routine === "evening_review") {
        const [roadmapMd, activeProjects] = await Promise.all([
          this.readFile("roadmap.md"),
          this.buildActiveProjectsSection(),
        ]);
        if (roadmapMd)
          sections.push(
            `<roadmap>\n${truncateRoadmap(roadmapMd, { timezone: this.config.timezone || undefined })}\n</roadmap>`,
          );
        if (activeProjects)
          sections.push(
            `<active_projects>\n${activeProjects}\n</active_projects>`,
          );

        // 3-day calendar look-ahead for evening review. Delegated mode emits
        // an MCP-fetch directive inside the same block so the flow works
        // without a routine-specific delegated variant.
        sections.push(await this.buildCalendarBlock(3, "calendar_events_3d"));
      } else if (event.routine === "user_profile_sweep") {
        // Both phases read the same current-agent-day bounds at session
        // start — the phase flag is preserved for journaling only and
        // does not branch the window. The guard below exists purely as
        // a misconfig fuse: if the event arrives without a valid phase
        // (e.g. a manual trigger that didn't thread `data.phase`), skip
        // the injection so the task-flow's Step 1 abort path (USER-PROFILE-
        // CAPTURE-PLAN.md §2.3 Step 1 / §2.4) fires as documented rather
        // than silently running the sweep with an unlabeled log line.
        const phase = (event.data as { phase?: unknown })?.phase;
        if (phase === "morning" || phase === "evening") {
          const agentDayDm = this.buildAgentDayDmContext();
          sections.push(
            `<agent_day_messages>\n${agentDayDm.messages}\n</agent_day_messages>`,
          );
          sections.push(
            `<agent_day_dm_conversation_log>\n${agentDayDm.dmConversationLog}\n</agent_day_dm_conversation_log>`,
          );
        } else {
          logger.warn(
            { phase, correlationId: event.correlationId },
            "user_profile_sweep event missing valid phase — skipping window injection",
          );
        }
      } else if (event.routine === "today_refresh") {
        // docs/design/appendices/routine-data-acquisition.md Phase 4 / Phase 3 R3 —
        // dashboard-triggered manual refresh. The pre-pass fetcher
        // (`routine.fetch_window`) acquires the day's calendar window
        // for every active calendar provider ahead of this session and
        // POSTs results to `/api/observations`; the `<fetch_report>`
        // block injected just above tells the routine whether the
        // pre-pass succeeded. The legacy per-mode REST recipe in this
        // hint encouraged the routine to re-fetch on its own — wasteful
        // since the server's `contentHash` would 409 every row, and
        // misleading after partials were lifted to the pre-pass per
        // §6.8. The narrowed hint below documents the post-Phase-4
        // contract: read pending observations, consult `<fetch_report>`
        // for status, skip the rewrite when no calendar provider is
        // configured at all (covered by `<integration_modes>` already,
        // but kept here as a one-line breadcrumb for the routine prose).
        sections.push(
          `<calendar_status>Pre-pass populated calendar observations ahead of this session. Read GET /api/observations?pending=true&source_prefix=google_calendar:,outlook_calendar: and consult <fetch_report> for pre-pass status. If <fetch_report status="failed"> or no rows, log a one-line skip to ## Agent Log and leave User Schedule untouched.</calendar_status>`,
        );
      } else if (
        event.routine === "weekly_review" ||
        event.routine === "monthly_review"
      ) {
        const [roadmapMd, activeProjects] = await Promise.all([
          this.readFile("roadmap.md"),
          this.buildActiveProjectsSection(),
        ]);
        if (roadmapMd)
          sections.push(
            `<roadmap>\n${truncateRoadmap(roadmapMd, { timezone: this.config.timezone || undefined })}\n</roadmap>`,
          );
        if (activeProjects) {
          sections.push(
            `<active_projects>\n${activeProjects}\n</active_projects>`,
          );
        }

        const lookaheadDays = event.routine === "monthly_review" ? 30 : 7;
        sections.push(
          await this.buildCalendarBlock(
            lookaheadDays,
            `calendar_events_${lookaheadDays}d`,
          ),
        );
      }
    }

    // Agent task / DM-tone events: inject live calendar + origin
    // metadata for informed execution. Both scheduled.task and
    // scheduled.dm need this — without it, scheduled sessions would
    // execute "blind" knowing only today.md (which may be stale) and
    // the task description (which may be terse).
    if (isScheduledEvent(event)) {
      // 1-day live calendar — critical for temporal awareness (meetings,
      // conflicts). Delegated mode emits an MCP-fetch directive inside the
      // same block.
      sections.push(await this.buildCalendarBlock(1, "calendar_today"));

      // Task origin metadata — tells the agent WHO scheduled this
      sections.push(
        `<task_origin source="${event.source}" schedule_id="${event.scheduleId ?? "none"}" />`,
      );
      sections.push(
        `<task_context>\n${JSON.stringify(event.taskContext ?? {}, null, 2)}\n</task_context>`,
      );

      // Dashboard regeneration tasks additionally get roadmap + projects
      // (Calendar data is already embedded in the task description by the API endpoint)
      if (event.source === "dashboard_regenerate") {
        const [roadmapMd, activeProjects] = await Promise.all([
          this.readFile("roadmap.md"),
          this.buildActiveProjectsSection(),
        ]);
        if (roadmapMd) sections.push(`<roadmap>\n${roadmapMd}\n</roadmap>`);
        if (activeProjects)
          sections.push(
            `<active_projects>\n${activeProjects}\n</active_projects>`,
          );
      }

      // SCHEDULED-DM-IMPLEMENTATION-PLAN §3.3 / §5.7 — DM-tone
      // sessions additionally see the user's recent DM activity and
      // the rolling owner-DM history so the LLM can detect the
      // conversation state (asleep vs. active vs. very-recent) and
      // pick Variant A (greeting) vs. Variant B (mid-conversation
      // weave) per the scheduled.dm.md task-flow.
      if (isScheduledDmEvent(event)) {
        const recentDms = this.buildRecentDmActivityBlock(60);
        if (recentDms) {
          sections.push(
            `<recent_dm_messages window="60min">\n${recentDms}\n</recent_dm_messages>`,
          );
        }
        const dmHistory = this.buildOwnerDmConversationHistory(20);
        if (dmHistory) {
          sections.push(
            `<recent_dm_conversation>\n${dmHistory}\n</recent_dm_conversation>`,
          );
        }
      }
    }

    // Message events: include conversation history from the active session.
    // Cross-session continuity (expired/closed sessions) is handled separately
    // by the dispatcher's buildCrossSessionConversationHistory(), which injects
    // history via the backend's conversationHistory parameter. Doing it here
    // as well would duplicate the data under two different XML tags.
    if (isMessageEvent(event)) {
      if (!opts.skipActiveHistoryBlock) {
        const history = this.getConversationHistory(event);
        if (history) {
          sections.push(
            `<conversation_history>\n${history}\n</conversation_history>`,
          );
        }
      }
      // <recent_other_surface> stays even when the active block is
      // suppressed: it covers the OTHER DM surface (dashboard ↔ owner)
      // and never overlaps with the cross-session bridge (which scopes
      // to the current surface).
      const otherSurface = this.buildRecentOtherSurfaceBlock(event);
      if (otherSurface) {
        sections.push(
          `<recent_other_surface>\n${otherSurface}\n</recent_other_surface>`,
        );
      }
    }

    return sections.join("\n\n");
  }

  /**
   * DM-HISTORY-CONTINUITY-FIX H-2 — narrow companion to `build()` for the
   * resume path. Emits only the new information the SDK session does not
   * already have: proactive forwards (including `scheduled_dm`) that
   * landed in this scope OR the cross-surface DM scope *after* the
   * resumed session was started.
   *
   * Why this is its own builder, not `build()` with a flag:
   *   - On resume, the SDK ships the cached system prompt (and the
   *     `<conversation_history>` / `<recent_other_surface>` blocks it
   *     was built with) untouched. Concatenating the full `build()`
   *     output onto the user turn re-bills every always-injected
   *     block against the user-turn payload, killing prompt-cache
   *     savings AND duplicating `<conversation_history>` content the
   *     SDK session already holds.
   *   - The catchup payload is ~few hundred tokens vs. ~10 K for the
   *     full build, on a hot path that fires whenever there's a
   *     recent proactive forward (~half of dashboard turns in
   *     practice).
   *
   * `sessionStartedAtMs` should be the session row's `started_at`
   * (not `last_message_at`) — `started_at` is fixed at session start
   * and doesn't race with concurrent inserts. Returns `null` when no
   * forwards landed after the anchor.
   */
  async buildResumeCatchupContext(
    event: Event,
    sessionStartedAtMs: number,
  ): Promise<string | null> {
    if (!isMessageEvent(event) || !event.isDm) return null;
    const { scope, scopeKey } = getConversationScope({
      platform: event.platform,
      channel: event.channel,
      threadId: event.threadId,
      isDm: true,
      intent: event.intent,
    });
    const other =
      scope === OWNER_DM_SCOPE
        ? { scope: DASHBOARD_CHAT_SCOPE, scopeKey: DASHBOARD_SCOPE_KEY }
        : scope === DASHBOARD_CHAT_SCOPE
          ? { scope: OWNER_DM_SCOPE, scopeKey: OWNER_SCOPE_KEY }
          : null;

    const sinceUtc = formatSqliteDatetime(new Date(sessionStartedAtMs));
    const scopeFilters: Array<{ scope: string; scopeKey: string }> = [
      { scope, scopeKey },
    ];
    if (other) scopeFilters.push(other);
    const placeholders = scopeFilters
      .map(() => "(s.scope = ? AND s.scope_key = ?)")
      .join(" OR ");
    const params: unknown[] = [];
    for (const filter of scopeFilters) {
      params.push(filter.scope, filter.scopeKey);
    }
    params.push(sinceUtc);

    const rows = this.db
      .prepare(
        `SELECT
           m.session_id,
           m.role,
           m.content,
           m.platform,
           m.timestamp,
           m.metadata,
           s.scope,
           s.backend_session_id
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE (${placeholders})
           AND m.role = 'assistant'
           AND m.timestamp > ?
         ORDER BY m.timestamp ASC, m.id ASC
         LIMIT 30`,
      )
      .all(...params) as Array<{
        session_id: number;
        role: string;
        content: string;
        platform: string;
        timestamp: string;
        metadata: string | null;
        scope: string;
        backend_session_id: string | null;
      }>;

    const forwards = rows.filter((r) =>
      isProactiveForwardMetadata(parseMessageMetadata(r.metadata)),
    );
    if (forwards.length === 0) return null;

    const proactiveRows: Array<{
      sessionId: number;
      dispatchIds: string[];
      sessionResumed: boolean;
    }> = [];
    const lines = forwards.map((r) => {
      const metadata = parseMessageMetadata(r.metadata);
      proactiveRows.push({
        sessionId: r.session_id,
        dispatchIds: metadataDispatchIds(metadata),
        sessionResumed: r.backend_session_id !== null,
      });
      const suffix = formatForwardSuffix(metadata);
      const scopeTag = r.scope === scope ? "this surface" : "other surface";
      return `[${r.timestamp}] [assistant → ${r.platform}, ${scopeTag}]${suffix}: ${r.content}`;
    });
    if (proactiveRows.length > 0) {
      this.logProactiveForwardInjected(proactiveRows);
    }

    return [
      "<proactive_forwards_since_last_turn>",
      "Background notifications and scheduled DMs dispatched on your",
      "behalf while this session was idle. The owner has now replied —",
      "these may or may not be the referent of that reply.",
      ...lines,
      "</proactive_forwards_since_last_turn>",
    ].join("\n");
  }

  /**
   * Slim context for `routine.fetch_window` (Phase 2 — see
   * docs/design/appendices/fetch-window-cost-reduction.md §5). Emits only the three
   * blocks the pre-pass session causally depends on:
   *
   *  - `<event_correlation_id>` — required for `/api/observations` POSTs
   *    so dispatched observations attribute back to the same parent run.
   *  - `<integration_modes>` — the partial bodies inlined into the
   *    fetcher's user prompt branch on `direct` / `delegated` / `native`
   *    per integration; without this block the partial cannot pick a
   *    mode-arm. Also the only block that reads from the DB on this path.
   *  - `<acquisition-plan>` — verbatim block from
   *    `event.data.acquisitionPlanBlock`, assembled by the dispatcher
   *    before the sub-session spawns. Carries one `<fetch>` row per
   *    (integration × mode × account) tuple. Absent only on the empty-plan
   *    short-circuit (`routine-fetch-window-runner.ts:buildFanOutPlanContext`),
   *    in which case the slim path emits two blocks instead of three.
   *
   * Skipped relative to the wide path (and why each is safe to drop):
   *  - `<management_mode_degraded>` — fetch_window does not read context
   *    MD files; degraded mode is informational for vault-touching flows.
   *  - `<user>` / `<management_rules>` / `<today>` — operator profile +
   *    rules + day-log are irrelevant to "fetch new messages since X".
   *  - `<agent_identity>` / `<current_time>` / `<current_agent_day>` —
   *    the per-fetch `<fetch>` row carries its own `since` / `before`
   *    timestamps; the fetcher does not introspect "what time is it".
   *  - `<settings>` / `<output_language_policy>` — output is structural
   *    JSON (`{fetched, posted, duplicates, errors}`); the language
   *    policy only governs user-facing prose.
   *  - `<routine_protocol>` — silent-by-default + "POST /api/notify is
   *    the only user channel" — fetch_window never POSTs to /api/notify;
   *    the protocol matters for the parent routine, not the pre-pass.
   *  - `<obsidian_vault_path>` — fetcher does not touch the vault.
   *  - `<today_write_lock_id>` / `<roadmap_write_lock_id>` — locks are
   *    parent-routine concerns; fetcher writes nothing to MD files.
   *  - `<gate_decision>` / `<fetch_report>` — pre-pass-related blocks
   *    consumed by the parent routine, not by the pre-pass itself.
   *
   * Backend-neutral by construction: this string is passed verbatim to
   * `core.execute(...)` for whichever backend resolved the binding
   * (`routine-fetch-window-runner.ts:1529`). Same saving lands on Claude
   * (cache_creation) and on Codex / Gemini / OpenCode (raw input tokens).
   */
  private buildFetchWindowContext(event: RoutineEvent): string {
    const sections: string[] = [
      `<event_correlation_id>${event.correlationId}</event_correlation_id>`,
      this.buildIntegrationModesBlock(),
    ];
    if (typeof event.data?.acquisitionPlanBlock === "string") {
      sections.push(event.data.acquisitionPlanBlock);
    }
    return sections.join("\n\n");
  }

  /**
   * Render the `<integration_modes ... />` element used by both the wide
   * build path and the fetch_window slim path. Centralised so the slim
   * path cannot drift from the wide path's attribute shape — both routes
   * read from the same `readIntegrations(db)` snapshot and emit
   * `key="mode"` plus the optional `_delegated_to` / `_native_backend`
   * attributes per state.
   */
  private buildIntegrationModesBlock(): string {
    const integrationsSnapshot = readIntegrations(this.db);
    const integrationAttrs = Object.entries(integrationsSnapshot)
      .flatMap(([key, state]) => {
        const attrs = [`${key}="${state.mode}"`];
        if (state.mode === "delegated" && state.delegatedBackend) {
          attrs.push(`${key}_delegated_to="${state.delegatedBackend}"`);
        }
        if (state.mode === "native" && state.nativeBackend) {
          attrs.push(`${key}_native_backend="${state.nativeBackend}"`);
        }
        return attrs;
      })
      .join(" ");
    return `<integration_modes ${integrationAttrs} />`;
  }

  /**
   * Compute the calendar lookahead window anchored at the user-timezone
   * midnight boundary. Shared by direct-mode fetches and the delegated-mode
   * MCP-fetch directive so both paths describe exactly the same range.
   */
  private computeCalendarWindow(days: number): { timeMin: string; timeMax: string } {
    const tz = this.config.timezone || undefined;
    const dayBounds = getAgentDayBoundsUtc(tz, 0);
    const startMs = parseSqliteUtcMs(dayBounds.start);
    return {
      timeMin: new Date(startMs).toISOString(),
      timeMax: new Date(startMs + days * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  /**
   * Build a `<calendar_events_…>` context block honouring every active
   * calendar provider × mode cell.
   *
   * docs/design/appendices/routine-data-acquisition.md §6.6 — the block wraps one
   * `<provider key="…" mode="…">…</provider>` sub-block per active
   * provider so the parent routine sees a uniform shape regardless of
   * which provider(s) the operator has configured. Per-provider body:
   *
   *  - **direct + matching service available** → inline formatted event
   *    list fetched by the daemon's `services.calendar` (Google today;
   *    Outlook gets the same path once a dedicated `services.outlookCalendar`
   *    lands — for now Outlook direct mode emits a service-unavailable
   *    note so the flow degrades gracefully).
   *  - **delegated** → a structured directive instructing the agent to
   *    call the relevant MCP tool (same-backend) or the daemon's
   *    `/api/integrations/<key>/exec` proxy (cross-backend). For
   *    `userManagedConnector` providers (Outlook today) the proxy
   *    branch is suppressed — same-backend and cross-backend collapse
   *    onto the session's MCP.
   *  - **native** → directive that points at the session backend's MCP
   *    only. No daemon proxy: native bindings never fall back to the
   *    daemon (R7 from the design doc).
   *  - **disabled** → provider sub-block omitted entirely.
   *
   * When no provider is active, emit the legacy
   * `<calendar_status>not available</calendar_status>` so routine flows
   * that branch on the unavailable marker keep working.
   *
   * All callers funnel through this method so the three surfaces
   * (morning / evening / weekly+monthly and the agent-task path) stay
   * in lock-step when integration handling changes.
   */
  /**
   * Build a `<calendar_events_*>` context block honouring every active
   * provider's mode.
   *
   * `prepassCovers` — A8 / Finding 5. When `true`, the caller's
   * `ROUTINE_WINDOWS` entry includes a calendar row, so the
   * `routine.fetch_window` pre-pass has already POSTed events to
   * `/api/observations` for every non-direct provider. Non-direct
   * provider sub-blocks then emit a "read observations" hint instead
   * of the legacy "fetch yourself" directive. Direct providers are
   * unchanged — ContextBuilder still pre-fetches inline events via
   * `services.calendar` (Google) and emits the fallback hint for
   * Outlook (no daemon-side service yet). The flag has no effect on
   * direct-mode sub-blocks. Default `false` for callers that don't
   * have pre-pass coverage (today_refresh, weekly/monthly_review,
   * roadmap_refresh).
   */
  private async buildCalendarBlock(
    days: number,
    blockName: string,
    prepassCovers = false,
  ): Promise<string> {
    const integrations = readIntegrations(this.db);
    const { timeMin, timeMax } = this.computeCalendarWindow(days);

    const subblocks: string[] = [];
    const googleSub = await this.buildCalendarProviderBlock(
      "google_calendar",
      "Google Calendar",
      integrations.google_calendar?.mode ?? "disabled",
      days,
      timeMin,
      timeMax,
      prepassCovers,
    );
    if (googleSub) subblocks.push(googleSub);
    const outlookSub = await this.buildCalendarProviderBlock(
      "outlook_calendar",
      "Outlook Calendar",
      integrations.outlook_calendar?.mode ?? "disabled",
      days,
      timeMin,
      timeMax,
      prepassCovers,
    );
    if (outlookSub) subblocks.push(outlookSub);

    if (subblocks.length === 0) {
      // Match the legacy single-line shape so existing prose that greps
      // for `<calendar_status>not available` keeps matching.
      return `<calendar_status>Calendar service not available. No calendar provider is configured for this window.</calendar_status>`;
    }
    return [
      `<${blockName} days="${days}" timeMin="${timeMin}" timeMax="${timeMax}">`,
      ...subblocks,
      `</${blockName}>`,
    ].join("\n");
  }

  /**
   * Emit one provider sub-block for `buildCalendarBlock`. Returns null
   * when the provider is disabled (or, for native mode, the binding
   * does not apply to a meaningful path — the agent reads
   * `<integration_modes>` to decide whether its session backend is the
   * native one).
   */
  private async buildCalendarProviderBlock(
    key: "google_calendar" | "outlook_calendar",
    displayName: string,
    mode: "direct" | "delegated" | "native" | "disabled",
    days: number,
    timeMin: string,
    timeMax: string,
    prepassCovers = false,
  ): Promise<string | null> {
    if (mode === "disabled") return null;

    const open = `  <provider key="${key}" mode="${mode}">`;
    const close = "  </provider>";

    // A8 / Finding 5 — when the parent routine's pre-pass owns the
    // calendar window AND this provider is non-direct, the pre-pass
    // has already POSTed events to /api/observations. Replace the
    // legacy "fetch yourself" directive with a hint pointing at
    // observations so the main routine session never re-drives the
    // MCP fan-out (the cost regression that motivated this flag).
    if (prepassCovers && (mode === "delegated" || mode === "native")) {
      return [
        open,
        `${displayName} ${mode} mode — the routine.fetch_window pre-pass`,
        `posted events for [${timeMin}, ${timeMax}) to /api/observations`,
        `under source_prefix \`${key}:\`. Read them via:`,
        `  GET http://localhost:8321/api/observations?pending=true&source_prefix=${key}:&limit=200`,
        `Consult \`<fetch_report>\` injected above for pre-pass status; on`,
        `status="failed" or "skipped" treat this provider as unavailable for`,
        `the window and log a one-line skip to \`## Agent Log\` instead of`,
        `re-driving the connector yourself. Do NOT call /api/calendar/* or`,
        `/api/integrations/*/exec — those return 410 in this mode.`,
        close,
      ].join("\n");
    }

    if (mode === "direct") {
      // Today only `services.calendar` (Google) is wired. Outlook direct
      // mode reaches `GET /api/calendar/outlook` from the task flow; the
      // context block surfaces a service-status hint until a daemon-side
      // CalendarService for Outlook lands. Either way the agent can fall
      // back to its own direct REST call from the task flow.
      if (key === "google_calendar" && this.services.calendar) {
        const inline = await this.fetchCalendarEvents(days);
        if (inline !== null) {
          return [open, inline, close].join("\n");
        }
      }
      return [
        open,
        `${displayName}: direct mode, daemon service not initialized for this window.`,
        `Fetch yourself via the task flow's direct-mode endpoint (Google: /api/calendar/events; Outlook: /api/calendar/outlook).`,
        close,
      ].join("\n");
    }

    if (mode === "delegated") {
      // CLAUDE.md: "Never hardcode an integration reference outside the
      // registry." `userManagedConnector` is the registry's source of
      // truth for whether the daemon ships a `/api/integrations/<key>/
      // exec` proxy. Reading it from the descriptor means a future
      // user-managed integration (Proton, custom MCP, etc.) inherits
      // the right branch without touching this method.
      const isUserManaged =
        getIntegrationDescriptor(key).userManagedConnector === true;
      const lines: string[] = [
        open,
        `${displayName} is delegated — see \`<integration_modes>\`. Fetch the window`,
        `(timeMin=${timeMin}, timeMax=${timeMax}) and treat the returned events as`,
        `the contents of this provider block for the rest of the task flow.`,
        "",
        "  Same-backend (delegated_to == your session backend) — use your",
        `  session's ${displayName} MCP tool (whichever your skills document).`,
      ];
      if (!isUserManaged) {
        lines.push(
          "",
          "  Cross-backend (delegated_to != your session backend) — call",
          "  the daemon's task-mode endpoint so the configured account is used:",
          `    POST http://localhost:8321/api/integrations/${key}/exec`,
          `      task: List every event between ${timeMin} and ${timeMax}.`,
          `      outputSchema: { events: [ { id, title, start, end } ] }`,
          `    Do NOT call /api/calendar/* (returns 410 in delegated mode).`,
        );
      } else {
        lines.push(
          "",
          "  Cross-backend: not available for Outlook (user-managed connector,",
          "  no daemon proxy). Fall through to the session's MCP regardless.",
        );
      }
      lines.push(
        "",
        "If the call errors out, log one line to `## Agent Log` and proceed",
        "as if the window were empty.",
        close,
      );
      return lines.join("\n");
    }

    // mode === "native"
    return [
      open,
      `${displayName} is in native mode — see \`<integration_modes>.${key}_native_to\`.`,
      `Fetch this window (timeMin=${timeMin}, timeMax=${timeMax}) yourself via your`,
      `session backend's ${displayName} MCP surface. Do NOT call /api/calendar/*`,
      `or /api/integrations/*/exec — native mode has no daemon proxy.`,
      "",
      `If the native binding does not match your session backend (check`,
      `\`${key}_native_to\`), treat this provider as unavailable for this turn`,
      `and log one line to \`## Agent Log\`.`,
      close,
    ].join("\n");
  }

  /**
   * Fetch calendar events for the next N days and format as markdown.
   * Groups events by date with day-of-week and Today/Tomorrow labels.
   * Returns null if CalendarService is not available.
   */
  private async fetchCalendarEvents(days: number): Promise<string | null> {
    if (!this.services.calendar) return null;

    try {
      const { timeMin, timeMax } = this.computeCalendarWindow(days);

      const events = await this.services.calendar!.listEvents(timeMin, timeMax);

      if (events.length === 0) {
        return `Calendar connected (Google Calendar). No events found in the next ${days} days.`;
      }

      return this.formatCalendarEvents(events, days);
    } catch (err) {
      logger.warn(
        { err },
        "Failed to fetch calendar events for context",
      );
      return null;
    }
  }

  /** Format calendar events grouped by date */
  private formatCalendarEvents(events: CalendarEvent[], days: number): string {
    const now = new Date();
    const tz = this.config.timezone || undefined;
    const todayStr = localDateStr(now, tz);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = localDateStr(tomorrow, tz);

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    // Group events by local date in the configured timezone.
    const byDate = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      if (!event.start) continue;
      const dateStr =
        event.start.length === 10
          ? event.start
          : localDateStr(new Date(event.start), tz);
      const group = byDate.get(dateStr) ?? [];
      group.push(event);
      byDate.set(dateStr, group);
    }

    const lines: string[] = [];

    // Generate all dates in range
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() + i);
      const dateStr = localDateStr(date, tz);
      const localInfo = nowInTimezone(tz, date);
      const dayName = dayNames[localInfo.dayOfWeek];

      let label = "";
      if (dateStr === todayStr) label = " — Today";
      else if (dateStr === tomorrowStr) label = " — Tomorrow";

      lines.push(`## ${dateStr} (${dayName})${label}`);

      const dayEvents = byDate.get(dateStr);
      if (!dayEvents || dayEvents.length === 0) {
        lines.push("- (no events)");
      } else {
        for (const event of dayEvents) {
          const timeRange = this.formatTimeRange(event);
          const summary = event.summary ?? "Untitled";
          const locationPart = event.location ? ` @ ${event.location}` : "";
          lines.push(`- ${timeRange} ${summary}${locationPart}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  /** Format event time range as "HH:MM–HH:MM" or "All day" */
  private formatTimeRange(event: CalendarEvent): string {
    if (!event.start || !event.end) return "All day";
    // All-day events have date format (YYYY-MM-DD) without time component
    if (event.start.length === 10) return "All day";

    const startDate = new Date(event.start);
    const endDate = new Date(event.end);
    const startTime = this.formatLocalTime(startDate);
    const endTime = this.formatLocalTime(endDate);
    return `${startTime}\u2013${endTime}`;
  }

  private formatLocalTime(date: Date): string {
    const local = nowInTimezone(this.config.timezone || undefined, date);
    return `${String(local.hours).padStart(2, "0")}:${String(local.minutes).padStart(2, "0")}`;
  }

  /**
   * SCHEDULED-DM-IMPLEMENTATION-PLAN §5.7 — return inbound owner-DM
   * messages received in the last `windowMinutes` across BOTH
   * owner-facing scopes (`owner_dm` for messaging-app DMs and
   * `dashboard_chat` for the dashboard chat panel), formatted one per
   * line oldest first. Returns null when there are no messages so the
   * caller can omit the block entirely.
   *
   * The two-scope query mirrors §3.6's gate set: the briefing
   * serializes behind both surfaces, so the LLM must see both
   * surfaces when classifying conversation state. A single-scope read
   * here would mis-classify state as `asleep` whenever the user is
   * mid-conversation on the OTHER surface — exactly the
   * voice-mismatch failure the design exists to fix.
   *
   * `docs_qa` is intentionally excluded — that surface is research
   * lookups, not conversation; gating against it would freeze
   * briefings during long doc-searches.
   */
  private buildRecentDmActivityBlock(windowMinutes: number): string | null {
    const sinceUtc = formatSqliteDatetime(
      new Date(Date.now() - windowMinutes * 60_000),
    );
    const rows = this.db
      .prepare(
        `SELECT m.role, m.content, m.timestamp
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE s.scope IN (?, ?) AND m.role = 'user' AND m.timestamp >= ?
         ORDER BY m.timestamp ASC
         LIMIT 30`,
      )
      .all(OWNER_DM_SCOPE, DASHBOARD_CHAT_SCOPE, sinceUtc) as {
        role: string;
        content: string;
        timestamp: string;
      }[];

    if (rows.length === 0) return null;
    return rows
      .map((r) => `[${r.timestamp}] ${truncateForBlock(r.content, 200)}`)
      .join("\n");
  }

  /**
   * SCHEDULED-DM-IMPLEMENTATION-PLAN §5.7 — return the last `limit`
   * owner-facing messages across BOTH `owner_dm` and `dashboard_chat`
   * scopes (interleaved by timestamp), formatted with role tags. Used
   * by `<recent_dm_conversation>` for topic awareness in the bridge
   * phrasing of Variant B briefings.
   *
   * Two-scope read — same reasoning as `buildRecentDmActivityBlock`:
   * the briefing must reconstruct topic context from whichever surface
   * the user has been using, not just the messaging-app one.
   */
  private buildOwnerDmConversationHistory(limit: number): string | null {
    const rows = this.db
      .prepare(
        `SELECT m.role, m.content, m.timestamp, m.metadata
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE (s.scope = ? AND s.scope_key = ?)
            OR (s.scope = ? AND s.scope_key = ?)
         ORDER BY m.timestamp DESC, m.id DESC
         LIMIT ?`,
      )
      .all(
        OWNER_DM_SCOPE,
        OWNER_SCOPE_KEY,
        DASHBOARD_CHAT_SCOPE,
        DASHBOARD_SCOPE_KEY,
        limit,
      ) as {
        role: string;
        content: string;
        timestamp: string;
        metadata: string | null;
      }[];

    if (rows.length === 0) return null;
    return rows
      .reverse()
      .map((r) => {
        const forwardSuffix =
          r.role === "assistant"
            ? formatForwardSuffix(parseMessageMetadata(r.metadata))
            : "";
        return `[${r.timestamp}] [${r.role}]${forwardSuffix}: ${truncateForBlock(r.content, 400)}`;
      })
      .join("\n");
  }

  private getConversationHistory(event: MessageEvent): string | null {
    const maxMessages = this.config.historyInjectionMaxMessages ?? 50;

    let rows: {
      session_id: number;
      timestamp: string;
      role: string;
      content: string;
      platform: string;
      metadata: string | null;
      backend: string | null;
      model_id: string | null;
      backend_session_id: string | null;
    }[];

    if (event.isDm) {
      const { scope, scopeKey } = getConversationScope({
        platform: event.platform,
        channel: event.channel,
        threadId: event.threadId,
        isDm: true,
        // Without `intent`, a docs_qa event would query under
        // `dashboard_chat` and inject chat history into the QA prompt
        // (or miss its own QA history). Thread it through so each
        // dashboard scope retrieves only its own conversation.
        intent: event.intent,
      });
      // DM: load the active conversation for the matching DM surface.
      rows = this.db
        .prepare(
          `SELECT
             m.session_id,
             m.role,
             m.content,
             m.platform,
             m.timestamp,
             m.metadata,
             m.backend,
             m.model_id,
             s.backend_session_id
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
           WHERE s.scope = ? AND s.scope_key = ? AND s.status = 'active'
           ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`,
        )
        .all(scope, scopeKey, maxMessages) as typeof rows;
    } else {
      // Non-DM: query by (platform, channel, thread).
      // Hard-cap at 20 — threads are short-lived and higher limits risk
      // injecting stale context from unrelated earlier threads.
      const threadLimit = Math.min(maxMessages, 20);
      rows = this.db
        .prepare(
          `SELECT
             m.session_id,
             m.role,
             m.content,
             m.platform,
             m.timestamp,
             m.metadata,
             m.backend,
             m.model_id,
             s.backend_session_id
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
           WHERE s.platform = ? AND s.channel_id = ? AND s.thread_id IS ?
           ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`,
        )
        .all(event.platform, event.channel, event.threadId ?? null, threadLimit) as typeof rows;
    }

    if (rows.length === 0) return null;

    // Truncate by approximate token budget (1 token ≈ 4 chars).
    const maxTokens = this.config.historyInjectionMaxTokens ?? 8000;
    const reversed = rows.reverse();
    const proactiveRows: Array<{
      sessionId: number;
      dispatchIds: string[];
      sessionResumed: boolean;
    }> = [];
    let tokenBudget = maxTokens * 4; // chars remaining
    const lines: string[] = [];
    for (const r of reversed) {
      const metadata = parseMessageMetadata(r.metadata);
      const isForward = isProactiveForwardMetadata(metadata);
      const tag = r.backend
        ? `[${r.timestamp}] [${r.role}/${r.backend}:${r.model_id ?? "?"}]`
        : `[${r.timestamp}] [${r.role}]`;
      const forwardSuffix =
        r.role === "assistant" ? formatForwardSuffix(metadata) : "";
      const line = `${tag}${forwardSuffix}: ${r.content}`;
      tokenBudget -= line.length;
      if (tokenBudget < 0 && lines.length > 0) {
        lines.unshift(`[...${reversed.length - lines.length} older messages omitted]`);
        break;
      }
      if (isForward) {
        proactiveRows.push({
          sessionId: r.session_id,
          dispatchIds: metadataDispatchIds(metadata),
          sessionResumed: r.backend_session_id !== null,
        });
      }
      lines.push(line);
    }
    if (proactiveRows.length > 0) {
      this.logProactiveForwardInjected(proactiveRows);
    }
    return lines.join("\n");
  }

  private buildRecentOtherSurfaceBlock(event: MessageEvent): string | null {
    if (!event.isDm || event.intent === "docs_qa") return null;
    const windowMinutes = this.config.historyOtherSurfaceWindowMinutes ?? 1440;
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;

    const { scope } = getConversationScope({
      platform: event.platform,
      channel: event.channel,
      threadId: event.threadId,
      isDm: true,
      intent: event.intent,
    });
    const other =
      scope === OWNER_DM_SCOPE
        ? { scope: DASHBOARD_CHAT_SCOPE, scopeKey: DASHBOARD_SCOPE_KEY }
        : scope === DASHBOARD_CHAT_SCOPE
          ? { scope: OWNER_DM_SCOPE, scopeKey: OWNER_SCOPE_KEY }
          : null;
    if (!other) return null;

    const sinceUtc = formatSqliteDatetime(
      new Date(Date.now() - windowMinutes * 60_000),
    );
    const rows = this.db
      .prepare(
        `SELECT
           m.role,
           m.content,
           m.platform,
           m.timestamp,
           m.metadata,
           s.scope,
           s.scope_key
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE s.scope = ?
           AND s.scope_key = ?
           AND s.status = 'active'
           AND m.timestamp >= ?
         ORDER BY m.timestamp ASC, m.id ASC
         LIMIT 60`,
      )
      .all(other.scope, other.scopeKey, sinceUtc) as Array<{
      role: string;
      content: string;
      platform: string;
      timestamp: string;
      metadata: string | null;
      scope: string;
      scope_key: string;
    }>;

    if (rows.length === 0) return null;

    const lines: string[] = [];
    const ordinaryGroups = new Map<
      string,
      { scope: string; count: number; firstMs: number; lastMs: number }
    >();
    for (const row of rows) {
      const metadata = parseMessageMetadata(row.metadata);
      const forwardType = getProactiveForwardType(metadata);
      if (forwardType) {
        lines.push(
          `[${row.timestamp}] [${forwardType} → ${row.platform}]: ${row.content}`,
        );
        continue;
      }

      const key = `${row.scope}:${row.scope_key}`;
      const timestampMs = parseSqliteUtcMs(row.timestamp);
      const existing = ordinaryGroups.get(key);
      if (existing) {
        existing.count += 1;
        existing.firstMs = Math.min(existing.firstMs, timestampMs);
        existing.lastMs = Math.max(existing.lastMs, timestampMs);
      } else {
        ordinaryGroups.set(key, {
          scope: row.scope,
          count: 1,
          firstMs: timestampMs,
          lastMs: timestampMs,
        });
      }
    }

    for (const group of ordinaryGroups.values()) {
      const spanMinutes = Math.max(
        1,
        Math.ceil((group.lastMs - group.firstMs) / 60_000),
      );
      lines.push(
        `(${group.scope}: ${group.count} turns in last ${spanMinutes} minutes)`,
      );
    }

    return lines.length > 0 ? lines.join("\n") : null;
  }

  private logProactiveForwardInjected(
    rows: Array<{
      sessionId: number;
      dispatchIds: string[];
      sessionResumed: boolean;
    }>,
  ): void {
    const sessionId = rows[rows.length - 1]?.sessionId;
    if (sessionId === undefined) return;
    const dispatchIds = [
      ...new Set(rows.flatMap((row) => row.dispatchIds)),
    ];
    try {
      this.db
        .prepare(
          `INSERT INTO agent_actions (
             action_type, trigger, result, detail, started_at
           )
           VALUES (
             'proactive_forward_injected',
             'reactive',
             'success',
             ?,
             CURRENT_TIMESTAMP
           )`,
        )
        .run(
          JSON.stringify({
            sessionId,
            dispatchIds,
            forwardCount: rows.length,
            sessionResumed: rows.some((row) => row.sessionResumed),
          }),
        );
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to log proactive forward injection");
    }
  }

  private async readFile(relativePath: string): Promise<string | null> {
    const contextDir = this.readableContextDir;
    if (!contextDir) return null;
    const fullPath = join(contextDir, relativePath);
    if (!existsSync(fullPath)) return null;
    try {
      return await readFile(fullPath, "utf-8");
    } catch {
      return null;
    }
  }

  private async buildActiveProjectsSection(): Promise<string | null> {
    const contextDir = this.readableContextDir;
    if (!contextDir) return null;
    const projectsDir = join(contextDir, CONTEXT_RELATIVE_PATHS.projects.dir);
    if (!existsSync(projectsDir)) return null;

    const projectFiles = readdirSync(projectsDir)
      .filter((name) => name.endsWith(".md"))
      .filter((name) => !name.startsWith("_"));
    if (projectFiles.length === 0) return null;

    const summaries = (
      await Promise.all(
        projectFiles.map(async (name) => {
          const content = await this.readFile(
            `${CONTEXT_RELATIVE_PATHS.projects.dir}/${name}`,
          );
          if (!content) return null;
          return summarizeProjectFile(name, content);
        }),
      )
    )
      .filter((summary): summary is ProjectSummary => summary !== null)
      .filter((summary) => summary.state !== "archived");

    if (summaries.length === 0) return null;

    summaries.sort((a, b) => {
      const aUpdated = a.updated ?? "";
      const bUpdated = b.updated ?? "";
      if (aUpdated !== bUpdated) return bUpdated.localeCompare(aUpdated);
      return a.title.localeCompare(b.title);
    });

    const lines = ["# Active projects", ""];
    for (const project of summaries) {
      const parts = [`state: ${project.state}`];
      if (project.nextMilestone) {
        parts.push(`next: ${project.nextMilestone}`);
      }
      if (project.due) {
        parts.push(`due: ${project.due}`);
      }
      lines.push(
        `- ${project.title} (\`${project.slug}\`) — ${parts.join("; ")}`,
      );
    }

    return lines.join("\n");
  }

  /**
   * Render a rolling 7-day (or N-day) window of DM conversation-log
   * summaries for roadmap_refresh. Unlike `buildYesterdaySqliteContext`,
   * which is anchored to the previous agent-day for journal synthesis,
   * this window is calendar-rolling — refreshes can trigger at any
   * time, and the prompt needs whatever recent DM context exists.
   *
   * Returns a formatted markdown block; falls back to a "(none)" stub
   * so the prompt can always cite the tag unconditionally.
   */
  private buildRecentDmConversationLog(days: number): string {
    const timezoneLabel = this.config.timezone || "system";
    const nowMs = Date.now();
    const startMs = nowMs - days * 24 * 60 * 60 * 1000;
    const startSqlite = formatSqliteDatetime(new Date(startMs));
    const endSqlite = formatSqliteDatetime(new Date(nowMs));

    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM dm_conversation_log
           WHERE created_at >= ? AND created_at < ?`,
        )
        .get(startSqlite, endSqlite) as { cnt: number }
    ).cnt;

    const rows = (
      this.db
        .prepare(
          `SELECT platform, scope, scope_key, summary, message_count, created_at
           FROM dm_conversation_log
           WHERE created_at >= ? AND created_at < ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(
          startSqlite,
          endSqlite,
          YESTERDAY_DM_LOG_LIMIT,
        ) as YesterdayDmConversationLogRow[]
    ).reverse();

    const lines = [
      `- Window: last ${days} days`,
      `- Timezone: ${timezoneLabel}`,
      `- Rows: ${total}`,
    ];
    if (total > rows.length) {
      lines.push(`- Showing latest ${rows.length} rows only`);
    }
    if (rows.length === 0) {
      lines.push("- (none)");
      return lines.join("\n");
    }
    for (const row of rows) {
      const scopeKey =
        row.scope_key && row.scope_key.length > 0 ? `/${row.scope_key}` : "";
      lines.push(
        `- ${formatSqliteTimestampForContext(row.created_at, timezoneLabel)} [${row.platform}:${row.scope}${scopeKey}] (${row.message_count} msgs) ${truncateContextText(row.summary, 220)}`,
      );
    }
    return lines.join("\n");
  }

  private async buildYesterdaySqliteContext(): Promise<{
    agentActions: string;
    messages: string;
    dmConversationLog: string;
  }> {
    const tz = this.config.timezone || undefined;
    const dayBoundaryHour = this.config.dayBoundaryHour ?? 4;
    const previousAgentDayRef = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const bounds = getAgentDayBoundsUtc(tz, dayBoundaryHour, previousAgentDayRef);
    const dayLabel = localDateStr(
      new Date(parseSqliteUtcMs(bounds.start)),
      tz,
    );
    const timezoneLabel = this.config.timezone || "system";

    const agentActionTotal = (
      this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM agent_actions
           WHERE started_at >= ? AND started_at < ?`,
        )
        .get(bounds.start, bounds.end) as { cnt: number }
    ).cnt;
    const agentActionRows = (
      this.db
        .prepare(
          `SELECT action_type, trigger, result, started_at, completed_at, error
           FROM agent_actions
           WHERE started_at >= ? AND started_at < ?
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .all(
          bounds.start,
          bounds.end,
          YESTERDAY_AGENT_ACTION_LIMIT,
        ) as YesterdayAgentActionRow[]
    ).reverse();

    const messageTotal = (
      this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM messages
           WHERE timestamp >= ? AND timestamp < ?
             AND role != 'system'`,
        )
        .get(bounds.start, bounds.end) as { cnt: number }
    ).cnt;
    const messageRows = (
      this.db
        .prepare(
          `SELECT role, content, platform, timestamp
           FROM messages
           WHERE timestamp >= ? AND timestamp < ?
             AND role != 'system'
           ORDER BY timestamp DESC
           LIMIT ?`,
        )
        .all(
          bounds.start,
          bounds.end,
          YESTERDAY_MESSAGE_LIMIT,
        ) as YesterdayMessageRow[]
    ).reverse();

    const dmLogTotal = (
      this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM dm_conversation_log
           WHERE created_at >= ? AND created_at < ?`,
        )
        .get(bounds.start, bounds.end) as { cnt: number }
    ).cnt;
    const dmLogRows = (
      this.db
        .prepare(
          `SELECT platform, scope, scope_key, summary, message_count, created_at
           FROM dm_conversation_log
           WHERE created_at >= ? AND created_at < ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(
          bounds.start,
          bounds.end,
          YESTERDAY_DM_LOG_LIMIT,
        ) as YesterdayDmConversationLogRow[]
    ).reverse();

    return {
      agentActions: formatYesterdayAgentActions(
        dayLabel,
        timezoneLabel,
        agentActionRows,
        agentActionTotal,
      ),
      messages: formatYesterdayMessages(
        dayLabel,
        timezoneLabel,
        messageRows,
        messageTotal,
      ),
      dmConversationLog: formatYesterdayDmConversationLog(
        dayLabel,
        timezoneLabel,
        dmLogRows,
        dmLogTotal,
      ),
    };
  }

  /**
   * Current-agent-day variant of `buildYesterdaySqliteContext` for the
   * user-profile sweep (§Phase 2). Resolves the day bounds to the
   * CURRENT agent-day — at 03:50 that window is ~04:00 yesterday →
   * 03:50 today (the agent-day about to close), and at 17:50 it is
   * ~04:00 today → 17:50 today. The sweep reads DM traffic + rolling
   * summaries but not agent_actions (not needed for fact extraction).
   */
  private buildAgentDayDmContext(): {
    messages: string;
    dmConversationLog: string;
  } {
    const tz = this.config.timezone || undefined;
    const dayBoundaryHour = this.config.dayBoundaryHour ?? 4;
    const bounds = getAgentDayBoundsUtc(tz, dayBoundaryHour);
    const dayLabel = localDateStr(
      new Date(parseSqliteUtcMs(bounds.start)),
      tz,
    );
    const timezoneLabel = this.config.timezone || "system";

    const messageTotal = (
      this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM messages
           WHERE timestamp >= ? AND timestamp < ?
             AND role != 'system'`,
        )
        .get(bounds.start, bounds.end) as { cnt: number }
    ).cnt;
    const messageRows = (
      this.db
        .prepare(
          `SELECT role, content, platform, timestamp
           FROM messages
           WHERE timestamp >= ? AND timestamp < ?
             AND role != 'system'
           ORDER BY timestamp DESC
           LIMIT ?`,
        )
        .all(
          bounds.start,
          bounds.end,
          YESTERDAY_MESSAGE_LIMIT,
        ) as YesterdayMessageRow[]
    ).reverse();

    const dmLogTotal = (
      this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM dm_conversation_log
           WHERE created_at >= ? AND created_at < ?`,
        )
        .get(bounds.start, bounds.end) as { cnt: number }
    ).cnt;
    const dmLogRows = (
      this.db
        .prepare(
          `SELECT platform, scope, scope_key, summary, message_count, created_at
           FROM dm_conversation_log
           WHERE created_at >= ? AND created_at < ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(
          bounds.start,
          bounds.end,
          YESTERDAY_DM_LOG_LIMIT,
        ) as YesterdayDmConversationLogRow[]
    ).reverse();

    return {
      messages: formatYesterdayMessages(
        dayLabel,
        timezoneLabel,
        messageRows,
        messageTotal,
      ),
      dmConversationLog: formatYesterdayDmConversationLog(
        dayLabel,
        timezoneLabel,
        dmLogRows,
        dmLogTotal,
      ),
    };
  }
}

interface ProjectSummary {
  slug: string;
  title: string;
  state: string;
  due: string | null;
  nextMilestone: string | null;
  updated: string | null;
}

/**
 * Truncate `value` to at most `max` chars, collapsing newlines so the
 * result fits on one line. Suffix `…` when truncation occurs. Used by
 * the scheduled.dm DM-activity / DM-history blocks.
 */
function truncateForBlock(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function summarizeProjectFile(
  filename: string,
  content: string,
): ProjectSummary | null {
  const slug = filename.replace(/\.md$/, "");
  const { frontmatter, body } = splitFrontmatter(content);
  const state = readFrontmatterScalar(frontmatter, "state") ?? "active";
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug;

  return {
    slug,
    title,
    state,
    due: readFrontmatterScalar(frontmatter, "due"),
    nextMilestone: readFrontmatterScalar(frontmatter, "next_milestone"),
    updated: readFrontmatterScalar(frontmatter, "updated"),
  };
}

function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    return { frontmatter: "", body: content };
  }

  const endIdx = content.indexOf("\n---", 4);
  if (endIdx < 0) {
    return { frontmatter: "", body: content };
  }

  return {
    frontmatter: content.slice(4, endIdx),
    body: content.slice(endIdx + 4).replace(/^\n+/, ""),
  };
}

interface YesterdayAgentActionRow {
  action_type: string;
  trigger: string | null;
  result: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface YesterdayMessageRow {
  role: string;
  content: string;
  platform: string;
  timestamp: string;
}

interface YesterdayDmConversationLogRow {
  platform: string;
  scope: string;
  scope_key: string;
  summary: string;
  message_count: number;
  created_at: string;
}

function readFrontmatterScalar(
  frontmatter: string,
  key: string,
): string | null {
  if (!frontmatter) return null;

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatter.match(
    new RegExp(`^${escapedKey}:\\s*(.+)$`, "m"),
  );
  if (!match) return null;

  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

/**
 * Truncate the ## Agent Log section of today.md to the last `maxEntries`
 * bullet lines. Operates on the string content only (does not touch disk).
 * Inserts an omission marker pointing to GET /api/context/today.
 */
function truncateAgentLog(content: string, maxEntries: number): string {
  // Match "\n## Agent Log\n" to avoid false positives inside code blocks or
  // quoted text. The leading \n ensures we match a heading at line start, not
  // a substring of prose. today.md's structure is daemon-controlled, but this
  // is defence-in-depth against accidental matches in Handoff/Notes.
  const needle = "\n## Agent Log\n";
  const needleIdx = content.indexOf(needle);
  if (needleIdx < 0) return content;
  const headerIdx = needleIdx + 1; // skip the leading \n to point at "##"
  const sectionHeader = "## Agent Log";

  // Find the end of the Agent Log section (next ## heading or EOF)
  const afterHeader = headerIdx + sectionHeader.length;
  const nextSectionIdx = content.indexOf("\n## ", afterHeader);
  const sectionEnd = nextSectionIdx >= 0 ? nextSectionIdx : content.length;

  const sectionBody = content.slice(afterHeader, sectionEnd);
  const lines = sectionBody.split("\n");

  // Extract bullet lines (start with "- ")
  const bulletLines = lines.filter((l) => l.trimStart().startsWith("- "));
  if (bulletLines.length <= maxEntries) return content;

  // Keep only the last maxEntries bullets
  const omitted = bulletLines.length - maxEntries;
  const kept = bulletLines.slice(-maxEntries);
  const truncatedBody = [
    "",
    `[...${omitted} earlier entries omitted — use GET /api/context/today for full content]`,
    ...kept,
    "",
  ].join("\n");

  return (
    content.slice(0, headerIdx) +
    sectionHeader +
    truncatedBody +
    content.slice(sectionEnd)
  );
}

function formatYesterdayAgentActions(
  dayLabel: string,
  timezoneLabel: string,
  rows: YesterdayAgentActionRow[],
  total: number,
): string {
  const lines = [
    `- Agent day: ${dayLabel}`,
    `- Timezone: ${timezoneLabel}`,
    `- Rows: ${total}`,
  ];
  if (total > rows.length) {
    lines.push(`- Showing latest ${rows.length} rows only`);
  }
  if (rows.length === 0) {
    lines.push("- (none)");
    return lines.join("\n");
  }
  for (const row of rows) {
    const trigger = row.trigger ? ` (${row.trigger})` : "";
    const result = row.result ?? "unknown";
    const error = row.error
      ? ` — error: ${truncateContextText(row.error, 140)}`
      : "";
    lines.push(
      `- ${formatSqliteTimestampForContext(row.started_at, timezoneLabel)} [${result}] ${row.action_type}${trigger}${error}`,
    );
  }
  return lines.join("\n");
}

function formatYesterdayMessages(
  dayLabel: string,
  timezoneLabel: string,
  rows: YesterdayMessageRow[],
  total: number,
): string {
  const lines = [
    `- Agent day: ${dayLabel}`,
    `- Timezone: ${timezoneLabel}`,
    `- Rows: ${total}`,
  ];
  if (total > rows.length) {
    lines.push(`- Showing latest ${rows.length} rows only`);
  }
  if (rows.length === 0) {
    lines.push("- (none)");
    return lines.join("\n");
  }
  for (const row of rows) {
    lines.push(
      `- ${formatSqliteTimestampForContext(row.timestamp, timezoneLabel)} [${row.platform}/${row.role}] ${truncateContextText(row.content, 180)}`,
    );
  }
  return lines.join("\n");
}

function formatYesterdayDmConversationLog(
  dayLabel: string,
  timezoneLabel: string,
  rows: YesterdayDmConversationLogRow[],
  total: number,
): string {
  const lines = [
    `- Agent day: ${dayLabel}`,
    `- Timezone: ${timezoneLabel}`,
    `- Rows: ${total}`,
  ];
  if (total > rows.length) {
    lines.push(`- Showing latest ${rows.length} rows only`);
  }
  if (rows.length === 0) {
    lines.push("- (none)");
    return lines.join("\n");
  }
  for (const row of rows) {
    const scopeKey =
      row.scope_key && row.scope_key.length > 0 ? `/${row.scope_key}` : "";
    lines.push(
      `- ${formatSqliteTimestampForContext(row.created_at, timezoneLabel)} [${row.platform}:${row.scope}${scopeKey}] (${row.message_count} msgs) ${truncateContextText(row.summary, 220)}`,
    );
  }
  return lines.join("\n");
}

function formatSqliteTimestampForContext(
  timestamp: string,
  timezone: string,
): string {
  const local = nowInTimezone(
    timezone === "system" ? undefined : timezone,
    new Date(parseSqliteUtcMs(timestamp)),
  );
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${String(local.hours).padStart(2, "0")}:${String(local.minutes).padStart(2, "0")}`;
}

function truncateContextText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3)}...`;
}

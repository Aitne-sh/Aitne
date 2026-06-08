import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  AGENT_ROLE_DESCRIPTOR,
  APP_NAME,
  createEvent,
  EventPriority,
  getAgentDayBoundsUtc,
  localDateStr,
  parseSqliteUtcMs,
} from "@aitne/shared";
import type { MessageEvent, RoutineEvent } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { setDegradedMode } from "../db/runtime-state.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { ContextBuilder } from "./context-builder.js";
import type { AgentConfig } from "../config.js";
import type { CalendarService, CalendarEvent } from "../services/calendar.js";
import { createServiceRegistry } from "../services/service-registry.js";
import {
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
} from "../messaging/constants.js";

describe("ContextBuilder", () => {
  let tmpDir: string;
  let contextDir: string;
  let db: Database.Database;
  let builder: ContextBuilder;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `pa-test-${Date.now()}`);
    contextDir = join(tmpDir, "context");
    mkdirSync(join(contextDir, "journal", "daily"), { recursive: true });
    mkdirSync(join(contextDir, "plans", "projects"), { recursive: true });
    mkdirSync(join(contextDir, "identity"), { recursive: true });
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    mkdirSync(join(contextDir, "policies", "routines"), { recursive: true });
    mkdirSync(join(contextDir, "journal"), { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    mkdirSync(join(contextDir, "state", "inbox"), { recursive: true });
    mkdirSync(join(contextDir, "knowledge"), { recursive: true });
    mkdirSync(join(contextDir, "knowledge", "dossiers"), { recursive: true });

    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    const config = {
      dataDir: tmpDir,
      externalObsidianVaultPath: null,
      agentDisplayName: "ai bot",
    } as unknown as AgentConfig;
    builder = new ContextBuilder(config, db, createServiceRegistry());
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds context with existing files", async () => {
    writeFileSync(join(contextDir, "identity", "profile.md"), "# User\nTest user");
    writeFileSync(
      join(contextDir, "policies", "management.md"),
      "# Rules\nBe helpful",
    );
    writeFileSync(join(contextDir, "state", "today.md"), "# Today\nBusy day");

    const event = createEvent({
      type: "test.event",
      source: "test",
      priority: EventPriority.NORMAL,
    });

    const context = await builder.build(event);

    expect(context).toContain("<user>");
    expect(context).toContain("Test user");
    expect(context).toContain("<management_rules>");
    // STAGE-C-DM-FRESHNESS-PLAN §Task 1: <today> tag now carries a
    // snapshot_at ISO-8601 attribute. Match the open tag with attribute.
    expect(context).toMatch(/<today snapshot_at="[^"]+">/);
    expect(context).toContain("<agent_identity>");
    // Three-axis identity (branding.ts): product (rebrand target), role
    // (LLM activation anchor — invariant across rebrands), display_name
    // (user-customizable proper noun for self-reference). Each axis must
    // be emitted on its own line so the LLM can disambiguate "I am
    // <display_name> and the operator is asking about <product>" when the
    // user has renamed their instance.
    expect(context).toContain(`product: ${APP_NAME}`);
    expect(context).toContain(`role: ${AGENT_ROLE_DESCRIPTOR}`);
    expect(context).toContain("display_name: ai bot");
    expect(context).toContain("whatsapp_label: [ai bot]");
    expect(context).toContain("<current_time ");
    expect(context).toContain("<event_correlation_id>");
    // Agent-day date placeholder: provided unconditionally so today.md
    // writers can use it for line 1 instead of guessing from <current_time>,
    // which gives calendar today and diverges from agent-day before
    // dayBoundaryHour:00 local. See morning-routine fix.
    expect(context).toMatch(/<current_agent_day date="\d{4}-\d{2}-\d{2}"/);
    expect(context).toMatch(/weekday="(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"/);
    expect(context).toMatch(/boundary_hour="\d+"/);
  });

  it("prefers event agentDisplayName over config during setup", async () => {
    const event = createEvent({
      type: "message.received",
      source: "dashboard",
      priority: EventPriority.NORMAL,
      data: { agentDisplayName: "setup bot" },
    });

    const context = await builder.build(event);

    expect(context).toContain("display_name: setup bot");
    expect(context).toContain("whatsapp_label: [setup bot]");
    expect(context).not.toContain("display_name: ai bot");
  });

  it("handles missing files gracefully", async () => {
    const event = createEvent({
      type: "test.event",
      source: "test",
      priority: EventPriority.NORMAL,
    });

    const context = await builder.build(event);

    // Should still have time and correlation ID
    expect(context).toContain("<current_time ");
    expect(context).toContain("<event_correlation_id>");
    // Should not have file sections
    expect(context).not.toContain("<user>");
  });

  // Design 21 §0.2 / NFR-1b — `<management_rules>` is the
  // authoritative injection path for rules/management.md and must
  // enforce the 32KB per-file cap the policy-files registry
  // previously provided. A runaway file (hand-edit, reconciler bug)
  // is skipped from the prompt with a warn-log; the surrounding
  // session continues without the SoT-bindings block rather than
  // blowing up the prompt budget.
  it("skips <management_rules> when rules/management.md exceeds the 32KB cap", async () => {
    const oversize = "x".repeat(33 * 1024); // 33KB > POLICY_FILE_MAX_BYTES (32KB)
    writeFileSync(join(contextDir, "policies", "management.md"), oversize);
    writeFileSync(join(contextDir, "identity", "profile.md"), "# User\nTest user");

    const event = createEvent({
      type: "test.event",
      source: "test",
      priority: EventPriority.NORMAL,
    });

    const context = await builder.build(event);

    // Oversize file is excluded — `<management_rules>` open tag must not appear.
    expect(context).not.toContain("<management_rules>");
    // The rest of the session-required blocks are still emitted so the
    // turn isn't dead-on-arrival just because one file is oversize.
    expect(context).toContain("<user>");
    expect(context).toContain("Test user");
    expect(context).toContain("<current_time ");
  });

  it("emits <management_rules> when rules/management.md is just under the cap", async () => {
    const justUnder = "y".repeat(32 * 1024 - 16); // 32KB - 16 bytes < POLICY_FILE_MAX_BYTES
    writeFileSync(join(contextDir, "policies", "management.md"), justUnder);

    const event = createEvent({
      type: "test.event",
      source: "test",
      priority: EventPriority.NORMAL,
    });

    const context = await builder.build(event);

    expect(context).toContain("<management_rules>");
    expect(context).toContain(justUnder);
  });

  // morning-routine-optimization.md §"Per-stage input sketches" + the
  // Phase-5 policy-file routing table — Stage B
  // (`routine.morning_routine_journal`) MUST NOT receive the
  // `<management_rules>` block. Stage B authors the daily journal
  // from the pre-aggregated `<journal_skeleton>` and reads no SoT
  // bindings; injecting management rules into a lite-tier session
  // both pushes it over the cold-start floor and contradicts the
  // design table. The ContextBuilder gate must agree with the
  // policy-files registry opt-out — both the ContextBuilder
  // injectManagementRules check and the policy-files `*` merge gate
  // read from the same `getInjectionPolicy(eventOrProcessKey)` table
  // (v4.2 V20), so both injection paths converge on the same Stage B
  // prompt shape.
  it("skips <management_rules> for Stage B (routine.morning_routine_journal)", async () => {
    writeFileSync(join(contextDir, "identity", "profile.md"), "# User\nTest user");
    writeFileSync(
      join(contextDir, "policies", "management.md"),
      "# Rules\nSoT bindings the journal author should never see",
    );

    const event = {
      type: "routine.morning_routine_journal",
      source: "test",
      priority: EventPriority.HIGH,
      correlationId: "stage-b-event-1",
      timestamp: new Date(),
      data: {},
      routine: "morning_routine_journal" as const,
    } as RoutineEvent;

    const context = await builder.build(event);

    expect(context).not.toContain("<management_rules>");
    expect(context).not.toContain("SoT bindings the journal author should never see");
    // <user> is still injected — Stage B reads it for redaction rules
    // and the people roster (design §"Per-stage input sketches").
    expect(context).toContain("<user>");
  });

  it("still emits <management_rules> for Stage A (routine.morning_routine_today)", async () => {
    writeFileSync(join(contextDir, "identity", "profile.md"), "# User\nTest user");
    writeFileSync(
      join(contextDir, "policies", "management.md"),
      "# Rules\nStage A reads SoT bindings",
    );

    const event = {
      type: "routine.morning_routine_today",
      source: "test",
      priority: EventPriority.HIGH,
      correlationId: "stage-a-event-1",
      timestamp: new Date(),
      data: {},
      routine: "morning_routine_today" as const,
    } as RoutineEvent;

    const context = await builder.build(event);

    expect(context).toContain("<management_rules>");
    expect(context).toContain("Stage A reads SoT bindings");
  });

  // Per-event opt-out from the heavy "always-injected" blocks. See
  // `resolveAlwaysInjectionPolicy` in context-builder.ts for the
  // rationale per event-type. The cases below are the contract surface
  // — if any of these regresses, a session pays the prompt-budget
  // cost for blocks the task-flow does not consume.
  describe("resolveAlwaysInjectionPolicy — per-event opt-out", () => {
    // Vault contents are populated identically across cases so the
    // only variable is the event type. The expected absence is the
    // contract: the file exists on disk, but the policy must keep its
    // bytes out of the prompt.
    const PROFILE_BODY = "# User\nProfile that must NOT leak into observer / hourly / today_refresh prompts";
    const RULES_BODY = "# Rules\nSoT bindings that must NOT leak into observer / hourly / today_refresh prompts";

    beforeEach(() => {
      writeFileSync(join(contextDir, "identity", "profile.md"), PROFILE_BODY);
      writeFileSync(join(contextDir, "policies", "management.md"), RULES_BODY);
      writeFileSync(join(contextDir, "state", "today.md"), "# Today\nseed");
    });

    it("omits <user> and <management_rules> for routine.hourly_check", async () => {
      const event = {
        ...createEvent({
          type: "routine.hourly_check",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "hourly_check",
      } as RoutineEvent;
      const context = await builder.build(event);
      expect(context).not.toContain("<user>");
      expect(context).not.toContain(PROFILE_BODY);
      expect(context).not.toContain("<management_rules>");
      expect(context).not.toContain(RULES_BODY);
      // Sanity: the routine still receives its load-bearing blocks.
      expect(context).toContain("<routine_protocol>");
      expect(context).toMatch(/<today snapshot_at="[^"]+">/);
    });

    it("omits <user> and <management_rules> for routine.today_refresh", async () => {
      const event = {
        ...createEvent({
          type: "routine.today_refresh",
          source: "dashboard",
          priority: EventPriority.NORMAL,
        }),
        routine: "today_refresh",
      } as RoutineEvent;
      const context = await builder.build(event);
      expect(context).not.toContain("<user>");
      expect(context).not.toContain(PROFILE_BODY);
      expect(context).not.toContain("<management_rules>");
      expect(context).not.toContain(RULES_BODY);
      // The pre-pass-driven `<calendar_status>` hint is the routine's
      // primary cue and stays present.
      expect(context).toContain("<calendar_status>");
    });

    it.each([
      ["github.pull_request.review_requested"],
      ["github.assigned"],
      ["github.security_alert"],
      ["github.workflow_run.failed"],
      ["git.push.detected"],
      ["git.branch.created"],
      ["git.tag.created"],
      ["git.merge_to_default"],
      ["git.push.force_pushed"],
      ["git.local_ahead.stale"],
      ["git.lifecycle.poll"],
    ])("omits <user> and <management_rules> for observer event %s", async (eventType) => {
      const event = createEvent({
        type: eventType,
        source: "observer",
        priority: EventPriority.NORMAL,
      });
      const context = await builder.build(event);
      expect(context).not.toContain("<user>");
      expect(context).not.toContain(PROFILE_BODY);
      expect(context).not.toContain("<management_rules>");
      expect(context).not.toContain(RULES_BODY);
    });

    it("omits <user> and <management_rules> for schedule.approaching", async () => {
      const event = createEvent({
        type: "schedule.approaching",
        source: "scheduler",
        priority: EventPriority.NORMAL,
      });
      const context = await builder.build(event);
      expect(context).not.toContain("<user>");
      expect(context).not.toContain(PROFILE_BODY);
      expect(context).not.toContain("<management_rules>");
      expect(context).not.toContain(RULES_BODY);
    });

    it("omits <user> and <management_rules> for scheduled.task", async () => {
      // The task-flow body consumes <today> + <task_origin> +
      // <task_context> only; <user> / <management_rules> appear in zero
      // steps. taskContext.background is the per-row contract for any
      // upfront context the future session needs.
      const event = {
        ...createEvent({
          type: "scheduled.task",
          source: "wake",
          priority: EventPriority.NORMAL,
        }),
        task: "generic close-the-loop reminder",
        taskContext: {},
      };
      const context = await builder.build(event);
      expect(context).not.toContain("<user>");
      expect(context).not.toContain(PROFILE_BODY);
      expect(context).not.toContain("<management_rules>");
      expect(context).not.toContain(RULES_BODY);
      // Load-bearing blocks the close-the-loop contract requires must
      // still be present.
      expect(context).toContain("<task_origin");
      expect(context).toContain("<task_context>");
      expect(context).toMatch(/<today snapshot_at="[^"]+">/);
    });

    it("still injects <roadmap> + <active_projects> for scheduled.task dashboard_regenerate (regression guard)", async () => {
      // The dashboard_regenerate source path adds <roadmap> +
      // <active_projects> independently of the <user> opt-out. Verify
      // those blocks still land so dashboard-driven regeneration keeps
      // its richer input set.
      writeFileSync(join(contextDir, "plans", "roadmap.md"), "# Roadmap\nMilestone A");
      const event = {
        ...createEvent({
          type: "scheduled.task",
          source: "dashboard_regenerate",
          priority: EventPriority.NORMAL,
        }),
        task: "regenerate from dashboard",
        taskContext: {},
      };
      const context = await builder.build(event);
      // Opt-out still applies.
      expect(context).not.toContain("<user>");
      expect(context).not.toContain("<management_rules>");
      // Source-specific augmentation is unaffected.
      expect(context).toContain("<roadmap>");
      expect(context).toContain("Milestone A");
    });

    // Complement of the scheduled.task opt-out: scheduled.dm intentionally
    // stays on the wide path because the morning_briefing sub-flow reads
    // <user> ## Notification Preferences (day-type filter) and the people
    // roster (name resolution). Per-sub_flow narrowing is tracked in
    // resolveAlwaysInjectionPolicy's JSDoc as a follow-up.
    it("still injects <user> and <management_rules> for scheduled.dm (default branch)", async () => {
      const event = {
        ...createEvent({
          type: "scheduled.dm",
          source: "dm_session",
          priority: EventPriority.NORMAL,
        }),
        task: "morning briefing — daily summary",
        taskContext: {},
      };
      const context = await builder.build(event);
      expect(context).toContain("<user>");
      expect(context).toContain(PROFILE_BODY);
      expect(context).toContain("<management_rules>");
      expect(context).toContain(RULES_BODY);
    });

    // Regression guard for the default branch — any event NOT listed in
    // the resolver must keep the wide-path behaviour. message.received
    // is the highest-traffic example.
    it("still injects <user> and <management_rules> for message.received (default branch)", async () => {
      const event = createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      });
      const context = await builder.build(event);
      expect(context).toContain("<user>");
      expect(context).toContain(PROFILE_BODY);
      expect(context).toContain("<management_rules>");
      expect(context).toContain(RULES_BODY);
    });
  });

  it("does not read fallback vault files while degraded", async () => {
    writeFileSync(join(contextDir, "identity", "profile.md"), "# User\nFallback user");
    writeFileSync(
      join(contextDir, "policies", "management.md"),
      "# Rules\nFallback rules",
    );
    writeFileSync(join(contextDir, "state", "today.md"), "# Today\nFallback today");
    setDegradedMode(db, {
      reason: "primary_vault_unreachable",
      path: "/missing/primary-vault",
      since: "2026-04-18T10:00:00Z",
    });

    const event = createEvent({
      type: "message.received",
      source: "dashboard",
      priority: EventPriority.HIGH,
    });

    const context = await builder.build(event);

    expect(context).toContain("<management_mode_degraded");
    expect(context).toContain("primary_vault_unreachable");
    expect(context).not.toContain("Fallback user");
    expect(context).not.toContain("Fallback rules");
    expect(context).not.toContain("Fallback today");
  });

  // RFC-D: context-builder must truncate roadmap.md for consumer routines
  // (morning/evening/weekly/monthly) so the Agent Action Plan section
  // keeps only entries in [today-7d, today+30d]. roadmap_refresh injects
  // the full file because it needs every entry to regenerate properly.
  describe("roadmap truncation for consumer routines", () => {
    // Pin "now" so the [today-7d, today+30d] window is deterministic — the
    // test data hardcodes 2026-05-01 as the near-term entry, so we set
    // system time to 2026-05-03 (which keeps that entry inside the past-7
    // window) regardless of when the suite runs.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-03T12:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const bloatedRoadmap = [
      "# Roadmap",
      "> Last synced: 2026-04-20",
      "",
      "## Annual Goals",
      "- Ship v1",
      "",
      "## Long-term Plans",
      "- [2026-Q4] Trip to Europe",
      "",
      "## Agent Action Plan",
      "",
      "### 2025-10-01: Far past event",
      "Source: Google Calendar",
      "",
      "### 2026-05-01: Near-term event",
      "Source: Google Calendar",
      "",
      "### 2026-12-01: Far future event",
      "Source: Google Calendar",
      "",
      "## Recurring",
      "- Every Friday: weekly review",
      "",
    ].join("\n");
    const consumerRoutines: ReadonlyArray<RoutineEvent["routine"]> = [
      "morning_routine",
      "evening_review",
      "weekly_review",
      "monthly_review",
    ];

    for (const routine of consumerRoutines) {
      it(`truncates roadmap for ${routine}`, async () => {
        writeFileSync(join(contextDir, "plans", "roadmap.md"), bloatedRoadmap);
        const event = {
          ...createEvent({
            type: `routine.${routine}`,
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine,
        } as RoutineEvent;

        const context = await builder.build(event);
        // Out-of-window entries removed
        expect(context).not.toContain("Far past event");
        expect(context).not.toContain("Far future event");
        // Near-term entry retained + preserved sections pass through
        expect(context).toContain("Near-term event");
        expect(context).toContain("Long-term Plans");
        expect(context).toContain("Trip to Europe");
        expect(context).toContain("## Recurring");
        // Omission marker surfaces the full-read endpoint
        expect(context).toContain("/api/context/roadmap");
      });
    }

    // B1 fix: the roadmap_refresh prompt's "scan DM history" step used
    // to reference context tags that were only injected for
    // morning_routine, making the step a dead branch. The context
    // builder now injects a 7-day dm_conversation_log window for
    // roadmap_refresh specifically.
    it("injects 7-day DM conversation log for roadmap_refresh", async () => {
      writeFileSync(join(contextDir, "plans", "roadmap.md"), bloatedRoadmap);
      // Seed a DM summary within the 7-day window.
      const recentMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
      const recentTs = new Date(recentMs)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      db.prepare(
        `INSERT INTO dm_conversation_log (platform, scope, scope_key, summary, message_count, created_at)
         VALUES ('slack', 'owner_dm', 'owner', 'Discussed Kyoto trip this summer', 4, ?)`,
      ).run(recentTs);
      // Seed an older summary outside the window.
      const oldMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const oldTs = new Date(oldMs)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      db.prepare(
        `INSERT INTO dm_conversation_log (platform, scope, scope_key, summary, message_count, created_at)
         VALUES ('slack', 'owner_dm', 'owner', 'Older conversation outside window', 2, ?)`,
      ).run(oldTs);

      const event = {
        ...createEvent({
          type: "routine.roadmap_refresh",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "roadmap_refresh",
      } as RoutineEvent;

      const context = await builder.build(event);
      expect(context).toContain('<recent_dm_conversation_log days="7">');
      expect(context).toContain("Kyoto trip this summer");
      expect(context).not.toContain("Older conversation outside window");
    });

    it("renders a (none) stub when no recent DM summaries exist", async () => {
      writeFileSync(join(contextDir, "plans", "roadmap.md"), bloatedRoadmap);
      const event = {
        ...createEvent({
          type: "routine.roadmap_refresh",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "roadmap_refresh",
      } as RoutineEvent;

      const context = await builder.build(event);
      expect(context).toContain('<recent_dm_conversation_log days="7">');
      expect(context).toContain("Rows: 0");
      expect(context).toContain("(none)");
    });

    it("does NOT truncate roadmap for roadmap_refresh (full file needed)", async () => {
      writeFileSync(join(contextDir, "plans", "roadmap.md"), bloatedRoadmap);
      const event = {
        ...createEvent({
          type: "routine.roadmap_refresh",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "roadmap_refresh",
      } as RoutineEvent;

      const context = await builder.build(event);
      expect(context).toContain("Far past event");
      expect(context).toContain("Near-term event");
      expect(context).toContain("Far future event");
    });
  });

  it("adds morning routine extra context", async () => {
    writeFileSync(join(contextDir, "plans", "roadmap.md"), "# Roadmap\nQ2 goals");
    writeFileSync(
      join(contextDir, "plans", "projects", "project-a.md"),
      [
        "---",
        "type: project",
        "state: active",
        "next_milestone: Ship alpha",
        "due: 2026-04-30",
        "updated: 2026-04-17",
        "---",
        "# Project A",
        "",
        "Summary",
      ].join("\n"),
    );
    writeFileSync(
      join(contextDir, "plans", "projects", "project-b.md"),
      [
        "---",
        "type: project",
        "state: archived",
        "---",
        "# Project B",
      ].join("\n"),
    );

    const event = {
      ...createEvent({
        type: "routine.morning_routine",
        source: "cron",
        priority: EventPriority.NORMAL,
      }),
      routine: "morning_routine",
    } as RoutineEvent;

    const context = await builder.build(event);

    expect(context).toContain("<roadmap>");
    expect(context).toContain("<active_projects>");
    expect(context).toContain("Project A");
    expect(context).not.toContain("Project B");
    expect(context).toContain("next: Ship alpha");
  });

  it("injects previous-agent-day SQLite projections for morning routine synthesis", async () => {
    writeFileSync(join(contextDir, "state", "yesterday.md"), "# 2026-04-16\n");
    const previousAgentDayBounds = getAgentDayBoundsUtc(
      undefined,
      4,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    const actionTs = new Date(parseSqliteUtcMs(previousAgentDayBounds.start) + 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const messageTs = new Date(parseSqliteUtcMs(previousAgentDayBounds.start) + 2 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const dmLogTs = new Date(parseSqliteUtcMs(previousAgentDayBounds.start) + 3 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, started_at)
       VALUES ('routine.hourly_check', 'autonomous', 'success', ?)`,
    ).run(actionTs);
    db.prepare(
      `INSERT INTO messages (role, content, platform, timestamp)
       VALUES ('user', 'Need to follow up with Alex', 'slack', ?)`,
    ).run(messageTs);
    db.prepare(
      `INSERT INTO dm_conversation_log (platform, scope, scope_key, summary, message_count, created_at)
       VALUES ('slack', 'owner_dm', 'owner', 'Discussed follow-up with Alex', 3, ?)`,
    ).run(dmLogTs);

    const event = {
      ...createEvent({
        type: "routine.morning_routine",
        source: "cron",
        priority: EventPriority.NORMAL,
      }),
      routine: "morning_routine",
    } as RoutineEvent;

    const context = await builder.build(event);

    expect(context).toContain("<yesterday_agent_actions>");
    expect(context).toContain("routine.hourly_check");
    expect(context).toContain("<yesterday_messages>");
    expect(context).toContain("Need to follow up with Alex");
    expect(context).toContain("<yesterday_dm_conversation_log>");
    expect(context).toContain("Discussed follow-up with Alex");
  });

  // ── <previous_week> injection (weekly-next-week-leverage.md) ──
  //
  // morning_routine reads the just-ended ISO week's
  // `weekly/YYYY-W{prev}.md` and lifts its `## Carry Over to Next Week`,
  // `## Next Week Focus`, and `## Lessons for Next Week` sections into a
  // small `<previous_week>` block — every morning of the new ISO week,
  // not gated on Monday. The injection is a soft handoff: the morning
  // task-flow treats the items as candidates for today.md priorities.

  describe("morning_routine <previous_week> injection", () => {
    it("emits <previous_week> when the previous ISO week's file is present", async () => {
      // Compute the previous-week file path for today so the fixture
      // lands where the digest helper looks. We reuse the same helper
      // the production code uses to avoid duplicating ISO math here.
      const { getPreviousWeekIsoKey } = await import("./previous-week-digest.js");
      const previousKey = getPreviousWeekIsoKey(undefined);
      mkdirSync(join(contextDir, "journal", "weekly"), { recursive: true });
      writeFileSync(
        join(contextDir, "journal", "weekly", `${previousKey}.md`),
        [
          "---",
          "type: weekly",
          "owner: agent",
          "updated: 2026-05-15",
          "---",
          `# Weekly Review ${previousKey}`,
          "",
          "## Carry Over to Next Week",
          "- API review feedback — pending PM sign-off",
          "",
          "## Next Week Focus",
          "- Land the auth refactor",
          "- Prep the Q3 roadmap",
          "",
          "## Lessons for Next Week",
          "- Tue/Wed mornings ate focus time → block 9-11 on calendar",
          "",
        ].join("\n"),
      );

      const event = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "morning_routine",
      } as RoutineEvent;

      const context = await builder.build(event);

      expect(context).toContain(`<previous_week period="${previousKey}"`);
      expect(context).toContain("<carry_over>");
      expect(context).toContain("API review feedback");
      expect(context).toContain("<focus>");
      expect(context).toContain("Land the auth refactor");
      expect(context).toContain("<lessons>");
      expect(context).toContain("block 9-11 on calendar");
      expect(context).toContain("</previous_week>");
    });

    it("omits <previous_week> when the previous week's file is missing", async () => {
      // No weekly file written — happens when the daemon was down
      // through Friday and the catchup window expired. The block
      // is skipped silently; morning_routine proceeds normally.
      const event = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "morning_routine",
      } as RoutineEvent;

      const context = await builder.build(event);

      expect(context).not.toContain("<previous_week ");
    });

    it("omits <previous_week> for non-morning routine events", async () => {
      // Other routines (evening_review, hourly_check, …) do not consume
      // the previous-week digest — they have their own context
      // surfaces. Plant a valid weekly file to prove the helper is
      // only invoked from the morning_routine branch.
      const { getPreviousWeekIsoKey } = await import("./previous-week-digest.js");
      const previousKey = getPreviousWeekIsoKey(undefined);
      mkdirSync(join(contextDir, "journal", "weekly"), { recursive: true });
      writeFileSync(
        join(contextDir, "journal", "weekly", `${previousKey}.md`),
        ["# x", "", "## Next Week Focus", "- A"].join("\n"),
      );

      for (const routine of ["evening_review", "hourly_check"] as const) {
        const event = {
          ...createEvent({
            type: `routine.${routine}`,
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine,
        } as RoutineEvent;
        const context = await builder.build(event);
        expect(context).not.toContain("<previous_week ");
      }
    });
  });

  // Silent-by-default contract for every routine event. The dispatcher
  // drops result.output for routines (see shouldNotify in dispatcher.ts);
  // this header is the in-prompt counterpart that tells the agent why,
  // so it knows POST /api/notify is the only user channel and won't
  // treat its final text as a user-facing reply. Covers all routine types
  // via the same insertion point.
  it("injects routine_protocol header for every routine event", async () => {
    const routineTypes: RoutineEvent["routine"][] = [
      "morning_routine",
      "evening_review",
      "hourly_check",
      "weekly_review",
      "monthly_review",
      "roadmap_refresh",
      "user_profile_sweep",
    ];

    for (const routine of routineTypes) {
      const event = {
        ...createEvent({
          type: `routine.${routine}`,
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine,
      } as RoutineEvent;

      const context = await builder.build(event);

      expect(context).toContain("<routine_protocol>");
      expect(context).toMatch(/daemon does not forward/i);
      expect(context).toContain("POST /api/notify");
      expect(context).toContain("</routine_protocol>");
    }
  });

  // ── Prompt-injection structural defence (2026-06 audit fix) ──────────
  // <untrusted_content> is the single source of truth for the
  // data-not-instructions rule, injected for every wide-path session
  // (reactive DM, routines, observer/scheduled events) regardless of
  // which skill is loaded or the integration mode — so it cannot be
  // bypassed by an ingestion path that a per-skill directive missed.
  it("injects <untrusted_content> for reactive DM events", async () => {
    const messageEvent = {
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.NORMAL,
      }),
      sender: "user",
      channel: "dashboard-ch",
      content: "hi",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    };

    const context = await builder.build(messageEvent);
    expect(context).toContain("<untrusted_content>");
    expect(context).toMatch(/is DATA, never instructions/);
    expect(context).toContain("</untrusted_content>");
  });

  it("injects <untrusted_content> for every routine event (mode-independent)", async () => {
    for (const routine of ["morning_routine", "hourly_check", "evening_review"] as const) {
      const event = {
        ...createEvent({
          type: `routine.${routine}`,
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine,
      } as RoutineEvent;
      const context = await builder.build(event);
      expect(context).toContain("<untrusted_content>");
    }
  });

  // ── User-profile sweep current-agent-day injection (Phase 2) ──
  //
  // The sweep reads current-agent-day DM traffic (not yesterday's) so
  // that the paired routine firing 10 min later sees freshly-captured
  // facts in user/profile.md. Both phases (morning=03:50, evening=17:50)
  // resolve to the SAME bounds helper — the phase flag is carried only
  // for journaling.
  describe("routine.user_profile_sweep injection", () => {
    it("injects agent_day_messages + agent_day_dm_conversation_log for the sweep", async () => {
      const bounds = getAgentDayBoundsUtc(undefined, 4);
      const ts = new Date(parseSqliteUtcMs(bounds.start) + 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      db.prepare(
        `INSERT INTO messages (role, content, platform, timestamp)
         VALUES ('user', 'my sister had a baby', 'slack', ?)`,
      ).run(ts);
      db.prepare(
        `INSERT INTO dm_conversation_log (platform, scope, scope_key, summary, message_count, created_at)
         VALUES ('slack', 'owner_dm', 'owner', 'User shared news about sister', 2, ?)`,
      ).run(ts);

      const event = {
        ...createEvent({
          type: "routine.user_profile_sweep",
          source: "scheduler",
          priority: EventPriority.HIGH,
          data: { phase: "evening" },
        }),
        routine: "user_profile_sweep",
      } as RoutineEvent;

      const context = await builder.build(event);

      expect(context).toContain("<agent_day_messages>");
      expect(context).toContain("my sister had a baby");
      expect(context).toContain("</agent_day_messages>");
      expect(context).toContain("<agent_day_dm_conversation_log>");
      expect(context).toContain("User shared news about sister");
      expect(context).toContain("</agent_day_dm_conversation_log>");
    });

    it("injects both phases against the same bounds (current agent-day)", async () => {
      const bounds = getAgentDayBoundsUtc(undefined, 4);
      const ts = new Date(parseSqliteUtcMs(bounds.start) + 30 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      db.prepare(
        `INSERT INTO messages (role, content, platform, timestamp)
         VALUES ('user', 'current-day fact', 'slack', ?)`,
      ).run(ts);

      for (const phase of ["morning", "evening"]) {
        const event = {
          ...createEvent({
            type: "routine.user_profile_sweep",
            source: "scheduler",
            priority: EventPriority.HIGH,
            data: { phase },
          }),
          routine: "user_profile_sweep",
        } as RoutineEvent;
        const context = await builder.build(event);
        expect(context).toContain("current-day fact");
      }
    });

    it("excludes previous-agent-day messages from the sweep window", async () => {
      const previousBounds = getAgentDayBoundsUtc(
        undefined,
        4,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      );
      // One hour before the current agent-day starts.
      const outsideTs = new Date(
        parseSqliteUtcMs(previousBounds.start) + 60 * 60 * 1000,
      )
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      db.prepare(
        `INSERT INTO messages (role, content, platform, timestamp)
         VALUES ('user', 'outside-window fact', 'slack', ?)`,
      ).run(outsideTs);

      const event = {
        ...createEvent({
          type: "routine.user_profile_sweep",
          source: "scheduler",
          priority: EventPriority.HIGH,
          data: { phase: "evening" },
        }),
        routine: "user_profile_sweep",
      } as RoutineEvent;

      const context = await builder.build(event);

      expect(context).toContain("<agent_day_messages>");
      expect(context).not.toContain("outside-window fact");
    });

    // Phase-missing guard — USER-PROFILE-CAPTURE-PLAN.md §Phase 2 exit
    // criteria bullet 3 ("emits neither block when phase is missing") +
    // §2.4 implementation note ("Step 1 detects the missing phase via
    // the absence of <agent_day_messages>"). Silent misconfig (manual
    // trigger that didn't thread data.phase, stale serialized event,
    // etc.) must surface as no-injection so the task-flow's documented
    // abort path fires, not as a sweep run against an unlabeled window.
    it("emits neither window block when phase is missing", async () => {
      const bounds = getAgentDayBoundsUtc(undefined, 4);
      const ts = new Date(parseSqliteUtcMs(bounds.start) + 30 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      db.prepare(
        `INSERT INTO messages (role, content, platform, timestamp)
         VALUES ('user', 'phase-missing fact', 'slack', ?)`,
      ).run(ts);

      const event = {
        ...createEvent({
          type: "routine.user_profile_sweep",
          source: "scheduler",
          priority: EventPriority.HIGH,
        }),
        routine: "user_profile_sweep",
      } as RoutineEvent;

      const context = await builder.build(event);

      expect(context).not.toContain("<agent_day_messages>");
      expect(context).not.toContain("<agent_day_dm_conversation_log>");
      expect(context).not.toContain("phase-missing fact");
    });

    it("emits neither window block when phase is an unknown value", async () => {
      const event = {
        ...createEvent({
          type: "routine.user_profile_sweep",
          source: "scheduler",
          priority: EventPriority.HIGH,
          data: { phase: "midnight" },
        }),
        routine: "user_profile_sweep",
      } as RoutineEvent;

      const context = await builder.build(event);

      expect(context).not.toContain("<agent_day_messages>");
      expect(context).not.toContain("<agent_day_dm_conversation_log>");
    });
  });

  it("does not inject routine_protocol for non-routine events", async () => {
    const messageEvent = {
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.NORMAL,
      }),
      sender: "user",
      channel: "dashboard-ch",
      content: "hi",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    };

    const context = await builder.build(messageEvent);
    expect(context).not.toContain("<routine_protocol>");
  });

  it("injects today write lock id when the dispatcher provides one", async () => {
    const event = {
      ...createEvent({
        type: "routine.morning_routine",
        source: "cron",
        priority: EventPriority.NORMAL,
        data: { todayWriteLockId: "lock-123" },
      }),
      routine: "morning_routine",
    } as RoutineEvent;

    const context = await builder.build(event);

    expect(context).toContain("<today_write_lock_id>lock-123</today_write_lock_id>");
  });

  it("injects roadmap write lock id when the dispatcher provides one", async () => {
    const event = {
      ...createEvent({
        type: "routine.roadmap_refresh",
        source: "cron",
        priority: EventPriority.NORMAL,
        data: { roadmapWriteLockId: "roadmap-lock-xyz" },
      }),
      routine: "roadmap_refresh",
    } as RoutineEvent;

    const context = await builder.build(event);

    expect(context).toContain(
      "<roadmap_write_lock_id>roadmap-lock-xyz</roadmap_write_lock_id>",
    );
  });

  it("omits roadmap write lock id when the dispatcher does not provide one", async () => {
    const event = {
      ...createEvent({
        type: "routine.roadmap_refresh",
        source: "cron",
        priority: EventPriority.NORMAL,
      }),
      routine: "roadmap_refresh",
    } as RoutineEvent;

    const context = await builder.build(event);

    expect(context).not.toContain("<roadmap_write_lock_id>");
  });

  it("includes obsidian vault path when configured", async () => {
    const config = {
      dataDir: tmpDir,
      externalObsidianVaultPath: "/Users/test/vault",
    } as unknown as AgentConfig;
    const builderWithVault = new ContextBuilder(config, db, createServiceRegistry());

    const event = createEvent({
      type: "test.event",
      source: "test",
      priority: EventPriority.NORMAL,
    });

    const context = await builderWithVault.build(event);
    expect(context).toContain("<obsidian_vault_path>/Users/test/vault</obsidian_vault_path>");
  });

  // DM cross-session context (previous session summary + unsummarized messages)
  // was previously handled by ContextBuilder.getPreviousDmContext(), which is now
  // removed. Cross-session continuity is handled by the dispatcher's
  // buildCrossSessionConversationHistory() to avoid duplicate injection.
  // Tests for that flow live in dispatcher.test.ts.

  describe("calendar events injection", () => {
    function makeMockCalendarService(events: CalendarEvent[]): CalendarService {
      return {
        available: true,
        init: vi.fn(),
        listEvents: vi.fn().mockResolvedValue(events),
        createEvent: vi.fn(),
      } as unknown as CalendarService;
    }

    // docs/design/appendices/routine-data-acquisition.md §6.6 — `buildCalendarBlock`
    // now honors the per-provider `mode`. Direct-mode tests must
    // explicitly set `google_calendar.mode = "direct"` to exercise the
    // inline-events path; otherwise the integration defaults to
    // "disabled" and the provider sub-block is omitted (correct strict
    // behavior). Each direct-mode test below sets the integration row
    // before building context.
    function setGoogleCalendarDirect() {
      writeIntegrations(db, {
        google_calendar: {
          mode: "direct",
          deniedTools: [],
          lastChangedAt: "2026-05-11T00:00:00.000Z",
        },
      });
    }

    it("injects calendar events into morning routine context", async () => {
      setGoogleCalendarDirect();
      // Pacific/Honolulu is UTC-10 with no DST, giving stable offset
      // arithmetic for the synthesized event ISO strings below.
      const timezone = "Pacific/Honolulu";
      const todayStr = localDateStr(new Date(), timezone);
      const mockEvents: CalendarEvent[] = [
        {
          id: "1",
          summary: "Team Standup",
          start: `${todayStr}T09:00:00-10:00`,
          end: `${todayStr}T09:30:00-10:00`,
          description: null,
          allDay: false,
          location: null,
        },
        {
          id: "2",
          summary: "Lunch",
          start: `${todayStr}T12:00:00-10:00`,
          end: `${todayStr}T13:00:00-10:00`,
          description: null,
          allDay: false,
          location: "Cafeteria",
        },
      ];

      const calService = makeMockCalendarService(mockEvents);
      const services = createServiceRegistry();
      services.calendar = calService;
      const config = {
        dataDir: tmpDir,
        externalObsidianVaultPath: null,
        timezone,
      } as unknown as AgentConfig;
      const builderWithCal = new ContextBuilder(config, db, services);

      const event = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "morning_routine",
      } as RoutineEvent;

      const context = await builderWithCal.build(event);

      // docs/design/appendices/routine-data-acquisition.md §6.6 — the wrapper now carries
      // `days` / `timeMin` / `timeMax` attributes plus a per-provider
      // sub-block so multi-provider deployments see a uniform shape.
      expect(context).toContain('<calendar_events_7d days="7"');
      expect(context).toContain('<provider key="google_calendar" mode="direct">');
      expect(context).toContain("Team Standup");
      expect(context).toContain("Lunch");
      expect(context).toContain("@ Cafeteria");
      expect(context).toContain("Today");
    });

    it("formats calendar event times with the configured timezone", async () => {
      setGoogleCalendarDirect();
      const originalTz = process.env.TZ;
      process.env.TZ = "UTC";
      vi.useFakeTimers();
      // 2026-04-21T00:30Z is 2026-04-20 14:30 in Pacific/Honolulu
      // (UTC-10, no DST).
      vi.setSystemTime(new Date("2026-04-20T14:00:00.000Z"));

      try {
        const mockEvents: CalendarEvent[] = [
          {
            id: "morning-call",
            summary: "Morning call",
            start: "2026-04-21T00:30:00.000Z",
            end: "2026-04-21T01:30:00.000Z",
            description: null,
            allDay: false,
            location: null,
          },
        ];
        const calService = makeMockCalendarService(mockEvents);
        const services = createServiceRegistry();
        services.calendar = calService;
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "Pacific/Honolulu",
        } as unknown as AgentConfig;
        const builderWithCal = new ContextBuilder(config, db, services);

        const event = {
          ...createEvent({
            type: "routine.morning_routine",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "morning_routine",
        } as RoutineEvent;

        const context = await builderWithCal.build(event);

        expect(context).toContain("## 2026-04-20");
        expect(context).toContain("- 14:30\u201315:30 Morning call");
        expect(context).not.toContain("- 00:30\u201301:30 Morning call");
      } finally {
        vi.useRealTimers();
        if (originalTz === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = originalTz;
        }
      }
    });

    it("injects calendar events into evening review context", async () => {
      setGoogleCalendarDirect();
      const calService = makeMockCalendarService([]);
      const services = createServiceRegistry();
      services.calendar = calService;
      const config = { dataDir: tmpDir, externalObsidianVaultPath: null } as unknown as AgentConfig;
      const builderWithCal = new ContextBuilder(config, db, services);

      const event = {
        ...createEvent({
          type: "routine.evening_review",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "evening_review",
      } as RoutineEvent;

      const context = await builderWithCal.build(event);

      expect(context).toContain('<calendar_events_3d days="3"');
      expect(context).toContain('<provider key="google_calendar" mode="direct">');
      expect(context).toContain("No events found in the next 3 days");
    });

    it("skips calendar injection when CalendarService is null", async () => {
      const config = { dataDir: tmpDir, externalObsidianVaultPath: null } as unknown as AgentConfig;
      const builderNoCal = new ContextBuilder(config, db, createServiceRegistry());

      const event = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "morning_routine",
      } as RoutineEvent;

      const context = await builderNoCal.build(event);

      expect(context).not.toContain("<calendar_events");
    });

    it("handles all-day events", async () => {
      setGoogleCalendarDirect();
      const todayStr = localDateStr(new Date());
      const calService = makeMockCalendarService([
        {
          id: "3",
          summary: "Holiday",
          start: todayStr,
          end: todayStr,
          description: null,
          allDay: false,
          location: null,
        },
      ]);
      const services = createServiceRegistry();
      services.calendar = calService;
      const config = { dataDir: tmpDir, externalObsidianVaultPath: null } as unknown as AgentConfig;
      const builderWithCal = new ContextBuilder(config, db, services);

      const event = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "morning_routine",
      } as RoutineEvent;

      const context = await builderWithCal.build(event);
      expect(context).toContain("All day Holiday");
    });

    it("gracefully handles calendar fetch failure", async () => {
      const calService = {
        available: true,
        init: vi.fn(),
        listEvents: vi.fn().mockRejectedValue(new Error("Auth expired")),
        createEvent: vi.fn(),
      } as unknown as CalendarService;

      const services = createServiceRegistry();
      services.calendar = calService;
      const config = { dataDir: tmpDir, externalObsidianVaultPath: null } as unknown as AgentConfig;
      const builderWithCal = new ContextBuilder(config, db, services);

      const event = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "morning_routine",
      } as RoutineEvent;

      // Should not throw
      const context = await builderWithCal.build(event);
      expect(context).not.toContain("<calendar_events");
    });

    // ── Delegated-mode injection ──
    //
    // When `google_calendar.mode === "delegated"` the daemon has no local
    // CalendarService to call. `buildCalendarBlock()` instead emits a
    // structured MCP-fetch directive inside the same `<calendar_events_Nd>`
    // tag so task-flow bodies that reference the block can pick it up
    // without their own mode-specific variant. These tests pin that
    // contract — a regression here silently breaks evening / weekly /
    // monthly reviews under delegated Calendar.
    describe("delegated-mode calendar injection", () => {
      function setupDelegatedBuilder(): ContextBuilder {
        writeIntegrations(db, {
          google_calendar: {
            mode: "delegated",
            delegatedBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-04-24T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        // services.calendar intentionally left null — delegated mode
        // typically clears the direct service. The next test also pins
        // that delegated wins even when the service IS present.
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "America/New_York",
        } as unknown as AgentConfig;
        return new ContextBuilder(config, db, services);
      }

      it("emits a mode-aware `<calendar_events_7d>` block for morning_routine without enumerating MCP tool names", async () => {
        // A8 / Finding 5 (2026-05-13) — morning_routine now emits the
        // pre-pass observations hint (see the sibling test below for
        // the prose-level assertion). This test is the STRUCTURAL pin:
        // the block wrapper, the provider sub-block tag, the
        // tool-name-discovery prohibition (P7), and the absence of the
        // legacy "Calendar service not available" status remain
        // unconditional regardless of whether the inner content is a
        // legacy fetch-yourself directive or the new hint. A future
        // refactor that breaks any of those four invariants will trip
        // here even if the inner prose changes again.
        const builderWithMode = setupDelegatedBuilder();

        const event = {
          ...createEvent({
            type: "routine.morning_routine",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "morning_routine",
        } as RoutineEvent;

        const context = await builderWithMode.build(event);

        // docs/design/appendices/routine-data-acquisition.md §6.6 — wrapper carries
        // window attributes; mode lives on the inner `<provider>`
        // sub-block so multi-provider deployments see a uniform shape.
        expect(context).toContain(`<calendar_events_7d days="7"`);
        expect(context).toContain(
          '<provider key="google_calendar" mode="delegated">',
        );
        // Per P7 the daemon does not enumerate MCP tool names — the
        // directive points at `<integration_modes>` and the agent's
        // session-bound surface. Pin the absence so a future edit
        // doesn't accidentally reintroduce tool-name discovery.
        expect(context).not.toContain("mcp__claude_ai_Google_Calendar__");
        expect(context).not.toContain("mcp__codex_apps__google_calendar");
        expect(context).toContain(`</calendar_events_7d>`);
        // Should NOT emit the legacy unavailable status — the directive
        // block replaces it so task-flows don't read both as true.
        expect(context).not.toContain("<calendar_status>Calendar service not available");
      });

      it("includes the cross-backend invoke proxy fallback for routines without a calendar pre-pass (e.g. weekly_review)", async () => {
        // Without this branch, a Claude session whose Calendar is
        // delegated to Gemini would follow the same-backend MCP
        // instruction and query its own (Claude.ai) Google account
        // instead of the configured (Gemini) one. The cross-backend
        // curl is the only way to read the configured account when
        // session backend ≠ delegated_to.
        //
        // A8 / Finding 5 (2026-05-13) — morning_routine NO LONGER
        // emits this directive because its `cal_morning_7d` pre-pass
        // owns the window in non-direct modes; ContextBuilder hands
        // the agent an observations hint instead (the assertion
        // below in the sibling test covers that contract). Pin the
        // legacy contract against `weekly_review` (cal_iso_week_to_now, no
        // ContextBuilder pre-pass coverage) so a future refactor
        // that drops the cross-backend branch is still caught.
        const builderWithMode = setupDelegatedBuilder();

        const event = {
          ...createEvent({
            type: "routine.weekly_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "weekly_review",
        } as RoutineEvent;

        const context = await builderWithMode.build(event);

        expect(context).toContain("/api/integrations/google_calendar/exec");
        expect(context).toContain("Cross-backend");
      });

      it("morning_routine emits the pre-pass observations hint instead of the fetch-yourself directive (A8 / Finding 5)", async () => {
        // The Sonnet main session used to receive a "fetch yourself
        // via MCP" directive in non-direct modes — the second half of
        // the routine.morning_routine $1.00-cap regression. With the
        // calendar pre-pass row in ROUTINE_WINDOWS, ContextBuilder
        // hands the agent a hint pointing at /api/observations and
        // the Haiku pre-pass drives the MCP fan-out instead. Pin
        // both the new prose and the absence of the legacy directive
        // so a future refactor cannot silently revert the win.
        const builderWithMode = setupDelegatedBuilder();
        const event = {
          ...createEvent({
            type: "routine.morning_routine",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "morning_routine",
        } as RoutineEvent;

        const context = await builderWithMode.build(event);
        expect(context).toContain(
          '<provider key="google_calendar" mode="delegated">',
        );
        expect(context).toContain("/api/observations");
        expect(context).toContain("source_prefix=google_calendar:");
        // Legacy directive language must NOT leak through.
        expect(context).not.toContain("/api/integrations/google_calendar/exec");
        expect(context).not.toContain("Cross-backend");
        expect(context).not.toContain("Fetch this window");
      });

      it("emits the MCP-fetch directive for evening_review's 3d block", async () => {
        const builderWithMode = setupDelegatedBuilder();

        const event = {
          ...createEvent({
            type: "routine.evening_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "evening_review",
        } as RoutineEvent;

        const context = await builderWithMode.build(event);

        expect(context).toContain(`<calendar_events_3d days="3"`);
        expect(context).toContain(
          '<provider key="google_calendar" mode="delegated">',
        );
      });

      it("emits the directive for weekly_review's 7d block and monthly_review's 30d block", async () => {
        const weekBuilder = setupDelegatedBuilder();
        const weeklyContext = await weekBuilder.build({
          ...createEvent({
            type: "routine.weekly_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "weekly_review",
        } as RoutineEvent);
        expect(weeklyContext).toContain(`<calendar_events_7d days="7"`);
        expect(weeklyContext).toContain(
          '<provider key="google_calendar" mode="delegated">',
        );

        const monthBuilder = setupDelegatedBuilder();
        const monthlyContext = await monthBuilder.build({
          ...createEvent({
            type: "routine.monthly_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "monthly_review",
        } as RoutineEvent);
        expect(monthlyContext).toContain(`<calendar_events_30d days="30"`);
        expect(monthlyContext).toContain(
          '<provider key="google_calendar" mode="delegated">',
        );
      });

      it("delegated mode wins even when services.calendar is still populated", async () => {
        // A misconfiguration where credentials are resident AND mode is
        // delegated. The direct fetch is available but using it would
        // silently violate the mode invariant (the agent session has the
        // MCP tool surface exposed, not the daemon's direct path). The
        // delegated directive must win.
        writeIntegrations(db, {
          google_calendar: {
            mode: "delegated",
            delegatedBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-04-24T00:00:00.000Z",
          },
        });
        const calService = makeMockCalendarService([
          {
            id: "leaked",
            summary: "Should not appear",
            start: "2026-04-24T09:00:00.000Z",
            end: "2026-04-24T10:00:00.000Z",
            description: null,
            allDay: false,
            location: null,
          },
        ]);
        const services = createServiceRegistry();
        services.calendar = calService;
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "America/New_York",
        } as unknown as AgentConfig;
        const builderWithMode = new ContextBuilder(config, db, services);

        const context = await builderWithMode.build({
          ...createEvent({
            type: "routine.morning_routine",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "morning_routine",
        } as RoutineEvent);

        expect(context).toContain(`<calendar_events_7d days="7"`);
        expect(context).toContain(
          '<provider key="google_calendar" mode="delegated">',
        );
        expect(context).not.toContain("Should not appear");
      });

      it("emits `<integration_modes>` with every registered key's mode", async () => {
        writeIntegrations(db, {
          gmail: {
            mode: "delegated",
            delegatedBackend: "codex",
            deniedTools: [],
            lastChangedAt: "2026-04-24T00:00:00.000Z",
          },
          google_calendar: {
            mode: "direct",
            deniedTools: [],
            lastChangedAt: "2026-04-24T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
        } as unknown as AgentConfig;
        const builderWithMode = new ContextBuilder(config, db, services);

        const context = await builderWithMode.build(
          createEvent({
            type: "test.event",
            source: "test",
            priority: EventPriority.NORMAL,
          }),
        );

        expect(context).toContain(`<integration_modes`);
        expect(context).toContain(`gmail="delegated"`);
        // DELEGATED-MODE-V2-DESIGN.md §5.4 — delegated keys also surface
        // `<key>_delegated_to="<backend>"` so the hourly_check delegated
        // variants can pick same-backend native MCP vs cross-backend proxy
        // per integration without reading integrations.md.
        expect(context).toContain(`gmail_delegated_to="codex"`);
        expect(context).toContain(`google_calendar="direct"`);
        expect(context).not.toContain(`google_calendar_delegated_to=`);
      });

      it("falls back to the direct `(not available)` status when mode is disabled and no service", async () => {
        // Default state (no writeIntegrations call) = every key disabled.
        const services = createServiceRegistry();
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
        } as unknown as AgentConfig;
        const builderWithMode = new ContextBuilder(config, db, services);

        const context = await builderWithMode.build({
          ...createEvent({
            type: "routine.evening_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "evening_review",
        } as RoutineEvent);

        expect(context).toContain("<calendar_status>Calendar service not available");
        expect(context).not.toContain(`mode="delegated"`);
      });

      // ── docs/design/appendices/routine-data-acquisition.md §6.6 — multi-provider + native paths ──

      it("emits an outlook_calendar provider sub-block when outlook is delegated (user-managed)", async () => {
        writeIntegrations(db, {
          outlook_calendar: {
            mode: "delegated",
            delegatedBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "UTC",
        } as unknown as AgentConfig;
        const builder = new ContextBuilder(config, db, services);
        const context = await builder.build({
          ...createEvent({
            type: "routine.evening_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "evening_review",
        } as RoutineEvent);
        expect(context).toContain('<calendar_events_3d days="3"');
        expect(context).toContain(
          '<provider key="outlook_calendar" mode="delegated">',
        );
        // user-managed → no daemon proxy branch
        expect(context).not.toContain(
          "/api/integrations/outlook_calendar/exec",
        );
        // Cross-backend collapse is documented inline so the agent
        // knows there is no proxy fallback.
        expect(context).toContain("user-managed connector");
      });

      it("emits a native provider sub-block that does not reference any daemon proxy", async () => {
        writeIntegrations(db, {
          google_calendar: {
            mode: "native",
            nativeBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "UTC",
        } as unknown as AgentConfig;
        const builder = new ContextBuilder(config, db, services);
        const context = await builder.build({
          ...createEvent({
            type: "routine.evening_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "evening_review",
        } as RoutineEvent);
        expect(context).toContain(
          '<provider key="google_calendar" mode="native">',
        );
        expect(context).not.toContain("/api/integrations/google_calendar/exec");
        // The directive points the agent at <integration_modes> for the
        // session-vs-binding match; no daemon-side tool-name discovery (P7).
        expect(context).not.toContain("mcp__claude_ai_Google_Calendar__");
      });

      it("emits sub-blocks for both providers when google + outlook are both active", async () => {
        writeIntegrations(db, {
          google_calendar: {
            mode: "delegated",
            delegatedBackend: "codex",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
          outlook_calendar: {
            mode: "native",
            nativeBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "UTC",
        } as unknown as AgentConfig;
        const builder = new ContextBuilder(config, db, services);
        const context = await builder.build({
          ...createEvent({
            type: "routine.evening_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "evening_review",
        } as RoutineEvent);
        expect(context).toContain(
          '<provider key="google_calendar" mode="delegated">',
        );
        expect(context).toContain(
          '<provider key="outlook_calendar" mode="native">',
        );
      });

      it("omits provider sub-blocks for providers in disabled mode", async () => {
        writeIntegrations(db, {
          google_calendar: {
            mode: "direct",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
          outlook_calendar: {
            mode: "disabled",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        services.calendar = {
          available: true,
          init: vi.fn(),
          listEvents: vi.fn().mockResolvedValue([]),
          createEvent: vi.fn(),
        } as unknown as CalendarService;
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "UTC",
        } as unknown as AgentConfig;
        const builder = new ContextBuilder(config, db, services);
        const context = await builder.build({
          ...createEvent({
            type: "routine.evening_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "evening_review",
        } as RoutineEvent);
        expect(context).toContain(
          '<provider key="google_calendar" mode="direct">',
        );
        expect(context).not.toContain('key="outlook_calendar"');
      });
    });

    // ── roadmap_refresh 90-day calendar block ──
    //
    // Pre-unification, roadmap_refresh emitted a hand-rolled
    // `<calendar_status>` line with three hardcoded branches
    // (delegated / direct+service / else). Native mode fell into the
    // else branch and the agent was told "preserve existing roadmap
    // content" — so a fresh install in native mode never bumped
    // `Last synced` past 1970-01-01. Unifying onto `buildCalendarBlock`
    // gives roadmap_refresh the same mode-aware surface as the other
    // review routines, eliminating the asymmetry.
    describe("roadmap_refresh 90-day calendar block", () => {
      it("emits `<calendar_events_90d>` with a direct provider sub-block when google_calendar is direct", async () => {
        writeIntegrations(db, {
          google_calendar: {
            mode: "direct",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        services.calendar = {
          available: true,
          init: vi.fn(),
          listEvents: vi.fn().mockResolvedValue([]),
          createEvent: vi.fn(),
        } as unknown as CalendarService;
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "UTC",
        } as unknown as AgentConfig;
        const builder = new ContextBuilder(config, db, services);
        const context = await builder.build({
          ...createEvent({
            type: "routine.roadmap_refresh",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "roadmap_refresh",
        } as RoutineEvent);

        expect(context).toContain('<calendar_events_90d days="90"');
        expect(context).toContain(
          '<provider key="google_calendar" mode="direct">',
        );
        expect(context).toContain('</calendar_events_90d>');
      });

      it("emits the MCP-fetch directive when google_calendar is delegated", async () => {
        writeIntegrations(db, {
          google_calendar: {
            mode: "delegated",
            delegatedBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "UTC",
        } as unknown as AgentConfig;
        const builder = new ContextBuilder(config, db, services);
        const context = await builder.build({
          ...createEvent({
            type: "routine.roadmap_refresh",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "roadmap_refresh",
        } as RoutineEvent);

        expect(context).toContain('<calendar_events_90d days="90"');
        expect(context).toContain(
          '<provider key="google_calendar" mode="delegated">',
        );
        expect(context).toContain(
          "/api/integrations/google_calendar/exec",
        );
      });

      it("emits the session-MCP directive when google_calendar is native (the regression that motivated the unification)", async () => {
        writeIntegrations(db, {
          google_calendar: {
            mode: "native",
            nativeBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "UTC",
        } as unknown as AgentConfig;
        const builder = new ContextBuilder(config, db, services);
        const context = await builder.build({
          ...createEvent({
            type: "routine.roadmap_refresh",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "roadmap_refresh",
        } as RoutineEvent);

        expect(context).toContain('<calendar_events_90d days="90"');
        expect(context).toContain(
          '<provider key="google_calendar" mode="native">',
        );
        // Native bindings never reach the daemon — pin the absence.
        expect(context).not.toContain(
          "/api/integrations/google_calendar/exec",
        );
        expect(context).not.toContain(
          "<calendar_status>Calendar service not available",
        );
        // And the legacy `<calendar_status>` hardcoded variants are
        // gone — these were the source of the "preserve existing
        // roadmap content" mis-signal in native mode.
        expect(context).not.toContain(
          "Skip calendar-based sections",
        );
        expect(context).not.toContain(
          "Google Calendar is delegated.",
        );
        expect(context).not.toContain(
          "Calendar service available.",
        );
      });

      it("emits both google + outlook provider sub-blocks when both are active in mixed modes", async () => {
        writeIntegrations(db, {
          google_calendar: {
            mode: "delegated",
            delegatedBackend: "codex",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
          outlook_calendar: {
            mode: "native",
            nativeBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-05-11T00:00:00.000Z",
          },
        });
        const services = createServiceRegistry();
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "UTC",
        } as unknown as AgentConfig;
        const builder = new ContextBuilder(config, db, services);
        const context = await builder.build({
          ...createEvent({
            type: "routine.roadmap_refresh",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "roadmap_refresh",
        } as RoutineEvent);

        expect(context).toContain('<calendar_events_90d days="90"');
        expect(context).toContain(
          '<provider key="google_calendar" mode="delegated">',
        );
        expect(context).toContain(
          '<provider key="outlook_calendar" mode="native">',
        );
      });

      it("falls back to `<calendar_status>not available>` when every provider is disabled", async () => {
        const services = createServiceRegistry();
        const config = {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          timezone: "UTC",
        } as unknown as AgentConfig;
        const builder = new ContextBuilder(config, db, services);
        const context = await builder.build({
          ...createEvent({
            type: "routine.roadmap_refresh",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "roadmap_refresh",
        } as RoutineEvent);

        expect(context).toContain(
          "<calendar_status>Calendar service not available",
        );
        expect(context).not.toContain("<calendar_events_90d");
      });
    });
  });

  // ── agent/journal.md is on-demand only ──
  //
  // The journal accumulates the agent's self-reflection and system-
  // improvement ideas, written by the weekly/monthly review routines.
  // It must NEVER be injected into the default context for any event type.
  // The design contract is:
  //
  //   - Notifications draw only from the user-facing buckets of weekly/
  //     monthly review; the journal never reaches a notify payload.
  //   - The Monthly Review routine explicitly fetches the journal on
  //     demand via GET /api/context/agent/journal when synthesizing a
  //     monthly retrospective.
  //
  // If a future refactor accidentally adds the journal to the always-
  // injected list (or a glob scan), this test traps it.
  describe("agent/journal.md is never auto-injected", () => {
    const eventSamples = [
      {
        label: "generic event",
        event: createEvent({
          type: "test.event",
          source: "test",
          priority: EventPriority.NORMAL,
        }),
      },
      {
        label: "morning routine",
        event: {
          ...createEvent({
            type: "routine.morning_routine",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "morning_routine",
        } as RoutineEvent,
      },
      {
        label: "evening review",
        event: {
          ...createEvent({
            type: "routine.evening_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "evening_review",
        } as RoutineEvent,
      },
      {
        label: "weekly review",
        event: {
          ...createEvent({
            type: "routine.weekly_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "weekly_review",
        } as RoutineEvent,
      },
      {
        label: "monthly review",
        event: {
          ...createEvent({
            type: "routine.monthly_review",
            source: "cron",
            priority: EventPriority.NORMAL,
          }),
          routine: "monthly_review",
        } as RoutineEvent,
      },
    ];

    for (const { label, event } of eventSamples) {
      it(`excludes agent/journal.md content from ${label} context`, async () => {
        // Plant recognizable sentinel content in the journal
        writeFileSync(
          join(contextDir, "journal", "agent.md"),
          "# Agent Journal\n\n## Weekly 2026-W14\nSENTINEL_JOURNAL_CONTENT_SHOULD_NOT_LEAK\n",
          "utf-8",
        );

        const context = await builder.build(event);

        // The file content (sentinel) and the auto-injection block tag
        // together prove the journal was NOT auto-injected. The bare path
        // string "journal/agent" is legitimately referenced by routine
        // task-flow instruction templates (telling the agent it MAY write
        // there on demand), so we don't gate on the path token alone.
        expect(context).not.toContain("SENTINEL_JOURNAL_CONTENT_SHOULD_NOT_LEAK");
        expect(context).not.toContain("<agent_journal");
      });
    }
  });

  describe("scheduled.dm DM-tone context blocks", () => {
    /**
     * Seed one message into a fresh session for the named owner-facing
     * scope. Two scopes are supported: `owner_dm` (Slack/Telegram/...
     * DMs) and `dashboard_chat` (the dashboard chat panel). The
     * scheduled.dm context blocks must include both — see
     * SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6 / §5.7.
     */
    function seedDmInScope(
      scope: "owner_dm" | "dashboard_chat",
      content: string,
      role: "user" | "assistant",
    ): void {
      const scopeKey = scope === "owner_dm" ? "owner" : "dashboard";
      const platform = scope === "owner_dm" ? "slack" : "dashboard";
      const channelId = scope === "owner_dm" ? "D-OWNER" : "dashboard";
      const session = db
        .prepare(
          `INSERT INTO conversation_sessions (scope, scope_key, status, platform, channel_id)
           VALUES (?, ?, 'active', ?, ?)`,
        )
        .run(scope, scopeKey, platform, channelId);
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform, timestamp)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run(session.lastInsertRowid, role, content, platform);
    }

    it("scheduled.dm injects <recent_dm_messages> and <recent_dm_conversation>", async () => {
      seedDmInScope("owner_dm", "are you there?", "user");

      const event = {
        ...createEvent({
          type: "scheduled.dm",
          source: "dm_session",
          priority: EventPriority.NORMAL,
        }),
        task: "morning briefing — daily summary",
        taskContext: { sub_flow: "morning_briefing" },
      };

      const context = await builder.build(event);

      expect(context).toContain('<recent_dm_messages window="60min">');
      expect(context).toContain("are you there?");
      expect(context).toContain("<recent_dm_conversation>");
      expect(context).toContain("<task_origin");
      expect(context).toContain('source="dm_session"');
    });

    it("scheduled.dm picks up dashboard_chat traffic too (gate-set / data-set parity)", async () => {
      // SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6 widened the gate set to
      // BOTH owner-facing scopes; §5.7's queries MUST mirror that, or
      // a user mid-conversation on the dashboard panel triggers the
      // exact voice-mismatch failure (Variant A "Good morning" while
      // the user is actively typing) the plan exists to fix.
      seedDmInScope("dashboard_chat", "still figuring out the budget", "user");

      const event = {
        ...createEvent({
          type: "scheduled.dm",
          source: "dm_session",
          priority: EventPriority.NORMAL,
        }),
        task: "morning briefing — daily summary",
        taskContext: { sub_flow: "morning_briefing" },
      };

      const context = await builder.build(event);

      expect(context).toContain('<recent_dm_messages window="60min">');
      expect(context).toContain("still figuring out the budget");
      expect(context).toContain("<recent_dm_conversation>");
    });

    it("scheduled.dm interleaves messages from both surfaces in <recent_dm_conversation>", async () => {
      // History must reflect topic context from BOTH surfaces — a user
      // who switches between Slack and the dashboard chat through the
      // morning shouldn't lose half their thread when the briefing
      // composes its bridge phrasing.
      seedDmInScope("owner_dm", "slack-side message", "user");
      seedDmInScope("dashboard_chat", "dashboard-side message", "user");

      const event = {
        ...createEvent({
          type: "scheduled.dm",
          source: "dm_session",
          priority: EventPriority.NORMAL,
        }),
        task: "morning briefing — daily summary",
        taskContext: {},
      };

      const context = await builder.build(event);

      expect(context).toContain("<recent_dm_conversation>");
      expect(context).toContain("slack-side message");
      expect(context).toContain("dashboard-side message");
    });

    it("scheduled.task does NOT inject DM-tone blocks (regression guard)", async () => {
      seedDmInScope("owner_dm", "non-briefing message", "user");

      const event = {
        ...createEvent({
          type: "scheduled.task",
          source: "wake",
          priority: EventPriority.NORMAL,
        }),
        task: "regular scheduled task",
        taskContext: {},
      };

      const context = await builder.build(event);

      expect(context).not.toContain("<recent_dm_messages");
      expect(context).not.toContain("<recent_dm_conversation>");
      // Calendar + origin still present.
      expect(context).toContain("<task_origin");
    });

    it("scheduled.dm omits DM-tone blocks when there are no DM rows", async () => {
      const event = {
        ...createEvent({
          type: "scheduled.dm",
          source: "dm_session",
          priority: EventPriority.NORMAL,
        }),
        task: "morning briefing — empty",
        taskContext: {},
      };

      const context = await builder.build(event);

      expect(context).not.toContain("<recent_dm_messages");
      expect(context).not.toContain("<recent_dm_conversation>");
    });

    it("scheduled.dm tags forwarded assistant rows in <recent_dm_conversation>", async () => {
      const session = db
        .prepare(
          `INSERT INTO conversation_sessions (scope, scope_key, status, platform, channel_id)
           VALUES ('owner_dm', 'owner', 'active', 'slack', 'D-OWNER')`,
        )
        .run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform, metadata, timestamp)
         VALUES (?, 'assistant', 'forwarded reminder text', 'slack', ?, datetime('now'))`,
      ).run(session.lastInsertRowid, JSON.stringify({ notificationType: "proactive_forward" }));

      const event = {
        ...createEvent({
          type: "scheduled.dm",
          source: "dm_session",
          priority: EventPriority.NORMAL,
        }),
        task: "morning briefing — surface forwarded provenance",
        taskContext: {},
      };

      const context = await builder.build(event);

      expect(context).toContain("<recent_dm_conversation>");
      expect(context).toContain("forwarded reminder text");
      expect(context).toContain("(forwarded from autonomous run)");
    });
  });

  describe("DM channel timeline context", () => {
    function makeDmEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
      return {
        ...createEvent({
          type: "message.received",
          source: overrides.platform ?? "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: overrides.channel ?? "D-OWNER",
        content: "handled it",
        platform: overrides.platform ?? "slack",
        threadId: null,
        isDm: true,
        isMention: false,
        ...overrides,
      } as MessageEvent;
    }

    function seedSession(params: {
      scope: string;
      scopeKey: string;
      platform: string;
      channelId: string;
      backendSessionId?: string | null;
    }): number {
      const result = db
        .prepare(
          `INSERT INTO conversation_sessions (
             platform, channel_id, scope, scope_key, status, is_dm, backend_session_id
           )
           VALUES (?, ?, ?, ?, 'active', 1, ?)`,
        )
        .run(
          params.platform,
          params.channelId,
          params.scope,
          params.scopeKey,
          params.backendSessionId ?? null,
        );
      return Number(result.lastInsertRowid);
    }

    function seedMessage(params: {
      sessionId: number;
      role: "user" | "assistant";
      content: string;
      platform: string;
      metadata?: Record<string, unknown>;
      timestamp?: string;
    }): void {
      db.prepare(
        `INSERT INTO messages (
           session_id, role, content, platform, metadata, timestamp
         )
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        params.sessionId,
        params.role,
        params.content,
        params.platform,
        JSON.stringify(params.metadata ?? {}),
        params.timestamp ?? sqliteMinutesAgo(1),
      );
    }

    function sqliteMinutesAgo(minutes: number): string {
      return new Date(Date.now() - minutes * 60_000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
    }

    it("marks proactive forwards in conversation_history and logs injection telemetry", async () => {
      const sessionId = seedSession({
        scope: OWNER_DM_SCOPE,
        scopeKey: OWNER_SCOPE_KEY,
        platform: "slack",
        channelId: "D-OWNER",
        backendSessionId: "sdk-session",
      });
      seedMessage({
        sessionId,
        role: "assistant",
        content: "An email about X arrived. Have you handled it?",
        platform: "slack",
        metadata: {
          notificationType: "proactive_forward",
          dispatchIds: ["dispatch-1"],
          originSessionIds: [99],
        },
      });

      const context = await builder.build(makeDmEvent());

      expect(context).toContain("<conversation_history>");
      expect(context).toContain("(forwarded from autonomous run)");
      expect(context).toContain("An email about X arrived");
      const action = db
        .prepare(
          "SELECT detail FROM agent_actions WHERE action_type = 'proactive_forward_injected'",
        )
        .get() as { detail: string } | undefined;
      expect(action).toBeTruthy();
      expect(JSON.parse(action!.detail)).toMatchObject({
        sessionId,
        dispatchIds: ["dispatch-1"],
        forwardCount: 1,
        sessionResumed: true,
      });
    });

    it("renders recent_other_surface with verbatim forwards and ordinary turn counts", async () => {
      const dashboardSessionId = seedSession({
        scope: DASHBOARD_CHAT_SCOPE,
        scopeKey: DASHBOARD_SCOPE_KEY,
        platform: "dashboard",
        channelId: "dash-1",
      });
      seedMessage({
        sessionId: dashboardSessionId,
        role: "assistant",
        content: "Dashboard-only reminder about the invoice.",
        platform: "dashboard",
        metadata: {
          notificationType: "proactive_forward",
          dispatchIds: ["dispatch-dashboard"],
          originSessionIds: [],
        },
        timestamp: sqliteMinutesAgo(20),
      });
      seedMessage({
        sessionId: dashboardSessionId,
        role: "user",
        content: "ordinary dashboard topic that must not be synthesized",
        platform: "dashboard",
        timestamp: sqliteMinutesAgo(10),
      });
      seedMessage({
        sessionId: dashboardSessionId,
        role: "assistant",
        content: "ordinary assistant answer",
        platform: "dashboard",
        timestamp: sqliteMinutesAgo(5),
      });

      const context = await builder.build(makeDmEvent());

      expect(context).toContain("<recent_other_surface>");
      expect(context).toContain(
        "[proactive_forward → dashboard]: Dashboard-only reminder about the invoice.",
      );
      expect(context).toContain("(dashboard_chat: 2 turns in last");
      expect(context).not.toContain("ordinary dashboard topic");
      expect(context).not.toContain("ordinary assistant answer");
    });

    it("renders a scheduled_dm row with the H-1 suffix in conversation_history", async () => {
      // DM-HISTORY-CONTINUITY-FIX H-1 — a `scheduled_dm` row inserted
      // by `scheduler.handleDirectDm` via the shared channel-timeline
      // path should appear in `<conversation_history>` with the
      // dedicated "(scheduled DM dispatched)" suffix so the model can
      // tell it apart from an autonomous-run forward.
      const sessionId = seedSession({
        scope: OWNER_DM_SCOPE,
        scopeKey: OWNER_SCOPE_KEY,
        platform: "slack",
        channelId: "D-OWNER",
        backendSessionId: "sdk-session",
      });
      seedMessage({
        sessionId,
        role: "assistant",
        content: "Reminder: standup in 5 minutes",
        platform: "slack",
        metadata: {
          notificationType: "scheduled_dm",
          dispatchIds: ["sched-1"],
          originSessionIds: [],
        },
      });

      const context = await builder.build(makeDmEvent());
      expect(context).toContain("<conversation_history>");
      expect(context).toContain("(scheduled DM dispatched)");
      expect(context).toContain("Reminder: standup in 5 minutes");
    });

    it("omits <conversation_history> when skipActiveHistoryBlock is set (H-3)", async () => {
      // DM-HISTORY-CONTINUITY-FIX H-3 — when the dispatcher knows the
      // cross-session bridge will cover the same rows, asking for
      // `skipActiveHistoryBlock: true` suppresses the active-session
      // block so the same messages don't render under two different
      // XML tags. `<recent_other_surface>` is unaffected (it covers
      // the OTHER DM surface and never overlaps).
      const sessionId = seedSession({
        scope: OWNER_DM_SCOPE,
        scopeKey: OWNER_SCOPE_KEY,
        platform: "slack",
        channelId: "D-OWNER",
        backendSessionId: "sdk-session",
      });
      seedMessage({
        sessionId,
        role: "user",
        content: "first message",
        platform: "slack",
      });
      seedMessage({
        sessionId,
        role: "assistant",
        content: "first reply",
        platform: "slack",
      });

      const withBlock = await builder.build(makeDmEvent());
      expect(withBlock).toContain("<conversation_history>");
      expect(withBlock).toContain("first message");

      const withoutBlock = await builder.build(makeDmEvent(), {
        skipActiveHistoryBlock: true,
      });
      expect(withoutBlock).not.toContain("<conversation_history>");
      expect(withoutBlock).not.toContain("first message");
    });

    it("disables recent_other_surface when the window is zero", async () => {
      builder = new ContextBuilder(
        {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          agentDisplayName: "ai bot",
          historyOtherSurfaceWindowMinutes: 0,
        } as unknown as AgentConfig,
        db,
        createServiceRegistry(),
      );
      const dashboardSessionId = seedSession({
        scope: DASHBOARD_CHAT_SCOPE,
        scopeKey: DASHBOARD_SCOPE_KEY,
        platform: "dashboard",
        channelId: "dash-1",
      });
      seedMessage({
        sessionId: dashboardSessionId,
        role: "assistant",
        content: "Dashboard-only reminder",
        platform: "dashboard",
        metadata: { notificationType: "proactive_forward" },
      });

      const context = await builder.build(makeDmEvent());

      expect(context).not.toContain("<recent_other_surface>");
    });

    // DM-HISTORY-CONTINUITY-FIX H-2 — the catchup builder returns ONLY
    // the proactive forwards that landed after the SDK session was
    // started, so resume turns no longer pay for the full ~10K-token
    // context block on every forward-bearing message.
    describe("buildResumeCatchupContext (H-2)", () => {
      it("returns null when no forwards landed after the anchor", async () => {
        const sessionId = seedSession({
          scope: OWNER_DM_SCOPE,
          scopeKey: OWNER_SCOPE_KEY,
          platform: "slack",
          channelId: "D-OWNER",
          backendSessionId: "sdk-session",
        });
        // Only a non-forward assistant message exists — irrelevant to
        // the catchup builder.
        seedMessage({
          sessionId,
          role: "assistant",
          content: "ordinary reply",
          platform: "slack",
        });

        const out = await builder.buildResumeCatchupContext(
          makeDmEvent(),
          Date.now() - 60_000,
        );
        expect(out).toBeNull();
      });

      it("returns null for a non-DM event", async () => {
        const out = await builder.buildResumeCatchupContext(
          {
            ...createEvent({
              type: "message.received",
              source: "slack",
              priority: EventPriority.HIGH,
            }),
            sender: "user",
            channel: "thread-1",
            content: "hi",
            platform: "slack",
            threadId: "thread-1",
            isDm: false,
            isMention: true,
          } as MessageEvent,
          Date.now(),
        );
        expect(out).toBeNull();
      });

      it("includes forwards from this scope and the cross-surface scope after the anchor", async () => {
        const ownerSessionId = seedSession({
          scope: OWNER_DM_SCOPE,
          scopeKey: OWNER_SCOPE_KEY,
          platform: "slack",
          channelId: "D-OWNER",
          backendSessionId: "sdk-session",
        });
        const dashboardSessionId = seedSession({
          scope: DASHBOARD_CHAT_SCOPE,
          scopeKey: DASHBOARD_SCOPE_KEY,
          platform: "dashboard",
          channelId: "dash-1",
        });

        // The "anchor" is when the resumed session started.
        const anchorMs = Date.now() - 30 * 60_000;

        // Before-anchor forward → must be EXCLUDED (the SDK already
        // saw it in the cached system prompt).
        seedMessage({
          sessionId: ownerSessionId,
          role: "assistant",
          content: "Stale forward (before session start)",
          platform: "slack",
          metadata: { notificationType: "proactive_forward" },
          timestamp: sqliteMinutesAgo(60),
        });

        // After-anchor forward in THIS scope → must be INCLUDED.
        seedMessage({
          sessionId: ownerSessionId,
          role: "assistant",
          content: "Owner-scope forward after session start",
          platform: "slack",
          metadata: { notificationType: "proactive_forward" },
          timestamp: sqliteMinutesAgo(10),
        });

        // After-anchor scheduled_dm in THIS scope → must be INCLUDED
        // (scheduled_dm is in PROACTIVE_FORWARD_TYPES post-H-1).
        seedMessage({
          sessionId: ownerSessionId,
          role: "assistant",
          content: "Scheduled DM dispatched after session start",
          platform: "slack",
          metadata: { notificationType: "scheduled_dm" },
          timestamp: sqliteMinutesAgo(5),
        });

        // After-anchor forward in the OTHER (dashboard) scope → INCLUDED.
        seedMessage({
          sessionId: dashboardSessionId,
          role: "assistant",
          content: "Dashboard-scope forward",
          platform: "dashboard",
          metadata: { notificationType: "proactive_forward" },
          timestamp: sqliteMinutesAgo(3),
        });

        // After-anchor NON-forward → must be EXCLUDED (covered by the
        // SDK's own conversation memory).
        seedMessage({
          sessionId: ownerSessionId,
          role: "assistant",
          content: "ordinary reply post-session",
          platform: "slack",
          timestamp: sqliteMinutesAgo(2),
        });

        const out = await builder.buildResumeCatchupContext(
          makeDmEvent(),
          anchorMs,
        );

        expect(out).not.toBeNull();
        expect(out!).toContain("<proactive_forwards_since_last_turn>");
        expect(out!).toContain("Owner-scope forward after session start");
        expect(out!).toContain("Scheduled DM dispatched after session start");
        expect(out!).toContain("(scheduled DM dispatched)");
        expect(out!).toContain("Dashboard-scope forward");
        expect(out!).toContain("this surface");
        expect(out!).toContain("other surface");
        expect(out!).not.toContain("Stale forward");
        expect(out!).not.toContain("ordinary reply post-session");

        // logProactiveForwardInjected must still fire on the catchup
        // path so cost / disavowal telemetry continues to track resume
        // injections after the H-2 site move.
        const action = db
          .prepare(
            "SELECT detail FROM agent_actions WHERE action_type = 'proactive_forward_injected'",
          )
          .get() as { detail: string } | undefined;
        expect(action).toBeTruthy();
        const detail = JSON.parse(action!.detail) as Record<string, unknown>;
        expect(detail.forwardCount).toBe(3);
      });

      it("returns null when after-anchor activity is non-forward only", async () => {
        const sessionId = seedSession({
          scope: OWNER_DM_SCOPE,
          scopeKey: OWNER_SCOPE_KEY,
          platform: "slack",
          channelId: "D-OWNER",
          backendSessionId: "sdk-session",
        });
        // After-anchor activity but none is a forward → no catchup.
        seedMessage({
          sessionId,
          role: "user",
          content: "user said hi after session start",
          platform: "slack",
          timestamp: sqliteMinutesAgo(5),
        });
        seedMessage({
          sessionId,
          role: "assistant",
          content: "ordinary reply",
          platform: "slack",
          timestamp: sqliteMinutesAgo(2),
        });

        const out = await builder.buildResumeCatchupContext(
          makeDmEvent(),
          Date.now() - 30 * 60_000,
        );
        expect(out).toBeNull();
      });
    });
  });

  // STAGE-C-DM-FRESHNESS-PLAN §Task 1 — the `<today>` open tag must carry a
  // `snapshot_at` ISO-8601 attribute so resumed DM turns can reason about
  // how stale their cached snapshot is. This is the system-prompt anchor;
  // the per-turn fresh-clock anchor (`<turn_context>`) is asserted in
  // dispatcher.test.ts.
  describe("<today snapshot_at> anchor", () => {
    it("emits snapshot_at on the <today> open tag for DM events", async () => {
      writeFileSync(
        join(contextDir, "state", "today.md"),
        "# Today\n\n## Agent Log\n- 09:00 woke up\n",
      );

      const before = Date.now();
      const event = createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.NORMAL,
      }) as MessageEvent;
      const context = await builder.build(event);
      const after = Date.now();

      // `<today snapshot_at="...">` must be present and the timestamp must
      // be a parseable ISO-8601 value bracketed by the clock window we
      // sampled around the build call (within ~1 s of the actual read).
      const match = /<today snapshot_at="([^"]+)">/.exec(context);
      expect(match).not.toBeNull();
      const isoStr = match![1];
      // Z-terminated ISO-8601 UTC (toISOString format).
      expect(isoStr).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const parsed = Date.parse(isoStr);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThanOrEqual(before - 1000);
      expect(parsed).toBeLessThanOrEqual(after + 1000);
    });

    it("preserves the omission marker AND snapshot_at when Agent Log is truncated (>10 entries)", async () => {
      const bullets = Array.from({ length: 15 }, (_, i) => `- 09:${String(i).padStart(2, "0")} entry-${i}`).join("\n");
      writeFileSync(
        join(contextDir, "state", "today.md"),
        `# Today\n\n## Agent Log\n${bullets}\n`,
      );

      const event = createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.NORMAL,
      }) as MessageEvent;
      const context = await builder.build(event);

      expect(context).toMatch(/<today snapshot_at="[^"]+">/);
      // 15 entries → 5 omitted; verify the omission marker still names the
      // refetch endpoint so the agent always knows where to look.
      expect(context).toContain(
        "[...5 earlier entries omitted — use GET /api/context/today for full content]",
      );
      // First entry was dropped, last 10 kept.
      expect(context).not.toContain("entry-0\n");
      expect(context).toContain("entry-14");
    });

    it("omits snapshot_at when today.md is missing (no <today> block at all)", async () => {
      const event = createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.NORMAL,
      }) as MessageEvent;
      const context = await builder.build(event);

      expect(context).not.toContain("<today");
      expect(context).not.toContain("snapshot_at=");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // docs/design/appendices/routine-data-acquisition.md Phase 4 / D1 — `<acquisition-plan>`
  // and `<fetch_report>` blocks rendered by the dispatcher (the fetcher
  // pre-pass for the former, the parent routine for the latter) are
  // attached to `event.data` and injected verbatim by ContextBuilder so
  // task-flow bodies (and any partials they include) see them ahead of
  // the routine's workflow steps.
  // ──────────────────────────────────────────────────────────────────────────

  describe("Phase 4 / D1 — acquisition-plan and fetch_report injection", () => {
    it("injects <acquisition-plan> when event.data.acquisitionPlanBlock is a string", async () => {
      const acquisitionPlanBlock = `<acquisition-plan routine="morning_routine" agent_day="2026-05-11">\n  <fetch integration="gmail" mode="direct" window="inbox_today" account="me" query="?since=2026-05-11T00:00:00.000Z" />\n</acquisition-plan>`;
      const event = createEvent({
        type: "routine.fetch_window",
        source: "cron",
        priority: EventPriority.NORMAL,
        data: { acquisitionPlanBlock },
      });
      const context = await builder.build(event);
      expect(context).toContain(acquisitionPlanBlock);
    });

    it("injects <fetch_report> when event.data.fetchReportBlock is a string", async () => {
      const block = `<fetch_report routine="morning_routine" agent_day="2026-05-11" status="success" fetched="3" posted="3" duplicates="0" />`;
      const event = createEvent({
        type: "routine.morning_routine",
        source: "cron",
        priority: EventPriority.NORMAL,
        data: { fetchReportBlock: block },
      }) as unknown as RoutineEvent;
      const context = await builder.build(event);
      expect(context).toContain(block);
    });

    it("omits the blocks entirely when the data keys are absent", async () => {
      const event = createEvent({
        type: "routine.morning_routine",
        source: "cron",
        priority: EventPriority.NORMAL,
      });
      const context = await builder.build(event);
      expect(context).not.toContain("<acquisition-plan");
      expect(context).not.toContain("<fetch_report");
    });

    it("emits both blocks side-by-side when both are present (no-op for production, defensive contract for fetcher's reassemble path)", async () => {
      const plan = `<acquisition-plan routine="hourly_check" agent_day="2026-05-11"></acquisition-plan>`;
      const report = `<fetch_report routine="hourly_check" agent_day="2026-05-11" status="skipped" fetched="0" posted="0" duplicates="0" />`;
      const event = createEvent({
        type: "routine.hourly_check",
        source: "cron",
        priority: EventPriority.NORMAL,
        data: { acquisitionPlanBlock: plan, fetchReportBlock: report },
      }) as unknown as RoutineEvent;
      const context = await builder.build(event);
      expect(context).toContain(plan);
      expect(context).toContain(report);
    });
  });

  // FEEDBACK_LEARNING_LOOP_DESIGN.md §4 / Phase 5 — the monthly re-generalization
  // worksheet is assembled by the dispatcher pre-step and injected verbatim,
  // exactly like the evening-review `<feedback_worksheet>`.
  describe("Phase 5 — feedback re-generalization injection", () => {
    it("injects <feedback_regeneralization> when event.data.regeneralizationBlock is a string", async () => {
      const block = `<feedback_regeneralization generated_at="2026-06-07T00:00:00Z" scopes="1">\n  <scope label="agent" store="policies/agent-lessons.md" section="lessons"></scope>\n</feedback_regeneralization>`;
      const event = createEvent({
        type: "routine.monthly_review",
        source: "cron",
        priority: EventPriority.NORMAL,
        data: { regeneralizationBlock: block },
      }) as unknown as RoutineEvent;
      const context = await builder.build(event);
      expect(context).toContain(block);
    });

    it("omits the block when event.data.regeneralizationBlock is absent", async () => {
      const event = createEvent({
        type: "routine.monthly_review",
        source: "cron",
        priority: EventPriority.NORMAL,
      });
      const context = await builder.build(event);
      expect(context).not.toContain("<feedback_regeneralization");
    });
  });

  // docs/design/appendices/fetch-window-cost-reduction.md §5 (Phase 2) — slim context for
  // the pre-pass fetcher. The session has no causal dependency on the
  // wide-path always-injected blocks, so the builder short-circuits them.
  describe("routine.fetch_window slim context (Phase 2)", () => {
    const acquisitionPlanBlock = `<acquisition-plan routine="hourly_check" agent_day="2026-05-14">\n  <fetch integration="gmail" mode="direct" window="inbox_today" account="me" query="?since=2026-05-14T00:00:00.000Z" />\n</acquisition-plan>`;

    function makeFetchWindowEvent(data: Record<string, unknown> = {}): RoutineEvent {
      return {
        ...createEvent({
          type: "routine.fetch_window",
          source: "cron",
          priority: EventPriority.NORMAL,
          data,
        }),
        routine: "fetch_window",
      } as RoutineEvent;
    }

    it("emits the three slim sections and nothing else", async () => {
      // Seed the integrations table so the slim path has something to
      // render in <integration_modes>; without rows the helper emits the
      // empty self-closing tag, which is also valid but less illustrative.
      writeIntegrations(db, {
        gmail: {
          mode: "direct",
          deniedTools: [],
          lastChangedAt: "2026-05-14T00:00:00.000Z",
        },
      });
      // Pre-seed `<user>` / `<today>` / `<management_rules>` files so the
      // wide path WOULD have injected them. The slim path should suppress
      // them anyway — this is the regression guard the test exists for.
      writeFileSync(join(contextDir, "identity", "profile.md"), "# User\nshould be skipped");
      writeFileSync(
        join(contextDir, "policies", "management.md"),
        "# Rules\nshould be skipped",
      );
      writeFileSync(join(contextDir, "state", "today.md"), "# Today\nshould be skipped");

      const event = makeFetchWindowEvent({ acquisitionPlanBlock });
      const context = await builder.build(event);

      // Required sections.
      expect(context).toContain(
        `<event_correlation_id>${event.correlationId}</event_correlation_id>`,
      );
      expect(context).toContain("<integration_modes ");
      expect(context).toContain(`gmail="direct"`);
      expect(context).toContain(acquisitionPlanBlock);

      // Wide-path blocks must be absent — every one of these is on the
      // §5 drop-list and present in the seeded data so this fails loud
      // if the early-return ever regresses.
      expect(context).not.toContain("<user>");
      expect(context).not.toContain("<management_rules>");
      expect(context).not.toContain("<today");
      expect(context).not.toContain("<agent_identity>");
      expect(context).not.toContain("<current_time ");
      expect(context).not.toContain("<current_agent_day ");
      expect(context).not.toContain("<settings ");
      expect(context).not.toContain("<output_language_policy>");
      expect(context).not.toContain("<untrusted_content>");
      expect(context).not.toContain("<routine_protocol>");
      expect(context).not.toContain("<management_mode_degraded>");
      expect(context).not.toContain("<obsidian_vault_path>");
      // The wide path injects <fetch_report> when event.data carries one;
      // the slim path drops it (the report describes the pre-pass run
      // about to start, not what the pre-pass needs).
      expect(context).not.toContain("<fetch_report");
    });

    it("omits <acquisition-plan> when event.data does not carry one", async () => {
      // Production never emits a fetch_window without an acquisition plan
      // (the runner short-circuits to the empty-plan report path before
      // dispatch). The slim builder still needs to be defensive — if a
      // future code path constructs the event without the block, the
      // remaining two sections must still render cleanly.
      const event = makeFetchWindowEvent();
      const context = await builder.build(event);
      expect(context).toContain(
        `<event_correlation_id>${event.correlationId}</event_correlation_id>`,
      );
      expect(context).toContain("<integration_modes ");
      expect(context).not.toContain("<acquisition-plan");
    });

    it("renders <integration_modes> with delegated_to / native_backend attrs (Phase 2 parity with wide path)", async () => {
      // The fetcher's per-integration partials branch on these attrs to
      // pick a same-backend MCP call vs a cross-backend proxy POST.
      // Dropping them would silently regress delegated and native flows.
      writeIntegrations(db, {
        gmail: {
          mode: "delegated",
          delegatedBackend: "codex",
          deniedTools: [],
          lastChangedAt: "2026-05-14T00:00:00.000Z",
        },
        google_calendar: {
          mode: "native",
          nativeBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-05-14T00:00:00.000Z",
        },
      });
      const event = makeFetchWindowEvent({ acquisitionPlanBlock });
      const context = await builder.build(event);
      expect(context).toContain(`gmail="delegated"`);
      expect(context).toContain(`gmail_delegated_to="codex"`);
      expect(context).toContain(`google_calendar="native"`);
      expect(context).toContain(`google_calendar_native_backend="claude"`);
    });

    it("ignores other event.data keys the wide path would have honored (gateDecision, fetchReportBlock, todayWriteLockId)", async () => {
      // fetcherEvent.data in production carries acquisitionPlanBlock +
      // parentRoutine + parentCorrelationId + prePassFanOut. The slim
      // path must not surface the wide-path-only keys even if a caller
      // accidentally sets them.
      const event = makeFetchWindowEvent({
        acquisitionPlanBlock,
        gateDecision: { block: "<gate_decision>noisy</gate_decision>" },
        fetchReportBlock: `<fetch_report status="success" />`,
        todayWriteLockId: "abc-123",
        roadmapWriteLockId: "def-456",
      });
      const context = await builder.build(event);
      expect(context).not.toContain("<gate_decision>");
      expect(context).not.toContain("<fetch_report");
      expect(context).not.toContain("<today_write_lock_id>");
      expect(context).not.toContain("<roadmap_write_lock_id>");
    });

    it("falls through to the wide path for a sibling routine event (regression guard)", async () => {
      // hourly_check is a routine event with routine !== "fetch_window";
      // it must still receive `<routine_protocol>` + the small
      // structured metadata blocks (`<agent_identity>`,
      // `<current_time>`, …). It does NOT receive `<user>` /
      // `<management_rules>` — those are opted out per
      // `resolveAlwaysInjectionPolicy`; the dedicated absence test
      // (`omits <user> and <management_rules> for routine.hourly_check`)
      // covers that contract, this case only guards that the slim
      // fetch_window branch did not accidentally swallow sibling
      // routines.
      writeFileSync(join(contextDir, "state", "today.md"), "# Today\nseed");
      const event = {
        ...createEvent({
          type: "routine.hourly_check",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "hourly_check",
      } as RoutineEvent;
      const context = await builder.build(event);
      expect(context).toContain("<routine_protocol>");
      expect(context).toContain("<agent_identity>");
      expect(context).toContain("<current_time ");
    });
  });

  describe("Phase 7 — <roadmap_skeleton> surfacing", () => {
    it("forwards event.data.roadmapSkeletonBlock verbatim on morning_routine", async () => {
      // Phase 7 — the orchestrator injects the skeleton on the
      // first-run branch (yesterday.md absent); ContextBuilder's only
      // job is to push the value as-is so Stage A sees the block. We
      // verify the pass-through here rather than the gate logic
      // (covered in orchestrator.test.ts).
      const skeleton =
        "<roadmap_skeleton>\n## Annual Goals\n- Ship Aitne 1.0\n</roadmap_skeleton>";
      const event = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "morning_routine",
        data: { roadmapSkeletonBlock: skeleton },
      } as RoutineEvent;
      const context = await builder.build(event);
      expect(context).toContain(skeleton);
    });

    it("omits <roadmap_skeleton> on morning_routine when the orchestrator did not inject it", async () => {
      writeFileSync(join(contextDir, "state", "today.md"), "# Today\nseed");
      const event = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "morning_routine",
      } as RoutineEvent;
      const context = await builder.build(event);
      expect(context).not.toContain("<roadmap_skeleton>");
    });
  });

  describe("Phase 3 — <agent_lessons> injection (Feedback Learning Loop §5)", () => {
    const LESSONS_FILE = [
      "# Agent Lessons",
      "",
      "## Lessons",
      "<!-- scope: agent · cap: 8192B · 40 entries -->",
      "- [2026-06-07] Keep the BUDGET_SECTION in the weekly report.",
      "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-07 -->",
      "- [2026-05-01] PROVISIONAL_DRAFT not yet promoted.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-05-01 --> <!-- provisional -->",
    ].join("\n");

    function writeLessons(): void {
      writeFileSync(
        join(contextDir, "policies", "agent-lessons.md"),
        LESSONS_FILE,
      );
    }

    function dmEvent(): MessageEvent {
      return createEvent({
        type: "message.received.dm",
        source: "telegram",
        priority: EventPriority.NORMAL,
      }) as MessageEvent;
    }

    function builderWith(overrides: Record<string, unknown>): ContextBuilder {
      return new ContextBuilder(
        {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          agentDisplayName: "ai bot",
          ...overrides,
        } as unknown as AgentConfig,
        db,
        createServiceRegistry(),
      );
    }

    it("injects the global block on DM messages, excluding provisional lessons", async () => {
      writeLessons();
      const context = await builder.build(dmEvent());
      expect(context).toContain("<agent_lessons>");
      expect(context).toContain("Keep the BUDGET_SECTION in the weekly report.");
      // Provisional lessons are stored but never injected (§4 step 4); the
      // machine-readable trailer is dropped (agent reads prose, not bookkeeping).
      expect(context).not.toContain("PROVISIONAL_DRAFT");
      expect(context).not.toContain("<!-- ev=");
    });

    it("emits the slim notify-discipline variant on the hourly notify turn", async () => {
      writeLessons();
      const event = {
        ...createEvent({
          type: "routine.hourly_check",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "hourly_check",
      } as RoutineEvent;
      const context = await builder.build(event);
      expect(context).toContain("<agent_lessons>");
      expect(context).toContain("Weigh these"); // slim preamble
    });

    it("does NOT inject on surfaces that opt out (today_refresh)", async () => {
      writeLessons();
      const event = {
        ...createEvent({
          type: "routine.today_refresh",
          source: "dashboard",
          priority: EventPriority.NORMAL,
        }),
        routine: "today_refresh",
      } as RoutineEvent;
      const context = await builder.build(event);
      expect(context).not.toContain("<agent_lessons>");
    });

    it("omits the block entirely when no lessons file exists", async () => {
      // No writeLessons() — the file is absent.
      const context = await builder.build(dmEvent());
      expect(context).not.toContain("<agent_lessons>");
    });

    it("is gated off entirely when feedbackLearningEnabled is false", async () => {
      writeLessons();
      const disabledBuilder = builderWith({ feedbackLearningEnabled: false });
      const context = await disabledBuilder.build(dmEvent());
      expect(context).not.toContain("<agent_lessons>");
    });

    it("skips the block when not even one lesson fits the cap (degrade floor)", async () => {
      writeLessons();
      // 8-byte cap is below even a single bullet → no lesson fits, so the block
      // is dropped entirely (the hard inject-time backstop; the cap is never
      // breached). The over-cap is logged via `overflow`.
      const cappedBuilder = builderWith({ feedbackLessonMaxBytesGlobal: 8 });
      const context = await cappedBuilder.build(dmEvent());
      expect(context).not.toContain("<agent_lessons>");
    });

    it("degrades to the top lessons by score when over cap but some fit", async () => {
      // Two active lessons; cap sits between a single top bullet and the
      // combined body → the block degrades to the highest-scored lesson instead
      // of dropping everything (v1.5 §11.6). BUDGET outscores BLOCKERS for any
      // wall-clock `now >= the fixture dates`, so the kept lesson is stable.
      const topBullet = "- Keep the BUDGET_SECTION in the weekly report.";
      writeFileSync(
        join(contextDir, "policies", "agent-lessons.md"),
        [
          "# Agent Lessons",
          "",
          "## Lessons",
          "- [2026-06-07] Keep the BUDGET_SECTION in the weekly report.",
          "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-07 -->",
          "- [2026-05-29] Lead with BLOCKERS_FIRST, not status, in standup summaries.",
          "  <!-- ev=4 kind=do-more src=behavioral conf=high last=2026-06-05 -->",
        ].join("\n"),
      );
      const cap = Buffer.byteLength(topBullet, "utf-8") + 2;
      const degradedBuilder = builderWith({ feedbackLessonMaxBytesGlobal: cap });
      const context = await degradedBuilder.build(dmEvent());
      expect(context).toContain("<agent_lessons>");
      expect(context).toContain("BUDGET_SECTION");
      expect(context).not.toContain("BLOCKERS_FIRST");
    });
  });

  describe("Phase 4 — <agent_lessons scope=\"self\"> per-agent injection (§5)", () => {
    const SLUG = "report-writer";
    const SELF_LESSONS_FILE = [
      "# Agent Lessons — agent:report-writer",
      "",
      "## Lessons",
      "<!-- scope: agent:report-writer · cap: 4096B · 20 entries -->",
      "- [2026-06-07] Keep the BUDGET_TABLE in the weekly report; owner flagged it missing twice.",
      "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-07 -->",
      "- [2026-05-01] PROVISIONAL_SELF not yet promoted.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-05-01 --> <!-- provisional -->",
    ].join("\n");

    function writeSelfLessons(slug = SLUG): void {
      mkdirSync(join(contextDir, "policies", "agents", slug), {
        recursive: true,
      });
      writeFileSync(
        join(contextDir, "policies", "agents", slug, "lessons.md"),
        SELF_LESSONS_FILE,
      );
    }

    /** A defined-agent task execution bound to `slug` (the dispatch site stamps
     *  `event.data.agentId`); scheduled.task is global+self only when bound.
     *  Pass `null` for the unbound (bare scheduled.task) case. */
    function boundTaskEvent(agentId: string | null = SLUG) {
      return createEvent({
        type: "scheduled.task",
        source: "cron",
        priority: EventPriority.NORMAL,
        data: agentId === null ? {} : { agentId },
      });
    }

    function builderWith(overrides: Record<string, unknown>): ContextBuilder {
      return new ContextBuilder(
        {
          dataDir: tmpDir,
          externalObsidianVaultPath: null,
          agentDisplayName: "ai bot",
          ...overrides,
        } as unknown as AgentConfig,
        db,
        createServiceRegistry(),
      );
    }

    it("injects the per-agent self block for an agent-bound execution", async () => {
      writeSelfLessons();
      const context = await builder.build(boundTaskEvent());
      expect(context).toContain('<agent_lessons scope="self">');
      expect(context).toContain("Keep the BUDGET_TABLE in the weekly report");
      expect(context).toContain("THIS agent's own past"); // self preamble
      // Provisional self lessons + trailers + dates are dropped, same as global.
      expect(context).not.toContain("PROVISIONAL_SELF");
      expect(context).not.toContain("<!-- ev=");
    });

    it("does NOT inject the self block when the run is not bound to a slug", async () => {
      writeSelfLessons();
      // A bare scheduled.task (no resolved Agent) is the §5 opt-out.
      const context = await builder.build(boundTaskEvent(null));
      expect(context).not.toContain('scope="self"');
    });

    it("does NOT inject the self block when agentId is an unsafe path segment", async () => {
      writeSelfLessons();
      // Defence-in-depth: a traversal-shaped agentId never builds a vault path.
      const context = await builder.build(boundTaskEvent("../../etc"));
      expect(context).not.toContain('scope="self"');
    });

    it("does NOT inject the self block on hourly_check (self:false) even when bound", async () => {
      writeSelfLessons("hourly-check");
      const event = {
        ...createEvent({
          type: "routine.hourly_check",
          source: "cron",
          priority: EventPriority.NORMAL,
          data: { agentId: "hourly-check" },
        }),
        routine: "hourly_check",
      } as RoutineEvent;
      const context = await builder.build(event);
      expect(context).not.toContain('scope="self"');
    });

    it("omits the self block when the per-agent file is absent", async () => {
      // No writeSelfLessons() — the file does not exist for this slug.
      const context = await builder.build(boundTaskEvent());
      expect(context).not.toContain('scope="self"');
    });

    it("is gated off when feedbackLearningEnabled is false", async () => {
      writeSelfLessons();
      const disabled = builderWith({ feedbackLearningEnabled: false });
      const context = await disabled.build(boundTaskEvent());
      expect(context).not.toContain('scope="self"');
    });

    it("self block coexists with the global block on a self+global surface", async () => {
      writeSelfLessons();
      writeFileSync(
        join(contextDir, "policies", "agent-lessons.md"),
        [
          "# Agent Lessons",
          "",
          "## Lessons",
          "- [2026-06-07] GLOBAL_DISCIPLINE — keep notifications terse.",
          "  <!-- ev=3 kind=do-less src=behavioral conf=high last=2026-06-07 -->",
        ].join("\n"),
      );
      const context = await builder.build(boundTaskEvent());
      // Both the plain global block and the scope="self" block are present.
      expect(context).toContain('<agent_lessons scope="self">');
      expect(context).toContain("GLOBAL_DISCIPLINE");
      expect(context).toContain("Keep the BUDGET_TABLE in the weekly report");
    });

    it("skips the self block when not even one lesson fits the per-agent cap", async () => {
      writeSelfLessons();
      const capped = builderWith({ feedbackLessonMaxBytesPerAgent: 8 });
      const context = await capped.build(boundTaskEvent());
      expect(context).not.toContain('scope="self"');
    });
  });
});

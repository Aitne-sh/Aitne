import { describe, expect, it } from "vitest";
import {
  ALL_PROCESS_KEYS,
  CONFIGURABLE_PROCESS_KEYS,
  customRoutineKey,
  customRoutineSlugFromKey,
  getDefaultTierForProcessKey,
  isAutonomousProcessKey,
  isConfigurableProcessKey,
  isCustomRoutineKey,
  resolveProcessKey,
} from "./process-key.js";
import { EventPriority, createEvent } from "./types.js";

describe("process-key helpers", () => {
  it("marks only configurable keys as configurable", () => {
    for (const processKey of CONFIGURABLE_PROCESS_KEYS) {
      expect(isConfigurableProcessKey(processKey)).toBe(true);
    }
    expect(isConfigurableProcessKey("setup")).toBe(false);
  });

  it("reserves high tier for opt-in heavy delegated tasks only", () => {
    // After the 2026-05-16 "no Opus by default" pass, the only `high`-
    // tagged process key left is `delegated_task_heavy`, which is itself
    // opt-in (gated by the `delegatedTaskHeavyEnabled` config flag and
    // never reached unless the operator flips it on per-integration).
    // Quality-sensitive one-shots that previously defaulted to `high`
    // (setup, knowledge.import, git.project.init / .retemplate) now seed
    // at medium tier (Sonnet); the operator can pin Opus per-row from
    // /settings/models when they want deeper reasoning on a one-shot.
    const highKeys = ["delegated_task_heavy"] as const;

    for (const key of highKeys) {
      expect(getDefaultTierForProcessKey(key)).toBe("high");
    }
  });

  it("defaults conversational, review, and task flows to medium tier", () => {
    const mediumKeys = [
      // Conversational — DMs are owner-in-the-loop; default medium and let
      // the dashboard chat picker / run-now requestedModel escalate.
      "message.dm",
      "message.mention",
      "dashboard.chat",
      // Routine reviews aggregate existing context — Sonnet handles cleanly.
      "routine.morning_routine",
      // morning-routine-optimization.md Phase 5 — Stage A of the split
      // pipeline keeps the medium tier because its workload (today.md
      // synthesis + Step 4 inbox triage + Step 7 schedule fan-out)
      // requires Sonnet's instruction-following ceiling. The parent
      // `routine.morning_routine` remains seeded as the gate envelope.
      "routine.morning_routine_today",
      "routine.evening_review",
      "routine.weekly_review",
      "routine.monthly_review",
      "routine.hourly_check",
      "routine.roadmap_refresh",
      "routine.today_refresh",
      "wiki.ingest_url",
      "wiki.compile",
      "wiki.ask",
      // WIKI_BUILDER_DESIGN.md Phase 3 — operational triad (medium tier).
      "wiki.lint",
      "wiki.trace",
      "wiki.connect",
      // Scheduled task / observer flows.
      "agent.task",
      "agent.dm_task",
      "schedule.approaching",
      // git.project.* are operator-driven one-shots over curated project
      // docs. init / retemplate were high-tier originally; demoted to
      // medium so the seed default is Sonnet across the family. Operators
      // who want Opus-grade analysis can pin per-row from /settings/models.
      "git.project.init",
      "git.project.update",
      "git.project.retemplate",
      // Setup wizard — demoted from high to medium (2026-05-16). The
      // two-turn contract is enforced by the task-flow's "Hard rules for
      // Turn 1" block, not by the model tier; Sonnet handles the Q&A →
      // rules emission cleanly and matches Aitne's "no Opus by default"
      // cost posture.
      "setup",
      // Knowledge import — demoted from high to medium (2026-05-16) for
      // the same "no Opus by default" reason. The dashboard upload form
      // exposes a per-run model picker so operators can opt into Opus
      // for an individual upload when the source is unusually subtle.
      "knowledge.import",
    ] as const;

    for (const key of mediumKeys) {
      expect(getDefaultTierForProcessKey(key)).toBe("medium");
    }
  });

  it("defaults short-shape observer-fired tasks to lite tier", () => {
    const liteKeys = [
      // Integration / calendar / mail / github / git observer-fired tasks
      // are short-shape probes — lite tier keeps per-call cost negligible.
      "integration_drift_sync",
      "calendar.change",
      "github.pull_request.review_requested",
      "github.assigned",
      "github.security_alert",
      "github.workflow_run.failed",
      "git.push.detected",
      "git.local_ahead.stale",
      "git.push.force_pushed",
      "git.branch.created",
      "git.tag.created",
      "git.merge_to_default",
      // docs/design/appendices/routine-data-acquisition.md §6.2 / P3 — pre-pass window
      // fetcher dispatched before each routine session. Mechanical
      // fetch + POST observations, no decision logic.
      "routine.fetch_window",
      // morning-routine-optimization.md Phase 5 — Stage B authors the
      // daily journal from a daemon-prepared skeleton; the ~15 KB
      // total prompt + skill payload clears the lite cold-start floor
      // and the template-driven body is well within Haiku's reach.
      "routine.morning_routine_journal",
    ] as const;

    for (const key of liteKeys) {
      expect(getDefaultTierForProcessKey(key)).toBe("lite");
    }
  });

  it("resolves dashboard chat separately from messaging DMs", () => {
    const event = Object.assign(
      createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      {
        sender: "user",
        channel: "dashboard-channel",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      },
    );

    expect(resolveProcessKey(event)).toBe("dashboard.chat");
  });

  it("forks dashboard messages on the intent discriminator", () => {
    const buildDashboardMessage = (intent?: "chat" | "docs_qa") =>
      Object.assign(
        createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        {
          sender: "user",
          channel: "dashboard-channel",
          content: "hello",
          platform: "dashboard",
          threadId: null,
          isDm: true,
          isMention: false,
          ...(intent !== undefined ? { intent } : {}),
        },
      );

    // Back-compat: undefined intent → chat.
    expect(resolveProcessKey(buildDashboardMessage())).toBe("dashboard.chat");
    // Explicit chat → chat.
    expect(resolveProcessKey(buildDashboardMessage("chat"))).toBe(
      "dashboard.chat",
    );
    // docs_qa → docs_qa.
    expect(resolveProcessKey(buildDashboardMessage("docs_qa"))).toBe(
      "dashboard.docs_qa",
    );

    // Defense-in-depth: intent is ignored on non-dashboard platforms so a
    // malformed Slack event can't smuggle the QA branch.
    const slackWithIntent = Object.assign(
      createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.HIGH,
      }),
      {
        sender: "U1",
        channel: "D1",
        content: "hi",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
        intent: "docs_qa" as const,
      },
    );
    expect(resolveProcessKey(slackWithIntent)).toBe("message.dm");
  });

  it("normalizes messaging, calendar, scheduled task, and setup events", () => {
    const dmEvent = Object.assign(
      createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.HIGH,
      }),
      {
        sender: "U123",
        channel: "D123",
        content: "ping",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      },
    );

    const mentionEvent = Object.assign(
      createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.HIGH,
      }),
      {
        sender: "U123",
        channel: "C123",
        content: "@bot ping",
        platform: "slack",
        threadId: "thread-1",
        isDm: false,
        isMention: true,
      },
    );

    const calendarEvent = createEvent({
      type: "calendar.event_created",
      source: "google_calendar",
      priority: EventPriority.NORMAL,
    });

    const taskEvent = createEvent({
      type: "scheduled.task",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });

    const dmSessionEvent = createEvent({
      type: "scheduled.dm",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });

    const setupEvent = createEvent({
      type: "setup.initial",
      source: "dashboard",
      priority: EventPriority.HIGH,
    });

    expect(resolveProcessKey(dmEvent)).toBe("message.dm");
    expect(resolveProcessKey(mentionEvent)).toBe("message.mention");
    expect(resolveProcessKey(calendarEvent)).toBe("calendar.change");
    expect(resolveProcessKey(taskEvent)).toBe("agent.task");
    expect(resolveProcessKey(dmSessionEvent)).toBe("agent.dm_task");
    expect(resolveProcessKey(setupEvent)).toBe("setup");
  });

  it("returns known process key types directly (isProcessKey branch)", () => {
    // routine.morning_routine is a known process key but not matched by
    // the message/calendar/scheduled/setup handlers above it
    const morningEvent = createEvent({
      type: "routine.morning_routine",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });
    expect(resolveProcessKey(morningEvent)).toBe("routine.morning_routine");

    const hourlyEvent = createEvent({
      type: "routine.hourly_check",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });
    expect(resolveProcessKey(hourlyEvent)).toBe("routine.hourly_check");
  });

  it("returns the raw event type for non-normalized events so callers can fall back to global defaults", () => {
    const event = createEvent({
      type: "health.anomaly",
      source: "monitor",
      priority: EventPriority.NORMAL,
    });

    expect(resolveProcessKey(event)).toBe("health.anomaly");
  });

  // docs/design/appendices/routine-data-acquisition.md §6.9 / P6 — the seed-row test in
  // packages/daemon/src/db/schema.test.ts covers `process_backend_config`
  // rows, but unseeded ProcessKeys fall through to `DEFAULT_PROCESS_TIERS`,
  // and a `routine.*` key that defaults to `high` here would bind to Opus
  // at runtime just as silently as a seeded heavy row. This second gate
  // closes that hole.
  //
  // After `morning-routine-optimization.md` Phase 7 (2026-05-16) NO
  // `routine.*` key defaults to `high`. The previous allowlist entry
  // `routine.morning_routine_initial` was retired; the first-run morning
  // branch now runs on medium tier via the parent
  // `routine.morning_routine` envelope with a daemon-prepared
  // `<roadmap_skeleton>` block. Re-adding a routine that needs `high`
  // is allowed but requires explicit listing here — that forces a
  // code-review touchpoint at exactly the moment headroom is being
  // re-claimed.
  it("no routine.* default tier is `high` (P6 tier ceiling)", () => {
    const HIGH_TIER_ROUTINE_ALLOWLIST = new Set<string>([]);
    const offenders: { key: string }[] = [];
    for (const key of ALL_PROCESS_KEYS) {
      if (!key.startsWith("routine.")) continue;
      if (HIGH_TIER_ROUTINE_ALLOWLIST.has(key)) continue;
      const tier = getDefaultTierForProcessKey(key);
      if (tier === "high") offenders.push({ key });
    }
    expect(
      offenders,
      `Routine keys defaulting to high tier outside the allowlist: ${offenders
        .map((o) => o.key)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("retired routine.morning_routine_initial is not present in ALL_PROCESS_KEYS", () => {
    // Regression guard for Phase 7 retirement. If a future refactor
    // re-introduces the key (e.g. accidentally re-adds it to
    // DEFAULT_PROCESS_KEYS), this assertion fires before any silent
    // tier-routing surprise reaches production.
    expect(new Set<string>(ALL_PROCESS_KEYS).has("routine.morning_routine_initial")).toBe(false);
  });

  it("classifies reactive vs autonomous process keys", () => {
    expect(isAutonomousProcessKey("routine.morning_routine")).toBe(true);
    expect(isAutonomousProcessKey("routine.evening_review")).toBe(true);
    expect(isAutonomousProcessKey("agent.task")).toBe(true);
    // SCHEDULED-DM-IMPLEMENTATION-PLAN §5.3 — daemon-initiated, not
    // owner-in-the-loop.
    expect(isAutonomousProcessKey("agent.dm_task")).toBe(true);
    expect(isAutonomousProcessKey("message.dm")).toBe(false);
    expect(isAutonomousProcessKey("message.mention")).toBe(false);
    expect(isAutonomousProcessKey("dashboard.chat")).toBe(false);
    expect(isAutonomousProcessKey("setup")).toBe(false);
  });

  describe("custom routine keys (B-007 §5.8)", () => {
    it("accepts well-formed routine.custom.<slug> keys", () => {
      expect(isCustomRoutineKey("routine.custom.tuesday-notion-sync")).toBe(true);
      expect(isCustomRoutineKey("routine.custom.a")).toBe(true);
      expect(isCustomRoutineKey("routine.custom.x1")).toBe(true);
    });

    it("rejects malformed or empty slugs", () => {
      expect(isCustomRoutineKey("routine.custom.")).toBe(false);
      expect(isCustomRoutineKey("routine.custom.-lead")).toBe(false);
      expect(isCustomRoutineKey("routine.custom.trail-")).toBe(false);
      expect(isCustomRoutineKey("routine.custom.UPPER")).toBe(false);
      expect(isCustomRoutineKey("routine.custom.with_underscore")).toBe(false);
      expect(isCustomRoutineKey("routine.custom.dots.inside")).toBe(false);
      expect(isCustomRoutineKey("routine.custom." + "x".repeat(65))).toBe(false);
    });

    it("rejects non-custom routine keys", () => {
      expect(isCustomRoutineKey("routine.morning_routine")).toBe(false);
      expect(isCustomRoutineKey("message.dm")).toBe(false);
      expect(isCustomRoutineKey("custom.something")).toBe(false);
    });

    it("round-trips slug ↔ key", () => {
      expect(customRoutineKey("my-slug")).toBe("routine.custom.my-slug");
      expect(customRoutineSlugFromKey("routine.custom.my-slug")).toBe("my-slug");
      expect(customRoutineSlugFromKey("routine.morning_routine")).toBe(null);
    });

    it("defaults custom routine tier to medium", () => {
      expect(getDefaultTierForProcessKey("routine.custom.foo")).toBe("medium");
    });

    it("defaults unknown non-custom keys to medium", () => {
      expect(getDefaultTierForProcessKey("some.unknown.key")).toBe("medium");
    });
  });
});

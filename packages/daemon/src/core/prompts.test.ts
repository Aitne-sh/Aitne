import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getTaskFlow, initTaskFlows } from "./prompts.js";
import { resolveTemplate, extractEventData } from "./backends/prompt-utils.js";
import { renderReferenceIncludes } from "./skills-compiler-skill-index.js";
import { DocsQAAdapter } from "../adapters/docs-qa-adapter.js";
import type { MessageEvent } from "@aitne/shared";
import {
  applyIntegrationModeFilter,
  createEvent,
  EventPriority,
  type CalendarChangeEvent,
} from "@aitne/shared";

// Resolve repo root from this file (packages/daemon/src/core/prompts.test.ts → 4 levels up)
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..");
const CONTEXT_SKILL_PATH = join(
  REPO_ROOT,
  "agent-assets/skills/context/SKILL.md",
);
const TODAY_SKILL_PATH = join(
  REPO_ROOT,
  "agent-assets/skills/today/SKILL.md",
);
const OBSERVATIONS_SKILL_PATH = join(
  REPO_ROOT,
  "agent-assets/skills/observations/SKILL.md",
);
const ROADMAP_SKILL_PATH = join(
  REPO_ROOT,
  "agent-assets/skills/roadmap/SKILL.md",
);
const READING_SKILL_PATH = join(
  REPO_ROOT,
  "agent-assets/skills/reading/SKILL.md",
);
const SCHEDULE_SKILL_PATH = join(
  REPO_ROOT,
  "agent-assets/skills/schedule/SKILL.md",
);

// Initialize task flows from the repo root
initTaskFlows(REPO_ROOT);


describe("getTaskFlow", () => {
  it("returns morning routine flow", () => {
    const flow = getTaskFlow("routine.morning_routine_today");
    expect(flow).toContain("Morning Routine");
    expect(flow).toContain("{context}");
  });

  it("returns evening review flow", () => {
    const flow = getTaskFlow("routine.evening_review");
    expect(flow).toContain("Evening Review");
  });

  it("returns weekly review flow", () => {
    const flow = getTaskFlow("routine.weekly_review");
    expect(flow).toContain("Weekly Review");
    expect(flow).toContain("journal/weekly/YYYY-Www.md");
    // weekly-next-week-leverage.md — the free-form `## Next Week
    // Priorities` was replaced by import-targeted sections that the
    // every-morning `<previous_week>` digest extractor reads (Mon–Sun
    // of the new ISO week, not Monday-only).
    expect(flow).toContain("## Carry Over to Next Week");
    expect(flow).toContain("## Next Week Focus");
  });

  it("returns monthly review flow", () => {
    const flow = getTaskFlow("routine.monthly_review");
    expect(flow).toContain("Monthly Review");
    expect(flow).toContain("journal/monthly/YYYY-MM.md");
    expect(flow).toContain("Next Month Priorities");
  });

  it("returns user-profile sweep flow with phase template + scope guardrails", () => {
    const flow = getTaskFlow("routine.user_profile_sweep");
    expect(flow).toContain("User-profile sweep");
    expect(flow).toContain("{event_data[phase]}");
    // Must read the sweep-specific window tags the ContextBuilder injects.
    expect(flow).toContain("<agent_day_messages>");
    expect(flow).toContain("<agent_day_dm_conversation_log>");
    // Must route through the user-profile skill.
    expect(flow).toContain("user-profile");
    // Must NOT touch Raw Signals — that section belongs to SignalDetector.
    expect(flow).toContain("Raw Signals");
    // Must not emit a user-visible notification.
    expect(flow).toMatch(/do not call.*\/api\/notify/i);
  });

  it("returns message received flow", () => {
    const flow = getTaskFlow("message.received");
    expect(flow).toContain("User Message");
    expect(flow).toContain("{event_data[content]}");
    // rules/management protection moved to _safety.md (shared preamble)
    expect(flow).toContain("user-profile skill");
  });

  it("returns DM first-message flow with checklist review", () => {
    const flow = getTaskFlow("message.received.dm_first");
    expect(flow).toContain("First Message of the Day");
    expect(flow).toContain("- [ ]");
    expect(flow).toContain("context");
    expect(flow).toContain("external-services");
    // rules/management protection moved to _safety.md
    expect(flow).toContain("user-profile skill");
    // docs/design/appendices/skills-improvement.md Phase 0.4 deliberately fattens the
    // dispatcher: the Project / Long-horizon decision trees move into
    // `_partials/dm-intent.*.md` and are included into the rendered DM
    // flow. The rendered flow legitimately contains the partial's curl
    // examples — the architectural invariant is enforced by the
    // partial-presence assertions in the dedicated test below.
  });

  it("returns DM ongoing flow with checklist management", () => {
    const flow = getTaskFlow("message.received.dm");
    expect(flow).toContain("Ongoing Conversation");
    expect(flow).toContain("context");
    expect(flow).toContain("external-services");
    expect(flow).toContain("Do NOT re-ask");
    // rules/management protection moved to _safety.md
    expect(flow).toContain("user-profile skill");
  });

  // STAGE-C-DM-FRESHNESS-PLAN §Task 3 — refetch directive must name the
  // structured anchors (`<today snapshot_at>` / `<turn_context>`), the
  // refetch endpoint, and English trigger phrases (equivalents in other
  // languages are governed by `<output_language_policy>`, not by a
  // hard-coded glossary in the task flow).
  it("DM ongoing flow names <today snapshot_at>, <turn_context>, GET /api/context/state/today, and English trigger phrases for the recent-activity refetch", () => {
    const flow = getTaskFlow("message.received.dm");
    expect(flow).toContain("Recent activity — refetch on demand");
    expect(flow).toContain('<today snapshot_at="...">');
    expect(flow).toContain('<turn_context current_time="..." snapshot_age_minutes="N" />');
    expect(flow).toContain("GET /api/context/state/today");
    // English trigger samples must be present so the agent recognizes
    // them verbatim. Non-English equivalents are handled by the
    // <output_language_policy> block injected per turn.
    expect(flow).toContain("anything new since X");
    expect(flow).toContain("anything happen");
    expect(flow).toContain("in the last N minutes");
    // The refetch directive is a positive permission ("refetch when …",
    // "no refetch needed for …"), not a "do NOT" prohibition. Verify the
    // wording bias.
    expect(flow).toContain("Refetch the live log when the user asks about recent activity");
    expect(flow).toContain("no refetch is needed");
  });

  it("DM prompts reference skills not inline API details", () => {
    for (const key of ["message.received.dm_first", "message.received.dm"]) {
      const flow = getTaskFlow(key);
      // Must reference skills
      expect(flow).toContain("external-services");
      // Must NOT inline curls that bypass the external-integration skills —
      // calendar / mail / tasks / travel routing all belong in their
      // respective skills. Exceptions:
      //   - `/api/context/user/*` PATCH (USER-PROFILE-CAPTURE-PLAN.md §Phase 1).
      //   - `/api/schedule*` curls inside the `_partials/dm-intent.project.md`
      //     decision tree (docs/design/appendices/skills-improvement.md Phase 0.4) — the confirm
      //     sub-flow's dedup-and-schedule logic is dispatcher work, not a
      //     skill-bypass.
      expect(flow).not.toMatch(
        /curl[^\n]*\/api\/(calendar|mail|tasks|travel|roadmap)/,
      );
    }
  });

  it("falls back to default for unknown types", () => {
    const flow = getTaskFlow("unknown.event.type");
    expect(flow).toContain("Event Processing");
  });

  it("accepts optional backendId without changing base flow", () => {
    const base = getTaskFlow("routine.morning_routine_today");
    const withBackend = getTaskFlow("routine.morning_routine_today", "claude");
    expect(withBackend).toBe(base);
  });

  it("returns base flow when overlay map has no entry for the backend", () => {
    const base = getTaskFlow("routine.hourly_check");
    const withGemini = getTaskFlow("routine.hourly_check", "gemini");
    expect(withGemini).toBe(base);
  });

  it("references skills instead of inline curl for context writes", () => {
    const morning = getTaskFlow("routine.morning_routine_today");
    // Stage A still hosts the today.md write contract — the skill
    // references and lock-id header are part of the synthesis flow.
    expect(morning).toContain("context skill");
    expect(morning).toContain("today_write_lock_id");
    expect(morning).toContain("X-Lock-Id");
  });

  it("message flow references user-profile skill", () => {
    const msg = getTaskFlow("message.received");
    expect(msg).toContain("user-profile skill");
  });

  it("evening review references user-profile skill for signal processing", () => {
    const evening = getTaskFlow("routine.evening_review");
    expect(evening).toContain("user-profile skill");
    expect(evening).toContain("Raw Signals");
    expect(evening).toContain("Learned Context");
    expect(evening).not.toContain("generate a weekly review");
  });

  it("weekly and monthly review prompts use the dedicated snapshot files", () => {
    const weekly = getTaskFlow("routine.weekly_review");
    const monthly = getTaskFlow("routine.monthly_review");
    expect(weekly).toContain("GET /api/context/list/daily");
    expect(weekly).toContain("<calendar_events_7d>");
    expect(monthly).toContain("GET /api/context/list/weekly");
    expect(monthly).toContain("<calendar_events_30d>");
  });

  it("returns roadmap refresh flow", () => {
    const flow = getTaskFlow("routine.roadmap_refresh");
    expect(flow).toContain("Roadmap Refresh");
    expect(flow).toContain("{context}");
    expect(flow).toContain("Agent Action Plan");
    expect(flow).toContain("calendar/events");
    expect(flow).toContain("PUT");
    expect(flow).toContain("policies/routines/monthly.md");
  });

  it("roadmap refresh reads pending scheduled tasks and preserves Long-term Plans", () => {
    const flow = getTaskFlow("routine.roadmap_refresh");
    // Phase 1: fetch pending/running scheduled tasks.
    expect(flow).toContain("/api/schedule?status=pending,running");
    expect(flow).toContain("roadmapEligible=true");
    // Phase 2: preserve-verbatim list must include Long-term Plans and Recurring.
    expect(flow).toContain("## Long-term Plans");
    // Phase 3: Required structure must include Long-term Plans (so PUT
    // does not erase the section) and a Scheduled: entry shape.
    expect(flow).toContain("### Scheduled:");
    // Last Reviewed escape hatch is gone — > Last synced is the audit line.
    expect(flow).not.toContain("Last Reviewed");
    expect(flow).toContain("Last synced");
  });

  it("roadmap refresh applies scheduled-task importance and 7-day horizon policy", () => {
    const flow = getTaskFlow("routine.roadmap_refresh");
    expect(flow).toContain("roadmapEligible=true");
    expect(flow).toContain("transient");
    expect(flow).toContain("low");
    expect(flow).toContain("7-day horizon");
    expect(flow).toContain("strategic");
  });

  it("roadmap refresh uses stable ids and transition-guard recovery", () => {
    const flow = getTaskFlow("routine.roadmap_refresh");
    expect(flow).toContain("merge-by-id");
    expect(flow).toContain("POST /api/context/plans/roadmap/id");
    expect(flow).toContain("payload.roadmap_entry_id");
    // Emoji-free Preparation Timeline row format (was previously
    // `✓ completed`; the on-disk legacy form is still accepted by
    // `roadmap-validate.ts` for backward compat).
    expect(flow).toContain("completed ...");
    expect(flow).toContain("transition guard");
    expect(flow).toContain("retry the full PUT once");
  });

  // RFC-B: Phase 1 must also pull upcoming travel bookings (authoritative
  // flight/hotel data already captured by the mail pipeline) and read the
  // rolling 7-day DM conversation log, which the context-builder injects
  // for roadmap_refresh so DM-seeded long-horizon items have a path into
  // the roadmap without a separate infra build-out.
  it("roadmap refresh Phase 1 pulls travel bookings and references DM history", () => {
    const flow = getTaskFlow("routine.roadmap_refresh");
    expect(flow).toContain("/api/travel-bookings/upcoming");
    expect(flow).toContain("Long-horizon DM-intent detection");
    // Must cite the actual injected tag, not legacy yesterday_* tags
    // that are only populated for morning_routine.
    expect(flow).toContain("recent_dm_conversation_log");
  });

  it("morning routine (Stage A) processes roadmap action items", () => {
    const morning = getTaskFlow("routine.morning_routine_today");
    expect(morning).toContain("Agent Action Plan");
    expect(morning).toContain("[notify]");
    expect(morning).toContain("[today]");
    expect(morning).toContain("[check]");
    expect(morning).toContain("[provisional");
  });

  // daily-journal-daemon-write.md §4.10 — journal authoring lives in
  // Stage B and emits two namespaced XML wrappers as final text; the
  // daemon composer writes the file.
  it("morning routine journal stage (Stage B) emits the namespaced wrappers and consumes the skeleton", () => {
    const journal = getTaskFlow("routine.morning_routine_journal");
    expect(journal).toContain("<aitne:daily-journal-body>");
    expect(journal).toContain("<aitne:daily-journal-frontmatter>");
    expect(journal).toContain("journal_skeleton");
    // Stage B has no tools — the task-flow must NOT instruct an HTTP
    // call to the chokepoint.
    expect(journal).not.toContain("PUT /api/context/daily");
  });

  it("morning routine keeps the day-type filter contract derived from Notification Preferences", () => {
    // Phase 4 variant collapse — both the recurring and first-run branches
    // dispatch under `routine.morning_routine` against one merged task-flow.
    // The flow must reference the today skill's canonical day-type section
    // and require reading Notification Preferences from user/profile.md so
    // both branches derive the same line-2 contract.
    const morning = getTaskFlow("routine.morning_routine_today");
    expect(morning).toContain("Notification Preferences");
    expect(morning).toContain("today skill");
    expect(morning).toContain("day-type");
    // The merged file must explicitly call out the first-run (no-yesterday)
    // branch so the agent picks it inline from prompt context.
    expect(morning).toMatch(/First-run \(`<yesterday>` absent\)/);
  });

  it("morning flow forbids meta context initialization tasks", () => {
    const morning = getTaskFlow("routine.morning_routine_today");
    expect(morning).toContain("Do **not** add meta-maintenance tasks about context files");
    // The phrase is split by a markdown line-wrap in the Stage A flow;
    // allow whitespace flexibility between the words.
    expect(morning).toMatch(/"initialize context\s+files"/);
  });

  // Phase 4 variant collapse defense in depth — Step 7.5 (profile-interview
  // queue) used to be skipped on the initial flow by two layers:
  // skills-manifest.ts withheld `user-interview` from
  // `routine.morning_routine_initial`, and the user-interview SKILL.md
  // listed the initial process key as a hard-skip in Operation 1. Both
  // layers became inert after Phase 4 unified dispatch under
  // `routine.morning_routine`, so the merged task-flow itself must carry
  // the first-run skip — otherwise a fresh-install user would receive
  // a profile question on day 1, which is the exact bad-UX outcome the
  // original two-layer defense existed to prevent.
  it("morning routine Stage A retains Step 7.5 profile-interview queue ordering", () => {
    const morning = getTaskFlow("routine.morning_routine_today");
    const step75Idx = morning.indexOf("### Step 7.5 — Profile-interview queue");
    const step8Idx = morning.indexOf("### Step 8 —");
    expect(step75Idx).toBeGreaterThan(-1);
    expect(step8Idx).toBeGreaterThan(step75Idx);
    const step75Block = morning.slice(step75Idx, step8Idx);
    // Phase (a) — mirror — must precede Phase (b) — pick — so the
    // latent-entry sync runs before any new-question selection.
    const phase75aIdx = step75Block.indexOf("#### Step 7.5a");
    const phase75bIdx = step75Block.indexOf("#### Step 7.5b");
    expect(phase75aIdx).toBeGreaterThan(-1);
    expect(phase75bIdx).toBeGreaterThan(phase75aIdx);
  });

  // `evening-review-slimdown.md` §2.3 (Phase 3) — Morning Routine owns
  // the did-not-fire marking that used to live in evening_review Step 1.
  // The substep runs against `<yesterday>` (the rotated archive day) so
  // the user-visible record carries an accurate close-the-loop tag
  // BEFORE today's plan is derived. Critical: it targets yesterday.md,
  // NOT today.md — flipping rows on the newly-generated today.md would
  // stomp the morning's plan immediately after PUT. The today-write-lock
  // is gated on `path === "today"` (see context.ts), so yesterday writes
  // intentionally need no `X-Lock-Id` — pin the inverse so a
  // "defensive" edit does not add a spurious lock acquisition.
  it("morning routine marks yesterday's unfired Agent Plan rows as did-not-fire under Step 1", () => {
    const morning = getTaskFlow("routine.morning_routine_today");
    expect(morning).toContain("did-not-fire");
    expect(morning).toContain("`<yesterday>` ## Agent Plan");
    expect(morning).toContain("PATCH `/api/context/state/yesterday`");
    expect(morning).toContain("section=agent_plan");
    expect(morning).toContain("section=agent_log");
    // `\s+` instead of a literal space — markdown line-wrap may split
    // "NO `X-Lock-Id`" from "header is needed" across a newline-indent,
    // and that whitespace is a rendering artifact, not a contract.
    expect(morning).toMatch(/NO `X-Lock-Id`\s+header is needed/);
    // Relative ordering inside the task-flow body — the substep must
    // sit under Step 1, BEFORE the day-type derive, so the archive is
    // closed out before today's plan composition starts.
    const didNotFireIdx = morning.indexOf("did-not-fire");
    const dayTypeIdx = morning.indexOf("Derive today's day-type header");
    expect(didNotFireIdx).toBeGreaterThan(-1);
    expect(dayTypeIdx).toBeGreaterThan(didNotFireIdx);
  });

  // LLM rebuilds of `## Agent Plan` silently drop sibling rows when the
  // keep-list isn't enumerated up front — this is the exact failure mode
  // the discipline block prevents, and the reason §2.3 routed this work
  // to the LLM (with the discipline guard) rather than to a calendar-
  // aware regex in `rotateDayFiles`. Also pins the "do not re-fire" rule
  // so the morning routine never surfaces a stale nudge from the retro
  // pass — that contract was the single biggest design risk noted in
  // §2.4 "Rare cases that Step 4 used to catch".
  it("morning routine's did-not-fire substep carries section-body-rebuild discipline and forbids retroactive execution", () => {
    const morning = getTaskFlow("routine.morning_routine_today");
    expect(morning).toContain("Section-body-rebuild discipline");
    expect(morning).toContain("GET the current `## Agent Plan` body fresh");
    expect(morning).toMatch(/keep-list/);
    expect(morning).toMatch(/byte-for-byte/);
    expect(morning).toMatch(/Do NOT retroactively execute/);
  });

  // The slimmed evening_review no longer marks did-not-fire on today.md
  // (§2.3 moved the ownership). Pin the negative: evening_review must
  // not regrow a Step 1 substep that flips Agent Plan rows, otherwise
  // both routines will race on the rotation boundary.
  it("evening review no longer marks did-not-fire on Agent Plan rows", () => {
    const evening = getTaskFlow("routine.evening_review");
    // Capital-F "Flip" sitting near "did-not-fire" is the exact directive
    // the slimdown removed (`Flip it to \`- [x] ... (did-not-fire)\``).
    // The earlier regex `/Flip [^.\n]*did-not-fire/` was vacuous — the
    // `[^.\n]*` class refuses to span the three dots inside `[x] ...`,
    // so it never matched the original prose and would have silently
    // accepted a re-introduction. `[\s\S]{0,200}?` keeps the search
    // tight (≤200 chars of any character, lazily matched) while still
    // catching the original wording. The current evening_review's
    // lowercase "flipped to `did-not-fire` by Morning Routine" prose
    // is intentionally below the case-sensitive trigger.
    expect(evening).not.toMatch(/Flip[\s\S]{0,200}?did-not-fire/);
    // The handoff substep prose explicitly hands the work to Morning
    // Routine — keep that as the documented contract so an editor who
    // re-adds the marking has to delete the prose first.
    expect(evening).toMatch(/Morning Routine reading yesterday\.md/);
  });

  it("evening review does not carry context initialization meta tasks into handoff", () => {
    const flow = getTaskFlow("routine.evening_review");
    expect(flow).toContain("Do **not** add or carry daemon-maintenance/meta items about context files");
  });

  // Evening Review Step 4 contract — user-facing wrap-up must not degrade
  // into an agent-report style message. These tests lock in the silence-by-
  // default polarity and the skill delegation, so future edits cannot
  // silently revert to the old "Send a summary" failure mode.

  it("evening review regression: does not use the old vague 'Send a summary' instruction", () => {
    const flow = getTaskFlow("routine.evening_review");
    expect(flow).not.toContain("Send a summary to the user via POST /api/notify");
  });

  // `evening-review-slimdown.md` §2.1 / §2.2 (Phase 2) — Step 2 was
  // trimmed to the two substeps that genuinely need an LLM in the loop:
  // 2a (Long-term Plans promote-on-resolution) and 2b (Review-date
  // fire). The mechanical sweeps (Scheduled: status sync, 180d Agent
  // Action Plan sweep, Long-term Plans stale/awaiting-reply marking)
  // moved into the daemon-driven `roadmap_mechanical_maintenance` cron
  // 15 minutes earlier — `roadmap-maintenance.ts`. This test pins the
  // surviving Step 2 surface so a regression that re-adds the
  // mechanical pieces under the LLM is caught here.
  it("evening review Step 2 owns Long-term Plans promotion and Review-date fire", () => {
    const flow = getTaskFlow("routine.evening_review");
    expect(flow).toContain("Step 2 — Roadmap maintenance");
    // Write-lock acquisition is mandatory before touching roadmap.md.
    expect(flow).toContain("POST /api/context/lock/roadmap");
    expect(flow).toContain("DELETE /api/context/lock/roadmap");
    // Section-body rebuild discipline (silent-drop guard) — applies to
    // both surviving substeps.
    expect(flow).toMatch(/rebuild discipline|keep-list/);
    // Long-term Plans is normally append-only; 2a is the one legal
    // remove path and must call out the data-loss risk.
    expect(flow).toContain("append-only");
    // 2a — promote-on-resolution: a Long-term Plan that resolved today
    // moves into Agent Action Plan with the same `<!-- id: rm-... -->`
    // marker, freeing the LLM to make the judgment call about whether
    // an entry is "resolved" (which a date-only sweep cannot do).
    expect(flow).toMatch(/2a\.\s+\*\*Promote Long-term Plans/);
    expect(flow).toContain("same `<!-- id: rm-... -->` marker");
    // 2b — fire-on-Review: due Long-term Plans either promote into
    // Agent Action Plan with a Preparation Timeline, or bump Review and
    // ReviewCount with the provisional tag.
    expect(flow).toMatch(/2b\.\s+\*\*Fire due Long-term Plans/);
    expect(flow).toContain("ReviewCount");
    expect(flow).toContain("[provisional");
  });

  // `evening-review-slimdown.md` §2.2 — mechanical sweeps (Scheduled
  // status sync, 180d Agent Action Plan sweep, Long-term Plans
  // stale/awaiting-reply marking) MUST no longer live in the task
  // flow. Their idempotent re-running by the daemon job is harmless,
  // but having the LLM re-derive them is the exact failure mode the
  // slimdown removes (LLM rebuilds silently drop sibling lines). This
  // negative assertion pins the move so a "reinstate Step 2d for
  // visibility" regression fails loud.
  it("evening review Step 2 no longer carries the mechanical sweeps that moved to the daemon job", () => {
    const flow = getTaskFlow("routine.evening_review");
    // 2a (Scheduled status sync) — no longer in the task flow body.
    expect(flow).not.toMatch(/Reconcile `Scheduled:` entry statuses/);
    // 2b (180d Agent Action Plan sweep) — no longer in the task flow body.
    expect(flow).not.toMatch(/Sweep `## Agent Action Plan` event entries/);
    expect(flow).not.toMatch(/more than 180 days in the future/);
    // 2d (Long-term Plans stale-mark) — no longer in the task flow body.
    expect(flow).not.toMatch(/Stale-mark Long-term Plans/);
    expect(flow).not.toContain("[stale since");
    expect(flow).not.toContain("[awaiting-reply");
  });

  // The C5 prohibition on mtime-based skipping was always correct, and
  // the new shape inherits it for free — the slim Step 2 has no
  // skip-on-recency knob at all. Keep the assertion so a future edit
  // doesn't reintroduce the wrong invalidation heuristic.
  it("evening review never gates Step 2 on roadmap mtime", () => {
    const flow = getTaskFlow("routine.evening_review");
    expect(flow).not.toMatch(/under 24 hours old/);
    expect(flow).not.toMatch(/mtime/);
  });

  // RFC-B: DM flows must route long-horizon intent through the roadmap
  // skill's detection block rather than inventing their own heuristics or
  // writing directly to roadmap.md. Ambiguous items must go to the
  // agent/journal.md candidate lane (dry-run), not straight to
  // Long-term Plans. Canonical path is `agent/journal.md` per
  // context-paths.ts and the CREATE_ONLY_PUT allowlist — see the
  // dm-conversational-flow appendix for the path migration story.
  it("DM flows reference the roadmap skill's long-horizon detection", () => {
    for (const key of ["message.received.dm", "message.received.dm_first"]) {
      const flow = getTaskFlow(key);
      expect(flow).toContain("roadmap");
      expect(flow).toMatch(/long-horizon|Long-horizon/);
      expect(flow).toContain("journal/agent");
      // Must not bypass the skill by embedding direct PATCH/PUT calls
      expect(flow).not.toMatch(/curl.*\/api\/context\/roadmap/);
    }
  });

  // DM flows must dispatch project-state intent (status, progress,
  // milestones, new project) through the Project DM-intent decision tree
  // — without this, named-workstream signals leak into the model's own
  // scratch memory instead of `projects/<slug>.md`. Post-docs/design/appendices/skills-improvement.md
  // Phase 0.4, the decision tree lives in `_partials/dm-intent.project.md`
  // (included into both DM flows). The `context` skill remains the writer
  // (PUT / PATCH / archive against `projects/*`). The rendered flow now
  // legitimately contains the decision-tree's curl examples; the
  // architectural invariant is enforced by asserting that the
  // dispatcher cites the `context` skill as the writer.
  it("DM flows include the dm-intent.project partial and cite context as writer", () => {
    for (const key of ["message.received.dm", "message.received.dm_first"]) {
      const flow = getTaskFlow(key);
      expect(flow).toMatch(/Project (DM-)?intent/);
      expect(flow).toContain("context");
      expect(flow).toMatch(/projects?\b/);
      // The decision-tree partial is included; raw `{include:...}`
      // directives must not leak to the LLM.
      expect(flow).not.toContain("{include:_partials/dm-intent.project.md}");
      // Phase 0.4 markers from the partial: decline-marker, slug grammar,
      // and reply branches all survive the inline.
      expect(flow).toContain("Decline-marker pre-check");
      expect(flow).toContain("Slug grammar");
      expect(flow).toContain("Reply branches");
      // `context` is cited as the writer (positive architectural marker).
      expect(flow.toLowerCase()).toMatch(/context.*writer/);
    }
  });

  // docs/design/appendices/skills-improvement.md Phase 0.4 — long-horizon decision tree is
  // included from the partial and the directive never leaks to the LLM.
  it("DM flows include the dm-intent.long-horizon partial and cite roadmap as writer", () => {
    for (const key of ["message.received.dm", "message.received.dm_first"]) {
      const flow = getTaskFlow(key);
      expect(flow).toMatch(/Long-horizon|long-horizon/);
      expect(flow).toContain("roadmap");
      expect(flow).not.toContain("{include:_partials/dm-intent.long-horizon.md}");
      // Markers from the partial: signal/non-signal lists + routing rules.
      expect(flow).toContain("Specific future date");
      expect(flow).toContain("Long-term Plans");
      expect(flow).toContain("agent-journal");
      // `roadmap` is cited as the writer (positive architectural marker).
      expect(flow.toLowerCase()).toMatch(/roadmap.*writer/);
    }
  });

  // docs/design/appendices/skills-improvement.md Phase 0.5 — capture-user-info partial
  // is included from DM, sweep, and evening_review. The directive never
  // leaks. user-profile remains the writer.
  it("DM, sweep, and evening_review include the capture-user-info partial", () => {
    for (const key of [
      "message.received.dm",
      "message.received.dm_first",
      "routine.user_profile_sweep",
      "routine.evening_review",
    ]) {
      const flow = getTaskFlow(key);
      expect(flow).not.toContain("{include:_partials/capture-user-info.md}");
      // Partial body markers — trigger surface + routing rules.
      expect(flow).toContain("Imperative tone/style directives");
      expect(flow).toContain("Declarative facts about the user");
      // user-profile is the writer everywhere.
      expect(flow).toContain("user-profile skill");
    }
  });

  // RFC-B: DM-originated scheduled tasks must reconcile the matching
  // Scheduled: entry in roadmap.md when they fire, so the user sees
  // Status flips live rather than waiting for the next refresh.
  it("scheduled.task confirms DM-origin Scheduled: entry via roadmap skill", () => {
    const flow = getTaskFlow("scheduled.task");
    expect(flow).toContain("roadmap");
    expect(flow).toContain("Scheduled:");
    // DM origin is surfaced via the `Origin:` line at the top of the
    // scheduled.task prompt (dispatcher maps agent_schedule.task_type
    // directly into the event source — see scheduler.ts where
    // source=row.task_type flows into {event_data[source]}).
    expect(flow).toMatch(/Origin:.*dm|DM-originated/i);
    // B2 fix: the dispatcher does NOT inject a roadmap_write_lock_id
    // for scheduled.task events, so the prompt must acquire the lock
    // itself via POST /api/context/lock/roadmap and release with
    // DELETE /api/context/lock/roadmap.
    expect(flow).toContain("POST /api/context/lock/roadmap");
    expect(flow).toContain("DELETE /api/context/lock/roadmap");
    // 409 retry path must be explicit
    expect(flow).toMatch(/409|back off 30 s|back off 30s/);
  });

  it("scheduled.task frames provisional roadmap reminders as confirmation questions", () => {
    const flow = getTaskFlow("scheduled.task");
    expect(flow).toContain("Provisional roadmap reminder contract");
    expect(flow).toContain("[provisional");
    expect(flow).toMatch(/confirmation|confirm/i);
    expect(flow).toContain("ESTA");
  });

  it("scheduled.task preserves roadmap ids and completed prep rows when reconciling", () => {
    const flow = getTaskFlow("scheduled.task");
    expect(flow).toContain("<!-- id: rm-... -->");
    // Emoji-free format (was previously `✓ completed ...`); the
    // legacy emoji-prefixed shape is still validator-accepted.
    expect(flow).toContain("completed ...");
    expect(flow).toContain("byte-for-byte");
  });

  // `evening-review-slimdown.md` §2.4 — Step 4 (user-facing wrap-up)
  // was deleted entirely. The built-in steps emit no user-facing
  // output by default; user-defined `routines/evening.md` rules are
  // authoritative and may still call /api/notify.
  it("evening review Step 4 is removed from the task flow", () => {
    const flow = getTaskFlow("routine.evening_review");
    // Section header itself must be gone.
    expect(flow).not.toMatch(/^###\s+Step\s*4\b/m);
    // 4a/4b/4c subheaders likewise.
    expect(flow).not.toMatch(/^####\s+4[abc]\./m);
    // The "Evening wrap-up contract" reference in the notify skill is
    // dropped in the same PR (notify/SKILL.md edit). The task flow
    // must NOT carry a hanging reference to it.
    expect(flow).not.toMatch(/Evening\s+wrap-up contract/i);
    // The (a)–(e) positive-trigger gate set was the load-bearing
    // structure of Step 4 — its absence is the strongest signal that
    // the deletion landed cleanly.
    expect(flow).not.toMatch(/positive triggers? holds?/i);
    expect(flow).not.toMatch(/awareness gate/i);
  });

  // §2.4 preamble Q3 resolution — the two-tier framing (built-in
  // silent / rulebook authoritative) is non-negotiable. Without it the
  // LLM may interpret "silent by default" as overriding user-authored
  // rulebook entries that emit messages, which would silently break
  // the Q6 conditional-notify wiring.
  it("evening review preamble keeps the rulebook authoritative over built-in silence", () => {
    const flow = getTaskFlow("routine.evening_review");
    expect(flow).toMatch(/routines\/evening\.md/);
    // The "authoritative" wording is the load-bearing token — paraphrase
    // is fine, but the assertion would break and signal a reviewer to
    // re-validate the two-tier intent.
    expect(flow).toMatch(/authoritative/i);
    // Must reference /api/notify as an allowed rulebook action — not as
    // a built-in step output.
    expect(flow).toMatch(/POST\s+\/api\/notify/);
    // No-user-facing-output-by-default framing for the built-in steps.
    expect(flow).toMatch(/no user-facing output by default/i);
  });

  it("setup.initial routes tone preferences to the character code block, not policies/management.md or profile.md", () => {
    const flow = getTaskFlow("setup.initial");
    const managementRulesSection = flow.split("### policies/management.md Format")[1] ?? "";
    // Communication-style content must never land in the management-rules file.
    expect(flow).toContain("Do NOT put communication style inside policies/management.md");
    expect(managementRulesSection).not.toContain("## Communication Style");
    expect(flow).toContain("<agent_identity>");
    expect(flow).not.toContain("{event_data[agentDisplayName]}");
    expect(flow).toContain("### identity/profile.md Format");
    expect(flow).toContain("PUT /api/context/identity/profile");
    expect(flow).toContain("## Notification Preferences");
    // Communication Style section is REMOVED from the profile skeleton —
    // tone preferences now flow through the ```character``` code block
    // which the dashboard stages into the inline Character editor in the
    // Rules step and PATCHes to /api/config atomically on Save & Finish.
    expect(flow).not.toContain("## Communication Style");
    expect(flow).toContain("```character");
    // The agent itself must NOT call /api/config — the dashboard owns
    // the PATCH. This guard exists because an earlier contract had the
    // agent PATCH directly; the double-write was redundant once the
    // Character step was folded into Rules.
    expect(flow).toMatch(/Do NOT[^\n]*PATCH \/api\/config|Do NOT call[^\n]*\/api\/config/i);
  });

  it("setup.update routes tone/style changes to the character code block, not user/profile.md", () => {
    const flow = getTaskFlow("setup.update");
    // Tone/style menu is labelled "Character" and targets the character
    // code block the dashboard stages into the inline editor.
    expect(flow).toContain("Character (tone / style / voice)");
    expect(flow).toContain("```character");
    // The agent must NOT call /api/config directly — same separation as
    // setup.initial. The dashboard persists both the management-rules
    // file and the new character value atomically on Save & Finish.
    // The source file may wrap the sentence across a newline — allow any
    // whitespace between words.
    expect(flow).toMatch(/Do NOT\s+call\s+PATCH\s+\/api\/config|DO NOT\s+PATCH\s+\/api\/config/i);
    // Must NOT tell the agent to write tone updates to user/profile.md
    // or to the management-rules file.
    expect(flow).not.toContain("update `user/profile.md`");
    expect(flow).not.toContain("## Communication Style");
  });

  // Phase 2.1 — ensure the user/ write paths are actually wired
  // into the prompts. Without these, the detailed profile layer stays
  // empty forever even though the API and skeletons exist.

  it("evening review promotes Raw Signals into user/, not just user/profile.md", () => {
    const flow = getTaskFlow("routine.evening_review");
    expect(flow).toContain("user-profile skill");
    expect(flow).toContain("Raw Signals");
    expect(flow).toContain("Learned Context");
    // Must actually mention the detailed layer
    expect(flow).toContain("user/");
    // Must describe the classification: pattern → user/profile.md,
    // detail-heavy → user/, noise → drop
    expect(flow).toMatch(/graduate|route/i);
    expect(flow).toContain("read-before-write");
    // Keeps the ~600 token budget discipline
    expect(flow).toContain("600 token");
  });

  it("setup.initial seeds identity/ from Q&A with a do-not-invent guard", () => {
    const flow = getTaskFlow("setup.initial");
    expect(flow).toContain("identity/");
    // All five detailed profile files should be mapped
    expect(flow).toContain("identity/people.md");
    expect(flow).toContain("identity/work.md");
    expect(flow).toContain("identity/expertise.md");
    expect(flow).toContain("identity/goals.md");
    expect(flow).toContain("identity/personal.md");
    // Must have the "do not invent" guard so the agent doesn't
    // hallucinate colleague names or project details
    expect(flow).toMatch(/do not invent or infer/i);
  });

  it("message and DM prompts reference the user-profile skill for profile updates", () => {
    for (const key of [
      "message.received",
      "message.received.dm_first",
      "message.received.dm",
    ]) {
      const flow = getTaskFlow(key);
      // Task flows delegate the detailed routing rules (user/profile.md vs
      // user/) to the user-profile skill rather than inlining them.
      expect(flow).toContain("user-profile skill");
    }
  });

  // SETUP-FLOW-REDESIGN-PLAN §5.8 / §11.1 — the legacy "tool selections"
  // form was deleted from the wizard. Phase 1 collected four radio
  // choices that were never persisted, just synthesized into a greeting
  // and discarded. The replacement is the agent-owned derive-then-confirm
  // strategy: `<tool_selections>` substitution and the "selected their
  // preferred tools via the UI" preamble must both be gone, otherwise
  // the agent will look for an injected block that no longer exists.
  it("setup.initial removes the deleted <tool_selections> block and form-style preamble (§5.8)", () => {
    const flow = getTaskFlow("setup.initial");
    expect(flow).not.toContain("<tool_selections>");
    expect(flow).not.toContain("</tool_selections>");
    expect(flow).not.toContain("tool_selections");
    expect(flow).not.toMatch(/selected their preferred tools via the UI/i);
    // Round-trip: the derive-then-confirm replacement must be present.
    // Without it the agent has no instruction for what to do with the
    // integration state at first turn.
    expect(flow).toContain("derive an initial Source-of-Truth");
    // Step 0 reads from the prompt-context tags emitted by
    // context-builder.ts, NOT from `/api/integrations` or `/api/config`.
    // Both endpoints are Approve-tier and the agent has only X-Read-Token,
    // so any curl produces 401 and the agent ends up fabricating answers
    // (the "Customize Your Rules" 401 bug). Pin the tag-based path here
    // so a future refactor doesn't silently re-introduce the curl calls.
    expect(flow).toContain("<integration_modes");
    expect(flow).toContain("<obsidian_vault_path>");
    // Match an actual curl command line — `curl … http://…/api/integrations`
    // — not the prose sentence that names the endpoint to forbid it.
    // The negative-lookahead `(?!\/)` excludes Autonomous-tier sub-paths
    // (`/api/integrations/<key>/exec`, `/api/config/character`) so this
    // regression guard pins ONLY the Approve-tier root reads that triggered
    // the 401 bug.
    expect(flow).not.toMatch(/curl[^\n`]*https?:\/\/[^\n]*\/api\/integrations(?!\/)/);
    expect(flow).not.toMatch(/curl[^\n`]*https?:\/\/[^\n]*\/api\/config(?!\/)/);
    // The Source-of-Truth template must reference the derived table,
    // not the deleted `selections` payload.
    expect(flow).not.toContain("{from selections}");
    expect(flow).toContain("{from derived table}");
  });

  // Customize-Your-Rules silent-3-minute bug: gpt-5.4-mini (and other
  // task-completion-biased models) collapsed setup.initial into a single
  // turn that emitted the management-rules template before the user
  // had answered any questions. The Codex defer-streaming fix removes
  // the dead-air symptom; this guard removes the root cause by making
  // the two-turn contract — Turn 1 = Q&A, Turn 2 = artifacts — explicit
  // in the prompt itself.
  it("setup.initial enforces an explicit two-turn structure (Turn 1 = Q&A only)", () => {
    const flow = getTaskFlow("setup.initial");
    // The headline section markers must be present so the model cannot
    // confuse Turn 1's "ask questions" responsibility with Turn 2's
    // "emit artifacts" responsibility.
    expect(flow).toContain("Turn 1 — Greet, present derived table, ask questions");
    expect(flow).toContain("Turn 2 — After the user replies, emit the artifacts");
    // Turn 1 must explicitly forbid emitting the rules / character blocks
    // and any write-curl. These three "DO NOT"s are the hard rule the
    // dispatcher's first-turn behavior depends on.
    const turn1Section = flow.split("### Turn 1")[1]?.split("### Turn 2")[0] ?? "";
    expect(turn1Section).toMatch(/do\s*\*?\*?not\*?\*?[^\n]*management-rules/i);
    expect(turn1Section).toMatch(/do\s*\*?\*?not\*?\*?[^\n]*character/i);
    expect(turn1Section).toMatch(/do\s*\*?\*?not\*?\*?[^\n]*curl/i);
    // Turn 2 must place the management-rules block first (the dashboard
    // reveals the preview as soon as the block lands, so emitting
    // anything else first delays the visible-progress signal).
    const turn2Section = flow.split("### Turn 2")[1] ?? "";
    expect(turn2Section).toMatch(/management-rules[\s\S]{0,80}FIRST/);
  });
});


describe("template variable resolution", () => {
  it("message.received template resolves all event_data placeholders", () => {
    const template = getTaskFlow("message.received");
    const event = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.NORMAL,
    });
    Object.assign(event, {
      platform: "slack",
      sender: "U123",
      content: "Ship it",
    });

    const data = extractEventData(event);
    const resolved = resolveTemplate(template, "<context>", data);

    expect(resolved).not.toMatch(/\{event_data\[/);
    expect(resolved).toContain("slack");
    expect(resolved).toContain("Ship it");
  });

  it("schedule.approaching template resolves all event_data placeholders", () => {
    const template = getTaskFlow("schedule.approaching");
    const event = {
      ...createEvent({
        type: "schedule.approaching",
        source: "calendar",
        priority: EventPriority.HIGH,
        // Mirror calendar-poller.ts:131-141 — the trigger-(a) detection
        // path keys off `event_data[calendarEventId]` to match the
        // observation row's `ref`, and `event_data[minutesUntil]` is
        // surfaced so the LLM doesn't need to recompute the heads-up
        // window from start/end timestamps.
        data: {
          calendarEventId: "evt-standup-1",
          summary: "Team Standup",
          startTime: "2026-04-06T10:00:00Z",
          endTime: "2026-04-06T10:30:00Z",
          minutesUntil: 12,
        },
      }),
      calendarId: "primary",
      eventTitle: "Team Standup",
      startTime: new Date("2026-04-06T10:00:00Z"),
      endTime: new Date("2026-04-06T10:30:00Z"),
      changeType: "approaching",
    } as CalendarChangeEvent;

    const data = extractEventData(event);
    const resolved = resolveTemplate(template, "<context>", data);

    expect(resolved).not.toMatch(/\{event_data\[/);
    expect(resolved).toContain("Team Standup");
    expect(resolved).toContain("2026-04-06T10:00:00.000Z");
    expect(resolved).toContain("2026-04-06T10:30:00.000Z");
    expect(resolved).toContain("evt-standup-1");
    expect(resolved).toContain("12");
  });

  it("hourly_check prompt points to observations review endpoints", () => {
    const flow = getTaskFlow("routine.hourly_check");
    expect(flow).toContain("observations skill");
    // docs/design/appendices/routine-data-acquisition.md Phase 3 R4: the merged read query
    // (both `actor=user` and `actor=agent` reach this session because the
    // Step 0 partials post mail / calendar / notion under `actor=agent`).
    // The legacy `actor=user&limit=20` query stays valid for early triage
    // and remains documented in the body.
    expect(flow).toContain("GET /api/observations?pending=true&limit=30");
    expect(flow).toContain("actor=user&limit=20");
    expect(flow).toContain("POST /api/observations/consume");
  });

  it("dashboard.docs_qa template surfaces the operator's question and the current-doc hint", () => {
    // Regression: the QA flow originally used `{context}` where the
    // user question should land, so the operator's first message was
    // swallowed before it ever reached the model. The fix routes the
    // user question through `{event_data[content]}` and the current-
    // doc hint through `{event_data[currentDocSlug]}`.
    const template = getTaskFlow("dashboard.docs_qa");
    const event = createEvent({
      type: "message.received",
      source: "dashboard",
      priority: EventPriority.HIGH,
    });
    Object.assign(event, {
      platform: "dashboard",
      sender: "user",
      channel: "qa-channel-1",
      content: "what is delegated mode?",
      threadId: null,
      isDm: true,
      isMention: false,
      intent: "docs_qa" as const,
    });
    event.data = {
      docsScope: "current",
      currentDocSlug: "concepts/delegated-mode",
      docsContextHint: { currentSlug: "concepts/delegated-mode" },
    };

    const data = extractEventData(event);
    const resolved = resolveTemplate(template, "<context>", data);

    expect(resolved).toContain("what is delegated mode?");
    expect(resolved).toContain("concepts/delegated-mode");
    // No orphan placeholders survive — catches both the original bug
    // (lost user content) and template-syntax regressions in either
    // direction (bare `{...}`, mustache-style `{{...}}`).
    expect(resolved).not.toMatch(/\{event_data\[/);
    expect(resolved).not.toMatch(/\{context\}/);
    expect(resolved).not.toMatch(/\{\{/);
  });

  it("dashboard.docs_qa template renders the '(none)' fallback when the operator has no current doc", () => {
    const template = getTaskFlow("dashboard.docs_qa");
    const event = createEvent({
      type: "message.received",
      source: "dashboard",
      priority: EventPriority.HIGH,
    });
    Object.assign(event, {
      platform: "dashboard",
      sender: "user",
      channel: "qa-channel-1",
      content: "what is a ProcessKey?",
      threadId: null,
      isDm: true,
      isMention: false,
      intent: "docs_qa" as const,
    });
    event.data = { docsScope: "all", currentDocSlug: "(none)" };

    const data = extractEventData(event);
    const resolved = resolveTemplate(template, "<context>", data);

    expect(resolved).toContain("what is a ProcessKey?");
    expect(resolved).toContain("(none)");
    expect(resolved).not.toMatch(/\{event_data\[/);
  });

  it("contract: DocsQAAdapter event populates the dashboard.docs_qa template end-to-end", () => {
    // Anchors the implicit contract between the adapter (writer of
    // `event.data` flat keys) and the task-flow file (reader of those
    // keys via `{event_data[...]}` placeholders). Without this test, a
    // rename on either side could pass independent unit tests while
    // silently breaking the live prompt.
    const onMessage = vi.fn();
    const adapter = new DocsQAAdapter(onMessage, { anchorsForSlug: () => null });
    const channelId = adapter.registerClient({
      writeSSE: async () => {},
      get closed() {
        return false;
      },
    });

    adapter.handleIncomingMessage(channelId, "what is delegated mode?", {
      scope: "current",
      contextHint: { currentSlug: "concepts/delegated-mode" },
    });

    const event = onMessage.mock.calls[0]![0] as MessageEvent;
    const data = extractEventData(event);
    const resolved = resolveTemplate(getTaskFlow("dashboard.docs_qa"), "<context>", data);

    expect(resolved).toContain("what is delegated mode?");
    expect(resolved).toContain("concepts/delegated-mode");
    expect(resolved).not.toMatch(/\{event_data\[/);
    expect(resolved).not.toMatch(/\{context\}/);
    expect(resolved).not.toMatch(/\{\{/);
  });
});

describe("task flow quality (Phase 9)", () => {
  it("hourly_check batches observations and prefers silence for noise", () => {
    const flow = getTaskFlow("routine.hourly_check");
    expect(flow).toContain("Decision Framework");
    expect(flow).toContain("Group related observations");
    expect(flow).toContain("Skip noise");
    expect(flow).toMatch(/Urgency gate/i);
    expect(flow).toMatch(/NEVER urgency triggers/i);
    expect(flow).toContain("Agent Log");
  });

  // Phase 5 partition-collision fix (INTEGRATION-DRIFT-DETECTION-PLAN.md
  // §11) originally landed by editing three `routine.hourly_check.delegated.<be>.md`
  // variant files. docs/design/appendices/routine-data-acquisition.md Phase 3 R4 deleted
  // those variants. Phase 4 D3 wires a pre-pass fetcher session
  // (`routine.fetch_window`) that runs the partials in its OWN prompt and
  // POSTs to `/api/observations` ahead of the main hourly_check session;
  // the main session reads pending observations and never embeds the
  // partials directly (per docs/design/appendices/routine-data-acquisition.md §6.8). The
  // partition-collision regression is therefore prevented by construction
  // — neither the main routine body nor the partial bodies (now consumed
  // by the pre-pass only) ever mention `/reconcile`. We pin the rendered
  // hourly_check body across all three legacy delegated backends to make
  // sure no future edit reintroduces a direct fetch / `/reconcile` POST
  // into the main session's prompt.
  for (const variantBackend of ["claude", "codex", "gemini"] as const) {
    it(`hourly_check (gmail+notion delegated to ${variantBackend}) does NOT POST gmail / notion reconcile`, () => {
      const ts = "2026-04-29T00:00:00.000Z";
      const integrations = {
        gmail: {
          mode: "delegated" as const,
          delegatedBackend: variantBackend,
          deniedTools: [],
          lastChangedAt: ts,
        },
        notion: {
          mode: "delegated" as const,
          delegatedBackend: variantBackend,
          deniedTools: [],
          lastChangedAt: ts,
        },
      };
      const flow = getTaskFlow(
        "routine.hourly_check",
        variantBackend,
        integrations,
      );

      // The rendered hourly_check must NOT carry a `/reconcile` curl POST
      // — neither in the base file nor through any (deleted) partial
      // include path.
      expect(flow).not.toMatch(
        /curl\s+[^\n]*-X\s+POST\s+[^\n]*\/api\/integrations\/gmail\/reconcile/,
      );
      expect(flow).not.toMatch(
        /curl\s+[^\n]*-X\s+POST\s+[^\n]*\/api\/integrations\/notion\/reconcile/,
      );
      expect(flow).not.toContain('"windowKey": "inbox:7d"');
      expect(flow).not.toContain('"windowKey": "recently_updated"');

      // The legacy "feeds Steps 1–4 as if it were a observation" framing
      // (pre-Phase-5) must stay out — observations now arrive via the
      // pre-pass session posting to `/api/observations`.
      expect(flow).not.toMatch(
        /feeds Steps 1[–-]4 as if it were a `mail:lifecycle` observation/,
      );
      expect(flow).not.toMatch(
        /feeds Steps 1[–-]4 as if it had arrived as a `notion:\*` observation/,
      );
      expect(flow).not.toMatch(/synthetic observation/i);

      // Step 7's row-less carve-out for the EventBus-driven imminent
      // reminder is documented in the stage-gate-decision block of the
      // base file under the `schedule_approaching` reason (underscore
      // form) — the legacy `schedule.approaching` dot form lived in the
      // deleted delegated variants. Either form satisfies the contract:
      // the agent must recognise this is a row-less signal class.
      expect(flow).toMatch(/schedule[._]approaching/);

      // After docs/design/appendices/routine-data-acquisition.md Phase 3 R4, the main
      // hourly_check session does NOT embed the acquisition partials —
      // they live in the pre-pass session's prompt only (§6.8). The
      // body must reference `/api/observations` (the read path) and
      // `<fetch_report>` (the pre-pass status block ContextBuilder
      // injects). The catalog phrasing that used to live inline now
      // lives in `routine.fetch_window.md` exclusively.
      expect(flow).toContain("/api/observations");
      expect(flow).toContain("<fetch_report>");
      expect(flow).not.toContain("{include:_partials/");
      expect(flow).not.toContain("catalog's `delegated` form");
    });
  }

  it("schedule.approaching references the calendar subsection", () => {
    const flow = getTaskFlow("schedule.approaching");
    expect(flow).toContain("notify skill");
    expect(flow).toContain("context skill");
    expect(flow).toContain("Agent Notes");
    expect(flow).toContain("Agent Log");
    // Heads-up window: `calendar-poller.ts:125` fires at
    // `minutesUntil <= 15`. The prompt MUST reference 15 minutes (not
    // the older "60 minutes" wording, which was factually wrong and
    // shipped briefly during the messaging-discipline plan rollout
    // before being corrected in the post-implementation audit).
    expect(flow).toContain("15 minutes");
    expect(flow).not.toContain("60 minutes");
    expect(flow).toContain("even when skipping");
    expect(flow).toContain('"Observer event formats → schedule.approaching"');
    expect(flow).not.toMatch(/curl\s+-s\s+-X\s+PATCH/);
  });
});

describe("today skill formats", () => {
  // docs/design/appendices/skills-improvement.md §2 — Agent Plan lifecycle moved into
  // `references/agent-plan-lifecycle.md`. Inline `{{> ref:* }}`
  // directives so structural assertions see the post-materialisation
  // body the runtime would produce.
  const TODAY_SKILL_DIR = join(REPO_ROOT, "agent-assets/skills/today");
  const skillContent = renderReferenceIncludes(
    readFileSync(TODAY_SKILL_PATH, "utf-8"),
    TODAY_SKILL_DIR,
  );

  it("documents the schedule.approaching formats", () => {
    expect(skillContent).toContain(
      "## schedule.approaching → Agent Notes + Agent Log",
    );
    expect(skillContent).toContain("event_title starts at HH:MM");
    expect(skillContent).toContain("- HH:MM [cal] event_title");
    // Earlier revisions pinned "60 min" here. The firing flow
    // (`imminent-event-scheduler.ts:281`) gates at `minutesUntil <= 15`,
    // so the 60-min gate restated in this skill was both stale and
    // redundant with the firing flow's own gate. The format documentation
    // now points back to the firing flow rather than restating a window —
    // this assertion guards against the stale figure being reintroduced.
    // (2026-06 audit: corrected the citation from the unrelated
    // calendar-poller.ts:125 to the actual emit site.)
    expect(skillContent).not.toContain("60 min");
    expect(skillContent).toContain("imminent-event-scheduler.ts:281");
  });

  it("documents the Agent Plan lifecycle", () => {
    expect(skillContent).toContain("## Agent Plan lifecycle");
    expect(skillContent).toContain("close the loop");
    // Post-extraction the phrasing in `references/agent-plan-lifecycle.md`
    // anchors the same warning under "Read-before-write" (line wraps
    // before "the entire section body", so anchor on the load-bearing
    // verb instead).
    expect(skillContent).toContain('`PATCH mode: "replace"` replaces');
  });
});

describe("observations skill logging formats", () => {
  const skillContent = readFileSync(OBSERVATIONS_SKILL_PATH, "utf-8");

  it("has the observation review logging section", () => {
    expect(skillContent).toContain("## Observation Review Logging");
    expect(skillContent).toContain("review pending observations in aggregate");
  });

  it("documents the observations Agent Log format", () => {
    expect(skillContent).toContain("### observations → Agent Log");
    expect(skillContent).toContain(
      "- HH:MM [observations] summary_of_review",
    );
    expect(skillContent).toContain("skipped (personal journal)");
    expect(skillContent).toContain("skipped (auto-generated)");
  });
});

// `getTaskFlow` runs the loaded body through `applyIntegrationModeFilter`
// only when both `backendId` and `integrations` are supplied. Verify the
// switch on a flow we know carries calendar mode markers.
describe("getTaskFlow — integration mode switching", () => {
  const ts = "2026-04-26T00:00:00.000Z";
  const directState = {
    google_calendar: {
      mode: "direct" as const,
      delegatedBackend: null,
      deniedTools: [],
      lastChangedAt: ts,
    },
  };
  const delegatedToGemini = {
    google_calendar: {
      mode: "delegated" as const,
      delegatedBackend: "gemini" as const,
      deniedTools: [],
      lastChangedAt: ts,
    },
  };

  it("DM flow keeps the direct calendar instruction in direct mode", () => {
    const flow = getTaskFlow("message.received.dm_first", "claude", directState);
    // Direct branch carries the call-to-action; the cross-backend branch
    // was stripped so its invoke endpoint must not appear.
    expect(flow).toMatch(/call `GET \/api\/calendar\/events`/);
    expect(flow).not.toContain("<!-- mode:");
    expect(flow).not.toContain("/api/integrations/google_calendar/exec");
  });

  it("DM flow swaps to the cross-backend invoke instruction when Calendar is delegated to a different backend", () => {
    const flow = getTaskFlow(
      "message.received.dm_first",
      "claude",
      delegatedToGemini,
    );
    // Cross-backend branch carries the invoke call; the direct branch's
    // call-to-action `GET /api/calendar/events` must be stripped. The
    // raw string `/api/calendar/events` can survive in a "do NOT call"
    // warning, so anchor on the imperative shape.
    expect(flow).toContain("/api/integrations/google_calendar/exec");
    expect(flow).not.toMatch(/call `GET \/api\/calendar\/events`/);
    expect(flow).not.toContain("<!-- mode:");
  });

  it("DM flow points at native MCP when Calendar is delegated to the session's backend (same-backend)", () => {
    const flow = getTaskFlow(
      "message.received.dm_first",
      "gemini",
      {
        google_calendar: {
          mode: "delegated",
          delegatedBackend: "gemini",
          deniedTools: [],
          lastChangedAt: ts,
        },
      },
    );
    // delegated-same branch: native MCP only. Anchor on absent imperatives
    // (the same-backend block does mention `/api/calendar/events` in a
    // "do NOT call" warning, so a bare substring check is too coarse).
    expect(flow).not.toMatch(/call `GET \/api\/calendar\/events`/);
    expect(flow).not.toMatch(/call `POST \/api\/integrations\//);
    expect(flow.toLowerCase()).toContain("native");
  });

  it("preserves mode markers when neither backendId nor integrations is supplied (filter is a no-op)", () => {
    const flow = getTaskFlow("message.received.dm_first");
    // Authoring tooling and tests that don't carry session context see the
    // raw markers — they're cheaper to grep against.
    expect(flow).toContain("<!-- mode:");
  });
});

// Exhaustive matrix: every (calendar mode × session backend) cell. For each
// cell, the loaded DM flow must keep exactly one branch's distinctive prose
// and strip every other branch's distinctive prose. This is the regression
// fence around the four-way prompt switch and protects against future edits
// that accidentally bleed direct-mode prose into delegated mode (or vice
// versa).
describe("getTaskFlow — full integration mode × session backend matrix", () => {
  type Branch = "direct" | "delegated-same" | "delegated-cross" | "disabled";
  type Backend = "claude" | "codex" | "gemini";

  // Distinctive prose anchors. Each pattern must appear in exactly one
  // branch of `message.received.dm_first.md`, otherwise the matrix below
  // can't pin down which branch survived.
  const distinctive: Record<Branch, RegExp> = {
    "direct": /call `GET \/api\/calendar\/events`/,
    "delegated-same": /native Google Calendar MCP tools/,
    "delegated-cross": /call `POST \/api\/integrations\/google_calendar\/exec`/,
    "disabled": /real-time calendar access is unavailable/,
  };

  type Cell = {
    label: string;
    integrations: Record<string, IntegrationStateForTest>;
    session: Backend;
    expected: Branch;
  };
  type IntegrationStateForTest = {
    mode: "direct" | "delegated" | "disabled";
    delegatedBackend: Backend | null;
    deniedTools: string[];
    lastChangedAt: string;
  };

  const ts = "2026-04-26T00:00:00.000Z";
  const cells: Cell[] = [];
  for (const session of ["claude", "codex", "gemini"] as const) {
    cells.push({
      label: `direct/${session}`,
      session,
      integrations: {
        google_calendar: {
          mode: "direct",
          delegatedBackend: null,
          deniedTools: [],
          lastChangedAt: ts,
        },
      },
      expected: "direct",
    });
    cells.push({
      label: `disabled/${session}`,
      session,
      integrations: {
        google_calendar: {
          mode: "disabled",
          delegatedBackend: null,
          deniedTools: [],
          lastChangedAt: ts,
        },
      },
      expected: "disabled",
    });
    for (const delegated of ["claude", "codex", "gemini"] as const) {
      cells.push({
        label: `delegated→${delegated}/${session}`,
        session,
        integrations: {
          google_calendar: {
            mode: "delegated",
            delegatedBackend: delegated,
            deniedTools: [],
            lastChangedAt: ts,
          },
        },
        expected: delegated === session ? "delegated-same" : "delegated-cross",
      });
    }
  }

  // Sanity: 3 sessions × (1 direct + 1 disabled + 3 delegated backends) = 15.
  it("enumerates 15 distinct cells", () => {
    expect(cells.length).toBe(15);
  });

  it.each(cells)(
    "$label keeps only the $expected branch in message.received.dm_first",
    (cell) => {
      const flow = getTaskFlow(
        "message.received.dm_first",
        cell.session,
        cell.integrations as never,
      );
      // The expected branch's distinctive prose must be present.
      expect(flow).toMatch(distinctive[cell.expected]);
      // Every other branch's distinctive prose must be stripped.
      for (const branch of Object.keys(distinctive) as Branch[]) {
        if (branch === cell.expected) continue;
        expect(flow).not.toMatch(distinctive[branch]);
      }
      // No raw markers may survive the filter.
      expect(flow).not.toContain("<!-- mode:");
      expect(flow).not.toContain("<!-- /mode:");
    },
  );

  // docs/design/appendices/routine-data-acquisition.md Phase 3 R3 + Phase 4 D4 —
  // `routine.today_refresh`'s inline four-branch Step 1 was first
  // replaced by partial includes (Phase 3 transitional) and then the
  // partials themselves were lifted out of the main routine body
  // entirely once the dispatcher pre-pass (`routine.fetch_window`)
  // landed. The main session now reads `/api/observations` and
  // consults `<fetch_report>`; per-mode wire surfaces live in the
  // pre-pass session's prompt only (§6.8). The branch-survival
  // coverage now lives in `routine-task-flow-includes.test.ts`
  // (pre-pass include-resolution assertions) and
  // `routine-partials-render.test.ts` (per-partial branch markers).
  it.each(cells)(
    "$label resolves the calendar partial in routine.today_refresh without leaving raw mode markers",
    (cell) => {
      const flow = getTaskFlow(
        "routine.today_refresh",
        cell.session,
        cell.integrations as never,
      );
      // The main routine body must no longer embed any partial-include
      // directive — the pre-pass session is the sole consumer of those.
      expect(flow).not.toContain("{include:_partials/");
      // No mode markers may survive — the body has none to begin with
      // (no per-mode prose lives in the main session anymore).
      expect(flow).not.toContain("<!-- mode:");
      // Every cell — including disabled — must surface the read-path
      // contract: the routine reads observations, the pre-pass posts
      // them. Disabled cells trigger a "skip" branch in the routine
      // prose driven by `<fetch_report status="skipped">`.
      expect(flow).toContain("/api/observations");
      expect(flow).toContain("<fetch_report");
    },
  );

  // The DM (non-first) flow received the same four-branch Calendar wrap
  // when this implementation extended the mode-filter to non-Gmail/Notion
  // sites. Anchors are line-start-anchored leading phrases — both
  // `delegated-same` and `delegated-cross` mention "native … Calendar MCP
  // tools" in different roles (use vs forbid), so a bare `/native … MCP/`
  // matcher would pin the wrong branch.
  it.each(cells)(
    "$label keeps only the $expected branch in message.received.dm",
    (cell) => {
      const dmAnchors: Record<Branch, RegExp> = {
        "direct": /^direct mode → `GET \/api\/calendar\/events`/m,
        "delegated-same": /^same-backend delegated → your session's native/m,
        "delegated-cross": /^cross-backend delegated → `POST/m,
        "disabled": /^disabled → tell the user real-time/m,
      };
      const flow = getTaskFlow(
        "message.received.dm",
        cell.session,
        cell.integrations as never,
      );
      expect(flow).toMatch(dmAnchors[cell.expected]);
      for (const branch of Object.keys(dmAnchors) as Branch[]) {
        if (branch === cell.expected) continue;
        expect(flow).not.toMatch(dmAnchors[branch]);
      }
      expect(flow).not.toContain("<!-- mode:");
    },
  );

  // Roadmap refresh used to wrap its 90-day Calendar fetch in the same
  // four-branch mode-filter block as the DM flows. After the calendar-
  // context unification, the per-mode wire surfaces live entirely in the
  // `<calendar_events_90d>` block injected by `ContextBuilder` — the
  // task-flow body just tells the agent to consume that block. This
  // matrix pins that the body is now mode-agnostic across every
  // (session, integration-mode, delegated-backend) cell while still
  // surfacing the canonical block reference.
  it.each(cells)(
    "$label leaves routine.roadmap_refresh mode-agnostic — no per-mode branch survives in the body",
    (cell) => {
      const flow = getTaskFlow(
        "routine.roadmap_refresh",
        cell.session,
        cell.integrations as never,
      );
      // The body must reference the canonical context block every cell
      // can read.
      expect(flow).toContain("<calendar_events_90d>");
      // No raw mode markers may survive — the body has none to begin
      // with after the unification (mode-awareness moved to the
      // ContextBuilder block).
      expect(flow).not.toContain("<!-- mode:");
      // The legacy hand-rolled prose for the four old branches is gone.
      // Pin the absence so a future revert doesn't silently reintroduce
      // the native-mode regression.
      expect(flow).not.toMatch(/Direct mode:\n\s*```\n\s*curl -s 'http:\/\/localhost:8321\/api\/calendar\/events\?date=today&days=90'/);
      expect(flow).not.toMatch(/Same-backend delegated — the connector is signed in/);
      expect(flow).not.toMatch(/Cross-backend delegated — call the daemon's/);
      expect(flow).not.toMatch(/Calendar is disabled — skip the calendar fetch entirely/);
    },
  );
});

// Mirror of the Calendar matrix above, extended to Gmail. The four-branch
// wrapper is applied to every task flow that hardcodes
// `/api/mail/:accountId/messages?limit=10`. Each cell asserts the right
// branch's distinctive prose survives, every other branch's prose is
// stripped, and no raw `<!-- mode:* -->` markers remain.
describe("getTaskFlow — Gmail mode × session backend matrix", () => {
  type Branch = "direct" | "delegated-same" | "delegated-cross" | "disabled";
  type Backend = "claude" | "codex" | "gemini";

  type IntegrationStateForTest = {
    mode: "direct" | "delegated" | "disabled";
    delegatedBackend: Backend | null;
    deniedTools: string[];
    lastChangedAt: string;
  };

  // Distinctive prose anchors per branch — each pattern appears in exactly
  // one of the four `<!-- mode:*:gmail -->` blocks across the three Gmail
  // task flows. The terse blocks (Phase 1.1 dedup) reflow across markdown
  // line wraps, so every regex uses `\s+` between word boundaries to
  // tolerate any indentation/break combination.
  const distinctive: Record<Branch, RegExp> = {
    "direct": /for\s+every\s+account\s+\(Gmail,\s+Outlook,\s+iCloud,\s+Yahoo,\s+IMAP\s+—\s+same\s+wire\s+surface\)/,
    "delegated-same": /session\s+backend's\s+native\s+Gmail\s+MCP\s+tool/,
    "delegated-cross": /POST\s+http:\/\/localhost:8321\/api\/integrations\/gmail\/exec/,
    "disabled": /Gmail\s+is\s+disabled\s+—\s+skip\s+Gmail\s+accounts\s+entirely/,
  };

  type Cell = {
    label: string;
    integrations: Record<string, IntegrationStateForTest>;
    session: Backend;
    expected: Branch;
  };

  const ts = "2026-04-26T00:00:00.000Z";
  const cells: Cell[] = [];
  for (const session of ["claude", "codex", "gemini"] as const) {
    cells.push({
      label: `direct/${session}`,
      session,
      integrations: {
        gmail: {
          mode: "direct",
          delegatedBackend: null,
          deniedTools: [],
          lastChangedAt: ts,
        },
      },
      expected: "direct",
    });
    cells.push({
      label: `disabled/${session}`,
      session,
      integrations: {
        gmail: {
          mode: "disabled",
          delegatedBackend: null,
          deniedTools: [],
          lastChangedAt: ts,
        },
      },
      expected: "disabled",
    });
    for (const delegated of ["claude", "codex", "gemini"] as const) {
      cells.push({
        label: `delegated→${delegated}/${session}`,
        session,
        integrations: {
          gmail: {
            mode: "delegated",
            delegatedBackend: delegated,
            deniedTools: [],
            lastChangedAt: ts,
          },
        },
        expected: delegated === session ? "delegated-same" : "delegated-cross",
      });
    }
  }

  it("enumerates 15 distinct cells", () => {
    expect(cells.length).toBe(15);
  });

  // Every flow that hardcodes the direct Gmail fetch surface gets the same
  // four-branch treatment. Listing them once here keeps the assertion shape
  // identical and surfaces drift as a single failure when prose is moved.
  //
  // docs/design/appendices/routine-data-acquisition.md Phase 3 R1 / R2 — the inline
  // `<!-- mode:*:gmail -->` blocks in `routine.morning_routine.md` and
  // `routine.morning_routine_initial.md` were replaced by partial
  // includes (`mail-acquire.gmail.md` + `mail-acquire.outlook_mail.md` +
  // `notion-acquire.notion.md`). The original "distinctive" anchors
  // (`for every account (Gmail, Outlook, iCloud, …)`,
  // `session backend's native Gmail MCP tool`,
  // `POST http://...gmail/exec`, `Gmail is disabled — skip Gmail accounts`)
  // are no longer in the routine body — they were specific to the deleted
  // 4-branch block. The per-partial branch-survival coverage moved to
  // `routine-task-flow-includes.test.ts` (rendered-output assertions) and
  // `routine-partials-render.test.ts` (per-partial branch markers).
  //
  // `scheduled.dm` retains the legacy 4-branch wrap; the matrix below
  // narrows to that flow only.
  const gmailFlows = ["scheduled.dm"] as const;

  for (const flowName of gmailFlows) {
    it.each(cells)(
      `${flowName}: $label keeps only the $expected gmail branch`,
      (cell) => {
        const flow = getTaskFlow(flowName, cell.session, cell.integrations as never);
        expect(flow).toMatch(distinctive[cell.expected]);
        for (const branch of Object.keys(distinctive) as Branch[]) {
          if (branch === cell.expected) continue;
          expect(flow).not.toMatch(distinctive[branch]);
        }
        expect(flow).not.toContain("<!-- mode:gmail");
        expect(flow).not.toContain("<!-- mode:direct:gmail");
        expect(flow).not.toContain("<!-- mode:delegated-same:gmail");
        expect(flow).not.toContain("<!-- mode:delegated-cross:gmail");
        expect(flow).not.toContain("<!-- mode:disabled:gmail");
        expect(flow).not.toContain("<!-- /mode:");
      },
    );

  }

  // Replacement coverage for `routine.morning_routine`. Phase 3 R1 / R2
  // of `docs/design/appendices/routine-data-acquisition.md` first replaced the inline
  // `<!-- mode:*:gmail -->` blocks with partial includes; Phase 4 D2
  // then lifted the partials out of the main routine body once the
  // dispatcher pre-pass landed. The main session now reads observations
  // directly; per-(mode, backend) wire surfaces live in
  // `routine.fetch_window.md` exclusively (§6.8). The detailed
  // per-branch coverage moved to `routine-partials-render.test.ts`
  // (per-partial branch markers) and `routine-task-flow-includes.test.ts`
  // (pre-pass include-resolution assertions).
  //
  // `routine.morning_routine_initial` is no longer in this list —
  // `docs/design/appendices/morning-routine-optimization.md` Phase 4
  // collapsed it into the same task-flow as `routine.morning_routine`
  // via an in-prompt first-run branch and removed the separate file.
  const partialMailRoutines = ["routine.morning_routine_today"] as const;
  for (const flowName of partialMailRoutines) {
    it.each(cells)(
      `${flowName}: $label resolves the gmail partial without leaving raw mode markers`,
      (cell) => {
        const flow = getTaskFlow(flowName, cell.session, cell.integrations as never);
        // No partial-include directives in the main routine body —
        // the pre-pass session is the sole consumer.
        expect(flow).not.toContain("{include:_partials/mail-acquire.gmail.md}");
        expect(flow).not.toContain("{include:_partials/mail-acquire.outlook_mail.md}");
        expect(flow).not.toContain("{include:_partials/notion-acquire.notion.md}");
        // No mode markers may survive (the body never carried them
        // post-Phase-4 — assertion stays as a regression guard).
        expect(flow).not.toContain("<!-- mode:");
        expect(flow).not.toContain("<!-- /mode:");
        // Every cell — direct / disabled / delegated → any backend —
        // must surface the read-path contract: the routine reads
        // observations, and `<fetch_report>` documents the pre-pass
        // status. The integration-mode discriminator no longer
        // changes the morning_routine body.
        expect(flow).toContain("/api/observations");
        expect(flow).toContain("<fetch_report>");
      },
    );
  }

  // Delegated-mode v2 contract surface. Every per-session-backend variant
  // of the mail SKILL must direct the agent at the natural-language
  // `/api/integrations/gmail/exec` endpoint with `outputSchema` validation.
  // Per-backend tool-arg name pinning (`limit` vs `max_results` vs
  // `maxResults`) was removed in v2 — the daemon picks the tool, so the
  // agent describes intent in prose, not a connector-specific JSON shape.
  // See `docs/design/17-delegated-mode-v2.md` §4.1.
  for (const variantBackend of ["claude", "codex", "gemini"] as const) {
    it(`mail SKILL.delegated.${variantBackend}.md exposes the v2 /exec contract`, () => {
      const body = readFileSync(
        join(REPO_ROOT, `agent-assets/skills/mail/SKILL.delegated.${variantBackend}.md`),
        "utf-8",
      );
      expect(body).toContain("POST /api/integrations/gmail/exec");
      expect(body).toContain("outputSchema");
      expect(body).toContain("allowDestructive");
    });
  }
});

// Notion mode-filter matrix for `observations/SKILL.md`. Skill bodies do not
// flow through `getTaskFlow` — `applyIntegrationModeFilter` is invoked
// directly during session materialization (see `skills-compiler.ts`), so
// the test reads the file from disk and exercises the filter inline.
describe("applyIntegrationModeFilter — Notion mode × session backend matrix on observations/SKILL.md", () => {
  type Branch = "direct" | "delegated-same" | "delegated-cross" | "disabled";
  type Backend = "claude" | "codex" | "gemini";

  type IntegrationStateForTest = {
    mode: "direct" | "delegated" | "disabled";
    delegatedBackend: Backend | null;
    deniedTools: string[];
    lastChangedAt: string;
  };

  const SKILL_BODY = readFileSync(OBSERVATIONS_SKILL_PATH, "utf-8");

  const distinctive: Record<Branch, RegExp> = {
    "direct": /curl -s "http:\/\/localhost:8321\/api\/notion\/query\?database=tasks"/,
    "delegated-same": /Use your session backend's native Notion MCP tool/,
    "delegated-cross": /POST http:\/\/localhost:8321\/api\/integrations\/notion\/exec/,
    "disabled": /Notion is disabled — there is no live source/,
  };

  type Cell = {
    label: string;
    integrations: Record<string, IntegrationStateForTest>;
    session: Backend;
    expected: Branch;
  };

  const ts = "2026-04-26T00:00:00.000Z";
  const cells: Cell[] = [];
  for (const session of ["claude", "codex", "gemini"] as const) {
    cells.push({
      label: `direct/${session}`,
      session,
      integrations: {
        notion: {
          mode: "direct",
          delegatedBackend: null,
          deniedTools: [],
          lastChangedAt: ts,
        },
      },
      expected: "direct",
    });
    cells.push({
      label: `disabled/${session}`,
      session,
      integrations: {
        notion: {
          mode: "disabled",
          delegatedBackend: null,
          deniedTools: [],
          lastChangedAt: ts,
        },
      },
      expected: "disabled",
    });
    for (const delegated of ["claude", "codex", "gemini"] as const) {
      cells.push({
        label: `delegated→${delegated}/${session}`,
        session,
        integrations: {
          notion: {
            mode: "delegated",
            delegatedBackend: delegated,
            deniedTools: [],
            lastChangedAt: ts,
          },
        },
        expected: delegated === session ? "delegated-same" : "delegated-cross",
      });
    }
  }

  it("enumerates 15 distinct cells", () => {
    expect(cells.length).toBe(15);
  });

  it.each(cells)(
    "$label keeps only the $expected notion branch in observations/SKILL.md",
    (cell) => {
      const filtered = applyIntegrationModeFilter(
        SKILL_BODY,
        cell.integrations as never,
        cell.session,
      );
      expect(filtered).toMatch(distinctive[cell.expected]);
      for (const branch of Object.keys(distinctive) as Branch[]) {
        if (branch === cell.expected) continue;
        expect(filtered).not.toMatch(distinctive[branch]);
      }
      expect(filtered).not.toContain("<!-- mode:direct:notion");
      expect(filtered).not.toContain("<!-- mode:delegated-same:notion");
      expect(filtered).not.toContain("<!-- mode:delegated-cross:notion");
      expect(filtered).not.toContain("<!-- mode:disabled:notion");
    },
  );
});

describe("roadmap skill contract", () => {
  // SKILLS-PHASE-2-PLAN.md §4.3 — horizon-tag table and Preparation Timeline
  // taxonomy live in `references/*.md` after Phase 2-B. Resolve `{{> ref:* }}`
  // directives so the test asserts against the body the agent actually sees,
  // not the un-resolved navigation overview.
  const skillContent = renderReferenceIncludes(
    readFileSync(ROADMAP_SKILL_PATH, "utf-8"),
    join(REPO_ROOT, "agent-assets/skills/roadmap"),
  );

  it("documents Long-term Plans Review fields and horizon table", () => {
    expect(skillContent).toContain("Review: <YYYY-MM-DD|[noreview]>");
    expect(skillContent).toContain("ReviewCount: <0-3>");
    expect(skillContent).toContain("YYYY-Qn");
    expect(skillContent).toContain("Source date + 90 days");
    expect(skillContent).toContain("Source: dashboard <today>");
  });

  it("documents stable ids and completed prep-row preservation", () => {
    expect(skillContent).toContain("## Stable entry identity");
    expect(skillContent).toContain("rm-YYYYMMDD-<6 lowercase hex>");
    expect(skillContent).toContain("POST /api/context/plans/roadmap/id");
    // Preparation Timeline row format in the post-emoji-sweep shape.
    // The validator still accepts the legacy `✓ completed ...` shape
    // for on-disk backward compat.
    expect(skillContent).toContain("completed YYYY-MM-DD: YYYY-MM-DD [tag]: description");
    expect(skillContent).toContain("transition guard");
  });

  it("documents scheduled-task pollution policy", () => {
    expect(skillContent).toContain("task_context.importance is \"transient\" or \"low\"");
    expect(skillContent).toContain("now + 7d");
    expect(skillContent).toContain("strategic");
  });
});

describe("reading skill roadmap contract", () => {
  const skillContent = readFileSync(READING_SKILL_PATH, "utf-8");

  it("queues roadmap_candidate:reading observations for goal-shaped reading intent", () => {
    expect(skillContent).toContain("roadmap_candidate:reading");
    expect(skillContent).toContain("reading_goal");
    expect(skillContent).toContain("horizon_tag");
    expect(skillContent).toContain("Finish Designing Data-Intensive Applications");
    expect(skillContent).toContain("Do **not** queue a roadmap candidate");
  });
});

describe("schedule skill importance contract", () => {
  // 2026-06 audit: the importance-tier table moved into
  // `references/importance.md` (progressive disclosure). Resolve the
  // `{{> ref:importance }}` include so these assertions see the
  // post-materialisation body, mirroring the today/roadmap suites above.
  const skillContent = renderReferenceIncludes(
    readFileSync(SCHEDULE_SKILL_PATH, "utf-8"),
    join(REPO_ROOT, "agent-assets/skills/schedule"),
  );

  it("documents the four schedule importance tiers", () => {
    for (const tier of ["transient", "normal", "strategic", "low"]) {
      expect(skillContent).toContain(`\`${tier}\``);
    }
    expect(skillContent).toContain("Default for `/api/schedule/dm`");
    expect(skillContent).toContain("more than 7 days out");
    expect(skillContent).toContain("\"importance\":\"strategic\"");
  });
});

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §8 / §12.3 — content assertions for
 * the native task-flow variants authored in Phase B2. Pinning these
 * properties prevents a future variant rewrite from silently breaking
 * the §8.3 server-side hash contract or letting a daemon path that
 * 410s in native mode sneak back into the prose.
 */
describe("native task-flow variants — Phase B2 content invariants", () => {
  const TASK_FLOWS_ROOT = join(REPO_ROOT, "agent-assets/task-flows");

  // docs/design/appendices/routine-data-acquisition.md Phase 3 R4 + Phase 4 D3 — the
  // `routine.hourly_check.native.<be>.md` variants were deleted along
  // with their `delegated.<be>` siblings (Phase 3 R4); the dispatcher
  // pre-pass (`routine.fetch_window`) now owns the partial-include
  // surface and POSTs to `/api/observations` ahead of the main session
  // (Phase 4 D3). The §8.3 contracts those native variants used to
  // encode live on against the base hourly_check + the pre-pass
  // session instead:
  //
  //   - "no `/reconcile` POST" — guaranteed by the partial bodies in
  //     the pre-pass session (they POST to `/api/observations`, never
  //     to `/reconcile`) AND by the absence of any direct integration
  //     fetch in the main session body.
  //   - "/api/observations contract" — the main session reads via
  //     `/api/observations?pending=true`; the per-source POST contract
  //     is taught in the pre-pass partials, covered by
  //     `routine-partials-render.test.ts`.
  //   - "read-only-this-hour" — preserved in the base
  //     `routine.hourly_check.md` body.
  //
  // The substitute test below pins each contract against the rendered
  // hourly_check under a native gmail binding for every backend.
  it.each(["claude", "codex", "gemini"] as const)(
    "routine.hourly_check (native gmail / %s session) preserves the §8.3 contracts after R4",
    (backend) => {
      const integrations = {
        gmail: {
          mode: "native" as const,
          nativeBackend: backend,
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00.000Z",
        },
        notion: {
          mode: "native" as const,
          nativeBackend: backend,
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00.000Z",
        },
        google_calendar: {
          mode: "native" as const,
          nativeBackend: backend,
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00.000Z",
        },
      };
      const flow = getTaskFlow("routine.hourly_check", backend, integrations);

      // No `/reconcile` curl POST anywhere in the rendered body.
      expect(flow).not.toMatch(
        /curl\s+[^\n]*-X\s+POST\s+[^\n]*\/api\/integrations\/(gmail|notion|google_calendar)\/reconcile/,
      );
      // Main session reads observations (the pre-pass posts them).
      expect(flow).toContain("/api/observations");
      // `<fetch_report>` is the contract surface for pre-pass status.
      expect(flow).toContain("<fetch_report>");
      // The "read-only this hour" constraint is owned by the base file.
      expect(flow).toContain("External services are read-only this hour");
      // No partial-include directives in the main body — those live in
      // the pre-pass session (`routine.fetch_window.md`) only.
      expect(flow).not.toContain("{include:_partials/");
    },
  );

  // §8.2 — every DM native variant MUST open with the connector
  // routing preamble (refusal directive + 410 contract). The variant
  // file itself only carries the per-mode preamble; the `<user_input>`
  // block, Steps 1–4, and the rest of the dispatch flow are pulled in
  // from the base via the `{{> base }}` partial directive at load time
  // (resolved by `expandTaskFlowPartials` in prompts.ts). The other
  // suite below pins the end-to-end render of `getTaskFlow` — here we
  // assert on the raw file body so a future edit can't drop the
  // routing-preamble contract.
  it.each([
    "message.received.dm.native.claude.md",
    "message.received.dm.native.codex.md",
    "message.received.dm.native.gemini.md",
    "message.received.dm_first.native.claude.md",
    "message.received.dm_first.native.codex.md",
    "message.received.dm_first.native.gemini.md",
  ])(
    "%s carries the connector routing preamble and 410 refusal language",
    (filename) => {
      const body = readFileSync(join(TASK_FLOWS_ROOT, filename), "utf-8");
      expect(body).toContain("Connector routing (native)");
      expect(body).toContain("410");
      expect(body.toLowerCase()).toMatch(/do\s*\*?\*?\s*not\s*\*?\*?\s*call/);
      // The {context} substitution token must survive — every DM
      // variant is delivered through `resolveTemplate` and an
      // accidental edit could strip it.
      expect(body).toContain("{context}");
      // The native variants are thin shells that include the canonical
      // base flow via `{{> base }}`. Pin the directive's presence here;
      // an earlier suite (`getTaskFlow expands the {{> base }} partial
      // in the native DM variant`) verifies the expansion produces the
      // `<user_input>` block and Steps 1–4 at render time.
      expect(body).toContain("{{> base }}");
    },
  );

  // docs/design/appendices/routine-data-acquisition.md Phase 3 R4 — the deleted native
  // hourly_check variants used to carry a `Native Mode (<Backend> connectors)`
  // section header and an `<integration-routing-table-actionable>`
  // placeholder. After R4, `selectTaskFlowVariantSuffix` still returns
  // `native.<backend>` when gmail is native, but `loadFlowVariant` falls
  // through to the base `routine.hourly_check.md` (`prompts.ts:152-158`).
  // The base file does NOT carry the routing-table placeholder; mode-
  // specific prose flows through the partial includes instead. The
  // routing-table substitution mechanism stays exercised through the
  // `message.received.dm{,_first}.native.<be>.md` variants which DID
  // survive the refactor — see the §8.1 / §8.2 suites further down.

  // Pin the fallback behaviour so a future revert that re-creates the
  // variant files would be caught.
  it.each(["claude", "codex", "gemini"] as const)(
    "routine.hourly_check (native gmail / %s session) falls back to the base file after R4",
    (backend) => {
      const integrations = {
        gmail: {
          mode: "native" as const,
          nativeBackend: backend,
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00.000Z",
        },
      };
      const flow = getTaskFlow("routine.hourly_check", backend, integrations);
      // The deleted variant's header is gone; the base file's H2 stays.
      expect(flow).not.toContain("Native Mode (Claude connectors)");
      expect(flow).not.toContain("Native Mode (Codex connectors)");
      expect(flow).not.toContain("Native Mode (Gemini connectors)");
      expect(flow).toContain("## Hourly Observation Review");
      // No partial-include directives in the main body (Phase 4 D3 —
      // they're in the pre-pass session only).
      expect(flow).not.toContain("{include:_partials/");
      // The pre-pass status surface is referenced.
      expect(flow).toContain("<fetch_report>");
    },
  );

  // INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 — DM / dm_first variant
  // selection. Without the registry wiring (gmail / google_calendar /
  // notion declaring `message.received.dm` and `message.received.dm_first`
  // in `taskFlowsTouched`), `selectTaskFlowVariantSuffix` falls through
  // to "direct" and the new native DM variant files become dead code.
  // This test pins the wiring so a future descriptor edit that drops
  // the DM flows from `taskFlowsTouched` fails loudly.
  it.each(["claude", "codex", "gemini"] as const)(
    "getTaskFlow returns the native DM variant when gmail is native and the session backend matches (regression: §8.1 wiring)",
    (backend) => {
      const integrations = {
        gmail: {
          mode: "native" as const,
          nativeBackend: backend,
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00.000Z",
        },
      };
      const flow = getTaskFlow("message.received.dm", backend, integrations);
      const displayName =
        backend === "claude" ? "Claude" : backend === "codex" ? "Codex" : "Gemini";
      expect(flow).toContain(`DM Reply — Native Mode (${displayName} connectors)`);
      // The routing-table placeholder must be substituted (no raw
      // placeholder leaks to the LLM).
      expect(flow).not.toContain("<integration-routing-table>");
      // gmail row in the rendered table.
      expect(flow).toContain("| gmail | native |");
    },
  );

  it.each(["claude", "codex", "gemini"] as const)(
    "getTaskFlow returns the native dm_first variant when google_calendar is native and the session backend matches (regression: §8.1 wiring)",
    (backend) => {
      const integrations = {
        google_calendar: {
          mode: "native" as const,
          nativeBackend: backend,
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00.000Z",
        },
      };
      const flow = getTaskFlow("message.received.dm_first", backend, integrations);
      const displayName =
        backend === "claude" ? "Claude" : backend === "codex" ? "Codex" : "Gemini";
      expect(flow).toContain(
        `DM — First Message of the Day (Native Mode — ${displayName} connectors)`,
      );
      expect(flow).not.toContain("<integration-routing-table>");
    },
  );

  // Native variants are picked for any of the three native-supported
  // integrations (gmail, google_calendar, notion). Pin notion separately
  // since its descriptor wiring is independent of the gmail/calendar
  // path through `selectTaskFlowVariantSuffix`.
  it("getTaskFlow returns the native DM variant when only notion is native", () => {
    const integrations = {
      notion: {
        mode: "native" as const,
        nativeBackend: "claude" as const,
        deniedTools: [],
        lastChangedAt: "2026-05-01T00:00:00.000Z",
      },
    };
    const flow = getTaskFlow("message.received.dm", "claude", integrations);
    expect(flow).toContain("DM Reply — Native Mode (Claude connectors)");
    expect(flow).toContain("| notion | native |");
  });

  // INTEGRATION_NATIVE_MODE_DESIGN.md §8.2 — the native DM variants are
  // thin shells that include the canonical base flow via `{{> base }}`.
  // Pin that the expansion fires (steps from the base flow appear in
  // the rendered output) and that the directive itself doesn't leak.
  it.each(["claude", "codex", "gemini"] as const)(
    "getTaskFlow expands the {{> base }} partial in the native DM variant (%s) — base flow Steps 1–4 + User Message block appear",
    (backend) => {
      const integrations = {
        gmail: {
          mode: "native" as const,
          nativeBackend: backend,
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00.000Z",
        },
      };
      const flow = getTaskFlow("message.received.dm", backend, integrations);
      // Directive must not leak to the LLM.
      expect(flow).not.toContain("{{> base }}");
      // Base flow's Steps 1-4 are inlined.
      expect(flow).toContain("Step 1 — Capture user info silently");
      expect(flow).toContain("Step 2 — Profile-question reconcile");
      expect(flow).toContain("Step 3 — Compose the reply");
      expect(flow).toContain("Step 4 — Route durable intent");
      // The `## User Message` block lives in the base; without partial
      // expansion the dispatcher's event_data injection would have no
      // anchor.
      expect(flow).toContain("## User Message");
      // The leading `{context}` is deduped — exactly ONE occurrence
      // total (the variant's leading token; the base's leading token is
      // stripped at expansion time per §8.2).
      const contextOccurrences = (flow.match(/\{context\}/g) || []).length;
      expect(contextOccurrences).toBe(1);
    },
  );

  it.each(["claude", "codex", "gemini"] as const)(
    "getTaskFlow expands the {{> base }} partial in the native dm_first variant (%s) — first-DM Step 3 task preview survives",
    (backend) => {
      const integrations = {
        gmail: {
          mode: "native" as const,
          nativeBackend: backend,
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00.000Z",
        },
      };
      const flow = getTaskFlow("message.received.dm_first", backend, integrations);
      expect(flow).not.toContain("{{> base }}");
      // dm_first's defining delta is the optional task preview in Step 3;
      // assert that the base's preview prose is inlined.
      expect(flow.toLowerCase()).toMatch(/task preview|imminent/);
      expect(flow).toContain("## User Message");
      const contextOccurrences = (flow.match(/\{context\}/g) || []).length;
      expect(contextOccurrences).toBe(1);
    },
  );

  // The partial resolver must NOT fire for the direct (base) flow —
  // the base file does not contain `{{> base }}` and the rendered
  // output should equal the file as-read (modulo brand tokens). Guards
  // against an accidental recursion if a future edit adds the directive
  // to the canonical base.
  it("getTaskFlow leaves the direct base flow unchanged (no recursion into self)", () => {
    const integrations = {
      // No native or delegated integrations → variant resolver returns
      // "direct" and `loadFlow` returns the base file directly without
      // running the partial expansion.
    };
    const flow = getTaskFlow("message.received.dm", "claude", integrations);
    // Base flow does not contain the directive today.
    expect(flow).not.toContain("{{> base }}");
    expect(flow).toContain("## DM — Ongoing Conversation");
  });
});

describe("prompt ↔ skill subsection cross-reference", () => {
  // This test guards the contract between observer prompts and the today
  // skill: for every event type whose prompt says
  //   "Observer event formats → {event}"
  // the skill MUST contain a matching "## {event} → ..." subsection heading.
  // Without this, a rename in either location would silently break the reference.
  const skillContent = readFileSync(TODAY_SKILL_PATH, "utf-8");

  const observerEvents: ReadonlyArray<{
    event: string;
    subsectionHeadingPrefix: string;
  }> = [
    {
      event: "schedule.approaching",
      subsectionHeadingPrefix: "## schedule.approaching →",
    },
  ];

  it.each(observerEvents)(
    "$event: prompt references a subsection that exists in today SKILL.md",
    ({ event, subsectionHeadingPrefix }) => {
      const flow = getTaskFlow(event);
      expect(flow).toContain(`"Observer event formats → ${event}"`);
      expect(skillContent).toContain(subsectionHeadingPrefix);
    },
  );
});

/**
 * skills-improvement.md Test coverage — R4 row.
 *
 * Phase 0.5 / §5 — the `confirm_dedup_key` shape + cross-path
 * cancellation rules currently live inline in `schedule/SKILL.md`.
 * The plan moves them into `_partials/confirm-subflow.md` consumed by
 * `message.received.dm.md` and `scheduled.dm.md`.
 *
 * This test fails today because the partial does not yet exist on
 * disk and the prose has not been deleted from `schedule/SKILL.md`.
 * Turns green once both edits land in the same PR.
 */
describe("confirm-subflow partial round-trip (R4)", () => {
  const PARTIAL_REL = "agent-assets/task-flows/_partials/confirm-subflow.md";
  const SCHEDULE_SKILL_REL = "agent-assets/skills/schedule/SKILL.md";
  const CONSUMERS = ["message.received.dm", "scheduled.dm"];

  it("the `_partials/confirm-subflow.md` file exists on disk", () => {
    const path = join(REPO_ROOT, PARTIAL_REL);
    expect(readFileSync(path, "utf-8").length).toBeGreaterThan(0);
  });

  it.each(CONSUMERS)(
    "%s includes the confirm-subflow partial and the include directive is resolved",
    (key) => {
      const flow = getTaskFlow(key);
      expect(flow).not.toContain("{include:_partials/confirm-subflow.md}");
      expect(flow).toContain("confirm_dedup_key");
    },
  );

  it("schedule/SKILL.md no longer carries the confirm_dedup_key prose (single source: the partial)", () => {
    const body = readFileSync(join(REPO_ROOT, SCHEDULE_SKILL_REL), "utf-8");
    // The skill may keep a short pointer paragraph that NAMES the
    // partial's contents (cross-path cancellation, shape contract).
    // What it must NOT carry is the section-level prose: a `##`/`###`
    // heading dedicated to either concept.
    expect(body).not.toMatch(/^#{2,4}\s+`?confirm_dedup_key`?\s+shape/im);
    expect(body).not.toMatch(/^#{2,4}\s+Cross-path cancellation/im);
  });
});

/**
 * skills-improvement.md Test coverage — X4 row.
 *
 * Phase 0.7 — `context-builder.ts:320` injects the canonical
 * `<output_language_policy>` block at runtime. Per-skill duplicates of
 * the Policy A/B/C explanation are dead prose. Each skill MAY keep a
 * single one-line pointer of the shape:
 *
 *   `Output language: <file> is Policy <X> — see <output_language_policy>. ...`
 *
 * The rule: each skill body has AT MOST ONE line that names
 * `Policy [ABC]`, and that line must also name `Output language:`. Any
 * additional Policy mention is the regression target.
 */
describe("output-language-policy duplication absence (X4)", () => {
  const SKILLS_DIR_LOCAL = join(REPO_ROOT, "agent-assets/skills");
  const SUSPECT_SLUGS = [
    "context",
    "today",
    "roadmap",
    "user-profile",
    "external-services",
    "notion",
    "notify",
    "project-doc",
    "observations",
  ];

  it.each(SUSPECT_SLUGS)(
    "%s/SKILL.md mentions Policy A/B/C at most once, and only as the `Output language:` pointer",
    (slug) => {
      const path = join(SKILLS_DIR_LOCAL, slug, "SKILL.md");
      if (!existsSync(path)) return;
      const lines = readFileSync(path, "utf-8").split("\n");
      const policyLines = lines.filter((l) => /\bPolicy\s+[ABC]\b/.test(l));
      // (1) at most one line carries a Policy [ABC] mention
      expect(
        policyLines.length,
        `${slug}: ${policyLines.length} lines mention Policy [ABC] — at most one (the pointer) is allowed`,
      ).toBeLessThanOrEqual(1);
      // (2) if present, the single line must be the canonical pointer
      if (policyLines.length === 1) {
        expect(
          policyLines[0],
          `${slug}: the Policy mention must be the "Output language:" pointer line`,
        ).toMatch(/Output language:/i);
        expect(
          policyLines[0],
          `${slug}: the pointer line must reference <output_language_policy>`,
        ).toMatch(/<output_language_policy>/);
      }
    },
  );
});

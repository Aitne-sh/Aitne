import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";
import type { ProcessKey } from "@aitne/shared";

import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";

/**
 * Event-type → agent profile mapping, expressed as prefix rules so every
 * member of a family shares the same profile without needing to list each
 * variant. Order matters: the first rule whose `prefix` matches wins.
 *
 * This is the single source of truth for "all routines use the routine
 * profile" (named AND custom), "all message.* and setup.* events use the
 * conversational profile", and so on. Adding a new variant inside an
 * existing family (e.g. `routine.quarterly_review`) requires no change here.
 *
 * Exact-match eventTypes (no trailing dot / slash) are handled via the
 * `exact: true` flag so `schedule.approaching` doesn't accidentally match
 * some future `schedule.anything_else` that needs a different profile.
 */
const PROFILE_RULES: ReadonlyArray<{ prefix: string; profile: string; exact?: boolean }> = [
  // docs/design/appendices/routine-data-acquisition.md §6.2 / §6.3 — the pre-pass
  // fetcher runs under its own dedicated persona ("fetch, don't think").
  // MUST precede the generic `routine.` rule below; without this entry
  // the prefix match would route the fetcher to the broad recurring-
  // routine profile and the SkillsCompiler would never materialise
  // `agent-assets/agent-profiles/routine-fetch-window.md`. Exact-match
  // so a future `routine.fetch_*` sibling can't silently inherit.
  { prefix: "routine.fetch_window", profile: "routine-fetch-window", exact: true },
  { prefix: "routine.",          profile: "routine" },
  // DOCS_QA_DESIGN.md §10.3 — exact-match so a future `dashboard.foo` cannot
  // silently inherit the docs-qa profile.
  { prefix: "dashboard.docs_qa", profile: "docs-qa",           exact: true },
  { prefix: "wiki.",             profile: "wiki-agent" },
  { prefix: "message.",          profile: "conversational" },
  { prefix: "setup.",            profile: "conversational" },
  { prefix: "schedule.approaching", profile: "observer",       exact: true },
  // SCHEDULED-DM-IMPLEMENTATION-PLAN §3.3 — DM-tone scheduled sessions
  // run under the conversational profile so the persona/character
  // visible in regular DMs is identical when the daemon initiates.
  // Exact-match so a future `scheduled.foo` cannot silently inherit.
  { prefix: "scheduled.dm",      profile: "conversational",    exact: true },
  { prefix: "scheduled.task",    profile: "task",              exact: true },
  { prefix: "github.",           profile: "observer" },
  { prefix: "git.",              profile: "observer" },
  // Knowledge import sessions run under a strict-fidelity persona
  // dedicated to copying user-supplied facts into user/*.md without
  // paraphrase. See agent-assets/agent-profiles/profile-importer.md.
  { prefix: "knowledge.import",  profile: "profile-importer",  exact: true },
];

const DEFAULT_PROFILE = "task";

export const EVENT_SKILL_SETS: Record<string, string[]> = {
  // ── Routines that touch today.md ──
  // `roadmap` is loaded for morning/evening because both may write to
  // roadmap.md (morning consumes ## Agent Action Plan rows and may
  // reconcile Scheduled: entries; evening prunes Long-term Plans / flips
  // Status). Hourly is intentionally omitted — hourly writes via
  // recordObservation(kind='roadmap_candidate'), never through the
  // roadmap skill. See ROADMAP-REDESIGN.md §3.7.
  // Morning routine input cap: the task-flow drives mail + calendar + roadmap
  // walk + today.md write + schedule register. Skills outside that surface
  // (`external-services`, `notion`, `travel`) inline 20+ KB of
  // API reference for endpoints the routine never calls — every dropped slug
  // here is one whose endpoints don't appear in routine.morning_routine.md.
  // Notion drain happens via /api/observations (taught by `observations`);
  // the `notion` skill itself only documents /api/notion/* CRUD which the
  // routine doesn't touch.
  "routine.morning_routine": [
    "context",
    "today",
    "observations",
    "schedule",
    "mail",
    "roadmap",
    // Conditionally loaded via `gmailLifestyleActive(db)` — morning
    // routine surfaces upcoming travel / commute / unsaved receipts in
    // today.md when relevant. Routine variant uses the base predicate
    // (no message-text trigger). See docs/design/appendices/skills-improvement.md §9-§11.
    "gmail-lifestyle",
    // Step 7.5 — pick at most one profile-interview question per agent-day
    // and write it as a (latent) entry in today.md ## Agent Notes. The
    // morning routine never schedules a cold DM for it; latent rows wait
    // for a natural opportunity. See profile-interview-queue.md §3.1.
    "user-interview",
  ],
  // `routine.morning_routine_initial` is retired. The first-run branch
  // flows through `routine.morning_routine_today` (Stage A) below. See
  // morning-routine-optimization.md for the split rationale.
  // Stage A (today.md synthesis) inherits the legacy bundle PLUS
  // `agent-actions` for the structured self-report Step 9 makes through
  // `PATCH /api/agent-actions/self`. The skill is small (~120 lines of
  // SKILL.md) — well within the medium-tier cold-start budget — and
  // load-bearing for the daemon's ⑥ AgentJournalAppender step which
  // reads the metadata column the agent writes here.
  "routine.morning_routine_today": [
    "context",
    "today",
    "observations",
    "schedule",
    "mail",
    "roadmap",
    "gmail-lifestyle",
    "user-interview",
    "agent-actions",
  ],
  // docs/design/appendices/daily-journal-daemon-write.md §4.10 — Stage B
  // no longer needs the `context` skill (or any other skill). The
  // daemon-side composer (`core/morning/daily-journal-composer.ts`)
  // performs the daily-journal write deterministically from the LLM's
  // tagged final-text output; Stage B has zero tool requirement so the
  // `dontAsk` denial layer that previously trapped Haiku's
  // `cat > /tmp/...` attempts becomes structurally moot.
  "routine.morning_routine_journal": [],
  // `evening-review-slimdown.md` §2.1 — Phase 2 dropped `travel`
  // unconditionally (was only kept for Step 4's "newly detected bookings"
  // path, deleted alongside Step 4). `notify` is loaded *conditionally* via
  // `resolveSkillManifest` — the built-in steps emit no user-facing output,
  // so the universal message-discipline contract is only needed when the
  // user has authored at least one `### ` rule in
  // `policies/routines/evening.md` that may call `POST /api/notify`. Callers MUST go
  // through `resolveSkillManifest(event, { contextDir })` to apply the gate;
  // direct `EVENT_SKILL_SETS[event]` reads see the static (`notify`-on)
  // shape and are intentionally conservative for tooling that doesn't have
  // a contextDir handy (manifest-integrity tests, ALL_SKILLS audits).
  "routine.evening_review": [
    "context",
    "today",
    "user-profile",
    "notify",
    "roadmap",
    "management-policy",
  ],
  "routine.hourly_check": [
    "context",
    "today",
    "observations",
    "notify",
    "schedule",
    "external-services",
    "mail",
    "notion",
  ],
  // ── Routines that read (but do not write) today.md ──
  "routine.weekly_review": [
    "context",
    "today",
    "notify",
    "schedule",
    "reading",
  ],
  "routine.monthly_review": [
    "context",
    "today",
    "notify",
    "schedule",
    "reading",
  ],
  "routine.roadmap_refresh": ["context", "external-services", "notion", "roadmap"],
  // BROWSER_HISTORY_INTEGRATION_PLAN P3. Each browser-history routine
  // loads the agent-facing browser-history skill (curl chokepoint to
  // /api/browser-history/*) plus `context` for the research-journal /
  // assistance / wiki write paths. `notify` is layered on for any
  // routine that DMs the user — the routine_protocol block tells the
  // agent that /api/notify is the only user-visible channel for
  // routines, but only `notify`'s SKILL.md carries the actual curl
  // shape (host, port, body schema, priority field, awareness-gate
  // rules). Without it the agent has to guess the API surface, which
  // breaks the "DM the owner with..." instructions in the task-flows.
  //
  // cluster_update stays silent — it appends to a journal file and
  // does not DM. The offer DM routine has the curl shape inline in
  // its task-flow so the narrow skill set is acceptable there; the
  // two accept-path routines (research_dispatch, research_wiki_summary)
  // need `notify` because their task-flows just say "DM the owner".
  "routine.research_cluster_update": ["browser-history", "context"],
  // BROWSER_HISTORY_INTEGRATION_PLAN §10.1 (seventh-pass) — offer DM
  // composition is its own lite-tier session. The task-flow inlines
  // the curl shape; no browser-history-respond — that skill lives on
  // the message.dm side where the user's reply lands.
  "routine.research_offer_dm": ["browser-history", "context"],
  "routine.research_dispatch": ["browser-history", "context", "notify"],
  "routine.research_wiki_summary": ["browser-history", "context", "notify"],
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.8 — managed-Chromium
  // health-check routine. Loads the narrow `browser-history-managed`
  // skill (status GET only, no profile-dir access) plus `context` for
  // the agent-journal append step. No `notify` — the supervisor in
  // `managed-chromium-supervisor.ts` already DMs the user when the
  // state machine transitions out of `ready`; a second DM from this
  // routine would be noise.
  "routine.managed_sync_health_check": ["browser-history-managed", "context"],
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.13 — Phase B-2 Instance A
  // workflow request. Scheduler / routine driven (DM-driven workflow
  // invocations stay under `message.received.dm`). Loads:
  //   - `browser-history-managed` — owner of the curl chokepoint for
  //     `/api/browser-automation/workflows/*` (workflow list +
  //     invoke + recent-runs).
  //   - `context` — vault-path writes are how the session leaves a
  //     trace of "I ran a screenshot of news.ycombinator.com today"
  //     in today.md's agent-log.
  //   - `notify` — the user-facing DM for workflows scheduled to
  //     report back ("screenshot taken, here it is"). Without `notify`
  //     the routine has no canonical channel to surface its result.
  "routine.browser_automation_request": [
    "browser-history-managed",
    "context",
    "notify",
  ],
  // Dashboard-triggered manual refresh of today.md's User Schedule
  // section. Intentionally narrow — the flow only reads the calendar
  // and PATCHes user_schedule / agent_log. No mail, no roadmap, no
  // observations, no notify (silent-by-default).
  "routine.today_refresh": ["context", "today", "external-services"],
  // Minimal manifest is load-bearing. The sweep exists because the
  // DM-time capture nudge competes with 13 skills for the model's
  // attention; running the safety-net sweep with the same bloated
  // manifest would replicate the failure mode. See USER-PROFILE-CAPTURE-PLAN.md
  // §Phase 2 rationale bullets 1 + 3. `user-interview` is loaded so the
  // evening sweep can do stale recovery, latent fallback promotion, and
  // the Layer 4 LLM reconcile (§3.4 + §3.5.4 + the latent fallback path
  // from the implementation plan).
  "routine.user_profile_sweep": [
    "context",
    "user-profile",
    "user-interview",
  ],
  // ── Conversational events ──
  // Note: the SDK's server-side advisor tool (when enabled via
  // backend_global_defaults.advisor_model) is registered by Anthropic with its
  // own built-in description and call policy. We deliberately do NOT ship a
  // dedicated advisor skill — doing so would duplicate or contradict the
  // built-in guidance the model already has for `advisor_20260301`.
  "message.received": [
    "context",
    "today",
    "user-profile",
    "notify",
    "attach",
    "schedule",
    "external-services",
    "mail",
    "notion",
    // docs/design/appendices/skills-improvement.md §9-§11 — merged from travel
    // + receipts. Conditionally loaded via `gmailLifestyleActiveForDm` so DMs
    // that don't mention travel / receipts and have no fresh bookings or
    // unsaved receipts don't pay the ~180-line cost.
    "gmail-lifestyle",
    "roadmap",
    "management-policy",
    // docs/design/appendices/skills-improvement.md §14 — merged from
    // management-task-{register,modify,stop}. Conditionally loaded via
    // `managedTasksActiveForDm`. Loaded by default (no db handle =
    // conservative include) so DM trigger surfaces remain discoverable
    // from any entry point; the predicate only drops the skill when the
    // DB has zero rows AND the message text carries no `mt_<n>` /
    // "managed task" / "recurring fetch" anchor.
    "managed-tasks",
  ],
  "message.received.dm_first": [
    "context",
    "today",
    "user-profile",
    "notify",
    "attach",
    "schedule",
    "external-services",
    "mail",
    "notion",
    "gmail-lifestyle",
    "roadmap",
    "management-policy",
    "managed-tasks",
    // DM handler decides whether the inbound topic is a natural moment
    // to weave a latent profile question into the reply, and ticks the
    // queue when the user answers a previously-asked one. See
    // profile-interview-queue.md §3.3 + the latent-opportunity block.
    "user-interview",
  ],
  "message.received.dm": [
    "context",
    "today",
    "user-profile",
    "notify",
    "attach",
    "schedule",
    "external-services",
    "mail",
    "notion",
    "gmail-lifestyle",
    "roadmap",
    "management-policy",
    "managed-tasks",
    "user-interview",
    // BROWSER_HISTORY_INTEGRATION_PLAN §10.1 (seventh-pass) — narrow
    // accept-surface for natural-language reply to a research offer
    // DM. The skill body documents the intent-mapping rules
    // (research/dig → research_assist; summarise → wiki_summary;
    // no thanks → decline). Conditional load is intentionally absent;
    // the skill itself no-ops when `GET /offers/pending` is empty,
    // and the cost of having the skill text in DM context is small.
    "browser-history-respond",
  ],
  // ── Task events ──
  "schedule.approaching": [
    "context",
    "today",
    "notify",
  ],
  "scheduled.task": [
    "context",
    "today",
    "notify",
    "schedule",
    "external-services",
    "mail",
    "notion",
    "roadmap",
    // docs/design/21-management-registry-and-entities.md §10.4 — when
    // task_context.mt_id matches `mt_<n>`, this skill takes over the run.
    // For non-managed scheduled tasks the skill is inert (its when_to_use
    // disambiguator points back at scheduled.task.md).
    "scheduled-managed-task",
  ],
  // SCHEDULED-DM-IMPLEMENTATION-PLAN §5.4 — DM-tone scheduled sessions.
  //   `context` + `today` for reading the day's data
  //   `notify` for any escalation if briefing fails
  //   `schedule` for self-management (the agent can DELETE its own
  //     pending rows in response to a user opt-out DM)
  //   `mail` / `notion` for live overnight delta queries
  //   `observations` for pending user-actor changes
  //   `external-services` for SoT lookups
  //   `roadmap` for context on which tasks matter today
  "scheduled.dm": [
    "context",
    "today",
    "notify",
    "schedule",
    "external-services",
    "mail",
    "notion",
    "observations",
    "roadmap",
    // Conditionally loaded via `gmailLifestyleActiveForDm` — the
    // briefing surfaces upcoming travel / commute when relevant.
    "gmail-lifestyle",
    // Morning-briefing piggyback (a latent profile question may be woven
    // into the briefing when topic-appropriate) and the
    // `profile_interview:` fallback sub-flow both call into this skill.
    // See profile-interview-queue.md §3.2 + §3.5.3.
    "user-interview",
  ],
  // SETUP-FLOW-REDESIGN-PLAN §5.8 removed the legacy "tool selections"
  // form; the agent now derives the Source-of-Truth table from the
  // `<integration_modes>` / `<obsidian_vault_path>` context tags rather
  // than hitting `/api/*` endpoints. setup.initial writes only to
  // /api/context/user/* (covered by the user-profile skill), so the
  // external-services skill — which mirrors /api/calendar, /api/obsidian,
  // /api/github, /api/skills — is dead weight here. Removing it cuts the
  // injected skill surface roughly in half for setup.initial on Codex,
  // where the long single-shot response was the visible symptom.
  "setup.initial": ["user-profile"],
  "setup.update": ["user-profile"],
  // Knowledge import: minimal manifest to keep the agent focused on
  // one job — read the uploaded blob and route literal facts into
  // user/*.md. `notify` is loaded so the Step 2 secret-shape abort can
  // surface a DM to the owner (otherwise the refusal is silent). The
  // session does NOT use `attach`: it flows through executeDefault, has
  // no chat turn token, and the dashboard activity feed plus the
  // standard agent_actions audit row already close the loop.
  "knowledge.import": ["context", "user-profile", "notify"],
  "github.pull_request.review_requested": [
    "context",
    "today",
    "notify",
    "observations",
    "external-services",
  ],
  "github.assigned": [
    "context",
    "today",
    "notify",
    "observations",
    "external-services",
  ],
  "github.security_alert": [
    "context",
    "today",
    "notify",
    "observations",
    "external-services",
  ],
  "github.workflow_run.failed": [
    "context",
    "today",
    "notify",
    "observations",
    "external-services",
  ],
  "git.push.detected": [
    "context",
    "today",
    "observations",
  ],
  "git.local_ahead.stale": [
    "context",
    "today",
    "observations",
  ],
  "git.push.force_pushed": [
    "context",
    "today",
    "notify",
    "observations",
  ],
  "git.branch.created": [
    "context",
    "today",
    "observations",
  ],
  "git.tag.created": [
    "context",
    "today",
    "observations",
  ],
  "git.merge_to_default": [
    "context",
    "today",
    "observations",
  ],
  "git.project.init": [
    "context",
    "observations",
    "project-doc",
  ],
  "git.project.update": [
    "context",
    "observations",
    "project-doc",
  ],
  // Dashboard-triggered one-shot template re-conform. The task-flow
  // operates only against the per-target context files via /api/context
  // and the project-doc skill rules; it never reads observations, today,
  // mail, etc. Without this entry the resolver falls back to ALL_SKILLS
  // (18 skills) and dilutes the agent's focus on a quality-sensitive
  // re-template task. See agent-assets/task-flows/git.project.retemplate.md.
  "git.project.retemplate": [
    "context",
    "project-doc",
  ],
  "git.lifecycle.poll": [
    "context",
    "today",
    "notify",
    "observations",
    "project-doc",
  ],
  // DOCS_QA_DESIGN.md §10.3 — single-skill manifest. The QA session has
  // exactly one read-only skill; every other skill is excluded so the
  // model cannot mutate context, send DMs, or hit external APIs.
  "dashboard.docs_qa": ["docs-search"],
  // docs/design/appendices/routine-data-acquisition.md §6.3 / P3 — the pre-pass fetcher
  // does mechanical fetch + POST observations and nothing else. The
  // skill set carries (a) `observations` for the POST contract,
  // (b) `mail` / `notion` / `external-services` for the three
  // integration families the catalog covers, and (c) `attach` so the
  // fetcher can stream raw mail attachments into the observation
  // payload when a partial calls for it. Notably absent: today /
  // schedule / roadmap / user-* / notify / management-* — the fetcher
  // never writes to context MD files, never DMs the owner, and never
  // spawns sub-tasks. Adding any of those would violate the
  // "no interpretation" boundary the profile enforces.
  "routine.fetch_window": [
    "observations",
    "mail",
    "notion",
    "external-services",
    "attach",
  ],
  "wiki.ingest_url": [
    "wiki-vault-rules",
    "wiki-ingest",
  ],
  "wiki.compile": [
    "wiki-vault-rules",
    "wiki-compile",
    // WIKI_BUILDER_DESIGN.md Phase 3 — graduate is a sub-action of compile:
    // when 00_inbox content is ready for promotion, the compile session
    // applies the graduate rules. No dedicated wiki.graduate process key.
    "wiki-graduate",
  ],
  "wiki.ask": [
    "wiki-vault-rules",
    "wiki-ask",
  ],
  // WIKI_BUILDER_DESIGN.md Phase 3 — operational triad. Each loads the
  // shared `wiki-vault-rules` skill plus its own action skill.
  "wiki.lint": [
    "wiki-vault-rules",
    "wiki-lint",
  ],
  "wiki.trace": [
    "wiki-vault-rules",
    "wiki-trace",
  ],
  "wiki.connect": [
    "wiki-vault-rules",
    "wiki-connect",
  ],
};

export const ALL_SKILLS = [
  "context",
  "today",
  "user-profile",
  "user-interview",
  "notify",
  "schedule",
  "observations",
  "attach",
  "external-services",
  "mail",
  "notion",
  // docs/design/appendices/skills-improvement.md §9-§11 — merged from travel
  // + receipts. Conditionally loaded for DMs / routines via
  // `gmailLifestyleActive*` predicates.
  "gmail-lifestyle",
  "roadmap",
  "management-policy",
  // docs/design/appendices/skills-improvement.md §14 — merged from
  // management-task-{register,modify,stop}. Conditionally loaded for
  // DMs via `managedTasksActiveForDm`.
  "managed-tasks",
  "scheduled-managed-task",
  "project-doc",
  "wiki-vault-rules",
  "wiki-ingest",
  "wiki-compile",
  "wiki-ask",
  // WIKI_BUILDER_DESIGN.md Phase 3 — operational + graduate.
  "wiki-lint",
  "wiki-trace",
  "wiki-connect",
  "wiki-graduate",
  // BROWSER_HISTORY_INTEGRATION_PLAN P3 — agent-facing skill for the
  // /api/browser-history/* surface. Bundled with `context` for the
  // research-journal write path.
  "browser-history",
  // BROWSER_HISTORY_INTEGRATION_PLAN §10.1 (seventh-pass) — narrow
  // accept-surface skill loaded for `message.received.dm` (which both
  // `message.dm` and `dashboard.chat` inherit). Exposes only the
  // pending-offers list + accept/decline endpoints so the standard
  // DM agent can translate a user's natural-language reply into the
  // structured dispatch call. The full `browser-history` skill is
  // intentionally NOT loaded for message.dm — DM agent isolation.
  "browser-history-respond",
];

const PROCESS_TO_EVENT_TYPE: Partial<Record<ProcessKey, string>> = {
  "routine.morning_routine": "routine.morning_routine",
  // morning-routine-optimization.md Phase 5/6 — Stage A + Stage B keys
  // map to their own event-type strings so `resolveSkillManifestForProcess`
  // returns the split bundle defined above.
  "routine.morning_routine_today": "routine.morning_routine_today",
  "routine.morning_routine_journal": "routine.morning_routine_journal",
  "routine.evening_review": "routine.evening_review",
  "routine.weekly_review": "routine.weekly_review",
  "routine.monthly_review": "routine.monthly_review",
  "routine.hourly_check": "routine.hourly_check",
  "routine.roadmap_refresh": "routine.roadmap_refresh",
  "routine.today_refresh": "routine.today_refresh",
  "routine.user_profile_sweep": "routine.user_profile_sweep",
  "routine.research_cluster_update": "routine.research_cluster_update",
  "routine.research_offer_dm": "routine.research_offer_dm",
  "routine.research_dispatch": "routine.research_dispatch",
  "routine.research_wiki_summary": "routine.research_wiki_summary",
  "routine.managed_sync_health_check": "routine.managed_sync_health_check",
  "routine.browser_automation_request": "routine.browser_automation_request",
  "message.dm": "message.received.dm",
  "message.mention": "message.received",
  "dashboard.chat": "message.received.dm",
  "dashboard.docs_qa": "dashboard.docs_qa",
  "agent.task": "scheduled.task",
  "agent.dm_task": "scheduled.dm",
  "schedule.approaching": "schedule.approaching",
  "calendar.change": "schedule.approaching",
  setup: "setup.initial",
  "knowledge.import": "knowledge.import",
  "git.project.init": "git.project.init",
  "git.project.update": "git.project.update",
  "git.project.retemplate": "git.project.retemplate",
  "git.lifecycle.poll": "git.lifecycle.poll",
  "wiki.ingest_url": "wiki.ingest_url",
  "wiki.compile": "wiki.compile",
  "wiki.ask": "wiki.ask",
  "wiki.lint": "wiki.lint",
  "wiki.trace": "wiki.trace",
  "wiki.connect": "wiki.connect",
};

/**
 * `evening-review-slimdown.md` §2.1 — predicate that drives conditional
 * loading of the `notify` skill for `routine.evening_review`.
 *
 * The slim built-in evening steps (Handoff, Long-term Plans promotion,
 * Review-date fire, Raw Signals graduation) emit no user-facing output.
 * `notify` is only load-bearing when the operator has written at least
 * one `### <label>` rule into `policies/routines/evening.md` that may post to
 * `/api/notify` — the universal message-discipline contract in the
 * notify skill is the binding format guide for those rules.
 *
 * Rules-of-thumb encoded here, mirroring §2.1's three cases:
 *   - file absent / unreadable → `false` (drop notify)
 *   - file empty / whitespace-only → `false` (drop notify)
 *   - file present but no `^### ` line → `false` (no rule headings)
 *   - file present with at least one `^### ` heading → `true` (keep notify)
 *
 * `contextDir` undefined / empty → `false`. Tooling that cannot resolve a
 * context root (manifest-integrity tests, repo-only audits) gets the
 * conservative "no rulebook" answer.
 */
export function eveningRulebookIsActive(
  contextDir: string | undefined | null,
): boolean {
  if (!contextDir) return false;
  const rulebookPath = join(contextDir, CONTEXT_RELATIVE_PATHS.routines.evening);
  if (!existsSync(rulebookPath)) return false;
  let body: string;
  try {
    body = readFileSync(rulebookPath, "utf-8");
  } catch {
    // Unreadable (permissions, deleted between existsSync and read) →
    // treat as absent. The next session re-evaluates from scratch.
    return false;
  }
  if (body.trim().length === 0) return false;
  return /^###\s+/m.test(body);
}

/**
 * docs/design/appendices/skills-improvement.md §9-§11 + Open Q #3 — predicate that drives
 * conditional loading of the merged `gmail-lifestyle` skill.
 *
 * Base predicate: true when at least one of
 *   - `travel_bookings` has a row with `start_date >= now() - 30 days`
 *     (a fresh-or-near-past booking the agent might still want to
 *     surface in summaries)
 *   - `receipts` has a row with `saved_at IS NULL` (an attachment the
 *     user has not yet filed into the external Obsidian vault)
 *
 * Both queries are cheap (one indexed `LIMIT 1` each) and run on every
 * manifest resolution; do not add a JSON-parsing or fan-out cousin
 * without a benchmark.
 *
 * `db === undefined` → returns `true` (conservative include). Tooling
 * that cannot pass the DB handle (manifest-integrity tests, ALL_SKILLS
 * audits) sees the merged skill in every event set, which matches the
 * static safety net.
 */
export function gmailLifestyleActive(
  db: Database.Database | null | undefined,
): boolean {
  if (!db) return true; // conservative include when no DB handle
  try {
    const fresh = db.prepare(
      `SELECT 1 FROM travel_bookings
       WHERE start_date >= datetime('now', '-30 days')
       LIMIT 1`,
    ).get();
    if (fresh) return true;
    const unsaved = db.prepare(
      `SELECT 1 FROM receipts WHERE saved_at IS NULL LIMIT 1`,
    ).get();
    return Boolean(unsaved);
  } catch {
    // Schema gap (tables not migrated yet, or db handle in unexpected
    // state) → conservative include. The skill body's own "When NOT to
    // act" copy is the second line of defence.
    return true;
  }
}

/**
 * Trigger phrases for the DM variant of `gmailLifestyleActive`. Matches
 * the inbound message text against keywords that imply the user wants
 * travel / commute / receipt help even when the DB predicate would say
 * no (first-ever booking question; receipt query before the first
 * Gmail-observer scan; etc.).
 *
 * Word-boundary regex (not `String.prototype.includes`): a naive
 * substring match would over-trigger on "stripe" / "stripped" (matches
 * `trip`), "training" / "constraint" (matches `train`), "tripled"
 * (matches `trip`), etc. — each false positive loads the ~180-line
 * skill body for an unrelated DM. The trigger pool is English-only;
 * the user's primary-language phrasings rely on the description-based
 * SDK match for routing, not on this predicate.
 *
 * Singular/plural is handled via the `s?` suffix; multi-word phrases
 * use a literal substring (still safe because the phrase itself is
 * unambiguous).
 */
const GMAIL_LIFESTYLE_TRIGGER_RE = new RegExp(
  String.raw`\b(receipts?|expenses?|invoices?|flights?|hotels?|trains?|commute|trips?|bookings?|reservations?)\b`,
  "i",
);
const GMAIL_LIFESTYLE_PHRASE_TRIGGERS: ReadonlyArray<string> = [
  "departure time",
];
function dmMentionsGmailLifestyle(
  messageText: string | null | undefined,
): boolean {
  if (!messageText) return false;
  if (GMAIL_LIFESTYLE_TRIGGER_RE.test(messageText)) return true;
  const lower = messageText.toLowerCase();
  for (const phrase of GMAIL_LIFESTYLE_PHRASE_TRIGGERS) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

/**
 * DM-aware variant. `gmail-lifestyle` is included when EITHER the base
 * predicate fires OR the inbound DM text mentions a trigger phrase.
 *
 * Non-DM events (morning routine, evening review) use the base
 * `gmailLifestyleActive` directly — they have no message text to read.
 */
export function gmailLifestyleActiveForDm(
  db: Database.Database | null | undefined,
  messageText: string | null | undefined,
): boolean {
  if (gmailLifestyleActive(db)) return true;
  return dmMentionsGmailLifestyle(messageText);
}

/**
 * docs/design/appendices/skills-improvement.md §14 — predicate for the merged
 * `managed-tasks` skill.
 *
 * Base predicate: true when at least one `managed_tasks` row exists.
 * The check is intentionally cheap (one indexed `LIMIT 1`).
 *
 * `db === undefined` → conservative include.
 */
export function managedTasksActive(
  db: Database.Database | null | undefined,
): boolean {
  if (!db) return true; // conservative include when no DB handle
  try {
    const row = db.prepare(`SELECT 1 FROM managed_tasks LIMIT 1`).get();
    return Boolean(row);
  } catch {
    return true;
  }
}

/**
 * DM trigger phrases for managed-tasks. The `mt_<n>` anchor is a
 * high-precision id reference; the long-form phrases are the
 * register-intent surface (the user wants to discuss the concept even
 * when zero rows exist yet).
 *
 * The app-name match uses word boundaries — a naive `t.includes("notion")`
 * matches "notional" / "notionally", "zoom" matches "zoomed in", "drive"
 * matches "driveway", "linear" matches "linearly", etc. Each would load
 * the merged ~250-line skill body for an unrelated DM. The recurring-
 * cadence anchor stays tight (`daily` / `weekly` / `monthly` / explicit
 * weekday) so a casual "every day I drink coffee" still misses.
 */
const MANAGED_TASKS_ID_RE = /\bmt_\d+\b/i;
const MANAGED_TASKS_RECURRING_VERB_RE = /\brecurring\s+(fetch|check|sync|pull|sweep)\b/i;
const MANAGED_TASKS_CADENCE_RE = /\b(every\s+(day|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|daily|weekly|monthly)\b/i;
const MANAGED_TASKS_APP_RE = /\b(zoom|gmail|drive|notion|outlook|linear|jira|slack|asana|github|trello|airtable)\b/i;
function dmMentionsManagedTasks(
  messageText: string | null | undefined,
): boolean {
  if (!messageText) return false;
  if (MANAGED_TASKS_ID_RE.test(messageText)) return true;
  if (/\bmanaged\s+tasks?\b/i.test(messageText)) return true;
  if (MANAGED_TASKS_RECURRING_VERB_RE.test(messageText)) return true;
  // "every day check Zoom" / "every Monday pull Drive" — recurring +
  // common-connector noun. Kept tight to avoid loading the skill on
  // bland scheduling phrasings that belong in `schedule` instead.
  if (
    MANAGED_TASKS_CADENCE_RE.test(messageText) &&
    MANAGED_TASKS_APP_RE.test(messageText)
  ) {
    return true;
  }
  return false;
}

/**
 * DM-aware variant. `managed-tasks` is included when EITHER the base
 * predicate fires OR the inbound DM text matches a managed-task
 * anchor / phrase.
 */
export function managedTasksActiveForDm(
  db: Database.Database | null | undefined,
  messageText: string | null | undefined,
): boolean {
  if (managedTasksActive(db)) return true;
  return dmMentionsManagedTasks(messageText);
}

/**
 * `evening-review-slimdown.md` §2.1 — context-aware manifest resolver.
 *
 * Wraps the static `EVENT_SKILL_SETS` lookup with per-event predicates that
 * inspect runtime state (today: only the evening rulebook). Other events
 * pass through unchanged — they reuse the static array verbatim.
 *
 * This is a per-event opt-in pattern (Q6 resolution). If a future routine
 * develops the same "skill needed only when user extends the rulebook"
 * shape, register its own predicate here rather than forcing every event
 * to think about context-driven loading.
 */
export function resolveSkillManifest(
  eventType: string,
  opts?: {
    contextDir?: string | null;
    /**
     * Live DB handle used by predicates that need to inspect runtime
     * tables (`gmailLifestyleActive`, `managedTasksActive`). Undefined →
     * predicates return the conservative include branch.
     */
    db?: Database.Database | null;
    /**
     * Inbound DM message text. Forwarded to `*ForDm` trigger-phrase
     * checks for DM-class events. Undefined for non-DM events.
     */
    messageText?: string | null;
  },
): string[] {
  const base = EVENT_SKILL_SETS[eventType];
  if (!base) return ALL_SKILLS;
  let result: string[] = base;

  if (eventType === "routine.evening_review") {
    if (!eveningRulebookIsActive(opts?.contextDir ?? null)) {
      result = result.filter((slug) => slug !== "notify");
    }
  }

  // docs/design/appendices/skills-improvement.md §9-§11 + §14 — gmail-lifestyle and
  // managed-tasks are present in the base array for the events listed
  // below and are dropped per-event when the matching predicate fires
  // false. DM-class events use the *ForDm variant so a trigger phrase
  // in the inbound message text can override an empty DB.
  const dmEvents = new Set([
    "message.received",
    "message.received.dm",
    "message.received.dm_first",
    "scheduled.dm",
  ]);
  const routineEventsWithGmailLifestyle = new Set([
    "routine.morning_routine",
    "routine.morning_routine_today",
  ]);

  if (dmEvents.has(eventType)) {
    if (
      result.includes("gmail-lifestyle") &&
      !gmailLifestyleActiveForDm(opts?.db ?? null, opts?.messageText ?? null)
    ) {
      result = result.filter((slug) => slug !== "gmail-lifestyle");
    }
    if (
      result.includes("managed-tasks") &&
      !managedTasksActiveForDm(opts?.db ?? null, opts?.messageText ?? null)
    ) {
      result = result.filter((slug) => slug !== "managed-tasks");
    }
  } else if (routineEventsWithGmailLifestyle.has(eventType)) {
    if (
      result.includes("gmail-lifestyle") &&
      !gmailLifestyleActive(opts?.db ?? null)
    ) {
      result = result.filter((slug) => slug !== "gmail-lifestyle");
    }
  }

  return result;
}

/**
 * Process-key flavoured wrapper around `resolveSkillManifest`. Mirrors
 * `getSkillsForProcess` so call sites that already key on `ProcessKey`
 * (most session materialisation sites) don't need to translate twice.
 */
export function resolveSkillManifestForProcess(
  processKey: ProcessKey,
  opts?: {
    contextDir?: string | null;
    db?: Database.Database | null;
    messageText?: string | null;
  },
): string[] {
  return resolveSkillManifest(
    PROCESS_TO_EVENT_TYPE[processKey] ?? processKey,
    opts,
  );
}

export function getProfileForEvent(eventType: string): string {
  for (const rule of PROFILE_RULES) {
    if (rule.exact ? eventType === rule.prefix : eventType.startsWith(rule.prefix)) {
      return rule.profile;
    }
  }
  return DEFAULT_PROFILE;
}

export function getSkillsForEvent(eventType: string): string[] {
  return EVENT_SKILL_SETS[eventType] ?? ALL_SKILLS;
}

export function getProfileForProcess(processKey: ProcessKey): string {
  return getProfileForEvent(PROCESS_TO_EVENT_TYPE[processKey] ?? processKey);
}

export function getSkillsForProcess(processKey: ProcessKey): string[] {
  return getSkillsForEvent(PROCESS_TO_EVENT_TYPE[processKey] ?? processKey);
}

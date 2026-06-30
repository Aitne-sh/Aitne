import { createLogger } from "../logging.js";

const logger = createLogger("risk-classifier");

/**
 * RiskTier — classifies the risk level of Daemon API operations.
 *
 * Convention: numeric enum → UPPER_CASE (EventPriority), string enum → PascalCase (RiskTier)
 */
export enum RiskTier {
  /** Safe to execute autonomously without any notification */
  Autonomous = "autonomous",
  /**
   * Contains personal data (email, calendar, notes, context files).
   * Enforced by X-Read-Token or Bearer auth when `enforceReadToken=true`.
   */
  ReadSensitive = "read_sensitive",
  /** Requires explicit user approval before execution */
  Approve = "approve",
}

/**
 * Risk classification per API endpoint.
 *
 * Keys use "METHOD /path" format for write operations that differ from
 * the default GET risk level. Plain "/path" applies to all methods.
 */
const API_RISK: Record<string, RiskTier> = {
  // ── Agent Internal API ──
  // /api/schedule is Autonomous per DESIGN.md §8: the agent self-schedules
  // as part of its normal operation. All methods are included — the agent
  // reschedules (PATCH) and cancels (DELETE) its own tasks via the schedule
  // skill, and the risk profile is identical to POST (single-row DB mutation,
  // idempotent by row ID).
  "/api/health": RiskTier.Autonomous,
  // /api/escalate is a 410 Gone stub. Listed explicitly (rather than
  // relying on the Approve default) so the boot audit's fingerprint
  // stays stable — see the "Admin / dashboard surfaces" block below.
  "POST /api/escalate": RiskTier.Approve,
  "/api/schedule": RiskTier.Autonomous,
  "PATCH /api/schedule/": RiskTier.Autonomous,
  "DELETE /api/schedule/": RiskTier.Autonomous,
  // SCHEDULE_API_REDESIGN_PLAN.md §4.4 — agent-callable discovery
  // endpoint cited by `schedule.model_unknown` / `schedule.frequency_unknown`
  // / `schedule.days_of_week_invalid` validValues payloads. Read-only,
  // no PII (registry shape + configured timezone), so Autonomous matches
  // the rest of the /api/schedule surface and the explicit entry pins
  // the audit fingerprint.
  "GET /api/schedule/options": RiskTier.Autonomous,
  // POST /api/schedule/batch is the morning-routine pipeline's bulk
  // entry-point (docs/design/appendices/morning-routine-optimization.md
  // §"POST /api/schedule/batch"). Same risk profile as POST /api/schedule:
  // single-table DB inserts the agent originates from its own session,
  // idempotent at the row level. No prefix-aliasing concerns since
  // "PATCH /api/schedule/" only matches the per-id PATCH path.
  "POST /api/schedule/batch": RiskTier.Autonomous,
  // PATCH /api/agent-actions/self lets the running session write
  // structured metadata into its own agent_actions row (used by the
  // morning-routine pipeline's ⑥ AgentJournalAppender). Autonomous —
  // the endpoint enforces same-row authn from x-pa-event-correlation-id
  // + x-process-key headers, so a malicious request would have to forge
  // the dispatcher-injected session identity.
  "PATCH /api/agent-actions/self": RiskTier.Autonomous,
  "/api/action/log": RiskTier.Autonomous,

  // Profile-interview queue helper. Read-only, returns a single boolean
  // (`{filled, sectionPresent}`) computed from a context-vault path. No
  // secrets, no auth-sensitive content. Agent prose calls this from the
  // morning routine (Layer 2 pre-pick), DM handler / scheduled.dm.md
  // (Layer 3 fire-time / opportunity abort), and the user_profile_sweep
  // (Layer 4 cross-check). See profile-interview-queue.md §3.5.
  "GET /api/profile-questions/slot-filled": RiskTier.Autonomous,

  // ── Recurring Schedules API (agent + dashboard) ──
  "GET /api/recurring-schedules": RiskTier.Autonomous,
  "POST /api/recurring-schedules": RiskTier.Autonomous,
  "PATCH /api/recurring-schedules/": RiskTier.Autonomous,
  "DELETE /api/recurring-schedules/": RiskTier.Autonomous,

  // ── Unified Task Board API (docs/design/appendices/unified-task-board.md) ──
  // L0 reads (inventory + blast-radius) are structural schedule metadata — the
  // same shape and tier as GET /api/recurring-schedules / /api/agents, so
  // Autonomous. The L1 write facade is intentionally Autonomous: it re-dispatches
  // each write through the OWNING route, which re-applies its own tier against
  // the forwarded credentials. So a token-less agent can edit a briefing
  // (rs: → /api/recurring-schedules, Autonomous) but is still 401'd on an agent
  // edit (agent: → /api/agents PATCH/DELETE, Approve) exactly as at the owner —
  // the inner gate decides, never a coarse outer one. The facade itself never
  // mutates a row directly (it only forwards), so it has no blast radius of its
  // own beyond what the owner enforces.
  "GET /api/tasks": RiskTier.Autonomous,
  "GET /api/tasks/impact": RiskTier.Autonomous,
  "POST /api/tasks": RiskTier.Autonomous,
  "PATCH /api/tasks/": RiskTier.Autonomous,
  "DELETE /api/tasks/": RiskTier.Autonomous,

  // ── Automation Triggers API (docs/design/19-dashboard-ia-and-triggers.md) ──
  // Dashboard-driven only — the agent does not configure its own triggers
  // (the user defines them in the Git/<domain> page UI). Approve tier for
  // both reads and writes: list responses reveal scheduling cadence and
  // free-form prompts, which can carry personal context.
  "/api/triggers": RiskTier.Approve,

  // ── Unified Repositories API (docs/design/appendices/unified-repositories.md) ──
  // Dashboard-driven only. Listing reveals registered local paths +
  // GitHub slugs (sensitive in shared-screen scenarios), CRUD changes
  // observer surface, and the run/init/scan endpoints spawn full agent
  // sessions in either a temp dir or a registered local clone.
  // Notify tier was abolished daemon-wide; Approve covers Bearer
  // enforcement for the dashboard and the agent has no current code
  // path that calls these without explicit user surface.
  // The /run + /triggers/:id/run + /management/{init,scan} routes also
  // write `agent_actions(action_type='repo_run')` rows for retrospective
  // visibility — the route handlers are the chokepoint, not the
  // classifier.
  "/api/repositories": RiskTier.Approve,
  // Agent-callable chokepoint for the architecture refresh flow. The
  // outer `/api/repositories` Approve umbrella protects browser-facing
  // CRUD; this endpoint is invoked by the agent session spawned for
  // `git.project.refresh_architecture` (no Bearer in the workdir), so
  // it gets an explicit Autonomous override. Body validation in the
  // route caps the payload size and rejects begin/end-marker
  // smuggling, so the blast radius is limited to the marker-bracketed
  // Architecture block of one overview.md.
  "PUT /api/repositories/{*}/architecture-section": RiskTier.Autonomous,

  // ── Skills API (agent + dashboard) ──
  // Agent manages user skills via the external-services skill (user-initiated DMs).
  // Built-in skills are immutable by API construction (slug collision rejection).
  // Reads and writes are both Autonomous — the agent calls via curl without
  // tokens. Per DELEGATED-MODE-V2-DESIGN.md §4.5, the user-driven `deniedTools`
  // setting is the primary defense; on-demand retrospective via /api/agent/actions
  // covers awareness.
  "GET /api/skills": RiskTier.Autonomous,
  "POST /api/skills": RiskTier.Autonomous,
  "PUT /api/skills/": RiskTier.Autonomous,
  "DELETE /api/skills/": RiskTier.Autonomous,

  // ── Docs & QA (DOCS_QA_BACKEND_DESIGN.md §10) ──
  // Read endpoints serve operator-facing docs that are not personal data
  // (sourced from agent-assets/docs/, mirrored to docs/user/ on first
  // launch). The docs-search skill must be able to curl these without a
  // Bearer token, so they're Autonomous.
  "/api/docs": RiskTier.Autonomous,
  // POST /api/docs/qa/messages enqueues a Q&A turn through the docs-QA
  // SSE adapter — it is dashboard-tab input gated by the dashboard's
  // Bearer auth, with the same blast-radius shape as /api/chat/messages
  // (Approve), so it gets an explicit override on top of the
  // Autonomous prefix (DOCS_QA_B7_DESIGN.md D6).
  "POST /api/docs/qa/messages": RiskTier.Approve,
  // GET /api/docs/qa/stream stays under the prefix's Autonomous tier
  // — the explicit row is documentation-shaped per the rest of this
  // file's style, so future readers can audit the QA endpoints by
  // grepping `docs/qa`.
  "GET /api/docs/qa/stream": RiskTier.Autonomous,

  // ── Dashboard / Browser-facing API ──
  // These endpoints are initiated by the dashboard rather than the autonomous
  // agent loop, so they must never be reachable without an API token.
  "GET /api/config/google-auth/callback": RiskTier.Autonomous,
  // design/15-character.md §15.6 — dedicated agent-callable endpoint for the
  // character (persona) field. The general /api/config surface stays Approve
  // because it can touch secrets, OAuth tokens, and schedule hot-reloads.
  // The character field is a single bounded style string, so a GET/PATCH
  // scoped to it matches /api/skills' risk profile: Autonomous on both.
  // Bearer-less callers (the agent's curl from a session workdir) can set
  // tone/persona without the full config blast radius.
  "GET /api/config/character": RiskTier.Autonomous,
  "PATCH /api/config/character": RiskTier.Autonomous,
  "/api/config": RiskTier.Approve,
  "GET /api/browser-history/status": RiskTier.Approve,
  "GET /api/browser-history/research-clusters": RiskTier.Autonomous,
  "GET /api/browser-history/research-clusters/{*}": RiskTier.Autonomous,
  "GET /api/browser-history/yesterday-summary": RiskTier.Autonomous,
  // BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 P4a — pre-morning digest
  // JSON endpoint. Read-only; serves the same Zod-validated shape the
  // morning Stage B journal already reads from the markdown sidecar.
  // No raw URLs / titles in the response (Layer 1 invariant), so
  // Autonomous like the rest of the browser-history read surface.
  "GET /api/browser-history/pre-morning-digest/{*}": RiskTier.Autonomous,
  "GET /api/browser-history/shopping/{*}": RiskTier.Autonomous,
  "GET /api/browser-history/reloads/today": RiskTier.Autonomous,
  "GET /api/browser-history/reloads/weekly": RiskTier.Autonomous,
  // BROWSER_HISTORY_INTEGRATION_PLAN P3 — engagement offers.
  // Reads (`/offers/pending`) are autonomous; the agent surfaces open
  // offers in the morning digest. Accept (`POST /offers/{*}/accept`)
  // queues a process-key dispatch one step removed from external
  // research / wiki writes — ReadSensitive so the dashboard's bearer
  // is enforced but the agent's curl from the session workdir still
  // works (the route enforces token presence via the same middleware
  // as other ReadSensitive endpoints). Decline and mute are
  // autonomous DB updates.
  "GET /api/browser-history/offers/pending": RiskTier.Autonomous,
  "POST /api/browser-history/offers/{*}/accept": RiskTier.ReadSensitive,
  "POST /api/browser-history/offers/{*}/decline": RiskTier.Autonomous,
  "POST /api/browser-history/offers/{*}/mute": RiskTier.Autonomous,
  // Agent write-back after `routine.research_wiki_summary` successfully
  // writes the wiki note. Stamps `wikiSummaryWrittenAt`; the only
  // mutation is on the cluster row the agent is already permitted to
  // read. Autonomous so the agent's curl from the session workdir works
  // without a bearer.
  "POST /api/browser-history/research-clusters/{*}/wiki-written":
    RiskTier.Autonomous,
  // ── WEEKLY_INTERESTS_REFLECTION_PLAN.md §17 ──
  // GET summary is read-only aggregate over cluster data; no PII / URL
  // / title content surfaces. Same risk profile as `/research-clusters`.
  "GET /api/browser-history/weekly-interests-summary": RiskTier.Autonomous,
  // POST refresh / cleanup are dashboard-only — bearer-token-
  // authenticated. Neither is listed in any skill's `allowed-tools`, so
  // no LLM can call them; the scheduler invokes the same logic via a
  // direct function call inside `dispatcher-scheduled-tasks.ts`'s
  // pre-hook, bypassing the HTTP layer. Approve tier documents the
  // bearer requirement and produces an audit row distinct from the
  // autonomous-tier reflection runs.
  "POST /api/browser-history/refresh-interests-reflection": RiskTier.Approve,
  "POST /api/browser-history/cleanup-interests-reflection": RiskTier.Approve,

  // ── Managed Chromium (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.10) ──
  // The dashboard control surface for the managed Chromium Instance S.
  // Reads (`status`, `setup-status`) are Autonomous so the dashboard
  // status badge can poll without a bearer. Mutations that destroy
  // state (`disconnect`, `enable=false`) are Approve. Mutations that
  // spawn a UI Chromium for the user to type credentials into
  // (`setup`, `setup-finish`, `reconnect`) are ReadSensitive: the
  // dashboard's bearer auth is required, but the agent never reaches
  // these routes (the skill body forbids them and the route layer's
  // tier guard short-circuits before any DB mutation).
  "GET /api/browser-history/managed/status": RiskTier.Autonomous,
  "POST /api/browser-history/managed/setup": RiskTier.ReadSensitive,
  "GET /api/browser-history/managed/setup-status": RiskTier.Autonomous,
  "POST /api/browser-history/managed/setup-finish": RiskTier.ReadSensitive,
  "POST /api/browser-history/managed/reconnect": RiskTier.ReadSensitive,
  "POST /api/browser-history/managed/disconnect": RiskTier.Approve,
  "POST /api/browser-history/managed/enable": RiskTier.Approve,
  // Opt-in Playwright Chromium download. Approve-tier because the
  // install touches the network and writes ~150 MiB into the user's
  // Playwright cache — an autonomous agent must not trigger this on
  // its own. The status sibling is autonomous-safe (read-only state).
  "POST /api/browser-history/managed/install-chromium": RiskTier.Approve,
  "GET /api/browser-history/managed/install-chromium/status": RiskTier.Autonomous,

  // ── Browser Automation Sites (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.9) ──
  // Phase B-2.5 per-site sign-in surface. Reads (`sites`,
  // `sites/{*}/status`) are Autonomous so the dashboard's per-site
  // card can poll without a bearer; the agent's auth-variant
  // workflows also call `GET /sites` to discover whether the user
  // has connected the site they need. Every mutation
  // (`connect` / `finalize` / `reauth` / `disconnect`) is Approve —
  // sign-in spawns a UI Chromium the user types credentials into, and
  // the connect / reauth payloads change the persistent profile dir.
  // The agent cannot trigger these (skill body forbids them; the
  // route layer's tier guard short-circuits before any DB mutation).
  "GET /api/browser-automation/sites": RiskTier.Autonomous,
  "POST /api/browser-automation/sites/{*}/connect": RiskTier.Approve,
  "GET /api/browser-automation/sites/{*}/status": RiskTier.Autonomous,
  "POST /api/browser-automation/sites/{*}/finalize": RiskTier.Approve,
  "POST /api/browser-automation/sites/{*}/reauth": RiskTier.Approve,
  "POST /api/browser-automation/sites/{*}/disconnect": RiskTier.Approve,

  // ── Browser Automation Purchase (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.10) ──
  // Phase B-4 experimental purchase surface. Token issuance is
  // daemon-internal — there is NO `POST /purchase-tokens` route. The
  // dashboard list endpoint is `Approve` rather than `Autonomous`
  // because a token list reveals every in-flight purchase intent
  // (site, displayed total, originating channels), and the agent has
  // no legitimate path to read it (the workflow already holds the
  // jti it minted for its own awaitReply polling). The DELETE path is
  // dashboard-only (user "Cancel pending" button); the agent cannot
  // cancel another workflow's token.
  "GET /api/browser-automation/purchase-tokens": RiskTier.Approve,
  "DELETE /api/browser-automation/purchase-tokens/{*}": RiskTier.Approve,
  // Global master toggle. Read is Autonomous so the dashboard can poll
  // status without a bearer; flipping is Approve (bearer-required).
  "GET /api/browser-automation/b4/enabled": RiskTier.Autonomous,
  "POST /api/browser-automation/b4/enabled": RiskTier.Approve,
  // Per-site config + primary-channel selection — dashboard-only.
  "GET /api/browser-automation/b4/site-configs": RiskTier.Autonomous,
  "PATCH /api/browser-automation/sites/{*}/b4-config": RiskTier.Approve,
  "GET /api/browser-automation/b4/primary-channels": RiskTier.Autonomous,
  "PATCH /api/browser-automation/channels/{*}/{*}/primary": RiskTier.Approve,

  // ── Browser Task (BROWSER_TASK_REDESIGN_PLAN.md §3) ──
  // Open-ended natural-language browser sub-agent surface. POST is
  // Autonomous — the only production caller today is the DM-agent
  // `browser-task` skill, whose curl shim carries only `x-read-token`
  // (sufficient for ReadSensitive, never enough for Approve). The
  // historical Approve tier here assumed a Phase 2 "DM-agent adapter
  // holds the dashboard bearer" path that was never wired, producing
  // a 401 on every DM-driven dispatch. Matching the sibling agent-
  // driven write paths (clarify + cancel, both Autonomous) keeps the
  // surface coherent. Defense-in-depth that actually matters lives
  // downstream and is independent of the API auth tier:
  //   1. Host-header loopback gate + sec-fetch-site / origin checks
  //      in `evaluateLoopbackBrowserGate` — CSRF protection survives
  //      at Autonomous (only same-origin POSTs from the dashboard's
  //      loopback origin reach the handler).
  //   2. `x-pa-channel-ref` attestation against `listPrimaryChannels()`
  //      inside the POST handler — a request whose channel is out of
  //      the primary set is silently downgraded with a
  //      `browser_task_channel_override` audit row.
  //   3. Per-task global cap, user-curated `browserTaskHostnameDenylist`,
  //      hardcoded payment-path block, and the B-4 final-confirm
  //      token gate inside the runner.
  //   4. Every dispatched task surfaces to the user via DM — there is
  //      no covert dispatch path. A future dashboard re-run button
  //      that calls this endpoint will still authenticate via Bearer
  //      because the dashboard proxy attaches one by default; the
  //      tier change only affects what's required, not what's offered.
  // The list / detail / events / screenshot reads stay ReadSensitive
  // because the task description + action log can carry personal
  // context (account ids, free-text intent).
  "POST /api/browser-task": RiskTier.Autonomous,
  "GET /api/browser-task": RiskTier.ReadSensitive,
  "GET /api/browser-task/{*}": RiskTier.ReadSensitive,
  "GET /api/browser-task/{*}/events": RiskTier.ReadSensitive,
  "GET /api/browser-task/{*}/screenshots/{*}": RiskTier.ReadSensitive,
  "POST /api/browser-task/{*}/clarify": RiskTier.Autonomous,
  "POST /api/browser-task/{*}/cancel": RiskTier.Autonomous,

  // ── Background Task (BACKGROUND_TASK_RUNNER_DESIGN.md §7) ──
  // Generic detached long-task surface, cloned from browser-task and
  // classified to the same posture. The only production callers are the
  // DM-agent `background-task` / `background-task-reply` skills and the
  // morning-briefing session, whose curl shim carries `x-read-token`
  // (sufficient for ReadSensitive, never enough for Approve). The same
  // loopback / sec-fetch / channel-attestation defenses as browser-task
  // apply, and every dispatched task surfaces to the user via DM — no
  // covert dispatch path.
  //   - POST (spawn) + clarify + cancel are Autonomous, matching the
  //     sibling agent-driven write paths (design §7: "same posture as
  //     /api/browser-task").
  //   - The list + detail reads stay ReadSensitive (NOT Autonomous):
  //     the artifact (`report` / `brief` / `draft` / `significance`)
  //     carries personal research / audit content, exactly the reason
  //     browser-task's reads are ReadSensitive. Reachable from the agent
  //     sessions that need them because their curl carries the read
  //     token (cf. GET /api/observations, also ReadSensitive, which the
  //     briefing already calls).
  "POST /api/background-task": RiskTier.Autonomous,
  "GET /api/background-task": RiskTier.ReadSensitive,
  "GET /api/background-task/{*}": RiskTier.ReadSensitive,
  "POST /api/background-task/{*}/clarify": RiskTier.Autonomous,
  "POST /api/background-task/{*}/cancel": RiskTier.Autonomous,

  "/api/setup": RiskTier.Approve,
  "POST /api/setup/redetect-browsers": RiskTier.Approve,
  // Management Mode Phase 2 — migration endpoint. Redundant with the
  // /api/setup prefix rule above (which already hits Approve) but named
  // explicitly so future refactors of the setup-tier rules don't
  // accidentally drop this endpoint to a weaker tier. The blast radius
  // is catastrophic: move files + rewrite DB + swap the context store.
  "POST /api/setup/migrate-context": RiskTier.Approve,
  // Knowledge import — owner uploads a Markdown / text file from the
  // dashboard Knowledge page; the daemon emits a one-shot session that
  // writes facts into user/*.md. Approve tier because the blast radius
  // is the entire user/* tree. Bearer auth required.
  "POST /api/knowledge/import": RiskTier.Approve,
  "/api/system": RiskTier.Approve,
  "/api/events": RiskTier.Approve,
  "/api/conversations": RiskTier.Approve,
  "DELETE /api/conversations": RiskTier.Approve,
  "DELETE /api/conversations/": RiskTier.Approve,
  "/api/cost": RiskTier.Approve,
  "/api/metrics": RiskTier.Approve,
  "/api/logs": RiskTier.Approve,
  "/api/approvals": RiskTier.Approve,
  "/api/notifications": RiskTier.Approve,
  "/api/search": RiskTier.Approve,
  "/api/snapshots": RiskTier.Approve,
  "/api/chat": RiskTier.Approve,
  "/api/commands": RiskTier.Approve,
  "/api/schedule/next": RiskTier.Approve,
  "/api/schedule/list": RiskTier.Approve,
  "POST /api/agent/regenerate": RiskTier.Approve,
  "POST /api/agent/run-now": RiskTier.Approve,
  // Evening-review slimdown §2.2 — manual fire of the daily mechanical
  // roadmap.md maintenance pass. Same Approve tier as the parent
  // `/run-now`: the daemon's CLI / dashboard hold the Bearer token,
  // agents do not.
  "POST /api/agent/run-now/roadmap-maintenance": RiskTier.Approve,
  // DELEGATED-MODE-V2-DESIGN.md §6.1 — agent-callable retrospective.
  // Autonomous tier so the DM session can read its own audit trail without
  // the dashboard-issued bearer (which agents don't have). Output is
  // redacted via secret-redaction before serialization.
  "GET /api/agent/actions": RiskTier.Autonomous,

  // ── Agent Definitions (AGENT_DEFINITIONS_DESIGN.md §9.7) ──
  // Reads + run-now are Autonomous: the list/detail/executions surface is
  // structural metadata about the agent's own scheduled identities (no PII
  // beyond what /api/schedule already exposes), and run-now enqueues a single
  // `agent_schedule` row the agent could already create via the schedule skill
  // (system-Agent run-now additionally DMs the owner in-handler — the §9.7
  // Notify convention, since the RiskTier enum has no Notify value). PATCH /
  // DELETE are Approve: they change `enabled` state / config overrides / delete
  // user Agents, and the stop-warning ack is the explicit consent surface, so
  // the dashboard's bearer token is required. `{*}` matches the `:slug`
  // segment; the executions + run-now patterns carry an extra trailing literal.
  // POST /api/agents (create) is Autonomous: it is the agent-facing replacement
  // for the now-410 `POST /api/recurring-schedules` (also Autonomous) — the
  // `agent-create` skill teaches the DM agent to create a recurring Agent for an
  // ongoing cadence, the same recurring-task capability it already had. The
  // loader rejects a one_shot/event definition; planCreate validates the rest.
  "GET /api/agents": RiskTier.Autonomous,
  "POST /api/agents": RiskTier.Autonomous,
  "GET /api/agents/{*}": RiskTier.Autonomous,
  "GET /api/agents/{*}/executions": RiskTier.Autonomous,
  "POST /api/agents/{*}/run-now": RiskTier.Autonomous,
  "PATCH /api/agents/{*}": RiskTier.Approve,
  "DELETE /api/agents/{*}": RiskTier.Approve,

  // ── Wiki Builder (WIKI_BUILDER_DESIGN.md Phase 1) ──
  // Dashboard workspace settings stay owner-only. Agent-callable file,
  // search, and index routes are Autonomous at middleware level but enforce
  // `x-process-key` and layer permissions inside the route.
  "/api/wiki/workspaces": RiskTier.Approve,
  "GET /api/wiki/": RiskTier.Autonomous,
  "POST /api/wiki/": RiskTier.Autonomous,
  "PATCH /api/wiki/": RiskTier.Autonomous,

  // ── Wiki Vault Probe (dashboard external-mode picker) ──
  // Path-validation probe called by the wiki settings page after the
  // operator picks a directory through the system-native folder dialog
  // (`/api/system/pick-directory`). Reports existence, writability,
  // collisions with primary/external/data vaults, and existing-wiki
  // structure (WIKI_BUILDER_DESIGN.md §6.1 / §7). Dashboard-only —
  // the agent has no legitimate use case for probing arbitrary user
  // paths. Approve tier so Bearer auth is mandatory; forbidden-prefix
  // and secret-path rejection happen in `fs.logic.ts`.
  "/api/fs/probe": RiskTier.Approve,

  // ── Chat file attachments (Phase 1) ──
  // Dashboard-initiated reads/uploads/deletes are owner-only. They fall
  // under the `/api/chat` Approve umbrella so Bearer auth is enforced by
  // the middleware — explicit entries are listed for auditability only.
  "GET /api/chat/attachments/": RiskTier.Approve,
  "POST /api/chat/attachments": RiskTier.Approve,
  "DELETE /api/chat/attachments/": RiskTier.Approve,
  // The outbound endpoint is the agent's path (curl from the session
  // workdir, no Bearer). It validates `X-Turn-Token` in-handler instead,
  // so the middleware must not force Bearer on it. Autonomous tier drops
  // it from Approve's mandatory-Bearer check; the agent's calls land in
  // agent_actions for the on-demand retrospective.
  "POST /api/chat/outbound-attachments": RiskTier.Autonomous,

  // ── Context File API ──
  // GET reads contain personal notes, schedule, user profile — ReadSensitive.
  // Writes remain Autonomous (agent's own memory operations).
  //
  // CONTEXT_VAULT_REDESIGN_PLAN.md §7.1 — after the six-class restructure
  // the per-path entries collapse to one row per class prefix. Legacy
  // URLs (e.g. `PUT /api/context/today.md`) are normalised by the
  // in-process alias resolver before reaching the classifier, so only
  // canonical paths need to be enumerated here.
  "GET /api/context": RiskTier.ReadSensitive,
  "PUT /api/context/": RiskTier.Autonomous,
  "PATCH /api/context/": RiskTier.Autonomous,
  // identity/ ← user profile + area files
  "PUT /api/context/identity/": RiskTier.Autonomous,
  "PATCH /api/context/identity/": RiskTier.Autonomous,
  // state/ — today, yesterday, scratch, inbox, activity, profile questions
  "PUT /api/context/state/": RiskTier.Autonomous,
  "PATCH /api/context/state/": RiskTier.Autonomous,
  "DELETE /api/context/state/": RiskTier.Autonomous,
  // plans/ — roadmap + projects
  "PUT /api/context/plans/": RiskTier.Autonomous,
  "PATCH /api/context/plans/": RiskTier.Autonomous,
  // Pure-utility ID minter for the new plans/roadmap path. Reads
  // existing IDs, generates a fresh one. No write side-effect.
  "POST /api/context/plans/roadmap/id": RiskTier.Autonomous,
  // policies/ — management, mcp, redaction, journal-format/-export,
  // integrations.md, management-captures, routines, skills
  "PUT /api/context/policies/": RiskTier.Autonomous,
  "PATCH /api/context/policies/": RiskTier.Autonomous,
  // DELETE on policies/ is intentionally scoped to routines/custom/*
  // only — policy captures preserve `status: removed` rather than
  // physically deleting, so blanket policies/ DELETE would defeat the
  // §4.6 / §5.1 audit invariant. Custom routines have their own
  // explicit route entry below.
  "DELETE /api/context/policies/routines/custom/": RiskTier.Autonomous,
  // journal/ — append-only narrative.
  "PUT /api/context/journal/": RiskTier.Autonomous,
  "PATCH /api/context/journal/": RiskTier.Autonomous,
  // knowledge/ — dossiers, entities, wiki, repos.
  "PUT /api/context/knowledge/": RiskTier.Autonomous,
  "PATCH /api/context/knowledge/": RiskTier.Autonomous,
  // Day rotation endpoint (today.md → yesterday.md; synthesized
  // journal/daily/YYYY-MM-DD.md is written by the morning routine).
  "POST /api/context/archive-today": RiskTier.Autonomous,
  "GET /api/context/list": RiskTier.ReadSensitive,
  // B-008 P7 — Vault Health surface. `health` returns a structural drift
  // report (no user prose), so Autonomous. `repair/stub` copies a template
  // file into the vault — Autonomous (agent self-repair); the dashboard
  // path remains unauthenticated-with-browser-gate per the agent-callable
  // pattern, and every call lands in agent_actions for retrospective.
  "GET /api/context/health": RiskTier.Autonomous,
  "POST /api/context/repair/stub": RiskTier.Autonomous,
  "POST /api/context/lock/morning-routine": RiskTier.Autonomous,
  "DELETE /api/context/lock/morning-routine": RiskTier.Autonomous,
  "POST /api/context/lock/roadmap": RiskTier.Autonomous,
  "DELETE /api/context/lock/roadmap": RiskTier.Autonomous,
  "GET /api/observations": RiskTier.ReadSensitive,
  "GET /api/observations/stats": RiskTier.Autonomous,
  "POST /api/observations": RiskTier.Autonomous,
  "POST /api/observations/consume": RiskTier.Autonomous,
  // Helpful 405 routes (see `observations.ts`). Classified Autonomous so
  // the auth middleware passes the request to the route handler, which
  // returns the canonical bulk-endpoint hint. Without these entries the
  // fail-closed default returns 401, which gives the agent nothing to
  // act on and drives the retry loop seen in 2026-05 telemetry.
  "GET /api/observations/consume": RiskTier.Autonomous,
  "POST /api/observations/{*}/consume": RiskTier.Autonomous,
  "GET /api/observations/{*}/consume": RiskTier.Autonomous,
  "PUT /api/observations/{*}/consume": RiskTier.Autonomous,
  "PATCH /api/observations/{*}/consume": RiskTier.Autonomous,
  "DELETE /api/observations/{*}/consume": RiskTier.Autonomous,
  "POST /api/feedback": RiskTier.Autonomous,
  "POST /api/feedback/consume": RiskTier.Autonomous,
  // Read-only lesson-store overview for the dashboard Lessons settings page
  // (FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5). Summarises cap utilisation
  // only — lesson prose was redaction-scrubbed at capture — so Autonomous.
  "GET /api/feedback/lessons": RiskTier.Autonomous,
  // Self-tuning verdict endpoint (SELF_TUNING_REVIEW_CYCLE_DESIGN.md §3.4).
  // Autonomous + (Phase 3) mandatory owner DM on apply — the exact pattern
  // that replaced the abolished Notify tier; requiring the Approve bearer
  // would put a human back in every loop iteration and defeat the design.
  // Safety is carried by code, not tier: verdicts may only reference
  // daemon-generated single-use recommendation ids from the current cycle,
  // the handler is idempotent per id, and Phase 2 never actuates (shadow).
  "POST /api/tuning/verdicts": RiskTier.Autonomous,
  // Pending-cycle read — knob names + telemetry counts only, no user prose.
  "GET /api/tuning/pending": RiskTier.Autonomous,

  // ── Notification ──
  "/api/notify": RiskTier.Autonomous,

  // ── External Service Proxy ──
  // GET reads return personal calendar/email/notes data — ReadSensitive.
  "GET /api/calendar/events": RiskTier.ReadSensitive,
  "GET /api/calendar/calendars": RiskTier.ReadSensitive,
  "POST /api/calendar/events": RiskTier.Autonomous,
  "PATCH /api/calendar/events": RiskTier.Autonomous,
  "DELETE /api/calendar/events": RiskTier.Autonomous,
  "POST /api/calendar/freebusy": RiskTier.ReadSensitive,
  // SETUP-FLOW-REDESIGN-PLAN §5.5 / §6.1 — Outlook on-demand calendar
  // reads (no observer in v1). Read-sensitive matches the Google
  // calendar list/get tier; the agent never writes via these routes
  // today.
  "GET /api/calendar/outlook/calendars": RiskTier.ReadSensitive,
  "GET /api/calendar/outlook/events": RiskTier.ReadSensitive,

  // Apple Calendar (iCloud CalDAV) — same tiers as Google Calendar for the
  // event-level routes; credential setters require Approve so the agent
  // cannot quietly write app-specific passwords on the user's behalf even
  // though the curl allowlist would otherwise permit it.
  "GET /api/apple-calendar/status": RiskTier.Autonomous,
  "GET /api/apple-calendar/events": RiskTier.ReadSensitive,
  "GET /api/apple-calendar/calendars": RiskTier.ReadSensitive,
  "POST /api/apple-calendar/events": RiskTier.Autonomous,
  "PATCH /api/apple-calendar/events": RiskTier.Autonomous,
  "DELETE /api/apple-calendar/events": RiskTier.Autonomous,
  "POST /api/apple-calendar/freebusy": RiskTier.ReadSensitive,
  "POST /api/apple-calendar/credentials": RiskTier.Approve,
  "DELETE /api/apple-calendar/credentials": RiskTier.Approve,
  "POST /api/apple-calendar/default-calendar": RiskTier.Approve,

  "GET /api/notion/query": RiskTier.ReadSensitive,
  "GET /api/notion/databases": RiskTier.ReadSensitive,
  "GET /api/notion/search": RiskTier.ReadSensitive,
  "GET /api/notion/pages/": RiskTier.ReadSensitive,
  "POST /api/notion/pages": RiskTier.Autonomous,
  "PATCH /api/notion/pages/": RiskTier.Autonomous,
  "DELETE /api/notion/pages/": RiskTier.Autonomous,

  // Obsidian: status is low-sensitivity metadata; notes/search contain content.
  "GET /api/obsidian/status": RiskTier.Autonomous,
  "GET /api/obsidian/notes": RiskTier.ReadSensitive,
  "GET /api/obsidian/search": RiskTier.ReadSensitive,
  "POST /api/obsidian/notes": RiskTier.Autonomous,
  "PUT /api/obsidian/notes": RiskTier.Autonomous,
  "PATCH /api/obsidian/notes": RiskTier.Autonomous,
  "DELETE /api/obsidian/notes": RiskTier.Autonomous,
  "PATCH /api/obsidian/daily": RiskTier.Autonomous,

  // ── Multi-mail provider (Phase 1 scope gate + Phase 2 Outlook routes) ──
  "GET /api/mail/providers": RiskTier.ReadSensitive,
  "PATCH /api/mail/providers": RiskTier.Approve,
  "GET /api/mail/accounts": RiskTier.ReadSensitive,
  "POST /api/mail/accounts": RiskTier.Approve,
  "POST /api/mail/accounts/device-code": RiskTier.Approve,
  "PATCH /api/mail/accounts/": RiskTier.Approve,
  "DELETE /api/mail/accounts/": RiskTier.Approve,
  // BYOA client-config — stores the Azure AD clientId/tenant. The payload
  // itself is not a secret (public OAuth client model), but writes reshape
  // trust for every Outlook account so the write path is owner-only.
  "GET /api/config/mail/outlook/client-config": RiskTier.Approve,
  "PUT /api/config/mail/outlook/client-config": RiskTier.Approve,
  "DELETE /api/config/mail/outlook/client-config": RiskTier.Approve,
  "POST /api/config/mail/app-password": RiskTier.Approve,
  // App-password rotation: rewrites credentials for an existing IMAP account
  // — same blast radius as initial create, owner-only.
  "POST /api/config/mail/app-password/{*}/refresh": RiskTier.Approve,

  // ── Multi-mail provider per-account operations (Phase 5 §3.3, §8) ──
  // Routes are split by blast radius, not by body content, so the classifier
  // stays path-based. `{*}` is a single-segment placeholder (see
  // {@link matchesPattern}). Pattern keys win over flat-prefix keys of
  // equal literal-prefix length.
  //
  // Flat-prefix defaults (catch-all for any new /api/mail/* route that
  // hasn't been classified explicitly yet — Autonomous for all writes per
  // DELEGATED-MODE-V2-DESIGN.md §4.5.1. Explicit patterns below override the
  // catch-alls via the longest-literal-prefix tiebreaker; deniedTools is
  // the safety control, not the tier.):
  "GET /api/mail/": RiskTier.ReadSensitive,
  // Cross-account local FTS5 search — ReadSensitive like any mail read.
  // Listed explicitly so the rule is obvious in review even though the
  // GET catch-all above would cover it.
  "GET /api/mail/search": RiskTier.ReadSensitive,
  "POST /api/mail/": RiskTier.Autonomous,
  "PATCH /api/mail/": RiskTier.Autonomous,
  "DELETE /api/mail/": RiskTier.Autonomous,
  // Draft CRUD — drafts are inert until explicitly sent.
  "POST /api/mail/{*}/drafts": RiskTier.Autonomous,
  "PATCH /api/mail/{*}/drafts/": RiskTier.Autonomous,
  "DELETE /api/mail/{*}/drafts/": RiskTier.Autonomous,
  // Reversible metadata ops (mark-read, labels, archive, untrash).
  "POST /api/mail/{*}/messages/{*}/read": RiskTier.Autonomous,
  "POST /api/mail/{*}/messages/{*}/archive": RiskTier.Autonomous,
  "POST /api/mail/{*}/messages/{*}/untrash": RiskTier.Autonomous,
  "POST /api/mail/{*}/messages/{*}/tags": RiskTier.Autonomous,
  // Destructive / outbound — Autonomous; deniedTools is the safety control
  // (DELEGATED-MODE-V2-DESIGN.md §4.5). The wizard pre-populates a starter
  // denylist on first delegated setup so a fresh install blocks _send / trash
  // by default; the user opts out explicitly per §4.5.4.
  "POST /api/mail/{*}/messages/send": RiskTier.Autonomous,
  "POST /api/mail/{*}/messages/{*}/trash": RiskTier.Autonomous,
  "POST /api/mail/{*}/drafts/{*}/send": RiskTier.Autonomous,

  // ── Git ──
  "GET /api/git": RiskTier.Autonomous,
  // Git project document templates + Re-template (P6 git-lifecycle-and-triggers.md
  // Decision 8). The editor (GET/PUT), apply (POST :kind/apply), and status
  // (GET retemplate/status) are dashboard-driven and change durable assets,
  // so they sit at Approve-tier — matching `/api/task-flows` whose blast
  // radius is the same shape (free-form prose the agent picks up verbatim).
  // The per-file reporter (POST retemplate/file) is the exception: the
  // re-template task-flow runs as an autonomous session and posts per-file
  // progress over curl from the session workdir, which carries no Bearer
  // token. It must therefore be Autonomous, mirroring `/api/observations`
  // and the `/api/context/*` write surface. The exact-match rule wins over
  // the path-only `/api/git/templates` prefix per
  // `findExplicitRiskClassification` step 1.
  "POST /api/git/templates/retemplate/file": RiskTier.Autonomous,
  "/api/git/templates": RiskTier.Approve,

  // ── GitHub ──
  "GET /api/github": RiskTier.Autonomous,
  "POST /api/github/pulls/comment": RiskTier.Autonomous,

  // ── Travel Bookings (Phase B) ──
  "GET /api/travel-bookings": RiskTier.ReadSensitive,
  "GET /api/travel-bookings/": RiskTier.ReadSensitive,
  "GET /api/travel-bookings/upcoming": RiskTier.ReadSensitive,
  "PATCH /api/travel-bookings/": RiskTier.Approve,

  // ── Receipts (Phase B) ──
  "GET /api/receipts": RiskTier.ReadSensitive,
  "GET /api/receipts/": RiskTier.ReadSensitive,
  "GET /api/receipts/summary": RiskTier.ReadSensitive,
  "POST /api/receipts/": RiskTier.ReadSensitive, // binary receipt download
  "PATCH /api/receipts/": RiskTier.Approve,

  // ── Books & Reading (Phase C, F-10) ──
  "GET /api/books": RiskTier.ReadSensitive,
  "GET /api/books/": RiskTier.ReadSensitive,
  "GET /api/books/summary": RiskTier.ReadSensitive,
  "PATCH /api/books/": RiskTier.Approve,                // user corrections
  "POST /api/books/import-clippings": RiskTier.Autonomous,  // bulk data write
  "POST /api/books/import-notebook-html": RiskTier.Autonomous, // Kindle Notebook Export email ingest

  // ── MCP Servers (B-003 Phase 2) ──
  // Mutations are Approve tier because an MCP server is effectively arbitrary
  // code with tool-level access to the agent. Probe is Autonomous — it spawns
  // a subprocess / opens an outbound HTTP call to the server the user just
  // configured, but it does not commit any agent-visible state until the
  // enable flip (which is Approve).
  "GET /api/mcp/servers": RiskTier.ReadSensitive,
  "GET /api/mcp/servers/": RiskTier.ReadSensitive,
  "POST /api/mcp/servers": RiskTier.Approve,
  "PATCH /api/mcp/servers/": RiskTier.Approve,
  "DELETE /api/mcp/servers/": RiskTier.Approve,
  "POST /api/mcp/servers/{*}/probe": RiskTier.Autonomous,
  "POST /api/mcp/servers/{*}/enable": RiskTier.Approve,
  "POST /api/mcp/servers/{*}/disable": RiskTier.Autonomous,
  "PUT /api/mcp/servers/{*}/secrets/": RiskTier.Approve,
  "DELETE /api/mcp/servers/{*}/secrets/": RiskTier.Approve,
  // Phase 3 kill switch — Autonomous. Contracts tool surface; per-server
  // enable (which expands surface) stays Approve.
  "POST /api/mcp/disable-all": RiskTier.Autonomous,
  // Gemini-side MCP installer — shells out to `gemini extensions install`
  // / `gemini mcp add`, modifying ~/.gemini/* config and potentially
  // launching an OAuth browser flow. Approve tier matches the per-server
  // mutation routes above: an MCP install expands the agent's tool
  // surface and the install URL is a trust delegation to a third-party
  // GitHub release / hosted MCP server.
  "POST /api/mcp/gemini-install": RiskTier.Approve,

  // ── Backends / Auth Recovery ──
  // Dashboard-initiated. Reads are Approve (contain auth status detail).
  // Recovery writes are Approve (credential file writes).
  "GET /api/backends": RiskTier.Approve,
  // Live opencode model catalogue. Read-only — enumerates providers + models
  // already configured on the operator's opencode server. Approve tier matches
  // the parent `GET /api/backends` (which already returns auth status detail).
  "GET /api/backends/opencode/live-models": RiskTier.Approve,
  "POST /api/backends/": RiskTier.Approve,
  "PUT /api/backends/main": RiskTier.Approve,
  // Provider API key configuration (ANTHROPIC_API_KEY / OPENAI_API_KEY /
  // GEMINI_API_KEY+GOOGLE_API_KEY). Approve tier across the board:
  //  - GET returns whether a key is configured + which env source — sensitive
  //    metadata that reveals the operator's auth posture.
  //  - PUT writes a provider credential to the OS keychain and mirrors it
  //    into process.env, redirecting every subsequent agent call to that key.
  //  - DELETE removes the key, restoring the captured shell-set value (if
  //    any) or falling back to CLI/OAuth.
  "GET /api/backends/{*}/api-key": RiskTier.Approve,
  "PUT /api/backends/{*}/api-key": RiskTier.Approve,
  "DELETE /api/backends/{*}/api-key": RiskTier.Approve,

  // ── Integrations (delegation framework, Phase 1) ──
  // Dashboard-only mutations — mode changes rewrite `integrations.md` and
  // (in later phases) stop pollers / gate routes. Approve tier matches
  // the `/api/backends` profile.
  "GET /api/integrations": RiskTier.Approve,
  "PATCH /api/integrations/": RiskTier.Approve,
  // Phase 2: connector probe endpoint. Approve-tier — the request body
  // accepts a tool list that bypasses the live MCP enumerator, so a
  // misuse can falsify the cached features map until the next live probe
  // overwrites it. Same trust level as the mode flip above.
  "POST /api/integrations/{*}/probe": RiskTier.Approve,
  // RESERVED — POST /api/integrations/{*}/invoke. The route is unmounted
  // today (superseded by /exec). The classification is preserved
  // commented-out so a future reactivation lands back at Autonomous tier
  // without re-deriving the rationale: the agent calls freely from
  // cross-backend skill prose and the user's `deniedTools` is the
  // chokepoint; Approve is reserved for daemon-config posture changes.
  // "POST /api/integrations/{*}/invoke": RiskTier.Autonomous,
  // delegated-sync opt-in surface
  // (docs/design/appendices/delegated-sync-opt-in.md). Approve tier:
  // dashboard-only schedule writes that change which background cadences
  // spend AI tokens. Run Now is the only POST and is also Approve — it
  // triggers a paid subprocess invocation, never agent-callable.
  "GET /api/delegated-sync": RiskTier.Approve,
  "PATCH /api/delegated-sync/cadences/": RiskTier.Approve,
  "PATCH /api/delegated-sync/active-hours": RiskTier.Approve,
  "POST /api/delegated-sync/cadences/": RiskTier.Approve,

  // INTEGRATION-DRIFT-DETECTION-PLAN.md §6.0 — drift-detection chokepoint.
  // Autonomous: the agent's activity_scan delegated variant POSTs the
  // result of its connector fetch to compute a structural diff. Defense
  // layers (window-key allowlist + per-call audit row) live inside the
  // handler. Daemon-internal callers (CalendarPoller, DelegatedSyncWorker)
  // call the pure `reconcile()` function directly and bypass this route.
  "POST /api/integrations/{*}/reconcile": RiskTier.Autonomous,

  // DELEGATED-TASK-MODE-DESIGN.md §4.1 — Phase 1 task mode for known
  // integrations. Autonomous, parallel to `/api/integrations/{*}/invoke`
  // (RPC mode); the per-integration `deniedTools` plus `allowDestructive`
  // gate enforce the safety floor without bearer auth.
  "POST /api/integrations/{*}/exec": RiskTier.Autonomous,
  // DELEGATED-TASK-MODE-DESIGN.md §4.2 — Phase 2 generic task mode for
  // unregistered MCPs. Approve tier (Bearer required) per the design's
  // "wider blast radius than /exec" rationale: there is no registered
  // integration's `deniedTools` to act as a chokepoint, so trust moves
  // up to dashboard / operator invocation. Diverges from
  // `/api/integrations/{*}/invoke` (Autonomous) and
  // `/api/integrations/{*}/exec` (Autonomous), where the integration's
  // user-curated deny list is the safety floor.
  "POST /api/delegated/run": RiskTier.Approve,

  // ── Admin / dashboard surfaces ──
  // Routes below are Approve by intent, not by fallback. Pinning them
  // explicitly keeps `auditRiskClassifications` at zero so a future
  // regression surfaces as exactly one new line. None are agent-callable:
  // secrets / messaging-pairing / backend-config / dashboard polling are
  // all Bearer-gated UI or admin operations.

  // Snapshot restore — rollback via dashboard.
  "POST /api/context/restore-snapshot/": RiskTier.Approve,
  // Catch-all DELETE under /api/context. Retention sweeps for daily/
  // and weekly/ go through dedicated handlers, not this fallback.
  "DELETE /api/context/": RiskTier.Approve,

  // Secrets — never agent-callable. Single prefix per method covers
  // writes for every platform (slack/telegram/discord/notion/github/
  // google/{credentials,token}) and the DELETE-by-name path.
  "PUT /api/secrets/": RiskTier.Approve,
  "DELETE /api/secrets/": RiskTier.Approve,

  // Messaging admin — pairing flows, token tests, status. Dashboard
  // only; agents talk to messaging via internal channel adapters,
  // never this HTTP surface.
  "GET /api/messaging/": RiskTier.Approve,
  "POST /api/messaging/": RiskTier.Approve,

  // Backends config writes (defaults / advisor pin). The existing
  // `PUT /api/backends/main` exact entry above documents per-process
  // bindings; these two cover the remaining global writes.
  "PUT /api/backends/defaults": RiskTier.Approve,
  "PUT /api/backends/advisor": RiskTier.Approve,

  // Process-config — per-ProcessKey backend overrides, dashboard only.
  "GET /api/process-config": RiskTier.Approve,
  "PUT /api/process-config/": RiskTier.Approve,

  // ── Task-flow overrides (P5 git-lifecycle-and-triggers.md) ──
  // Dashboard-only writes that store free-form prompt prose under
  // <dataDir>/task-flows/<key>.md. Reads expose the bundled body too —
  // not a personal-data risk, but Approve-tier matches `/api/triggers`
  // (dashboard-driven) since the override changes how the agent
  // dispatches every matching event going forward.
  "/api/task-flows": RiskTier.Approve,

  // ── Git accounts (P5 multi-account remotes) ──
  // Approve tier on every method. PAT writes via PUT carry secrets in
  // the body; metadata edits change which credential a watched repo
  // resolves to. Probe is Approve too — it shells out to `gh api user`
  // which counts against the user's API quota.
  "/api/git-accounts": RiskTier.Approve,
  "POST /api/git-accounts/{*}/probe": RiskTier.Approve,

  // Dashboard polling — Bearer-gated UI surfaces.
  "GET /api/dashboard/next-check": RiskTier.Approve,
  // STAGE-C-DM-FRESHNESS-PLAN §Task 4 — DM-freshness aggregate served
  // to the dashboard's observability panel. Read-only roll-up of
  // agent_actions; same Bearer-gated tier as other dashboard reads.
  "GET /api/dashboard/dm-freshness": RiskTier.Approve,

  // Activity tab read-mirror (Memory → Activity). Dashboard-only — surfaces
  // the wider activity-source union used by the runner so the UI can flag
  // recently-stopped tasks whose `state/activity/<source>.md` is still on disk
  // for the 90-day window. Not agent-callable; same Approve tier as the
  // rest of the dashboard read surfaces.
  "GET /api/activity-sources": RiskTier.Approve,

  // Voice transcription opt-in surface (docs/design/appendices/voice-
  // transcription.md). Both endpoints are owner-only via the dashboard's
  // Settings → Advanced → Voice Mode card. Status is polled every 2s
  // while installing; install kicks off the model download, persists
  // `voiceTranscriptionEnabled=true`, and triggers a daemon self-restart
  // on success — same blast-radius shape as `/api/setup/*`.
  "GET /api/voice/status": RiskTier.Approve,
  "POST /api/voice/install": RiskTier.Approve,
  // Owner-only "delete the local Whisper weights" surface, used to
  // recover from a half-failed download. Same blast-radius shape as
  // install — touches files inside the daemon-owned models dir, no
  // external side effects, dashboard-gated.
  "DELETE /api/voice/model": RiskTier.Approve,

  // ── Management Registry & Entities (docs/design/21-management-registry-and-entities.md §13.1) ──
  // The agent registers / modifies / stops managed tasks via curl from
  // its session workdir; the Notify-tier intent in §13.1 maps onto the
  // current Autonomous + DM-confirmation pattern (the §13.1 "Notify"
  // label predates the abolition of a separate Notify tier — see
  // recurring-schedules' identical Autonomous classification at top of
  // this file). The destructive-confirmation invariant lives in the
  // skill prompts (DM before stop), not in HTTP risk tiers.
  //
  // Reads are Autonomous because the rendered file content is also
  // injected into the prompt via policy-files.ts wildcard ref — the
  // GET surface adds no new disclosure.
  "GET /api/managed-tasks": RiskTier.Autonomous,
  "POST /api/managed-tasks": RiskTier.Autonomous,
  "GET /api/managed-tasks/": RiskTier.Autonomous,
  "PATCH /api/managed-tasks/": RiskTier.Autonomous,
  "DELETE /api/managed-tasks/": RiskTier.Autonomous,
  "POST /api/managed-tasks/{*}/run-now": RiskTier.Autonomous,
  "POST /api/managed-tasks/{*}/rename-app": RiskTier.Autonomous,
  "PATCH /api/managed-tasks/{*}/run-result": RiskTier.Autonomous,
  // Aggregate audit feed for the dashboard's Settings → Management →
  // History tab. Browser-only — the agent's per-mt history reads through
  // `GET /api/managed-tasks/:id/runs` (Autonomous, scoped to one row);
  // this surface returns every `management_task.*` and `sot_binding.*`
  // row, which is the same disclosure shape as `/api/conversations` and
  // gets the same Approve tier so Bearer auth is required.
  "GET /api/management-history": RiskTier.Approve,

  "GET /api/sot-bindings": RiskTier.Autonomous,
  "GET /api/sot-bindings/": RiskTier.Autonomous,
  "PUT /api/sot-bindings": RiskTier.Autonomous,

  // Entity-mirror lookup contract (§7.6). Mirror rows surface only the
  // path/title/sources of L2 entity files — the same content the agent
  // would otherwise read via /api/context/* (already ReadSensitive). The
  // mirror returns whichever subset of frontmatter the watcher cached, so
  // we mark it ReadSensitive and require a token, matching /api/context.
  "GET /api/entities": RiskTier.ReadSensitive,
  "GET /api/entities/by-path": RiskTier.ReadSensitive,

  // ── Skill curation (P22 — appendix p22-skill-self-optimization.md) ──
  // Read endpoints are Autonomous — the optimizer agent is gated by
  // its own runToken, and the dashboard reads them with the standard
  // bearer auth. No PII flows through these routes; the payloads are
  // structural metadata about the agent's own skill files.
  "GET /api/skill-curation/skills": RiskTier.Autonomous,
  "GET /api/skill-curation/skills/": RiskTier.Autonomous,
  "GET /api/skill-curation/signals": RiskTier.Autonomous,
  "GET /api/skill-curation/knowledge-map": RiskTier.Autonomous,
  "GET /api/skill-curation/proposals/": RiskTier.Autonomous,
  // Run minting (`POST /runs`, exact) is Approve. In production this surface
  // is unused — the dispatcher's `materializeOptimizerWorkdir` mints the
  // runId/runToken directly and never crosses the HTTP boundary (see the
  // route handler comment). Leaving it Autonomous let any Bearer-less local
  // caller (incl. a prompt-injected DM agent) mint a valid optimizer token
  // once curation is opted in, then drive `/proposals` to self-author skill
  // overlays — a least-privilege violation. Approve confines minting to the
  // dashboard/operator; the legitimate optimizer reads its token from the
  // workdir preamble, not this route.
  "POST /api/skill-curation/runs": RiskTier.Approve,
  // The proposal chokepoint and the per-run finalize stay Autonomous — both
  // are gated by the optimizer's runToken (HMAC, scoped to a single run)
  // enforced inside the route, and the legitimate optimizer agent reaches
  // them via curl from its session workdir (no Bearer). Per design §2.1 the
  // chokepoint applies every passing proposal atomically; the only roll-back
  // path is the system-driven auto-revert (`auto-revert.ts`).
  "POST /api/skill-curation/proposals": RiskTier.Autonomous,
  "POST /api/skill-curation/runs/": RiskTier.Autonomous,
  // P22 §6.1 — settings + listing surfaces consumed by the dashboard.
  // GETs are Autonomous (no PII; framework metadata only). PATCH writes the
  // operator's curation config to runtime_state and re-derives cron — Approve.
  "GET /api/settings/skill-curation": RiskTier.Autonomous,
  "PATCH /api/settings/skill-curation": RiskTier.Approve,
  "GET /api/skill-curation/proposals": RiskTier.Autonomous,
  "GET /api/skill-curation/runs": RiskTier.Autonomous,
  // P22 §6.4 — owner-only "Run optimization now" button. Approve tier so
  // a stolen agent token (e.g. the optimizer's own runToken) cannot bypass
  // the cadence gate by forging a manual run. Dashboard auth fires from
  // the bearer token, not the runToken.
  "POST /api/skill-curation/runs/manual": RiskTier.Approve,
  // §5.4 orphan-overlay surface — read is Autonomous, discard is Approve
  // because it deletes a previously-applied overlay file from disk.
  "GET /api/skill-curation/orphans": RiskTier.Autonomous,
  "POST /api/skill-curation/orphans/discard": RiskTier.Approve,

};

/**
 * Find an *explicit* risk classification for a (method, path), without
 * falling back to the default-Approve / default-Autonomous tiers.
 *
 * Returns the matched tier when an entry in `API_RISK` covers the route
 * (via exact, path-only, pattern, or prefix match) and `null` when the
 * route would only be served by the conservative default.
 *
 * Used by both `classifyRisk` (which adds the default fallback) and
 * `auditRiskClassifications` (which surfaces unclassified routes at boot).
 *
 * Lookup order:
 * 1. Exact match: "METHOD /path" (e.g., "POST /api/calendar/events")
 * 2. Path-only match: "/path" (e.g., "/api/health")
 * 3. Pattern match: keys containing `{*}` placeholder — longest literal
 *    prefix wins ties (multi-account routes like
 *    `POST /api/mail/{*}/messages/send`)
 * 4. Prefix match: longest matching `path.startsWith(...)` key
 */
export function findExplicitRiskClassification(
  method: string,
  path: string,
): RiskTier | null {
  // 1. Exact match with method
  const methodKey = `${method} ${path}`;
  if (methodKey in API_RISK) return API_RISK[methodKey];

  // 2. Path-only match
  if (path in API_RISK) return API_RISK[path];

  // 3. Pattern match — `{*}` placeholder matches a single non-empty path
  //    segment. Longer literal prefix wins ties.
  const patternCandidates = Object.entries(API_RISK)
    .filter(([key]) => key.includes("{*}"))
    .filter(([key]) => {
      // Every API_RISK key is `METHOD path`; the space-less fallback is defensive.
      /* c8 ignore start */
      const keyPath = key.includes(" ") ? key.split(" ")[1] : key;
      const keyMethod = key.includes(" ") ? key.split(" ")[0] : null;
      /* c8 ignore stop */
      if (keyMethod && keyMethod !== method) return false;
      return matchesPattern(keyPath, path);
    })
    .sort((a, b) => literalPrefixLength(b[0]) - literalPrefixLength(a[0]));
  if (patternCandidates.length > 0) return patternCandidates[0][1];

  // 4. Prefix match (longest first)
  const candidates = Object.entries(API_RISK)
    .filter(([key]) => !key.includes("{*}"))
    .filter(([key]) => {
      // Every API_RISK key is `METHOD path`; the space-less fallback is defensive.
      /* c8 ignore start */
      const keyPath = key.includes(" ") ? key.split(" ")[1] : key;
      const keyMethod = key.includes(" ") ? key.split(" ")[0] : null;
      /* c8 ignore stop */
      if (keyMethod && keyMethod !== method) return false;
      return pathPrefixMatches(keyPath, path);
    })
    // Rank by matched path-prefix length so the most-specific prefix wins.
    // Must compare the path segment, NOT the raw key: the `"METHOD "` token
    // would otherwise lift a shorter, less-specific method-keyed prefix
    // (e.g. `DELETE /api/git`) above a longer path-only one (`/api/github`),
    // silently downgrading the tier. Mirrors the step-3 pattern tiebreaker.
    .sort((a, b) => keyPathOf(b[0]).length - keyPathOf(a[0]).length);

  if (candidates.length > 0) return candidates[0][1];

  return null;
}

/**
 * Classify the risk tier of an API request.
 *
 * Wraps `findExplicitRiskClassification` with the conservative default:
 * unknown /api/* routes → Approve (fail-closed); other paths → Autonomous.
 */
export function classifyRisk(method: string, path: string): RiskTier {
  const explicit = findExplicitRiskClassification(method, path);
  if (explicit !== null) return explicit;

  // Unknown daemon API routes must fail closed so newly-added browser-facing
  // endpoints do not become anonymously reachable just because API_RISK was
  // not updated yet.
  if (path.startsWith("/api/")) {
    logger.warn(
      { method, path },
      "No risk classification found for /api route, defaulting to Approve",
    );
    return RiskTier.Approve;
  }

  logger.debug({ method, path }, "No risk classification found, defaulting to Autonomous");
  return RiskTier.Autonomous;
}

/**
 * Boot-time audit: given the registered Hono routes, return the subset
 * that would only be served by the default-Approve fallback.
 *
 * Why this exists: `API_RISK` is hand-maintained. When a developer adds
 * a new route in `routes/*.ts` but forgets to update the classifier
 * table, the request hits the runtime warning only after the first call
 * — and then 401s because Approve-tier requires a Bearer the agent can't
 * supply, producing a user-visible retry spiral. The boot audit catches
 * the omission before any traffic flows.
 *
 * Hono parameterized segments (`/integrations/:key/exec`) are
 * normalized to a representative literal so `{*}`-pattern entries in
 * `API_RISK` match them. Routes that don't start with `/api/` are
 * skipped (default-Autonomous is intentional there — webhooks, root).
 */
export interface AuditableRoute {
  method: string;
  path: string;
}

export function auditRiskClassifications(
  routes: ReadonlyArray<AuditableRoute>,
): AuditableRoute[] {
  const seen = new Set<string>();
  const unclassified: AuditableRoute[] = [];

  for (const route of routes) {
    const method = route.method.toUpperCase();
    // Hono represents catch-all middleware with method "ALL" or "*" — those
    // are never agent-callable endpoints and don't need a classification.
    if (method === "ALL" || method === "OPTIONS" || method === "HEAD") continue;
    if (!route.path.startsWith("/api/") && route.path !== "/api") continue;

    const dedupKey = `${method} ${route.path}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Substitute Hono `:param` segments with a representative literal so
    // `{*}`-patterned entries in API_RISK match. The matcher's `{*}`
    // accepts any single non-empty segment, so the substitute value is
    // arbitrary — `_` keeps audit log lines readable.
    const normalizedPath = route.path.replace(/:[^/]+/g, "_");
    if (findExplicitRiskClassification(method, normalizedPath) === null) {
      unclassified.push({ method, path: route.path });
    }
  }

  return unclassified;
}

/** Turn a key path with `{*}` placeholders into a segment regex matcher.
 *  Each `{*}` matches a single non-empty URL segment (no `/`). Remaining
 *  trailing path after the last literal segment is allowed — this keeps
 *  prefix-style keys working, e.g. `/api/mail/{*}/messages/` matches both
 *  `.../messages/abc` and `.../messages/abc/trash`. */
function matchesPattern(keyPath: string, actualPath: string): boolean {
  const segments = keyPath.split("/");
  const actualSegments = actualPath.split("/");
  if (actualSegments.length < segments.length) return false;
  // Compare segment-by-segment; `{*}` accepts any single non-empty segment.
  // Trailing segments in `actualPath` beyond the key length are treated as
  // a prefix match (keeps `endsWith:"/"` style keys matching).
  const endsWithSlash = keyPath.endsWith("/");
  const compareLen = endsWithSlash ? segments.length - 1 : segments.length;
  if (!endsWithSlash && actualSegments.length !== segments.length) return false;
  for (let i = 0; i < compareLen; i++) {
    const s = segments[i];
    if (s === "{*}") {
      if (!actualSegments[i] || actualSegments[i].length === 0) return false;
      continue;
    }
    if (s !== actualSegments[i]) return false;
  }
  return true;
}

/** Extract the path portion of an `API_RISK` key: `"METHOD /path"` → `/path`,
 *  or a bare `"/path"` path-only key unchanged. Ranking must compare the path
 *  segment alone — the leading `"METHOD "` token (3–6 chars) would otherwise
 *  inflate a shorter, less-specific method-keyed prefix above a longer
 *  path-only one. */
export function keyPathOf(key: string): string {
  return key.includes(" ") ? key.split(" ")[1] : key;
}

/** Segment-aware prefix test for step-4 (non-`{*}`) keys. A raw
 *  `path.startsWith(keyPath)` matches a *string* prefix, so `/api/git`
 *  would spuriously match the unrelated sibling `/api/git-accounts` (and,
 *  worse, an unclassified future `/api/git-webhook` — silently inheriting
 *  the sibling's tier instead of failing closed to Approve). A key that
 *  ends in `/` is an explicit subtree catch-all, so a raw `startsWith` is
 *  already the boundary; otherwise the match must be a strict
 *  `/`-delimited descendant. Exact `path === keyPath` is pre-empted by the
 *  step-1/step-2 exact lookups, so step 4 only ever matches descendants.
 *  Mirrors the segment discipline of `matchesPattern` (step 3). */
function pathPrefixMatches(keyPath: string, path: string): boolean {
  if (keyPath.endsWith("/")) return path.startsWith(keyPath);
  return path.startsWith(keyPath + "/");
}

/** Count characters of the path prefix before the first `{*}` (or the whole
 *  path length if none) — used to rank pattern candidates by specificity.
 *  Defensive against future overlapping `{*}` keys: today no two `{*}` entries
 *  in `API_RISK` match the same `(method, path)` pair, so the sort comparator
 *  never invokes this helper. The function exists so the first overlapping
 *  pair added picks the more specific entry instead of relying on iteration
 *  order. */
/* c8 ignore start */
function literalPrefixLength(key: string): number {
  const keyPath = keyPathOf(key);
  const idx = keyPath.indexOf("{*}");
  return idx < 0 ? keyPath.length : idx;
}
/* c8 ignore stop */

/** Strip a trailing `{*}` placeholder from `path` so callers can
 *  substring-match user skill bodies against the literal prefix. No
 *  ReadSensitive entry carries `{*}` today (only the Autonomous /
 *  Approve ones do), so the truthy branch is currently unreachable;
 *  preserved for future paths and parked out of the coverage gate. */
/* c8 ignore start */
function stripWildcardSuffix(path: string): string {
  return path.includes("{*}")
    ? path.slice(0, path.indexOf("{*}")).replace(/\/+$/, "")
    : path;
}
/* c8 ignore stop */

/**
 * Return every `/api/*` path that `API_RISK` classifies as
 * `RiskTier.ReadSensitive` for GET requests, with `{*}` placeholders
 * stripped to the literal prefix segment. Used by the drift-guard test
 * in `skills-compiler.test.ts` to assert
 * `READ_SENSITIVE_API_PREFIXES` covers every read-sensitive GET
 * surface — so a new endpoint added to `API_RISK` cannot silently
 * regress the Codex banner emission contract
 * (docs/design/appendices/skills-unification.md Phase 1 §"Codex read-sensitive banner
 * inheritance").
 *
 * Returns sorted unique strings; trailing `/` is preserved as it appears
 * in `API_RISK` so the caller can distinguish prefix-style keys from
 * exact paths.
 */
export function listReadSensitiveGetPathKeys(): readonly string[] {
  const out = new Set<string>();
  for (const [key, tier] of Object.entries(API_RISK)) {
    if (tier !== RiskTier.ReadSensitive) continue;
    // Every ReadSensitive entry in `API_RISK` today carries an explicit
    // "METHOD /api/path" prefix, so the methodless / non-/api/ branches
    // are defensive and currently unreachable.
    const hasMethod = key.includes(" ");
    const method = hasMethod ? key.split(" ")[0] : /* c8 ignore next */ "GET";
    const path = hasMethod ? key.split(" ")[1] : /* c8 ignore next */ key;
    if (method !== "GET") /* c8 ignore next */ continue;
    if (!path.startsWith("/api/")) /* c8 ignore next */ continue;
    // Strip `{*}` placeholders to the literal prefix so callers can
    // substring-match user skill bodies against it.
    const literalPrefix = stripWildcardSuffix(path);
    out.add(literalPrefix);
  }
  return [...out].sort();
}

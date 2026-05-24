/**
 * Activity → docs concept link map (DOCS_QA_DESIGN.md §8.4).
 *
 * `agent_actions.action_type` is set to `event.type` (see `recordAgentAction`
 * in `daemon/src/safety/audit.ts`), NOT to the ProcessKey resolved later
 * in routing. That means several keys that look like obvious entries here
 * are actually purely-routing concepts and never appear in the column:
 *
 *   - `message.dm` / `message.mention` / `dashboard.chat` — every owner
 *     message is emitted as `event.type === "message.received"`; the DM /
 *     mention / dashboard-chat distinction is computed by `resolveProcessKey`
 *     for routing only and never persisted. The single
 *     `"message.received" → features/messaging/overview` entry below covers
 *     all four UI surfaces.
 *
 * The map below is therefore keyed by event-type strings only. Entries are
 * grouped:
 *   - "Currently emitted" — verified emission paths in the daemon.
 *   - "Reserved (defensive)" — known-future or rarely-fired ProcessKeys
 *     that the daemon may eventually emit as `event.type` (e.g. when the
 *     docs QA pipeline finally enqueues `dashboard.docs_qa` events). Safe
 *     to keep — `docIdForEventType` simply never returns them today.
 *
 * Iteration: exact-match check first, then prefix rules. The prefix rules
 * cover the dynamic families:
 *   - `routine.custom.<slug>` → custom routines doc
 *   - `setup.*`               → setup wizard walkthrough (defensive —
 *     `setup.initial`/`setup.update` are prompt keys today, but the family
 *     is reserved as a future event-type namespace)
 *   - `calendar.*`            → calendar integration
 *   - `git.*`                 → git integration
 *
 * A null result means "no doc to link" — callers must hide the affordance
 * rather than render a dead link. Several real action_types intentionally
 * resolve to null because they have no operator-facing meaning:
 * `attachment.upload.{inbound,outbound}`, `delegated_proxy.invoke`
 * (RESERVED — RPC route is commented; see integrations.ts route notes),
 * `delegated_task.exec` (the active task-mode header row — internal
 * subprocess accounting, no operator UI), `blocked_absolute`,
 * `qa_invalid_citation`.
 */

const EXACT: Record<string, string> = {
  // ── Currently emitted ───────────────────────────────────────────────
  // Routines
  "routine.morning_routine": "features/routines/morning-routine",
  "routine.evening_review": "features/routines/evening-review",
  "routine.weekly_review": "features/routines/weekly-review",
  // `routine.monthly_review` intentionally has no doc mapping while the
  // routine is gated off-by-default (see runtime-settings.ts:
  // monthlyReviewEnabled). The previous mapping pointed at
  // `features/routines/monthly-review` which was removed during the
  // doc cleanup. When the Mirror+Prune redesign re-enables monthly,
  // re-introduce the doc and restore the mapping.
  "routine.hourly_check": "features/routines/hourly-check",
  "routine.roadmap_refresh": "features/memory-files/roadmap",
  "routine.today_refresh": "features/memory-files/today",
  "routine.user_profile_sweep": "features/memory-files/user-profile",

  // Messaging — every owner message lands here regardless of DM/mention/
  // dashboard-chat routing distinction (see file-header note).
  "message.received": "features/messaging/overview",

  // Schedule
  "scheduled.task": "features/memory-files/schedule",
  "schedule.approaching": "features/operations/schedule-approaching",

  // ── Reserved (defensive) ────────────────────────────────────────────
  // `routine.morning_routine_initial` was retired by
  // `docs/design/appendices/morning-routine-optimization.md`. The mapping
  // is kept as a defensive entry so historical `agent_actions` rows still
  // resolve to the morning-routine doc.
  "routine.morning_routine_initial": "features/routines/morning-routine",
  // Stage A (today) and Stage B (journal) both surface under the
  // morning-routine doc.
  "routine.morning_routine_today": "features/routines/morning-routine",
  "routine.morning_routine_journal": "features/routines/morning-routine",

  // The docs-QA dispatcher path is not yet wired (see DOCS_QA_BACKEND
  // §6 — `docs.ts` has no `/qa/messages` enqueue endpoint today). When
  // it lands, QA turns will likely audit as `dashboard.docs_qa`.
  "dashboard.docs_qa": "features/operations/activity-and-conversations",

  // Gmail classifier is currently invoked outside the AuditLogger path,
  // but `process_backend_config` reserves `gmail_classify` as a ProcessKey
  // and the classifier may be migrated to `agent_actions` later.
  gmail_classify: "features/integrations/mail",
};

interface PrefixRule {
  prefix: string;
  docId: string;
}

const PREFIX: ReadonlyArray<PrefixRule> = [
  { prefix: "routine.custom.", docId: "features/routines/custom-routines" },
  { prefix: "setup.", docId: "guides/setup-wizard" },
  { prefix: "calendar.", docId: "features/integrations/calendar" },
  { prefix: "git.", docId: "features/integrations/git" },
];

/**
 * Resolve a docs slug for an event type. Returns `null` when the event
 * type has no operator-facing doc — callers should hide the link.
 */
export function docIdForEventType(eventType: string): string | null {
  const exact = EXACT[eventType];
  if (exact) return exact;
  for (const rule of PREFIX) {
    if (eventType.startsWith(rule.prefix)) return rule.docId;
  }
  return null;
}

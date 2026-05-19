/**
 * SETUP-FLOW-REDESIGN-PLAN §6.5 — flow controller for the redesigned
 * setup wizard. The list collapses from 13 steps to 7 collection steps
 * + a terminal `complete`:
 *
 *   1. Basics            (display name + language)            — required
 *   2. Vault             (mode + primary path inline)         — required
 *   3. AI Backend        (main backend selection)             — required
 *   4. Mail              (Gmail + Outlook + IMAP)             — skippable
 *   5. Calendar          (Google + Outlook)                   — skippable
 *   6. Note              (Notion + external Obsidian vault)   — skippable
 *   7. Messaging         (Slack/Telegram/Discord/WhatsApp)    — skippable
 *   8. Customize Rules   (chat-driven; no tools form)         — required
 *   9. Complete                                                — terminal
 *
 * Repositories are not registered during setup — users add them
 * post-setup from Settings → Connections → Repositories. Conditional
 * sub-steps are gone: every former mode-then-credentials pair is now
 * inline inside the parent step, so `filterInitialSteps` collapses to
 * identity. The wizard list returned matches the `BASE_INITIAL_STEPS`
 * order; `app/setup/page.tsx` switches on the id to mount the right
 * component.
 */

export type SetupStep =
  | "basics"
  | "vault"
  | "backend"
  | "mail"
  | "calendar"
  | "note"
  | "messaging"
  | "rules"
  | "complete";

export const BASE_INITIAL_STEPS: readonly SetupStep[] = [
  "basics",
  "vault",
  "backend",
  "mail",
  "calendar",
  "note",
  "messaging",
  "rules",
  "complete",
];

/**
 * The required steps — the wizard cannot finish without each of these
 * having been visited at least once. (`complete` is the terminal screen
 * and is included in the set so the type system can read it as
 * required-by-existence.) Skip buttons are hidden on these steps; every
 * other step exposes Skip.
 */
export const REQUIRED_STEPS: ReadonlySet<SetupStep> = new Set<SetupStep>([
  "basics",
  "vault",
  "backend",
  "rules",
  "complete",
]);

/**
 * Human-readable labels for the stepper. Single source of truth so the
 * page header and the per-step `WizardStepFrame` titles cannot drift.
 */
export const STEP_LABELS: Record<SetupStep, string> = {
  basics: "Basics",
  vault: "Vault",
  backend: "AI Backend",
  mail: "Mail",
  calendar: "Calendar",
  note: "Notes",
  messaging: "Messaging",
  rules: "Rules",
  complete: "Done",
};

/**
 * Derived vault mode for the wizard. `modeOverride` is non-null only
 * when the user explicitly toggled the choice in VaultStep; in that
 * case their click wins over whatever the daemon currently has
 * persisted. Otherwise we mirror `config.vaultMode`, defaulting to
 * "plain" when config is still loading (so the initial render does
 * not flicker the inline path field in and out).
 */
export function deriveVaultMode(
  modeOverride: "plain" | "obsidian" | null,
  configVaultMode: "plain" | "obsidian" | null | undefined,
): "plain" | "obsidian" {
  if (modeOverride !== null) return modeOverride;
  return configVaultMode === "obsidian" ? "obsidian" : "plain";
}

/**
 * Identity in v1 — every former conditional sub-step (`google`,
 * `obsidian`, `notion`) is now an inline disclosure in its parent
 * step, so the list never shrinks from `BASE_INITIAL_STEPS`.
 *
 * Kept as a separate function so `app/setup/page.tsx` doesn't need a
 * conditional import path during the redesign cutover, and so future
 * conditional gating (e.g. enterprise-only steps) has an obvious home.
 */
export function filterInitialSteps(
  baseSteps: readonly SetupStep[] = BASE_INITIAL_STEPS,
): SetupStep[] {
  return [...baseSteps];
}

/** True for steps the Skip button should render. */
export function isSkippable(step: SetupStep): boolean {
  return !REQUIRED_STEPS.has(step);
}

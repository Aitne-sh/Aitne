/**
 * Pure logic helpers for BackendCard. Kept separate so render-free
 * assertions (install-vs-verify visibility, continue gating, hint copy)
 * stay unit-testable without pulling React or the query client.
 */

import type { BackendId } from "@aitne/shared";

/**
 * Product constant — "Recommended" pill anchor. Claude is the recommended
 * main for new users because the Agent SDK's advisor tool only works
 * server-side on Claude. Kept here (not in server-provided metadata)
 * because "what we recommend" is a product-UX decision, not a daemon
 * policy — changing it should not require a daemon release.
 */
export const RECOMMENDED_BACKEND: BackendId = "claude";

export function isRecommended(backendId: BackendId): boolean {
  return backendId === RECOMMENDED_BACKEND;
}

/**
 * Whether the BackendCard should show the inline CLI install panel
 * (true = CLI missing and we should surface the installer). The CLI
 * install panel also shows its own done state; we hide it entirely when
 * the CLI is present so we don't flash "detecting install methods…"
 * every time the backend card mounts.
 */
export function shouldShowCliInstall(cliInstalled: boolean): boolean {
  return !cliInstalled;
}

/**
 * Whether the "Verify install" button should be reachable. The button
 * stays mounted-and-disabled while another card mutation is in flight
 * (busy), but it's allowed even when the CLI isn't on PATH — the
 * server-side handler returns a clean "not installed" diagnostic, which
 * is more useful to the user than a greyed-out button with no feedback.
 */
export function shouldEnableVerifyInstall(busy: boolean): boolean {
  return !busy;
}

/**
 * Whether the wizard's "Configure later" one-liner should be rendered
 * on this card. Shown only in wizard mode, only on non-main cards where
 * the CLI is not yet installed. Auth verification was removed as a
 * setup-flow gate — install presence (verify-install) is now the only
 * signal we use here.
 */
export function shouldShowWizardConfigureLaterHint(opts: {
  mode: "wizard" | "settings";
  isMain: boolean;
  cliInstalled: boolean;
}): boolean {
  if (opts.mode !== "wizard") return false;
  if (opts.isMain) return false;
  return !opts.cliInstalled;
}

/**
 * True when the wizard's Continue button should be enabled. The only
 * hard requirement is that the operator has picked a main backend —
 * CLI install, auth verify, and API-key registration are all
 * skippable. Skipping is a deliberate product choice: the user can
 * complete the rest from /settings/models on their own time, and any
 * verify-install state already saved is persisted server-side via
 * `useBackends()`. Non-main backends were already exempt from gating.
 */
export function isContinueEligible(opts: {
  mainBackend: BackendId | null;
}): boolean {
  return opts.mainBackend !== null;
}

/**
 * Derive whether the Allow-mode badge should show for this card's
 * backend. Caller passes the per-backend permission mode string from
 * `useConfig()` so the card itself stays a pure render — this helper
 * accepts any string (not just the typed `ExecutionPermissionMode`
 * union) because config values arrive as `Record<string, unknown>`
 * until the React 19 typed slice lands.
 */
export function isAllowModeActive(
  permissionMode: string | null | undefined,
): boolean {
  return permissionMode === "allow";
}

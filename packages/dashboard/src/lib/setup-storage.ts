"use client";

/**
 * Wizard state persistence for `/setup`. Without this, a page reload mid-
 * setup drops the user back to `welcome` (initial mode) and a re-entry to
 * the conversation step calls `/setup/start` again, restarting the agent
 * conversation from scratch and forcing the user to redo every answer.
 *
 * Daemon-side: a startup sweep in `index.ts` closes any leftover active
 * `dashboard_chat` sessions, so a stored `setupSessionId` whose row was
 * orphaned by a daemon restart will fail the active-status check and the
 * conversation step falls through to a fresh start.
 *
 * Storage is `sessionStorage` so the state lives for the duration of the
 * tab — closing the tab discards it, which matches the user's mental
 * model of "I left setup half-done in this tab."
 */

import type { IntegrationKey, IntegrationMode } from "@aitne/shared";
import type { SetupStep } from "@/components/setup/wizard-steps.logic";

const STORAGE_KEY = "pa-setup-wizard-state";

export interface PersistedWizardState {
  step?: SetupStep;
  agentDisplayName?: string;
  modeOverride?: "plain" | "obsidian" | null;
  /**
   * SETUP-FLOW-REDESIGN-PLAN §5.2 — the user's chosen primary-vault path,
   * persisted but NOT yet committed to the daemon. The actual
   * `/setup/migrate-context` call runs on entry to the Customize Rules
   * step (see `conversation-step.tsx`); deferring file creation lets the
   * user freely Back-navigate and re-pick the same directory without
   * the picker showing it as already populated.
   */
  pendingVaultPath?: string | null;
  integrationModeDraft?: Partial<Record<IntegrationKey, IntegrationMode>>;
  /**
   * Per-radio optionId pick for the Google-mode step (e.g.
   * `delegated:codex`, `direct`, `disabled`). Without this, a remount of
   * `GoogleModeStep` (Back navigation, reload while on the step) would
   * re-seed `defaultOptionId` and propagate the default through
   * `onDraftChange`, overwriting any prior user pick — and a subsequent
   * Continue would PATCH the daemon back to that default.
   */
  googleModeSelections?: Partial<Record<IntegrationKey, string>>;
  /** Same protection for the Notion single-radio step. */
  notionModeSelection?: string;
  /**
   * SETUP-FLOW-REDESIGN-PLAN §5.8 — the legacy `phase` / `selections`
   * fields are gone (Phase 1 tool selections were deleted). Kept as
   * loose-typed leftovers in this interface so a stale sessionStorage
   * entry from before the redesign deserializes cleanly via the
   * `readWizardState` JSON.parse path; new writers never set them.
   */
  phase?: "selections" | "conversation";
  selections?: {
    schedule: string | null;
    tasks: string | null;
    notes: string | null;
    projects: string | null;
  };
  /** DB id of the in-flight setup conversation. Written when /setup/start
   *  resolves; checked on remount to decide between resume and fresh start. */
  setupSessionId?: number;
  /** Mode the persisted `setupSessionId` was created under. Resume must
   *  reject a session id from a different mode (e.g. an initial-mode id
   *  left in storage when the user later opens `?mode=update`) — a match
   *  there would skip the fresh `/setup/start` the update flow needs. */
  setupSessionMode?: "initial" | "update";
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function readWizardState(): PersistedWizardState {
  if (!isBrowser()) return {};
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as PersistedWizardState;
  } catch {
    return {};
  }
}

export function writeWizardState(patch: PersistedWizardState): void {
  if (!isBrowser()) return;
  try {
    const current = readWizardState();
    const merged = { ...current, ...patch };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* quota exceeded or sessionStorage disabled — ignore */
  }
}

export function clearWizardState(): void {
  if (!isBrowser()) return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

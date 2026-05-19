"use client";

/**
 * Preference store for the Docs Q&A panel's model picker.
 *
 * Lives in localStorage rather than the React Query qa-cache because
 * the picker is a long-lived **preference** (outlives a single tab
 * session), not transcript state. Independent storage key so the qa
 * cache reset paths (sessionStorage sessionId rotation, transcript
 * clear) cannot accidentally drop the operator's model choice.
 *
 * Returns `null` when nothing is persisted. The panel substitutes the
 * binding endpoint's `defaultModelId` (registry-derived cheapest light
 * model) so the dashboard never hardcodes a Claude/Codex/Gemini model
 * id — bumping the registry cascades to the picker default.
 */

const STORAGE_KEY = "pa.docs.qa-panel.modelId";

export function loadPreferredQAModel(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function savePreferredQAModel(modelId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, modelId);
  } catch {
    /* quota exceeded — ignore, the in-memory state still wins */
  }
}

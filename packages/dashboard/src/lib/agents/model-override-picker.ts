import type { BackendId } from "@aitne/shared";
import {
  decodeSelection,
  encodeSelection,
  type PickerGroup,
} from "@/components/chat/chat-model-picker.logic";
import type { OverrideValues } from "./builtin-override";

/**
 * Pure logic for the built-in Agent Definition tab's Model dropdown. The
 * dropdown reuses the chat picker's `buildPickerGroups` (enabled backends ×
 * registered models, auth-blocked groups disabled) and stores its selection
 * as the `backend.model` + `backend.backend_id` override pair. This module
 * maps between that pair and the `<select>` value so the component stays a
 * dumb renderer (dashboard testing convention: logic in pure .ts, no jsdom).
 */

/** `<select>` value for "no model pin — use the tier default". */
export const MODEL_DEFAULT_VALUE = "";

export interface ModelOverrideSelectState {
  /** Current `<select>` value (encoded `backend::model`, legacy value, or ""). */
  value: string;
  /**
   * Synthetic option to render when the stored pin is not in the live
   * catalog (hand-typed before the dropdown existed, or its backend is now
   * disabled). Keeps the stored value visible instead of silently showing
   * "(tier default)" while a pin is still active.
   */
  legacyOption: { value: string; label: string } | null;
}

const LEGACY_PREFIX = "legacy-model-pin:";

/** Derive the dropdown state from the current override values + catalog. */
export function modelOverrideSelectState(
  values: OverrideValues,
  groups: ReadonlyArray<PickerGroup>,
): ModelOverrideSelectState {
  const model = values["backend.model"];
  if (typeof model !== "string" || model.length === 0) {
    return { value: MODEL_DEFAULT_VALUE, legacyOption: null };
  }
  const storedBackend = values["backend.backend_id"];
  const backendId =
    typeof storedBackend === "string" && storedBackend.length > 0
      ? (storedBackend as BackendId)
      : (groups.find((g) => g.models.some((m) => m.modelId === model))?.backendId ?? null);
  if (backendId !== null) {
    const group = groups.find((g) => g.backendId === backendId);
    if (group?.models.some((m) => m.modelId === model)) {
      return {
        value: encodeSelection({ backendId, modelId: model }),
        legacyOption: null,
      };
    }
  }
  const value = `${LEGACY_PREFIX}${model}`;
  return {
    value,
    legacyOption: {
      value,
      label: `${model} (saved pin — not in the current catalog)`,
    },
  };
}

/**
 * Map a `<select>` change back onto the override pair. Returns the new
 * `backend.model` / `backend.backend_id` values, or `null` for a no-op (the
 * synthetic legacy option re-selected).
 */
export function modelOverrideFromSelection(
  value: string,
): { model: string | null; backendId: string | null } | null {
  if (value === MODEL_DEFAULT_VALUE) return { model: null, backendId: null };
  if (value.startsWith(LEGACY_PREFIX)) return null;
  const decoded = decodeSelection(value);
  if (!decoded) return null;
  return { model: decoded.modelId, backendId: decoded.backendId };
}

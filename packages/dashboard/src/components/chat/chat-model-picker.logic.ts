import type { BackendId, BackendModel } from "@aitne/shared";
import type { BackendStatusRow } from "../../lib/api-types";
import { getBackendShortLabel } from "../../lib/backend-ui";

/**
 * Pure logic layer for ChatModelPicker. Split out from the React component
 * so we can vitest it without @testing-library (not currently a dashboard
 * dep). The picker component is a thin shell over these helpers.
 */

export type ChatModelOverride = {
  backendId: BackendId;
  modelId: string;
} | null;

export type Selection = NonNullable<ChatModelOverride>;

export const AUTO_VALUE = "__auto__";
export const SEPARATOR = "::";

/**
 * `authStatus` values that mean "this backend definitely cannot serve a
 * request right now". `recovering` and `unknown` are omitted on purpose —
 * recovering is an in-progress auth flow that may resolve before the next
 * turn fires, and unknown is the pre-first-check state.
 */
export const AUTH_BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "expired",
  "missing",
]);

export interface PickerGroup {
  backendId: BackendId;
  label: string;
  authBlocked: boolean;
  authStatus: string;
  models: BackendModel[];
}

export function encodeSelection(sel: Selection): string {
  return `${sel.backendId}${SEPARATOR}${sel.modelId}`;
}

export function decodeSelection(value: string): Selection | null {
  if (value === AUTO_VALUE) return null;
  const idx = value.indexOf(SEPARATOR);
  if (idx < 0) return null;
  return {
    backendId: value.slice(0, idx) as BackendId,
    modelId: value.slice(idx + SEPARATOR.length),
  };
}

/**
 * Flatten enabled backends × their models for the dropdown.
 *
 *  - Keep only backends where `enabled && models.length > 0`; otherwise
 *    the group would render as an empty label.
 *  - Auth-blocked backends stay in the list so the user sees WHY they
 *    can't pick them; the picker UI renders their items disabled.
 *  - Models sort heavy-first, deprecated-last, then alphabetical —
 *    capable current models sit at the top of each group.
 */
export function buildPickerGroups(
  backends: ReadonlyArray<BackendStatusRow>,
): PickerGroup[] {
  return backends
    .filter((b) => b.enabled && b.models.length > 0)
    .map((b) => ({
      backendId: b.id,
      label: getBackendShortLabel(b.id),
      authBlocked: AUTH_BLOCKED_STATUSES.has(b.authStatus),
      authStatus: b.authStatus,
      models: [...b.models].sort((a, c) => {
        if (a.tier !== c.tier) return a.tier === "high" ? -1 : 1;
        const aDep = a.deprecated === true ? 1 : 0;
        const cDep = c.deprecated === true ? 1 : 0;
        if (aDep !== cDep) return aDep - cDep;
        return a.label.localeCompare(c.label);
      }),
    }));
}

/**
 * Whether a non-blocking "heavy tier" cost hint should be shown for the
 * current selection. Triggered for every heavy-tier pick — heavy models
 * are not the recommended default and rack up cost & rate-limit risk
 * faster than the light tier. Returns null when no hint applies.
 */
export function heavyTierHint(
  value: ChatModelOverride,
  groups: ReadonlyArray<PickerGroup>,
): { backendId: BackendId; modelLabel: string } | null {
  if (!value) return null;
  const group = groups.find((g) => g.backendId === value.backendId);
  const model = group?.models.find((m) => m.modelId === value.modelId);
  if (!model || model.tier !== "high") return null;
  return { backendId: value.backendId, modelLabel: model.label };
}

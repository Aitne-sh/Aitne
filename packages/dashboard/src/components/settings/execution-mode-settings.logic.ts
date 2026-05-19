import { getBackendIds, type ExecutionPermissionMode } from "@aitne/shared";
import {
  EMPTY_OVERRIDES,
  internalToUi,
  type ExecutionModeUi,
  type PerBackendOverrides,
} from "@/components/settings/execution-mode.logic";

/**
 * Pure helpers for `ExecutionModeSettings`
 * (EXECUTION-MODE-DESIGN.md §5.2). Extracted from the component so the
 * "seed from config" branches — especially the divergent-mixed-state
 * seed the accordion relies on — are unit-testable.
 */

export interface ConfigModeSlice {
  claudeExecutionPermissionMode: ExecutionPermissionMode;
  codexExecutionPermissionMode: ExecutionPermissionMode;
  geminiExecutionPermissionMode: ExecutionPermissionMode;
  opencodeExecutionPermissionMode: ExecutionPermissionMode;
}

/**
 * Return the top-level pick for the Safe / Allow card. `null` means
 * "the backends disagree in the persisted config, so there is no
 * unified top-level value to highlight." Caller should force-open the
 * advanced accordion in that case so the user sees the divergence.
 */
export function deriveTopFromConfig(
  config: ConfigModeSlice,
): ExecutionModeUi | null {
  const modes = getBackendIds().map((backend) =>
    internalToUi(config[`${backend}ExecutionPermissionMode`]),
  );
  const first = modes[0] ?? "safe";
  return modes.every((mode) => mode === first) ? first : null;
}

/**
 * Return the per-backend overrides to seed when the user opens the card.
 * On a unified config (deriveTopFromConfig returns non-null) no overrides
 * are needed — every row follows the top-level pick. On a mixed config
 * every row is surfaced as an explicit override so the user can edit
 * each backend directly.
 */
export function deriveOverridesFromConfig(
  config: ConfigModeSlice,
): PerBackendOverrides {
  const top = deriveTopFromConfig(config);
  if (top !== null) return { ...EMPTY_OVERRIDES };
  return Object.fromEntries(
    getBackendIds().map((backend) => [
      backend,
      internalToUi(config[`${backend}ExecutionPermissionMode`]),
    ]),
  ) as PerBackendOverrides;
}

/**
 * Combined seed helper: returns the tuple the component puts into its
 * three useState slots on first hydration, plus a hint for whether the
 * advanced accordion should be force-opened.
 */
export function seedStateFromConfig(config: ConfigModeSlice): {
  topLevel: ExecutionModeUi | null;
  overrides: PerBackendOverrides;
  forceAccordionOpen: boolean;
} {
  const topLevel = deriveTopFromConfig(config);
  const overrides = deriveOverridesFromConfig(config);
  return {
    topLevel,
    overrides,
    forceAccordionOpen: topLevel === null,
  };
}

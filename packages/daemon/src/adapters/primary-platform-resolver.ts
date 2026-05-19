/**
 * Pure resolver for the boot-time `primaryPlatform` mismatch.
 *
 * Background: `config.primaryPlatform` defaults to `"slack"` (env or
 * schema). A user who only sets up Telegram / Discord / WhatsApp will
 * boot every time with a primary whose adapter isn't registered, which
 * historically logged "Primary platform is not registered, falling
 * back" on every start and only patched the value in-memory — the next
 * boot replayed the same fallback because the `settings` table never
 * learned about it.
 *
 * Decision matrix (see `resolvePrimaryPlatform`):
 *  - primary's adapter is registered → keep, no action
 *  - no adapters registered at all (very early boot / silent install) →
 *    keep; we have nothing to fall back to and the warning has no
 *    operator value
 *  - primary not registered, fallback exists, user never set the value
 *    explicitly → switch + persist (auto-resolve), so the next boot is
 *    silent
 *  - primary not registered, fallback exists, user *did* set it
 *    explicitly (DB row or env var) → switch in-memory only (warn),
 *    don't overwrite their preference
 *  - primary not registered, no eligible fallback → no-fallback warn
 *
 * Pure / DI-friendly: callers feed in registry snapshots and the
 * resolver returns an action. The startup site in `index.ts` translates
 * the action into `messageHub.setPrimaryPlatform(...)` /
 * `settingsStore.set(...)` calls plus the appropriate log line.
 */

export interface PrimaryPlatformResolverInput {
  /** Current value on the live `AgentConfig` (env-or-schema-or-DB merged). */
  readonly configuredPrimary: string;
  /** `messageHub.getAdapter(configuredPrimary) !== undefined`. */
  readonly primaryAdapterRegistered: boolean;
  /** `messageHub.getPlatforms()` snapshot — includes "dashboard". */
  readonly registeredPlatforms: readonly string[];
  /**
   * The platform the caller has chosen as the new primary if a switch
   * is warranted. `null` when nothing eligible exists (e.g. only the
   * dashboard adapter is up).
   *
   * Order semantics — "first set up" vs "canonical" vs anything else —
   * are NOT the resolver's responsibility. The caller computes this
   * (today: `selectFirstPairedPlatform` in
   * `messaging/owner-channels.ts`, fed from
   * `messageHub.getEffectiveFallbackPlatforms()`).
   */
  readonly effectiveFallback: string | null;
  /**
   * True when the operator chose this value via the dashboard /
   * `PATCH /api/config` (DB `settings` row), or via the
   * `PA_PRIMARY_PLATFORM` env var. False when the value is just the
   * schema default "slack" that nobody asked for — that's the case the
   * auto-resolve targets.
   */
  readonly userExplicitlySetPrimary: boolean;
}

export type PrimaryPlatformResolverAction =
  | { readonly kind: "keep" }
  | {
      readonly kind: "switch";
      readonly newPrimary: string;
      readonly persist: boolean;
      readonly reason: "auto-resolve" | "fallback-only";
    }
  | { readonly kind: "no-fallback" };

export function resolvePrimaryPlatform(
  input: PrimaryPlatformResolverInput,
): PrimaryPlatformResolverAction {
  if (input.primaryAdapterRegistered) {
    return { kind: "keep" };
  }
  if (input.registeredPlatforms.length === 0) {
    return { kind: "keep" };
  }
  if (input.effectiveFallback === null) {
    return { kind: "no-fallback" };
  }
  if (input.userExplicitlySetPrimary) {
    return {
      kind: "switch",
      newPrimary: input.effectiveFallback,
      persist: false,
      reason: "fallback-only",
    };
  }
  return {
    kind: "switch",
    newPrimary: input.effectiveFallback,
    persist: true,
    reason: "auto-resolve",
  };
}

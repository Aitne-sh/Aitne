/**
 * Type declarations for the plain-ESM launcher mirror `ports.mjs`.
 *
 * `ports.mjs` is hand-written JavaScript (it must run before the TypeScript
 * build), so it carries no inferred types. This sidecar lets TypeScript
 * consumers — notably the `packages/shared/src/ports.test.ts` drift guard,
 * which imports this module to assert it stays in lockstep with the TS
 * source-of-truth `packages/shared/src/ports.ts` — typecheck the import under
 * `strict`. Keep these signatures identical to `ports.ts`'s exports (minus
 * `loopbackOrigins`, which is TS-only and not mirrored here).
 */

/** Daemon HTTP API port. Overridable via `PA_API_PORT`. */
export const DEFAULT_API_PORT: number;

/** Dashboard (Next.js) port. Overridable via `PA_DASHBOARD_PORT`. */
export const DEFAULT_DASHBOARD_PORT: number;

/** Resolve the daemon API port from env, falling back to DEFAULT_API_PORT. */
export function resolveApiPort(
  env?: Record<string, string | undefined>,
): number;

/** Resolve the dashboard port from env, falling back to DEFAULT_DASHBOARD_PORT. */
export function resolveDashboardPort(
  env?: Record<string, string | undefined>,
): number;

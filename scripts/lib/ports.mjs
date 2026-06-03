/**
 * Default network ports for the Aitne daemon API and dashboard.
 *
 * SINGLE SOURCE OF TRUTH (launcher / plain-ESM side). `bin/aitne.mjs` and the
 * `scripts/**` launchers cannot import `@aitne/shared`: they run *before* the
 * TypeScript build that produces it (running `aitne start` is what triggers
 * that build), and the published package ships only `bin` + `scripts/*.mjs` +
 * `agent-assets`, never `packages/`. So the defaults are mirrored here in a
 * build-independent module that lives under the published `scripts/lib/`.
 *
 * The TypeScript mirror lives in `packages/shared/src/ports.ts`. The two are
 * pinned together by `packages/shared/src/ports.test.ts`, which fails CI if
 * the values ever drift. Change a default in BOTH or the test goes red.
 */

/** Daemon HTTP API port. Overridable via `PA_API_PORT`. */
export const DEFAULT_API_PORT = 8321;

/** Dashboard (Next.js) port. Overridable via `PA_DASHBOARD_PORT`. Not 3000 — that collides with most dev servers. */
export const DEFAULT_DASHBOARD_PORT = 8322;

function parsePort(raw) {
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Resolve the daemon API port from env, falling back to DEFAULT_API_PORT. */
export function resolveApiPort(env = process.env) {
  return parsePort(env.PA_API_PORT) ?? DEFAULT_API_PORT;
}

/** Resolve the dashboard port from env, falling back to DEFAULT_DASHBOARD_PORT. */
export function resolveDashboardPort(env = process.env) {
  return parsePort(env.PA_DASHBOARD_PORT) ?? DEFAULT_DASHBOARD_PORT;
}

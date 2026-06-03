/**
 * Default network ports for the Aitne daemon API and the dashboard.
 *
 * SINGLE SOURCE OF TRUTH (TypeScript side). Every TypeScript consumer — the
 * daemon's `config.ts`, the CORS allowlist, the OAuth origin allowlist — must
 * read these constants (or the `resolve*` helpers) instead of hardcoding a
 * port literal. Change the default in one place, here.
 *
 * Why there is a second copy: the launcher scripts (`bin/aitne.mjs`,
 * `scripts/**`) CANNOT import this module. They run *before* the TypeScript
 * build that produces `@aitne/shared` dist (running `aitne start` is what
 * triggers that build), and the published package ships only `bin` +
 * `scripts/*.mjs` + `agent-assets`, never `packages/`. So a plain-ESM mirror
 * lives in `scripts/lib/ports.mjs`. The two are pinned together by
 * `ports.test.ts`, which fails CI if the values ever drift.
 */

/** Daemon HTTP API port. Overridable via `PA_API_PORT`. */
export const DEFAULT_API_PORT = 8321;

/**
 * Dashboard (Next.js) port. Overridable via `PA_DASHBOARD_PORT`.
 *
 * Deliberately NOT 3000 — that is the default for Next.js, React, Express and
 * most dev servers, so it collides constantly. 8322 sits next to the daemon's
 * 8321 ("Aitne lives in the 832x range") and is outside the common dev-port
 * range.
 */
export const DEFAULT_DASHBOARD_PORT = 8322;

function parsePort(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Resolve the daemon API port from env, falling back to {@link DEFAULT_API_PORT}. */
export function resolveApiPort(
  env: Record<string, string | undefined> = process.env,
): number {
  return parsePort(env.PA_API_PORT) ?? DEFAULT_API_PORT;
}

/** Resolve the dashboard port from env, falling back to {@link DEFAULT_DASHBOARD_PORT}. */
export function resolveDashboardPort(
  env: Record<string, string | undefined> = process.env,
): number {
  return parsePort(env.PA_DASHBOARD_PORT) ?? DEFAULT_DASHBOARD_PORT;
}

/**
 * The three loopback origins (`localhost`, `127.0.0.1`, `[::1]`) for a port.
 *
 * Used by both the daemon CORS allowlist and the OAuth postMessage origin
 * allowlist, which previously each built this triple by hand. `[::1]` matters
 * because some IPv6-first environments emit origins in that bracketed form.
 */
export function loopbackOrigins(port: number): string[] {
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
}

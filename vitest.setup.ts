import { afterEach, vi } from "vitest";

/**
 * Pin the test process to UTC so time-sensitive assertions are deterministic
 * regardless of the developer's machine timezone.
 *
 * CI runs in UTC, and several suites construct `Z`-suffixed ISO instants and
 * then assert on the *local-time* projection (e.g. `repository-management-docs`
 * derives "today" from a `now: new Date("…T18:00:00Z")`, and
 * `integration-card.logic`'s `formatRecentCallTimestamp` compares calendar
 * days via `Date.getDate()`). Those hold only when the runtime TZ is UTC — on
 * an `Asia/Tokyo` machine an 18:00Z instant rolls into the next calendar day
 * and the assertions flip. `context-builder.test.ts` already sets `TZ=UTC`
 * locally for the same reason; this hoists that intent to the whole suite.
 *
 * Node re-reads `process.env.TZ` at runtime, so setting it here — at setup-file
 * module load, before any test file's `Date` calls — takes effect. Per-test
 * `process.env.TZ` overrides (and their restores) still work on top of this.
 * `PA_TEST_TZ` lets a developer reproduce a TZ-specific bug without editing
 * this file.
 */
process.env.TZ = process.env.PA_TEST_TZ ?? "UTC";

/**
 * Global per-test cleanup safety net.
 *
 * Why: `vitest.config.ts` caps `maxForks` to keep RAM in check, which packs
 * many test files into each fork. With `isolate: true` (vitest's default for
 * the forks pool) the module graph resets between files — but `globalThis`,
 * timer state, and stubbed envs live at the worker-process level and DO
 * leak across files. A test that calls `vi.useFakeTimers()` and crashes
 * before its own `afterEach` runs `vi.useRealTimers()` will silently poison
 * every subsequent file landing on the same fork. We saw this manifest as
 * cross-file flakes in `mail-poller.test.ts`, `claude-code-core.test.ts`,
 * and `absolute-block-audit.test.ts` — each passes alone, fails in suite.
 *
 * Each call below is **idempotent and side-effect-free when nothing was
 * stubbed**, so this hook does not change behavior for tests that already
 * clean up after themselves. It only catches the leaks.
 *
 * - `vi.useRealTimers()` — restores the global `setTimeout` / `setInterval`
 *   / `Date` patches. No-op when fake timers were not enabled. This is the
 *   load-bearing one — fake timers patch `globalThis` directly, so a leaked
 *   patch outlives module isolation and breaks every subsequent test that
 *   uses real time.
 * - `vi.unstubAllEnvs()` — restores every `vi.stubEnv(...)` set during the
 *   test. No-op when no env vars were stubbed via vi.
 *
 * Note: we intentionally do NOT call `vi.unstubAllGlobals()` here.
 * `signal-detector.test.ts:7` stubs `globalThis.fetch` at module top level
 * and reuses the stub across all tests in the file; unstubbing per-test
 * tears that pattern down. Top-level stubs are re-applied automatically
 * when isolate=true re-loads the module on the next file, so they don't
 * need a cross-file safety net.
 *
 * This hook does NOT touch `vi.mock(...)` module mocks (those are reset by
 * the module-graph re-init between files when `isolate: true`) or
 * `vi.spyOn(...)` spies (call `vi.restoreAllMocks()` per-test if a test
 * leaks a spy on a shared module export — that's a per-test bug, not a
 * global concern).
 */
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

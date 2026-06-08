/**
 * Type declarations for the plain-ESM launcher module `process-identity.mjs`.
 *
 * `process-identity.mjs` is hand-written JavaScript (it must run before the
 * TypeScript build, from `bin/aitne.mjs`), so it carries no inferred types.
 * This sidecar lets the `packages/shared/src/process-identity.test.ts` peer
 * test typecheck the import under `strict`. Mirrors the `ports.d.mts`
 * precedent. Keep these signatures in lockstep with the `.mjs` exports.
 */

/** Parsed pidfile contents. `startToken` is null for a legacy (tokenless) file. */
export interface PidMeta {
  pid: number;
  startToken: string | null;
}

/** Injectable OS shims for {@link readProcessStartToken} (tests only). */
export interface ReadTokenDeps {
  platform?: NodeJS.Platform;
  execFileSync?: (command: string, args?: readonly string[], options?: unknown) => string | Buffer;
  readFileSync?: (path: string, encoding: string) => string;
}

/** Liveness + start-time reader injected into {@link classifyPid}. */
export interface ClassifyDeps {
  readToken: (pid: number) => string | null;
  isAlive: (pid: number) => boolean;
}

export type PidClassification = "stale" | "running-ours" | "running-unverified";

export function serializePidMeta(input: { pid: number; startToken?: string | null }): string;

export function parsePidMeta(content: string): PidMeta | null;

export function parseLinuxStat(statContent: string): string | null;

export function readProcessStartToken(
  pid: number | null | undefined,
  deps?: ReadTokenDeps,
): string | null;

export function classifyPid(
  meta: { pid?: number | null; startToken?: string | null } | null | undefined,
  deps: ClassifyDeps,
): PidClassification;

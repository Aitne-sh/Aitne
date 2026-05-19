import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { DelegatedToolCost } from "../core/agent-core.js";

/**
 * Stateless utilities for {@link DelegatedBackendInvoker}: a tiny FS reader,
 * a stable arg hash for `agent_actions.detail`, two `DelegatedToolCost`
 * builders, a code-fence stripper, and the synthetic one-shot lease used
 * when the session-dir pool is disabled.
 *
 * Nothing here reads invoker instance state — these are exported as plain
 * functions so the parent class can delegate without preserving a `this`
 * binding. `LegacyOneShotLease` keeps the same `release()` / `discard()`
 * shape as `SessionPoolLease` so the task() / run() loop can hold either
 * kind through one variable.
 */

export function readFileSyncIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function hashArgs(args: unknown): string {
  try {
    const serialized = JSON.stringify(args ?? null);
    return createHash("sha256")
      .update(serialized)
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "unhashable";
  }
}

export function zeroCost(): DelegatedToolCost {
  return {
    tokensInput: 0,
    tokensOutput: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
  };
}

export function mergeCost(
  a: DelegatedToolCost,
  b: DelegatedToolCost,
): DelegatedToolCost {
  return {
    tokensInput: a.tokensInput + b.tokensInput,
    tokensOutput: a.tokensOutput + b.tokensOutput,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd + b.costUsd,
    durationMs: a.durationMs + b.durationMs,
    numTurns: a.numTurns + b.numTurns,
  };
}

/**
 * Fence stripper shared with `delegated-task-runtime.ts` (which keeps a
 * private copy for `extractAndValidateResult`'s schema-violation recovery
 * path — see runtime.ts:572). A four-line helper hand-synced rather than
 * imported from either direction so neither file widens its dependency
 * surface for the sake of one regex.
 */
export function stripCodeFences(input: string): string {
  let s = input.trim();
  const fenceRe = /^```(?:json|JSON|jsonc|JSONC)?\s*\r?\n([\s\S]*?)\r?\n```$/;
  const m = s.match(fenceRe);
  if (m) return m[1];
  s = s.replace(/^```(?:json|JSON|jsonc|JSONC)?\s*\r?\n/, "");
  s = s.replace(/\r?\n```\s*$/, "");
  return s;
}

/**
 * §13 Phase 3.2 — synthetic lease used when pooling is disabled. Implements
 * the same `release()` / `discard()` shape as `SessionPoolLease` so the
 * task() / run() loop doesn't have to branch on whether pooling is active.
 * Both methods clean up the tempdir (no TTL semantics — there's no pool
 * to return to).
 */
export class LegacyOneShotLease {
  readonly fromPool = false;
  private released = false;
  constructor(
    readonly sessionDir: string,
    private readonly cleanup: () => void,
  ) {}
  release(): void {
    if (this.released) return;
    this.released = true;
    this.cleanup();
  }
  discard(): void {
    if (this.released) return;
    this.released = true;
    this.cleanup();
  }
}

/**
 * Pre-spawn gates for autonomous routine sessions —
 * PREPASS_COST_REDUCTION_PLAN.md N2.
 *
 * Two cheap checks run before the daemon spawns an autonomous backend
 * session (routine dispatch + pre-pass fan-out sub-sessions), so a
 * session that would deterministically fail is skipped instead of
 * billed/spawned:
 *
 *  1. **Offline gate** — DNS-resolve the *backend API host* (the daemon
 *     never talks to integration APIs in delegated/native mode, so the
 *     backend host is the only one that matters). Uses `dns.lookup`
 *     (getaddrinfo — the same resolver path that produces the observed
 *     ENOTFOUND failures), NOT `dns.resolve` (c-ares bypasses the OS
 *     resolver / hosts file and can disagree with what the session would
 *     see). Results are cached ~60s per host so a fan-out of N
 *     integrations costs one lookup.
 *  2. **Auth gate** — consult the cached auth-health row
 *     (`readCachedAuthStatus`) and treat the backend as non-viable only
 *     when `shouldSkip` is true (expired/missing with a ≤10-min-fresh
 *     cache, or a recovery subprocess owning the row). The hourly
 *     `checkAll()` probe and the reactive `recordReactiveAuth*` writers
 *     refresh the cache independently of routine sessions, so a
 *     recovered backend un-skips within minutes.
 *
 * **A spawn is skipped only when EVERY candidate backend (main +
 * fallback) is non-viable.** The BackendRouter already skips an
 * auth-unhealthy main straight to its fallback, so gating on the main
 * alone would suppress sessions the router could have completed —
 * exactly the accuracy degradation the now-scope forbids.
 *
 * Skips never touch pre-pass freshness state, so the next tick retries.
 * Every decision is fail-open: an unknown backend host, a gate-internal
 * error, or a DB failure lets the spawn proceed — the gate exists to
 * save doomed sessions, never to block live ones.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type Database from "better-sqlite3";
import type { BackendId } from "@aitne/shared";
import { readCachedAuthStatus } from "./backends/auth-health-monitor.js";
import { createLogger } from "../logging.js";

const logger = createLogger("spawn-gates");

/**
 * Backend → API host the SDK/CLI must reach for a session to be viable.
 * Hosts chosen per the default auth path of each backend's runtime:
 * Claude Code → Anthropic API; Codex CLI (ChatGPT-plan auth) →
 * chatgpt.com; Gemini CLI (OAuth code-assist) → cloudcode-pa. The gate
 * only needs a DNS answer for outage detection, so an API-key install
 * resolving a sibling host of the same provider is equally conclusive.
 * Backends without an entry (e.g. opencode, which routes to arbitrary
 * providers) are fail-open: the offline gate passes them.
 */
export const BACKEND_API_HOSTS: Partial<Record<BackendId, string>> = {
  claude: "api.anthropic.com",
  codex: "chatgpt.com",
  gemini: "cloudcode-pa.googleapis.com",
};

/** Default TTL for cached per-host DNS verdicts (~60s per the N2 spec). */
const DEFAULT_DNS_CACHE_TTL_MS = 60 * 1000;

/**
 * Deadline for a single `dns.lookup` call. getaddrinfo has no timeout
 * of its own — a degraded resolver can block for the OS resolver
 * timeout (5-30s), serially per candidate host, stalling the
 * autonomous lane and every fan-out sub-session start. Past the
 * deadline the gate fails OPEN (treats the host as resolvable): an
 * answer we don't have is not an outage signal.
 */
const DEFAULT_DNS_LOOKUP_TIMEOUT_MS = 2_500;

export type SpawnGateSkipReason = "offline" | "auth_unhealthy";

/** Per-candidate diagnostics carried into the skip audit row. */
export interface SpawnGateBackendVerdict {
  backendId: BackendId;
  /** Host probed by the offline gate; null = no mapping (gate passed). */
  host: string | null;
  /** True when the host failed to resolve (within the cache TTL). */
  offline: boolean;
  /** Cached auth status string (`ok` / `expired` / `missing` / …). */
  authStatus: string;
  /** True when the cached auth row says a spawn is doomed. */
  authShouldSkip: boolean;
  /** Net verdict: this backend could run the session. */
  viable: boolean;
}

export interface SpawnGateDecision {
  skip: boolean;
  /**
   * Present iff `skip`. `offline` when every candidate was blocked by
   * DNS; `auth_unhealthy` when at least one candidate resolved but had
   * a confirmed-bad auth cache.
   */
  reason?: SpawnGateSkipReason;
  backends: SpawnGateBackendVerdict[];
}

export interface AutonomousSpawnGateOptions {
  /** Injected for tests; defaults to `node:dns/promises.lookup`. */
  lookup?: (host: string) => Promise<unknown>;
  /** Injected clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** DNS verdict cache TTL; defaults to 60s. */
  dnsCacheTtlMs?: number;
  /** Per-lookup deadline (fail-open past it); defaults to 2.5s. */
  dnsLookupTimeoutMs?: number;
  /**
   * Freshness window forwarded to `readCachedAuthStatus`. Omit to use
   * that module's 10-minute default; callers with a configured
   * `authPreflightFreshnessMs` should thread it through so the gate and
   * the router agree on what "recently confirmed bad" means.
   */
  authFreshnessMs?: number;
  /** Host mapping override for tests. */
  backendApiHosts?: Partial<Record<BackendId, string>>;
}

interface DnsCacheEntry {
  ok: boolean;
  expiresAtMs: number;
}

export class AutonomousSpawnGate {
  private readonly lookup: (host: string) => Promise<unknown>;
  private readonly now: () => number;
  private readonly dnsCacheTtlMs: number;
  private readonly dnsLookupTimeoutMs: number;
  private readonly authFreshnessMs: number | undefined;
  private readonly hosts: Partial<Record<BackendId, string>>;
  private readonly dnsCache = new Map<string, DnsCacheEntry>();

  constructor(
    private readonly db: Database.Database,
    options: AutonomousSpawnGateOptions = {},
  ) {
    // `dnsLookup` is referenced directly (no wrapper arrow) so the
    // default arm carries no never-invoked closure — tests cover the
    // `??` branch by constructing without options, without doing real
    // DNS.
    this.lookup = options.lookup ?? dnsLookup;
    this.now = options.now ?? (() => Date.now());
    this.dnsCacheTtlMs = options.dnsCacheTtlMs ?? DEFAULT_DNS_CACHE_TTL_MS;
    this.dnsLookupTimeoutMs =
      options.dnsLookupTimeoutMs ?? DEFAULT_DNS_LOOKUP_TIMEOUT_MS;
    this.authFreshnessMs = options.authFreshnessMs;
    this.hosts = options.backendApiHosts ?? BACKEND_API_HOSTS;
  }

  /**
   * Evaluate the gates for the candidate backends that could run the
   * session (binding main first, then fallback). Returns `skip: false`
   * for an empty candidate list (nothing to assert) and on any internal
   * error (fail-open).
   */
  async evaluate(
    candidates: readonly BackendId[],
  ): Promise<SpawnGateDecision> {
    try {
      if (candidates.length === 0) {
        return { skip: false, backends: [] };
      }
      const backends: SpawnGateBackendVerdict[] = [];
      for (const backendId of candidates) {
        backends.push(await this.evaluateBackend(backendId));
      }
      if (backends.some((b) => b.viable)) {
        return { skip: false, backends };
      }
      const reason: SpawnGateSkipReason = backends.every((b) => b.offline)
        ? "offline"
        : "auth_unhealthy";
      return { skip: true, reason, backends };
    } catch (err) {
      logger.warn(
        { err, candidates },
        "Spawn-gate evaluation failed — failing open",
      );
      return { skip: false, backends: [] };
    }
  }

  private async evaluateBackend(
    backendId: BackendId,
  ): Promise<SpawnGateBackendVerdict> {
    const host = this.hosts[backendId] ?? null;
    const offline = host === null ? false : !(await this.hostResolves(host));
    // readCachedAuthStatus is fail-open by contract (returns
    // `{status:"unknown", shouldSkip:false}` on any DB error), and
    // `evaluate()`'s outer catch fails the whole gate open as the last
    // line of defense — no per-call try/catch needed here.
    const cached = this.authFreshnessMs === undefined
      ? readCachedAuthStatus(this.db, backendId)
      : readCachedAuthStatus(this.db, backendId, this.authFreshnessMs);
    return {
      backendId,
      host,
      offline,
      authStatus: cached.status,
      authShouldSkip: cached.shouldSkip,
      viable: !offline && !cached.shouldSkip,
    };
  }

  private async hostResolves(host: string): Promise<boolean> {
    const nowMs = this.now();
    const cached = this.dnsCache.get(host);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.ok;
    }
    const ok = await this.lookupWithDeadline(host);
    this.dnsCache.set(host, {
      ok,
      expiresAtMs: this.now() + this.dnsCacheTtlMs,
    });
    return ok;
  }

  /**
   * One bounded lookup attempt. Three fail-OPEN (`true`) outcomes that
   * deliberately do not count as "offline":
   *  - the resolver answered (any address);
   *  - `EAI_AGAIN` — the resolver said "try again", which is a transient
   *    resolver condition, not an outage verdict;
   *  - the deadline elapsed — no answer is not a negative answer.
   * Only a definitive resolution failure (ENOTFOUND et al.) returns
   * `false`. The verdict — including a fail-open one — is cached by the
   * caller for the TTL so a hung resolver costs at most one deadline
   * per host per minute.
   */
  private async lookupWithDeadline(host: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const attempt = this.lookup(host).then(
      () => true,
      (err: unknown) => {
        const code = typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
        return code === "EAI_AGAIN";
      },
    );
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.dnsLookupTimeoutMs);
    });
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}

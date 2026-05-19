import type Database from "better-sqlite3";
import {
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";
import {
  evaluateProbe,
  type ProbeResult,
} from "../core/integration-probe.js";
import {
  readProbe,
  writeProbe,
} from "../db/integration-probe-store.js";
import { readIntegrations } from "../db/integrations-store.js";
import {
  LiveProbeUnsupportedError,
  type IAgentCore,
} from "../core/agent-core.js";
import { createLogger } from "../logging.js";
import type { Observer } from "./manager.js";

const logger = createLogger("delegated-probe-observer");

/**
 * Default stagger between consecutive per-backend probe subprocesses.
 * Mirrors `McpAutoProbe`'s shape (smaller value here because we typically
 * only have 1-3 distinct backends to walk per tick, not 10 MCP servers).
 */
const DEFAULT_STAGGER_MS = 250;

export interface DelegatedProbeObserverOptions {
  db: Database.Database;
  /**
   * Pool of agent cores to look up by `backendId`. Wired in `index.ts`
   * with `[agentCore, codexCore, geminiCore]`. A delegated integration
   * whose `delegatedBackend` does not appear in this array logs a warning
   * once per tick and is skipped (defense against config drift).
   */
  agentBackends: readonly IAgentCore[];
  /**
   * Cadence in minutes. 0 disables the observer entirely (the timer is
   * never scheduled; `start()` becomes a no-op after logging the decision
   * so it's visible in operator logs).
   */
  intervalMinutes: number;
  /** Stagger between per-backend subprocess calls. Default 250ms. */
  staggerMs?: number;
  /** Test seam — `Date.now()` indirection for the freshness skip check. */
  now?: () => number;
  /** Test seam — sleep helper. Default `setTimeout`-backed Promise. */
  sleep?: (ms: number) => Promise<void>;
}

interface BackendGroup {
  backend: BackendId;
  integrations: IntegrationKey[];
  /** Pre-tick `probed_at` timestamps keyed by integration. */
  probedAtMs: Map<IntegrationKey, number>;
  /** Pre-tick `present` snapshot for transition logging. */
  presentSnapshot: Map<IntegrationKey, boolean>;
}

/**
 * DELEGATED-MODE-V2 §7.1 — periodic re-probe observer.
 *
 * Walks every `state.mode === "delegated"` integration once per
 * `intervalMinutes`, batches them by `delegatedBackend`, and re-runs
 * `core.probeTools()` per backend so the `integration_probes` cache stays
 * fresh. Without this, `consultDelegatedConnectorHealth` (`§4.5`) is
 * input-starved after the wizard's first probe — the §10 risk row "user
 * signed out hours ago" never produces a DM.
 *
 * Batching: two integrations on the same `delegatedBackend` consume one
 * subprocess call (the live tool list is namespace-filtered per
 * integration by `evaluateProbe`). Per-integration calls would be N×
 * cost for the current `{gmail, google_calendar}` registry where both
 * default to the same backend.
 *
 * The probeTools prompts in `claude-code-core.ts` and `codex-core.ts` are
 * hardcoded for Gmail + Google_Calendar by name. Adding a new delegated
 * integration requires lockstep updates to both prompts AND the prefix /
 * regex constants (see DELEGATED-MODE-V2 §7.1 "Adding a new delegated
 * integration"); otherwise the new integration's `present` is
 * permanently false regardless of actual sign-in state.
 *
 * Failure handling per group, not per tick: a backend whose CLI throws,
 * times out, or returns `LiveProbeUnsupportedError` does not crash the
 * tick or skip remaining groups. The probe row stays at its last value
 * (preserves last-known-good).
 */
export class DelegatedProbeObserver implements Observer {
  readonly name = "delegated-probe";

  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private readonly intervalMs: number;
  private readonly staggerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * Latch keyed by `${integration}:${backend}` so each Gemini-style
   * `LiveProbeUnsupportedError` logs at most once. Without this every
   * tick would emit the same warn line indefinitely.
   */
  private readonly liveProbeUnsupportedLogged = new Set<string>();

  constructor(private readonly options: DelegatedProbeObserverOptions) {
    this.intervalMs = options.intervalMinutes * 60_000;
    this.staggerMs = options.staggerMs ?? DEFAULT_STAGGER_MS;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async start(): Promise<void> {
    if (this.intervalMs <= 0) {
      logger.info(
        "Delegated probe observer disabled (delegatedProbeIntervalMinutes <= 0) — skipping registration",
      );
      return;
    }
    // First tick is scheduled, not immediate: avoid racing with the
    // wizard's initial live-probe flurry the user often runs right after
    // delegating an integration.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    logger.info(
      { intervalMs: this.intervalMs },
      "Delegated probe observer started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // In-flight tick is allowed to complete on its own. Each
    // `probeTools()` carries its own per-backend subprocess timeout, so
    // leaking the Promise here is bounded.
  }

  /**
   * Runs one pass over delegated integrations grouped by backend.
   * Exposed for tests; production callers let the interval timer drive
   * it. Re-entrancy is guarded so a slow tick (Codex CLI startup × N
   * backends) cannot overlap the next timer fire.
   */
  async tick(): Promise<void> {
    if (this.tickRunning) {
      logger.debug(
        "Delegated probe tick already running — skipping overlap",
      );
      return;
    }
    this.tickRunning = true;
    try {
      await this.runTick();
    } finally {
      this.tickRunning = false;
    }
  }

  private async runTick(): Promise<void> {
    const groups = this.collectGroups();
    if (groups.length === 0) return;

    const freshnessMs = this.intervalMs / 2;
    const now = this.now();

    let probedGroups = 0;
    let skippedGroups = 0;
    let firstStagger = true;

    for (const group of groups) {
      // Mixed-freshness in a group forces probe — cheaper to run one
      // subprocess for the whole group than to partial-skip and hand the
      // staler members an extra interval of staleness.
      const allFresh = group.integrations.every((key) => {
        const probedAt = group.probedAtMs.get(key);
        return probedAt !== undefined && now - probedAt < freshnessMs;
      });
      if (allFresh) {
        skippedGroups++;
        continue;
      }

      const core = this.options.agentBackends.find(
        (c) => c.backendId === group.backend,
      );
      if (!core) {
        logger.warn(
          { backend: group.backend, integrations: group.integrations },
          "No registered agent core for delegated backend — skipping group",
        );
        continue;
      }

      if (!firstStagger) {
        await this.sleep(this.staggerMs);
      }
      firstStagger = false;

      await this.probeGroup(core, group);
      probedGroups++;
    }

    logger.info(
      {
        probedGroups,
        skippedGroups,
        totalGroups: groups.length,
      },
      "Delegated probe tick finished",
    );
  }

  private collectGroups(): BackendGroup[] {
    const integrations = readIntegrations(this.options.db);
    const byBackend = new Map<BackendId, BackendGroup>();

    for (const [keyRaw, state] of Object.entries(integrations)) {
      if (state.mode !== "delegated") continue;
      const backend = state.delegatedBackend;
      // `integrationStateSchema.superRefine` enforces that delegated
      // mode carries a backend, but the field is nullable+optional in
      // the type — guard explicitly so TS narrows.
      /* c8 ignore next -- registry-rollback / hand-edited-DB defense */
      if (backend === null || backend === undefined) continue;
      const key = keyRaw as IntegrationKey;

      let group = byBackend.get(backend);
      if (!group) {
        group = {
          backend,
          integrations: [],
          probedAtMs: new Map(),
          presentSnapshot: new Map(),
        };
        byBackend.set(backend, group);
      }
      group.integrations.push(key);

      // Snapshot existing probe row up-front so transition logging
      // compares against the pre-tick state, not the post-`writeProbe`
      // state we're about to overwrite.
      const existing = readProbe(this.options.db, key, backend);
      if (existing) {
        const probedAt = Date.parse(existing.probedAt);
        if (!Number.isNaN(probedAt)) {
          group.probedAtMs.set(key, probedAt);
        }
        group.presentSnapshot.set(key, existing.present);
      }
    }

    return [...byBackend.values()];
  }

  private async probeGroup(
    core: IAgentCore,
    group: BackendGroup,
  ): Promise<void> {
    let tools: string[];
    try {
      tools = await core.probeTools();
    } catch (err) {
      if (err instanceof LiveProbeUnsupportedError) {
        // Log once per (integration, backend). Two ticks → one log line
        // per pair. Gemini today; future backends that throw the same
        // class fall through this path automatically.
        for (const key of group.integrations) {
          const latch = `${key}:${group.backend}`;
          if (this.liveProbeUnsupportedLogged.has(latch)) continue;
          this.liveProbeUnsupportedLogged.add(latch);
          logger.warn(
            {
              integration: key,
              backend: group.backend,
              reason: err.reason,
            },
            "Backend does not support live probe — delegated probe will stay stale until support lands",
          );
        }
        return;
      }
      logger.warn(
        { backend: group.backend, integrations: group.integrations, err },
        "probeTools threw — preserving last-known-good probe rows for this group",
      );
      return;
    }

    for (const key of group.integrations) {
      let result: ProbeResult;
      try {
        result = evaluateProbe({
          tools,
          integration: key,
          backend: group.backend,
        });
        writeProbe(this.options.db, result);
      } catch (err) {
        // One bad row should not poison its siblings — typically a
        // registry inconsistency for this specific integration. The
        // sibling integrations on the same backend continue.
        logger.error(
          { integration: key, backend: group.backend, err },
          "evaluateProbe / writeProbe failed for delegated integration",
        );
        continue;
      }

      const previousPresent = group.presentSnapshot.get(key);
      if (previousPresent !== undefined && previousPresent !== result.present) {
        logger.info(
          {
            integration: key,
            backend: group.backend,
            from: previousPresent,
            to: result.present,
            missingRequired: result.missingRequired,
          },
          "Delegated probe transition",
        );
      }
    }
  }
}

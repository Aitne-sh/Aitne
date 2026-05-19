import type Database from "better-sqlite3";
import type { Observer } from "../../observers/manager.js";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import { createLogger } from "../../logging.js";
import { probeMcpServer } from "./probe.js";
import {
  listMcpServers,
  resolveMcpSecrets,
  saveMcpProbeResult,
} from "./registry.js";
import type { McpServer } from "./types.js";

const logger = createLogger("mcp-auto-probe");

/**
 * Default stagger between consecutive server probes inside a single tick.
 * Keeps ten enabled servers from sharing a 10-second probe timeout wall
 * simultaneously (each probe is already bounded to 10 s, so a 2 s stagger
 * means a full ten-server tick completes in < 30 s).
 */
const DEFAULT_STAGGER_MS = 2_000;

export interface McpAutoProbeOptions {
  db: Database.Database;
  blobStore: EncryptedBlobStore;
  /** PA_DATA_DIR — forwarded to `probeMcpServer` for the sandbox cwd. */
  dataDir: string;
  /**
   * Probe cadence in minutes. 0 disables the observer entirely (the timer
   * is never scheduled; `start()` becomes a no-op after logging the decision
   * so it's visible in operator logs).
   */
  intervalMinutes: number;
  /** Override for tests — clock injection for the freshness skip check. */
  now?: () => number;
  /** Override for tests — per-server probe stagger. */
  staggerMs?: number;
  /** Override for tests — lets the test inject a fake probe runner. */
  probe?: typeof probeMcpServer;
  /**
   * Override for tests — sleep helper. Default `setTimeout`. Tests replace
   * with a fake so staggered probes run without real delay.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * B-003 Phase 4.3 — auto-probe observer.
 *
 * Walks every row in `mcp_servers WHERE enabled = 1` once per
 * `intervalMinutes`, re-runs the same `initialize + tools/list` probe the
 * dashboard Probe button issues, and persists the result via
 * `saveMcpProbeResult`. The persisted row drives:
 *
 *  - The `ConnectionCard` status dot (error / connected).
 *  - The per-tool list the card renders for the allowlist toggles.
 *  - The `## MCP tools available` section appended to the instruction file
 *    at session materialization time (see `session-materializer.ts`),
 *    which is how the agent knows what tools each server currently exposes.
 *
 * Failure handling is deliberately minimal: a failing probe writes the
 * error to `last_probe_status` and moves on. We do NOT auto-disable —
 * enabling / disabling an MCP server is an approve-tier mutation by design
 * (§ Safety integration in B-003), so auto-flipping it from a polling
 * observer would silently widen the safety surface. The card's error state
 * surfaces the failure; the user decides.
 *
 * A manually-probed server (via `POST /api/mcp/servers/:id/probe`) is
 * skipped for one tick when its `lastProbeAt` is younger than half the
 * configured interval. This avoids double-probing a server the user just
 * fixed and re-probed.
 */
export class McpAutoProbe implements Observer {
  readonly name = "mcp-auto-probe";

  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private readonly intervalMs: number;
  private readonly staggerMs: number;
  private readonly now: () => number;
  private readonly probeFn: typeof probeMcpServer;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: McpAutoProbeOptions) {
    this.intervalMs = options.intervalMinutes * 60_000;
    this.staggerMs = options.staggerMs ?? DEFAULT_STAGGER_MS;
    this.now = options.now ?? Date.now;
    this.probeFn = options.probe ?? probeMcpServer;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async start(): Promise<void> {
    if (this.intervalMs <= 0) {
      logger.info(
        "MCP auto-probe disabled (mcpAutoProbeIntervalMinutes <= 0) — skipping registration",
      );
      return;
    }
    // First tick is scheduled, not immediate: avoid racing with the initial
    // manual-probe flurry the user often runs right after setting servers up.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    logger.info(
      { intervalMs: this.intervalMs },
      "MCP auto-probe observer started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // In-flight tick is allowed to complete on its own — probes hold a
    // 10 s timeout each and kill their own process trees / abort their
    // fetches on timeout, so leaking the Promise here is bounded.
  }

  /**
   * Runs one pass over enabled servers. Exposed for tests; production callers
   * should let the interval timer drive it. Re-entrancy is guarded so that a
   * slow tick (e.g. 8 servers × stagger) cannot overlap the next timer fire.
   */
  async tick(): Promise<void> {
    if (this.tickRunning) {
      logger.debug("MCP auto-probe tick already running — skipping overlap");
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
    const servers = listMcpServers(this.options.db).filter((s) => s.enabled);
    if (servers.length === 0) return;

    const now = this.now();
    const freshnessMs = this.intervalMs / 2;

    let probed = 0;
    let skipped = 0;
    let firstStagger = true;

    for (const server of servers) {
      // Skip if a recent manual probe already refreshed the status.
      if (server.lastProbeAt != null && now - server.lastProbeAt < freshnessMs) {
        skipped++;
        continue;
      }

      if (!firstStagger) {
        await this.sleep(this.staggerMs);
      }
      firstStagger = false;

      await this.probeOne(server);
      probed++;
    }

    logger.info({ probed, skipped, total: servers.length }, "MCP auto-probe tick finished");
  }

  private async probeOne(server: McpServer): Promise<void> {
    try {
      const rawSecrets = await resolveMcpSecrets(this.options.blobStore, server);
      const secrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawSecrets)) {
        if (v != null) secrets[k] = v;
      }
      const result = await this.probeFn(server, {
        dataDir: this.options.dataDir,
        secrets,
      });
      saveMcpProbeResult(this.options.db, server.id, result);
      if (result.ok) {
        logger.debug(
          { id: server.id, tools: result.toolCount },
          "MCP auto-probe succeeded",
        );
      } else {
        logger.warn(
          { id: server.id, error: result.error },
          "MCP auto-probe returned a failure result",
        );
      }
    } catch (err) {
      // probeMcpServer is designed to return `{ok:false}` on transport errors,
      // so reaching this catch means the probe runner itself threw — usually
      // an invariant bug. Log and continue; the next tick will retry.
      logger.error({ err, id: server.id }, "MCP auto-probe threw unexpectedly");
    }
  }
}

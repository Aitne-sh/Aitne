/**
 * docs/design/appendices/opencode-backend.md §5.1 / §6.4 — server lifecycle manager.
 *
 * Phase 2 ships only the Managed implementation: one long-lived
 * `opencode serve` child process per backend slot, with config-diff
 * triggered bounce. The Remote implementation lands in Phase 5; Phase 2
 * exposes the interface so wiring is stable.
 *
 * Concurrency model: a single `BackendRouter` slot is serialised by the
 * router's per-backend in-flight gate. Within that gate `ensureConfig`
 * may block on a bounce, then `client()` returns the live SDK client.
 * `shutdown()` is wired into `ObserverManager` so graceful daemon exit
 * stops the child process and releases the loopback port.
 */

import { createHash } from "node:crypto";
import {
  createOpencode,
  type Config,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { stableStringify } from "@aitne/shared";
import type { OpencodeRuntimeConfig } from "@aitne/shared";
import { createLogger } from "../../logging.js";

const logger = createLogger("opencode-server-manager");

/** Default cold-start budget — V6 measured p95 ≈ 1222 ms; 15 s headroom
 *  for slow CI hosts and the rare MCP-bound bounce. */
const DEFAULT_SPAWN_TIMEOUT_MS = 15_000;

/** Default loopback bind. Port 0 lets the OS pick a free port; the SDK
 *  echoes the chosen URL back so we never need to probe externally. */
const DEFAULT_HOSTNAME = "127.0.0.1";

export type OpencodeServerMode = "managed" | "remote";

/**
 * docs/design/appendices/opencode-backend.md §5.9 / Phase 4 — handle to a short-lived
 * isolated server spawned for one tight-permission task. Caller is
 * responsible for `close()`-ing it in a `finally` so the loopback port
 * is released even when the inner work throws.
 */
export interface EphemeralOpencodeServerHandle {
  client: OpencodeClient;
  close: () => Promise<void>;
}

export interface OpencodeServerManager {
  readonly mode: OpencodeServerMode;
  /**
   * Ensure the underlying server is running with `desiredConfig`.
   * Managed: bounces when the canonical-hash of the desired config
   * differs from the running server's hash. Idempotent on same input.
   * Remote: no-op in Phase 5+.
   */
  ensureConfig(desiredConfig: OpencodeRuntimeConfig): Promise<void>;
  /** Resolve the live SDK client. Lazily spawns the server on first call. */
  client(): Promise<OpencodeClient>;
  /**
   * docs/design/appendices/opencode-backend.md §5.9 Path A — spawn an isolated ephemeral
   * server for a single tight-permission task. Used by
   * `runDelegatedTask` when the operator opts into `isolation: "ephemeral"`
   * (rare path: operator-supplied MCP context the primary server's
   * connections cannot be trusted with). Returns an
   * {@link EphemeralOpencodeServerHandle} the caller MUST close in
   * `finally` to release the loopback port.
   *
   * Managed: spawns a fresh `createOpencode()` independent of the
   * long-lived primary server's state. Remote: throws — Path A is
   * unavailable on a server the daemon does not own.
   */
  spawnEphemeral(
    config: OpencodeRuntimeConfig,
  ): Promise<EphemeralOpencodeServerHandle>;
  /** Stop the server child process and release resources. */
  shutdown(): Promise<void>;
}

/**
 * Hash a desired `OpencodeRuntimeConfig` deterministically so two
 * equivalent configs (regardless of key ordering or undefined fields)
 * produce the same hash. Reused for bounce-vs-noop decision.
 */
export function hashRuntimeConfig(config: OpencodeRuntimeConfig): string {
  // Drop `undefined` so { a: undefined } and {} canonicalise equal.
  const canonical = stableStringify(stripUndefined(config));
  return createHash("sha256").update(canonical).digest("hex");
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

export interface ManagedOpencodeServerManagerOptions {
  /** Loopback host. Default `127.0.0.1`. */
  hostname?: string;
  /** Port. `0` ⇒ OS chooses. Default `0`. */
  port?: number;
  /** Cold-start timeout per spawn (ms). Default 15 000. */
  spawnTimeoutMs?: number;
  /**
   * Inject the SDK's `createOpencode` for tests. Production code wires
   * this to the real export. The wrapper signature matches the real
   * SDK so the production path is type-safe.
   */
  createOpencodeImpl?: typeof createOpencode;
}

interface ServerState {
  client: OpencodeClient;
  server: { url: string; close(): void };
  runningHash: string;
  config: OpencodeRuntimeConfig;
  spawnedAt: number;
}

/**
 * Managed-mode lifecycle. Owns a single child process; bounces on
 * config-diff.
 *
 * Crash recovery: V6 fixtures show `server.close()` is synchronous and
 * does not throw on a stopped process. The manager treats a missing /
 * already-stopped server as "respawn on next ensureConfig". We don't
 * subscribe to `child_process` signals here because the SDK abstracts
 * them away; the next inbound `ensureConfig` will pay the cost of
 * detection if the server died.
 */
export class ManagedOpencodeServerManager implements OpencodeServerManager {
  readonly mode = "managed" as const;
  private state: ServerState | null = null;
  /** Coalesce concurrent ensureConfig / client calls onto a single spawn. */
  private inflight: Promise<ServerState> | null = null;
  private readonly hostname: string;
  private readonly port: number;
  private readonly spawnTimeoutMs: number;
  private readonly createOpencodeImpl: typeof createOpencode;
  private shutdownRequested = false;

  constructor(options: ManagedOpencodeServerManagerOptions = {}) {
    this.hostname = options.hostname ?? DEFAULT_HOSTNAME;
    this.port = options.port ?? 0;
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
    this.createOpencodeImpl = options.createOpencodeImpl ?? createOpencode;
  }

  async ensureConfig(desiredConfig: OpencodeRuntimeConfig): Promise<void> {
    if (this.shutdownRequested) {
      throw new Error("OpencodeServerManager has been shut down");
    }
    const desiredHash = hashRuntimeConfig(desiredConfig);
    if (this.state && this.state.runningHash === desiredHash) {
      return;
    }
    await this.spawn(desiredConfig, desiredHash);
  }

  async client(): Promise<OpencodeClient> {
    if (this.shutdownRequested) {
      throw new Error("OpencodeServerManager has been shut down");
    }
    if (!this.state) {
      // Lazy first-spawn with an empty config — callers that want
      // specific config should call ensureConfig() first.
      await this.spawn({}, hashRuntimeConfig({}));
    }
    return this.state!.client;
  }

  async spawnEphemeral(
    config: OpencodeRuntimeConfig,
  ): Promise<EphemeralOpencodeServerHandle> {
    if (this.shutdownRequested) {
      throw new Error("OpencodeServerManager has been shut down");
    }
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(new Error("opencode ephemeral spawn timeout")),
      this.spawnTimeoutMs,
    );
    const start = Date.now();
    try {
      const { client, server } = await this.createOpencodeImpl({
        hostname: this.hostname,
        port: 0,
        signal: abortController.signal,
        timeout: this.spawnTimeoutMs,
        config: config as Config,
      });
      logger.info(
        { url: server.url, spawnMs: Date.now() - start, ephemeral: true },
        "opencode ephemeral server spawned",
      );
      return {
        client,
        close: async () => {
          try {
            server.close();
          } catch (err) {
            logger.warn({ err }, "opencode ephemeral server close threw");
          }
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (this.state) {
      const { server } = this.state;
      try {
        server.close();
      } catch (err) {
        logger.warn({ err }, "opencode server close threw");
      }
      this.state = null;
    }
  }

  /** Lifecycle introspection — useful for diagnostics and tests. */
  get isRunning(): boolean {
    return this.state !== null;
  }

  get currentHash(): string | null {
    return this.state?.runningHash ?? null;
  }

  private async spawn(
    config: OpencodeRuntimeConfig,
    hash: string,
  ): Promise<ServerState> {
    // Coalesce concurrent spawn attempts so a flurry of ensureConfig
    // calls (e.g. on first boot) doesn't fire multiple child processes.
    if (this.inflight) {
      const state = await this.inflight;
      if (state.runningHash === hash) return state;
      // Different hash — fall through to bounce.
    }
    const spawnPromise = this.doSpawn(config, hash);
    this.inflight = spawnPromise;
    try {
      const state = await spawnPromise;
      return state;
    } finally {
      this.inflight = null;
    }
  }

  private async doSpawn(
    config: OpencodeRuntimeConfig,
    hash: string,
  ): Promise<ServerState> {
    if (this.state) {
      const previousHash = this.state.runningHash;
      const ageMs = Date.now() - this.state.spawnedAt;
      try {
        this.state.server.close();
      } catch (err) {
        logger.warn({ err }, "opencode server close threw during bounce");
      }
      this.state = null;
      logger.info(
        { previousHash: previousHash.slice(0, 12), newHash: hash.slice(0, 12), ageMs },
        "opencode server bounced",
      );
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(new Error("opencode spawn timeout")),
      this.spawnTimeoutMs,
    );
    const start = Date.now();
    try {
      const { client, server } = await this.createOpencodeImpl({
        hostname: this.hostname,
        port: this.port,
        signal: abortController.signal,
        timeout: this.spawnTimeoutMs,
        config: config as Config,
      });
      const next: ServerState = {
        client,
        server,
        runningHash: hash,
        config,
        spawnedAt: Date.now(),
      };
      this.state = next;
      logger.info(
        {
          url: server.url,
          hash: hash.slice(0, 12),
          spawnMs: Date.now() - start,
        },
        "opencode server spawned",
      );
      return next;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Phase 2 factory: only the Managed variant exists today. Phase 5 adds
 * a `RemoteOpencodeServerManager` branch keyed on a runtime setting.
 * The factory contract keeps callers backend-shape-agnostic.
 */
export function createOpencodeServerManager(
  options: ManagedOpencodeServerManagerOptions = {},
): OpencodeServerManager {
  return new ManagedOpencodeServerManager(options);
}

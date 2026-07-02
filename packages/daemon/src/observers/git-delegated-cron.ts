import type Database from "better-sqlite3";
import {
  createEvent,
  DEFAULT_CLAUDE_LITE_MODEL,
  EventPriority,
  latestLiteFor,
  type AgentTaskEvent,
  type BackendId,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";
import type { EventBus } from "../core/event-bus.js";
import { readIntegrations } from "../db/integrations-store.js";
import {
  proxyModelIsKnown,
  resolveCanonicalDelegatedModel,
} from "../core/backends/proxy-model-registry.js";
import { createLogger } from "../logging.js";
import type { Observer } from "./manager.js";

const logger = createLogger("git-delegated-cron");

export const GIT_DELEGATED_CRON_OBSERVER_NAME = "git-delegated-cron";
export const GIT_DELEGATED_PROCESS_KEY = "git.lifecycle.poll";

const MIN_CADENCE_SECONDS = 600;

interface GitDelegatedCronOptions {
  db: Database.Database;
  eventBus: EventBus;
  repoPaths: readonly string[];
  githubRepos: readonly string[];
  cadenceSeconds: number;
  pushOverdueMinutes: number;
  activityScanEnabled?: boolean;
  now?: () => Date;
}

interface DelegatedScope {
  backend: BackendId;
  modelId: string;
  integrations: IntegrationKey[];
}

export function hasActiveDelegatedGitLifecycleIntegration(
  db: Database.Database,
  override?: { key: IntegrationKey; state: IntegrationState },
): boolean {
  const integrations = readIntegrations(db);
  if (override && (override.key === "git" || override.key === "github")) {
    integrations[override.key] = override.state;
  }
  return (
    integrations.git.mode === "delegated"
    || integrations.github.mode === "delegated"
  );
}

function cadenceSeconds(value: number): number {
  if (!Number.isFinite(value)) return 3600;
  return Math.max(MIN_CADENCE_SECONDS, Math.floor(value));
}

export class GitDelegatedCronObserver implements Observer {
  readonly name = GIT_DELEGATED_CRON_OBSERVER_NAME;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private readonly cadenceSeconds: number;
  private readonly now: () => Date;

  constructor(private readonly options: GitDelegatedCronOptions) {
    this.cadenceSeconds = cadenceSeconds(options.cadenceSeconds);
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    this.scheduleNext(this.initialDelaySeconds());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const scopes = this.delegatedScopes();
      if (scopes.length === 0) return 0;

      let emitted = 0;
      for (const scope of scopes) {
        const event = this.buildEvent(scope);
        await this.options.eventBus.put(event);
        emitted += 1;
      }
      if (emitted > 0) {
        logger.info(
          { emitted, cadenceSeconds: this.cadenceSeconds },
          "Queued delegated Git lifecycle poll event(s)",
        );
      }
      return emitted;
    } catch (err) {
      logger.warn({ err }, "Delegated Git lifecycle poll tick failed");
      return 0;
    } finally { /* c8 ignore next */
      this.running = false;
    }
  }

  private scheduleNext(delaySeconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.scheduleNext(this.cadenceSeconds));
    }, delaySeconds * 1000);
    this.timer.unref?.();
  }

  private initialDelaySeconds(): number {
    // Keep 1h delegated Git checks away from routine.activity_scan. This is
    // the collision-avoidance rule from the Git lifecycle design: no session
    // reuse, just a 30-minute offset to avoid light-tier concurrency spikes.
    if (this.options.activityScanEnabled && this.cadenceSeconds === 3600) {
      return 30 * 60;
    }
    return this.cadenceSeconds;
  }

  private delegatedScopes(): DelegatedScope[] {
    const integrations = readIntegrations(this.options.db);
    const grouped = new Map<string, DelegatedScope>();
    this.addScope(grouped, "git", integrations.git);
    this.addScope(grouped, "github", integrations.github);
    return [...grouped.values()];
  }

  private addScope(
    grouped: Map<string, DelegatedScope>,
    integration: "git" | "github",
    state: IntegrationState,
  ): void {
    if (state.mode !== "delegated" || !state.delegatedBackend) return;
    const backend = state.delegatedBackend;
    const modelId = this.resolveModel(backend, state);
    const key = `${backend}:${modelId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.integrations.push(integration);
      return;
    }
    grouped.set(key, { backend, modelId, integrations: [integration] });
  }

  private resolveModel(backend: BackendId, state: IntegrationState): string {
    const pinned = state.delegatedModel ?? null;
    if (pinned && proxyModelIsKnown(this.options.db, backend, pinned)) {
      return pinned;
    }
    const canonical = resolveCanonicalDelegatedModel(backend, this.options.db);
    // `resolveCanonicalDelegatedModel` already returns the registry lite pick
    // (`latestLiteFor`) when nothing is pinned, so `canonical` is null only in
    // the impossible case where the registry carries no lite model for the
    // backend. Fall back to a registry-sourced constant rather than a
    // hardcoded per-backend literal (which also mis-mapped `opencode`).
    /* c8 ignore next — unreachable while the model registry carries lite models for all backends */
    return canonical ?? latestLiteFor(backend) ?? DEFAULT_CLAUDE_LITE_MODEL;
  }

  private buildEvent(scope: DelegatedScope): AgentTaskEvent {
    const activeIntegrations = scope.integrations;
    const task =
      activeIntegrations.length === 2
        ? "Run delegated Git and GitHub lifecycle poll."
        : activeIntegrations[0] === "git"
          ? "Run delegated Git lifecycle poll."
          : "Run delegated GitHub lifecycle poll.";
    const base = createEvent({
      type: "scheduled.task",
      source: GIT_DELEGATED_CRON_OBSERVER_NAME,
      priority: EventPriority.NORMAL,
    });
    return {
      ...base,
      task,
      taskContext: {
        triggerSource: "integration_delegated_cron",
        processKey: GIT_DELEGATED_PROCESS_KEY,
        backend: scope.backend,
        activeIntegrations,
        repoPaths: [...this.options.repoPaths],
        githubRepos: [...this.options.githubRepos],
        cadenceSeconds: this.cadenceSeconds,
        pushOverdueMinutes: this.options.pushOverdueMinutes,
        firedAt: this.now().toISOString(),
      },
      requestedBackendId: scope.backend,
      requestedModelId: scope.modelId,
    };
  }
}

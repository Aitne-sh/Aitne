import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { createEvent, EventPriority } from "@aitne/shared";
import type { EventBus } from "../core/event-bus.js";
import { recordObservation } from "../db/observations.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { Observer } from "./manager.js";
import { createLogger } from "../logging.js";
import {
  classifyGitLifecycleEvent,
  type GitEventClassification,
  type GitLifecycleEventType,
  type GitObservationActor,
  type GitObservationChangeType,
} from "./git-event-classifier.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("git-watcher");

const LOCAL_GIT_TIMEOUT_MS = 10_000;
const REMOTE_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_PUSH_OVERDUE_MINUTES = 60;

interface GitWatcherOptions {
  pushOverdueMinutes?: number;
  now?: () => number;
  eventBus?: EventBus;
  onRepoBaseline?: (repoPath: string) => void | Promise<void>;
  onLifecycleObservation?: (
    classification: Extract<GitEventClassification, { kind: "observe" }>,
  ) => void | Promise<void>;
  /**
   * Per-repo credential resolver (P5 multi-account). Returns the env
   * overlay that remote-touching `git` calls against `repoPath` should
   * run under — most commonly
   * `{GH_TOKEN, GIT_ASKPASS, PA_GIT_TOKEN, GIT_TERMINAL_PROMPT}`
   * built by `GitAccountRegistry.buildSpawnEnv`. Repos without a
   * configured `accountAlias` resolve to `undefined`, in which case the
   * call runs in the daemon's own env (the legacy single-account path).
   *
   * The resolver is consulted for every remote operation —
   * `git fetch`, `git ls-remote --heads/--tags`, and
   * `git ls-remote --symref` — because each opens a fresh authenticated
   * connection (a prior fetch's auth doesn't carry over unless the user
   * has a credential helper installed, which we cannot assume). Local
   * commands (`git rev-parse`, `git log`, `merge-base`) skip the resolver.
   *
   * Resolver exceptions are caught at the call site and logged so a
   * misconfigured alias does not stall the entire poll cycle.
   */
  repoEnvResolver?: (repoPath: string) => Promise<NodeJS.ProcessEnv | undefined>;
  /**
   * Per-row poll-cadence overrides (unified-repositories §5). Each entry
   * maps `repoPath → poll_interval_sec`; `null`/missing entries fall
   * back to `pollIntervalSeconds`. The watcher's global `setInterval`
   * still ticks at `pollIntervalSeconds`; on each tick, repos whose
   * next-fire timestamp hasn't elapsed are skipped. Per-row intervals
   * therefore can only be longer than the global tick, which matches
   * the "throttle expensive repos" intent.
   *
   * Optional — when omitted, every repo polls on every tick (the
   * pre-unification behaviour).
   */
  repoIntervals?: ReadonlyMap<string, number | null>;
  /**
   * Optional commit-attribution tracker (C1). When provided, observations
   * whose SHA matches a recently-marked agent commit are tagged
   * `actor='agent'` instead of the historical `'user'` / `'unknown'`
   * defaults. When absent (legacy callers, fixtures) the watcher falls
   * back to the pre-fix literals — strict no-op for existing behaviour.
   */
  writeTracker?: AgentWriteTracker;
}

interface RemoteSnapshot {
  branches: Map<string, string>;
  tags: Map<string, string>;
  defaultBranch: string | null;
}

interface LocalAheadState {
  branch: string;
  upstreamRef: string;
  upstreamHash: string;
  /**
   * Fallback anchor used only when git cannot tell us the oldest unpushed
   * commit's timestamp (e.g. corrupted refs, very shallow checkout). When
   * git provides a real timestamp via `git log --format=%ct --reverse`, the
   * cached value is ignored — that lets a rebase that rewrites committer
   * times reset the staleness clock automatically.
   */
  fallbackFirstSeenAtMs: number;
  emittedRef: string | null;
}

/**
 * GitWatcher — detects local and remote Git lifecycle changes across
 * monitored repositories.
 *
 * Polls each repo at a configurable interval. Local HEAD changes are recorded
 * as before; remote lifecycle signals are detected by fetching origin and
 * diffing the latest remote heads/tags against an in-memory cold-start
 * baseline.
 */
export class GitWatcher implements Observer {
  readonly name = "git";

  /** Tracks the last known commit hash per repository */
  private readonly lastCommitHash = new Map<string, string>();
  private readonly remoteSnapshots = new Map<string, RemoteSnapshot>();
  private readonly localAheadStates = new Map<string, LocalAheadState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  /** Webhook fallback: when webhook is healthy, poll less frequently */
  private readonly normalIntervalSeconds: number;
  private readonly reducedIntervalSeconds: number;
  private readonly pushOverdueMs: number;
  private readonly now: () => number;
  private readonly eventBus: EventBus | null;
  private readonly onRepoBaseline: ((repoPath: string) => void | Promise<void>) | null;
  private readonly onLifecycleObservation:
    | ((
        classification: Extract<GitEventClassification, { kind: "observe" }>,
      ) => void | Promise<void>)
    | null;
  private readonly repoEnvResolver:
    | ((repoPath: string) => Promise<NodeJS.ProcessEnv | undefined>)
    | null;
  private readonly repoIntervals: ReadonlyMap<string, number | null>;
  private readonly writeTracker: AgentWriteTracker | null;
  /** Per-row next-fire timestamp; `0` (or missing) means "due immediately". */
  private readonly nextFireAt = new Map<string, number>();
  private lastWebhookEventAt = 0;
  private webhookEnabled = false;
  /** Duration (ms) of no webhook events before restoring full-frequency polling */
  private static readonly WEBHOOK_STALE_MS = 10 * 60 * 1000; // 10 minutes

  constructor(
    private readonly repoPaths: string[],
    private readonly db: Database.Database,
    private readonly pollIntervalSeconds: number = 300,
    options: GitWatcherOptions = {},
  ) {
    this.normalIntervalSeconds = pollIntervalSeconds;
    // When webhook is active, poll 6x less frequently
    this.reducedIntervalSeconds = pollIntervalSeconds * 6;
    this.pushOverdueMs =
      (options.pushOverdueMinutes ?? DEFAULT_PUSH_OVERDUE_MINUTES) * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.eventBus = options.eventBus ?? null;
    this.onRepoBaseline = options.onRepoBaseline ?? null;
    this.onLifecycleObservation = options.onLifecycleObservation ?? null;
    this.repoEnvResolver = options.repoEnvResolver ?? null;
    this.repoIntervals = options.repoIntervals ?? new Map();
    this.writeTracker = options.writeTracker ?? null;
  }

  /**
   * Resolve an observation's `actor` against the agent-commit tracker
   * (C1). When the tracker has been notified that the daemon just
   * committed `sha` to `repoPath`, the observation flips to
   * `'agent'`; otherwise the historical fallback (`'user'` for local
   * HEAD changes, `'unknown'` for remote-side events) is preserved so
   * absence of the tracker is a strict no-op.
   *
   * Deletion-event sites pass no SHA — those keep the fallback
   * verbatim.
   */
  private resolveActor(
    repoPath: string,
    sha: string | null | undefined,
    fallback: GitObservationActor,
  ): GitObservationActor {
    if (!sha) return fallback;
    return this.writeTracker?.isAgentCommit(repoPath, sha) ? "agent" : fallback;
  }

  /**
   * Per-row scheduling gate (unified-repositories §5). Override is
   * recognized only when longer than the global tick — the global
   * `setInterval` already enforces "every tick" for repos without an
   * override, so per-row gating only adds value for repos that should
   * poll *less* often.
   */
  private getRepoOverrideSeconds(repoPath: string): number | null {
    const override = this.repoIntervals.get(repoPath);
    if (typeof override === "number" && override > this.normalIntervalSeconds) {
      return override;
    }
    return null;
  }

  private isRepoDue(repoPath: string, nowMs: number): boolean {
    const override = this.getRepoOverrideSeconds(repoPath);
    if (override === null) return true;
    const next = this.nextFireAt.get(repoPath);
    return next === undefined || nowMs >= next;
  }

  private markRepoFired(repoPath: string, nowMs: number): void {
    const override = this.getRepoOverrideSeconds(repoPath);
    if (override === null) return;
    this.nextFireAt.set(repoPath, nowMs + override * 1000);
  }

  /**
   * Enable webhook-aware mode. When enabled, polling frequency is reduced
   * while the webhook is healthy. Call notifyWebhookEvent() on each
   * received webhook to keep the "healthy" timer alive.
   */
  enableWebhookMode(): void {
    this.webhookEnabled = true;
    this.lastWebhookEventAt = Date.now();
    this.restartTimer();
    logger.info("Webhook mode enabled — polling frequency reduced");
  }

  /** Called by the GitHub webhook handler to signal a live webhook */
  notifyWebhookEvent(): void {
    this.lastWebhookEventAt = Date.now();
  }

  /** Check if webhook is healthy (received an event recently) */
  private isWebhookHealthy(): boolean {
    if (!this.webhookEnabled) return false;
    return Date.now() - this.lastWebhookEventAt < GitWatcher.WEBHOOK_STALE_MS;
  }

  private getCurrentInterval(): number {
    return this.isWebhookHealthy()
      ? this.reducedIntervalSeconds
      : this.normalIntervalSeconds;
  }

  private restartTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    const interval = this.getCurrentInterval();
    // Track the active interval so `maybeAdjustFrequency` doesn't re-restart on
    // its next tick — without this, callers that go through `restartTimer`
    // directly (e.g. `enableWebhookMode`) leave `lastUsedInterval` stale and
    // cause one redundant restart per webhook transition.
    this.lastUsedInterval = interval;
    this.pollTimer = setInterval(
      () => {
        void this.poll();
        // Check if we need to switch frequency
        this.maybeAdjustFrequency();
      },
      interval * 1000,
    );
  }

  private lastUsedInterval = 0;
  private maybeAdjustFrequency(): void {
    const newInterval = this.getCurrentInterval();
    if (newInterval !== this.lastUsedInterval) {
      this.lastUsedInterval = newInterval;
      this.restartTimer();
      logger.info(
        { intervalSeconds: newInterval, webhookHealthy: this.isWebhookHealthy() },
        "Git poll frequency adjusted",
      );
    }
  }

  async start(): Promise<void> {
    if (this.repoPaths.length === 0) return;

    // Initialize with current local/remote state for each repo. The initial
    // remote snapshot is a baseline, not an event source; otherwise enabling
    // the watcher on an existing repo would flood observations for every
    // existing branch and tag.
    await Promise.all(
      this.repoPaths.map(async (repo) => {
        const hash = await this.getLatestHash(repo);
        if (hash) this.lastCommitHash.set(repo, hash);
        await this.initializeRemoteSnapshot(repo);
        await this.updateLocalAheadBaseline(repo);
        await this.notifyRepoBaseline(repo);
      }),
    );

    // Start polling at normal frequency (adjusted if webhook mode is enabled)
    this.lastUsedInterval = this.getCurrentInterval();
    this.pollTimer = setInterval(
      () => {
        void this.poll();
        this.maybeAdjustFrequency();
      },
      this.lastUsedInterval * 1000,
    );

    logger.info(
      { repos: this.repoPaths.length, intervalSeconds: this.pollIntervalSeconds },
      "Git watcher started",
    );
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("Git watcher stopped");
  }

  /** Poll all repos for new commits — per-row scheduling honored. */
  private async poll(): Promise<void> {
    if (this.polling) {
      logger.debug("Git poll skipped because previous poll is still running");
      return;
    }
    this.polling = true;
    try {
      const nowMs = this.now();
      const due = this.repoPaths.filter((repo) => this.isRepoDue(repo, nowMs));
      if (due.length < this.repoPaths.length) {
        logger.debug(
          {
            scheduled: this.repoPaths.length,
            due: due.length,
            skipped: this.repoPaths.length - due.length,
          },
          "Git poll — per-row gate skipped some repos",
        );
      }
      await Promise.all(
        due.map(async (repo) => {
          await this.checkRepo(repo);
          this.markRepoFired(repo, nowMs);
        }),
      );
    } finally {
      this.polling = false;
    }
  }

  private async notifyRepoBaseline(repoPath: string): Promise<void> {
    if (!this.onRepoBaseline) return;
    try {
      await this.onRepoBaseline(repoPath);
    } catch (err) {
      logger.warn({ err, repo: repoPath }, "Git repo baseline callback failed");
    }
  }

  private async checkRepo(repoPath: string): Promise<void> {
    await this.checkLocalHead(repoPath);
    await this.checkRemoteRefs(repoPath);
    await this.checkLocalAhead(repoPath);
  }

  private async checkLocalHead(repoPath: string): Promise<void> {
    try {
      const currentHash = await this.getLatestHash(repoPath);
      if (!currentHash) return;

      const previousHash = this.lastCommitHash.get(repoPath);
      if (previousHash === currentHash) return;

      // New local commit(s) detected
      this.lastCommitHash.set(repoPath, currentHash);

      // Skip if this is the first check (initialization)
      if (!previousHash) return;

      // Get commit details
      const commitInfo = await this.getCommitRangeInfo(
        repoPath,
        previousHash,
        currentHash,
      );
      const changedFiles = await this.getChangedFiles(
        repoPath,
        previousHash,
        currentHash,
      );

      recordObservation(this.db, {
        source: `git:${repoPath}`,
        ref: currentHash,
        changeType: "modified",
        actor: this.resolveActor(repoPath, currentHash, "user"),
        payload: {
          repoPath,
          commitHash: currentHash,
          previousHash,
          commitInfo,
          changedFiles,
        },
      });
      logger.info(
        { repo: repoPath, hash: currentHash.slice(0, 8) },
        "Git observation recorded",
      );
    } catch (err) {
      logger.error({ repo: repoPath, err }, "Failed to check local git HEAD");
    }
  }

  private async initializeRemoteSnapshot(repoPath: string): Promise<void> {
    try {
      const env = await this.resolveRepoEnv(repoPath);
      const fetched = await this.fetchOrigin(repoPath, env);
      if (!fetched) return;
      const snapshot = await this.readRemoteSnapshot(repoPath, env);
      if (snapshot) {
        this.remoteSnapshots.set(repoPath, snapshot);
      }
    } catch (err) {
      logger.debug({ repo: repoPath, err }, "Failed to initialize git remote snapshot");
    }
  }

  private async checkRemoteRefs(repoPath: string): Promise<void> {
    try {
      const env = await this.resolveRepoEnv(repoPath);
      const fetched = await this.fetchOrigin(repoPath, env);
      if (!fetched) return;
      const current = await this.readRemoteSnapshot(repoPath, env);
      if (!current) return;

      const previous = this.remoteSnapshots.get(repoPath);
      this.remoteSnapshots.set(repoPath, current);
      if (!previous) return;

      await this.recordRemoteBranchDiff(repoPath, previous, current);
      this.recordRemoteTagDiff(repoPath, previous, current);
    } catch (err) {
      logger.error({ repo: repoPath, err }, "Failed to check git remote refs");
    }
  }

  private async recordRemoteBranchDiff(
    repoPath: string,
    previous: RemoteSnapshot,
    current: RemoteSnapshot,
  ): Promise<void> {
    for (const [branch, remoteHash] of current.branches) {
      const previousRemoteHash = previous.branches.get(branch);
      if (!previousRemoteHash) {
        this.recordGitLifecycleObservation({
          repoPath,
          eventType: "git.branch.created",
          ref: `branch_created:${branch}:${remoteHash}`,
          changeType: "created",
          actor: this.resolveActor(repoPath, remoteHash, "unknown"),
          payload: {
            branch,
            remoteHash,
            defaultBranch: current.defaultBranch,
          },
        });
        continue;
      }
      if (previousRemoteHash === remoteHash) continue;

      const forcePush = await this.isAncestor(
        repoPath,
        previousRemoteHash,
        remoteHash,
      );
      const forcePushDetected = forcePush === false;
      // An ancestry-check failure on the default branch silently suppresses
      // the only DM-by-default event in the entire git surface
      // (`git.push.force_pushed`). Surface it at WARN so an operator
      // monitoring logs notices a missed force-push detection. Non-default
      // branches stay at debug (the signal already isn't DM-grade for those).
      if (forcePush === null && branch === current.defaultBranch) {
        logger.warn(
          { repo: repoPath, branch, previousRemoteHash, remoteHash },
          "Git force-push check failed on default branch — force-push detection skipped",
        );
      }
      const payload = {
        branch,
        defaultBranch: current.defaultBranch,
        remoteHash,
        previousRemoteHash,
        forcePush: forcePushDetected,
        forcePushCheck: forcePush === null ? "unknown" : "known",
      };

      this.recordGitLifecycleObservation({
        repoPath,
        eventType: "git.push.detected",
        ref: `push:${branch}:${remoteHash}`,
        changeType: "modified",
        actor: this.resolveActor(repoPath, remoteHash, "unknown"),
        payload,
      });

      if (forcePushDetected) {
        this.recordGitLifecycleObservation({
          repoPath,
          eventType: "git.push.force_pushed",
          ref: `force_push:${branch}:${previousRemoteHash}->${remoteHash}`,
          changeType: "modified",
          actor: this.resolveActor(repoPath, remoteHash, "unknown"),
          payload,
        });
      }

      if (branch === current.defaultBranch) {
        this.recordGitLifecycleObservation({
          repoPath,
          eventType: "git.merge_to_default",
          ref: `merge_to_default:${branch}:${remoteHash}`,
          changeType: "modified",
          actor: this.resolveActor(repoPath, remoteHash, "unknown"),
          payload,
        });
      }
    }

    for (const [branch, previousRemoteHash] of previous.branches) {
      if (current.branches.has(branch)) continue;
      // Branch deletion carries no SHA we can attribute back to a
      // tracker mark — the previousRemoteHash describes what *was*
      // deleted, not who deleted it. Stays "unknown" by design (C1).
      this.recordGitLifecycleObservation({
        repoPath,
        eventType: "git.branch.deleted",
        ref: `branch_deleted:${branch}:${previousRemoteHash}`,
        changeType: "deleted",
        actor: "unknown",
        payload: {
          branch,
          previousRemoteHash,
          defaultBranch: current.defaultBranch,
        },
      });
    }
  }

  private recordRemoteTagDiff(
    repoPath: string,
    previous: RemoteSnapshot,
    current: RemoteSnapshot,
  ): void {
    for (const [tag, tagHash] of current.tags) {
      if (previous.tags.has(tag)) continue;
      this.recordGitLifecycleObservation({
        repoPath,
        eventType: "git.tag.created",
        ref: `tag_created:${tag}:${tagHash}`,
        changeType: "created",
        actor: this.resolveActor(repoPath, tagHash, "unknown"),
        payload: {
          tag,
          tagHash,
          defaultBranch: current.defaultBranch,
        },
      });
    }

    for (const [tag, previousTagHash] of previous.tags) {
      if (current.tags.has(tag)) continue;
      // Tag deletion carries no SHA we can attribute back to a tracker
      // mark — same reasoning as branch.deleted above. Stays "unknown"
      // by design (C1).
      this.recordGitLifecycleObservation({
        repoPath,
        eventType: "git.tag.deleted",
        ref: `tag_deleted:${tag}:${previousTagHash}`,
        changeType: "deleted",
        actor: "unknown",
        payload: {
          tag,
          previousTagHash,
          defaultBranch: current.defaultBranch,
        },
      });
    }
  }

  private async updateLocalAheadBaseline(repoPath: string): Promise<void> {
    const ahead = await this.getLocalAheadInfo(repoPath);
    if (!ahead) return;
    this.localAheadStates.set(ahead.key, {
      branch: ahead.branch,
      upstreamRef: ahead.upstreamRef,
      upstreamHash: ahead.upstreamHash,
      fallbackFirstSeenAtMs: this.now(),
      emittedRef: null,
    });
  }

  private async checkLocalAhead(repoPath: string): Promise<void> {
    try {
      const ahead = await this.getLocalAheadInfo(repoPath);
      if (!ahead) {
        this.clearLocalAheadStatesForRepo(repoPath);
        return;
      }

      // Reset only when the upstream changes (the user pushed and is ahead
      // again, or upstream was force-pushed). A new commit on top of unpushed
      // work keeps the same upstream and must NOT reset the staleness clock —
      // the design's "stale local-ahead" intent is one alert per ahead-period.
      const existing = this.localAheadStates.get(ahead.key);
      const upstreamChanged =
        !existing
        || existing.upstreamHash !== ahead.upstreamHash
        || existing.upstreamRef !== ahead.upstreamRef;
      const state: LocalAheadState = upstreamChanged
        ? {
            branch: ahead.branch,
            upstreamRef: ahead.upstreamRef,
            upstreamHash: ahead.upstreamHash,
            fallbackFirstSeenAtMs: this.now(),
            emittedRef: null,
          }
        : (existing as LocalAheadState);
      if (upstreamChanged) this.localAheadStates.set(ahead.key, state);

      // Anchor the staleness clock on the OLDEST unpushed commit's committer
      // time. Using HEAD's timestamp instead would silently reset the clock
      // every time a new commit lands on top of unpushed work — a developer
      // who keeps committing without pushing would never see the warning.
      const anchorMs = ahead.oldestUnpushedCommittedAtMs ?? state.fallbackFirstSeenAtMs;
      const staleForMs = this.now() - anchorMs;
      // Ref intentionally omits headHash: one observation per (branch,
      // upstream) ahead-period regardless of how many top commits land
      // during that period.
      const ref = `local_ahead_stale:${ahead.branch}:${ahead.upstreamHash}`;
      if (staleForMs < this.pushOverdueMs || state.emittedRef === ref) {
        return;
      }
      if (this.hasObservationEver(`git:${repoPath}`, ref)) {
        state.emittedRef = ref;
        return;
      }

      this.recordGitLifecycleObservation({
        repoPath,
        eventType: "git.local_ahead.stale",
        ref,
        changeType: "modified",
        actor: this.resolveActor(repoPath, ahead.headHash, "user"),
        payload: {
          branch: ahead.branch,
          upstreamRef: ahead.upstreamRef,
          upstreamHash: ahead.upstreamHash,
          headHash: ahead.headHash,
          aheadCount: ahead.aheadCount,
          oldestUnpushedCommittedAt: ahead.oldestUnpushedCommittedAtMs === null
            ? null
            : new Date(ahead.oldestUnpushedCommittedAtMs).toISOString(),
          staleForMinutes: Math.floor(staleForMs / 60_000),
          pushOverdueMinutes: Math.floor(this.pushOverdueMs / 60_000),
        },
      });
      state.emittedRef = ref;
    } catch (err) {
      logger.error({ repo: repoPath, err }, "Failed to check git local-ahead state");
    }
  }

  private clearLocalAheadStatesForRepo(repoPath: string): void {
    const prefix = `${repoPath}::`;
    for (const key of this.localAheadStates.keys()) {
      if (key.startsWith(prefix)) {
        this.localAheadStates.delete(key);
      }
    }
  }

  private async getLocalAheadInfo(repoPath: string): Promise<{
    key: string;
    branch: string;
    upstreamRef: string;
    upstreamHash: string;
    headHash: string;
    aheadCount: number;
    oldestUnpushedCommittedAtMs: number | null;
  } | null> {
    const branch = await this.getCurrentBranch(repoPath);
    if (!branch) return null;

    const upstreamRef = await this.getUpstreamRef(repoPath, branch);
    if (!upstreamRef) return null;

    const [headHash, upstreamHash] = await Promise.all([
      this.getLatestHash(repoPath),
      this.getRevParse(repoPath, upstreamRef),
    ]);
    if (!headHash || !upstreamHash || headHash === upstreamHash) return null;

    const aheadCount = await this.getAheadCount(repoPath, upstreamRef);
    if (aheadCount <= 0) return null;
    const oldestUnpushedCommittedAtMs = await this.getOldestUnpushedCommitTimestampMs(
      repoPath,
      upstreamRef,
    );

    return {
      key: `${repoPath}::${branch}`,
      branch,
      upstreamRef,
      upstreamHash,
      headHash,
      aheadCount,
      oldestUnpushedCommittedAtMs,
    };
  }

  /**
   * Resolve the env overlay once per remote-touching operation chain.
   * Caller passes the result to `fetchOrigin` and `readRemoteSnapshot`
   * so a single poll cycle for a given repo doesn't double-call the
   * resolver (which would double-spend `gh auth token` rate budget).
   * Returns `undefined` for repos without an alias OR when the resolver
   * throws — both fall back to the daemon's own env.
   */
  private async resolveRepoEnv(
    repoPath: string,
  ): Promise<NodeJS.ProcessEnv | undefined> {
    if (!this.repoEnvResolver) return undefined;
    try {
      return await this.repoEnvResolver(repoPath);
    } catch (err) {
      logger.warn(
        { repo: repoPath, err },
        "Git per-repo credential resolution failed — falling back to default env",
      );
      return undefined;
    }
  }

  private async fetchOrigin(
    repoPath: string,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<boolean> {
    try {
      await execFileAsync(
        "git",
        ["fetch", "--prune", "--tags", "origin"],
        { cwd: repoPath, timeout: REMOTE_GIT_TIMEOUT_MS, ...(env ? { env } : {}) },
      );
      return true;
    } catch (err) {
      if (this.remoteSnapshots.has(repoPath)) {
        logger.warn({ repo: repoPath, err }, "Git origin fetch failed");
      } else {
        logger.debug({ repo: repoPath, err }, "Git origin fetch skipped");
      }
      return false;
    }
  }

  private async readRemoteSnapshot(
    repoPath: string,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<RemoteSnapshot | null> {
    const [branches, tags] = await Promise.all([
      this.readRemoteRefs(repoPath, "heads", env),
      this.readRemoteRefs(repoPath, "tags", env),
    ]);
    if (!branches || !tags) return null;
    const defaultBranch = await this.getDefaultBranch(repoPath, branches, env);
    return { branches, tags, defaultBranch };
  }

  private async readRemoteRefs(
    repoPath: string,
    kind: "heads" | "tags",
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<Map<string, string> | null> {
    try {
      const args =
        kind === "heads"
          ? ["ls-remote", "--heads", "origin"]
          : ["ls-remote", "--tags", "--refs", "origin"];
      const { stdout } = await execFileAsync(
        "git",
        args,
        { cwd: repoPath, timeout: REMOTE_GIT_TIMEOUT_MS, ...(env ? { env } : {}) },
      );
      return parseLsRemoteRefs(stdout, kind);
    } catch {
      return null;
    }
  }

  private async getDefaultBranch(
    repoPath: string,
    branches: Map<string, string>,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-remote", "--symref", "origin", "HEAD"],
        { cwd: repoPath, timeout: REMOTE_GIT_TIMEOUT_MS, ...(env ? { env } : {}) },
      );
      const parsed = parseDefaultBranch(stdout);
      if (parsed) return parsed;
    } catch {
      // Fall through to local heuristics.
    }
    if (branches.has("main")) return "main";
    if (branches.has("master")) return "master";
    return branches.keys().next().value ?? null;
  }

  private async isAncestor(
    repoPath: string,
    ancestorHash: string,
    descendantHash: string,
  ): Promise<boolean | null> {
    try {
      await execFileAsync(
        "git",
        ["merge-base", "--is-ancestor", ancestorHash, descendantHash],
        { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS },
      );
      return true;
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
      if (code === 1) return false;
      return null;
    }
  }

  private async getCurrentBranch(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS },
      );
      const branch = stdout.trim();
      return branch && branch !== "HEAD" ? branch : null;
    } catch {
      return null;
    }
  }

  private async getUpstreamRef(
    repoPath: string,
    branch: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS },
      );
      const upstream = stdout.trim();
      if (upstream) return upstream;
    } catch {
      // Fall back to origin/<branch> for repos that have not explicitly set
      // upstream tracking but follow the conventional remote branch shape.
    }

    const fallback = `origin/${branch}`;
    const hash = await this.getRevParse(repoPath, fallback);
    return hash ? fallback : null;
  }

  private async getRevParse(
    repoPath: string,
    revision: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--verify", revision],
        { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS },
      );
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private async getAheadCount(
    repoPath: string,
    upstreamRef: string,
  ): Promise<number> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-list", "--count", `${upstreamRef}..HEAD`],
        { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS },
      );
      const parsed = Number(stdout.trim());
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Committer time of the OLDEST unpushed commit reachable from HEAD but not
   * from `upstreamRef`. Anchors the local-ahead staleness clock so that a
   * stream of incremental commits on top of long-unpushed work doesn't reset
   * the timer (rebasing does, since rebase rewrites committer time — that is
   * the desired behaviour: an active rebase signals the user is working on
   * the unpushed range, not abandoning it).
   */
  private async getOldestUnpushedCommitTimestampMs(
    repoPath: string,
    upstreamRef: string,
  ): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "--format=%ct", "--reverse", `${upstreamRef}..HEAD`],
        { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS },
      );
      const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
      if (!first) return null;
      const seconds = Number(first.trim());
      return Number.isFinite(seconds) ? seconds * 1000 : null;
    } catch {
      return null;
    }
  }

  private recordGitLifecycleObservation(params: {
    repoPath: string;
    eventType: GitLifecycleEventType;
    ref: string;
    changeType: GitObservationChangeType;
    actor: GitObservationActor;
    payload: Record<string, unknown>;
  }): void {
    const classification = classifyGitLifecycleEvent(params);
    if (classification.kind === "skip") return;

    const isFresh = !this.hasObservationEver(
      classification.source,
      classification.ref,
    );

    recordObservation(this.db, {
      source: classification.source,
      ref: classification.ref,
      changeType: classification.changeType,
      actor: classification.actor,
      payload: classification.payload,
    });

    if (classification.emitEvent && isFresh && this.eventBus) {
      void this.eventBus.put(
        createEvent({
          type: classification.eventType,
          source: "git-watcher",
          priority: classification.priority,
          data: classification.payload,
        }),
      ).catch((err) => {
        logger.error(
          { err, eventType: classification.eventType, ref: classification.ref },
          "Failed to emit git lifecycle event",
        );
      });
    }
    if (isFresh && this.onLifecycleObservation) {
      Promise.resolve(this.onLifecycleObservation(classification)).catch((err) => {
        logger.warn(
          { err, eventType: classification.eventType, ref: classification.ref },
          "Git lifecycle observation callback failed",
        );
      });
    }

    logger.info(
      {
        repo: classification.payload.repoPath,
        eventType: classification.eventType,
        priority: EventPriority[classification.priority],
        emitted: classification.emitEvent && isFresh && this.eventBus !== null,
        ref: classification.ref,
      },
      "Git lifecycle observation recorded",
    );
  }

  private hasObservationEver(source: string, ref: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM observations WHERE source = ? AND ref = ? LIMIT 1")
      .get(source, ref);
    return row !== undefined;
  }

  /** Get the latest commit hash for a repo */
  private async getLatestHash(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS },
      );
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /** Get commit summaries and stat diff for the full observed range */
  private async getCommitRangeInfo(
    repoPath: string,
    fromHash: string,
    toHash: string,
  ): Promise<string> {
    try {
      const [logResult, statResult] = await Promise.all([
        execFileAsync("git", ["log", "--format=%h %s (%an, %ar)", `${fromHash}..${toHash}`],
          { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS }),
        execFileAsync("git", ["diff", "--stat", fromHash, toHash],
          { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS }),
      ]);

      const commits = logResult.stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      const stat = statResult.stdout.trim();
      return [...commits, stat].filter(Boolean).join("\n\n").slice(0, 3000);
    } catch {
      return `${fromHash.slice(0, 8)}..${toHash.slice(0, 8)}`;
    }
  }

  /** Get list of changed files between two commits */
  private async getChangedFiles(
    repoPath: string,
    fromHash: string,
    toHash: string,
  ): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--name-only", fromHash, toHash],
        { cwd: repoPath, timeout: LOCAL_GIT_TIMEOUT_MS },
      );
      return stdout
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);
    } catch {
      return [];
    }
  }
}

export function parseLsRemoteRefs(
  stdout: string,
  kind: "heads" | "tags",
): Map<string, string> {
  const prefix = kind === "heads" ? "refs/heads/" : "refs/tags/";
  const refs = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, refName] = trimmed.split(/\s+/, 2);
    if (!sha || !refName || !refName.startsWith(prefix)) continue;
    if (kind === "tags" && refName.endsWith("^{}")) continue;
    refs.set(refName.slice(prefix.length), sha);
  }
  return refs;
}

export function parseDefaultBranch(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/);
    if (match) return match[1];
  }
  return null;
}

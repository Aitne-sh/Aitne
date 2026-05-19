import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { createEvent, EventPriority } from "@aitne/shared";
import type { EventBus } from "../core/event-bus.js";
import { recordObservation } from "../db/observations.js";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";
import { createLogger } from "../logging.js";
import type { Observer } from "./manager.js";
import {
  classifyNotification,
  classifyWorkflowRun,
  parseGitHubRepoFullName,
  parseGitHubRemote,
  type Classification,
  type GitHubNotification,
  type GitHubWorkflowRun,
} from "./github-poller-classifier.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("github-poller");

const NOTIF_ETAG_KEY = "github_poller.notifications_etag";
const NOTIF_LAST_MODIFIED_KEY = "github_poller.notifications_last_modified";

/**
 * Identifier for a watched GitHub repository. Resolved from a local path
 * via `git remote get-url origin` at startup, OR injected directly via
 * `GitHubPollerOptions.repoBindings` for tests.
 *
 * `accountAlias` (P5 multi-account) is opaque to the poller — it's
 * forwarded to the `accountResolver` callback verbatim. Resolution to a
 * concrete `GH_TOKEN` happens inside the resolver so the poller stays
 * decoupled from the credential store layout.
 */
export interface RepoBinding {
  localPath?: string;
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  accountAlias?: string;
}

export interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runner contract — accepts an optional `env` overlay so a per-repo
 * credential injection (P5 multi-account) can scope `GH_TOKEN` to a
 * single workflow_runs poll without disturbing the user's
 * session-level `gh auth switch` state. Notifications never pass an
 * `env`; the global owner inbox is single-account by design.
 */
export type GhRunner = (
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<GhExecResult>;

export interface GitHubPollerOptions {
  db: Database.Database;
  eventBus: EventBus;
  repoPaths: readonly string[];
  /**
   * Direct GitHub repositories in `owner/repo` form. These are useful when
   * the user wants remote-side polling for a repo that is not cloned locally.
   * Unlike `repoPaths`, this list also scopes Notifications processing when
   * non-empty.
   */
  repoFullNames?: readonly string[];
  pollIntervalSeconds: number;
  /**
   * Path to the `gh` CLI. Defaults to `"gh"` (rely on PATH). Tests may
   * override this OR pass `runner` directly to bypass execFile entirely.
   */
  ghBin?: string;
  /**
   * Test-only: replace the `gh` invoker with a stub. When omitted, the
   * poller calls real `execFile(ghBin, args)` via Node child_process.
   */
  runner?: GhRunner;
  /**
   * Test-only: bypass `git remote get-url origin` resolution by supplying
   * pre-built bindings. Production callers leave this undefined and pass
   * `repoPaths` instead.
   */
  repoBindings?: readonly RepoBinding[];
  /**
   * Per-repo credential resolver (P5 multi-account). Returns the env
   * overlay to pass to the runner for any repo-scoped `gh api ...` call —
   * `repos/<owner>/<repo>` (default-branch lookup at startup) and
   * `repos/<owner>/<repo>/actions/runs` (workflow polling). `undefined`
   * (the default for repos without an `accountAlias`) keeps the legacy
   * single-account behaviour. The notifications endpoint always runs on
   * the daemon's own env — it reads the global owner inbox, which is
   * not per-repo.
   *
   * Input is a partial binding rather than a full `RepoBinding` because
   * default-branch resolution happens BEFORE we know the binding's
   * `defaultBranch` field; the resolver only ever consumes `accountAlias`.
   */
  accountResolver?: (
    binding: { accountAlias?: string },
  ) => Promise<NodeJS.ProcessEnv | undefined>;
  /**
   * Maps a watched repo (by absolute local path or `owner/repo`) to a
   * `gitAccounts` alias. Consulted once during `resolveRepoBindings` so
   * the resulting `RepoBinding` carries the alias forward into the
   * poll-time `accountResolver` call. `undefined` => no alias (default
   * `gh` profile).
   */
  repoAccountAliasResolver?: (input: {
    localPath?: string;
    fullName: string;
  }) => string | undefined;
  /**
   * Trigger-evaluator hook (unified-repositories §4.4). Fired after
   * `applyClassification` records a fresh observation, so duplicate
   * polls of the same notification don't re-fire triggers. The hook
   * receives the resolved binding plus the raw classification so the
   * caller can map back to a `repositories.id` and dispatch matched
   * `repository_triggers`.
   *
   * Failures in the hook never bubble out — caught + logged at the
   * call site so a misconfigured trigger cannot stall the poll loop.
   */
  onTriggerableEvent?: (event: TriggerableGithubEvent) => void | Promise<void>;
  /**
   * Per-repo poll-cadence overrides (unified-repositories §5). Maps a
   * binding key (`owner/repo`) → `poll_interval_sec`. Null entries (or
   * missing keys) fall back to `pollIntervalSeconds`. Notifications-side
   * polling is always at the global cadence — the override only gates
   * per-repo `actions/runs` polling, since that's the expensive part.
   *
   * Optional — when omitted, every repo's workflow runs are polled on
   * every tick (the pre-unification behaviour).
   */
  repoIntervals?: ReadonlyMap<string, number | null>;
}

/**
 * Surface emitted by `applyClassification` after the (source, ref)
 * idempotency check passes. The fields mirror what the trigger
 * evaluator needs: `eventType` keys into `EVENT_PATH_EXTRACTORS`
 * and the payload for filter matching, while `binding` lets the
 * caller resolve back to a `repositories.id` without re-deriving
 * `owner/repo` from the source string.
 */
export interface TriggerableGithubEvent {
  binding: RepoBinding | null;
  eventType: string;
  source: string;
  ref: string;
  payload: Record<string, unknown>;
}

/**
 * GitHubPoller — daemon-side polling of GitHub Notifications + workflow runs
 * via `gh` CLI. Replaces the webhook-driven path for local-first installs
 * where exposing a public URL is impractical.
 *
 * Two cadences on a single timer:
 *   1. `gh api notifications` — ETag-cached; 304s cost no rate quota.
 *      Classifies by `reason` and records observations; HIGH-priority
 *      reasons (review_requested / assign / security_alert) also push to
 *      the EventBus for direct DM via the matching task-flow.
 *   2. `gh api repos/<o>/<r>/actions/runs?status=failure` per watched repo.
 *      Default-branch failures are HIGH; feature-branch failures stay as
 *      observations only.
 *
 * Idempotency: a notification or workflow_run that the poller has emitted
 * for in the past does NOT re-emit on subsequent polls. The pre-check on
 * `observations(source, ref)` (any consumed_at) guards the EventBus push;
 * `recordObservation` itself is UPSERT-idempotent on (source, ref) WHERE
 * consumed_at IS NULL.
 *
 * Cold-start safety: the workflow_runs path checks the observations table
 * for any prior row keyed `github:workflow:<owner>/<repo>`. When none exists,
 * the first batch is recorded WITHOUT EventBus emission — otherwise the
 * user would wake up to one HIGH-priority DM per historical CI failure on
 * the default branch. Subsequent polls go through the normal
 * idempotency-checked path: `applyClassification` records, and emits only
 * if the (source, ref) pair is fresh.
 *
 * No cursor on the workflow_runs query — the API returns the latest 30
 * `?status=failure` runs sorted desc by creation time, and the (source,
 * ref) pre-check naturally suppresses re-emission. An older approach that
 * filtered by `created>cursor` was abandoned because long-running workflows
 * (created at T1, fail at T3) would be silently dropped after the cursor
 * advanced past T1.
 *
 * Notifications cold-start is handled inherently by GitHub (only unread
 * items are returned).
 *
 * Auth: re-uses the user's `gh auth login` keychain entry. The daemon's
 * SecretBroker is intentionally NOT consulted — auth lives where `gh`
 * already manages it. If `gh auth status` is non-zero, polls back off
 * exponentially.
 */
export class GitHubPoller implements Observer {
  readonly name = "github";

  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly repoPaths: readonly string[];
  private readonly repoFullNames: readonly string[];
  private readonly pollIntervalMs: number;
  private readonly runner: GhRunner;
  private readonly repoBindingsOverride: readonly RepoBinding[] | null;
  private readonly directNotificationRepos: ReadonlySet<string>;
  private readonly accountResolver:
    | ((binding: { accountAlias?: string }) => Promise<NodeJS.ProcessEnv | undefined>)
    | null;
  private readonly repoAccountAliasResolver:
    | ((input: { localPath?: string; fullName: string }) => string | undefined)
    | null;
  private readonly onTriggerableEvent:
    | ((event: TriggerableGithubEvent) => void | Promise<void>)
    | null;
  private readonly repoIntervals: ReadonlyMap<string, number | null>;
  private readonly globalIntervalSeconds: number;
  /** Per-repo next-fire timestamp (ms). Notifications poll separately. */
  private readonly nextFireAt = new Map<string, number>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private repos: RepoBinding[] = [];
  private consecutiveFailures = 0;
  private skipRemaining = 0;
  private polling = false;

  constructor(opts: GitHubPollerOptions) {
    this.db = opts.db;
    this.eventBus = opts.eventBus;
    this.repoPaths = opts.repoPaths;
    this.repoFullNames = opts.repoFullNames ?? [];
    this.pollIntervalMs = opts.pollIntervalSeconds * 1000;
    this.runner = opts.runner ?? makeDefaultRunner(opts.ghBin ?? "gh");
    this.repoBindingsOverride = opts.repoBindings ?? null;
    this.accountResolver = opts.accountResolver ?? null;
    this.repoAccountAliasResolver = opts.repoAccountAliasResolver ?? null;
    this.onTriggerableEvent = opts.onTriggerableEvent ?? null;
    this.repoIntervals = opts.repoIntervals ?? new Map();
    this.globalIntervalSeconds = opts.pollIntervalSeconds;
    this.directNotificationRepos = new Set(
      this.repoFullNames
        .map((repo) => parseGitHubRepoFullName(repo)?.fullName.toLowerCase())
        .filter((repo): repo is string => typeof repo === "string"),
    );
  }

  async start(): Promise<void> {
    // Resolve repo bindings (owner/name + default branch). A repo whose
    // remote isn't GitHub, or whose default-branch lookup fails, is skipped
    // — observers continue without it. Tests may bypass git/gh round-trips
    // entirely via `repoBindings`.
    this.repos = this.repoBindingsOverride
      ? [...this.repoBindingsOverride]
      : await this.resolveRepoBindings();
    this.repos = dedupeRepoBindings(this.repos);

    // Initial poll. Errors here back off but don't prevent the timer from
    // firing — auth might be configured after daemon start.
    await this.poll();

    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    logger.info(
      {
        intervalMs: this.pollIntervalMs,
        watchedRepos: this.repos.length,
      },
      "GitHub poller started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("GitHub poller stopped");
  }

  private async poll(): Promise<void> {
    if (this.skipRemaining > 0) {
      this.skipRemaining--;
      return;
    }
    // Concurrent-fire guard. With the default 600s interval the previous
    // tick has long completed, but a slow API or low-interval test could
    // overlap; serialize for determinism.
    if (this.polling) return;
    this.polling = true;

    let anyFailed = false;

    try {
      try {
        await this.pollNotifications();
      } catch (err) {
        anyFailed = true;
        this.handlePollError("notifications", err);
      }

      const nowMs = Date.now();
      for (const repo of this.repos) {
        // Per-row scheduling gate (unified-repositories §5). Skipping
        // is best-effort: a row whose interval is shorter than the
        // global tick still polls every tick, but a row with a longer
        // override polls less often.
        if (!this.isRepoDue(repo.fullName, nowMs)) continue;
        try {
          await this.pollWorkflowRuns(repo);
          this.markRepoFired(repo.fullName, nowMs);
        } catch (err) {
          anyFailed = true;
          this.handlePollError(`workflow:${repo.fullName}`, err);
          // Mark fired even on failure so we don't tight-loop a broken
          // repo across ticks. The exponential backoff in
          // handlePollError still throttles globally.
          this.markRepoFired(repo.fullName, nowMs);
        }
      }

      if (!anyFailed) {
        this.consecutiveFailures = 0;
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Per-row scheduling helpers. Returns the override (seconds) only
   * when one is configured *and* longer than the global tick. Rows
   * with no override (or an override <= global) fall through to the
   * "every tick" cadence — the global `setInterval` already enforces
   * that floor, so we don't need a per-row mark.
   */
  private getRepoOverrideSeconds(fullName: string): number | null {
    const override = this.repoIntervals.get(fullName);
    if (typeof override === "number" && override > this.globalIntervalSeconds) {
      return override;
    }
    return null;
  }

  /**
   * True when the row is due for its next poll. Rows with no override
   * (the common case) are always due — `nextFireAt` is never set for
   * them. Rows with a longer override are gated until the override
   * window elapses.
   */
  private isRepoDue(fullName: string, nowMs: number): boolean {
    const override = this.getRepoOverrideSeconds(fullName);
    if (override === null) return true;
    const next = this.nextFireAt.get(fullName);
    return next === undefined || nowMs >= next;
  }

  private markRepoFired(fullName: string, nowMs: number): void {
    const override = this.getRepoOverrideSeconds(fullName);
    if (override === null) return; // no gating needed
    this.nextFireAt.set(fullName, nowMs + override * 1000);
  }

  private handlePollError(scope: string, err: unknown): void {
    this.consecutiveFailures++;
    this.skipRemaining = Math.min(2 ** (this.consecutiveFailures - 1), 16);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT") || message.includes("not found")) {
      logger.warn(
        { scope, consecutiveFailures: this.consecutiveFailures, skipRemaining: this.skipRemaining },
        "`gh` CLI is not on PATH — install via `brew install gh` (or platform equivalent), then `gh auth login`. Backing off.",
      );
    } else if (message.includes("authentication") || message.includes("401")) {
      logger.warn(
        { scope, consecutiveFailures: this.consecutiveFailures, skipRemaining: this.skipRemaining },
        "GitHub poll failed (auth) — run `gh auth status` to verify; backing off.",
      );
    } else if (message.includes("rate limit") || message.includes("429")) {
      logger.warn(
        { scope, consecutiveFailures: this.consecutiveFailures, skipRemaining: this.skipRemaining },
        "GitHub rate limited — backing off",
      );
    } else {
      logger.error(
        { scope, err, consecutiveFailures: this.consecutiveFailures, skipRemaining: this.skipRemaining },
        "GitHub poll failed — backing off",
      );
    }
  }

  private async pollNotifications(): Promise<void> {
    const lastEtag = readRuntimeState<string>(this.db, NOTIF_ETAG_KEY);
    const lastModified = readRuntimeState<string>(
      this.db,
      NOTIF_LAST_MODIFIED_KEY,
    );

    const args = ["api", "notifications", "--include"];
    if (lastEtag) args.push("-H", `If-None-Match: ${lastEtag}`);
    if (lastModified) args.push("-H", `If-Modified-Since: ${lastModified}`);

    const result = await this.runner(args);
    const { headers, body, statusCode } = parseGhIncludeResponse(result.stdout);

    if (statusCode === 304) {
      return; // No changes — cheapest path, also no rate-quota cost.
    }
    if (statusCode === 0) {
      // No HTTP status parsed — gh CLI itself failed (network down, binary
      // missing, killed). Surface with whatever stderr / exit signal we have.
      throw new Error(
        `gh api notifications failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
      );
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `gh api notifications returned ${statusCode}: ${result.stderr || body}`,
      );
    }

    let notifications: GitHubNotification[];
    try {
      notifications = JSON.parse(body) as GitHubNotification[];
    } catch (err) {
      throw new Error(`Failed to parse notifications JSON: ${(err as Error).message}`);
    }

    // Process items first; only persist new ETag/Last-Modified after the
    // batch lands. If processing throws midway the next tick re-fetches
    // the whole window — idempotency on (source, ref) absorbs the duplicate
    // recording, and the EventBus emit is gated by isObservationFresh.
    for (const n of notifications) {
      if (!this.shouldProcessNotification(n)) continue;
      const binding = this.findBindingForNotification(n);
      this.applyClassification(classifyNotification(n), binding);
    }

    const etag = headers["etag"];
    const lastMod = headers["last-modified"];
    if (etag) writeRuntimeState(this.db, NOTIF_ETAG_KEY, etag);
    if (lastMod) writeRuntimeState(this.db, NOTIF_LAST_MODIFIED_KEY, lastMod);
  }

  private async pollWorkflowRuns(repo: RepoBinding): Promise<void> {
    // No cursor — fetch the latest 30 failed runs every tick. The GitHub
    // API returns most-recent-first, so this is bounded; the (source, ref)
    // idempotency check handles re-emission. Filtering by `created>cursor`
    // would silently drop long-running workflows that fail later than their
    // creation timestamp suggests.
    const filterArg =
      `repos/${repo.owner}/${repo.repo}/actions/runs?status=failure&per_page=30`;

    const env = await this.resolveAccountEnv(repo.accountAlias);

    // Preserve the legacy single-argument call shape when no env overlay
    // is in play. Tests assert `toHaveBeenCalledWith([...])` without a
    // trailing options arg, and dropping the second positional means a
    // pre-multi-account caller's runner stub keeps matching.
    const result = env
      ? await this.runner(["api", filterArg], { env })
      : await this.runner(["api", filterArg]);
    if (result.exitCode !== 0) {
      throw new Error(
        `gh api ${filterArg} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
      );
    }

    let parsed: { workflow_runs?: GitHubWorkflowRun[] };
    try {
      parsed = JSON.parse(result.stdout) as { workflow_runs?: GitHubWorkflowRun[] };
    } catch (err) {
      throw new Error(`Failed to parse workflow_runs JSON: ${(err as Error).message}`);
    }

    const runs = parsed.workflow_runs ?? [];

    // Cold-start: if no observations exist yet for this repo's workflow
    // source, this is the first time the poller has seen this repo.
    // Recording without emit prevents the user from getting one HIGH DM
    // per historical default-branch failure when they first enable the
    // integration. After the cold batch is in the table, future polls
    // emit only for genuinely new failures (idempotency check passes only
    // for refs absent from the table).
    const cold = isWorkflowRepoCold(this.db, repo.fullName);
    for (const run of runs) {
      const classification = classifyWorkflowRun(
        run,
        repo.defaultBranch,
        repo.fullName,
      );
      if (classification.kind === "skip") continue;
      if (cold) {
        recordObservation(this.db, {
          source: classification.source,
          ref: classification.ref,
          changeType: classification.changeType,
          actor: "user",
          payload: classification.payload,
        });
      } else {
        this.applyClassification(classification, repo);
      }
    }
  }

  /**
   * Apply a classifier verdict — record the observation (UPSERT-idempotent
   * on the partial unique index) and emit to the EventBus only when the
   * (source, ref) pair has not been recorded before. The pre-check guards
   * against re-DM-ing the user about a notification that re-appears on
   * subsequent polls before the user dismisses it on GitHub.
   */
  private applyClassification(
    classification: Classification,
    binding: RepoBinding | null = null,
  ): void {
    if (classification.kind === "skip") return;

    const isFresh = isObservationFresh(
      this.db,
      classification.source,
      classification.ref,
    );

    recordObservation(this.db, {
      source: classification.source,
      ref: classification.ref,
      changeType: classification.changeType,
      actor: "user",
      payload: classification.payload,
    });

    if (classification.emitEvent && isFresh) {
      this.eventBus.put(
        createEvent({
          type: classification.eventType,
          source: "github-poller",
          priority: classification.priority,
          data: classification.payload,
        }),
      );
      logger.info(
        {
          eventType: classification.eventType,
          priority: EventPriority[classification.priority],
          ref: classification.ref,
        },
        "GitHub event emitted",
      );
    }

    // Trigger evaluator hook (unified-repositories §4.4). Fires for every
    // fresh observation — `emitEvent` gates the broadcast to the existing
    // task-flow pipeline, but per-repo triggers should fire regardless of
    // priority (a user-defined trigger on `github.notification` is valid
    // even though the classifier doesn't broadcast that key by default).
    if (isFresh && this.onTriggerableEvent) {
      Promise.resolve(
        this.onTriggerableEvent({
          binding,
          eventType: classification.eventType,
          source: classification.source,
          ref: classification.ref,
          payload: classification.payload,
        }),
      ).catch((err) => {
        logger.warn(
          {
            err,
            eventType: classification.eventType,
            ref: classification.ref,
          },
          "GitHub trigger hook failed",
        );
      });
    }
  }

  /**
   * Match a notification's `repository.full_name` against the resolved
   * `repos` list so trigger dispatch can carry the binding through. Returns
   * null when the notification's repo isn't watched (which happens for the
   * global-inbox path with no `directNotificationRepos` filter).
   */
  private findBindingForNotification(
    notification: GitHubNotification,
  ): RepoBinding | null {
    const target = notification.repository.full_name.toLowerCase();
    return (
      this.repos.find((b) => b.fullName.toLowerCase() === target) ?? null
    );
  }

  private async resolveRepoBindings(): Promise<RepoBinding[]> {
    const out: RepoBinding[] = [];
    for (const localPath of this.repoPaths) {
      try {
        const remoteResult = await execFileAsync(
          "git",
          ["remote", "get-url", "origin"],
          { cwd: localPath, timeout: 5000 },
        );
        const parsed = parseGitHubRemote(remoteResult.stdout);
        if (!parsed) {
          logger.debug({ localPath }, "Skipping non-GitHub remote");
          continue;
        }
        const fullName = `${parsed.owner}/${parsed.repo}`;
        const accountAlias = this.repoAccountAliasResolver?.({
          localPath,
          fullName,
        });
        // Resolve env BEFORE the default-branch lookup so private repos
        // accessible only via the aliased credential don't silently fall
        // back to "main" — that wrong branch would freeze onto the binding
        // for the lifetime of the poller and break `git.merge_to_default`.
        const env = await this.resolveAccountEnv(accountAlias);
        const defaultBranch = await this.fetchDefaultBranch(parsed.owner, parsed.repo, env);
        out.push({
          localPath,
          owner: parsed.owner,
          repo: parsed.repo,
          fullName,
          defaultBranch,
          ...(accountAlias ? { accountAlias } : {}),
        });
      } catch (err) {
        logger.warn(
          { localPath, err: (err as Error).message },
          "Failed to resolve GitHub remote — skipping",
        );
      }
    }
    for (const configured of this.repoFullNames) {
      const parsed = parseGitHubRepoFullName(configured);
      if (!parsed) {
        logger.warn({ repo: configured }, "Invalid configured GitHub repo — skipping");
        continue;
      }
      const accountAlias = this.repoAccountAliasResolver?.({
        fullName: parsed.fullName,
      });
      const env = await this.resolveAccountEnv(accountAlias);
      const defaultBranch = await this.fetchDefaultBranch(parsed.owner, parsed.repo, env);
      out.push({
        owner: parsed.owner,
        repo: parsed.repo,
        fullName: parsed.fullName,
        defaultBranch,
        ...(accountAlias ? { accountAlias } : {}),
      });
    }
    return out;
  }

  /**
   * Wrap `accountResolver` invocation with the standard try/catch that
   * keeps a misconfigured alias from stalling the entire poll cycle.
   * Returns `undefined` for repos without an alias OR when the resolver
   * throws — both fall back to the daemon's own env.
   */
  private async resolveAccountEnv(
    accountAlias: string | undefined,
  ): Promise<NodeJS.ProcessEnv | undefined> {
    if (!accountAlias || !this.accountResolver) return undefined;
    try {
      return await this.accountResolver({ accountAlias });
    } catch (err) {
      logger.warn(
        { alias: accountAlias, err },
        "GitHub per-repo credential resolution failed — falling back to default profile",
      );
      return undefined;
    }
  }

  private shouldProcessNotification(notification: GitHubNotification): boolean {
    if (this.directNotificationRepos.size === 0) return true;
    return this.directNotificationRepos.has(
      notification.repository.full_name.toLowerCase(),
    );
  }

  private async fetchDefaultBranch(
    owner: string,
    repo: string,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<string> {
    try {
      const result = env
        ? await this.runner(
            ["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"],
            { env },
          )
        : await this.runner([
            "api",
            `repos/${owner}/${repo}`,
            "--jq",
            ".default_branch",
          ]);
      const branch = result.stdout.trim();
      if (!branch) return "main";
      return branch;
    } catch (err) {
      logger.warn(
        { owner, repo, err: (err as Error).message },
        "Default-branch lookup failed — falling back to 'main'",
      );
      return "main";
    }
  }
}

/**
 * Default `gh` runner: invokes `execFile(ghBin, args)` via Node
 * child_process. Caller-injected runners are used by tests to bypass the
 * subprocess entirely. The factory captures `ghBin` so tests that pass
 * `ghBin: "/path/to/fake/gh"` still work.
 */
function makeDefaultRunner(ghBin: string): GhRunner {
  return async (args, options) => {
    try {
      const { stdout, stderr } = await execFileAsync(ghBin, [...args], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        ...(options?.env ? { env: options.env } : {}),
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      // ENOENT: binary not on PATH. Surface with a marker substring the
      // poller's error classifier can detect for an actionable log line.
      if (e.code === "ENOENT") {
        return {
          stdout: "",
          stderr: `ENOENT: gh CLI not found at "${ghBin}"`,
          exitCode: 127,
        };
      }
      const exitCode = typeof e.code === "number" ? e.code : 1;
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "",
        exitCode,
      };
    }
  };
}

function dedupeRepoBindings(bindings: RepoBinding[]): RepoBinding[] {
  const seen = new Set<string>();
  const deduped: RepoBinding[] = [];
  for (const binding of bindings) {
    const key = binding.fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(binding);
  }
  return deduped;
}

/**
 * Parse the headers + body returned by `gh api --include`. Output looks like:
 *
 *   HTTP/2.0 200 OK
 *   Etag: W/"abc"
 *   Content-Type: application/json
 *
 *   [{...}]
 *
 * Headers are case-folded to lowercase. Both LF (`\n\n`) and CRLF
 * (`\r\n\r\n`) header-body separators are recognized — `gh api` is
 * implemented in Go and may emit either depending on GitHub server output.
 *
 * Returns `statusCode: 0` when no recognizable separator is present so
 * callers can distinguish "no HTTP status parsed" from a legitimate 2xx.
 *
 * Exported for the test file; not used elsewhere.
 */
export function parseGhIncludeResponse(raw: string): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  const crlfIdx = raw.indexOf("\r\n\r\n");
  const lfIdx = raw.indexOf("\n\n");
  let splitIdx: number;
  let separatorLen: number;
  if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
    splitIdx = crlfIdx;
    separatorLen = 4;
  } else if (lfIdx !== -1) {
    splitIdx = lfIdx;
    separatorLen = 2;
  } else {
    return { statusCode: 0, headers: {}, body: raw };
  }
  const headerBlock = raw.slice(0, splitIdx);
  const body = raw.slice(splitIdx + separatorLen);
  // Split on either CRLF or LF — handles mixed-form responses defensively.
  const lines = headerBlock.split(/\r?\n/);
  let statusCode = 0;
  const statusMatch = lines[0]?.match(/^HTTP\/[\d.]+\s+(\d+)/);
  if (statusMatch) statusCode = Number(statusMatch[1]);
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx === -1) continue;
    const name = lines[i].slice(0, colonIdx).trim().toLowerCase();
    const value = lines[i].slice(colonIdx + 1).trim();
    if (name) headers[name] = value;
  }
  return { statusCode, headers, body };
}

/**
 * Pre-check for orchestrator idempotency. Returns true when no row with this
 * (source, ref) pair has ever been recorded — consumed or not. Used by
 * `applyClassification` to gate EventBus emission. The observations UPSERT
 * itself is idempotent on the partial unique index (consumed_at IS NULL),
 * but the bus push is not — without this guard a still-unread notification
 * would re-DM the user on every poll tick.
 *
 * Exported for tests.
 */
export function isObservationFresh(
  db: Database.Database,
  source: string,
  ref: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS hit FROM observations WHERE source = ? AND ref = ? LIMIT 1",
    )
    .get(source, ref);
  return row === undefined;
}

/**
 * Cold-start detection for the workflow_runs path. Returns true when the
 * observations table contains no rows keyed by `github:workflow:<repoFullName>`.
 *
 * Backs the rule: on first poll for a repository, record the latest
 * failures without emit. After the cold batch is in the table, subsequent
 * polls emit only for refs that aren't already in the table.
 *
 * Exported for tests.
 */
export function isWorkflowRepoCold(
  db: Database.Database,
  repoFullName: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS hit FROM observations WHERE source = ? LIMIT 1",
    )
    .get(`github:workflow:${repoFullName}`);
  return row === undefined;
}

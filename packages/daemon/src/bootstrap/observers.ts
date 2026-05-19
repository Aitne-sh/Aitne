/**
 * Observer bootstrap — §7 of the legacy `startup()` IIFE.
 *
 * Extracted from `index.ts` per
 * `docs/design/appendices/index-bootstrap-stage-split.md` Phase B-2.
 * Companion to `bootstrap/db.ts`, `bootstrap/adapters.ts`,
 * `bootstrap/services.ts`, and `bootstrap/api.ts`; same Pattern-C shape
 * (file-split-plan.md §10).
 *
 * Responsibilities (in run order):
 *  1. Build the `ObserverManager` and the shared `ObserverState` slot the
 *     `gitWatcher` lives in (read by §13 webhook-mode upgrade and by the
 *     B-4 `handleSecretChange` "github" branch).
 *  2. Construct the `GitAccountRegistry` + the per-repo helpers
 *     (`getNormalizedGitRepos`, `lookupRepoAlias`,
 *     `queueGitProjectInitsForCurrentConfig`) that the git observers and
 *     the §11 ApiDeps record consume.
 *  3. Wire and conditionally register the five hot-register builders:
 *     `buildGitWatcher`, `buildGithubPoller`, `buildGitDelegatedCronObserver`,
 *     `buildCalendarPoller`, `buildNotionPoller`. Three of the five are
 *     re-exported on the result because B-4 (`handleSecretChange` +
 *     `handleGoogleServicesReady`) and B-3 (`onIntegrationModeChange`)
 *     need them for hot-register paths; the other two are exposed for
 *     symmetry — `applyIntegrationModeChange` already routes through
 *     all four direct-mode observers.
 *  4. Register the always-on observers (repository management cron,
 *     primary vault watcher, imminent event scheduler, context-index
 *     reconciler, entity-mirror observer, MCP auto-probe).
 *  5. Conditionally register the §7.2 observation summarizer worker
 *     (gated on `config.observationSummarizerEnabled`) and the external
 *     Obsidian vault watcher (gated on `externalObsidianVaultPath` +
 *     `externalObsidianWatch`).
 *  6. Conditionally register the mail observers when `services.mail` is
 *     present (the multi-mail poller + the reconciliation job).
 *
 * Mutable state shape (`ObserverState`) mirrors `AdapterState` from
 * `bootstrap/adapters.ts`: the factory writes the slot when a builder
 * runs, the caller reads it back to apply the webhook-mode fallback,
 * and the integration-lifecycle layer clears it on a git mode flip via
 * `clearGitWatcher()`.
 *
 * Ordering invariants this module preserves (design §11):
 *  - `mergeRuntimeSettingsFromDb` (Phase B-1) runs before this factory
 *    is invoked. Observer builders read the merged `config` directly.
 *  - The wiki workspace token resolver (Phase B-1) is registered before
 *    any observer reads it through the skill compiler.
 *  - The context-index reconciler is constructed here but its prompt-
 *    context-changed sink is filled by `setPromptContextChangedSink`
 *    after the dispatcher and session manager exist (B-4). Until that
 *    call lands the sink stays null and the observer logs but does not
 *    invalidate caches — exactly matching the pre-extraction behavior.
 *  - `triggerRoadmapRefresh` is a closure passed in by the caller; it
 *    captures `emitRoadmapRefreshSink` (assigned by the caller after the
 *    dispatcher is constructed). Pollers store the callback and only
 *    invoke it after `observerManager.startAll()` runs, by which time
 *    the dispatcher has been wired — preserving the §7 forward-reference
 *    indirection from the pre-extraction code.
 */

import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { getContextDir } from "../config.js";
import {
  isSetupCompleted,
  isDegraded as readDegradedMode,
} from "../db/runtime-state.js";
import {
  getRepositoryByGithub,
  getRepositoryByLocalPath,
  listRepositories,
  selectGithubRepoSlugs,
  selectGitWatchedRepos,
} from "../db/repositories-store.js";
import { dispatchMatchingTriggers } from "../core/trigger-dispatch.js";
import {
  normalizeGitWatchedRepos,
  queueGitProjectUpdate,
  queueMissingGitProjectInits,
} from "../core/git-project-docs.js";
import {
  shouldStartObserversFor,
} from "../core/integration-lifecycle.js";
import type { EventBus } from "../core/event-bus.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import type { EncryptedBlobStore } from "../secrets/encrypted-blob-store.js";
import type { ServiceRegistry } from "../services/service-registry.js";
import type { MessageHub } from "../adapters/message-hub.js";
import type { TodayWriteLockManager } from "../core/today-write-lock.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { PromptContextChangedCallback } from "../core/context-staleness.js";
import { ObserverManager } from "../observers/manager.js";
import { ObsidianWatcher } from "../observers/obsidian-watcher.js";
import { PrimaryVaultWatcher } from "../observers/primary-vault-watcher.js";
import { ContextIndexReconcilerObserver } from "../observers/context-index-reconciler-observer.js";
import { EntityMirrorObserver } from "../observers/entity-mirror-observer.js";
import { GitWatcher } from "../observers/git-watcher.js";
import { GitHubPoller } from "../observers/github-poller.js";
import { GitAccountRegistry } from "../services/git-account-registry.js";
import {
  GitDelegatedCronObserver,
  hasActiveDelegatedGitLifecycleIntegration,
} from "../observers/git-delegated-cron.js";
import { RepositoryManagementCron } from "../observers/repository-management-cron.js";
import {
  ObservationSummarizerWorker,
  AnthropicSummarizerClient,
  UnsupportedSummarizerClient,
  type SummarizerLlmClient,
} from "../observers/observation-summarizer/index.js";
import { CalendarPoller } from "../observers/calendar-poller.js";
import { ImminentEventScheduler } from "../observers/imminent-event-scheduler.js";
import { NotionPoller } from "../observers/notion-poller.js";
import { MailPoller } from "../observers/mail-poller.js";
import { MailReconciliationJob } from "../observers/mail-reconciliation.js";
import type { BootstrapSecretState } from "./services.js";
import { createLogger } from "../logging.js";

const logger = createLogger("daemon-bootstrap-observers");

/**
 * Mutable holder for the live `GitWatcher` reference. The webhook-mode
 * fallback (§13 + the B-4 `handleSecretChange` "github" branch) reads
 * this slot through `getGitWatcher()` to upgrade an existing watcher
 * without rebuilding; the integration-lifecycle drop-out path nulls it
 * through `clearGitWatcher()` when `git.mode` flips away from `direct`.
 *
 * Unlike `AdapterState` in `bootstrap/adapters.ts`, this slot is owned
 * by the factory (allocated internally, not passed in) — only one slot
 * exists today and the public surface is the accessor pair, so callers
 * never need direct access to the holder.
 */
interface ObserverState {
  gitWatcher: GitWatcher | null;
}

export interface BootstrapObserversDeps {
  readonly db: Database.Database;
  readonly config: AgentConfig;
  readonly eventBus: EventBus;
  readonly secretBroker: SecretBroker;
  readonly services: ServiceRegistry;
  readonly writeTracker: AgentWriteTracker;
  readonly blobStore: EncryptedBlobStore;
  readonly messageHub: MessageHub;
  readonly morningRoutineLock: TodayWriteLockManager;
  readonly secretState: BootstrapSecretState;
  /**
   * Roadmap-refresh trampoline owned by the caller. The closure here
   * reads from a `let` slot the caller assigns once the dispatcher
   * exists. The indirection preserves the §7 ordering invariant that
   * observers may register before the dispatcher is constructed.
   */
  readonly triggerRoadmapRefresh: (source: string) => void;
}

export interface BootstrapObserversResult {
  readonly observerManager: ObserverManager;
  readonly primaryVaultWatcher: PrimaryVaultWatcher;
  readonly contextIndexReconciler: ContextIndexReconcilerObserver;
  readonly gitAccountRegistry: GitAccountRegistry;

  /**
   * Hot-register builders for B-3 (`applyIntegrationModeChange`) and B-4
   * (`handleSecretChange` + `handleGoogleServicesReady`). All five are
   * exposed: in addition to the `buildCalendarPoller` / `buildNotionPoller`
   * / `buildGitWatcher` paths the B-2 design draft called out, the
   * github + git-delegated builders are also called by
   * `applyIntegrationModeChange` for runtime mode flips — see
   * `bootstrap/api.ts:onIntegrationModeChange`.
   */
  readonly buildGitWatcher: () => GitWatcher | null;
  readonly buildGithubPoller: () => GitHubPoller;
  readonly buildGitDelegatedCronObserver: () => GitDelegatedCronObserver;
  readonly buildCalendarPoller: () => CalendarPoller | null;
  readonly buildNotionPoller: () => NotionPoller | null;

  /**
   * Drop the cached `gitWatcher` reference. Called by the
   * integration-lifecycle helper when `git.mode` flips out of `direct`
   * so the next §13 / `handleSecretChange` read does not see a stale
   * instance after the observer was stopped.
   */
  readonly clearGitWatcher: () => void;
  /** Snapshot accessor; null when no watcher has been built. */
  readonly getGitWatcher: () => GitWatcher | null;

  /**
   * Best-effort backfill of missing `git_project_docs.queued_init` rows
   * for the current config. Re-exposed so the API surface (PATCH
   * `gitWatchedRepos` etc.) can request it after rows shift at runtime.
   */
  readonly queueGitProjectInitsForCurrentConfig: (source: string) => void;

  /**
   * Install the prompt-context-changed sink consumed by the
   * context-index reconciler. Called by B-4 (event-pipeline) once the
   * dispatcher and session manager exist. Idempotent: re-installs
   * replace the previous sink.
   */
  readonly setPromptContextChangedSink: (cb: PromptContextChangedCallback) => void;
}

/**
 * Assemble every observer-tier registration that used to live inline in
 * `startup()` §7 of `index.ts`. Async because the primary vault watcher
 * is `setVaultPath`'d before registration and several secondary
 * observers are loaded via dynamic import (`SkillCurationWalker`,
 * `scanAndRecordOrphanOverlays`, `McpAutoProbe`).
 */
export async function createObservers(
  deps: BootstrapObserversDeps,
): Promise<BootstrapObserversResult> {
  const {
    db,
    config,
    eventBus,
    secretBroker,
    services,
    writeTracker,
    blobStore,
    messageHub,
    morningRoutineLock,
    secretState,
    triggerRoadmapRefresh,
  } = deps;

  const observerManager = new ObserverManager();
  const observerState: ObserverState = { gitWatcher: null };

  // The reconciler sink starts null and is filled by B-4 after the
  // dispatcher and session manager exist. The closure below is what
  // the observer sees; reassigning `promptSink` flips the resolved
  // callback for subsequent emissions.
  let promptSink: PromptContextChangedCallback | null = null;
  const setPromptContextChangedSink = (cb: PromptContextChangedCallback): void => {
    promptSink = cb;
  };

  // ── Git registry + per-repo helpers ───────────────────────────────────
  const getNormalizedGitRepos = () =>
    normalizeGitWatchedRepos({ gitWatchedRepos: selectGitWatchedRepos(db) });

  // P5 multi-account: registry resolves `gitAccounts[<alias>]` to an env
  // overlay on each call. The `getAccounts` thunk reads `config.gitAccounts`
  // lazily so a `PATCH /api/config` that mutates `config` flows through
  // without re-instantiation — which is why `gitAccounts` is NOT in
  // `RESTART_REQUIRED_KEY_TUPLE`.
  const gitAccountRegistry = new GitAccountRegistry({
    dataDir: config.dataDir,
    secretBroker,
    getAccounts: () => config.gitAccounts,
  });

  // One-time info note: github-side rows without a local clone fall back
  // to the default `gh` profile when the row's `github_account` is null.
  // Surface this when both `gitAccounts` and github-only rows exist so a
  // user staring at unaccounted-for traffic from "the wrong account" sees
  // it in `aitne logs` rather than guessing.
  const githubOnlyRows = selectGithubRepoSlugs(db).length;
  if (
    Object.keys(config.gitAccounts ?? {}).length > 0
    && githubOnlyRows > 0
  ) {
    logger.info(
      {
        gitAccounts: Object.keys(config.gitAccounts).length,
        githubRepos: githubOnlyRows,
      },
      "GitHub-side repository rows fall back to the default gh profile when github_account is unset. Set the row's account alias from /api/repositories or the dashboard.",
    );
  }

  const lookupRepoAlias = (
    repoPath?: string,
    fullName?: string,
  ): string | undefined => {
    const repos = getNormalizedGitRepos();
    if (repoPath) {
      const byPath = repos.find((r) => r.path === repoPath);
      if (byPath?.accountAlias) return byPath.accountAlias;
    }
    if (fullName) {
      const byOrgRepo = repos.find((r) => {
        if (!r.org) return false;
        // Repos resolved from `githubRepos` (not local paths) match by full name.
        return fullName.toLowerCase() === `${r.org}/${r.slug}`.toLowerCase();
      });
      if (byOrgRepo?.accountAlias) return byOrgRepo.accountAlias;
    }
    return undefined;
  };

  const queueGitProjectInitsForCurrentConfig = (source: string): void => {
    if (!isSetupCompleted(db) || readDegradedMode(db)) return;
    const repos = getNormalizedGitRepos();
    if (repos.length === 0) return;
    try {
      const inserted = queueMissingGitProjectInits({
        db,
        contextDir: getContextDir(config, db),
        dataDir: config.dataDir,
        workspaceDir: config.workspaceDir,
        repos,
      });
      if (inserted > 0) {
        logger.info(
          { inserted, source },
          "Queued missing git project documentation init tasks",
        );
      }
    } catch (err) {
      logger.warn({ err, source }, "Failed to queue git project documentation init tasks");
    }
  };

  // Re-read the repo rows on every builder invocation. Each builder is
  // called at boot AND hot-re-invoked from `onIntegrationModeChange`
  // (api.ts) after a `delegated → direct` flip, so a stale boot-time
  // snapshot would baked the pre-flip repo list into the new observer.
  // `selectGithubRepoSlugs(db)` is already a live read for the same
  // reason — keeping the local-path list snapshot-once was an
  // unintentional inconsistency. The boot call site (immediately below
  // each builder) sees identical data because nothing mutates
  // `gitWatchedRepos` between bootstrap stages.
  const buildGitWatcher = (): GitWatcher | null => {
    const gitWatchedRepos = getNormalizedGitRepos();
    const gitRepoPaths = gitWatchedRepos.map((repo) => repo.path);
    if (gitRepoPaths.length === 0) return null;
    // Per-row poll cadence (unified-repositories §5). Sourced from each
    // row's `poll_interval_sec`; rows with null fall through to the
    // global `gitPollIntervalSeconds`.
    const repoIntervals = new Map<string, number | null>(
      gitWatchedRepos.map((row) => [row.path, row.pollIntervalSec ?? null]),
    );
    const watcher = new GitWatcher(
      gitRepoPaths,
      db,
      config.gitPollIntervalSeconds,
      {
        eventBus,
        // Threaded through so observations of agent-originated commits
        // flip to `actor='agent'` (C1). Without this, daemon-side
        // commits would feed the hourly_check pending floor as user
        // activity and re-invoke the agent in a loop.
        writeTracker,
        pushOverdueMinutes: config.gitPushOverdueMinutes,
        repoIntervals,
        repoEnvResolver: async (repoPath) => {
          const alias = lookupRepoAlias(repoPath);
          if (!alias) return undefined;
          return (await gitAccountRegistry.buildSpawnEnv(alias)) ?? undefined;
        },
        onRepoBaseline: (repoPath) => {
          const repo = getNormalizedGitRepos().find((item) => item.path === repoPath);
          if (!repo) return;
          queueGitProjectInitsForCurrentConfig("git-baseline");
        },
        onLifecycleObservation: (classification) => {
          if (!isSetupCompleted(db) || readDegradedMode(db)) return;
          const repoPath = typeof classification.payload.repoPath === "string"
            ? classification.payload.repoPath
            : classification.source.replace(/^git:/, "");
          const repo = getNormalizedGitRepos().find((item) => item.path === repoPath);
          if (!repo) return;
          const result = queueGitProjectUpdate({
            db,
            dataDir: config.dataDir,
            workspaceDir: config.workspaceDir,
            repo,
            event: classification,
            debounceMinutes: config.gitProjectUpdateDebounceMinutes,
          });
          if (result === "queued" || result === "merged") {
            logger.info(
              {
                repo: repo.path,
                eventType: classification.eventType,
                result,
              },
              "Queued git project documentation update",
            );
          }
          // Unified-repositories §4.4 — fire any per-repo triggers
          // configured for this lifecycle event. Triggers ride alongside
          // the task-flow pipeline above; they do not consume the event.
          const repositoryRow = getRepositoryByLocalPath(db, repoPath);
          if (repositoryRow) {
            void dispatchMatchingTriggers(
              { db, eventBus },
              repositoryRow.id,
              classification.eventType,
              classification.payload,
            );
          }
        },
      },
    );
    observerState.gitWatcher = watcher;
    return watcher;
  };

  if (shouldStartObserversFor(db, "git")) {
    const watcher = buildGitWatcher();
    if (watcher) observerManager.register(watcher);
  }

  // GitHubPoller — daemon-side notification + workflow_run polling via the
  // user's `gh auth login` keychain entry. Registered only while
  // github.mode === "direct".
  const buildGithubPoller = (): GitHubPoller => {
    // Per-row poll cadence (unified-repositories §5). The map is keyed by
    // `owner/repo` to match `RepoBinding.fullName`.
    const repoIntervals = new Map<string, number | null>();
    for (const row of listRepositories(db, { hasGithub: true })) {
      if (row.githubOwner && row.githubRepo) {
        repoIntervals.set(
          `${row.githubOwner}/${row.githubRepo}`,
          row.pollIntervalSec ?? null,
        );
      }
    }
    return new GitHubPoller({
      db,
      eventBus,
      repoPaths: getNormalizedGitRepos().map((r) => r.path),
      repoFullNames: selectGithubRepoSlugs(db),
      pollIntervalSeconds: config.githubPollIntervalSeconds,
      repoIntervals,
      repoAccountAliasResolver: ({ localPath, fullName }) =>
        lookupRepoAlias(localPath, fullName),
      accountResolver: async (binding) => {
        if (!binding.accountAlias) return undefined;
        return (
          (await gitAccountRegistry.buildSpawnEnv(binding.accountAlias)) ?? undefined
        );
      },
      // Unified-repositories §4.4 — resolve the binding's owner/repo to
      // a repositories.id and fire any per-repo triggers configured for
      // this event type. Failures are logged inside dispatch and do not
      // bubble out so a misconfigured trigger cannot stall the poll loop.
      onTriggerableEvent: async (event) => {
        if (!isSetupCompleted(db) || readDegradedMode(db)) return;
        let repoRow = null;
        if (event.binding) {
          repoRow = getRepositoryByGithub(
            db,
            event.binding.owner,
            event.binding.repo,
          );
        }
        if (!repoRow) {
          const fullName =
            typeof event.payload.repository === "string"
              ? event.payload.repository
              : null;
          if (fullName) {
            const [owner, repo] = fullName.split("/");
            if (owner && repo) {
              repoRow = getRepositoryByGithub(db, owner, repo);
            }
          }
        }
        if (!repoRow) return;
        await dispatchMatchingTriggers(
          { db, eventBus },
          repoRow.id,
          event.eventType,
          event.payload,
        );
      },
    });
  };
  if (shouldStartObserversFor(db, "github")) {
    observerManager.register(buildGithubPoller());
  }

  // Each call returns a fresh observer so the integration-lifecycle
  // helper re-registers a new instance after a mode flip — picking up
  // any gitPollIntervalSeconds / gitPushOverdueMinutes /
  // hourlyCheckEnabled PATCH that landed while the cron was idle.
  const buildGitDelegatedCronObserver = (): GitDelegatedCronObserver =>
    new GitDelegatedCronObserver({
      db,
      eventBus,
      repoPaths: getNormalizedGitRepos().map((r) => r.path),
      githubRepos: selectGithubRepoSlugs(db),
      cadenceSeconds: config.gitPollIntervalSeconds,
      pushOverdueMinutes: config.gitPushOverdueMinutes,
      hourlyCheckEnabled: config.hourlyCheckEnabled,
    });
  if (hasActiveDelegatedGitLifecycleIntegration(db)) {
    observerManager.register(buildGitDelegatedCronObserver());
  }

  // Unified-repositories daily management cron — see
  // docs/design/appendices/unified-repositories.md §4.5. Iterates rows
  // whose `repository_management.enabled = 1` and writes the required
  // journal/overview markdown for each row that's due.
  observerManager.register(
    new RepositoryManagementCron({
      db,
      eventBus,
      contextDir: () => getContextDir(config, db),
      timezone: config.timezone || undefined,
      writeTracker,
    }),
  );

  // Coexistence note: the legacy /webhook/github handler also calls
  // recordObservation + EventBus.put, so a user with both webhooks AND
  // the poller live will receive two events per `review_requested`.
  // Log a one-time warning rather than disabling either path
  // automatically.
  if (secretState.githubWebhookConfigured && shouldStartObserversFor(db, "github")) {
    logger.warn(
      "GitHub webhook secret configured AND GitHubPoller running — "
        + "duplicate events possible. Remove the webhook secret or unregister "
        + "the GitHub webhook on github.com to silence.",
    );
  }

  // SETUP-FLOW-REDESIGN-PLAN §6.3 — `externalObsidianWatch` kill switch
  // for the external-vault branch.
  if (config.externalObsidianVaultPath && config.externalObsidianWatch) {
    observerManager.register(
      new ObsidianWatcher(
        config.externalObsidianVaultPath,
        db,
        config.obsidianDebounceSeconds,
        writeTracker,
        { source: "obsidian:external", name: "obsidian:external" },
      ),
    );
  }

  // Primary-vault watcher — registered unconditionally. Stays dormant
  // until `setVaultPath` points it at a real directory. The migration
  // endpoint's `onPrimaryVaultPathChange` callback calls setVaultPath
  // explicitly after every commit.
  const primaryVaultWatcher = new PrimaryVaultWatcher(
    db,
    config.obsidianDebounceSeconds,
    writeTracker,
  );
  await primaryVaultWatcher.setVaultPath(
    config.vaultMode === "obsidian" ? config.primaryVaultPath : null,
  );
  observerManager.register(primaryVaultWatcher);

  // Calendar poller — returns null when `services.calendar` is
  // unavailable so the integration-lifecycle module can no-op (for
  // example: integration flips to direct before OAuth is set up). The
  // §4.5.1 gate `google_calendar.mode === "direct"` is checked BEFORE
  // invoking the builder.
  const buildCalendarPoller = (): CalendarPoller | null => {
    if (!services.calendar) return null;
    return new CalendarPoller(
      services.calendar,
      db,
      config.calendarPollIntervalSeconds,
      config.googleCalendarId,
      writeTracker,
      triggerRoadmapRefresh,
      morningRoutineLock,
      config.timezone,
    );
  };

  if (services.calendar && shouldStartObserversFor(db, "google_calendar")) {
    const poller = buildCalendarPoller();
    if (poller) observerManager.register(poller);
  }

  observerManager.register(
    new ImminentEventScheduler(db, eventBus, config.googleCalendarId),
  );

  // Notion poller — returns null when `services.notion` is unavailable
  // or no databases are configured.
  const buildNotionPoller = (): NotionPoller | null => {
    if (!services.notion) return null;
    if (Object.keys(config.notionDatabaseIds).length === 0) return null;
    return new NotionPoller({
      notionService: services.notion,
      databaseIds: config.notionDatabaseIds,
      pollIntervalSeconds: config.notionPollIntervalSeconds,
      db,
      writeTracker,
    });
  };

  if (
    services.notion
    && Object.keys(config.notionDatabaseIds).length > 0
    && shouldStartObserversFor(db, "notion")
  ) {
    const poller = buildNotionPoller();
    if (poller) observerManager.register(poller);
  }

  if (services.mail) {
    observerManager.register(
      new MailPoller({
        registry: services.mail,
        db,
        writeTracker,
        pollIntervalSeconds: config.mailPollIntervalSeconds,
        maxMessagesPerPoll: config.mailMaxMessagesPerPoll,
        authFailureRetryHours: config.mailAuthFailureRetryHours,
        providerPollIntervalsSeconds: {
          gmail: config.gmailPollIntervalSeconds,
        },
        notifyOwner: async (message) => {
          await messageHub.sendToUser(message);
        },
        triggerRoadmapRefresh,
      }),
    );
    observerManager.register(
      new MailReconciliationJob({
        registry: services.mail,
        db,
      }),
    );
  }

  // ── 7.04 Skill-curation observers (P22 — appendix p22-skill-self-optimization.md) ──
  // Hourly walker accumulates `structure_diff` signals for the curation
  // cohort. Outcomes/feedback collection was dropped from the Preview
  // scope — the feature optimizes silently in the background.
  {
    const { SkillCurationWalker } = await import("../observers/skill-curation-walker.js");
    observerManager.register(
      new SkillCurationWalker(
        db,
        getContextDir(config),
        join(config.workspaceDir, "agent-assets", "skills"),
        config.dataDir,
      ),
    );
    // §5.4 — boot-time orphan-overlay scan. Emits one log line per
    // orphan and seeds `runtime_state.skill_curation.orphan_overlays`
    // so the dashboard banner can read it without re-walking the FS.
    try {
      const { scanAndRecordOrphanOverlays } = await import(
        "../core/skill-curation/orphan-overlay.js"
      );
      scanAndRecordOrphanOverlays(
        db,
        config.dataDir,
        join(config.workspaceDir, "agent-assets", "skills"),
      );
    } catch (err) {
      logger.warn({ err }, "Skill-curation orphan-overlay scan failed at boot");
    }
  }

  // ── 7.05 Context-index reconciler (B-004 Phase 2a) ──
  // Keeps `context/context-index.md` in sync with the filesystem so the
  // per-flow review-context loader can treat the index as authoritative.
  // Combines: startup one-shot (30 s after boot), internal chokidar
  // watcher on contextDir (10 s debounce), cron nightly, and API-route
  // hints. The prompt-context-changed sink is installed later by B-4.
  const contextIndexReconciler = new ContextIndexReconcilerObserver({
    db,
    contextDir: getContextDir(config),
    writeTracker,
    onPromptContextChanged: (path, reason, tier, metadata) => {
      // Route to the live sink — null until B-4 installs the
      // dispatcher-aware callback. Without the indirection the
      // observer would have to be constructed after the dispatcher,
      // breaking the §11 ordering invariant.
      promptSink?.(path, reason, tier, metadata);
    },
    morningRoutineLock,
    timezone: config.timezone || undefined,
  });
  observerManager.register(contextIndexReconciler);

  // docs/design/21-management-registry-and-entities.md §7.6 P5 —
  // entity-mirror watcher. Owns its own chokidar watcher independent of
  // the context-index reconciler's debounce path so single-file L2
  // writes converge into the SQLite mirror within NFR-9's 500 ms
  // budget. The §7.2 chain fans an L2 entity delta out to the
  // context-index observer's `requestReconcile` so the rendered
  // domain-index + activity-view files refresh on the same 10 s
  // debounce as other fs_event triggers.
  observerManager.register(
    new EntityMirrorObserver({
      db,
      contextDir: getContextDir(config),
      writeTracker,
      onEntityChanged: () => contextIndexReconciler.requestReconcile("fs_event"),
    }),
  );

  // ── 7.1 MCP auto-probe (B-003 Phase 4.3) ──
  // Walks enabled mcp_servers rows every `mcpAutoProbeIntervalMinutes`
  // and re-runs the probe sandbox. Set the interval to 0 to disable.
  // The observer never flips `enabled` on its own — failure surfaces
  // through the dashboard card's status dot.
  {
    const { McpAutoProbe } = await import("../services/mcp/auto-probe.js");
    observerManager.register(
      new McpAutoProbe({
        db,
        blobStore,
        dataDir: config.dataDir,
        intervalMinutes: config.mcpAutoProbeIntervalMinutes,
      }),
    );
  }

  // ── 7.2 Observation summarizer (cost-reduction-structural §A) ──
  // Drains pending observation rows asynchronously: pre-filter →
  // per-source LLM call → `summary_text` + `novelty_score` written
  // back to the row. The hourly_check skill consumes summaries instead
  // of re-fetching raw content. Disabled cleanly via
  // `observationSummarizerEnabled` — when off, observations stay
  // pending and the skill drops to legacy fetch-on-doubt.
  if (config.observationSummarizerEnabled) {
    const summarizerBinding = (() => {
      try {
        const row = db
          .prepare(
            `SELECT main_backend, main_model FROM process_backend_config WHERE process_key = 'observation.summarize'`,
          )
          .get() as { main_backend?: string; main_model?: string } | undefined;
        if (!row?.main_backend || !row.main_model) return null;
        return { backendId: row.main_backend, modelId: row.main_model };
      } catch (err) {
        logger.debug({ err }, "Failed to read observation.summarize binding; using fallback");
        return null;
      }
    })();

    const summarizerClient: SummarizerLlmClient = (() => {
      const fallbackBackend = summarizerBinding?.backendId ?? "claude";
      const fallbackModel = summarizerBinding?.modelId ?? "claude-haiku-4-5-20251001";
      if (fallbackBackend === "claude") {
        return new AnthropicSummarizerClient({
          modelId: fallbackModel,
          getApiKey: async () => {
            const direct = await secretBroker.getBackendApiKey("claude");
            if (direct) return direct;
            // Fall back to env (matches the daemon's API-key bridging policy).
            return process.env.ANTHROPIC_API_KEY ?? null;
          },
        });
      }
      // Codex / Gemini summarizer support is not yet implemented; the
      // worker translates `unsupported_backend` into a 'skipped' row so
      // the hourly_check skill drops to its legacy fetch path.
      return new UnsupportedSummarizerClient(
        fallbackBackend as SummarizerLlmClient["backendId"],
        fallbackModel,
      );
    })();

    observerManager.register(
      new ObservationSummarizerWorker({
        db,
        client: summarizerClient,
        concurrency: config.observationSummarizerConcurrency,
        perCallTimeoutMs: config.observationSummarizerTimeoutMs,
        maxLlmCallsPerMinute: config.observationSummarizerMaxCallsPerMinute,
        queueDepthLimit: config.observationSummarizerQueueLimit,
        preFilter: { vipMailSenders: config.vipMailSenders },
      }),
    );
  } else {
    logger.info("Observation summarizer disabled — pending rows stay pending");
  }

  return {
    observerManager,
    primaryVaultWatcher,
    contextIndexReconciler,
    gitAccountRegistry,
    buildGitWatcher,
    buildGithubPoller,
    buildGitDelegatedCronObserver,
    buildCalendarPoller,
    buildNotionPoller,
    // Only clears the in-memory slot reference. The actual observer
    // stop/unregister is performed by `applyIntegrationModeChange` via
    // `observerManager.stopAndUnregister("git")` BEFORE the api.ts
    // wrapper calls clearGitWatcher (api.ts:472-474). Doing both here
    // would double-stop a quiesced watcher.
    clearGitWatcher: () => {
      observerState.gitWatcher = null;
    },
    getGitWatcher: () => observerState.gitWatcher,
    queueGitProjectInitsForCurrentConfig,
    setPromptContextChangedSink,
  };
}

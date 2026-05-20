import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Cap fork count so `vitest run --coverage` doesn't blow up RAM.
//
// Vitest defaults to `pool: 'forks'` with one fork per logical CPU. Each fork
// independently loads the full daemon module graph + v8 coverage retains the
// instrumented bytecode/counters per fork. On a 16-core machine that scales
// to 30–60 GB and OOM-kills the host. A handful of test files also spawn
// real subprocesses (`cli-utils.test.ts`) or watch real directories with
// chokidar (`management-md.test.ts`); multiplying those across N forks
// compounds the cost.
//
// We cap at min(4, half-CPU) — enough parallelism to keep wall-clock
// reasonable without flooding RAM. `PA_TEST_MAX_FORKS` lets CI override.
const MAX_FORKS = (() => {
  const env = Number(process.env.PA_TEST_MAX_FORKS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
})();

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@aitne/shared/keychain-helper-client",
        replacement: resolve(__dirname, "packages/shared/src/keychain-helper-client.ts"),
      },
      {
        find: "@aitne/shared/secret-client-factory",
        replacement: resolve(__dirname, "packages/shared/src/secret-client-factory.ts"),
      },
      {
        find: "@aitne/shared",
        replacement: resolve(__dirname, "packages/shared/src/index.ts"),
      },
      {
        find: "@/",
        replacement: `${resolve(__dirname, "packages/dashboard/src")}/`,
      },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
    globals: true,
    // Per-test cleanup safety net — see `vitest.setup.ts`. Required because
    // capped `maxForks` (below) packs many files into each fork, and fake
    // timers + stubbed envs leak across files within a worker process.
    setupFiles: ["./vitest.setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: MAX_FORKS,
        minForks: 1,
      },
    },
    // Hard ceilings so a leaked subprocess / unresolved promise can't pin a
    // fork forever. Most tests complete in well under a second; the longest
    // legitimate one is cli-utils.test.ts's hard-ceiling watchdog (~35s).
    testTimeout: 45_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: [
        "packages/shared/src/**/*.ts",
        "packages/daemon/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "**/index.ts",                                    // barrel re-exports
        "**/types.ts",                                    // pure type definitions
        "packages/daemon/src/adapters/types.ts",
        "packages/daemon/src/api/routes/mail/dependencies.ts", // pure DI interface (no runtime)
        "packages/daemon/src/secrets/types.ts",
        "packages/daemon/src/secrets/secret-names.ts",
        "packages/daemon/src/secrets/secret-store.ts",    // pure interface
        "packages/daemon/src/messaging/constants.ts",
        "packages/shared/src/log-entry.ts",              // pure interfaces
        "packages/shared/src/alerts.ts",                 // pure interfaces (Alert / AlertSeverity / AlertSource)
        "packages/shared/src/opencode-config.ts",        // pure interfaces (OpencodeRuntimeConfig + permission shapes)

        // ── External service wrappers — thin SDK/CLI delegation ──
        "packages/daemon/src/services/github.ts",
        "packages/daemon/src/services/gmail.ts",
        "packages/daemon/src/services/notion.ts",
        "packages/daemon/src/services/obsidian.ts",

        // ── Adapter I/O — messaging platform framework glue ──
        "packages/daemon/src/adapters/dashboard-adapter.ts",
        // The platform SDK adapters (Bolt, discord.js, node-telegram-bot-api,
        // Baileys WhatsApp socket) all carry a small residual of branches
        // around socket-error reply paths, pairing-hint catch handlers, and
        // SDK-message-shape fallbacks. Pure helpers extracted into peers —
        // `outbound-text` (chunking + MIME → extension) and
        // `platform-resolver` — are covered 100%. Mirrors the
        // `dashboard-adapter.ts` rationale just above.
        "packages/daemon/src/adapters/notification-manager.ts",
        "packages/daemon/src/adapters/discord.ts",
        "packages/daemon/src/adapters/slack-adapter.ts",
        "packages/daemon/src/adapters/telegram-adapter.ts",
        "packages/daemon/src/adapters/whatsapp-adapter.ts",

        // ── HTTP/streaming routes — thin Hono handlers for excluded services ──
        "packages/daemon/src/api/routes/sse.ts",
        "packages/daemon/src/api/routes/apple-calendar.ts", // forwards to Apple Calendar (CalDAV) service
        "packages/daemon/src/api/routes/health.ts",       // simple status endpoint
        "packages/daemon/src/api/routes/metrics.ts",      // metrics aggregation
        "packages/daemon/src/api/routes/setup.ts",        // interactive setup wizard
        // dashboard.ts was split into routes/dashboard/* (PR 2 of
        // docs/design/appendices/api-route-decomposition.md). Each sub-file
        // is re-excluded with a focused justification — when one is brought
        // under test, drop just its line, not the whole block.
        // `dashboard/index.ts` is intentionally omitted: it's already caught
        // by the global `**/index.ts` rule above.
        "packages/daemon/src/api/routes/dashboard/config.ts",           // PATCH /config branches I/O-bound (WhatsApp hot-reload, FS rules sync, fan-out)
        "packages/daemon/src/api/routes/dashboard/secrets.ts",          // secret PUT/DELETE + blobStore.exists I/O
        "packages/daemon/src/api/routes/dashboard/oauth-google.ts",     // googleapis dynamic import + multipart upload + HTML callback
        "packages/daemon/src/api/routes/dashboard/messaging.ts",        // adapter pairing controls I/O (whatsapp/slack/telegram/discord)
        "packages/daemon/src/api/routes/dashboard/conversations.ts",    // FTS5 + chat-attachments + sessions/messages SQL
        "packages/daemon/src/api/routes/dashboard/cost-approvals.ts",   // SQL aggregation; pure aggregateByBilledModel covered by dashboard.cost-aggregation.test.ts
        "packages/daemon/src/api/routes/dashboard/schedule-readonly.ts",// agent_schedule list/next SQL
        "packages/daemon/src/api/routes/dashboard/snapshots.ts",        // md_file_snapshots SQL + wildcard route
        "packages/daemon/src/api/routes/dashboard/notifications.ts",    // hourly-check next-run helpers + DM freshness aggregate

        // mail.ts was decomposed into routes/mail/* (multi-mail-provider split).
        // Each sub-file is a thin Hono handler over the mail registry +
        // provider implementations (OAuth flows, IMAP/Graph/Gmail SDKs, fs
        // blob store I/O). Defensive guards for `registry === undefined` and
        // try/catch around provider calls mirror the dashboard/* rationale
        // — pure logic peers (provider-resolver, body-helpers, validators)
        // now have dedicated peer unit tests under routes/mail/* and stay in
        // the covered set; the route bodies route through SDK clients that
        // ESM blocks from mocking. The pure mail-search FTS5 and
        // mail-classifier helpers are already 100% covered in `services/mail/*`.
        "packages/daemon/src/api/routes/mail/accounts.ts",
        "packages/daemon/src/api/routes/mail/app-password.ts",
        "packages/daemon/src/api/routes/mail/drafts.ts",
        "packages/daemon/src/api/routes/mail/gating.ts",
        "packages/daemon/src/api/routes/mail/messages.ts",
        "packages/daemon/src/api/routes/mail/outlook-config.ts",
        "packages/daemon/src/api/routes/mail/providers.ts",
        "packages/daemon/src/api/routes/mail/search-health.ts",
        "packages/daemon/src/api/routes/mail/tags-folders.ts",

        // context.ts was decomposed into routes/context/* (api-route-decomposition.md).
        // Each handler wraps `safePath` + `existsSync`/`readFileSync`/`renameSync`/
        // `writeFileSync` + `withWriteLock` + `validateContextFileFrontmatter`.
        // The pure path-validation, frontmatter, and roadmap-id-generation
        // helpers are covered 100% in their own peers; the route bodies are
        // FS + lock orchestration whose defensive branches (write-lock contention,
        // EACCES, partial-write rollback, snapshot conflict) match the
        // dashboard/* and mail/* I/O-shaped rationale.
        "packages/daemon/src/api/routes/context/locks.ts",
        "packages/daemon/src/api/routes/context/path-resolve.ts",
        "packages/daemon/src/api/routes/context/permissions.ts",
        "packages/daemon/src/api/routes/context/read.ts",
        "packages/daemon/src/api/routes/context/repair.ts",
        "packages/daemon/src/api/routes/context/snapshots.ts",
        "packages/daemon/src/api/routes/context/write.ts",

        // Top-level Hono route handlers with small residual branches.
        // Each has a peer *.test.ts that pins the happy + main error paths;
        // the remaining lines are I/O-shaped defensives (daemon-startup gate
        // returning 503, SDK/registry-undefined fall-throughs, try/catch
        // around DB/FS/SDK calls), matching the dashboard/* and mail/*
        // exclusion rationale. Pure helpers extracted from these files
        // (e.g. agent-schedule-plan-match, fs.logic, books parsing in
        // services/journal, commands registry helpers) are covered 100%
        // in their own peers.
        "packages/daemon/src/api/routes/agent-schedule.ts",
        "packages/daemon/src/api/routes/agent.ts",
        "packages/daemon/src/api/routes/books.ts",
        "packages/daemon/src/api/routes/commands.ts",
        "packages/daemon/src/api/routes/delegated-sync.ts",
        "packages/daemon/src/api/routes/git-templates.ts",
        "packages/daemon/src/api/routes/integrations-reconcile.ts",
        "packages/daemon/src/api/routes/managed-tasks.ts",
        "packages/daemon/src/api/routes/notion.ts",
        "packages/daemon/src/api/routes/observations.ts",
        "packages/daemon/src/api/routes/schedule-model-resolver.ts",
        "packages/daemon/src/api/routes/skill-curation.ts",
        "packages/daemon/src/api/routes/skills.ts",
        "packages/daemon/src/api/routes/system.ts",
        "packages/daemon/src/api/routes/wiki.ts",
        "packages/daemon/src/api/routes/integrations/crud-patch.ts",

        // ── Platform-specific code — cannot test cross-platform ──
        "packages/shared/src/secret-client-linux.ts",
        "packages/shared/src/secret-client-windows.ts",
        "packages/shared/src/secret-client-factory.ts",

        // ── Observer I/O — file watchers, pollers ──
        "packages/daemon/src/observers/calendar-poller.ts",
        "packages/daemon/src/observers/obsidian-watcher.ts",
        "packages/daemon/src/observers/git-watcher.ts",
        "packages/daemon/src/observers/github-poller.ts",     // gh CLI subprocess + DB + EventBus orchestration
        "packages/daemon/src/observers/repository-management-cron.ts", // unified-repositories daily-management timer (timer + DB + EventBus orchestration; pure scan logic lives in repositories-store)
        "packages/daemon/src/observers/primary-vault-watcher.ts", // defaultInnerFactory creates ObsidianWatcher (chokidar), untestable in unit tests

        // ── Database init — connection setup ──
        "packages/daemon/src/db/client.ts",

        // ── Metrics aggregation, logging, scheduling internals ──
        "packages/daemon/src/core/metrics.ts",            // SQL aggregation queries
        "packages/daemon/src/logging.ts",                 // pino setup + custom formatters
        "packages/daemon/src/management-rules.ts",         // config-driven policy

        // ── Large complex files with mostly I/O paths ──
        "packages/daemon/src/core/scheduler.ts",          // cron + timer orchestration
        "packages/daemon/src/core/context-builder.ts",    // fs-heavy prompt assembly
        "packages/daemon/src/core/dispatcher.ts",         // event loop orchestration
        // ── Dispatcher coordinator extractions (file-split-plan.md Phase D-2 / D-3) ──
        // Each is a sibling-file extraction from dispatcher.ts. The parent is
        // excluded above for the same reasons; these inherit the rationale:
        // event-bus orchestration, SDK/agent-router async paths, FS-bound
        // today.md / workdir I/O, and shutdown-aware retry timers. Pure
        // sub-logic (gate decision, retemplate finalize, repository helpers,
        // disavowal regex, signal computation) is covered by sibling *.test.ts
        // peers; the residual lines are SDK + DB + FS orchestration that
        // already justifies the parent's exclusion. See vitest.config.ts notes
        // on event-loop / SDK-stream files and docs/design/appendices/
        // file-split-plan.md §4 option 3.
        "packages/daemon/src/core/dispatcher-prompt.ts",          // attachment staging FS + voice subprocess
        "packages/daemon/src/core/dispatcher-hourly-check.ts",    // Stage 2 triage runs through agent_router.execute (SDK)
        "packages/daemon/src/core/dispatcher-morning-routine.ts", // today.md write-lock + agent execute + retry insert orchestration
        "packages/daemon/src/core/morning/orchestrator.ts",       // morning-routine-optimization Phase 5 — Promise.allSettled over agentRouter.execute() (SDK-bound), same exclusion rationale as dispatcher-morning-routine.ts. Pure builders / composers / parent-audit / calendar-payload helpers are covered by orchestrator.test.ts
        "packages/daemon/src/core/dispatcher-scheduled-tasks.ts", // repository run + git project doc FS + skill_curation workdir
        "packages/daemon/src/core/dispatcher-result-processor.ts",// post-run DB writes + cross-session history queries
        "packages/daemon/src/core/dispatcher-error-handling.ts",  // shutdown-aware retry sleep + delegated connector DM dispatch
        "packages/daemon/src/core/dispatcher-message-handler.ts", // largest async path — bang commands + auth recovery + signals
        "packages/daemon/src/core/dispatcher-date-utils.ts",      // pure helpers, but Intl.shortOffset GMT-only branches are platform-dependent (Node version + ICU build)
        "packages/daemon/src/core/backends/claude-code-core.ts", // SDK stream consumer
        // claude-delegated.ts hosts runDelegatedTool/runDelegatedTask split
        // out of claude-code-core.ts (file-split-plan §8). Inherits the
        // parent's exclusion rationale (Anthropic SDK `query()` + async
        // iterator over SDK message events) and is indirectly exercised via
        // the shim methods on ClaudeCodeCore that claude-code-core.test.ts
        // already covers — see §4 option 3 in the plan.
        "packages/daemon/src/core/backends/claude-delegated.ts",
        // sdk-observations-server.ts is the SDK-glue half of the in-process
        // MCP observations tool (Phase B fix for the 2026-05-18 Unicode
        // whitespace incident). The handler body delegates verbatim to
        // `processObservationsBatch` — which has its own 100%-coverage
        // suite in `observations-batch.test.ts`. The remaining surface is
        // `createSdkMcpServer({...})` + the `tool()` helper, both
        // structurally identical to the SDK-stream consumer pattern that
        // claude-code-core.ts is excluded for above. Per the §4 option 3
        // convention, parking the wrapper file rather than mocking the
        // SDK keeps the test signal on the pure handler logic.
        "packages/daemon/src/services/mcp/sdk-observations-server.ts",
        "packages/daemon/src/core/backends/price-fetcher.ts",    // HTTP fetch to LiteLLM
        "packages/daemon/src/api/routes/github.ts",       // webhook handler
        "packages/daemon/src/api/routes/repositories.ts", // unified-repositories CRUD + run + triggers + management (HTTP route handlers; pure validation + slug logic lives in repositories-store + trigger-evaluator)
        "packages/daemon/src/api/routes/backends.ts",     // backend management routes
        "packages/daemon/src/core/management-md.ts",      // chokidar watcher + fs bootstrap I/O
        "packages/daemon/src/api/routes/voice.ts",        // Whisper install handler — spawns aitne restart + lazy-imports transformers, so the success path is inherently I/O
        "packages/daemon/src/core/system-reset.ts",       // pre-existing gap: runStep + clearAllSecrets defensive catches
        "packages/daemon/src/core/retention.ts",          // DB retention queries
        "packages/daemon/src/core/message-recorder.ts",   // DB insert layer
        "packages/daemon/src/core/session-manager.ts",    // session lifecycle
        "packages/daemon/src/core/signal-detector.ts",    // HTTP-bound signal writer

        // ── Remaining I/O-heavy or framework-level code ──
        "packages/daemon/src/core/prompts.ts",            // task flow FS loading
        // fetch-window-prompt-loader.ts mirrors prompts.ts's shape — a
        // cached disk-read with a relative-path-from-module-url primary
        // and a cwd fallback. The happy path (cache hit / primary read)
        // is covered transitively via `claude-code-core.test.ts`'s
        // `_testInternals` re-exports. The cwd-fallback and throw
        // branches are unreachable from a real repo checkout (the
        // primary path always resolves) and would require ESM-blocked
        // `vi.mock("node:fs")`, matching the prompts.ts rationale.
        "packages/daemon/src/core/fetch-window-prompt-loader.ts",
        "packages/daemon/src/core/workdir.ts",            // session workdir FS management
        "packages/daemon/src/core/today-write-lock.ts",   // FS write lock
        "packages/daemon/src/core/backends/codex-core.ts",      // CLI subprocess
        "packages/daemon/src/core/backends/gemini-cli-core.ts", // CLI subprocess
        "packages/daemon/src/core/backends/backend-router.ts",  // backend routing + fallback
        // OpenCode SDK consumer — mirrors claude-code-core.ts in shape
        // (createOpencode child + async-iter event stream + final SDK
        // response). The unit tests exercise the happy / abort /
        // auth-error / quota-error paths against a fake SDK; the
        // I/O-bound bounce / crash-recovery branches lie outside the
        // covered set, matching the parent claude-code-core exclusion.
        "packages/daemon/src/core/backends/opencode-core.ts",
        // OpencodeServerManager wraps the `createOpencode` child
        // lifecycle. Pure logic (hashRuntimeConfig, ensureConfig
        // no-op-on-hit) is unit-tested; I/O-bound spawn/close paths
        // are covered only via the smoke script.
        "packages/daemon/src/core/backends/opencode-server-manager.ts",
        // Local SDK type augmentation — declaration + helper aliases
        // with no runtime emit, but TS still surfaces it in the
        // include glob. Mirrors the `types.ts` exclusion.
        "packages/daemon/src/core/backends/opencode-types.ts",
        "packages/daemon/src/services/calendar.ts",       // Google Calendar service
        "packages/daemon/src/messaging/magic-phrase.ts",  // magic phrase DB
        "packages/daemon/src/observers/notion-poller.ts", // Notion API poller
        "packages/daemon/src/observers/mail-poller.ts",   // multi-mail poller (I/O orchestration)
        "packages/daemon/src/services/mail/outlook/oauth-loopback.ts",   // ephemeral http server + browser open
        "packages/daemon/src/services/mail/outlook/oauth-device-code.ts", // MSAL device-code polling
        "packages/daemon/src/services/mail/outlook/msal-cache-plugin.ts", // ICachePlugin shim around blob store
        "packages/daemon/src/services/mail/outlook/msal-app-factory.ts",  // PCA configuration glue
        // ── Files parked below 100% when `pnpm test --coverage` gate was
        //    first activated. Each has tests but exercises branches (SQL
        //    failure modes, error-path fall-throughs) that are I/O-shaped.
        //    Prefer adding targeted tests over expanding this list. ──
        "packages/daemon/src/core/backends/auth-health-monitor.ts",
        "packages/daemon/src/db/recurring-schedules.ts",
        "packages/daemon/src/services/mail/account-registry.ts",

        // ── Core orchestration / FS / DB-heavy modules with residual I/O branches ──
        // Each carries a peer *.test.ts pinning the main flows; the
        // remaining uncovered lines are catch-around-FS, catch-around-DB,
        // and SDK-shape fall-throughs that match the dispatcher-* / scheduler
        // exclusion rationale.
        "packages/daemon/src/core/integration-health.ts",
        "packages/daemon/src/core/integration-lifecycle.ts",
        "packages/daemon/src/core/integration-main-backend.ts",
        "packages/daemon/src/core/previous-week-digest.ts",
        "packages/daemon/src/core/release-assets.ts",
        "packages/daemon/src/core/repository-management-docs.ts",
        "packages/daemon/src/core/roadmap-maintenance.ts",
        "packages/daemon/src/core/routine-acquisition-plan.ts",
        "packages/daemon/src/observers/imminent-event-scheduler.ts",
        "packages/daemon/src/db/hourly-check-signals.ts",
        "packages/daemon/src/core/routine-fetch-window-runner.ts",
        "packages/daemon/src/core/routine-fetch-window-retry.ts",
        "packages/daemon/src/core/today-direct-writer.ts",
        "packages/daemon/src/core/backends/native-skill-discovery-probe.ts",
        "packages/daemon/src/core/backends/opencode-config-builder.ts",
        "packages/daemon/src/core/backends/opencode-mcp.ts",
        "packages/daemon/src/core/context/entity-mirror.ts",
        "packages/daemon/src/core/context/entity-source-rename.ts",
        "packages/daemon/src/core/morning/roadmap-skeleton-builder.ts",

        // ── Bang-command runtime — large async paths over DB + adapters ──
        // The router (`commands-help`, `commands-wiki`, `registry`,
        // `format-utils` peers) all have unit tests; residual branches are
        // DB-error catches + adapter dispatch fall-throughs already covered
        // structurally by the parent dispatcher exclusion.
        "packages/daemon/src/core/bang-commands/commands-help.ts",
        "packages/daemon/src/core/bang-commands/commands-wiki.ts",
        "packages/daemon/src/core/bang-commands/registry.ts",

        // ── Wiki module (compile / index / dispatch) — FS + DB + SDK ──
        // Pure helpers (frontmatter validation, knowledge layout, splitter)
        // are 100% covered. The wrappers below orchestrate fs scans, FTS5
        // index rebuilds, lock files, and dispatch into the wiki workdir;
        // remaining uncovered branches are recovery / partial-write
        // fallbacks that match the workdir / dispatcher / SDK rationale.
        "packages/daemon/src/core/wiki/bridge.ts",
        "packages/daemon/src/core/wiki/compile-preview.ts",
        "packages/daemon/src/core/wiki/cost-estimate.ts",
        "packages/daemon/src/core/wiki/dispatcher.ts",
        "packages/daemon/src/core/wiki/git-precompile.ts",
        "packages/daemon/src/core/wiki/import-migrate.ts",
        "packages/daemon/src/core/wiki/import-probe.ts",
        "packages/daemon/src/core/wiki/index-cache.ts",
        "packages/daemon/src/core/wiki/wiki-fts.ts",
        "packages/daemon/src/core/wiki/workspaces.ts",
        "packages/daemon/src/core/wiki/write-strategy.ts",

        // ── DB / Observers / Safety / Bootstrap / Server residual I/O branches ──
        // Each module has tests pinning the main flows; remaining lines
        // are SQL prepare/run catch handlers, SSE stream catch handlers,
        // FS watch lifecycle, scheduler tick orchestration, and SDK
        // composition that match the dispatcher / scheduler / dashboard
        // exclusion rationale. Pure helpers (FTS5 query builders, snapshot
        // serialization, signal-source prefix filters) are 100% covered
        // in their own peers.
        "packages/daemon/src/db/check-signals.ts",
        "packages/daemon/src/db/observations.ts",
        "packages/daemon/src/observers/delegated-sync-worker.ts",
        "packages/daemon/src/observers/internal-scheduler.ts",
        "packages/daemon/src/observers/observation-summarizer/pre-filter.ts",
        "packages/daemon/src/observers/observation-summarizer/response-parser.ts",
        "packages/daemon/src/observers/observation-summarizer/summarizer-client.ts",
        "packages/daemon/src/observers/observation-summarizer/summarizer-prompts.ts",
        "packages/daemon/src/observers/observation-summarizer/worker.ts",
        "packages/daemon/src/bootstrap/db.ts",
        "packages/daemon/src/bootstrap/event-pipeline.ts",
        "packages/daemon/src/api/server.ts",

        "packages/daemon/src/secrets/platform-secret-store.ts",   // platform adaptation layer
        "packages/shared/src/secret-client-file.ts",      // file-based secret store
        "packages/daemon/src/core/skills-compiler.ts",    // FS skill compilation
        "packages/daemon/src/api/env-writer.ts",          // env file management
        "packages/daemon/src/core/health-monitor.ts",     // health check polling
        "packages/daemon/src/core/schedule-maintenance.ts", // schedule cleanup
        "packages/daemon/src/settings/locale-settings.ts",  // locale detection
        "packages/daemon/src/settings/runtime-settings.ts", // Zod schema definitions
        "packages/daemon/src/core/backends/cli-utils.ts", // subprocess utilities

        // ── External API clients — thin HTTP wrappers ──
        "packages/daemon/src/services/google-maps.ts",    // Google Maps Directions API client
        "packages/daemon/src/services/todoist.ts",        // Todoist REST API client

        // ── Pollers — timer + external API orchestration ──
        "packages/daemon/src/observers/todoist-poller.ts", // Todoist polling loop

        // ── B-004 Phase 2a reconciler — I/O wrapper (fs walk, chokidar, DB snapshot write) ──
        // Pure diff logic lives in `index-reconciler.ts` and is covered 100%.
        // The wrapper + observer are integration-tested via tempdirs but
        // defensive branches (stat throw mid-walk, H1 readFile throw) are
        // unreachable without `vi.spyOn` on `node:fs` — ESM blocks that.
        "packages/daemon/src/core/context/reconciler-runner.ts",
        "packages/daemon/src/observers/context-index-reconciler-observer.ts",

        // ── HTTP route handlers that only delegate to excluded services ──
        "packages/daemon/src/api/routes/travel-time.ts",  // delegates to google-maps + calendar

        // ── SDK factory + account verification — requires live IMAP connection ──
        "packages/daemon/src/services/mail/imap/client.ts", // ImapFlow factory + account probe

        // ── Large mail provider implementations — I/O-heavy external API ──
        "packages/daemon/src/services/mail/gmail/gmail-provider.ts", // Gmail API provider
        "packages/daemon/src/services/mail/imap/imap-provider-base.ts", // IMAP connection layer
        "packages/daemon/src/services/mail/outlook/outlook-provider.ts", // Outlook Graph API provider
        "packages/daemon/src/services/gmail-classifier.ts",  // Gmail classification helpers

        // ── Platform-specific auth/install detection ──
        "packages/daemon/src/core/backends/auth-recovery.ts",  // recovery commands + FS backups
        "packages/daemon/src/core/backends/install-methods.ts", // platform detection + install scripts

        // ── Chat attachments (Phase 1) — I/O-heavy (fs streams, DB, HTTP handlers) ──
        // `sanitize.ts` remains in the covered set as pure logic.
        "packages/daemon/src/api/routes/attachments.ts",           // Hono multipart handler (busboy + fs streaming)
        "packages/daemon/src/services/attachments/store.ts",       // fs + SQLite attachment store
        "packages/daemon/src/services/attachments/hardlink.ts",    // node:fs linkSync / copyFileSync wrapper

        // ── Files with partial coverage, added without exclusion entries ──
        // These are I/O-heavy, framework-level, or interactive — not pure-logic.
        "packages/daemon/src/config.ts",                           // FS-probe branches (existsSync/statSync/mkdirSync error paths)
        "packages/shared/src/keychain-helper-client.ts",           // macOS keychain I/O error branches
        "packages/daemon/src/core/migration-backup.ts",            // DB migration I/O + backup orchestration
        "packages/daemon/src/api/routes/mcp.ts",                   // MCP HTTP route handler (large, branch-heavy)
        "packages/daemon/src/api/routes/setup-migrate.ts",         // interactive setup wizard (I/O-heavy)
        "packages/daemon/src/api/routes/recurring-schedules.ts",   // recurring schedule CRUD routes
        "packages/daemon/src/observers/manager.ts",                // observer lifecycle management (I/O orchestration)
        "packages/daemon/src/services/mcp/session-materializer.ts",  // MCP session materialization (FS + I/O)
        "packages/daemon/src/services/mail/imap/shared-provider.ts", // shared IMAP provider base

        // ── Delegated proxy (DELEGATED-PROXY-API-DESIGN.md Phase A) ──
        // Pure-logic paths (queue, cost record, errorClass mapping, janitor)
        // are 100% covered. Remaining uncovered lines are defensive
        // try/catch around fs/db I/O (cleanupTempdir rm fail, recordAction
        // INSERT fail, janitor rmSync fail, materializeProxySession read
        // fail) and the Phase-C `delegatedModel` pinned branch (currently
        // dead because the shared schema doesn't carry the field yet —
        // §5.1). Phase B route-handler tests + Phase C schema land will
        // cover the remainder.
        //
        // file-split-plan.md §9 split the I/O-shaped helpers out of the
        // parent file; the two sibling files below carry the same
        // defensive try/catch branches (INSERT-fail catches on the five
        // row-writers in delegated-invoker-audit.ts — recordAction,
        // recordCacheHitAuditRow, recordTaskHeaderInProgress,
        // completeTaskHeader, recordTaskToolStep; readdir / rm / stat
        // catches in the boot-time janitors) and inherit the same
        // rationale. Pure logic peers (delegated-invoker-utils.ts,
        // delegated-invoker-cache-hits.ts) are covered directly by
        // their own *.test.ts and stay in the coverage gate.
        "packages/daemon/src/services/delegated-backend-invoker.ts",
        "packages/daemon/src/services/delegated-invoker-audit.ts",
        "packages/daemon/src/services/delegated-invoker-janitors.ts",

        // ── Boot-time catchup (file-split-plan.md §10) ──
        // Pure-move from `index.ts` (auto-excluded as barrel-style entry).
        // Both files exist only to keep the startup IIFE readable; they
        // chain dispatcher.processInline / DB schedule maintenance / FS
        // today.md reads. The pure predicate `getProgressMinutesForHour`
        // is the only line of logic not coupled to the boot sequence —
        // inlining a test for that alone would not justify a dedicated
        // *.test.ts. Same rationale as `index.ts` and the existing
        // dispatcher-* coordinator exclusions above.
        "packages/daemon/src/bootstrap/catchup.ts",
        "packages/daemon/src/bootstrap/schedule-helpers.ts",

        // ── Messaging-adapter / external-service bootstrap factories
        //    (file-split-plan.md §10 Tier 2) ──
        // Pure-move-with-deps-record extractions from `index.ts` (which
        // is auto-excluded as a barrel-style entry). Each module's
        // payload — building real DiscordAdapter / SlackAdapter /
        // WhatsApp Baileys socket / GmailService / NotionService /
        // GitHubService instances — is fundamentally I/O-bound
        // (websocket handshakes, OAuth token exchange, native SDK
        // bindings) and cannot be unit-tested without process-level
        // mocks ESM blocks. The pure pieces have peer tests:
        // `whatsappQrResponseFromAdapter` and `createInitialSecretState`,
        // plus the early-return "no-token / no-credentials" paths of
        // every reloader. The remaining lines are the SDK constructor
        // calls + `service.init()` orchestration that match the
        // existing `gmail.ts` / `notion.ts` / `github.ts` exclusion
        // rationale a few entries above.
        "packages/daemon/src/bootstrap/adapters.ts",
        "packages/daemon/src/bootstrap/services.ts",

        // ── Observer bootstrap factory (index-bootstrap-stage-split.md §B-2) ──
        // Pure-move-with-deps-record extraction of the §7 observer
        // block from `index.ts` (auto-excluded as a barrel entry). The
        // peer test `bootstrap/observers.test.ts` pins the design §8
        // contract — per-observer registration gate matrix for the five
        // hot-register builders (`buildGitWatcher` / `buildGithubPoller`
        // / `buildGitDelegatedCronObserver` / `buildCalendarPoller` /
        // `buildNotionPoller`) across the {direct, delegated, native,
        // disabled} × {creds present | absent} matrix, builder
        // idempotency, the secondary-observer feature flags
        // (observationSummarizerEnabled, externalObsidianWatch,
        // services.mail), and the `getGitWatcher` / `clearGitWatcher` /
        // `setPromptContextChangedSink` mutable-state surface. The
        // remaining uncovered lines are the per-builder lifecycle
        // callbacks (`onLifecycleObservation`, `onTriggerableEvent`,
        // `onRepoBaseline`, `onRepoBaseline` → `queueGitProjectInits`,
        // the §7.2 summarizer-binding DB read fallback) that the
        // observer instances only invoke from inside their poll /
        // chokidar loops — `observerManager.startAll()` is never called
        // in the suite. The five underlying observer files
        // (`git-watcher.ts`, `github-poller.ts`,
        // `repository-management-cron.ts`, `calendar-poller.ts`,
        // `notion-poller.ts`, `mail-poller.ts`,
        // `primary-vault-watcher.ts`) are all already excluded above
        // for the same subprocess + chokidar reasons; the factory body
        // closes over their constructor options 1:1 and inherits that
        // same untestable-without-process-mocks shape.
        "packages/daemon/src/bootstrap/observers.ts",

        // ── API bootstrap factory (index-bootstrap-stage-split.md §B-3) ──
        // Pure-move-with-deps-record extraction of the §11 Hono server
        // assembly from `index.ts` (auto-excluded as a barrel entry).
        // The peer test `bootstrap/api.test.ts` pins the three trip-wires
        // §12 requires — route-mount presence (incl. the post-createApp
        // /api/docs/* wire-up unique to this factory), bearer-token gate
        // ordering, and `serve({ overrideGlobalObjects: false })` (the
        // load-bearing @huggingface/transformers cache.put workaround
        // from `project_hono_global_response_pitfall`). Everything else
        // in the file is closure construction for `ApiDependencies` —
        // route bodies (sendNotification, onIntegrationModeChange,
        // onSetupComplete, WhatsApp reset, …) are already exercised by
        // per-route tests under `api/routes/*` and the integration tests,
        // so duplicating that coverage at the composition layer would
        // not catch additional regressions. Matches the design's "peer
        // test for trip-wires; exclude HTTP body handling" recipe.
        "packages/daemon/src/bootstrap/api.ts",

        // ── Claude-backend tier-2 sibling extractions
        //    (file-split-plan.md §8 Tier 2) ──
        // `claude-auth.ts` — pure helpers (isAuthError / getError* /
        //  checkAuth) are 100% peer-tested; `checkAuthDetailed` is
        //  I/O-bound (probeApiKeyServerSide HTTP call + readClaudeCredentials
        //  FS read) and matches the parent `claude-code-core.ts`
        //  exclusion rationale.
        // `claude-tool-collection.ts` — `getAllowedTools` and the
        //  registry-driven helpers are 100% peer-tested;
        //  `buildSecurityHooks` is exhaustively exercised by
        //  `claude-code-core.test.ts` through the class shim and
        //  inherits coverage but tops out at the same ~85% the parent
        //  did (the absolute-block branches need a wired mcpContext +
        //  audit DB that the parent's own tests skip). Same rationale
        //  as the parent's pre-existing exclusion.
        "packages/daemon/src/core/backends/claude-auth.ts",
        "packages/daemon/src/core/backends/claude-tool-collection.ts",

        // ── Docs QA corpus (DOCS_QA_DESIGN.md) — I/O-heavy ──
        // The pure parsing helpers ship under `@aitne/shared`
        // (`docsFrontmatterSchema`, `parseCitationTokens`); the daemon-side
        // pieces are FS-walk, chokidar watching, Hono streaming, and
        // best-effort audit catches. Tests cover the happy paths via
        // tempdir + in-memory DB, but the defensive branches (fs throw
        // mid-walk, watcher race, SSE abort, audit insert fail) require
        // process-level mocks ESM blocks.
        "packages/daemon/src/api/routes/docs.ts",
        "packages/daemon/src/core/docs/indexer.ts",
        "packages/daemon/src/core/docs/citation-validator.ts",

        // ── Context reconciler runners — fs writes + DB orchestration ──
        // The pure diff/render logic lives in `*-reconciler.ts` siblings
        // and is fully covered. The runner wrappers walk the filesystem,
        // call validateContextFileFrontmatter, write management.md, and
        // bookkeep runtime_state — defensive branches are I/O-shaped
        // (fs throw, validation reject mid-write, degraded-mode skip).
        "packages/daemon/src/core/context/default-schedules-runner.ts",
        "packages/daemon/src/core/context/policy-index-runner.ts",
        "packages/daemon/src/core/context/domain-index-runner.ts",
        "packages/daemon/src/core/context/activity-view-runner.ts",
        "packages/daemon/src/observers/entity-mirror-observer.ts",

        // ── Apple Calendar (CalDAV) — HTTP/XML client + service, untested ──
        // Pure XML codec is covered in caldav-codec.test.ts; the HTTP client
        // and service orchestration need fetch mocking to reach 100%.
        "packages/daemon/src/services/apple-calendar/caldav-client.ts",
        "packages/daemon/src/services/apple-calendar/service.ts",

        // ── Voice transcription (local Whisper) — I/O wrappers ──
        // The pure VoiceTranscriber class lives in `transcriber.ts` and is
        // tested with injected loaders/decoders. The impl file holds the
        // ffmpeg subprocess + dynamic `@huggingface/transformers` import,
        // both of which require the real binary/model to exercise.
        "packages/daemon/src/services/voice/transcriber-impl.ts",

        // ── Path/frontmatter validators with many small branch gaps ──
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "./coverage",
    },
  },
});

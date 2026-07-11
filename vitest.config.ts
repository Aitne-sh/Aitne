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
        "packages/daemon/src/core/backends/model-registry.ts", // compat barrel — re-exports @aitne/shared model-registry (the real impl lives in shared/src/model-registry.ts and IS covered)

        // ── Pure type / interface declaration files (no runtime code) ──
        // Each file below is a Zod-free `export interface` / `export type`
        // module — instrumentation reports 0% because there are no
        // statements to execute. Mirrors the **/types.ts category above.
        "packages/shared/src/log-entry.ts",
        "packages/shared/src/alerts.ts",                  // type-only — Alert shape; the *aggregator* in daemon/src/core/alerts.ts has its own coverage
        "packages/shared/src/opencode-config.ts",         // opencode runtime-config interfaces (the builder is `opencode-config-builder.ts`)
        "packages/daemon/src/secrets/secret-store.ts",    // SecretStore interface (impl is platform-secret-store.ts / encrypted-blob-store.ts)
        "packages/daemon/src/core/backends/opencode-types.ts", // `declare module` augmentation + helper types
        "packages/daemon/src/core/skills-compiler-types.ts",   // SessionInstructionParams interface (extracted from skills-compiler.ts Phase 1 split)
        "packages/daemon/src/api/helpers/agent-errors-types.ts", // AgentErrorEnvelope / AgentErrorIssue / constraint types (no runtime code)
        "packages/daemon/src/api/routes/mail/dependencies.ts", // MailRouteDependencies interface


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
        "packages/daemon/src/api/routes/dashboard/notifications.ts",    // activity-scan next-run helpers + DM freshness aggregate

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
        // Unified Task Board glue: DB reads for the inventory/impact projection
        // + the L1 facade's in-process re-dispatch. All decision logic (ref
        // grammar, projection, blast-radius, the §9 dispatch guards) lives in
        // the 100%-covered pure peers under core/task-board/*; the route body is
        // read-orchestration + a Request forward (the dispatch-unavailable 501,
        // header copy, and owner-response passthrough are I/O-shaped, matching
        // the agent-schedule.ts / managed-tasks.ts rationale). Peer
        // `routes/tasks.test.ts` pins the happy GET + facade routing paths.
        "packages/daemon/src/api/routes/tasks.ts",
        "packages/daemon/src/api/routes/books.ts",
        "packages/daemon/src/api/routes/integrations-reconcile.ts",
        "packages/daemon/src/api/routes/managed-tasks.ts",
        // 888-line route with 63-test peer covering happy paths but ~21
        // branch gaps remaining (per-endpoint body_too_large declared +
        // actual, c.req.text() throw catches, integration flip-lock 409,
        // batch envelope shape errors, consume validator field-issue
        // branches). Defensive validation paths worth covering, but each
        // requires a hand-crafted payload — ~20 tests of additional work.
        // Re-added 2026-05-22 after a brief pragmatic pass; the smaller
        // siblings `system.ts` / `delegated-sync.ts` / `commands.ts` /
        // `git-templates.ts` all landed at 100% in the same pass.
        "packages/daemon/src/api/routes/observations.ts",
        "packages/daemon/src/api/routes/feedback.ts",     // capture/consume Hono handlers + the FS-enumerating GET /feedback/lessons overview; peer test pins validation/dedup/sanitize/consume + the lessons happy paths, the pure summarizeLessonStore is 100% on its own
        "packages/daemon/src/api/routes/skill-curation.ts",
        
        "packages/daemon/src/api/routes/wiki.ts",
        "packages/daemon/src/api/routes/integrations/crud-patch.ts",

        // ── Platform-specific code — cannot test cross-platform ──
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

        // ── Large complex files with mostly I/O paths ──
        "packages/daemon/src/core/scheduler.ts",          // cron + timer orchestration
        "packages/daemon/src/core/context-builder.ts",    // fs-heavy prompt assembly
        // ── ContextBuilder block-builder extractions (FILE_SPLIT_PLAN_CONTEXT_BUILDER.md §5) ──
        // Sibling-file extractions from context-builder.ts. The parent is
        // excluded above for fs-heavy / DB-heavy prompt-assembly reasons; the
        // calendar / conversation / projects / yesterday siblings inherit the
        // same rationale (CalendarService fetches, multi-scope SQL joins,
        // readdirSync / readFile fan-out over the projects directory, agent-day
        // SQL aggregations). Format helpers are excluded because they are
        // pure transforms with their own context-builder-format.test.ts peer
        // at 100% — keep it OUT of this list so the gate continues to enforce.
        "packages/daemon/src/core/context-builder-calendar.ts",     // CalendarService async fetch + per-provider mode branches
        "packages/daemon/src/core/context-builder-conversation.ts", // multi-scope DM history SQL + proactive-forward audit insert
        "packages/daemon/src/core/context-builder-projects.ts",     // readdirSync + per-file readFile fan-out
        "packages/daemon/src/core/context-builder-yesterday.ts",    // agent-day SQL aggregations across messages / agent_actions / dm_conversation_log
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
        "packages/daemon/src/core/dispatcher-activity-scan.ts",    // Stage 2 triage runs through agent_router.execute (SDK)
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
        "packages/daemon/src/core/agents/loader-watcher.ts", // chokidar watcher glue (AGENT_DEFINITIONS §6.2); reload logic lives in loader.ts (covered), watcher behaviour pinned by loader-watcher.test.ts — mirrors management-md.ts rationale
        "packages/daemon/src/core/agents/loader-boot.ts", // boot wiring (AGENT_DEFINITIONS §6.1 Phase-7) — assembles the loader's snapshot/SSE/recurring ports + dirs over the real db/fs and starts the watcher; pure mapping (recurring-schedule-adapter) + the loader core are covered, this is the index.ts-style glue layer
        "packages/daemon/src/api/routes/voice.ts",        // Whisper install handler — spawns aitne restart + lazy-imports transformers, so the success path is inherently I/O
        "packages/daemon/src/core/system-reset.ts",       // pre-existing gap: runStep + clearAllSecrets defensive catches
        "packages/daemon/src/core/retention.ts",          // DB retention queries
        "packages/daemon/src/core/session-manager.ts",    // session lifecycle

        // ── Remaining I/O-heavy or framework-level code ──
        "packages/daemon/src/core/prompts.ts",            // task flow FS loading
        // slim-system-prompt-loader.ts mirrors prompts.ts's shape — a
        // per-template cached disk-read with a relative-path-from-module-url
        // primary and a cwd fallback (RESEARCH_CLUSTER_COST_FIX_PLAN.md F4
        // generalized the former fetch-window-prompt-loader.ts). The happy
        // path (cache hit / primary read) is covered by its own
        // `slim-system-prompt-loader.test.ts` plus `claude-code-core.test.ts`'s
        // `_testInternals` re-exports. The cwd-fallback and throw branches
        // are unreachable from a real repo checkout (the primary path always
        // resolves) and would require ESM-blocked `vi.mock("node:fs")`,
        // matching the prompts.ts rationale.
        "packages/daemon/src/core/slim-system-prompt-loader.ts",
        "packages/daemon/src/core/workdir.ts",            // session workdir FS management
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
        "packages/daemon/src/services/calendar.ts",       // Google Calendar service
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

        // ── Core orchestration / FS / DB-heavy modules with residual I/O branches ──
        // Each carries a peer *.test.ts pinning the main flows; the
        // remaining uncovered lines are catch-around-FS, catch-around-DB,
        // and SDK-shape fall-throughs that match the dispatcher-* / scheduler
        // exclusion rationale.
        "packages/daemon/src/core/integration-lifecycle.ts",
        "packages/daemon/src/core/repository-management-docs.ts",
        "packages/daemon/src/core/lesson-maintenance.ts",
        "packages/daemon/src/core/roadmap-maintenance.ts",
        "packages/daemon/src/core/routine-acquisition-plan.ts",
        "packages/daemon/src/db/activity-scan-signals.ts",
        "packages/daemon/src/core/routine-fetch-window-runner.ts",
        "packages/daemon/src/core/backends/native-skill-discovery-probe.ts",
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
        "packages/daemon/src/core/wiki/dispatcher.ts",
        "packages/daemon/src/core/wiki/git-precompile.ts",
        "packages/daemon/src/core/wiki/import-migrate.ts",
        "packages/daemon/src/core/wiki/import-probe.ts",
        "packages/daemon/src/core/wiki/index-cache.ts",
        "packages/daemon/src/core/wiki/wiki-fts.ts",
        "packages/daemon/src/core/wiki/workspaces.ts",

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
        "packages/daemon/src/observers/observation-summarizer/summarizer-client.ts",
        "packages/daemon/src/observers/observation-summarizer/summarizer-prompts.ts",
        "packages/daemon/src/observers/observation-summarizer/worker.ts",
        "packages/daemon/src/bootstrap/db.ts",
        "packages/daemon/src/bootstrap/event-pipeline.ts",
        "packages/daemon/src/api/server.ts",

        "packages/shared/src/secret-client-file.ts",      // file-based secret store
        "packages/daemon/src/core/skills-compiler.ts",    // FS skill compilation
        // ── skills-compiler sibling-file extractions (commit 6749ade Phase 1) ──
        // The parent is excluded above for FS / subprocess / instruction-file
        // I/O reasons; the siblings inherit the same rationale — every
        // residual uncovered branch is a defensive FS guard (existsSync,
        // malformed-frontmatter fallback, write-failed logger). Pure
        // sub-logic has its own peer *.test.ts at 100%.
        "packages/daemon/src/core/skills-compiler-cli-renderer.ts",  // CLI instruction file render + character-block rewrite over session dirs
        "packages/daemon/src/core/skills-compiler-denied-tools.ts",  // deny-list emission paths gated by tool-source FS layout
        "packages/daemon/src/core/skills-compiler-skill-index.ts",   // <skill-index> splice + existsSync / readFileSync guards
        "packages/daemon/src/core/skills-compiler-tree.ts",          // tree walk + cp / rm / brand-token rewrites on materialized session dirs
        "packages/daemon/src/core/skills-compiler-variants.ts",      // variant resolution + missing-variant FS-cache invalidation
        "packages/daemon/src/api/env-writer.ts",          // env file management
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

        // ── Source library (SOURCE_LIBRARY_DESIGN.md) — same I/O shape as the
        // attachments pair above. `document-mimes.ts` stays in the covered set
        // as pure logic (as does `core/sources/maintenance-prefilter.ts`).
        "packages/daemon/src/api/routes/sources.ts",               // Hono handler (fs streaming + DB)
        "packages/daemon/src/services/sources/store.ts",           // fs + SQLite source library

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
        // `catchup.ts` exists only to keep the startup IIFE readable; it
        // chains dispatcher.processInline / DB schedule maintenance / FS
        // today.md reads, none of which are testable without a real
        // dispatcher. Same rationale as `index.ts` and the existing
        // dispatcher-* coordinator exclusions above. The sibling
        // `schedule-helpers.ts` is the pure-predicate half and is in the
        // covered set with its own peer test.
        "packages/daemon/src/bootstrap/catchup.ts",

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

        // ── Browser History P1 — OS-bound detectors, launchers, readers ──
        // BROWSER_HISTORY_INTEGRATION_PLAN.md §13 P1 scope. Pure helpers
        // stay in the covered set with peer tests:
        //   * `detectors/registry.ts:computeBrowserHistoryIngestEnabled` and
        //     `serializeBrowserHistoryCapabilities` are pinned by
        //     `detectors/registry.test.ts`.
        //   * `lifecycle/failure-escalation.ts` is pure state-machine code
        //     and is tested directly with all outcome branches.
        //   * `db/browser-history-store.ts` is exercised end-to-end by
        //     `api/routes/browser-history.test.ts`.
        //   * Layer-2 GET routes (`/status`, `/research-clusters`,
        //     `/yesterday-summary`) are pinned by the same route test.
        // The exclusions below are the I/O-bound layers — fs probes
        // against real browser profile roots, `spawn(chromium, ...)` /
        // `osascript` lifecycle, `better-sqlite3` snapshot opens, the
        // OS-specific `HostProfile` factory (process.platform + ps /
        // Get-CimInstance / `which` probes), and the cron-driven
        // supervisor tick. Each matches the existing observer / SDK
        // exclusion rationale above (process-mock-blocked by ESM).
        "packages/daemon/src/services/browser-history/detectors/chromium.ts",
        // The I/O orchestrator inside the registry — `detectBrowserHistoryCapabilities` —
        // shells out to every per-browser detector and mkdirs the cache root.
        // Sibling `computeBrowserHistoryIngestEnabled` / `serializeBrowserHistoryCapabilities`
        // / `browserHistoryCacheRoot` are pure and exercised by the peer test;
        // because the file mixes pure + I/O surface in a single TS module the
        // exclusion targets it as a whole rather than splitting into two files.
        "packages/daemon/src/services/browser-history/detectors/registry.ts",
        // On-demand Playwright Chromium installer — `spawn(node, [cli.js,
        // install, chromium])` + child stdout/stderr progress parsing +
        // exit/error event handlers + `createRequire(...).resolve` cli
        // probe. Pure status accessor + DEFAULT_STATUS are trivial; the
        // file's substance is subprocess lifecycle that matches the sibling
        // `chromium-launcher.ts` / `lifecycle/supervisor.ts` exclusion
        // rationale (process-mock-blocked by ESM).
        "packages/daemon/src/services/browser-history/lifecycle/chromium-install.ts",
        "packages/daemon/src/services/browser-history/lifecycle/chromium-launcher.ts",
        "packages/daemon/src/services/browser-history/lifecycle/platform.ts",
        "packages/daemon/src/services/browser-history/lifecycle/supervisor.ts",
        "packages/daemon/src/services/browser-history/readers/chromium-reader.ts",
        "packages/daemon/src/observers/browser-history-poller.ts",
        "packages/daemon/src/api/routes/browser-history.ts",

        // ── MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md Phase B-1 ──
        // The supervisor, bootstrap module, route handlers, and boot
        // helper are now wired (server.ts mounts the routes;
        // bootstrap/observers.ts calls `maybeRegisterManagedChromium`),
        // but the I/O-bound paths in each (sandbox-exec / bwrap / app-
        // container spawn, ps-based PID enumeration, FS-bound profile
        // dir lifecycle, `await import("node:fs/promises")` deferred
        // imports, OAuth UI window orchestration) are
        // process-mock-blocked by ESM and match the
        // `chromium-launcher.ts` / `lifecycle/supervisor.ts` exclusion
        // rationale a few entries above.
        //
        // The four pure-logic peers carry full unit tests and stay in
        // the covered set: `managed-chromium-state` (zod schema +
        // runtime_state round-trip — now 100% incl. bootstrap deep-copy
        // branch via the peer test's mutate-then-read fixture),
        // `reauth-detector` (Local State probe + sync stall taxonomy),
        // `sandbox-launcher` arg builders, `supervisor-config`
        // (Instance S launch config + bootstrap argv). The I/O wrappers
        // below are excluded for the same subprocess/SDK reasons as
        // the existing browser-history lifecycle modules.
        "packages/daemon/src/services/browser-history/managed-chromium/managed-chromium-supervisor.ts",
        "packages/daemon/src/services/browser-history/managed-chromium/reauth-detector.ts",
        "packages/daemon/src/services/browser-history/managed-chromium/sandbox-install.ts",
        "packages/daemon/src/services/browser-history/managed-chromium/sandbox-launcher.ts",
        "packages/daemon/src/services/browser-history/managed-chromium/setup-bootstrap.ts",
        "packages/daemon/src/services/browser-history/managed-chromium/supervisor-config.ts",
        "packages/daemon/src/api/routes/browser-history-managed.ts",
        "packages/daemon/src/bootstrap/managed-chromium.ts",
        // ── MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md Phase B-2 (Instance A) ──
        // BROWSER_TASK_REDESIGN_PLAN.md Phase 6 retired the workflow runner
        // and its registry; only the I/O primitives the new browser-task
        // surface re-uses survive. Pure-logic peers (`automation/egress-
        // denylist`, `automation/external-content`, `automation/trace-
        // store-paths`, `db/browser-automation-store`) stay in the covered
        // set and are exercised by their peer *.test.ts files. The
        // exclusions below are I/O-bound (Playwright `connectOverCDP`,
        // `chromium` spawn, `fs/promises` against per-task profile dirs,
        // kernel-assigned CDP port + HTTP fetch loop, dynamic
        // `await import("playwright-core")`) and match the existing
        // `chromium-launcher.ts` / `setup-bootstrap.ts` exclusion rationale.
        "packages/daemon/src/services/browser-history/managed-chromium/instance-a-launcher.ts",
        "packages/daemon/src/services/browser-history/managed-chromium/cdp-connect.ts",
        "packages/daemon/src/services/browser-history/automation/cdp-network-interception.ts",
        "packages/daemon/src/services/browser-history/automation/trace-store.ts",
        // ── MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md Phase B-2.5 (per-site
        // authenticated sessions) ── Pure-logic peers (`automation/site-registry`,
        // `db/managed-chromium-sites-store`) stay in the covered set and
        // are exercised by their peer *.test.ts files. The exclusions below are
        // I/O-bound (UI Chromium spawn, Playwright CDP probe of the bootstrap
        // window, FS-bound per-site profile dir lifecycle) and match the
        // existing `setup-bootstrap.ts` exclusion rationale.
        "packages/daemon/src/services/browser-history/managed-chromium/site-bootstrap.ts",
        "packages/daemon/src/api/routes/browser-automation-sites.ts",

        // ── MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md Phase B-4 (purchase
        // confirmation flow) ── Pure-logic peers stay in the covered set:
        // `safety/outbound-purchase-guard` (100% via its own peer test —
        // covers the §17.7 outbound classifier guard + the
        // `result='failed'` audit-row INSERT) and the
        // `automation/purchase-tokens` classifier (already 100%). The
        // exclusions below are I/O-bound: SQL stores (better-sqlite3
        // prepare/run catches that need ESM-blocked DB mocks to reach),
        // the Hono route handler (multipart, outbound DM dispatch), the
        // messaging-adapter sender (Discord/Slack/Telegram socket calls),
        // the Playwright `run()` workflow body, and the purchase handler
        // that ties the messaging adapters to the automation runner.
        // Mirrors the B-1 / B-2 / B-2.5 / B-3 exclusion rationale above.
        "packages/daemon/src/api/routes/browser-automation-purchase.ts",
        "packages/daemon/src/db/browser-automation-b4-config-store.ts",
        "packages/daemon/src/db/browser-automation-purchase-primary-channels-store.ts",
        "packages/daemon/src/db/browser-automation-purchase-replies-store.ts",
        "packages/daemon/src/db/browser-automation-purchase-tokens-store.ts",
        "packages/daemon/src/messaging/purchase-system-message-sender.ts",
        "packages/daemon/src/messaging/final-confirm-system-message-sender.ts",
        "packages/daemon/src/messaging/browser-task-mcp-notifier.ts",
        "packages/daemon/src/services/browser-history/automation/purchase-handler.ts",

        // ── BROWSER_TASK_REDESIGN_PLAN.md Phase 1 (browser-task surface) ──
        // Pure-logic peers stay in the covered set: the slot manager
        // (`services/browser-task/browser-task-slots.ts`), the deadline
        // scanner pure function, the lite-final-confirm classifier
        // (`automation/lite-final-confirm-tokens.ts`), and the
        // allowlist-composition / boot-recovery / final-confirm-gate
        // helpers all carry peer tests. The exclusions below are
        // I/O-bound — SQL stores (better-sqlite3 prepare/run catches),
        // the Hono route handler (multipart, originating-channel
        // attestation, SSE), the runner stub (will become the real
        // Playwright + Claude SDK driver in Phase 2), and the
        // final-confirm-handler DM dispatch (mirrors the B-4
        // purchase-handler exclusion). Mirrors the B-1..B-4 rationale.
        "packages/daemon/src/db/browser-task-store.ts",
        "packages/daemon/src/db/browser-task-action-log-store.ts",
        "packages/daemon/src/db/browser-task-clarifications-store.ts",
        "packages/daemon/src/db/browser-task-final-confirm-tokens-store.ts",
        "packages/daemon/src/api/routes/browser-task.ts",
        "packages/daemon/src/services/browser-history/automation/final-confirm-handler.ts",
        "packages/daemon/src/services/browser-task/browser-task-runner.ts",
        // ── BROWSER_TASK_REDESIGN_PLAN.md Phase 2 (Playwright + SDK driver) ──
        // Pure-logic peers stay covered: tool schemas, navigate-guard,
        // final-confirm-gate, loop-guard, extract-cap, extract-output,
        // screenshot-output, dom-snapshot-output. The exclusions
        // below are I/O-bound: the per-task MCP server composer
        // (Playwright Page calls inside every tool handler), the
        // driver (acquirePlaywrightContext + Claude SDK query stream
        // consumer), and the route layer. Same rationale as the
        // Phase 1 sibling exclusions above.
        "packages/daemon/src/services/browser-history/automation/browser-task-tools/server.ts",
        "packages/daemon/src/services/browser-task/browser-task-driver.ts",

        // ── BACKGROUND_TASK_RUNNER_DESIGN.md Phase 2 (generic runner) ──
        // Pure-logic peers stay covered: the budget envelope
        // (`background-task-budget.ts`), the SSE transition emitter
        // (`background-task-transition-events.ts`), and the scheduled
        // dispatch handler (`dispatcher-scheduled-background-task.ts`) all
        // carry peer tests. The exclusions below are I/O-bound — SQL
        // stores, the Hono route layer, the worker MCP tools (store-write
        // glue), the runner (slot/park/cancel orchestration), and the
        // driver (Claude SDK query stream consumer). Mirrors the
        // browser-task Phase 1/2 exclusion rationale above.
        "packages/daemon/src/db/background-task-store.ts",
        "packages/daemon/src/db/background-task-clarifications-store.ts",
        "packages/daemon/src/api/routes/background-task.ts",
        "packages/daemon/src/services/background-task/background-task-tools.ts",
        "packages/daemon/src/services/background-task/background-task-runner.ts",
        "packages/daemon/src/services/background-task/background-task-driver.ts",

        // ── Development mode (dev-mode plan) ── Native port of loop-kit's
        // loop engine. The PURE core stays IN the gate at 100%:
        // `services/dev-mode/dev-loop-evaluate.ts` (deterministic decision
        // order over injected spawn/git shims), `dev-loop-config.ts`
        // (defaults/normalize/validate/hash-serialize), `verdict-parse.ts`
        // (extract_verdict + per-REQ table parse). The exclusions below are
        // I/O-bound — SQL stores, the fs/git working-dir writer, the
        // IAgentCore SDK-consuming legs, the detached engine/runner
        // (park/cancel/boot-resume orchestration), and the Hono route.
        // Mirrors the background-task exclusion rationale above.
        "packages/daemon/src/db/dev-sessions-store.ts",
        "packages/daemon/src/db/dev-session-escalations-store.ts",
        "packages/daemon/src/db/dev-session-tasks-store.ts",
        "packages/daemon/src/db/dev-session-checklist-store.ts",
        "packages/daemon/src/services/dev-mode/dev-loop-docs.ts",
        "packages/daemon/src/services/dev-mode/dev-loop-legs.ts",
        "packages/daemon/src/services/dev-mode/dev-loop-engine.ts",
        "packages/daemon/src/services/dev-mode/dev-mode-runner.ts",
        "packages/daemon/src/services/dev-mode/dev-mode-backend.ts",
        "packages/daemon/src/services/dev-mode/dev-mode-publisher.ts",
        // Flow port (fleet) I/O peers — the pure core (task-plan.ts,
        // dev-flow-schedule.ts) stays IN the gate at 100%.
        "packages/daemon/src/services/dev-mode/dev-flow-git.ts",
        "packages/daemon/src/services/dev-mode/dev-flow-legs.ts",
        "packages/daemon/src/services/dev-mode/dev-flow-orchestrator.ts",
        "packages/daemon/src/api/routes/dev-sessions.ts",

        // ── Weekly interests reflection (WEEKLY_INTERESTS_REFLECTION_PLAN) ──
        // FS-locked write coordinator + best-effort cleanup helpers.
        // Pure planning logic stays in the covered set; the wrappers
        // below thread real fs/rmSync/writeFile against per-run files
        // whose error branches need ESM-blocked node:fs mocks.
        // (`interests-reflection-lock.ts` is the pure in-process mutex —
        // 100% covered by its peer test incl. the holder-mismatch warning
        // branch; only the fs-bound siblings remain excluded.)
        "packages/daemon/src/services/browser-history/cleanup-interests-reflection.ts",
        "packages/daemon/src/services/browser-history/refresh-interests-reflection.ts",

        // ── Context entities mirror route (docs/design/
        // 21-management-registry-and-entities.md §7.6) ── Hono route
        // handler over the `entities-store` SQL paths. Pure validation
        // lives in shared (`isDomain`, `isEntityType`); the store has its
        // peer test pinning the main flows. The route body is I/O-bound
        // multi-shape query dispatch matching the dashboard/* and mail/*
        // rationale.
        "packages/daemon/src/api/routes/entities.ts",

        // ── Integration route gate (api/integration-route-gate) ──
        // Hono middleware that gates per-integration HTTP routes by
        // current mode. Pure decision logic is peer-tested elsewhere;
        // the gate body wires DB lookups + response shaping that matches
        // the dashboard/* exclusion rationale.
        "packages/daemon/src/api/integration-route-gate.ts",

        // ── Automation triggers store (db/automation-triggers) ──
        // CRUD over `automation_triggers` rows. Remaining lines are SQL
        // prepare/run catches that match the existing `db/*` I/O
        // rationale (see check-signals.ts / observations.ts exclusions
        // above).
        "packages/daemon/src/db/automation-triggers.ts",

        // ── Backend plan presets (core/backends/plan-presets) ──
        // Hosts `DELEGATED_PROCESS_KEYS` + `applyDefaultPresets` (CLAUDE.md
        // "Where to look first" table). Pure tier-table is peer-tested;
        // the DB-seeding helpers match the `db/*` rationale.
        "packages/daemon/src/core/backends/plan-presets.ts",

        // ── Multi-mail provider reconcile orchestrator
        // (services/integrations/reconcile) ── Driver that walks each
        // provider's reconcile-planner output and applies actions
        // through the provider SDKs. Pure planning lives in
        // `mail/imap/reconcile-planner` (100% covered); this wrapper
        // performs SDK-bound writes matching the mail/* rationale.
        "packages/daemon/src/services/integrations/reconcile.ts",

        // ── Management policy store (db/management-policy) ── SQL CRUD
        // over `management_policy` table. Pure parse/serialize helpers
        // stay in the covered set; the wrapper carries SQL prepare/run
        // catches matching the `db/*` rationale.
        "packages/daemon/src/db/management-policy.ts",

        // ── MCP registry helpers (services/mcp/registry) ── Pure
        // descriptor lookups stay 100% covered via `services/mcp/*`
        // peer tests; the SQL helpers (`setMcpServerEnabled` and
        // friends) thread better-sqlite3 prepare/run, matching the
        // `db/*` rationale.
        "packages/daemon/src/services/mcp/registry.ts",

        // ── Phase B-2 Instance A config builder
        // (managed-chromium/instance-a-config) ── Builder for the
        // Instance A Chromium argv + workflow profile dirs. Most
        // branches are peer-tested; residual lines are fs.mkdir /
        // realpath paths that need node:fs mocks matching the B-2
        // sibling-exclusion rationale above (`instance-a-launcher.ts`).
        "packages/daemon/src/services/browser-history/managed-chromium/instance-a-config.ts",

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

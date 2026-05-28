import { z } from "zod";
import { BACKEND_IDS, type BackendId } from "./backend.js";

export const NATIVE_CONNECTOR_BACKEND_IDS = BACKEND_IDS.filter(
  (backend): backend is Exclude<BackendId, "opencode"> => backend !== "opencode",
);

/**
 * Integration Delegation Framework — shared types (Phase 1–3).
 *
 * See `GOOGLE_AUTH_DELEGATION_DESIGN.md` v3. Phase 1 ships the registry +
 * per-integration mode config with Gmail + Calendar as the first two keys.
 * Phase 3 adds skill / task-flow variant selection helpers consumed by
 * SkillsCompiler and prompts.ts. Git lifecycle Phase 4 retroactively registers
 * the local Git / GitHub observers under the same mode framework.
 */

/**
 * Mode-aware integrations — the ones that can flip between `direct` and
 * `delegated` and route through the per-backend probe / connector / skill
 * filter framework. Other surfaces (lifestyle services like
 * receipts/books/travel-bookings, Obsidian) integrate via dedicated routes
 * and observers without participating in this registry.
 */
export const INTEGRATION_KEYS = [
  "gmail",
  "google_calendar",
  "notion",
  "git",
  "github",
  "outlook_mail",
  "outlook_calendar",
  "browser_history",
] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

const integrationKeySet: ReadonlySet<string> = new Set(INTEGRATION_KEYS);

export function isIntegrationKey(value: string): value is IntegrationKey {
  return integrationKeySet.has(value);
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §3.1 — the fourth mode `native` means
 * "the main backend reaches the integration through its own native MCP
 * connector; the daemon does not poll and does not proxy." Unlike
 * `delegated` it does not run a worker; unlike `disabled` the agent can
 * still call the integration on-demand inside a DM / hourly_check turn.
 *
 * Order matters for UI tables: kept stable so dashboards rendering by
 * `INTEGRATION_MODES.indexOf(mode)` do not reflow when `native` ships.
 */
export const INTEGRATION_MODES = [
  "direct",
  "delegated",
  "native",
  "disabled",
] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

const integrationModeSet: ReadonlySet<string> = new Set(INTEGRATION_MODES);

export function isIntegrationMode(value: string): value is IntegrationMode {
  return integrationModeSet.has(value);
}

export interface IntegrationBackendConnector {
  /** Prefix that vendor-shipped MCP tools share, e.g. `mcp__claude_ai_Gmail__`. */
  toolNamespace: string;
  /** Capabilities that must all be present for delegated mode to be offered. */
  requiredCapabilities: readonly string[];
  /** Capabilities the feature matrix renders from (tick/cross UI). */
  optionalCapabilities: readonly string[];
  /**
   * Maps each capability name to the unsuffixed tool names that satisfy it.
   * Used by the probe to translate a live MCP tool list into per-capability
   * presence. Tool names are the part after `toolNamespace` (e.g. for the
   * Claude Gmail connector `toolNamespace = "mcp__claude_ai_Gmail__"`,
   * `"search"` maps to `["search_threads"]`).
   *
   * Every capability listed in `requiredCapabilities` ∪ `optionalCapabilities`
   * MUST have an entry here. An empty array means "no shipped tool satisfies
   * this capability" (always absent in the probe). The registry
   * self-consistency test in `integration-probe.test.ts` enforces this.
   */
  capabilityTools: Readonly<Record<string, readonly string[]>>;
  /**
   * DELEGATED-TASK-MODE-DESIGN.md §7.3 — bare tool names (same form as
   * `capabilityTools` values) whose invocation mutates user-visible state
   * in a way that requires explicit confirmation per the CLAUDE.md
   * "destructive ops require user confirmation" invariant. Concrete tool
   * names rather than capability keys because some capabilities mix reads
   * and writes (Gemini Gmail's `label` covers `listLabels` (read) and
   * `modify` (write)); a tool-level list lets us deny the writes without
   * classifying the read as destructive.
   *
   * Used by:
   *   - Task mode `runDelegatedTask`: when `allowDestructive: false`,
   *     these are removed from the SDK's `allowedTools` (Claude) /
   *     emitted as priority-998 deny rules (Gemini), and the subprocess
   *     is instructed to return `{needsConfirmation, confirmationPlan}`.
   *   - The `destructive-coverage.test.ts` drift test asserts every entry
   *     in `RECOMMENDED_STARTER_DENIED_TOOLS` for this connector appears
   *     here (i.e. the recommended starter list is a subset of the
   *     descriptor's destructive set).
   *
   * Every entry MUST also appear in some `capabilityTools[k]` array — a
   * destructive tool the descriptor doesn't otherwise know about would be
   * dead weight. Enforced by the same self-consistency test that covers
   * the rest of the descriptor surface.
   */
  destructiveTools: readonly string[];
}

export interface IntegrationDirectSetup {
  /** Keychain keys that must be present for direct mode to function. */
  credentialKeys: readonly string[];
  /** Documentation URL shown in the setup wizard and dashboard cards. */
  helpUrl: string;
}

export interface IntegrationDescriptor {
  key: IntegrationKey;
  displayName: string;
  supportedModes: readonly IntegrationMode[];
  directSetup?: IntegrationDirectSetup;
  backendConnectors: Partial<Record<BackendId, IntegrationBackendConnector>>;
  /** Skill slugs whose bodies depend on this integration. Declarative only in Phase 1. */
  skillsTouched: readonly string[];
  /** Task-flow keys same. Declarative only in Phase 1. */
  taskFlowsTouched: readonly string[];
  /**
   * docs/design/appendices/routine-data-acquisition.md §10 R3 — task-flow keys whose
   * execution causes this integration's partial
   * (`_partials/<kind>-acquire.<key>.md`) to be dispatched, either:
   *
   *   - directly: the routine's bundled body contains
   *     `{include:_partials/...}`. Only `routine.fetch_window.md`
   *     (the meta-fetcher) owns the directive today; OR
   *   - indirectly: the routine triggers the pre-pass via
   *     `ROUTINE_WINDOWS[routine]` carrying a row of the integration's
   *     kind. The pre-pass session reads `routine.fetch_window.md` and
   *     fetches on behalf of the parent routine, which then consumes
   *     the resulting observations from `/api/observations`.
   *
   * Distinct from `taskFlowsTouched`, which controls per-(backend, mode)
   * **variant materialization** (`<key>.delegated.<be>.md` files). The
   * two fields differ in semantics and consumer:
   *
   *  - `taskFlowsTouched` → drives `selectTaskFlowVariantSuffix` and
   *    the bundled variant files; consumed by the BackendRouter native
   *    fallback gate (does the MAIN session reach MCP?). For
   *    user-managed integrations (Outlook today) the field stays empty
   *    — there are no variant files to materialize.
   *  - `taskFlowsReferenced` → drives dashboard surfaces ("which
   *    routines consume this integration's data?") and the
   *    partial-coupling lint (`routine-partials.test.ts`). The original
   *    §6.5.1 native threshold-bypass that also consumed this field was
   *    retired by HOURLY_CHECK_GATE_REDESIGN_PLAN.md — the hourly_check
   *    gate now sees pre-pass observations directly through its
   *    source-prefix-derived signal compute.
   *
   * Every populated `taskFlowsReferenced` MUST include
   * `routine.fetch_window` so the directive-owning file remains bound
   * to the descriptor (lint enforces). The new field is additive —
   * readers that predate it (lifecycle code) keep working untouched.
   */
  taskFlowsReferenced?: readonly { routine: string; via: "partial" }[];
  /**
   * Runtime observer names gated by `integration.mode === "direct"`. Each
   * string is the value the observer exposes via its `Observer.name`
   * property — `ObserverManager.has()` / `stopAndUnregister()` look up by
   * that exact key. (The design doc uses class names like `MailPoller`
   * for human readability; the registry uses the runtime name so the
   * lifecycle module can act without a translation table.)
   */
  observersTouched: readonly string[];
  /**
   * Path prefixes the registry middleware 410-gates when delegated. The
   * 410 is **defense-in-depth** in v2 (DELEGATED-MODE-V2-DESIGN.md §6.3):
   * cross-backend skill prose directs the agent at
   * `POST /api/integrations/:key/exec` (the task-mode chokepoint; the
   * legacy `/invoke` RPC was retired 2026-05-01), and same-backend skill
   * is not provisioned at all. The gate fires only when the agent invents
   * a call the variant prose did not teach it.
   *
   * Multi-provider routes (e.g. Gmail under `/api/mail/*`) are
   * intentionally NOT listed here — prefix matching would also block
   * other providers (iCloud, Outlook, IMAP). Per-account 410 inside the
   * route handler covers those cases. Single-provider surfaces like
   * `/api/calendar` can be listed safely.
   */
  apiRoutesTouched: readonly string[];
  /**
   * Skill slugs whose `SKILL.md` body should be filtered by this
   * integration's `deniedTools` independently of `skillsTouched` —
   * forward-compat hook for skill bodies that touch the integration but
   * should not trigger variant resolution. Today, `skillsTouched`
   * already covers every body that needs the deny pass; this field
   * remains for symmetry with non-default-variant cases.
   */
  deniedToolsAppliesToSkills?: readonly string[];
  /**
   * Subset of `skillsTouched` whose body the integration's same-backend
   * connector tools fully cover. When `selectSkillVariantFile` resolves
   * to "same-backend", a touched skill is dropped (returns `null`) only
   * if EVERY touching integration declares it here. Skills broader than
   * the integration (e.g. `mail` covers IMAP/Outlook on top of Gmail;
   * `external-services` covers Obsidian/GitHub/scheduling on top of
   * Google Calendar) must NOT appear here — dropping them would orphan
   * the non-delegated functionality. Skills that are pure connector
   * wrappers (e.g. `notion` is solely Notion) belong here.
   */
  sameBackendDropsSkillBody?: readonly string[];
  /**
   * Marks an integration whose `delegated` AND `native` modes rely on an
   * MCP server or connector the user installs on the agent backend
   * (Claude Code / Codex / Gemini CLI) themselves. The daemon does not
   * ship a tool inventory for these connectors, so:
   *   - `backendConnectors` may be empty (no descriptor-driven feature
   *     matrix or capability probe).
   *   - The PATCH `/integrations/:key` endpoint accepts any `delegatedBackend`
   *     or `nativeBackend` supported by the daemon — capability probing is
   *     the user's responsibility on the backend side.
   *   - The probe and route-gate surfaces fall back to a generic
   *     "user-managed connector" path that does not enforce the daemon's
   *     normal tool-inventory checks; `evaluateProbe` synthesises a
   *     result via `makeUserManagedProbeResult`.
   *   - The missing-variant gate is skipped — there is no
   *     `SKILL.delegated.<backend>.md` / `SKILL.native.<backend>.md`
   *     authored by the daemon for these integrations; the agent reaches
   *     them through the user's own MCP / skill tools.
   *
   * Today: `outlook_mail` and `outlook_calendar`. Microsoft does not ship
   * a hosted MCP connector for Claude / Codex / Gemini; users register an
   * Outlook / Microsoft Graph MCP server on their backend (Claude Code
   * Connector, Codex MCP, Gemini extension) and we trust that wiring.
   *
   * INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 (2026-05 amendment) extends
   * the contract from delegated-only to delegated + native so users with
   * a custom Outlook / Graph MCP on their main backend can run native
   * mode without waiting for a hosted Microsoft connector.
   */
  userManagedConnector?: boolean;
  /**
   * docs/design/appendices/pre-pass-fan-out.md §4.2 — filename of the integration's
   * pre-pass partial inside `agent-assets/task-flows/_partials/`. The
   * fan-out coordinator (`RoutineFetchWindowRunner`) reads this body
   * verbatim (frontmatter-stripped, mode-filtered) and substitutes it
   * for the `{integration_partial}` placeholder in
   * `routine.fetch_window.md` when dispatching a per-integration
   * sub-session.
   *
   * The five integrations that participate in routine pre-pass (gmail,
   * outlook_mail, google_calendar, outlook_calendar, notion) declare the
   * filename. Integrations with no pre-pass surface (git, github today)
   * omit the field — `splitAcquisitionPlanByIntegration` never emits a
   * sub-plan for them, so the runner cannot reach a partial-less code
   * path. The lint (`routine-partials.test.ts`) enforces:
   *   (a) every populated value resolves to an existing
   *       `_partials/<file>` on disk, and
   *   (b) the integration co-lists `routine.fetch_window` in
   *       `taskFlowsReferenced` (the partial-owning task-flow), keeping
   *       the descriptor coupled to the partial chain.
   */
  prePassPartial?: string;
}

function readOnlyCliConnector(toolNamespace: string): IntegrationBackendConnector {
  return {
    // Git/GitHub delegation runs through the selected backend's shell/CLI
    // context (`git` / `gh`) rather than a hosted MCP connector. Keeping the
    // capability lists empty makes DelegatedProbeObserver a liveness/audit
    // heartbeat for these integrations without fabricating MCP tools the
    // backend cannot actually list.
    toolNamespace,
    requiredCapabilities: [],
    optionalCapabilities: [],
    capabilityTools: {},
    destructiveTools: [],
  };
}

/**
 * The registry. Single source of truth for which integrations exist, what
 * backends can delegate for them, and which parts of the daemon they touch.
 *
 * `backendConnectors` is a `Partial` record — omitting a backend means
 * delegation through that backend is unsupported.
 *
 * Gemini namespace convention differs from Claude / Codex. Gemini CLI's
 * MCP_TOOL_PREFIX is `mcp_` (single underscore) and the per-server prefix
 * is `mcp_<serverName>_`, so a tool registered as `gmail.search` on the
 * `google-workspace` extension surfaces as `mcp_google-workspace_gmail.search`.
 * Hyphens and dots in the registered name are preserved. The tool-name
 * format was confirmed by stream-event probe (2026-04-26 — see
 * `gemini -p ... --output-format stream-json` `tool_use` events) and is
 * the source of truth for `toolNamespace` and `capabilityTools` below.
 *
 * Gemini connectors require host-side MCP setup the daemon does not
 * manage:
 *  - Gmail + Calendar: `~/.gemini/extensions/google-workspace/`
 *    (install via `gemini extensions install <url>`).
 *  - Notion: register Notion's official MCP server under the server name
 *    `notion` (e.g. `gemini mcp add notion <url>`); changing the server
 *    name breaks the namespace assumption — see Gemini Notion descriptor
 *    notes below.
 */
export const INTEGRATION_DESCRIPTORS: Readonly<
  Record<IntegrationKey, IntegrationDescriptor>
> = {
  gmail: {
    key: "gmail",
    displayName: "Gmail",
    prePassPartial: "mail-acquire.gmail.md",
    // INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 — descriptor-driven native:
    // gmail ships connectors for claude/codex/gemini, so native is
    // supported across all three when the main backend matches. (The
    // 2026-05 §5.3 amendment also opens native to userManagedConnector
    // descriptors — gmail does not need that path.)
    supportedModes: ["direct", "native", "delegated", "disabled"],
    // DELEGATED-MODE-V2-DESIGN.md §3.4 / §5.1 — delegated-mode calls flow
    // through the generic `POST /api/integrations/gmail/exec` task-mode
    // chokepoint (the legacy `/invoke` RPC was retired 2026-05-01).
    // The legacy per-route `routeMap` proxy was removed in Phase 3.5; the
    // per-mode skill variant model (`SKILL.delegated.<sessionBackend>.md`)
    // restored in Phase 3 covers cross-backend prose, and same-backend
    // sessions use native MCP without a skill body.
    directSetup: {
      credentialKeys: ["googleCredentialsJson", "googleTokenJson"],
      // Google Workspace's end-to-end OAuth setup walkthrough — covers project
      // creation, API enablement, consent screen, and OAuth client credentials.
      // The setup wizard's `GCP_LINKS` deep-links each step; this URL is the
      // overview / fallback for users who want the official prose.
      helpUrl: "https://developers.google.com/workspace/guides/create-credentials",
    },
    backendConnectors: {
      claude: {
        toolNamespace: "mcp__claude_ai_Gmail__",
        // Claude's hosted Gmail connector is draft-only. Send/forward/delete/
        // attachment capabilities are deliberately absent — dashboard + skill
        // variants branch on this gap.
        requiredCapabilities: ["search", "read", "draft", "label"],
        optionalCapabilities: ["draft", "label", "create_label"],
        capabilityTools: {
          search: ["search_threads"],
          read: ["get_thread"],
          draft: ["create_draft", "list_drafts"],
          label: ["label_message", "label_thread", "unlabel_message", "unlabel_thread", "list_labels"],
          create_label: ["create_label"],
        },
        // Claude's hosted Gmail connector exposes no send/delete/forward —
        // label mutations are the only state-changing tools. The four
        // label_* tools mutate thread/message labels; `list_labels` is a
        // read and is intentionally excluded. `create_label` modifies the
        // user's label taxonomy and is included.
        destructiveTools: [
          "label_message",
          "label_thread",
          "unlabel_message",
          "unlabel_thread",
          "create_label",
        ],
      },
      codex: {
        toolNamespace: "mcp__codex_apps__gmail._",
        requiredCapabilities: ["search", "read", "draft", "label", "send"],
        optionalCapabilities: [
          "draft",
          "label",
          "create_label",
          "update_draft",
          "send",
          "forward",
          "delete",
          "read_attachment",
          "batch",
        ],
        // The Codex namespace already terminates with `._`, so capability
        // tool names are the rest of the symbol (no leading underscore).
        // E.g. `mcp__codex_apps__gmail._` + `search_emails`
        // = `mcp__codex_apps__gmail._search_emails` (the actual tool).
        capabilityTools: {
          search: ["search_emails", "search_email_ids"],
          read: ["read_email", "read_email_thread"],
          draft: ["create_draft", "list_drafts"],
          update_draft: ["update_draft"],
          send: ["send_email", "send_draft"],
          forward: ["forward_emails"],
          label: ["apply_labels_to_emails", "list_labels", "bulk_label_matching_emails"],
          create_label: ["create_label"],
          delete: ["delete_emails", "archive_emails"],
          read_attachment: ["read_attachment"],
          batch: ["batch_modify_email", "batch_read_email", "batch_read_email_threads"],
        },
        // Send/delete/forward + label mutations + create_label. `list_labels`,
        // `read_*`, `search_*`, `read_attachment`, and the read-side batch
        // tools (`batch_read_*`) are read-only and intentionally excluded.
        // `update_draft` mutates a not-yet-sent draft and is reversible (the
        // user can edit again before sending) — listed as write-class in
        // §7.4, NOT destructive.
        destructiveTools: [
          "send_email",
          "send_draft",
          "forward_emails",
          "delete_emails",
          "archive_emails",
          "apply_labels_to_emails",
          "bulk_label_matching_emails",
          "create_label",
          "batch_modify_email",
        ],
      },
      gemini: {
        // Gemini CLI's `google-workspace` extension exposes Gmail tools
        // under the `gmail.*` registration. Combined with Gemini's MCP
        // namespace convention (`mcp_<server>_<tool>`, single underscore),
        // a search call surfaces as `mcp_google-workspace_gmail.search` in
        // `tool_use` stream events. `capabilityTools` entries below are
        // the bare suffix (the part after `gmail.`), matching how Codex's
        // namespace also terminates with a separator.
        toolNamespace: "mcp_google-workspace_gmail.",
        // Required capabilities mirror Codex's full-auto floor; the
        // google-workspace extension covers all of search/read/draft/
        // label/send.
        requiredCapabilities: ["search", "read", "draft", "label", "send"],
        // `delete` and `forward` are not surfaced as optional capabilities:
        // the google-workspace extension has no dedicated tool for either
        // (delete = `modify` + add TRASH label; forward = `send` with
        // re-quoted body). Listing them would imply parity the connector
        // doesn't have. Agents that need either compose them from the
        // primitives.
        optionalCapabilities: [
          "draft",
          "label",
          "create_label",
          "send",
          "read_attachment",
          "batch",
        ],
        capabilityTools: {
          search: ["search"],
          read: ["get"],
          draft: ["createDraft"],
          // sendDraft = dispatch a previously-created draft. send =
          // compose-and-send in one call (the irreversible path; default-
          // denied via RECOMMENDED_STARTER_DENIED_TOOLS).
          send: ["send", "sendDraft"],
          // `modify` / `modifyThread` apply or remove labels (including
          // the system TRASH label). `listLabels` is a read; included
          // here for the same reason Codex includes `list_labels` —
          // labelling typically requires enumerating existing labels first.
          label: ["modify", "modifyThread", "listLabels"],
          create_label: ["createLabel"],
          read_attachment: ["downloadAttachment"],
          batch: ["batchModify"],
        },
        // `send`/`sendDraft` (irreversible dispatch), `modify`/`modifyThread`
        // (mutate labels including TRASH), `createLabel` (taxonomy edit), and
        // `batchModify` (mass mutation). `listLabels`, `search`, `get`,
        // `downloadAttachment`, and `createDraft` (reversible — the user
        // can edit before sending) stay write-class only. This list is the
        // tool-name version of the design's `destructiveCapabilities` set
        // for the Gemini connector, with the read-mixed `label` capability
        // split apart to keep `listLabels` allowed.
        destructiveTools: [
          "send",
          "sendDraft",
          "modify",
          "modifyThread",
          "createLabel",
          "batchModify",
        ],
        // The google-workspace extension authenticates the user's signed-in
        // Google account on first tool call (no separate subscription).
      },
    },
    // DELEGATED-MODE-V2-DESIGN.md §3.4 / §5.1 — restored in Phase 3 so
    // `selectSkillVariantFile` engages on the `mail` skill.
    // `SKILL.delegated.<sessionBackend>.md` is materialized for
    // cross-backend pairs; same-backend resolves to `null` (native MCP,
    // no skill body).
    skillsTouched: ["mail"],
    // `routine.hourly_check` retains a delegated variant: when Gmail is
    // delegated, MailPoller's per-account filter (mail-poller.ts:173-181)
    // stops Gmail-account polling, so `mail:lifecycle` observations
    // disappear. The variant's Step 0a fetches the equivalent window via
    // the connector. Listing the task-flow here is what triggers
    // `selectTaskFlowVariantSuffix` to pick the variant.
    //
    // INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 — `message.received.dm` /
    // `message.received.dm_first` are listed so the native DM variants
    // (`message.received.dm.native.<backend>.md`) are reachable through
    // `selectTaskFlowVariantSuffix`. Delegated DM has no variant file
    // today (the base flow carries inline `<!-- mode:delegated:* -->`
    // markers for the Calendar block); the loader falls back to the
    // base file when the delegated variant is missing.
    taskFlowsTouched: [
      "routine.hourly_check",
      "message.received.dm",
      "message.received.dm_first",
    ],
    // docs/design/appendices/routine-data-acquisition.md §10 R3 + Phase 4 D1-D4 —
    // routines that *consume Gmail observations dispatched on their
    // behalf* via the pre-pass session. Post-Phase 4 the main routine
    // bodies no longer embed `{include:_partials/mail-acquire.gmail.md}`
    // directly; the include lives in `routine.fetch_window.md` only.
    // Each routine listed here triggers a pre-pass with a mail row in
    // `ROUTINE_WINDOWS`, which posts Gmail observations the routine
    // then drains from `/api/observations`. Consumed by the
    // partial-coupling lint in `routine-partials.test.ts` (the
    // relaxed predicate accepts the include OR a pre-pass dispatch).
    taskFlowsReferenced: [
      { routine: "routine.morning_routine", via: "partial" },
      { routine: "routine.hourly_check", via: "partial" },
      { routine: "routine.evening_review", via: "partial" },
      // The directive-owning task-flow (the pre-pass session itself);
      // keeps the lint's "every taskFlowsReferenced points at a routine"
      // direction satisfied through the literal-include path.
      { routine: "routine.fetch_window", via: "partial" },
    ],
    observersTouched: [],
    // Multi-provider routes (`/api/mail/*`) are intentionally not gated
    // here — prefix matching would also block iCloud / Outlook / IMAP
    // accounts. Per-account 410 inside the mail handler covers Gmail
    // accounts when delegated (DELEGATED-MODE-V2-DESIGN.md §6.3
    // defense-in-depth).
    apiRoutesTouched: [],
    deniedToolsAppliesToSkills: ["mail"],
  },
  google_calendar: {
    key: "google_calendar",
    displayName: "Google Calendar",
    prePassPartial: "calendar-acquire.google_calendar.md",
    // INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 — connectors ship for all three
    // backends, so native is supported when the main backend matches.
    supportedModes: ["direct", "native", "delegated", "disabled"],
    // DELEGATED-MODE-V2-DESIGN.md §3.4 / §5.1 — delegated-mode calls flow
    // through `POST /api/integrations/google_calendar/exec` (the legacy
    // `/invoke` RPC was retired 2026-05-01). Per-mode skill variants
    // restored in Phase 3.
    directSetup: {
      credentialKeys: ["googleCredentialsJson", "googleTokenJson"],
      // Same OAuth flow as Gmail — Google Workspace's official setup guide.
      helpUrl: "https://developers.google.com/workspace/guides/create-credentials",
    },
    backendConnectors: {
      claude: {
        toolNamespace: "mcp__claude_ai_Google_Calendar__",
        requiredCapabilities: ["list_events", "get_event", "create_event"],
        optionalCapabilities: [
          "list_events",
          "get_event",
          "create_event",
          "update_event",
          "delete_event",
          "respond_to_event",
          "suggest_time",
          "list_calendars",
        ],
        capabilityTools: {
          list_events: ["list_events"],
          get_event: ["get_event"],
          create_event: ["create_event"],
          update_event: ["update_event"],
          delete_event: ["delete_event"],
          respond_to_event: ["respond_to_event"],
          suggest_time: ["suggest_time"],
          list_calendars: ["list_calendars"],
        },
        // Mutating calendar ops. `respond_to_event` is destructive because
        // the response is fired off to the organizer; `suggest_time` is
        // pure compute with no calendar side effects.
        destructiveTools: [
          "create_event",
          "update_event",
          "delete_event",
          "respond_to_event",
        ],
      },
      codex: {
        toolNamespace: "mcp__codex_apps__google_calendar._",
        requiredCapabilities: ["search", "read", "create_event"],
        optionalCapabilities: [
          "search",
          "read",
          "create_event",
          "update_event",
          "delete_event",
          "respond_event",
          "get_availability",
          "batch_read",
        ],
        capabilityTools: {
          search: ["search", "search_events"],
          read: ["read_event", "fetch"],
          create_event: ["create_event"],
          update_event: ["update_event"],
          delete_event: ["delete_event"],
          respond_event: ["respond_event"],
          get_availability: ["get_availability"],
          batch_read: ["batch_read_event"],
        },
        destructiveTools: [
          "create_event",
          "update_event",
          "delete_event",
          "respond_event",
        ],
      },
      gemini: {
        // google-workspace extension's Calendar tools: registered as
        // `calendar.*`, surfaced as `mcp_google-workspace_calendar.*`.
        toolNamespace: "mcp_google-workspace_calendar.",
        requiredCapabilities: ["list_events", "get_event", "create_event"],
        optionalCapabilities: [
          "list_events",
          "get_event",
          "create_event",
          "update_event",
          "delete_event",
          "respond_to_event",
          "find_free_time",
          "list_calendars",
        ],
        capabilityTools: {
          list_events: ["listEvents"],
          get_event: ["getEvent"],
          create_event: ["createEvent"],
          update_event: ["updateEvent"],
          delete_event: ["deleteEvent"],
          respond_to_event: ["respondToEvent"],
          find_free_time: ["findFreeTime"],
          list_calendars: ["list"],
        },
        destructiveTools: [
          "createEvent",
          "updateEvent",
          "deleteEvent",
          "respondToEvent",
        ],
      },
    },
    // DELEGATED-MODE-V2-DESIGN.md §3.4 / §5.1 — restored in Phase 3 so
    // `selectSkillVariantFile` engages on the `external-services` skill.
    skillsTouched: ["external-services"],
    // `routine.hourly_check` retains a delegated variant: when Calendar is
    // delegated, the CalendarPoller stops (see `observersTouched` below)
    // so `calendar:*` observations and `schedule.approaching` events are
    // lost. The variant's Step 0b restores both via two connector fetches
    // (imminent-window + 24h change-detection).
    //
    // INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 — DM / dm_first listed so
    // the native DM variants resolve via `selectTaskFlowVariantSuffix`.
    // The base DM flow carries `<!-- mode:*:google_calendar -->` markers
    // covering direct / delegated-same / delegated-cross / native /
    // disabled inline; the loader falls back to the base when a
    // delegated variant file is absent.
    taskFlowsTouched: [
      "routine.hourly_check",
      "message.received.dm",
      "message.received.dm_first",
    ],
    // docs/design/appendices/routine-data-acquisition.md §10 R3 + Phase 4 D1-D4 —
    // routines that *consume Google Calendar observations dispatched on
    // their behalf* via the pre-pass session. Post-Phase 4 the main
    // routine bodies no longer embed
    // `{include:_partials/calendar-acquire.google_calendar.md}`; the
    // include lives in `routine.fetch_window.md` only. Morning /
    // evening / monthly read the multi-provider context block
    // (`<calendar_events_*>`) exclusively and do NOT trigger a calendar
    // pre-pass row, so they are absent here. See `outlook_calendar` for
    // the symmetric coverage.
    taskFlowsReferenced: [
      { routine: "routine.today_refresh", via: "partial" },
      { routine: "routine.hourly_check", via: "partial" },
      { routine: "routine.weekly_review", via: "partial" },
      // Pre-pass fetcher's task-flow (literal include lives here).
      { routine: "routine.fetch_window", via: "partial" },
    ],
    // CalendarPoller still stops on a delegated flip — it polls via direct
    // OAuth credentials that the user has not necessarily set when running
    // delegated. The variant compensates for the observation surface.
    observersTouched: ["calendar"],
    // Single-provider surface — the `/api/calendar` prefix can be 410-gated
    // safely (DELEGATED-MODE-V2-DESIGN.md §6.3 defense-in-depth). Cross-
    // backend skill prose directs the agent at the invoke endpoint, but
    // hallucinated `/api/calendar/*` calls now interdict at the gate.
    apiRoutesTouched: ["/api/calendar"],
    deniedToolsAppliesToSkills: ["external-services"],
  },
  notion: {
    key: "notion",
    displayName: "Notion",
    prePassPartial: "notion-acquire.notion.md",
    // INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 — connectors ship for
    // claude/codex/gemini; native is supported when the main backend
    // matches one of those.
    supportedModes: ["direct", "native", "delegated", "disabled"],
    directSetup: {
      credentialKeys: ["notionApiKey"],
      // Notion's official guide for creating an internal integration and
      // obtaining the API key required by direct mode.
      helpUrl: "https://developers.notion.com/docs/create-a-notion-integration",
    },
    backendConnectors: {
      claude: {
        toolNamespace: "mcp__claude_ai_Notion__",
        // Minimum set that makes delegated mode worth the user's time:
        // search + read + create + property update + content patch +
        // archive. Schema-admin, comments, and the rest are bonuses —
        // declared in optionalCapabilities. The framework's tool-deny
        // policy (NOTION_DELEGATION_DESIGN.md §7.7) lets the user carve
        // those out per-tool from the dashboard.
        //
        // Archive caveat (v0.4): `notion-update-page` does NOT trash
        // pages — `in_trash` is rejected as a property and there is no
        // dedicated trash tool. The `archive` capability stays in the
        // required set because the property-update workaround
        // (Status="Archived" + status-property write) does route through
        // `notion-update-page`, but the skill body labels it as
        // workaround-only. See NOTION_DELEGATION_DESIGN.md §3 + §7.4.
        requiredCapabilities: [
          "search",
          "read",
          "create_page",
          "update_properties",
          "patch_content",
          "archive",
        ],
        optionalCapabilities: [
          "search",
          "read",
          "create_page",
          "update_properties",
          "patch_content",
          "replace_content",
          "archive",
          "comments",
          "duplicate_page",
          "move_page",
          "apply_template",
          "schema_admin",
          "users",
          "teams",
        ],
        // Several capabilities (`update_properties`, `patch_content`,
        // `replace_content`, `archive`, `apply_template`) all map to the
        // single `notion-update-page` tool. The probe is tool-name based,
        // so they flip to "true" together — accurate at the tool level
        // even though it doesn't verify each sub-command. Per
        // NOTION_DELEGATION_DESIGN.md §5 (capability-tool overlap note).
        capabilityTools: {
          search: ["notion-search"],
          read: ["notion-fetch"],
          create_page: ["notion-create-pages"],
          update_properties: ["notion-update-page"],
          patch_content: ["notion-update-page"],
          replace_content: ["notion-update-page"],
          archive: ["notion-update-page"],
          comments: ["notion-create-comment", "notion-get-comments"],
          duplicate_page: ["notion-duplicate-page"],
          move_page: ["notion-move-pages"],
          apply_template: ["notion-update-page"],
          schema_admin: [
            "notion-create-database",
            "notion-update-data-source",
            "notion-create-view",
            "notion-update-view",
          ],
          users: ["notion-get-users"],
          teams: ["notion-get-teams"],
        },
        // Page mutations + comment writes + schema admin. The read-only
        // tools (`notion-search`, `notion-fetch`, `notion-get-comments`,
        // `notion-get-users`, `notion-get-teams`) are intentionally
        // excluded. `notion-update-page` covers update_properties,
        // patch_content, replace_content, apply_template, AND archive
        // (the property-update workaround for trash) — listing it once
        // here gates all five.
        destructiveTools: [
          "notion-create-pages",
          "notion-update-page",
          "notion-duplicate-page",
          "notion-move-pages",
          "notion-create-comment",
          "notion-create-database",
          "notion-update-data-source",
          "notion-create-view",
          "notion-update-view",
        ],
      },
      codex: {
        toolNamespace: "mcp__codex_apps__notion._",
        // Same required set as Claude — these are framework requirements
        // (search/read/create/property update/content patch/archive) that
        // make delegated mode worth the user's time. Codex carries strict
        // parity on each: `_search` and `_fetch` for read, `_notion_create_pages`,
        // and `_notion_update_page` (same 5 commands as Claude:
        // update_properties, update_content, replace_content,
        // apply_template, update_verification). The page-archive gap is
        // identical to Claude — no `in_trash` on pages — so the skill
        // body uses the same property-update / move-to-trash workarounds.
        // The `archive` capability stays in `requiredCapabilities` for
        // the same reason as the Claude block above (workaround routes
        // through `_notion_update_page`). NOTION_DELEGATION_DESIGN.md
        // §3 + §7.4.
        requiredCapabilities: [
          "search",
          "read",
          "create_page",
          "update_properties",
          "patch_content",
          "archive",
        ],
        // Codex exposes two capabilities Claude's connector lacks:
        //  - `query_data_sources` — `_notion_query_data_sources` runs
        //    SQLite queries against a data source, including parameterized
        //    structured-property filters (`WHERE Status = ? AND Priority = ?`).
        //    This natively closes the gap §3.2 / Q2 accepted for Claude
        //    delegation; the delegated skill body documents the SQL pattern.
        //  - `query_meeting_notes` — `_notion_query_meeting_notes` runs a
        //    structured filter against the user's meeting-notes data source.
        //    Niche but free, surfaced as a capability.
        optionalCapabilities: [
          "search",
          "read",
          "create_page",
          "update_properties",
          "patch_content",
          "replace_content",
          "archive",
          "comments",
          "duplicate_page",
          "move_page",
          "apply_template",
          "schema_admin",
          "users",
          "teams",
          "query_data_sources",
          "query_meeting_notes",
        ],
        // Tool names are unsuffixed (the Codex namespace already terminates
        // with `._`, so `mcp__codex_apps__notion._` + `notion_create_pages`
        // = `mcp__codex_apps__notion._notion_create_pages`). Note `_search`
        // and `_fetch` are bare — they're not Notion-prefixed in Codex's
        // namespace, only the rest are.
        capabilityTools: {
          search: ["search"],
          read: ["fetch"],
          create_page: ["notion_create_pages"],
          update_properties: ["notion_update_page"],
          patch_content: ["notion_update_page"],
          replace_content: ["notion_update_page"],
          archive: ["notion_update_page"],
          comments: ["notion_create_comment", "notion_get_comments"],
          duplicate_page: ["notion_duplicate_page"],
          move_page: ["notion_move_pages"],
          apply_template: ["notion_update_page"],
          schema_admin: [
            "notion_create_database",
            "notion_update_data_source",
            "notion_create_view",
            "notion_update_view",
          ],
          users: ["notion_get_users"],
          teams: ["notion_get_teams"],
          query_data_sources: ["notion_query_data_sources"],
          query_meeting_notes: ["notion_query_meeting_notes"],
        },
        // Same shape as the Claude namespace but underscore-separated. The
        // two query_* tools (`_notion_query_data_sources`,
        // `_notion_query_meeting_notes`) are read-only structured queries
        // and intentionally excluded.
        destructiveTools: [
          "notion_create_pages",
          "notion_update_page",
          "notion_duplicate_page",
          "notion_move_pages",
          "notion_create_comment",
          "notion_create_database",
          "notion_update_data_source",
          "notion_create_view",
          "notion_update_view",
        ],
      },
      gemini: {
        // Notion's official MCP server is added to Gemini CLI by the
        // user (`gemini mcp add notion <url>` or via the dashboard's MCP
        // page). This descriptor assumes the server is registered under
        // the literal name `notion` — Gemini surfaces tools as
        // `mcp_notion_<tool>`. If the user picks a different name the
        // probe will report every required capability missing; the
        // dashboard surfaces this as an actionable "wrong server name"
        // hint.
        //
        // Tool names match Notion's hosted MCP wire format (same names
        // Anthropic's hosted Notion connector uses, with hyphenated
        // identifiers). Same required-capability floor as Claude / Codex.
        toolNamespace: "mcp_notion_",
        requiredCapabilities: [
          "search",
          "read",
          "create_page",
          "update_properties",
          "patch_content",
          "archive",
        ],
        optionalCapabilities: [
          "search",
          "read",
          "create_page",
          "update_properties",
          "patch_content",
          "replace_content",
          "archive",
          "comments",
          "duplicate_page",
          "move_page",
          "apply_template",
          "schema_admin",
          "users",
          "teams",
        ],
        capabilityTools: {
          search: ["notion-search"],
          read: ["notion-fetch"],
          create_page: ["notion-create-pages"],
          update_properties: ["notion-update-page"],
          patch_content: ["notion-update-page"],
          replace_content: ["notion-update-page"],
          archive: ["notion-update-page"],
          comments: ["notion-create-comment", "notion-get-comments"],
          duplicate_page: ["notion-duplicate-page"],
          move_page: ["notion-move-pages"],
          apply_template: ["notion-update-page"],
          schema_admin: [
            "notion-create-database",
            "notion-update-data-source",
            "notion-create-view",
            "notion-update-view",
          ],
          users: ["notion-get-users"],
          teams: ["notion-get-teams"],
        },
        destructiveTools: [
          "notion-create-pages",
          "notion-update-page",
          "notion-duplicate-page",
          "notion-move-pages",
          "notion-create-comment",
          "notion-create-database",
          "notion-update-data-source",
          "notion-create-view",
          "notion-update-view",
        ],
      },
    },
    skillsTouched: ["notion"],
    // `routine.hourly_check` is the only routine that consumes Notion
    // observations today (NotionPoller → observations table → routine via
    // the `observations` skill). When Notion is delegated the poller
    // stops; the hourly_check delegated variant compensates by pulling
    // recent edits via `notion-search` inline. See §7.5 of the design.
    //
    // INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 — DM / dm_first listed so
    // the native DM variants resolve. Delegated DM has no variant file
    // today; the loader falls back to the base when missing.
    taskFlowsTouched: [
      "routine.hourly_check",
      "message.received.dm",
      "message.received.dm_first",
    ],
    // docs/design/appendices/routine-data-acquisition.md §10 R3 + Phase 4 D1-D4 —
    // routines that *consume Notion observations dispatched on their
    // behalf* via the pre-pass session. Post-Phase 4 the main routine
    // bodies no longer embed `{include:_partials/notion-acquire.notion.md}`;
    // the include lives in `routine.fetch_window.md` only. Notion only
    // covers routines whose plan kind includes `notion` (morning +
    // hourly); evening / weekly / monthly draw on daily-journal
    // carry-over instead of a fresh pre-pass.
    taskFlowsReferenced: [
      { routine: "routine.morning_routine", via: "partial" },
      { routine: "routine.hourly_check", via: "partial" },
      // Pre-pass fetcher's task-flow (literal include lives here).
      { routine: "routine.fetch_window", via: "partial" },
    ],
    observersTouched: ["notion-poller"],
    // Fine-grained gating: leave `/api/notion/databases` ungated (it's a
    // config dump with no Notion API call). Gate the routes that hit the
    // API. The route-gate middleware uses longest-prefix matching with
    // strict boundary semantics (`pathname === prefix ||
    // startsWith(prefix + "/")`), so `/api/notion/databases` never
    // matches any of these. See §5 + §7.2 of the design.
    apiRoutesTouched: [
      "/api/notion/query",
      "/api/notion/search",
      "/api/notion/pages",
    ],
    // The `notion` skill body is purely a wrapper over `/api/notion/*`
    // (no IMAP/Obsidian/etc. side-content). When notion is delegated
    // same-backend the connector's own tool descriptions cover the
    // surface, so dropping the skill body avoids redundant prose.
    sameBackendDropsSkillBody: ["notion"],
  },
  git: {
    key: "git",
    displayName: "Git",
    supportedModes: ["direct", "delegated", "disabled"],
    backendConnectors: {
      claude: readOnlyCliConnector("cli:git:claude:"),
      codex: readOnlyCliConnector("cli:git:codex:"),
      gemini: readOnlyCliConnector("cli:git:gemini:"),
    },
    // Git event task-flows are backend-neutral observer flows, not MCP
    // connector wrappers. Delegated Git uses a dedicated cron task-flow,
    // so no SKILL.delegated.* variants are required here.
    skillsTouched: [],
    taskFlowsTouched: [],
    observersTouched: ["git"],
    apiRoutesTouched: [],
  },
  github: {
    key: "github",
    displayName: "GitHub",
    supportedModes: ["direct", "delegated", "disabled"],
    backendConnectors: {
      claude: readOnlyCliConnector("cli:github:claude:"),
      codex: readOnlyCliConnector("cli:github:codex:"),
      gemini: readOnlyCliConnector("cli:github:gemini:"),
    },
    // GitHub delegated mode also relies on the chosen backend's read-only
    // `gh` CLI access, not daemon-proxied MCP tools.
    skillsTouched: [],
    taskFlowsTouched: [],
    observersTouched: ["github"],
    apiRoutesTouched: [],
  },
  // SETUP-FLOW-REDESIGN-PLAN §6.1 — Outlook Mail. Microsoft does not
  // ship a hosted Outlook MCP connector for Claude / Codex / Gemini, so
  // `backendConnectors` stays empty and BOTH `delegated` and `native`
  // modes run as "user-managed connector": the user installs an Outlook
  // / Microsoft Graph MCP server on the agent backend they pick (Claude
  // Code Connector / Codex MCP / Gemini extension) and the daemon trusts
  // that wiring. The `userManagedConnector` flag relaxes the PATCH /
  // probe / variant gates that otherwise require a descriptor-supplied
  // connector. The dashboard surfaces a "user must configure MCP on the
  // selected backend" notice for both modes.
  //
  // INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 (amendment 2026-05): the
  // original rule that native mode required at least one `backendConnectors`
  // entry was relaxed so users with custom MCP / skill harnesses installed
  // on their main backend can flip Outlook to native too. The probe runs
  // as a "user-managed" synthetic result (`makeUserManagedProbeResult`)
  // and the missing-variant gate is skipped for `userManagedConnector`
  // descriptors, matching the long-standing delegated-mode behaviour.
  outlook_mail: {
    key: "outlook_mail",
    displayName: "Outlook Mail",
    prePassPartial: "mail-acquire.outlook_mail.md",
    supportedModes: ["direct", "native", "delegated", "disabled"],
    userManagedConnector: true,
    directSetup: {
      // MSAL token cache + per-account BYOA client config. Per §6.1 of
      // the redesign plan, the token cache key is `mail:outlook:<accountId>`
      // and the client-config blob is the canonical
      // `mail:outlook:client-config` (see services/mail/outlook/client-config.ts).
      credentialKeys: ["mail:outlook:client-config"],
      // Microsoft Identity platform OAuth onboarding for personal +
      // organizational accounts (BYOA pattern, public client).
      helpUrl:
        "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app",
    },
    backendConnectors: {},
    // The unified `mail` skill already routes per-account on
    // MailProviderKind ("outlook") for direct mode. Delegated and
    // native modes for outlook are user-managed (no daemon-side
    // variant materialization), so the registry intentionally does
    // NOT declare `skillsTouched` here — `selectSkillVariantFile`
    // would otherwise resolve to a Gmail-specific delegated/native
    // variant when only outlook is in that mode.
    //
    // Routine data path: scheduled routines (morning / hourly /
    // evening / weekly / monthly) reach Outlook through the
    // `mail-acquire.outlook_mail.md` partial dispatched by the
    // `routine.fetch_window` pre-pass session — see
    // docs/design/appendices/routine-data-acquisition.md §6.8 / §8.2. The partial
    // owns all four mode branches (`direct` via `/api/mail/*`;
    // `delegated` / `native` via the user-bound MCP / CLI surface)
    // and never leans on the `/api/mail/*` 410 round-trip described
    // below. The `taskFlowsReferenced` field encodes that coupling.
    //
    // 410 fallback (legacy backstop, NOT the routine path): when an
    // ad-hoc DM-driven flow lands on the unified `mail` SKILL.md
    // prose without a routine pre-pass — i.e., the agent calls
    // `/api/mail/<outlookAccountId>/*` directly — the route handler
    // returns 410 with the user-managed message (see
    // `delegatedMailIntegrationMessage` in api/routes/mail.ts),
    // redirecting the agent to its own MCP. One round-trip on first
    // attempt is the documented cost of NOT shipping Outlook-specific
    // skill variants; routines do not pay it because the partial
    // resolves the path before any /api/mail/* call.
    skillsTouched: [],
    taskFlowsTouched: [],
    // docs/design/appendices/routine-data-acquisition.md §10 R3 + Phase 4 D1-D4 —
    // routines that *consume Outlook Mail observations dispatched on
    // their behalf* via the pre-pass session. Post-Phase 4 the main
    // routine bodies no longer embed the `mail-acquire.outlook_mail.md`
    // partial; the include lives in `routine.fetch_window.md` only.
    // Outlook mail flows into the morning / hourly / evening pre-passes;
    // weekly + monthly reviews read mail through daily journals, not
    // through a fresh pre-pass.
    taskFlowsReferenced: [
      { routine: "routine.morning_routine", via: "partial" },
      { routine: "routine.hourly_check", via: "partial" },
      { routine: "routine.evening_review", via: "partial" },
      // Pre-pass fetcher's task-flow (literal include lives here).
      { routine: "routine.fetch_window", via: "partial" },
    ],
    // The unified mail poller handles all `MailProviderKind` rows,
    // including `kind="outlook"`; lifecycle stops Outlook polling when
    // outlook_mail flips to delegated.
    observersTouched: ["mail-poller"],
    // Multi-provider routes `/api/mail/*` cannot be safely prefix-gated;
    // per-account 410 inside the handler covers the delegated case.
    // (Same exception Gmail makes — see `gatedIntegrationForKind` in
    // mail.ts.)
    apiRoutesTouched: [],
  },
  // SETUP-FLOW-REDESIGN-PLAN §6.1 — Outlook Calendar. Single-provider
  // surface (mirrors `google_calendar`). v1 ships on-demand Graph
  // fetches; no `OutlookCalendarPoller`. `observersTouched: []`
  // reflects the deferral honestly. Both `delegated` and `native` modes
  // are user-managed — see the `outlook_mail` block for the contract,
  // including the 2026-05 amendment to §5.3 that opens `native` to
  // user-managed-connector integrations.
  outlook_calendar: {
    key: "outlook_calendar",
    displayName: "Outlook Calendar",
    prePassPartial: "calendar-acquire.outlook_calendar.md",
    supportedModes: ["direct", "native", "delegated", "disabled"],
    userManagedConnector: true,
    directSetup: {
      // Token shared with `outlook_mail` via the MSAL cache plugin's
      // per-account row. The same `mail:outlook:client-config` BYOA blob
      // is reused — calendar does not register a separate client.
      credentialKeys: ["mail:outlook:client-config"],
      helpUrl:
        "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app",
    },
    backendConnectors: {},
    // No daemon-side skill variant for delegated outlook calendar —
    // user-managed MCP exposes itself on the backend natively.
    skillsTouched: [],
    taskFlowsTouched: [],
    // docs/design/appendices/routine-data-acquisition.md §10 R3 + Phase 4 D1-D4 —
    // routines that *consume Outlook Calendar observations dispatched
    // on their behalf* via the pre-pass session. Post-Phase 4 the main
    // routine bodies no longer embed the
    // `calendar-acquire.outlook_calendar.md` partial; the include lives
    // in `routine.fetch_window.md` only. Per design §6.10 the pre-pass
    // fires only for routines whose calendar window is NOT already
    // covered by ContextBuilder's multi-provider `<calendar_events_*>`
    // block:
    //   - today_refresh  → cal_next_24h_drift
    //   - hourly_check   → imminent_2h
    //   - weekly_review  → cal_iso_week_to_now retrospective (Monday
    //                      00:00 local through `now`; the next-7d view
    //                      is delivered by ContextBuilder
    //                      `<calendar_events_7d>` instead)
    // Morning / evening / monthly read the multi-provider context
    // block exclusively — they touch Outlook calendar at runtime but
    // NOT through a pre-pass row, so they do not belong here. The
    // ContextBuilder coupling is discoverable from the buildCalendarBlock
    // registry walk in `packages/daemon/src/core/context-builder.ts`,
    // not via this descriptor field.
    taskFlowsReferenced: [
      { routine: "routine.today_refresh", via: "partial" },
      { routine: "routine.hourly_check", via: "partial" },
      { routine: "routine.weekly_review", via: "partial" },
      // docs/design/appendices/routine-data-acquisition.md Phase 4 / D1 — pre-pass fetcher.
      { routine: "routine.fetch_window", via: "partial" },
    ],
    observersTouched: [],
    // Single-provider surface — `/api/calendar/outlook` is safely
    // prefix-gated to 410 when delegated. The route gate's user-managed
    // message points the agent at its backend's MCP rather than at any
    // daemon-side proxy (no `/exec` or `/invoke` chokepoint exists for
    // user-managed connectors).
    apiRoutesTouched: ["/api/calendar/outlook"],
  },
  browser_history: {
    key: "browser_history",
    displayName: "Browser History",
    supportedModes: ["direct", "disabled"],
    backendConnectors: {},
    skillsTouched: ["browser-history"],
    taskFlowsTouched: ["routine.research_cluster_update"],
    // BROWSER_HISTORY_INTEGRATION_PLAN §6.3 — the journal / weekly
    // review consume browser-history data through a pre-computed digest
    // file (written by `pre-morning-digest.ts`) and through the typed
    // `/api/browser-history/*` endpoints, NOT through the
    // `{include:_partials/<kind>-acquire.<key>.md}` directive that
    // `taskFlowsReferenced` is built for. Leaving the field unset
    // honours the lint invariant (`taskFlowsReferenced` + no
    // `prePassPartial` is structural drift) while preserving the
    // design coupling — the dashboard surface for "which routines
    // consume browsing data" lives next to the integration page
    // instead of this descriptor field.
    observersTouched: [
      "browser-history-poller",
      "browser-lifecycle-supervisor",
    ],
    // Gate only agent-facing data routes. `/api/browser-history/status` is a
    // dashboard control-plane read and must remain reachable while the
    // integration is still disabled so the consent page can show detection
    // state before enabling ingest. The pre-morning-digest route is the
    // F2-Stage-1 JSON fallback the morning journal calls when the markdown
    // file is missing — same data contract as `yesterday-summary`, so it
    // must 410 together with it when the integration is disabled.
    apiRoutesTouched: [
      "/api/browser-history/research-clusters",
      "/api/browser-history/yesterday-summary",
      "/api/browser-history/pre-morning-digest",
      // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.7 — control-plane
      // route prefix for the opt-in managed Chromium surface. The
      // route is exposed even when the integration is in `direct` /
      // `delegated` mode (the dashboard's consent banner needs the
      // status read to decide what to render), so we expose only the
      // `status` GET as gated and let the mutation routes go through
      // the route-level risk-tier gate instead.
      "/api/browser-history/managed/status",
    ],
    userManagedConnector: false,
  },
};

export const HIGH_SENSITIVITY_INTEGRATIONS = new Set<IntegrationKey>([
  "browser_history",
]);

/**
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §11 / §16.2 — integrations
 * that carry an additional opt-in surface for the daemon-supervised
 * Chromium ("managed mode"). Today only `browser_history` participates;
 * the set is exported so the dashboard consent banner and the manage-
 * chromium dashboard page can mirror the same gating logic without
 * hard-coding the integration key. Same shape as
 * `HIGH_SENSITIVITY_INTEGRATIONS`.
 */
export const MANAGED_CHROMIUM_INTEGRATIONS = new Set<IntegrationKey>([
  "browser_history",
]);

/**
 * BROWSER_HISTORY_INTEGRATION_PLAN §10.3 — backend safety floor.
 *
 * Each process key declares the backends that may run it. The router
 * (`backend-router.ts:validateSafetyFloor`) refuses to bind a key to a
 * backend not in `eligible`, or to a backend listed in `forbiddenModes`
 * under the current execution mode.
 *
 * Rationale per key lives next to the entry — see the design doc for the
 * full argument (attacker-controlled prose surface for WebFetch, deny-
 * rule layer needed for external writes, etc.). Order in `eligible`
 * matters: it is the preference list — the first eligible binding wins
 * when the router cascades a default through `applyDefaultPresets`.
 *
 * Codex appears in NO eligibility list. Per the design's "Codex allow
 * mode is unenforceable; offering only strict mode would make the
 * routine constantly require user approval" argument, the floor refuses
 * Codex outright for browser-history surfaces. Operators can widen the
 * floor per-process from /settings/models with an explicit override
 * that lands in `agent_actions` — see §10.3 closing paragraph.
 */
export type BackendSafetyFloorBackend =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode";

export interface BackendSafetyFloor {
  eligible: ReadonlyArray<BackendSafetyFloorBackend>;
  /**
   * Backend+mode pairs explicitly refused even when the backend appears
   * in `eligible`. Today only Codex carries mode-scoped refusals (allow
   * mode is unenforceable; strict mode is operationally hostile for
   * frequent shell calls). The router checks this AFTER `eligible`.
   */
  forbiddenModes?: ReadonlyArray<{
    backend: BackendSafetyFloorBackend;
    mode: "strict" | "allow";
  }>;
  rationale: string;
}

export const BROWSER_HISTORY_PROCESS_KEYS: Readonly<
  Record<string, BackendSafetyFloor>
> = {
  "routine.research_cluster_update": {
    eligible: ["claude", "gemini", "opencode"],
    forbiddenModes: [
      { backend: "codex", mode: "allow" },
      { backend: "codex", mode: "strict" },
    ],
    rationale:
      "Lite-tier journal append; absolute-block layer must cover SQLite/exfil patterns.",
  },
  "routine.research_offer_dm": {
    eligible: ["claude", "gemini", "opencode"],
    forbiddenModes: [
      { backend: "codex", mode: "allow" },
      { backend: "codex", mode: "strict" },
    ],
    rationale:
      "Lite-tier two-option offer DM composition (seventh-pass). Reads cluster snapshot (displayName carries attacker-influenceable title), composes one DM, POSTs /api/notify. Same eligibility as cluster_update — Codex forbidden because allow mode is unenforceable and strict mode is operationally hostile (constant approvals).",
  },
  "routine.research_dispatch": {
    eligible: ["claude"],
    rationale:
      "Consumes attacker-controlled prose via WebFetch at scale; requires Claude PreToolUse hook authority.",
  },
  "routine.research_wiki_summary": {
    eligible: ["claude", "opencode"],
    rationale:
      "External write path (Obsidian/Notion); needs deny-rule layer covering the write surface.",
  },
  // BROWSER_TASK_REDESIGN_PLAN.md §5 + §2 — open-ended browser sub-agent.
  // Claude-only. Two structural blockers behind that call:
  //   (a) the 10 browser tools ship as an in-process `createSdkMcpServer`
  //       instance that only Claude's `@anthropic-ai/claude-agent-sdk`
  //       consumes — Codex/Gemini take stdio MCP servers as out-of-process
  //       subprocesses and the daemon would have to redo the entire
  //       per-task lifetime model to fit that;
  //   (b) `allowedToolsOverride` is Claude-only per `agent-core.ts` JSDoc,
  //       so Codex/Gemini have no way to enforce the "only these 10 tools"
  //       envelope the safety floor demands.
  // Sub-agent's safety floor matches `routine.research_dispatch`
  // (attacker-controlled prose + external-content wrappers + PreToolUse
  // enforcement). Fallback target intentionally NOT registered — on
  // BackendQuotaError the task transitions to `failed
  // (backend_unavailable)` rather than re-spawning on a backend that
  // cannot consume the per-task SDK MCP server.
  "browser_task": {
    eligible: ["claude"],
    rationale:
      "DOM-driving sub-agent; in-process SDK MCP server is Claude-only; tool allowlist enforcement requires `allowedToolsOverride` which is Claude-only.",
  },
};

export function getBrowserHistorySafetyFloor(
  processKey: string,
): BackendSafetyFloor | null {
  return BROWSER_HISTORY_PROCESS_KEYS[processKey] ?? null;
}

export function getIntegrationDescriptor(
  key: IntegrationKey,
): IntegrationDescriptor {
  return INTEGRATION_DESCRIPTORS[key];
}

export function listIntegrationDescriptors(): readonly IntegrationDescriptor[] {
  return INTEGRATION_KEYS.map((k) => INTEGRATION_DESCRIPTORS[k]);
}

/**
 * DELEGATED-MODE-V2-DESIGN.md §3 — integrations whose delegated task-flow
 * variant uses the daemon's generic `/api/integrations/:key/exec`
 * task-mode proxy (the legacy `/invoke` RPC was retired 2026-05-01)
 * rather than native MCP. The router's
 * {@link delegatedIntegrationsForProcessKey} skips these when computing
 * fallback-refusal candidates: the daemon proxies the connector via
 * `delegatedBackend`'s spawned subprocess regardless of which agent
 * backend handles the process key, so the agent backend's identity does
 * not need to constrain fallback.
 *
 * Replaces the v1 `proxiedAtDaemon` descriptor flag (removed in
 * Phase 3.5). New v2 integrations that adopt the proxy task-flow add
 * themselves here. Native-MCP-driven integrations (today: notion) are
 * intentionally absent so their fallback-refusal semantics remain.
 */
const PROXY_DRIVEN_INTEGRATIONS: ReadonlySet<IntegrationKey> = new Set([
  "gmail",
  "google_calendar",
]);

/**
 * Per-integration runtime state. Persisted as a single JSON blob in the
 * `settings` table under key `"integrations"`; rendered into
 * `~/.personal-agent/integrations.md` so users can edit by hand.
 */
export const integrationStateSchema = z
  .object({
    mode: z.enum(INTEGRATION_MODES),
    delegatedBackend: z
      .enum(BACKEND_IDS)
      .optional()
      // zod 4 emits `null` defaults as `undefined` when the field is optional;
      // keep it explicit so JSON round-trips don't flip between.
      .nullable()
      .optional(),
    /**
     * INTEGRATION_NATIVE_MODE_DESIGN.md §5.2 — backend whose native MCP
     * the agent uses to reach this integration when `mode === "native"`.
     * Required when mode is `native`; otherwise must be omitted.
     *
     * Kept as a separate field from `delegatedBackend` (rather than a
     * single `boundBackend`) so a mode flip is a single field change and
     * consumers can match on the column's presence as well as `mode`. The
     * §11.4 main-backend-change cascade preserves the prior native binding
     * in the audit row (`integration.native_unbound`) even after this
     * field clears.
     */
    nativeBackend: z
      .enum(BACKEND_IDS)
      .nullable()
      .optional(),
    /**
     * DELEGATED-PROXY-API-DESIGN.md §4.2 / §5.1 — user-pinned model used by
     * `DelegatedBackendInvoker` for proxy invocations. Null / undefined
     * means "use the canonical light-tier model for `delegatedBackend`",
     * resolved at call time rather than PATCH time so plan changes
     * automatically retrack the canonical pick.
     *
     * Mode-flip behaviour: preserved across `direct ↔ delegated` and
     * `delegated → disabled`; on a `delegatedBackend` swap a stale value
     * is silently dropped at call time (dashboard surfaces a "Reset to
     * default" affordance). PATCH validation rejects values that don't
     * appear in the registered model list for `delegatedBackend`.
     */
    delegatedModel: z.string().min(1).nullable().optional(),
    /**
     * DELEGATED-PROXY-API-DESIGN.md §4.2 — per-call max-turns override.
     * Sized for the rare connector that needs a tool-list lookup before
     * the actual call. v0.1 ships UI only for `delegatedModel`;
     * `delegatedMaxTurns` is registry-default (DELEGATED_PROXY_DEFAULTS
     * in `delegated-proxy-config.ts`) and lifted later if observation
     * warrants. Field exists in the schema for forward compatibility.
     */
    delegatedMaxTurns: z.number().int().min(1).max(10).nullable().optional(),
    /**
     * INTEGRATION-DRIFT-DETECTION-PLAN Phase 3 — hard kill switch for the
     * daemon-side delegated drift worker. Omitted means enabled; storing
     * only `false` keeps existing settings JSON compact and preserves
     * backward compatibility with rows written before the worker existed.
     */
    delegatedSyncEnabled: z.boolean().optional(),
    /**
     * Inert today: the cadence worker has no role in native mode (see
     * `docs/design/appendices/native-integration-mode.md` §"Polling,
     * observers, and the hourly-check threshold"; native observations
     * come from the in-turn `routine.fetch_window` pre-pass, not the
     * worker). The field is retained so user settings written under the
     * earlier §19.6 design survive a downgrade and so a future native
     * heartbeat mechanism can re-claim the name without a schema flip.
     * Omitted means the (currently-vacuous) default.
     */
    nativeSyncEnabled: z.boolean().optional(),
    /**
     * §7.7 tool-deny policy. Each entry is the unsuffixed tool name as
     * declared in the descriptor's `capabilityTools` (e.g. for Claude
     * Notion: `"notion-create-database"`; for Codex Notion:
     * `"notion_create_database"`). Tools listed here are stripped from the
     * delegated skill body at materialization time (hard enforcement on
     * Claude via `allowed-tools` frontmatter; soft enforcement on Codex /
     * Gemini via a prose "Denied tools" block). Default empty = all
     * allowed. Stale entries (tool name not present in the active
     * backend's capability tools) are silently ignored.
     */
    deniedTools: z.array(z.string()).optional().default([]),
    /** ISO-8601 timestamp the user / daemon last changed this field. */
    lastChangedAt: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "delegated") {
      if (!value.delegatedBackend) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["delegatedBackend"],
          message: "delegatedBackend is required when mode is 'delegated'",
        });
      }
    }
    if (value.mode === "native") {
      if (!value.nativeBackend) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nativeBackend"],
          message: "nativeBackend is required when mode is 'native'",
        });
      }
    }
    // INTEGRATION_NATIVE_MODE_DESIGN.md §5.2 — mutual exclusion. The two
    // fields name disjoint contracts; carrying both would leave the
    // resolver guessing which one to honour after a mode flip.
    if (value.mode !== "delegated" && value.delegatedBackend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delegatedBackend"],
        message: "delegatedBackend must be omitted unless mode is 'delegated'",
      });
    }
    if (value.mode !== "native" && value.nativeBackend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nativeBackend"],
        message: "nativeBackend must be omitted unless mode is 'native'",
      });
    }
    // `delegatedModel` is allowed in any mode — it's inert when not
    // delegated. Cross-field validation (model belongs to backend) lives
    // in the PATCH handler so it can read the live model registry / plan
    // preset; doing it here would couple every settings round-trip to
    // that lookup.
  });

export type IntegrationState = z.infer<typeof integrationStateSchema>;

/**
 * The full integrations map stored in the `settings` table. Every registered
 * integration key has an entry; missing keys are filled with the per-key
 * default before persistence. Gmail / Calendar / Notion stay disabled on
 * fresh installs, while Git / GitHub default to direct mode to preserve the
 * pre-registry observer behaviour and match the Git lifecycle design.
 */
export const integrationsMapSchema = z
  .object(
    Object.fromEntries(
      INTEGRATION_KEYS.map((key) => [key, integrationStateSchema.optional()]),
    ) as Record<IntegrationKey, z.ZodOptional<typeof integrationStateSchema>>,
  )
  .strict();

export type IntegrationsMap = Partial<Record<IntegrationKey, IntegrationState>>;

function defaultModeForIntegration(key: IntegrationKey): IntegrationMode {
  return key === "git" || key === "github" ? "direct" : "disabled";
}

/** Build the default integration map used for fresh installs. */
export function defaultIntegrationsMap(
  now: string = new Date().toISOString(),
): Record<IntegrationKey, IntegrationState> {
  const out = {} as Record<IntegrationKey, IntegrationState>;
  for (const key of INTEGRATION_KEYS) {
    out[key] = {
      mode: defaultModeForIntegration(key),
      deniedTools: [],
      lastChangedAt: now,
    };
  }
  return out;
}

/**
 * Narrow user input (from integrations.md or PATCH /api/integrations/:key) to a
 * valid state. Used by the parser and the API route so both enforce identical
 * rules.
 */
export const integrationPatchSchema = z
  .object({
    mode: z.enum(INTEGRATION_MODES),
    delegatedBackend: z.enum(BACKEND_IDS).optional().nullable(),
    /**
     * INTEGRATION_NATIVE_MODE_DESIGN.md §11.2 — PATCH-time validation of
     * `nativeBackend` mirrors `delegatedBackend`. The PATCH route runs
     * the additional "must equal current main backend" check (§11.2) and
     * the live probe (§9.3) before persisting.
     */
    nativeBackend: z.enum(BACKEND_IDS).optional().nullable(),
    /**
     * DELEGATED-PROXY-API-DESIGN.md §6.1 — user-pinned proxy model. Empty
     * string is rejected (use `null` to clear). Cross-field validation
     * (the value must appear in the registered model list for the
     * effective backend) lives in the PATCH route handler so it can
     * consult the live model registry / plan preset; here we only narrow
     * the shape.
     *
     * Omitting the field preserves the previously stored value across
     * `direct ↔ delegated` flips. Passing `null` explicitly clears the
     * pin — useful when the dashboard "Reset to default" affordance is
     * triggered after a backend swap.
     */
    delegatedModel: z.string().min(1).nullable().optional(),
    /**
     * DELEGATED-PROXY-API-DESIGN.md §4.2 — forward-compat field for
     * per-integration max-turns overrides. v0.1 surfaces no UI for this;
     * the schema accepts it so a future dashboard release can land
     * without a migration. PATCH-time validation matches the state
     * schema's int(1..10) bound.
     */
    delegatedMaxTurns: z.number().int().min(1).max(10).nullable().optional(),
    /**
     * Optional hard kill switch for DelegatedSyncWorker. Omitted = enabled.
     * Accepted in any mode so the user can pre-stage the setting before
     * flipping an integration to delegated.
     */
    delegatedSyncEnabled: z.boolean().optional(),
    /**
     * Accepted on PATCH for forward compatibility but inert today —
     * the cadence worker no longer runs for native rows. See the
     * matching field on the state schema above.
     */
    nativeSyncEnabled: z.boolean().optional(),
    /**
     * §7.7 — optional tool-deny list. Validation against
     * descriptor.capabilityTools and required-capability coverage runs in
     * the API route via `validateDeniedTools`; here we only narrow the
     * shape. Omitting the field on PATCH preserves the previously stored
     * list (mode-independent — direct ↔ delegated does not clear it).
     */
    deniedTools: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "delegated" && !value.delegatedBackend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delegatedBackend"],
        message: "delegatedBackend is required when mode is 'delegated'",
      });
    }
    if (value.mode !== "delegated" && value.delegatedBackend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delegatedBackend"],
        message: "delegatedBackend must be omitted unless mode is 'delegated'",
      });
    }
    if (value.mode === "native" && !value.nativeBackend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nativeBackend"],
        message: "nativeBackend is required when mode is 'native'",
      });
    }
    if (value.mode !== "native" && value.nativeBackend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nativeBackend"],
        message: "nativeBackend must be omitted unless mode is 'native'",
      });
    }
  });

export type IntegrationPatch = z.infer<typeof integrationPatchSchema>;

// ── Phase 3: Skill / task-flow variant selection (§4.7) ──────────────────────

/**
 * DELEGATED-MODE-V2-DESIGN.md §4.1.1 — pick the SKILL.md variant for a given
 * skill, **session backend**, and integration state. Three outcomes:
 *
 *   - `"SKILL.md"`      — direct/default body. Used when no touched
 *                         integration is delegated, when the skill is
 *                         integration-agnostic, OR when every touched
 *                         integration is same-backend delegated but the
 *                         skill body covers more than the connector
 *                         exposes (see `sameBackendDropsSkillBody`).
 *   - `null`            — do **not** materialize the skill at all. Reached
 *                         when every touched integration is delegated AND
 *                         `delegatedBackend === sessionBackend` AND every
 *                         touching integration declares the skill in its
 *                         `sameBackendDropsSkillBody` (i.e. the connector
 *                         covers the entire skill surface). The agent
 *                         already has the connector's tools natively, so
 *                         a redundant skill body is omitted.
 *   - `"SKILL.delegated.<sessionBackend>.md"` — cross-backend variant. The
 *                         DM session runs on `sessionBackend` but the
 *                         connector for at least one touched integration
 *                         lives on a *different* backend, so the agent
 *                         must call the daemon's generic invoke endpoint
 *                         which spawns the delegatedBackend subprocess.
 *
 * Combination rule for skills that touch multiple integrations: cross-backend
 * wins over same-backend (a single skill body cannot reliably span both
 * worlds), and same-backend → null wins over direct only when *every*
 * touched integration resolves to same-backend AND every touched integration
 * declares the skill in `sameBackendDropsSkillBody`. Any other configuration
 * falls back to `"SKILL.md"`.
 *
 * Callers are responsible for existence-checking: if the returned variant
 * file does not exist on disk, fall back to `"SKILL.md"`.
 */
export function selectSkillVariantFile(
  skillSlug: string,
  sessionBackend: BackendId,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): string | null {
  const touchingKeys = INTEGRATION_KEYS.filter(
    (k) => INTEGRATION_DESCRIPTORS[k].skillsTouched.includes(skillSlug),
  );
  if (touchingKeys.length === 0) return "SKILL.md";

  const verdicts = touchingKeys.map((k) =>
    resolveOneVariant(integrations[k], sessionBackend),
  );
  // INTEGRATION_NATIVE_MODE_DESIGN.md §5.4.1 — tie-break order:
  //
  //   1. cross-backend-delegated wins over everything: that variant
  //      carries the daemon-proxy paths the cross-backend-delegated
  //      integrations require, and is authored to document native
  //      siblings inline (§7.4 mixed-mode prompts).
  //   2. native wins over same-backend-delegated and direct: native
  //      is explicit-skill-required (§7.5 — no `sameBackendDropsSkillBody`
  //      flag), so we never fall back to `null` for a native integration.
  //   3. all-same-backend-delegated → null (drop) when every touched
  //      integration declares the skill in `sameBackendDropsSkillBody`.
  //   4. otherwise → direct (`SKILL.md`).
  if (verdicts.some((v) => v === "cross-backend")) {
    return `SKILL.delegated.${sessionBackend}.md`;
  }
  if (verdicts.some((v) => v === "native")) {
    return `SKILL.native.${sessionBackend}.md`;
  }
  if (verdicts.every((v) => v === "same-backend")) {
    // The skill body is dropped only when every touching integration's
    // descriptor confirms its connector covers the skill end-to-end.
    // Multi-purpose skills (`mail` covers IMAP/Outlook; `external-services`
    // covers Obsidian/GitHub/scheduling) keep the direct body so the
    // non-delegated functionality survives.
    const allDrop = touchingKeys.every((k) =>
      INTEGRATION_DESCRIPTORS[k].sameBackendDropsSkillBody?.includes(skillSlug)
        ?? false,
    );
    return allDrop ? null : "SKILL.md";
  }
  return "SKILL.md";
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §5.4 — per-integration verdict the
 * skill / task-flow variant selectors consume.
 *
 *   - `direct`       — daemon owns the data path (SKILL.md).
 *   - `same-backend` — `delegated` AND `delegatedBackend === sessionBackend`.
 *                      The connector lives on the session backend; skill body
 *                      may be dropped via `sameBackendDropsSkillBody`.
 *   - `cross-backend`— `delegated` AND `delegatedBackend !== sessionBackend`.
 *                      Skill body uses the daemon proxy chokepoint.
 *   - `native`       — `mode === "native"` AND `nativeBackend === sessionBackend`.
 *                      Native is always same-backend by construction; a
 *                      mismatched binding (after main-backend swap) is treated
 *                      as `disabled` so the resolver does not request a variant
 *                      for a backend that cannot reach the connector.
 *   - `disabled`     — `mode === "disabled"` or an absent state row. The
 *                      direct skill body still wins for non-touched siblings;
 *                      only when *every* touching integration is disabled do
 *                      consumers see this verdict in the aggregate.
 */
function resolveOneVariant(
  state: IntegrationState | undefined,
  sessionBackend: BackendId,
): "direct" | "same-backend" | "cross-backend" | "native" | "disabled" {
  // Skill not bound to this integration, or integration not yet seeded into
  // state (defaults to disabled).
  if (!state) return "disabled";
  if (state.mode === "disabled") return "disabled";
  if (state.mode === "native") {
    // Native binds to the main backend at flip time and re-probes on a
    // main-backend change (§11.4 cascades a mismatch to `disabled`). A
    // stale mismatch reaching this resolver is a registry-drift case and
    // we degrade safely to `disabled` — the agent never tries a variant
    // file for a backend that cannot reach the connector.
    return state.nativeBackend === sessionBackend ? "native" : "disabled";
  }
  if (state.mode !== "delegated") return "direct";
  if (state.delegatedBackend === sessionBackend) return "same-backend";
  return "cross-backend";
}

/**
 * Return the task-flow variant suffix for a given event type, backend, and
 * integration state. Returns `"direct"` when no touched integration is
 * delegated or native-bound to `backendId`. Returns `"delegated.<backendId>"`
 * when at least one touched integration is in `delegated` mode (regardless of
 * backend — the variant always documents both same-backend and cross-backend
 * paths). Returns `"native.<backendId>"` when at least one touched integration
 * is in `native` mode AND its `nativeBackend === backendId`, AND no touched
 * integration is in `delegated` mode.
 *
 * INTEGRATION_NATIVE_MODE_DESIGN.md §5.4.2 — mixed `delegated` + `native` on
 * the same task flow: `delegated` wins because that variant carries the proxy
 * paths the cross-backend-delegated integrations require. The delegated
 * variant must document native-mode language for native-mode siblings
 * (§7.4 / §8.4 mixed-mode prompts).
 *
 * The caller constructs the filename as `<eventType>.<suffix>.md` and checks
 * for existence before falling back to `<eventType>.md`.
 */
export function selectTaskFlowVariantSuffix(
  taskFlowKey: string,
  backendId: BackendId,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): string {
  const touchingKeys = INTEGRATION_KEYS.filter(
    (k) => INTEGRATION_DESCRIPTORS[k].taskFlowsTouched.includes(taskFlowKey),
  );
  if (touchingKeys.length === 0) return "direct";

  const hasDelegated = touchingKeys.some(
    (k) => integrations[k]?.mode === "delegated",
  );
  if (hasDelegated) return `delegated.${backendId}`;

  const hasNativeForBackend = touchingKeys.some((k) => {
    const state = integrations[k];
    return state?.mode === "native" && state.nativeBackend === backendId;
  });
  if (hasNativeForBackend) return `native.${backendId}`;

  return "direct";
}

// ── Phase 4: Backend-router delegated-integration gating (§4 Phase 4) ────────

/**
 * Return the delegated integrations whose `taskFlowsTouched` declares a
 * dependency on this process key. Skills are intentionally not consulted —
 * skills load on demand mid-session, so the router cannot predict them from
 * a process key alone.
 *
 * **Excludes proxy-driven integrations** (see {@link PROXY_DRIVEN_INTEGRATIONS}).
 * The router uses this helper only to decide whether to refuse a fallback
 * because the fallback backend lacks the integration's connector. For
 * proxy-driven integrations the connector lives on `delegatedBackend` and
 * is invoked by the daemon — the agent backend never touches it, so the
 * fallback gate is irrelevant. (Gmail/Calendar still appear in
 * `taskFlowsTouched` because their delegated variant is what
 * `selectTaskFlowVariantSuffix` reads to compensate for stopped pollers;
 * the asymmetry is intentional.)
 *
 * Returns an empty array when no native-MCP delegated integration touches
 * the key.
 */
export function delegatedIntegrationsForProcessKey(
  processKey: string,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): IntegrationKey[] {
  return INTEGRATION_KEYS.filter((k) => {
    const state = integrations[k];
    if (!state || state.mode !== "delegated") return false;
    if (PROXY_DRIVEN_INTEGRATIONS.has(k)) return false;
    return INTEGRATION_DESCRIPTORS[k].taskFlowsTouched.includes(processKey);
  });
}

/**
 * True when the registry declares a connector for `(integrationKey, backendId)`.
 * Descriptor presence is the contract the BackendRouter consults on the
 * fallback path — a missing entry means the backend has no connector for
 * this integration, so routing a delegated-integration process key through
 * it would silently execute with the wrong tool surface.
 *
 * This does NOT consult capability lists or live probe state; `PATCH
 * /api/integrations/:key` already enforces `requiredCapabilities` against
 * the live probe before a delegated flip is accepted, and the router does
 * not re-run that check at dispatch time.
 */
export function backendHasIntegrationConnector(
  integrationKey: IntegrationKey,
  backendId: BackendId,
): boolean {
  return INTEGRATION_DESCRIPTORS[integrationKey].backendConnectors[backendId] !== undefined;
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 — backends that can host this
 * integration's `native` mode. The setup wizard surfaces the `native`
 * option only when the main backend appears in this list; the PATCH
 * route uses the same set to reject a native flip to an unsupported
 * backend.
 *
 * Two paths produce the list:
 *
 *   - **Descriptor-driven connector** (gmail, google_calendar, notion):
 *     return the backends that ship a `backendConnectors` entry. The
 *     probe verifies the connector's `requiredCapabilities` at flip
 *     time; the `SKILL.native.<backend>.md` body documents the tool
 *     namespace.
 *
 *   - **User-managed connector** (outlook_mail, outlook_calendar — and
 *     any future integration with `userManagedConnector: true`): return
 *     every native-connector-capable runtime backend (claude / codex /
 *     gemini). Backends that are registered but do not yet have a
 *     runtime connector surface stay out of this list. The daemon trusts
 *     the user's MCP / skill harness on the chosen backend, the probe
 *     synthesises a result via `makeUserManagedProbeResult`, and the
 *     missing-variant gate is skipped — the agent reaches the
 *     integration through the user's own tools, not a daemon-shipped
 *     variant body.
 *
 *     2026-05 amendment to §5.3 (in-place): the original rule "native
 *     is offered only for integrations whose registry lists at least one
 *     `backendConnectors` entry" was relaxed so users with their own
 *     MCP servers / skills installed on their main backend can flip
 *     these integrations to native too.
 *
 * Returns a fresh array each call so the caller can store it without
 * aliasing the registry constants.
 */
export function supportedNativeBackends(
  integrationKey: IntegrationKey,
): BackendId[] {
  const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
  if (descriptor.userManagedConnector) {
    return [...NATIVE_CONNECTOR_BACKEND_IDS];
  }
  return NATIVE_CONNECTOR_BACKEND_IDS.filter(
    (b) => descriptor.backendConnectors[b] !== undefined,
  );
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §10.1 — native integrations whose
 * `taskFlowsTouched` declares a dependency on this process key. The
 * consumer is the BackendRouter's native fallback gate
 * ({@link BackendRouter.refineFallbackForNative}) — it asks "will the
 * main session for this process key reach the integration's MCP
 * directly via a variant body?" so it can refuse a fallback to a
 * backend that lacks the connector.
 *
 * Intentionally `taskFlowsTouched`-only — the partial-include coupling
 * (`taskFlowsReferenced`, RDAD §10 R3) is dispatched in a separate
 * pre-pass session on the `routine.fetch_window` ProcessKey, NOT the
 * main session. The main routine reads observations from the DB and
 * does not touch MCP, so a fallback on the main session is fine even
 * when the partial-driven pre-pass would prefer the bound backend.
 *
 * The historical §6.5.1 threshold-bypass that consumed a union
 * (touched ∪ referenced) was retired by
 * HOURLY_CHECK_GATE_REDESIGN_PLAN.md when the hourly_check gate moved
 * onto registry-derived source-prefix sets — there is no longer a
 * caller that needs the union variant.
 */
export function nativeIntegrationsForProcessKey(
  processKey: string,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): IntegrationKey[] {
  return INTEGRATION_KEYS.filter((k) => {
    const state = integrations[k];
    if (!state || state.mode !== "native") return false;
    return INTEGRATION_DESCRIPTORS[k].taskFlowsTouched.includes(processKey);
  });
}

/**
 * Canonical "kind" buckets the hourly_check gate's signal compute uses
 * to filter `observations.source LIKE ?` clauses. Each kind maps to a
 * set of source-prefix patterns covering:
 *
 *   1. **Direct mode**: the prefix the daemon's in-process poller writes
 *      (e.g. `mail:%` from MailPoller aggregate writes, `calendar:%` from
 *      drift-effects, `notion:%` from NotionPoller, `obsidian:%` from
 *      ObsidianWatcher, `git:%` from GitWatcher, `github:%` from
 *      GitHubPoller).
 *   2. **Delegated / native mode**: the integration-keyed prefix the
 *      pre-pass partial writes (e.g. `gmail:%`, `outlook_mail:%`,
 *      `google_calendar:%`, `outlook_calendar:%`, `notion:%`).
 *
 * Integration-keyed prefixes are derived from
 * `INTEGRATION_DESCRIPTORS` so a new integration shipping with a
 * `prePassPartial` named `<kind>-acquire.<key>.md` auto-extends the
 * matching kind's prefix set — no registry-external string literals
 * needed. The direct-poller prefixes that aren't tied to an integration
 * (`mail` aggregate, `calendar` drift-effects, `obsidian`) are kept as
 * a small static table beside the derivation.
 *
 * CLAUDE.md: "Never hardcode an integration reference outside the
 * registry."
 */
export type ObservationKind =
  | "mail"
  | "calendar"
  | "notion"
  | "vault"
  | "repo";

const DIRECT_POLLER_SOURCE_PREFIXES: Readonly<Record<ObservationKind, readonly string[]>> = {
  // MailPoller writes a single aggregate row per poll under `mail:lifecycle`;
  // per-message rows ride on the pre-pass `gmail:%` / `outlook_mail:%` prefixes.
  mail: ["mail"],
  // drift-effects writes `calendar:<id>` for direct-mode calendar pollers.
  calendar: ["calendar"],
  // NotionPoller writes `notion:%`; the integration's pre-pass partial uses
  // the same prefix, so the registry-derived set just overlaps here.
  notion: ["notion"],
  // ObsidianWatcher writes `obsidian:%`. Not an integration today.
  vault: ["obsidian"],
  // GitWatcher writes `git:%`; GitHubPoller writes `github:%`. Both are
  // descriptor-listed integrations but their pre-pass partials are absent
  // (no fetch window) so the registry derivation below skips them — the
  // static seed keeps the gate's source filter intact.
  repo: ["git", "github"],
};

/**
 * Source-prefix tokens (no trailing `:`) for the given kind. Combine
 * with `<source-key>:` at the call site to build SQL `LIKE` patterns
 * (e.g. `mail:%`, `gmail:%`).
 *
 * The function unions the static direct-poller seeds with every
 * `INTEGRATION_DESCRIPTORS` entry whose `prePassPartial` filename
 * begins with `<kind>-acquire.`. Returns prefixes sorted + deduped.
 */
export function getObservationSourcePrefixesForKind(
  kind: ObservationKind,
): readonly string[] {
  const seeds = new Set<string>(DIRECT_POLLER_SOURCE_PREFIXES[kind]);
  for (const key of INTEGRATION_KEYS) {
    const descriptor = INTEGRATION_DESCRIPTORS[key];
    const partial = descriptor.prePassPartial;
    if (!partial) continue;
    if (partial.startsWith(`${kind}-acquire.`)) {
      seeds.add(descriptor.key);
    }
  }
  return [...seeds].sort();
}

/**
 * Build a SQL `OR`-disjunction of `source LIKE ?` clauses for the given
 * kinds plus the positional bind values. The returned `clause` string
 * is already wrapped in parentheses; callers splice it into a `WHERE`
 * directly. Empty `kinds` returns an always-false `clause` (`'1=0'`)
 * plus an empty `values` array — defensive against caller bugs.
 */
export function buildSourcePrefixFilter(
  kinds: readonly ObservationKind[],
): { clause: string; values: string[] } {
  const seen = new Set<string>();
  for (const kind of kinds) {
    for (const prefix of getObservationSourcePrefixesForKind(kind)) {
      seen.add(prefix);
    }
  }
  if (seen.size === 0) {
    return { clause: "(1=0)", values: [] };
  }
  const prefixes = [...seen].sort();
  const clauses = prefixes.map(() => "source LIKE ?");
  const values = prefixes.map((p) => `${p}:%`);
  return { clause: `(${clauses.join(" OR ")})`, values };
}

// ── §7.7: Tool-deny policy validation + helpers ──────────────────────────────

/**
 * DELEGATED-MODE-V2-DESIGN.md §4.3.5 — match a deny pattern against a single
 * tool name. Patterns are bare unsuffixed tool names — no `mcp__*` prefix,
 * no leading underscore (the connector's `toolNamespace` already terminates
 * as needed; e.g. Codex Gmail's namespace is `mcp__codex_apps__gmail._`,
 * so the bare match key is `send_email`, not `_send_email`). Optionally
 * suffixed with `*`:
 *
 *   `send_email`      — exact match
 *   `send_*`          — prefix match, anything starting with `send_`
 *   `*`               — matches anything (deny everything; rare)
 *
 * Anchors are implicit; `*` is only honored as a suffix to keep the pattern
 * language single-purpose. `*` mid-string is treated as literal text.
 *
 * Used by `validateDeniedTools` (typo defense at PATCH time),
 * `filterDeniedToolsForBackend` (active/stale partition during
 * materialization), and the `/api/integrations/:key/exec` task-mode
 * chokepoint (per-call deny enforcement; the legacy `/invoke` RPC was
 * retired 2026-05-01).
 */
export function matchToolPattern(pattern: string, tool: string): boolean {
  if (pattern === tool) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return tool.startsWith(prefix);
  }
  return false;
}

/**
 * Expand a deny pattern against a connector's known-tool universe. Exact
 * patterns return `[pattern]` if known, `[]` if not. Glob patterns return
 * the subset of known tools whose name starts with the prefix.
 *
 * Pure data — both inputs come from the integration registry, no I/O.
 */
function expandDenyPattern(
  pattern: string,
  knownTools: ReadonlySet<string>,
): string[] {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    const out: string[] = [];
    for (const tool of knownTools) {
      if (tool.startsWith(prefix)) out.push(tool);
    }
    return out;
  }
  return knownTools.has(pattern) ? [pattern] : [];
}

export type ValidateDeniedToolsResult =
  | { ok: true }
  | {
      ok: false;
      error: "no_connector";
      backendId: BackendId;
    }
  | {
      ok: false;
      error: "unknown_tool";
      tool: string;
      knownTools: readonly string[];
    }
  | {
      ok: false;
      error: "denial_breaks_required_capability";
      capability: string;
      remainingTools: readonly string[];
    };

/**
 * Validate a proposed `deniedTools` list against an integration's
 * descriptor for a given `delegatedBackend`. Returns the first failure;
 * callers map this to the documented 400 shapes.
 *
 * Patterns: each entry is either an exact tool name (e.g. `_send_email`)
 * or a `*`-suffixed glob (e.g. `_delete_*`, `*`). See {@link matchToolPattern}.
 *
 *  - **`unknown_tool`**: an exact entry isn't in any of the connector's
 *    `capabilityTools` arrays, OR a glob entry matches no known tool
 *    (typo defense for both forms). Helps users catch typos and stale
 *    Claude / Codex names after a backend swap. (Note: the *materializer*
 *    tolerates stale entries silently per §7.7 — but PATCH is strict so
 *    the user sees the typo before saving. The dashboard's stale-entries
 *    UI handles the soft case after a backend flip.)
 *  - **`denial_breaks_required_capability`**: collectively, the proposal
 *    drops every tool that satisfies at least one `requiredCapability`.
 *    Multi-cap overlap matters — Notion's `notion-update-page` covers
 *    `update_properties`, `patch_content`, `archive`, and `apply_template`,
 *    so denying it breaks all four required caps at once. The error names
 *    the first failing capability and lists what's still in the
 *    `capabilityTools[capability]` set after the deny — so the dashboard
 *    can show a "you'd need to keep X, Y, or Z" hint without a second call.
 *    Globs are expanded against the connector's known tools before the
 *    capability-coverage check runs.
 */
export function validateDeniedTools(
  integrationKey: IntegrationKey,
  backendId: BackendId,
  deniedTools: readonly string[],
): ValidateDeniedToolsResult {
  const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
  const connector = descriptor.backendConnectors[backendId];
  // Forward-compat: today every (integrationKey, BackendId) pair has a
  // connector — this branch is reserved for a future integration that
  // omits one. See integrations.test.ts for the assertion that BackendId
  // membership is exhaustive.
  /* c8 ignore next 3 */
  if (!connector) {
    return { ok: false, error: "no_connector", backendId };
  }

  // Compute the known-tool universe once: union of every tool name appearing
  // in any capabilityTools entry. Used for both unknown-tool detection and
  // for the remaining-tools error payload.
  const knownToolSet = new Set<string>();
  for (const tools of Object.values(connector.capabilityTools)) {
    for (const t of tools) knownToolSet.add(t);
  }

  // Validate each pattern, then expand globs into concrete tool names so the
  // capability-coverage check below can see the full impact.
  const expandedDenied = new Set<string>();
  for (const tool of deniedTools) {
    const matches = expandDenyPattern(tool, knownToolSet);
    if (matches.length === 0) {
      // Exact-name typo or a glob that matches nothing in the connector.
      return {
        ok: false,
        error: "unknown_tool",
        tool,
        knownTools: [...knownToolSet].sort(),
      };
    }
    for (const m of matches) expandedDenied.add(m);
  }

  for (const capability of connector.requiredCapabilities) {
    // every requiredCapability is keyed in capabilityTools via the
    // descriptor self-consistency test; the `?? []` is defensive
    // against future descriptor edits that drop a capability mapping.
    /* c8 ignore next */
    const tools = connector.capabilityTools[capability] ?? [];
    const remaining = tools.filter((t) => !expandedDenied.has(t));
    if (remaining.length === 0) {
      // Surface the capability + what would still be available if the user
      // un-denied at least one of these. Lets the dashboard render an
      // actionable hint without a second round-trip.
      return {
        ok: false,
        error: "denial_breaks_required_capability",
        capability,
        remainingTools: tools,
      };
    }
  }

  return { ok: true };
}

/**
 * Filter a `deniedTools` list down to entries that exist in the active
 * backend's capability tools, expanding glob patterns. Used by the
 * materializer to silently drop stale names after a `delegatedBackend`
 * swap (§7.7 mode-flip behavior) and by `collectSessionDeniedTools` to
 * produce concrete namespaced tool names for backend `disallowedTools`.
 *
 * The output `active` list is the **expanded** concrete tool name set
 * (globs replaced by their matches) so callers can feed it directly into
 * an SDK `disallowedTools` array or `applyDeniedTools`. `stale` carries
 * the original user-entered patterns that matched nothing on this
 * backend's tool universe (typo or post-swap leftover).
 *
 * Distinct from `validateDeniedTools` — the API rejects unknown tools at
 * PATCH time, but a user who flips claude → codex carries Claude-namespaced
 * entries that the API didn't see at PATCH time. The materializer ignores
 * them; the dashboard surfaces them as "stale" so the user can clean up.
 */
export function filterDeniedToolsForBackend(
  integrationKey: IntegrationKey,
  backendId: BackendId,
  deniedTools: readonly string[],
): { active: string[]; stale: string[] } {
  const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
  const connector = descriptor.backendConnectors[backendId];
  // Forward-compat: see validateDeniedTools comment above.
  /* c8 ignore next */
  if (!connector) return { active: [], stale: [...deniedTools] };
  const known = new Set<string>();
  for (const tools of Object.values(connector.capabilityTools)) {
    for (const t of tools) known.add(t);
  }
  const activeSet = new Set<string>();
  const stale: string[] = [];
  for (const pattern of deniedTools) {
    const matches = expandDenyPattern(pattern, known);
    if (matches.length === 0) {
      stale.push(pattern);
      continue;
    }
    for (const m of matches) activeSet.add(m);
  }
  return { active: [...activeSet], stale };
}

/**
 * DELEGATED-MODE-V2-DESIGN.md §4.5.4 — recommended starter denylist used
 * by the setup wizard / PATCH route when the user first picks delegated
 * mode for an integration. The list errs conservative: strictly-destructive
 * ops (send / trash / delete) are always denied; reversible-but-easy-to-
 * lose-track-of ops (archive / mass-relabel / event-update) are denied so
 * the agent can't silently churn through cleanup work. The user opts out
 * explicitly per §4.5.4.
 *
 * Keyed on `(integrationKey, backendId)` because the same logical
 * destructive op uses different tool names per connector — Codex's Gmail
 * uses `_send_email`, Claude's Gmail has no send tool at all (the
 * connector is draft-only). Backends without a starter list resolve to
 * `[]` (no floor — caller can still PATCH explicit denies).
 *
 * The list contains only tool names already declared in the connector's
 * `capabilityTools`, so `validateDeniedTools` accepts them without the
 * `*`-glob extension.
 */
const RECOMMENDED_STARTER_DENIED_TOOLS: Readonly<
  Partial<Record<IntegrationKey, Partial<Record<BackendId, readonly string[]>>>>
> = {
  gmail: {
    // Codex's Gmail descriptor lists `send` in `requiredCapabilities` with
    // `["send_email", "send_draft"]`. Denying both would remove every path
    // to satisfy `send`, which `validateDeniedTools` rejects. The starter
    // list therefore denies `send_email` only — the irreversible "compose
    // and send right now" path — and leaves `send_draft` (send a previously
    // drafted message, which the user already vetted in the UI) available.
    // `delete_emails` and `archive_emails` together empty the optional
    // `delete` capability, which the validator allows. `apply_labels_to_emails`
    // is one of three tools in `label`; the floor is conservative without
    // breaking the capability.
    codex: [
      "send_email",
      "delete_emails",
      "archive_emails",
      "apply_labels_to_emails",
    ],
    // Claude's hosted Gmail connector is draft-only (no send/delete);
    // label mutations are the only mutating ops. `label_message` and
    // `label_thread` deny 2 of 5 tools in `label`, keeping the capability
    // satisfiable.
    claude: ["label_message", "label_thread"],
    // Gemini's google-workspace connector. `send` covers
    // compose-and-send-now (irreversible); `sendDraft` stays available
    // so the agent can dispatch a draft the user already vetted in the
    // UI. `batchModify` is the mass-mutation path; default-deny it the
    // way Codex's `apply_labels_to_emails` is denied. `modify` /
    // `modifyThread` are kept available — they're the only label-write
    // path the connector exposes, so denying them empties the required
    // `label` capability.
    gemini: ["send", "batchModify"],
  },
  google_calendar: {
    codex: ["delete_event", "update_event"],
    claude: ["delete_event", "update_event"],
    gemini: ["deleteEvent", "updateEvent"],
  },
};

/**
 * Lookup the recommended starter denylist for `(integrationKey,
 * backendId)`. Returns a fresh array each call so the caller can store it
 * directly without aliasing the registry constant.
 */
export function recommendedStarterDeniedTools(
  integrationKey: IntegrationKey,
  backendId: BackendId,
): string[] {
  const list =
    RECOMMENDED_STARTER_DENIED_TOOLS[integrationKey]?.[backendId] ?? [];
  return [...list];
}

/**
 * DELEGATED-TASK-MODE-DESIGN.md §7.3 — destructive tool list for
 * `(integrationKey, backendId)`, returned as **fully-qualified names**
 * (`toolNamespace + bareName`). Used by `runDelegatedTask` to feed into
 * SDK `disallowedTools` (Claude) or admin-policy deny rules (Gemini)
 * when `allowDestructive: false`.
 *
 * Returns `[]` when the backend has no connector for the integration
 * (forward-compat: this never happens today; every backend has a
 * connector for every registered integration).
 */
export function destructiveTaskTools(
  integrationKey: IntegrationKey,
  backendId: BackendId,
): string[] {
  const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
  const connector = descriptor.backendConnectors[backendId];
  /* c8 ignore next */
  if (!connector) return [];
  return connector.destructiveTools.map(
    (t) => `${connector.toolNamespace}${t}`,
  );
}

/**
 * DELEGATED-TASK-MODE-DESIGN.md §7.3 — bare-name version of
 * {@link destructiveTaskTools}, returned WITHOUT the `toolNamespace`
 * prefix. Used by anti-prompt-injection assertions and by callers that
 * already namespace separately.
 */
export function destructiveTaskToolsBare(
  integrationKey: IntegrationKey,
  backendId: BackendId,
): string[] {
  const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
  const connector = descriptor.backendConnectors[backendId];
  /* c8 ignore next */
  if (!connector) return [];
  return [...connector.destructiveTools];
}

/**
 * DELEGATED-MODE-V2-DESIGN.md §4.3.3 + INTEGRATION_NATIVE_MODE_DESIGN.md §11
 * — collect every `deniedTools` entry that applies to the **session
 * backend's own native MCP** (the "same-backend" state). For each
 * integration whose effective binding for `sessionBackend` is same-backend
 * (delegated to the same backend, OR native to the same backend), expand
 * the user's deny patterns against the connector's known tools and return
 * the namespaced tool names (`mcp__<connector>__<tool>`) ready to drop
 * into:
 *
 *   - Claude Code SDK `disallowedTools` array (hard enforcement)
 *   - Gemini admin policy `denied_tools` rules (hard enforcement)
 *   - Codex agent profile prose block (soft enforcement — accepted gap,
 *     §4.3.4 outcome γ)
 *
 * Cross-backend delegated integrations (delegatedBackend !== sessionBackend)
 * are excluded — those calls go through `/api/integrations/:key/exec`
 * (the task-mode chokepoint that replaced the retired `/invoke` RPC)
 * which enforces deny at the daemon chokepoint (§4.3.2). Disabled / direct
 * integrations are excluded — deny only applies to modes that surface MCP
 * to the session.
 *
 * Native is always same-backend by definition (`nativeBackend === sessionBackend`
 * is the only valid binding for the active session); the per-key
 * `deniedTools` array is shared with delegated and the helper treats them
 * uniformly so a user's deny list survives a delegated→native flip.
 *
 * Returns a `Map` keyed by integration so callers can attribute denies
 * per-integration in logs / prose. Empty entries are omitted.
 */
export function collectSessionDeniedTools(
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
  sessionBackend: BackendId,
): Map<IntegrationKey, string[]> {
  const out = new Map<IntegrationKey, string[]>();
  for (const key of INTEGRATION_KEYS) {
    const state = integrations[key];
    if (!state) continue;
    // Mode predicate: same-backend delegated OR same-backend native. Both
    // surface MCP directly to the session, so both need SDK-level deny.
    const sameBackendDelegated =
      state.mode === "delegated" && state.delegatedBackend === sessionBackend;
    const sameBackendNative =
      state.mode === "native" && state.nativeBackend === sessionBackend;
    if (!sameBackendDelegated && !sameBackendNative) continue;
    // Zod schema defaults deniedTools to `[]`; the `?? []` is defensive
    // against legacy state objects predating the default.
    /* c8 ignore next */
    const denied = state.deniedTools ?? [];
    if (denied.length === 0) continue;
    const descriptor = INTEGRATION_DESCRIPTORS[key];
    const connector = descriptor.backendConnectors[sessionBackend];
    // Forward-compat: every (integration, backend) pair currently has a
    // connector. This branch survives in code as registry drift insurance.
    /* c8 ignore next */
    if (!connector) continue;
    const { active } = filterDeniedToolsForBackend(key, sessionBackend, denied);
    if (active.length === 0) continue;
    const namespaced = active.map((t) => `${connector.toolNamespace}${t}`);
    out.set(key, namespaced);
  }
  return out;
}

// ── Mode-conditional section filter ──────────────────────────────────────────

/**
 * Predicates accepted by `applyIntegrationModeFilter`. Each one keeps the
 * wrapped section when its condition holds for the given integration key
 * and session backend.
 */
export const INTEGRATION_MODE_PREDICATES = [
  "direct",
  "delegated",
  "delegated-same",
  "delegated-cross",
  "native",
  "disabled",
] as const;
export type IntegrationModePredicate =
  (typeof INTEGRATION_MODE_PREDICATES)[number];

const integrationModePredicateSet: ReadonlySet<string> = new Set(
  INTEGRATION_MODE_PREDICATES,
);

/**
 * Strip mode-conditional sections from a task-flow or skill body based on
 * current integration state and session backend. Mirrors the
 * `<!-- service:* -->` family used by `stripUnconfiguredServices` in
 * skills-compiler.ts.
 *
 * Section syntax (HTML comment delimiters, kept literal so authoring stays
 * markdown-friendly):
 *
 *   <!-- mode:<predicate>:<key> -->
 *   ...content shown only when the predicate holds...
 *   <!-- /mode:<predicate>:<key> -->
 *
 * Predicates and the state they keep content for:
 *
 *   direct           — `integrations[key].mode === "direct"`
 *   delegated        — `mode === "delegated"` (regardless of which backend)
 *   delegated-same   — delegated AND `delegatedBackend === sessionBackend`
 *                      (the connector is signed in to this same session's
 *                      backend; the agent uses native MCP tools and skill
 *                      bodies are typically not materialized)
 *   delegated-cross  — delegated AND `delegatedBackend !== sessionBackend`
 *                      (the agent reaches the connector via the daemon
 *                      task-mode proxy at `POST /api/integrations/:key/exec`;
 *                      the legacy `/invoke` RPC was retired 2026-05-01)
 *   disabled         — `mode === "disabled"` OR no state row (treated as
 *                      disabled by `defaultIntegrationsMap`)
 *
 * Behaviour notes:
 *
 *  - **Unknown predicate**: section preserved verbatim. Surfaces the typo in
 *    the rendered prompt rather than silently losing or duplicating prose.
 *  - **Unknown integration key**: section preserved verbatim. Same rationale —
 *    a misspelled key (or registry drift mid-deploy) should remain visible.
 *  - **Sections do not nest**: the regex is non-greedy and matches the
 *    first close tag. Two sibling blocks at the same level work; nesting
 *    a same-key block inside another doesn't and is unsupported.
 *  - **Idempotent**: running the filter twice on the same content with the
 *    same state produces identical output.
 *
 * Apply this AFTER any whole-file variant selection (e.g. `SKILL.delegated.
 * <backend>.md`) so the variant author can use mode markers freely without
 * worrying about pre-filtering interactions.
 */
export function applyIntegrationModeFilter(
  content: string,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
  sessionBackend: BackendId,
): string {
  return content.replace(
    /<!-- mode:([a-z][a-z-]*):([a-z_][a-z0-9_]*) -->\n?([\s\S]*?)<!-- \/mode:\1:\2 -->\n?/g,
    (match, predicate: string, key: string, body: string) => {
      if (!integrationModePredicateSet.has(predicate)) return match;
      if (!isIntegrationKey(key)) return match;
      const keep = evaluateIntegrationModePredicate(
        predicate as IntegrationModePredicate,
        integrations[key],
        sessionBackend,
      );
      return keep ? body : "";
    },
  );
}

function evaluateIntegrationModePredicate(
  predicate: IntegrationModePredicate,
  state: IntegrationState | undefined,
  sessionBackend: BackendId,
): boolean {
  // Treat missing state as disabled (matches `defaultIntegrationsMap`).
  const mode: IntegrationMode = state?.mode ?? "disabled";
  const delegatedBackend = state?.delegatedBackend ?? null;
  const nativeBackend = state?.nativeBackend ?? null;
  switch (predicate) {
    case "direct":
      return mode === "direct";
    case "delegated":
      return mode === "delegated";
    case "delegated-same":
      return mode === "delegated" && delegatedBackend === sessionBackend;
    case "delegated-cross":
      return (
        mode === "delegated"
        && delegatedBackend !== null
        && delegatedBackend !== sessionBackend
      );
    case "native":
      // INTEGRATION_NATIVE_MODE_DESIGN.md §5.4 — a native binding to a
      // different backend than the current session reads as "not native
      // here". The §11.4 cascade prevents the mismatched binding from
      // persisting; this predicate stays defensive against drift.
      return mode === "native" && nativeBackend === sessionBackend;
    case "disabled":
      return mode === "disabled";
  }
}

// ── DELEGATED-TASK-MODE-DESIGN.md §4.2 — `/api/delegated/run` allowedTools ───

/**
 * Validation regex for an `allowedTools` entry on `POST /api/delegated/run`
 * (Phase 2 generic task mode for unregistered MCPs).
 *
 * Spec §4.2 reads: "Specifically rejected: bare `*`, patterns starting with
 * `*`, prefixes shorter than 4 characters before `*` (e.g. `mcp_*`), and
 * anything containing shell metacharacters." The literal example `mcp_*`
 * has a 4-character prefix yet must be rejected — i.e. the spec's prose
 * intent is "≥5 chars before `*`," and the {4,} quantifier in the literal
 * regex contradicts the example. We honor the example: prefix-before-`*`
 * must be ≥5 chars, and bare/leading `*` is rejected outright.
 *
 * Allowed shape:
 *   - 5+ chars of `[A-Za-z0-9_-]` to start.
 *   - Optional dotted/underscored continuation segments
 *     (`([._][A-Za-z0-9_-]+)*`).
 *   - Optional trailing `*` for a glob.
 *
 * Examples accepted: `mcp_my-server_*`, `mcp_my-server_subtool.action`,
 * `mcp__custom-srv_doIt`. Examples rejected: `*`, `*foo`, `mcp_*`,
 * `mcp_my-server_*.action`, `srv;rm -rf /`.
 *
 * Shell-metacharacter rejection is doubled-up: even if a pattern slipped
 * through the regex (it can't — the character class excludes them), the
 * dedicated check in {@link validateRunAllowedTool} would reject. This
 * keeps the safety floor obvious in review.
 */
export const MCP_PATTERN_REGEX =
  /^[A-Za-z0-9_-]{5,}([._][A-Za-z0-9_-]+)*\*?$/;

/**
 * Shell metacharacters not allowed anywhere in an `allowedTools` entry.
 * The regex above already excludes them from the character class, but a
 * standalone check is what {@link validateRunAllowedTool} cites in its
 * `bad_allowed_tools` message so callers see *why* the pattern was rejected
 * (without re-deriving from the regex).
 */
const SHELL_METACHAR_RE = /[;&|`$()<>'"\\\s\n\r\t{}\[\]?#~^!=,]/;

export type ValidateRunAllowedToolsResult =
  | { ok: true }
  | {
      ok: false;
      errorClass: "bad_allowed_tools";
      pattern: string;
      reason:
        | "empty"
        | "bare_star"
        | "leading_star"
        | "prefix_too_short"
        | "shell_metachar"
        | "shape_invalid";
      message: string;
    };

/** Validate a single pattern entry. Exported for unit tests. */
export function validateRunAllowedTool(
  pattern: unknown,
): ValidateRunAllowedToolsResult {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return {
      ok: false,
      errorClass: "bad_allowed_tools",
      pattern: typeof pattern === "string" ? pattern : "",
      reason: "empty",
      message: "allowedTools entries must be non-empty strings",
    };
  }
  if (pattern === "*") {
    return {
      ok: false,
      errorClass: "bad_allowed_tools",
      pattern,
      reason: "bare_star",
      message: "bare `*` is not an allowed pattern — it would match every tool",
    };
  }
  if (pattern.startsWith("*")) {
    return {
      ok: false,
      errorClass: "bad_allowed_tools",
      pattern,
      reason: "leading_star",
      message: "patterns must not start with `*` — anchor with a literal prefix",
    };
  }
  if (SHELL_METACHAR_RE.test(pattern)) {
    return {
      ok: false,
      errorClass: "bad_allowed_tools",
      pattern,
      reason: "shell_metachar",
      message:
        "patterns must not contain shell metacharacters or whitespace",
    };
  }
  // Trailing-star prefix length must be ≥5; the regex enforces this, but
  // we surface a clearer error class for the common typo.
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    if (prefix.length < 5) {
      return {
        ok: false,
        errorClass: "bad_allowed_tools",
        pattern,
        reason: "prefix_too_short",
        message:
          "glob prefix must be at least 5 characters before `*` (e.g. `mcp_my-server_*`)",
      };
    }
  }
  if (!MCP_PATTERN_REGEX.test(pattern)) {
    return {
      ok: false,
      errorClass: "bad_allowed_tools",
      pattern,
      reason: "shape_invalid",
      message:
        "pattern must match ^[A-Za-z0-9_-]{5,}([._][A-Za-z0-9_-]+)*\\*?$ — letters/digits/underscores/dashes with optional `._`-separated segments and an optional trailing `*`",
    };
  }
  return { ok: true };
}

/**
 * Validate every entry in a `/api/delegated/run` `allowedTools` array.
 * Returns the first failing entry (HTTP 400 maps to that), or `{ok: true}`
 * if every pattern is well-formed and the array is non-empty.
 */
export function validateRunAllowedTools(
  patterns: readonly unknown[],
): ValidateRunAllowedToolsResult {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return {
      ok: false,
      errorClass: "bad_allowed_tools",
      pattern: "",
      reason: "empty",
      message: "allowedTools must be a non-empty array",
    };
  }
  for (const p of patterns) {
    const r = validateRunAllowedTool(p);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/**
 * Match an `/api/delegated/run` allowedTools entry against a fully
 * qualified tool name observed in the subprocess stream. Mirrors the
 * `matchToolPattern` semantics used elsewhere — exact equality or
 * `*`-suffix prefix match — but the input space is fully-qualified MCP
 * names, not the bare deny vocabulary, so we expose it as a separate
 * symbol.
 */
export function matchRunAllowedToolPattern(
  pattern: string,
  tool: string,
): boolean {
  if (pattern === tool) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return tool.startsWith(prefix);
  }
  return false;
}

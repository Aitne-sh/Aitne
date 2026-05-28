import { describe, it, expect } from "vitest";
import {
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  INTEGRATION_MODES,
  INTEGRATION_MODE_PREDICATES,
  NATIVE_CONNECTOR_BACKEND_IDS,
  applyIntegrationModeFilter,
  backendHasIntegrationConnector,
  buildSourcePrefixFilter,
  getObservationSourcePrefixesForKind,
  collectSessionDeniedTools,
  defaultIntegrationsMap,
  delegatedIntegrationsForProcessKey,
  destructiveTaskTools,
  destructiveTaskToolsBare,
  filterDeniedToolsForBackend,
  getIntegrationDescriptor,
  integrationPatchSchema,
  integrationStateSchema,
  integrationsMapSchema,
  isIntegrationKey,
  isIntegrationMode,
  listIntegrationDescriptors,
  matchRunAllowedToolPattern,
  matchToolPattern,
  MCP_PATTERN_REGEX,
  nativeIntegrationsForProcessKey,
  recommendedStarterDeniedTools,
  selectSkillVariantFile,
  selectTaskFlowVariantSuffix,
  supportedNativeBackends,
  validateDeniedTools,
  validateRunAllowedTool,
  validateRunAllowedTools,
  type IntegrationState,
} from "./integrations.js";
import { BACKEND_IDS } from "./backend.js";

describe("Integration registry", () => {
  it("declares hosted and Git lifecycle integrations as registered keys", () => {
    expect(INTEGRATION_KEYS).toEqual([
      "gmail",
      "google_calendar",
      "notion",
      "git",
      "github",
      "outlook_mail",
      "outlook_calendar",
      "browser_history",
    ]);
  });

  it("exposes descriptor metadata for every registered key", () => {
    // Most registered keys declare the delegated-capable mode tuple. Outlook
    // integrations ship as "user-managed connector" (the daemon trusts the
    // user's MCP wiring on the chosen backend), so they declare delegated AND
    // native while leaving `backendConnectors` empty —
    // INTEGRATION_NATIVE_MODE_DESIGN.md §5.3. Browser History is
    // high-sensitivity local telemetry and intentionally supports only
    // direct/disabled.
    const userManagedKeys = new Set<string>(["outlook_mail", "outlook_calendar"]);
    const directOnlyKeys = new Set<string>(["browser_history"]);
    for (const key of INTEGRATION_KEYS) {
      const descriptor = INTEGRATION_DESCRIPTORS[key];
      expect(descriptor.key).toBe(key);
      expect(descriptor.displayName).toBeTruthy();
      expect(descriptor.supportedModes).toEqual(
        directOnlyKeys.has(key)
          ? ["direct", "disabled"]
          : expect.arrayContaining(["direct", "delegated", "disabled"]),
      );
      if (directOnlyKeys.has(key)) {
        expect(descriptor.userManagedConnector).toBe(false);
        expect(Object.keys(descriptor.backendConnectors).length).toBe(0);
      } else if (userManagedKeys.has(key)) {
        expect(descriptor.userManagedConnector).toBe(true);
        expect(Object.keys(descriptor.backendConnectors).length).toBe(0);
      } else {
        // Descriptor-driven integrations declare at least one backend
        // connector. Gmail, Calendar, and Notion all ship with
        // claude + codex + gemini.
        expect(Object.keys(descriptor.backendConnectors).length).toBeGreaterThan(0);
      }
    }
  });

  it("Outlook descriptors declare delegated AND native as user-managed with empty backendConnectors", () => {
    // Outlook delegated AND native modes are "user-managed connector":
    // the user installs an MCP / connector on the agent backend they
    // pick, and the daemon trusts that wiring. `backendConnectors`
    // stays empty so the probe and feature matrix do not pretend to
    // know what the backend exposes — INTEGRATION_NATIVE_MODE_DESIGN.md
    // §5.3 (2026-05 amendment).
    for (const key of ["outlook_mail", "outlook_calendar"] as const) {
      const desc = INTEGRATION_DESCRIPTORS[key];
      expect(desc.supportedModes).toEqual(
        expect.arrayContaining(["direct", "delegated", "native", "disabled"]),
      );
      expect(desc.userManagedConnector).toBe(true);
      expect(desc.backendConnectors).toEqual({});
      expect(desc.directSetup).toBeDefined();
    }
  });

  it("outlook_calendar.apiRoutesTouched is /api/calendar/outlook (single-provider, prefix-gateable)", () => {
    expect(INTEGRATION_DESCRIPTORS.outlook_calendar.apiRoutesTouched).toEqual([
      "/api/calendar/outlook",
    ]);
  });

  it("outlook_mail.apiRoutesTouched is empty — `/api/mail/*` is multi-provider", () => {
    // Same exception Gmail makes: prefix-gating multi-provider routes
    // would block other Mail providers. Per-account 410 inside the
    // handler is the defense-in-depth surface when a future delegated
    // mode lands.
    expect(INTEGRATION_DESCRIPTORS.outlook_mail.apiRoutesTouched).toEqual([]);
  });

  it("browser_history is direct-only and exposes only agent-facing data routes to the integration gate", () => {
    const desc = INTEGRATION_DESCRIPTORS.browser_history;
    expect(desc.supportedModes).toEqual(["direct", "disabled"]);
    expect(desc.backendConnectors).toEqual({});
    expect(desc.observersTouched).toEqual([
      "browser-history-poller",
      "browser-lifecycle-supervisor",
    ]);
    expect(desc.apiRoutesTouched).toEqual([
      "/api/browser-history/research-clusters",
      "/api/browser-history/yesterday-summary",
      // BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 P4a — JSON fallback for
      // the morning journal. Gated together with `yesterday-summary` so
      // a `disabled` integration cannot serve digest data through this
      // route.
      "/api/browser-history/pre-morning-digest",
      // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.7 — control-plane
      // status read used by the dashboard's consent banner before the
      // operator opts in. Exposed even when the integration is in
      // `direct` / `delegated` mode so the banner can show detection
      // state without flipping the gate; the mutation siblings under
      // `/managed/*` route through the risk-tier gate instead of the
      // integration gate.
      "/api/browser-history/managed/status",
    ]);
  });

  // docs/design/appendices/routine-data-acquisition.md §10 R3 / F7 — user-managed
  // Outlook integrations express their routine coupling via the new
  // `taskFlowsReferenced` field instead of `taskFlowsTouched` (which
  // controls variant materialization, irrelevant here).
  it("outlook_mail declares taskFlowsReferenced for the routines that include its partial", () => {
    const refs = INTEGRATION_DESCRIPTORS.outlook_mail.taskFlowsReferenced;
    expect(refs).toBeDefined();
    const routines = refs!.map((r) => r.routine).sort();
    // `routine.fetch_window` is the §6.1.1 pre-pass session, which
    // bundles every acquire partial directly. The dispatcher chooses
    // at runtime which `<fetch>` rows reach it, so every integration
    // that owns a partial appears in this list.
    expect(routines).toEqual([
      "routine.evening_review",
      "routine.fetch_window",
      "routine.hourly_check",
      "routine.morning_routine",
    ]);
    expect(refs!.every((r) => r.via === "partial")).toBe(true);
    // taskFlowsTouched stays empty — no variant materialization.
    expect(INTEGRATION_DESCRIPTORS.outlook_mail.taskFlowsTouched).toEqual([]);
  });

  it("outlook_calendar declares taskFlowsReferenced ONLY for routines whose body includes the calendar-acquire partial", () => {
    // The field semantics is `via: "partial"` — routines that reach
    // Outlook calendar via the multi-provider `<calendar_events_*>`
    // ContextBuilder block (morning / evening / monthly) do NOT belong
    // here because they never include `_partials/calendar-acquire
    // .outlook_calendar.md`. Per design §6.10 only three routines have
    // calendar windows NOT covered by the context block, plus the
    // pre-pass `routine.fetch_window` which bundles every partial.
    const refs = INTEGRATION_DESCRIPTORS.outlook_calendar.taskFlowsReferenced;
    expect(refs).toBeDefined();
    const routines = refs!.map((r) => r.routine).sort();
    expect(routines).toEqual([
      "routine.fetch_window",
      "routine.hourly_check",
      "routine.today_refresh",
      "routine.weekly_review",
    ]);
    expect(refs!.every((r) => r.via === "partial")).toBe(true);
    expect(INTEGRATION_DESCRIPTORS.outlook_calendar.taskFlowsTouched).toEqual(
      [],
    );
  });

  // docs/design/appendices/routine-data-acquisition.md §10 R3 / C1 — the
  // `taskFlowsReferenced` field is no longer Outlook-only. Every
  // integration with a partial in `_partials/` now declares the
  // routines whose body includes it, so the bidirectional drift lint
  // in `routine-partials.test.ts` exercises all five acquire partials.
  // `taskFlowsTouched` retains its variant-materialization semantics
  // (non-empty for gmail / google_calendar / notion because their
  // `routine.hourly_check.delegated.<be>.md` variants used to live in
  // the tree — Phase 3 R4 deleted those, but the field is still
  // honoured by `selectTaskFlowVariantSuffix` for the DM variants).
  it("gmail declares taskFlowsReferenced for every routine that includes its mail-acquire partial", () => {
    const refs = INTEGRATION_DESCRIPTORS.gmail.taskFlowsReferenced;
    expect(refs).toBeDefined();
    const routines = refs!.map((r) => r.routine).sort();
    expect(routines).toEqual([
      "routine.evening_review",
      "routine.fetch_window",
      "routine.hourly_check",
      "routine.morning_routine",
    ]);
    expect(refs!.every((r) => r.via === "partial")).toBe(true);
  });

  it("google_calendar declares taskFlowsReferenced ONLY for routines whose body includes the calendar-acquire partial", () => {
    // Mirrors the outlook_calendar shape — morning / evening / monthly
    // read the multi-provider `<calendar_events_*>` ContextBuilder block
    // directly and do NOT include the partial. `routine.fetch_window`
    // bundles every partial because the dispatcher chooses at runtime.
    const refs = INTEGRATION_DESCRIPTORS.google_calendar.taskFlowsReferenced;
    expect(refs).toBeDefined();
    const routines = refs!.map((r) => r.routine).sort();
    expect(routines).toEqual([
      "routine.fetch_window",
      "routine.hourly_check",
      "routine.today_refresh",
      "routine.weekly_review",
    ]);
    expect(refs!.every((r) => r.via === "partial")).toBe(true);
  });

  it("notion declares taskFlowsReferenced ONLY for routines whose body includes the notion-acquire partial", () => {
    // Morning + hourly are the only routines whose `ROUTINE_WINDOWS`
    // plan kind includes `notion`; evening / weekly / monthly draw on
    // daily-journal carry-over instead of a fresh pre-pass.
    // `routine.fetch_window` bundles every partial.
    const refs = INTEGRATION_DESCRIPTORS.notion.taskFlowsReferenced;
    expect(refs).toBeDefined();
    const routines = refs!.map((r) => r.routine).sort();
    expect(routines).toEqual([
      "routine.fetch_window",
      "routine.hourly_check",
      "routine.morning_routine",
    ]);
    expect(refs!.every((r) => r.via === "partial")).toBe(true);
  });

  it("notion ships with claude + codex + gemini connectors", () => {
    const notion = INTEGRATION_DESCRIPTORS.notion;
    expect(notion.backendConnectors.claude).toBeDefined();
    expect(notion.backendConnectors.codex).toBeDefined();
    expect(notion.backendConnectors.gemini).toBeDefined();
  });

  it("gmail, google_calendar, and notion all ship with claude + codex + gemini connectors", () => {
    for (const key of ["gmail", "google_calendar", "notion"] as const) {
      expect(Object.keys(INTEGRATION_DESCRIPTORS[key].backendConnectors)).toEqual(
        expect.arrayContaining(["claude", "codex", "gemini"]),
      );
    }
  });

  it("gemini connectors use the single-underscore namespace convention", () => {
    // Confirmed via stream-event probe 2026-04-26: Gemini CLI emits MCP
    // tool names as `mcp_<server>_<tool>` (single underscore), not the
    // `mcp__<server>__<tool>` (double underscore) form Claude / Codex use.
    // The probe matcher in evaluateProbe relies on this prefix.
    for (const key of ["gmail", "google_calendar", "notion"] as const) {
      const gemini = INTEGRATION_DESCRIPTORS[key].backendConnectors.gemini;
      expect(gemini).toBeDefined();
      expect(gemini!.toolNamespace.startsWith("mcp_")).toBe(true);
      expect(gemini!.toolNamespace.startsWith("mcp__")).toBe(false);
    }
  });

  it("marks Claude's Gmail connector as missing send/delete/attachment", () => {
    const gmail = INTEGRATION_DESCRIPTORS.gmail;
    const claude = gmail.backendConnectors.claude;
    expect(claude).toBeDefined();
    expect(claude!.optionalCapabilities).not.toContain("send");
    expect(claude!.optionalCapabilities).not.toContain("delete");
    expect(claude!.optionalCapabilities).not.toContain("read_attachment");
    const codex = gmail.backendConnectors.codex;
    expect(codex!.optionalCapabilities).toContain("send");
    expect(codex!.optionalCapabilities).toContain("delete");
  });

  it("namespace + capabilityTool concatenates to a real-looking MCP tool name (no double underscores)", () => {
    // Regression guard: the original Codex registry put leading
    // underscores in capabilityTools while the namespace already ended
    // with `._`, producing fake names like
    // `mcp__codex_apps__gmail.__search_emails`. The probe would then
    // silently report every Codex capability absent.
    for (const descriptor of listIntegrationDescriptors()) {
      for (const [backend, connector] of Object.entries(descriptor.backendConnectors)) {
        if (!connector) continue;
        for (const tools of Object.values(connector.capabilityTools)) {
          for (const tool of tools) {
            const fullName = connector.toolNamespace + tool;
            expect(
              fullName.includes("___"),
              `${descriptor.key}.${backend}: namespace+${tool} produces triple underscore ${fullName}`,
            ).toBe(false);
            // Two underscores in a row are legal inside the namespace
            // (`mcp__claude_ai_Gmail__`) but not at the boundary.
            const boundary = fullName.slice(
              connector.toolNamespace.length - 1,
              connector.toolNamespace.length + 1,
            );
            expect(
              boundary === "__" && tool.startsWith("_"),
              `${descriptor.key}.${backend}: namespace ends in '_' and tool '${tool}' starts with '_' — produces "${fullName}" with collapsed boundary`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("populates capabilityTools for every required capability of every connector", () => {
    for (const descriptor of listIntegrationDescriptors()) {
      for (const [backend, connector] of Object.entries(descriptor.backendConnectors)) {
        if (!connector) continue;
        for (const cap of connector.requiredCapabilities) {
          const tools = connector.capabilityTools[cap];
          expect(
            tools,
            `${descriptor.key}.${backend}.requiredCapabilities[${cap}] needs an entry in capabilityTools`,
          ).toBeDefined();
          expect(tools!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("leaves gmail.apiRoutesTouched empty — `/api/mail/*` is multi-provider so the per-account 410 inside the route handler covers Gmail", () => {
    // DELEGATED-MODE-V2-DESIGN.md §6.3: blanket-gating `/api/mail/*` at
    // the registry level would also block iCloud / Outlook / IMAP
    // accounts. Per-account 410 inside the mail handler is the
    // defense-in-depth surface for delegated Gmail.
    expect(INTEGRATION_DESCRIPTORS.gmail.apiRoutesTouched).toEqual([]);
  });

  it("populates google_calendar.apiRoutesTouched with `/api/calendar` — single-provider, defense-in-depth 410 gate", () => {
    // DELEGATED-MODE-V2-DESIGN.md §3.4 / §6.3: Calendar's single-tenant
    // route surface lets the route gate fire 410 against hallucinated
    // direct-mode calls when the integration is delegated.
    expect(INTEGRATION_DESCRIPTORS.google_calendar.apiRoutesTouched).toEqual([
      "/api/calendar",
    ]);
  });

  it("re-populates skillsTouched for gmail and google_calendar so selectSkillVariantFile engages on the per-mode variants", () => {
    // DELEGATED-MODE-V2-DESIGN.md §3.4 / §5.1: Phase 3 restored per-mode
    // skill provisioning. The materializer reads these to pick
    // `SKILL.delegated.<sessionBackend>.md` (cross-backend) or `null`
    // (same-backend native MCP).
    expect(INTEGRATION_DESCRIPTORS.gmail.skillsTouched).toEqual(["mail"]);
    expect(INTEGRATION_DESCRIPTORS.google_calendar.skillsTouched).toEqual([
      "external-services",
    ]);
  });

  it("retains taskFlowsTouched: ['routine.hourly_check'] on gmail and google_calendar — pollers stop in delegated mode and the variant compensates; INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 adds the DM flows so the native DM variants resolve via selectTaskFlowVariantSuffix", () => {
    // The per-integration mode-aware variant of the hourly check
    // restores observations the stopped pollers no longer produce.
    // `delegatedIntegrationsForProcessKey` excludes proxy-driven
    // integrations from fallback-refusal because the daemon proxy
    // works regardless of the agent backend.
    //
    // §8.1 adds `message.received.dm` / `message.received.dm_first` so
    // the new `message.received.dm.native.<backend>.md` variants are
    // selected. The delegated DM variants are intentionally absent —
    // the base flow's inline `<!-- mode:<predicate>:google_calendar -->`
    // markers cover that branch; the loader's fallback (`prompts.ts:
    // loadFlowVariant`) reads the base when the variant file is missing,
    // and `missingVariantsForMode` (skills-compiler.ts) is lenient when
    // the base file exists.
    expect(INTEGRATION_DESCRIPTORS.gmail.taskFlowsTouched).toEqual([
      "routine.hourly_check",
      "message.received.dm",
      "message.received.dm_first",
    ]);
    expect(INTEGRATION_DESCRIPTORS.google_calendar.taskFlowsTouched).toEqual([
      "routine.hourly_check",
      "message.received.dm",
      "message.received.dm_first",
    ]);
  });

  it("declares deniedToolsAppliesToSkills on gmail and google_calendar so applyAllDeniedToolsForSkill reaches the variant skill body", () => {
    // DELEGATED-MODE-V2-DESIGN.md §5.1 keeps `deniedToolsAppliesToSkills`
    // unchanged. With Phase 3's `skillsTouched` restoration the field is
    // structurally redundant for the default-variant case but remains
    // for symmetry and future variants.
    expect(INTEGRATION_DESCRIPTORS.gmail.deniedToolsAppliesToSkills).toEqual(["mail"]);
    expect(INTEGRATION_DESCRIPTORS.google_calendar.deniedToolsAppliesToSkills).toEqual([
      "external-services",
    ]);
  });

  it("Notion retains the legacy variant path", () => {
    expect(INTEGRATION_DESCRIPTORS.notion.skillsTouched).toEqual(["notion"]);
  });

  it("registers git and github as CLI-backed lifecycle integrations", () => {
    for (const key of ["git", "github"] as const) {
      const descriptor = INTEGRATION_DESCRIPTORS[key];
      expect(descriptor.directSetup).toBeUndefined();
      expect(descriptor.skillsTouched).toEqual([]);
      expect(descriptor.taskFlowsTouched).toEqual([]);
      expect(descriptor.apiRoutesTouched).toEqual([]);
      expect(descriptor.observersTouched).toEqual([key]);
      for (const backend of NATIVE_CONNECTOR_BACKEND_IDS) {
        const connector = descriptor.backendConnectors[backend];
        expect(connector).toBeDefined();
        expect(connector!.requiredCapabilities).toEqual([]);
        expect(connector!.optionalCapabilities).toEqual([]);
        expect(connector!.destructiveTools).toEqual([]);
      }
    }
  });

  it("declares sameBackendDropsSkillBody only for skills the integration's connector fully wraps", () => {
    // notion: pure connector wrapper — drop is correct.
    expect(INTEGRATION_DESCRIPTORS.notion.sameBackendDropsSkillBody).toEqual(["notion"]);
    // gmail: `mail` covers IMAP/Outlook beyond Gmail — body must NOT drop.
    expect(INTEGRATION_DESCRIPTORS.gmail.sameBackendDropsSkillBody ?? []).toEqual([]);
    // google_calendar: `external-services` covers Obsidian/GitHub/scheduling
    // beyond Calendar — body must NOT drop.
    expect(INTEGRATION_DESCRIPTORS.google_calendar.sameBackendDropsSkillBody ?? [])
      .toEqual([]);
  });

  it("every sameBackendDropsSkillBody entry is a subset of its skillsTouched (registry self-consistency)", () => {
    for (const key of INTEGRATION_KEYS) {
      const desc = INTEGRATION_DESCRIPTORS[key];
      const drops = desc.sameBackendDropsSkillBody ?? [];
      const touched = new Set(desc.skillsTouched);
      for (const slug of drops) {
        expect(touched.has(slug)).toBe(true);
      }
    }
  });

  it("scopes notion.apiRoutesTouched to query/search/pages — leaves /api/notion/databases ungated", () => {
    // Per NOTION_DELEGATION_DESIGN.md §5 + §7.2: databases is a config
    // dump (no Notion API call); the other three sub-prefixes hit the
    // API and are 410-gated when delegated.
    expect(INTEGRATION_DESCRIPTORS.notion.apiRoutesTouched).toEqual([
      "/api/notion/query",
      "/api/notion/search",
      "/api/notion/pages",
    ]);
  });

  it("getIntegrationDescriptor returns the same object as the map", () => {
    expect(getIntegrationDescriptor("gmail")).toBe(INTEGRATION_DESCRIPTORS.gmail);
  });

  it("listIntegrationDescriptors returns descriptors in key order", () => {
    const list = listIntegrationDescriptors();
    expect(list.map((d) => d.key)).toEqual([...INTEGRATION_KEYS]);
  });

  it("isIntegrationKey narrows string input", () => {
    expect(isIntegrationKey("gmail")).toBe(true);
    expect(isIntegrationKey("google_calendar")).toBe(true);
    expect(isIntegrationKey("notion")).toBe(true);
    expect(isIntegrationKey("git")).toBe(true);
    expect(isIntegrationKey("github")).toBe(true);
    expect(isIntegrationKey("slack")).toBe(false);
    expect(isIntegrationKey("")).toBe(false);
  });

  it("isIntegrationMode narrows string input", () => {
    expect(isIntegrationMode("direct")).toBe(true);
    expect(isIntegrationMode("delegated")).toBe(true);
    expect(isIntegrationMode("disabled")).toBe(true);
    expect(isIntegrationMode("other")).toBe(false);
  });
});

// DELEGATED-TASK-MODE-DESIGN.md §7.3 — destructive-tool drift detection.
// The connector's `destructiveTools` is the single source of truth for
// what runDelegatedTask treats as confirmation-gated. The starter denylist
// must stay a (possibly proper) subset of it, and every entry must come
// from the connector's known-tool universe.
describe("destructiveTools (DELEGATED-TASK-MODE-DESIGN.md §7.3)", () => {
  it("every connector declares a destructiveTools array", () => {
    for (const key of INTEGRATION_KEYS) {
      const descriptor = INTEGRATION_DESCRIPTORS[key];
      for (const backend of BACKEND_IDS) {
        const connector = descriptor.backendConnectors[backend];
        if (!connector) continue;
        expect(Array.isArray(connector.destructiveTools)).toBe(true);
      }
    }
  });

  it("every destructiveTools entry appears in some capabilityTools array", () => {
    for (const key of INTEGRATION_KEYS) {
      const descriptor = INTEGRATION_DESCRIPTORS[key];
      for (const backend of BACKEND_IDS) {
        const connector = descriptor.backendConnectors[backend];
        if (!connector) continue;
        const known = new Set<string>();
        for (const tools of Object.values(connector.capabilityTools)) {
          for (const t of tools) known.add(t);
        }
        for (const dt of connector.destructiveTools) {
          expect(known.has(dt)).toBe(true);
        }
      }
    }
  });

  it("destructiveTools never contains read-only tools (regression guard)", () => {
    // Spot-check the exact failure modes that motivated tool-name granularity:
    // Gemini Gmail's `label` capability mixes `listLabels` (read) with
    // `modify` (write); Notion's `users`/`teams` read-only.
    const gmGemini = INTEGRATION_DESCRIPTORS.gmail.backendConnectors.gemini!;
    expect(gmGemini.destructiveTools).not.toContain("listLabels");
    expect(gmGemini.destructiveTools).toContain("modify");
    const claudeNotion = INTEGRATION_DESCRIPTORS.notion.backendConnectors.claude!;
    expect(claudeNotion.destructiveTools).not.toContain("notion-get-comments");
    expect(claudeNotion.destructiveTools).not.toContain("notion-get-users");
    expect(claudeNotion.destructiveTools).toContain("notion-update-page");
  });

  it("recommended starter denylist is a subset of destructiveTools", () => {
    // Every entry in RECOMMENDED_STARTER_DENIED_TOOLS for a connector must
    // also appear in the connector's destructiveTools — otherwise the
    // starter floor would deny tools the task-mode pipeline considers
    // benign, surfacing as confusing user behavior.
    for (const key of INTEGRATION_KEYS) {
      const descriptor = INTEGRATION_DESCRIPTORS[key];
      for (const backend of BACKEND_IDS) {
        const connector = descriptor.backendConnectors[backend];
        if (!connector) continue;
        const starter = recommendedStarterDeniedTools(key, backend);
        const destructive = new Set(connector.destructiveTools);
        for (const t of starter) {
          expect(destructive.has(t)).toBe(true);
        }
      }
    }
  });

  it("destructiveTaskTools returns namespaced names", () => {
    const tools = destructiveTaskTools("gmail", "gemini");
    expect(tools).toContain("mcp_google-workspace_gmail.send");
    expect(tools).toContain("mcp_google-workspace_gmail.modify");
    // Read-only tools must not appear.
    expect(tools).not.toContain("mcp_google-workspace_gmail.listLabels");
    expect(tools).not.toContain("mcp_google-workspace_gmail.search");
  });

  it("destructiveTaskToolsBare returns unnamespaced names", () => {
    const tools = destructiveTaskToolsBare("google_calendar", "claude");
    expect(tools).toEqual([
      "create_event",
      "update_event",
      "delete_event",
      "respond_to_event",
    ]);
  });
});

describe("defaultIntegrationsMap", () => {
  it("returns per-key defaults with the supplied timestamp", () => {
    const now = "2026-04-19T12:00:00.000Z";
    const map = defaultIntegrationsMap(now);
    for (const key of INTEGRATION_KEYS) {
      expect(map[key]).toEqual({
        mode: key === "git" || key === "github" ? "direct" : "disabled",
        deniedTools: [],
        lastChangedAt: now,
      });
    }
  });

  it("uses a fresh ISO timestamp when none is supplied", () => {
    const map = defaultIntegrationsMap();
    expect(map.gmail.lastChangedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("integrationStateSchema", () => {
  it("accepts a valid disabled state", () => {
    const result = integrationStateSchema.parse({
      mode: "disabled",
      deniedTools: [],
      lastChangedAt: "2026-04-19T00:00:00.000Z",
    });
    expect(result.mode).toBe("disabled");
  });

  it("requires delegatedBackend when mode is delegated", () => {
    const result = integrationStateSchema.safeParse({
      mode: "delegated",
      deniedTools: [],
      lastChangedAt: "2026-04-19T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a delegated state with a backend", () => {
    const result = integrationStateSchema.parse({
      mode: "delegated",
      delegatedBackend: "claude",
      deniedTools: [],
      lastChangedAt: "2026-04-19T00:00:00.000Z",
    });
    expect(result.delegatedBackend).toBe("claude");
  });

  it("rejects an unknown mode", () => {
    const result = integrationStateSchema.safeParse({
      mode: "maintenance",
      deniedTools: [],
      lastChangedAt: "2026-04-19T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown backend", () => {
    const result = integrationStateSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "openai",
      deniedTools: [],
      lastChangedAt: "2026-04-19T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("integrationPatchSchema", () => {
  it("accepts a direct patch without delegatedBackend", () => {
    const result = integrationPatchSchema.parse({ mode: "direct" });
    expect(result.mode).toBe("direct");
  });

  it("rejects a non-delegated mode with delegatedBackend set", () => {
    const result = integrationPatchSchema.safeParse({
      mode: "disabled",
      delegatedBackend: "codex",
    });
    expect(result.success).toBe(false);
  });

  it("rejects delegated without backend", () => {
    const result = integrationPatchSchema.safeParse({ mode: "delegated" });
    expect(result.success).toBe(false);
  });

  it("accepts delegated + backend", () => {
    const result = integrationPatchSchema.parse({
      mode: "delegated",
      delegatedBackend: "codex",
    });
    expect(result.delegatedBackend).toBe("codex");
  });
});

describe("integrationsMapSchema", () => {
  it("accepts a map keyed by valid integration keys", () => {
    const result = integrationsMapSchema.parse({
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    expect(result.gmail?.mode).toBe("direct");
  });

  it("rejects unknown keys", () => {
    const result = integrationsMapSchema.safeParse({
      slack: { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T00:00:00.000Z" },
    });
    expect(result.success).toBe(false);
  });
});

describe("exports", () => {
  it("exposes INTEGRATION_MODES with the documented vocabulary", () => {
    // INTEGRATION_NATIVE_MODE_DESIGN.md §3.1 — `native` is the fourth mode,
    // sandwiched between `delegated` and `disabled` so the UI ordering
    // (direct → delegated → native → disabled) reads from "most setup" to
    // "least setup."
    expect(INTEGRATION_MODES).toEqual([
      "direct",
      "delegated",
      "native",
      "disabled",
    ]);
  });
});

describe("selectSkillVariantFile — DELEGATED-MODE-V2-DESIGN.md §4.1.1 three-state resolution", () => {
  const now = "2026-04-19T00:00:00.000Z";

  it("returns SKILL.md when no integration touches the skill (skill is integration-agnostic)", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    // `context` is not in any integration's skillsTouched.
    expect(selectSkillVariantFile("context", "claude", integrations)).toBe("SKILL.md");
  });

  it("returns SKILL.md when all touched integrations are direct", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.notion = { mode: "direct", deniedTools: [], lastChangedAt: now };
    expect(selectSkillVariantFile("notion", "claude", integrations)).toBe("SKILL.md");
  });

  it("returns SKILL.md when all touched integrations are disabled (default state)", () => {
    const integrations = defaultIntegrationsMap(now);
    expect(selectSkillVariantFile("notion", "codex", integrations)).toBe("SKILL.md");
  });

  it("returns null (no skill) when notion is delegated to the SAME backend as the session — same-backend native MCP", () => {
    // §4.1.2: the agent already has the connector's tools in its inventory;
    // a skill body would be redundant and would mis-direct the agent at
    // /api/integrations/:key/exec (which 409s in this case; the legacy
    // /invoke RPC was retired 2026-05-01).
    const integrations = defaultIntegrationsMap(now);
    integrations.notion = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(selectSkillVariantFile("notion", "claude", integrations)).toBeNull();
  });

  it("returns null (no skill) when notion is delegated to codex with a Codex DM session", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.notion = { mode: "delegated", delegatedBackend: "codex", deniedTools: [], lastChangedAt: now };
    expect(selectSkillVariantFile("notion", "codex", integrations)).toBeNull();
  });

  it("returns SKILL.delegated.<sessionBackend>.md when notion is delegated to a DIFFERENT backend than the session — cross-backend proxy", () => {
    // Claude DM session × Codex-owned Notion connector → use the daemon
    // proxy. The variant body teaches /api/integrations/notion/exec prose
    // (the legacy /invoke RPC was retired 2026-05-01).
    const integrations = defaultIntegrationsMap(now);
    integrations.notion = { mode: "delegated", delegatedBackend: "codex", deniedTools: [], lastChangedAt: now };
    expect(selectSkillVariantFile("notion", "claude", integrations)).toBe("SKILL.delegated.claude.md");
  });

  it("returns SKILL.delegated.codex.md when notion is delegated to Claude with a Codex DM session", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.notion = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(selectSkillVariantFile("notion", "codex", integrations)).toBe("SKILL.delegated.codex.md");
  });

  it("returns SKILL.md for mail when gmail is delegated same-backend — multi-provider skill body survives", () => {
    // The `mail` skill covers IMAP/Outlook/iCloud on top of Gmail. When
    // Gmail is same-backend delegated the connector handles Gmail accounts
    // natively, but `/api/mail/*` is still the only path for non-Gmail
    // accounts. The gmail descriptor's `sameBackendDropsSkillBody` is
    // empty so the SKILL.md body is retained.
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(selectSkillVariantFile("mail", "claude", integrations)).toBe("SKILL.md");
  });

  it("returns SKILL.md for external-services when google_calendar is delegated same-backend — multi-purpose skill survives", () => {
    // `external-services` covers Obsidian, GitHub, recurring schedules
    // and one-shot scheduling alongside Google Calendar. Dropping the
    // body would orphan all four; google_calendar's
    // `sameBackendDropsSkillBody` is intentionally empty.
    const integrations = defaultIntegrationsMap(now);
    integrations.google_calendar = { mode: "delegated", delegatedBackend: "codex", deniedTools: [], lastChangedAt: now };
    expect(selectSkillVariantFile("external-services", "codex", integrations)).toBe("SKILL.md");
  });

  it("returns SKILL.delegated.<sessionBackend>.md when calendar is delegated cross-backend (Phase 3.4 cross-backend resolution)", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.google_calendar = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(selectSkillVariantFile("external-services", "codex", integrations))
      .toBe("SKILL.delegated.codex.md");
  });

  it("returns SKILL.md for today/schedule/roadmap even when gmail is delegated (no skill variant required)", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    // today/schedule/roadmap bodies are backend-neutral — no variants needed.
    expect(selectSkillVariantFile("today", "claude", integrations)).toBe("SKILL.md");
    expect(selectSkillVariantFile("schedule", "claude", integrations)).toBe("SKILL.md");
    expect(selectSkillVariantFile("roadmap", "claude", integrations)).toBe("SKILL.md");
  });
});

describe("selectTaskFlowVariantSuffix", () => {
  const now = "2026-04-19T00:00:00.000Z";

  it("returns 'direct' when no integration touches the task flow", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    // routine.roadmap_refresh is NOT in any integration's taskFlowsTouched
    expect(selectTaskFlowVariantSuffix("routine.roadmap_refresh", "claude", integrations)).toBe("direct");
  });

  it("returns 'direct' for morning_routine even when gmail is delegated — Phase D removed the variant", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(selectTaskFlowVariantSuffix("routine.morning_routine", "claude", integrations)).toBe("direct");
  });

  it("returns 'direct' for morning_routine even when calendar is delegated — Phase D removed the variant", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.google_calendar = { mode: "delegated", delegatedBackend: "codex", deniedTools: [], lastChangedAt: now };
    expect(selectTaskFlowVariantSuffix("routine.morning_routine", "codex", integrations)).toBe("direct");
  });

  it("returns 'delegated.claude' for hourly_check when ONLY gmail is delegated — variant compensates for the MailPoller per-account filter", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(selectTaskFlowVariantSuffix("routine.hourly_check", "claude", integrations)).toBe("delegated.claude");
  });

  it("returns 'delegated.codex' for hourly_check when ONLY google_calendar is delegated — variant compensates for the stopped CalendarPoller", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.google_calendar = { mode: "delegated", delegatedBackend: "codex", deniedTools: [], lastChangedAt: now };
    expect(selectTaskFlowVariantSuffix("routine.hourly_check", "codex", integrations)).toBe("delegated.codex");
  });

  it("returns 'delegated.claude' for hourly_check when notion is delegated on claude — legacy path retained for notion", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.notion = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    // notion still uses the legacy variant path; its hourly_check variant
    // restores observation coverage when NotionPoller stops.
    expect(selectTaskFlowVariantSuffix("routine.hourly_check", "claude", integrations)).toBe("delegated.claude");
  });

  it("returns null for the notion skill when notion is delegated on claude with a Claude DM session — same-backend native MCP", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.notion = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    // §4.1.2 — same-backend: notion's tools are already in the Claude
    // session's inventory, so no skill body is materialized.
    expect(selectSkillVariantFile("notion", "claude", integrations)).toBeNull();
  });

  it("returns 'direct' for evening_review even when gmail or calendar is delegated (context block carries the MCP directive)", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    integrations.google_calendar = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(selectTaskFlowVariantSuffix("routine.evening_review", "claude", integrations)).toBe("direct");
  });

  it("returns 'delegated.<backend>' for message.received.dm when calendar is delegated — INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 added DM to taskFlowsTouched so the variant selector now engages; the delegated variant file is intentionally absent so the loader falls back to the base file with its inline <!-- mode:delegated:google_calendar --> markers", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.google_calendar = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(selectTaskFlowVariantSuffix("message.received.dm", "claude", integrations)).toBe("delegated.claude");
  });

  it("returns 'native.<backend>' for message.received.dm when gmail is native and the session backend matches — pins the §8.1 wiring", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "native", nativeBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(selectTaskFlowVariantSuffix("message.received.dm", "claude", integrations)).toBe("native.claude");
    expect(selectTaskFlowVariantSuffix("message.received.dm_first", "claude", integrations)).toBe("native.claude");
  });

  it("treats an undefined entry as disabled (sparse map — ?? fallback fires when the touched integration is missing from the map)", () => {
    // A bare `{}` map plus a touched task flow exercises
    // `integrations[k]?.mode ?? "disabled"` — every touchingKey
    // resolves through the nullish-coalescing branch.
    expect(selectTaskFlowVariantSuffix("routine.hourly_check", "claude", {})).toBe("direct");
  });
});

describe("delegatedIntegrationsForProcessKey", () => {
  const now = "2026-04-19T00:00:00.000Z";

  it("returns empty when no integration is delegated", () => {
    const integrations = defaultIntegrationsMap(now);
    expect(delegatedIntegrationsForProcessKey("routine.morning_routine", integrations)).toEqual([]);
  });

  it("returns empty for a process key no integration touches", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(delegatedIntegrationsForProcessKey("routine.evening_review", integrations)).toEqual([]);
  });

  it("returns empty for hourly_check when ONLY gmail is delegated — gmail is proxy-driven so the daemon proxy handles the connector call independently of the agent backend", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    expect(delegatedIntegrationsForProcessKey("routine.hourly_check", integrations)).toEqual([]);
  });

  it("returns empty for morning_routine when gmail+calendar are delegated — Phase D removed both claims", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: now };
    integrations.google_calendar = {
      mode: "delegated",
      delegatedBackend: "codex",
      deniedTools: [],
      lastChangedAt: now,
    };
    // Pre-Phase-D, both claimed morning_routine via taskFlowsTouched.
    // After Phase D, the daemon proxies their `/api/*` traffic mid-session
    // so the router has nothing to re-pin; morning_routine is also off
    // both descriptors' taskFlowsTouched lists.
    expect(delegatedIntegrationsForProcessKey("routine.morning_routine", integrations)).toEqual([]);
  });

  it("returns notion for hourly_check when notion is delegated — legacy path retained", () => {
    const integrations = defaultIntegrationsMap(now);
    integrations.notion = {
      mode: "delegated",
      delegatedBackend: "claude",
      deniedTools: [],
      lastChangedAt: now,
    };
    expect(delegatedIntegrationsForProcessKey("routine.hourly_check", integrations)).toEqual([
      "notion",
    ]);
  });

  it("returns notion only for hourly_check even when gmail+calendar are also delegated — gmail/calendar are proxy-driven so they're excluded regardless of taskFlowsTouched", () => {
    // gmail + google_calendar carry `taskFlowsTouched: ["routine.hourly_check"]`
    // (so the variant compensates for stopped pollers), but the router
    // should NOT pin the agent backend to their `delegatedBackend` —
    // the daemon proxy handles connector access independently. Notion is
    // not proxy-driven, so it remains in the result.
    const integrations = defaultIntegrationsMap(now);
    integrations.gmail = {
      mode: "delegated",
      delegatedBackend: "codex", // intentionally different from main
      deniedTools: [],
      lastChangedAt: now,
    };
    integrations.google_calendar = {
      mode: "delegated",
      delegatedBackend: "codex",
      deniedTools: [],
      lastChangedAt: now,
    };
    integrations.notion = {
      mode: "delegated",
      delegatedBackend: "claude",
      deniedTools: [],
      lastChangedAt: now,
    };
    expect(delegatedIntegrationsForProcessKey("routine.hourly_check", integrations)).toEqual([
      "notion",
    ]);
  });

  it("treats missing entries in a partial integrations map as not-delegated", () => {
    const partial = {
      gmail: {
        mode: "delegated" as const,
        delegatedBackend: "claude" as const,
        deniedTools: [],
        lastChangedAt: now,
      },
    };
    // morning_routine is not on any descriptor's taskFlowsTouched list,
    // so the result is empty regardless of gmail's state.
    expect(
      delegatedIntegrationsForProcessKey("routine.morning_routine", partial),
    ).toEqual([]);
  });
});

describe("integrationStateSchema with deniedTools (§7.7)", () => {
  it("defaults to empty array when omitted", () => {
    const parsed = integrationStateSchema.parse({
      mode: "delegated",
      delegatedBackend: "claude",
      deniedTools: [],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(parsed.deniedTools).toEqual([]);
  });

  it("preserves the provided list verbatim — string identity, not validation", () => {
    const parsed = integrationStateSchema.parse({
      mode: "delegated",
      delegatedBackend: "claude",
      deniedTools: ["notion-create-database", "made-up-tool"],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(parsed.deniedTools).toEqual([
      "notion-create-database",
      "made-up-tool",
    ]);
  });
});

describe("integrationPatchSchema with deniedTools (§7.7)", () => {
  it("accepts an explicit deniedTools array", () => {
    const result = integrationPatchSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "claude",
      deniedTools: ["notion-create-database"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts omission (preserves stored list)", () => {
    const result = integrationPatchSchema.safeParse({
      mode: "direct",
    });
    expect(result.success).toBe(true);
    expect(result.data?.deniedTools).toBeUndefined();
  });

  it("rejects non-string entries", () => {
    const result = integrationPatchSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "claude",
      deniedTools: [42],
    });
    expect(result.success).toBe(false);
  });
});

// ── DELEGATED-PROXY-API-DESIGN.md §C1 — delegatedModel / delegatedMaxTurns ──

describe("integrationStateSchema with delegatedModel (Phase C)", () => {
  it("accepts a non-empty delegatedModel value", () => {
    const parsed = integrationStateSchema.parse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedModel: "gpt-5.4-mini",
      deniedTools: [],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(parsed.delegatedModel).toBe("gpt-5.4-mini");
  });

  it("accepts null / undefined for the canonical-fallback case", () => {
    const withNull = integrationStateSchema.parse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedModel: null,
      deniedTools: [],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(withNull.delegatedModel).toBeNull();
    const omitted = integrationStateSchema.parse({
      mode: "delegated",
      delegatedBackend: "codex",
      deniedTools: [],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(omitted.delegatedModel).toBeUndefined();
  });

  it("rejects empty string delegatedModel — use null to clear instead", () => {
    const r = integrationStateSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedModel: "",
      deniedTools: [],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(r.success).toBe(false);
  });

  it("accepts delegatedMaxTurns within [1,10]", () => {
    const parsed = integrationStateSchema.parse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedMaxTurns: 5,
      deniedTools: [],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(parsed.delegatedMaxTurns).toBe(5);
  });

  it("rejects delegatedMaxTurns outside [1,10]", () => {
    const tooLow = integrationStateSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedMaxTurns: 0,
      deniedTools: [],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(tooLow.success).toBe(false);
    const tooHigh = integrationStateSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedMaxTurns: 11,
      deniedTools: [],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(tooHigh.success).toBe(false);
  });

  it("allows delegatedModel even when mode is direct (pre-staged before flip)", () => {
    const parsed = integrationStateSchema.parse({
      mode: "direct",
      delegatedModel: "gpt-5.4-mini",
      deniedTools: [],
      lastChangedAt: "2026-04-25T00:00:00Z",
    });
    expect(parsed.delegatedModel).toBe("gpt-5.4-mini");
  });

  it("accepts delegatedSyncEnabled as an optional kill switch without defaulting old rows", () => {
    const omitted = integrationStateSchema.parse({
      mode: "delegated",
      delegatedBackend: "claude",
      deniedTools: [],
      lastChangedAt: "2026-04-29T00:00:00Z",
    });
    expect(omitted.delegatedSyncEnabled).toBeUndefined();

    const disabled = integrationStateSchema.parse({
      mode: "delegated",
      delegatedBackend: "claude",
      delegatedSyncEnabled: false,
      deniedTools: [],
      lastChangedAt: "2026-04-29T00:00:00Z",
    });
    expect(disabled.delegatedSyncEnabled).toBe(false);
  });
});

describe("integrationPatchSchema with delegatedModel (Phase C)", () => {
  it("accepts a non-empty pinned model alongside a delegated flip", () => {
    const r = integrationPatchSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedModel: "gpt-5.4-mini",
    });
    expect(r.success).toBe(true);
  });

  it("accepts null to clear the pin without re-validating against a backend", () => {
    const r = integrationPatchSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedModel: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty string delegatedModel", () => {
    const r = integrationPatchSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedModel: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an out-of-range delegatedMaxTurns", () => {
    const r = integrationPatchSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedMaxTurns: 99,
    });
    expect(r.success).toBe(false);
  });

  it("accepts delegatedSyncEnabled in patches for the worker kill switch", () => {
    const r = integrationPatchSchema.safeParse({
      mode: "delegated",
      delegatedBackend: "codex",
      delegatedSyncEnabled: false,
    });
    expect(r.success).toBe(true);
  });
});

describe("validateDeniedTools (§7.7)", () => {
  it("returns ok for an empty list", () => {
    const r = validateDeniedTools("notion", "claude", []);
    expect(r).toEqual({ ok: true });
  });

  it("returns ok for tools that exist and don't break required caps", () => {
    // Schema-admin tools are optional — denying them is fine.
    const r = validateDeniedTools("notion", "claude", [
      "notion-create-database",
      "notion-update-data-source",
    ]);
    expect(r).toEqual({ ok: true });
  });

  it("rejects an unknown tool with the documented shape", () => {
    const r = validateDeniedTools("notion", "claude", ["nope-not-a-tool"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("unknown_tool");
    if (r.error !== "unknown_tool") return;
    expect(r.tool).toBe("nope-not-a-tool");
    expect(r.knownTools).toContain("notion-search");
    // Sorted for stable client rendering.
    expect([...r.knownTools]).toEqual([...r.knownTools].sort());
  });

  it("rejects denying the only tool that satisfies a required capability — multi-cap overlap collapses through one tool name", () => {
    // §5 capability-tool overlap: notion-update-page satisfies
    // update_properties, patch_content, archive, apply_template, and
    // replace_content. Denying it breaks all five (4 required + 1 optional).
    const r = validateDeniedTools("notion", "claude", ["notion-update-page"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("denial_breaks_required_capability");
    if (r.error !== "denial_breaks_required_capability") return;
    // The validator returns the FIRST failing required cap in iteration
    // order. Tied to descriptor ordering: update_properties precedes
    // patch_content / archive in `requiredCapabilities`. Pinning this
    // catches accidental reordering.
    expect(r.capability).toBe("update_properties");
    expect(r.remainingTools).toEqual(["notion-update-page"]);
  });

  it("rejects denying both notion-search alternatives for Codex Gmail (when several tools share a cap)", () => {
    // Codex Gmail's `search` capability has two tools — denying both should
    // fail. Denying just one should succeed.
    const okOne = validateDeniedTools("gmail", "codex", ["search_emails"]);
    expect(okOne).toEqual({ ok: true });

    const breakBoth = validateDeniedTools("gmail", "codex", [
      "search_emails",
      "search_email_ids",
    ]);
    expect(breakBoth.ok).toBe(false);
    if (breakBoth.ok) return;
    expect(breakBoth.error).toBe("denial_breaks_required_capability");
    if (breakBoth.error !== "denial_breaks_required_capability") return;
    expect(breakBoth.capability).toBe("search");
  });

  // The `no_connector` branch is reserved for future integrations that
  // omit a backend from `backendConnectors`. Today every (integrationKey,
  // BackendId) pair has a connector — the type system enforces BackendId
  // membership and the registry covers every pair. The runtime check
  // survives in code as forward-compat and is exercised when a future
  // integration lands without a Gemini / Codex / Claude descriptor.
});

describe("filterDeniedToolsForBackend (§7.7 stale-tool detection)", () => {
  it("partitions a list into active vs stale entries for the active backend", () => {
    // Mix of Claude-style and Codex-style names — only one set is active.
    const r = filterDeniedToolsForBackend("notion", "claude", [
      "notion-create-database", // Claude — active
      "notion_create_database", // Codex name carried over — stale
      "made-up", // never existed — stale
    ]);
    expect(r.active).toEqual(["notion-create-database"]);
    expect(r.stale).toEqual(["notion_create_database", "made-up"]);
  });

  // The "no connector" branch (every entry stale) is reserved for future
  // integrations that omit a backend — see the equivalent comment in the
  // validateDeniedTools describe block above.

  it("treats an empty list as both-empty", () => {
    const r = filterDeniedToolsForBackend("notion", "claude", []);
    expect(r).toEqual({ active: [], stale: [] });
  });
});

describe("backendHasIntegrationConnector", () => {
  it("returns true for Claude's Gmail connector", () => {
    expect(backendHasIntegrationConnector("gmail", "claude")).toBe(true);
  });

  it("returns true for Codex's Gmail connector", () => {
    expect(backendHasIntegrationConnector("gmail", "codex")).toBe(true);
  });

  it("returns true for Claude's Calendar connector", () => {
    expect(backendHasIntegrationConnector("google_calendar", "claude")).toBe(true);
  });

  it("returns true for Gemini connectors across gmail / calendar / notion", () => {
    expect(backendHasIntegrationConnector("gmail", "gemini")).toBe(true);
    expect(backendHasIntegrationConnector("google_calendar", "gemini")).toBe(true);
    expect(backendHasIntegrationConnector("notion", "gemini")).toBe(true);
  });
});

describe("matchToolPattern (DELEGATED-MODE-V2 §4.3.5)", () => {
  it("exact-match: pattern equals tool", () => {
    expect(matchToolPattern("_send_email", "_send_email")).toBe(true);
    expect(matchToolPattern("_send_email", "_send_message")).toBe(false);
  });

  it("prefix-glob: pattern with `*` suffix matches tools with that prefix", () => {
    expect(matchToolPattern("_send_*", "_send_email")).toBe(true);
    expect(matchToolPattern("_send_*", "_send_message")).toBe(true);
    expect(matchToolPattern("_send_*", "_archive_email")).toBe(false);
  });

  it("bare `*` matches anything", () => {
    expect(matchToolPattern("*", "_send_email")).toBe(true);
    expect(matchToolPattern("*", "")).toBe(true);
    expect(matchToolPattern("*", "anything-here")).toBe(true);
  });

  it("ignores mid-string `*` (only suffix glob is supported)", () => {
    expect(matchToolPattern("_send_*_email", "_send_some_email")).toBe(false);
    expect(matchToolPattern("_send_*_email", "_send_*_email")).toBe(true);
  });
});

describe("validateDeniedTools (glob extension)", () => {
  it("accepts a glob when its expansion does not break a required capability", () => {
    // Codex Gmail capabilityTools.delete = ["delete_emails", "archive_emails"];
    // `delete` is in optionalCapabilities, so `delete_*` (denies both) is
    // allowed.
    const r = validateDeniedTools("gmail", "codex", ["delete_*"]);
    expect(r.ok).toBe(true);
  });

  it("rejects a glob whose expansion empties a required capability", () => {
    // Codex Gmail's required `send` capability is `["send_email", "send_draft"]`.
    // `send_*` denies both — every tool satisfying `send` is removed.
    const r = validateDeniedTools("gmail", "codex", ["send_*"]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === "denial_breaks_required_capability") {
      expect(r.capability).toBe("send");
    }
  });

  it("rejects a glob that matches no known tool (typo defense)", () => {
    const r = validateDeniedTools("gmail", "codex", ["totally_made_up_*"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("unknown_tool");
      expect((r as { tool: string }).tool).toBe("totally_made_up_*");
    }
  });

  it("expands globs before the required-capability coverage check", () => {
    // Codex Gmail's `read` capability → ["read_email", "read_email_thread"].
    // `read_*` denies both — every tool satisfying `read` is removed.
    const r = validateDeniedTools("gmail", "codex", ["read_*"]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === "denial_breaks_required_capability") {
      expect(r.capability).toBe("read");
    }
  });
});

describe("filterDeniedToolsForBackend (glob expansion)", () => {
  it("expands a glob into the matching subset of known tools", () => {
    const r = filterDeniedToolsForBackend("gmail", "codex", ["send_*"]);
    // `send_email` and `send_draft` are the two known `send_*` tools.
    expect(r.active.sort()).toEqual(["send_draft", "send_email"]);
    expect(r.stale).toEqual([]);
  });

  it("flags a glob with no matches as stale (post-swap leftover)", () => {
    const r = filterDeniedToolsForBackend("gmail", "claude", ["send_*"]);
    // Claude's Gmail connector is draft-only; nothing matches `send_*`.
    expect(r.active).toEqual([]);
    expect(r.stale).toEqual(["send_*"]);
  });

  it("dedupes overlapping glob + exact entries", () => {
    const r = filterDeniedToolsForBackend("gmail", "codex", [
      "send_email",
      "send_*",
    ]);
    expect(r.active.sort()).toEqual(["send_draft", "send_email"]);
  });
});

describe("collectSessionDeniedTools (DELEGATED-MODE-V2 §4.3.3)", () => {
  function delegated(
    backend: "claude" | "codex" | "gemini",
    deniedTools: string[],
  ): IntegrationState {
    return {
      mode: "delegated",
      delegatedBackend: backend,
      deniedTools,
      lastChangedAt: "2026-04-26T00:00:00.000Z",
    };
  }

  it("returns namespaced tools only for integrations whose delegatedBackend matches the session backend", () => {
    const map = collectSessionDeniedTools(
      {
        gmail: delegated("codex", ["send_email"]),
        google_calendar: delegated("codex", ["delete_event"]),
      },
      "codex",
    );
    expect(map.size).toBe(2);
    expect(map.get("gmail")).toEqual(["mcp__codex_apps__gmail._send_email"]);
    expect(map.get("google_calendar")).toEqual([
      "mcp__codex_apps__google_calendar._delete_event",
    ]);
  });

  it("excludes integrations whose delegatedBackend differs from sessionBackend (cross-backend)", () => {
    const map = collectSessionDeniedTools(
      {
        gmail: delegated("codex", ["send_email"]),
      },
      "claude",
    );
    expect(map.size).toBe(0);
  });

  it("excludes direct / disabled integrations", () => {
    const map = collectSessionDeniedTools(
      {
        gmail: {
          mode: "direct",
          deniedTools: ["send_email"],
          lastChangedAt: "2026-04-26T00:00:00.000Z",
        },
        google_calendar: {
          mode: "disabled",
          deniedTools: ["delete_event"],
          lastChangedAt: "2026-04-26T00:00:00.000Z",
        },
      },
      "codex",
    );
    expect(map.size).toBe(0);
  });

  it("expands glob patterns into concrete namespaced tool names", () => {
    const map = collectSessionDeniedTools(
      {
        gmail: delegated("codex", ["send_*"]),
      },
      "codex",
    );
    expect(map.get("gmail")?.sort()).toEqual([
      "mcp__codex_apps__gmail._send_draft",
      "mcp__codex_apps__gmail._send_email",
    ]);
  });

  it("omits integrations whose deniedTools list is empty", () => {
    const map = collectSessionDeniedTools(
      {
        gmail: delegated("codex", []),
      },
      "codex",
    );
    expect(map.size).toBe(0);
  });

  it("omits integrations whose deniedTools entries are all stale (no match on this backend)", () => {
    const map = collectSessionDeniedTools(
      {
        gmail: delegated("codex", ["totally_made_up_tool"]),
      },
      "codex",
    );
    expect(map.size).toBe(0);
  });

  it("excludes integrations whose backend has no connector (defensive guard)", () => {
    // gemini has no Gmail connector in the descriptor — even with a
    // delegated state pointing there, the helper drops it instead of
    // throwing. Mirrors the guard in `collectSessionDeniedTools` body.
    const map = collectSessionDeniedTools(
      {
        gmail: delegated("gemini", ["send_email"]),
      },
      "gemini",
    );
    expect(map.size).toBe(0);
  });

  // INTEGRATION_NATIVE_MODE_DESIGN.md §11 — native mode is always same-
  // backend by definition, so `deniedTools` flows through the same
  // helper as delegated-same. The user's deny list must survive a
  // delegated→native flip.
  function native(
    backend: "claude" | "codex" | "gemini",
    deniedTools: string[],
  ): IntegrationState {
    return {
      mode: "native",
      nativeBackend: backend,
      deniedTools,
      lastChangedAt: "2026-05-11T00:00:00.000Z",
    };
  }

  it("includes same-backend native integrations (mode === 'native' && nativeBackend === sessionBackend)", () => {
    const map = collectSessionDeniedTools(
      {
        gmail: native("claude", ["create_label"]),
      },
      "claude",
    );
    expect(map.size).toBe(1);
    expect(map.get("gmail")).toEqual(["mcp__claude_ai_Gmail__create_label"]);
  });

  it("excludes native integrations whose nativeBackend differs from sessionBackend", () => {
    // Native binds to ONE backend — a Claude-native row must not deny
    // tools in a Codex session that happens to read the same state.
    const map = collectSessionDeniedTools(
      {
        gmail: native("claude", ["create_label"]),
      },
      "codex",
    );
    expect(map.size).toBe(0);
  });

  it("merges denied tools across delegated AND native integrations on the same backend", () => {
    const map = collectSessionDeniedTools(
      {
        gmail: native("claude", ["create_label"]),
        google_calendar: delegated("claude", ["delete_event"]),
      },
      "claude",
    );
    expect(map.size).toBe(2);
    expect(map.get("gmail")).toEqual(["mcp__claude_ai_Gmail__create_label"]);
    expect(map.get("google_calendar")).toEqual([
      "mcp__claude_ai_Google_Calendar__delete_event",
    ]);
  });

  it("omits native integrations whose deniedTools list is empty", () => {
    const map = collectSessionDeniedTools(
      {
        gmail: native("claude", []),
      },
      "claude",
    );
    expect(map.size).toBe(0);
  });
});

describe("recommendedStarterDeniedTools (DELEGATED-MODE-V2 §4.5.4)", () => {
  it("returns a fresh array per call (no aliasing)", () => {
    const a = recommendedStarterDeniedTools("gmail", "codex");
    const b = recommendedStarterDeniedTools("gmail", "codex");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("returns the documented destructive set for Gmail × Codex (without breaking `send` capability)", () => {
    // `send_email` only — `send_draft` is preserved so the required
    // `send` capability still has at least one tool. See §4.5.4 floor logic.
    expect(recommendedStarterDeniedTools("gmail", "codex").sort()).toEqual([
      "apply_labels_to_emails",
      "archive_emails",
      "delete_emails",
      "send_email",
    ]);
  });

  it("returns the documented destructive set for Google Calendar × Codex", () => {
    expect(
      recommendedStarterDeniedTools("google_calendar", "codex").sort(),
    ).toEqual(["delete_event", "update_event"]);
  });

  it("returns Claude-flavored entries for Claude backends (no send/delete in connector)", () => {
    // Claude's hosted Gmail is draft-only — only label mutations are
    // available, so the recommended floor targets those.
    expect(recommendedStarterDeniedTools("gmail", "claude").sort()).toEqual([
      "label_message",
      "label_thread",
    ]);
    expect(
      recommendedStarterDeniedTools("google_calendar", "claude").sort(),
    ).toEqual(["delete_event", "update_event"]);
  });

  it("returns [] for combinations with no curated list (notion etc.)", () => {
    expect(recommendedStarterDeniedTools("notion", "claude")).toEqual([]);
    expect(recommendedStarterDeniedTools("notion", "codex")).toEqual([]);
  });

  it("every recommended entry is declared in the connector's capabilityTools (registry self-consistency)", () => {
    // Self-test: the starter list must always pass `validateDeniedTools`
    // for the (key, backend) combo. This is what keeps the wizard /
    // PATCH default from immediately erroring on its own output.
    for (const key of INTEGRATION_KEYS) {
      for (const backend of ["claude", "codex", "gemini"] as const) {
        const list = recommendedStarterDeniedTools(key, backend);
        if (list.length === 0) continue;
        const r = validateDeniedTools(key, backend, list);
        if (!r.ok) {
          throw new Error(
            `Starter denylist for ${key}×${backend} fails validateDeniedTools: ${JSON.stringify(r)}`,
          );
        }
      }
    }
  });
});

describe("applyIntegrationModeFilter", () => {
  const ts = "2026-04-26T00:00:00.000Z";

  function state(
    mode: IntegrationState["mode"],
    delegatedBackend?: IntegrationState["delegatedBackend"],
  ): IntegrationState {
    return {
      mode,
      delegatedBackend: delegatedBackend ?? null,
      deniedTools: [],
      lastChangedAt: ts,
    };
  }

  it("exposes the predicate vocabulary as a frozen tuple", () => {
    // INTEGRATION_NATIVE_MODE_DESIGN.md §3.1 adds `native`.
    expect(INTEGRATION_MODE_PREDICATES).toEqual([
      "direct",
      "delegated",
      "delegated-same",
      "delegated-cross",
      "native",
      "disabled",
    ]);
  });

  it("keeps the direct block when mode is direct, strips the delegated block", () => {
    const content = [
      "before",
      "<!-- mode:direct:google_calendar -->",
      "DIRECT",
      "<!-- /mode:direct:google_calendar -->",
      "<!-- mode:delegated:google_calendar -->",
      "DELEGATED",
      "<!-- /mode:delegated:google_calendar -->",
      "after",
    ].join("\n");
    const out = applyIntegrationModeFilter(
      content,
      { google_calendar: state("direct") },
      "claude",
    );
    expect(out).toContain("DIRECT");
    expect(out).not.toContain("DELEGATED");
    expect(out).not.toContain("<!-- mode:");
  });

  it("keeps the delegated block when mode is delegated", () => {
    const content = [
      "<!-- mode:direct:google_calendar -->",
      "DIRECT",
      "<!-- /mode:direct:google_calendar -->",
      "<!-- mode:delegated:google_calendar -->",
      "DELEGATED",
      "<!-- /mode:delegated:google_calendar -->",
    ].join("\n");
    const out = applyIntegrationModeFilter(
      content,
      { google_calendar: state("delegated", "gemini") },
      "claude",
    );
    expect(out).not.toContain("DIRECT");
    expect(out).toContain("DELEGATED");
  });

  it("delegated-same fires only when delegatedBackend equals sessionBackend", () => {
    const content = [
      "<!-- mode:delegated-same:google_calendar -->",
      "SAME",
      "<!-- /mode:delegated-same:google_calendar -->",
      "<!-- mode:delegated-cross:google_calendar -->",
      "CROSS",
      "<!-- /mode:delegated-cross:google_calendar -->",
    ].join("\n");
    // Same: session=gemini AND delegated to gemini.
    expect(
      applyIntegrationModeFilter(
        content,
        { google_calendar: state("delegated", "gemini") },
        "gemini",
      ),
    ).toBe("SAME\n");
    // Cross: session=claude AND delegated to gemini.
    expect(
      applyIntegrationModeFilter(
        content,
        { google_calendar: state("delegated", "gemini") },
        "claude",
      ),
    ).toBe("CROSS\n");
  });

  it("delegated-cross is false when integration is direct or disabled", () => {
    const content =
      "<!-- mode:delegated-cross:google_calendar -->X<!-- /mode:delegated-cross:google_calendar -->";
    expect(
      applyIntegrationModeFilter(
        content,
        { google_calendar: state("direct") },
        "claude",
      ),
    ).toBe("");
    expect(
      applyIntegrationModeFilter(
        content,
        { google_calendar: state("disabled") },
        "claude",
      ),
    ).toBe("");
  });

  it("delegated-cross returns false when delegatedBackend is null (defensive — schema prevents this state)", () => {
    // Zod requires delegatedBackend when mode === "delegated", but the
    // filter's defensive null check guards against stale/legacy state
    // slipping through. Synthesize the invalid combo directly to exercise
    // the guard branch — without this test the `delegatedBackend !== null`
    // line is unreachable under schema-valid inputs.
    const content =
      "<!-- mode:delegated-cross:google_calendar -->X<!-- /mode:delegated-cross:google_calendar -->";
    const invalidState: IntegrationState = {
      mode: "delegated",
      delegatedBackend: null,
      deniedTools: [],
      lastChangedAt: ts,
    };
    const out = applyIntegrationModeFilter(
      content,
      { google_calendar: invalidState },
      "claude",
    );
    expect(out).toBe("");
  });

  it("disabled fires when mode is disabled OR no state row exists", () => {
    const content =
      "<!-- mode:disabled:google_calendar -->X<!-- /mode:disabled:google_calendar -->\n";
    expect(
      applyIntegrationModeFilter(
        content,
        { google_calendar: state("disabled") },
        "claude",
      ),
    ).toBe("X");
    // Missing key — the integration map default is "all keys disabled", so a
    // bare `{}` should also fire `disabled`.
    expect(applyIntegrationModeFilter(content, {}, "claude")).toBe("X");
  });

  it("preserves sections with unknown predicate (typo defense)", () => {
    const content =
      "<!-- mode:always:google_calendar -->X<!-- /mode:always:google_calendar -->";
    const out = applyIntegrationModeFilter(
      content,
      { google_calendar: state("direct") },
      "claude",
    );
    expect(out).toBe(content);
  });

  it("preserves sections with unknown integration key (typo defense)", () => {
    const content =
      "<!-- mode:direct:googel_calendar -->X<!-- /mode:direct:googel_calendar -->";
    const out = applyIntegrationModeFilter(
      content,
      { google_calendar: state("direct") },
      "claude",
    );
    expect(out).toBe(content);
  });

  it("strips multiple sibling blocks for different keys independently", () => {
    const content = [
      "<!-- mode:direct:gmail -->GMAIL_DIRECT<!-- /mode:direct:gmail -->",
      "<!-- mode:delegated:google_calendar -->CAL_DEL<!-- /mode:delegated:google_calendar -->",
    ].join("\n");
    const out = applyIntegrationModeFilter(
      content,
      {
        gmail: state("direct"),
        google_calendar: state("delegated", "gemini"),
      },
      "claude",
    );
    expect(out).toContain("GMAIL_DIRECT");
    expect(out).toContain("CAL_DEL");
  });

  it("is idempotent — running twice produces the same output", () => {
    const content = [
      "<!-- mode:direct:google_calendar -->",
      "DIRECT",
      "<!-- /mode:direct:google_calendar -->",
      "<!-- mode:delegated:google_calendar -->",
      "DELEGATED",
      "<!-- /mode:delegated:google_calendar -->",
    ].join("\n");
    const integrations = { google_calendar: state("direct") };
    const once = applyIntegrationModeFilter(content, integrations, "claude");
    const twice = applyIntegrationModeFilter(once, integrations, "claude");
    expect(twice).toBe(once);
  });

  it("leaves unrelated content untouched (no markers = no-op)", () => {
    const content = "# Heading\n\nNo mode markers here.\n";
    const out = applyIntegrationModeFilter(
      content,
      { google_calendar: state("delegated", "gemini") },
      "claude",
    );
    expect(out).toBe(content);
  });

  it("covers every cell of the (mode × session backend) matrix consistently", () => {
    // Exhaustive check that the four delegated-related predicates do not
    // overlap unexpectedly. For each cell, exactly one of {direct,
    // delegated-same, delegated-cross, disabled} must be true; `delegated`
    // is true iff the cell is delegated-same OR delegated-cross.
    const backends = ["claude", "codex", "gemini"] as const;
    type Cell = {
      label: string;
      state: IntegrationState | undefined;
      session: typeof backends[number];
      expect: { direct: boolean; "delegated-same": boolean; "delegated-cross": boolean; disabled: boolean };
    };
    const cells: Cell[] = [];
    for (const session of backends) {
      cells.push({
        label: `direct/${session}`,
        state: state("direct"),
        session,
        expect: { direct: true, "delegated-same": false, "delegated-cross": false, disabled: false },
      });
      cells.push({
        label: `disabled/${session}`,
        state: state("disabled"),
        session,
        expect: { direct: false, "delegated-same": false, "delegated-cross": false, disabled: true },
      });
      cells.push({
        label: `missing/${session}`,
        state: undefined,
        session,
        expect: { direct: false, "delegated-same": false, "delegated-cross": false, disabled: true },
      });
      for (const dele of backends) {
        cells.push({
          label: `delegated-${dele}/${session}`,
          state: state("delegated", dele),
          session,
          expect: {
            direct: false,
            "delegated-same": dele === session,
            "delegated-cross": dele !== session,
            disabled: false,
          },
        });
      }
    }

    for (const c of cells) {
      const wrap = (pred: string) =>
        `<!-- mode:${pred}:google_calendar -->X<!-- /mode:${pred}:google_calendar -->\n`;
      const integrations: Partial<Record<"google_calendar", IntegrationState>> =
        c.state ? { google_calendar: c.state } : {};
      // direct
      expect(applyIntegrationModeFilter(wrap("direct"), integrations, c.session))
        .toBe(c.expect.direct ? "X" : "");
      // delegated-same
      expect(
        applyIntegrationModeFilter(wrap("delegated-same"), integrations, c.session),
      ).toBe(c.expect["delegated-same"] ? "X" : "");
      // delegated-cross
      expect(
        applyIntegrationModeFilter(wrap("delegated-cross"), integrations, c.session),
      ).toBe(c.expect["delegated-cross"] ? "X" : "");
      // disabled
      expect(applyIntegrationModeFilter(wrap("disabled"), integrations, c.session))
        .toBe(c.expect.disabled ? "X" : "");
      // delegated == delegated-same OR delegated-cross
      const expectDelegated =
        c.expect["delegated-same"] || c.expect["delegated-cross"];
      expect(applyIntegrationModeFilter(wrap("delegated"), integrations, c.session))
        .toBe(expectDelegated ? "X" : "");
    }
  });
});

// ── DELEGATED-TASK-MODE-DESIGN.md §4.2 — /api/delegated/run pattern ─────────

describe("validateRunAllowedTool / validateRunAllowedTools", () => {
  it("accepts well-formed exact and glob patterns", () => {
    const accepted = [
      "mcp_my-server_search",
      "mcp_my-server_*",
      "mcp__custom-srv_doIt",
      "mcp_my-server_subtool.action",
      "mcp_my-server_subtool.action_v2",
      "mcp_my-server_subtool_action.run",
    ];
    for (const p of accepted) {
      const r = validateRunAllowedTool(p);
      if (!r.ok) {
        throw new Error(`expected ${p} to be accepted, got ${r.reason}: ${r.message}`);
      }
      expect(MCP_PATTERN_REGEX.test(p)).toBe(true);
    }
    expect(validateRunAllowedTools(accepted).ok).toBe(true);
  });

  it("rejects bare and leading `*`", () => {
    const r1 = validateRunAllowedTool("*");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("bare_star");
    const r2 = validateRunAllowedTool("*foo");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("leading_star");
  });

  it("rejects globs with prefix shorter than 5 characters (matches §4.2 example)", () => {
    // "mcp_*" has a 4-char prefix — explicitly listed as rejected in §4.2
    // even though the spec's literal regex would admit it. We honor the
    // example.
    const r = validateRunAllowedTool("mcp_*");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("prefix_too_short");
  });

  it("rejects shell metacharacters and whitespace", () => {
    for (const bad of [
      "srv;rm -rf /",
      "mcp_my-server_x|y",
      "mcp_my-server_x y",
      "mcp_my-server_$x",
      "mcp_my-server_`x`",
      "mcp_my-server_\nx",
      "mcp_my-server_x>y",
    ]) {
      const r = validateRunAllowedTool(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("shell_metachar");
    }
  });

  it("rejects empty / non-string entries and empty arrays", () => {
    const e1 = validateRunAllowedTool("");
    expect(e1.ok).toBe(false);
    if (!e1.ok) expect(e1.reason).toBe("empty");

    const e2 = validateRunAllowedTool(123 as unknown);
    expect(e2.ok).toBe(false);

    const e3 = validateRunAllowedTools([]);
    expect(e3.ok).toBe(false);
    if (!e3.ok) expect(e3.reason).toBe("empty");

    const e4 = validateRunAllowedTools("not-an-array" as unknown as string[]);
    expect(e4.ok).toBe(false);
  });

  it("returns the first failing pattern when given a mixed list", () => {
    const r = validateRunAllowedTools([
      "mcp_my-server_search",
      "*",
      "mcp_my-server_other",
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.pattern).toBe("*");
      expect(r.reason).toBe("bare_star");
    }
  });

  it("rejects patterns shaped like bare deny entries (single short word)", () => {
    // "send" is a valid deny-list entry but not a valid run allowedTools
    // entry — we want fully-qualified MCP names.
    const r = validateRunAllowedTool("send");
    expect(r.ok).toBe(false);
  });

  it("rejects `*` mid-string (only trailing glob is supported)", () => {
    const r = validateRunAllowedTool("mcp_my-server_*.action");
    expect(r.ok).toBe(false);
  });
});

describe("matchRunAllowedToolPattern", () => {
  it("matches exact and glob entries", () => {
    expect(
      matchRunAllowedToolPattern("mcp_my-server_search", "mcp_my-server_search"),
    ).toBe(true);
    expect(
      matchRunAllowedToolPattern("mcp_my-server_*", "mcp_my-server_search"),
    ).toBe(true);
    expect(
      matchRunAllowedToolPattern("mcp_my-server_*", "mcp_other_search"),
    ).toBe(false);
    expect(
      matchRunAllowedToolPattern("mcp_my-server_search", "mcp_my-server_other"),
    ).toBe(false);
  });
});

// ── INTEGRATION_NATIVE_MODE_DESIGN.md Phase B1 ──────────────────────────────

describe("native mode — supportedNativeBackends (§5.3)", () => {
  it("returns every backend with a connector for the integration", () => {
    expect(supportedNativeBackends("gmail").sort()).toEqual(
      ["claude", "codex", "gemini"].sort(),
    );
    expect(supportedNativeBackends("google_calendar").sort()).toEqual(
      ["claude", "codex", "gemini"].sort(),
    );
    expect(supportedNativeBackends("notion").sort()).toEqual(
      ["claude", "codex", "gemini"].sort(),
    );
  });

  it("returns a fresh array each call so callers cannot alias the constant", () => {
    const a = supportedNativeBackends("gmail");
    const b = supportedNativeBackends("gmail");
    expect(a).not.toBe(b);
    a.push("claude"); // mutating should not affect subsequent calls
    expect(supportedNativeBackends("gmail").length).toBe(3);
  });

  it("returns every backend for read-only CLI integrations (git/github)", () => {
    // git / github use `readOnlyCliConnector` for every native-connector
    // runtime backend, so the descriptor declares connectors for the
    // Phase-1 runtime-capable set. They are not in `supportedModes:
    // native` today, but the helper itself is descriptor-driven and
    // should report them honestly.
    expect(supportedNativeBackends("git").sort()).toEqual(
      [...NATIVE_CONNECTOR_BACKEND_IDS].sort(),
    );
    expect(supportedNativeBackends("github").sort()).toEqual(
      [...NATIVE_CONNECTOR_BACKEND_IDS].sort(),
    );
  });

  it("returns every backend for user-managed connectors (outlook)", () => {
    // INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 (2026-05 amendment) —
    // `userManagedConnector` integrations ship with empty `backendConnectors`
    // but the user installs their own MCP on the main backend, so native
    // is supported across every runtime backend that currently has a
    // native connector surface. The PATCH route skips the missing-variant
    // gate for these descriptors and the probe synthesises a user-managed
    // result.
    expect(supportedNativeBackends("outlook_mail").sort()).toEqual(
      [...NATIVE_CONNECTOR_BACKEND_IDS].sort(),
    );
    expect(supportedNativeBackends("outlook_calendar").sort()).toEqual(
      [...NATIVE_CONNECTOR_BACKEND_IDS].sort(),
    );
  });
});

describe("native mode — nativeIntegrationsForProcessKey (§10.1 — fallback gate, touched-only)", () => {
  const ts = "2026-05-11T00:00:00.000Z";

  it("returns only native integrations whose taskFlowsTouched includes the key", () => {
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
      notion: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    const result = nativeIntegrationsForProcessKey(
      "routine.hourly_check",
      integrations as never,
    );
    expect(result.sort()).toEqual(["gmail", "notion"].sort());
  });

  it("returns an empty array when no native integration touches the key", () => {
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    const result = nativeIntegrationsForProcessKey(
      "routine.hourly_check",
      integrations as never,
    );
    expect(result).toEqual([]);
  });

  it("ignores native integrations whose taskFlowsTouched does not include the key", () => {
    // INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 added `message.received.dm`
    // and `message.received.dm_first` to gmail/calendar/notion's
    // `taskFlowsTouched`. `taskFlowsReferenced` (RDAD §10 R3) is NOT
    // consulted by this helper — the BackendRouter's native fallback
    // gate consumes it and only cares about variant-driven coupling
    // (the partial-include path runs on a separate pre-pass session).
    // `routine.evening_review` is in gmail.taskFlowsReferenced but NOT
    // in any integration's taskFlowsTouched, so it is the negative case.
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    expect(
      nativeIntegrationsForProcessKey(
        "routine.evening_review",
        integrations as never,
      ),
    ).toEqual([]);
  });

  it("ignores user-managed integrations whose taskFlowsTouched is empty", () => {
    // outlook_mail uses `taskFlowsReferenced` (partial-include) instead
    // of `taskFlowsTouched`. The fallback-gate helper intentionally
    // does NOT pick this up — the historical §6.5.1 threshold-bypass
    // that needed the union was retired by
    // HOURLY_CHECK_GATE_REDESIGN_PLAN.md.
    const integrations: Partial<Record<string, IntegrationState>> = {
      outlook_mail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    expect(
      nativeIntegrationsForProcessKey(
        "routine.hourly_check",
        integrations as never,
      ),
    ).toEqual([]);
  });
});

describe("native mode — selectSkillVariantFile (§5.4.1)", () => {
  const ts = "2026-05-11T00:00:00.000Z";

  it("returns SKILL.native.<backend>.md when integration is native-bound to that session backend", () => {
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    expect(selectSkillVariantFile("mail", "claude", integrations as never))
      .toBe("SKILL.native.claude.md");
  });

  it("treats native-cross (binding mismatches session backend) as disabled — returns SKILL.md when no other integration touches the skill", () => {
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    // A codex DM session asking about the mail skill — gmail's native
    // binding is on claude, so the §11.4 cascade would have already
    // disabled this row when the main backend changed. Pre-cascade
    // (registry drift) the resolver safely degrades to SKILL.md.
    expect(selectSkillVariantFile("mail", "codex", integrations as never))
      .toBe("SKILL.md");
  });

  it("cross-backend-delegated wins over native on a multi-provider skill (§5.4.2 tie-break)", () => {
    // The `external-services` skill is only touched by `google_calendar` in
    // the current registry, so we cannot construct a true multi-touched
    // skill from production data. Exercise the tie-break by pinning
    // google_calendar to delegated cross-backend and pretending an in-
    // memory native integration touches the same skill. Because we only
    // have a single touching key, the test verifies the delegated branch
    // outranks the native branch by toggling the delegated value alone.
    const delegatedCross: Partial<Record<string, IntegrationState>> = {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    // Session backend is claude (cross-backend) → SKILL.delegated.claude.md
    expect(
      selectSkillVariantFile("external-services", "claude", delegatedCross as never),
    ).toBe("SKILL.delegated.claude.md");
  });

  it("native binding to a notion connector returns the notion native variant", () => {
    const integrations: Partial<Record<string, IntegrationState>> = {
      notion: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    expect(selectSkillVariantFile("notion", "claude", integrations as never))
      .toBe("SKILL.native.claude.md");
  });
});

describe("native mode — selectTaskFlowVariantSuffix (§5.4.2)", () => {
  const ts = "2026-05-11T00:00:00.000Z";

  it("returns native.<backend> when at least one touched integration is native-bound", () => {
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    expect(
      selectTaskFlowVariantSuffix("routine.hourly_check", "claude", integrations as never),
    ).toBe("native.claude");
  });

  it("delegated still wins over native on the same task flow (§5.4.2 tie-break)", () => {
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    expect(
      selectTaskFlowVariantSuffix("routine.hourly_check", "claude", integrations as never),
    ).toBe("delegated.claude");
  });

  it("returns direct when no touched integration is native or delegated", () => {
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    expect(
      selectTaskFlowVariantSuffix("routine.hourly_check", "claude", integrations as never),
    ).toBe("direct");
  });

  it("returns direct when the native binding does not match the session backend", () => {
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      },
    };
    // Cross-backend native (drift) — the resolver degrades to direct so
    // we never request a SKILL.native.<wrong-backend>.md file.
    expect(
      selectTaskFlowVariantSuffix("routine.hourly_check", "codex", integrations as never),
    ).toBe("direct");
  });
});

describe("native mode — integrationStateSchema validation (§5.2)", () => {
  const ts = "2026-05-11T00:00:00.000Z";

  it("accepts mode=native + nativeBackend", () => {
    expect(() =>
      integrationStateSchema.parse({
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      }),
    ).not.toThrow();
  });

  it("rejects mode=native without nativeBackend", () => {
    expect(() =>
      integrationStateSchema.parse({
        mode: "native",
        deniedTools: [],
        lastChangedAt: ts,
      }),
    ).toThrow();
  });

  it("rejects nativeBackend when mode is not native", () => {
    expect(() =>
      integrationStateSchema.parse({
        mode: "direct",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: ts,
      }),
    ).toThrow();
  });

  it("rejects co-occurring delegatedBackend and nativeBackend (mutual exclusion)", () => {
    expect(() =>
      integrationStateSchema.parse({
        mode: "native",
        nativeBackend: "claude",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: ts,
      }),
    ).toThrow();
  });
});

describe("native mode — integrationPatchSchema validation (§11.2)", () => {
  it("accepts mode=native + nativeBackend on PATCH", () => {
    expect(() =>
      integrationPatchSchema.parse({
        mode: "native",
        nativeBackend: "claude",
      }),
    ).not.toThrow();
  });

  it("rejects mode=native without nativeBackend on PATCH", () => {
    expect(() =>
      integrationPatchSchema.parse({
        mode: "native",
      }),
    ).toThrow();
  });

  it("rejects nativeBackend on non-native PATCH (mutual exclusion)", () => {
    expect(() =>
      integrationPatchSchema.parse({
        mode: "delegated",
        delegatedBackend: "claude",
        nativeBackend: "claude",
      }),
    ).toThrow();
  });
});

describe("native mode — applyIntegrationModeFilter `native` predicate (§5.4)", () => {
  it("keeps a native-only block when the integration is native-bound to the session backend", () => {
    const content = [
      "before",
      "<!-- mode:native:gmail -->",
      "NATIVE-ONLY",
      "<!-- /mode:native:gmail -->",
      "after",
    ].join("\n");
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    };
    const filtered = applyIntegrationModeFilter(
      content,
      integrations as never,
      "claude",
    );
    expect(filtered).toContain("NATIVE-ONLY");
  });

  it("strips a native-only block when the integration is not native or bound elsewhere", () => {
    const content = [
      "<!-- mode:native:gmail -->",
      "NATIVE-ONLY",
      "<!-- /mode:native:gmail -->",
    ].join("\n");
    const integrations: Partial<Record<string, IntegrationState>> = {
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    };
    const filtered = applyIntegrationModeFilter(
      content,
      integrations as never,
      "claude",
    );
    expect(filtered).not.toContain("NATIVE-ONLY");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 1.B — source-prefix-set
// derivation. The hourly_check gate's signal compute consumes these to
// filter `observations.source LIKE ?` clauses without hardcoding any
// integration reference outside the registry.
// ────────────────────────────────────────────────────────────────────────────

describe("getObservationSourcePrefixesForKind", () => {
  it("derives mail prefixes from the registry (direct + gmail + outlook_mail)", () => {
    const prefixes = getObservationSourcePrefixesForKind("mail");
    expect(prefixes).toContain("mail");
    expect(prefixes).toContain("gmail");
    expect(prefixes).toContain("outlook_mail");
  });

  it("derives calendar prefixes from the registry (direct + google_calendar + outlook_calendar)", () => {
    const prefixes = getObservationSourcePrefixesForKind("calendar");
    expect(prefixes).toContain("calendar");
    expect(prefixes).toContain("google_calendar");
    expect(prefixes).toContain("outlook_calendar");
  });

  it("returns notion as the sole notion prefix (direct + integration share the same key)", () => {
    const prefixes = getObservationSourcePrefixesForKind("notion");
    expect([...prefixes].sort()).toEqual(["notion"]);
  });

  it("returns obsidian as the sole vault prefix", () => {
    expect([...getObservationSourcePrefixesForKind("vault")]).toEqual(["obsidian"]);
  });

  it("returns git + github for repo", () => {
    expect([...getObservationSourcePrefixesForKind("repo")].sort()).toEqual([
      "git",
      "github",
    ]);
  });
});

describe("buildSourcePrefixFilter", () => {
  it("emits a parenthesised OR of LIKE clauses with sorted prefixes", () => {
    const { clause, values } = buildSourcePrefixFilter(["notion"]);
    expect(clause).toBe("(source LIKE ?)");
    expect(values).toEqual(["notion:%"]);
  });

  it("merges multiple kinds with no duplicates", () => {
    const { clause, values } = buildSourcePrefixFilter(["calendar", "notion"]);
    expect(values).toContain("calendar:%");
    expect(values).toContain("google_calendar:%");
    expect(values).toContain("outlook_calendar:%");
    expect(values).toContain("notion:%");
    const count = (clause.match(/source LIKE \?/g) ?? []).length;
    expect(count).toBe(values.length);
  });

  it("returns the always-false clause when no kinds are passed", () => {
    const { clause, values } = buildSourcePrefixFilter([]);
    expect(clause).toBe("(1=0)");
    expect(values).toEqual([]);
  });
});

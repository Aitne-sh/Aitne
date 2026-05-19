import { describe, it, expect } from "vitest";
import type { ConfigResponse, IntegrationListItem } from "@/lib/api-types";
import {
  availableDelegatedBackends,
  availableNativeBackends,
  buildFeatureMatrix,
  canFlipToNative,
  capabilityLabel,
  classifyModeSwitch,
  directCredentialsPresent,
  estimateCostPerCallUsd,
  formatPerCallUsd,
  formatRecentCallCost,
  formatRecentCallDuration,
  formatRecentCallTimestamp,
  modeIsAvailable,
  modeLabel,
  PROXY_CALL_TOKEN_ESTIMATE,
  PROXY_MODEL_AUTO_VALUE,
  shortenRecentCallTool,
  shouldShowReconfigureBanner,
  subTierLabel,
} from "./integration-card.logic";

// ── Fixtures ──

const gmailDescriptor: IntegrationListItem = {
  key: "gmail",
  displayName: "Gmail",
  supportedModes: ["direct", "delegated", "disabled"],
  directSetup: { credentialKeys: ["googleCredentialsJson"], helpUrl: "x" },
  backendConnectors: {
    claude: {
      toolNamespace: "mcp__claude_ai_Gmail__",
      requiredCapabilities: ["search", "read", "draft", "label"],
      optionalCapabilities: ["draft", "label", "create_label"],
      capabilityTools: {},
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
      capabilityTools: {},
    },
  },
  skillsTouched: ["mail"],
  taskFlowsTouched: ["routine.morning_routine"],
  observersTouched: [],
  apiRoutesTouched: [],
  state: { mode: "disabled", lastChangedAt: "2026-04-20T00:00:00Z" },
};

describe("capabilityLabel", () => {
  it.each([
    ["search", "Search"],
    ["send", "Send"],
    ["create_label", "Create labels"],
    ["list_events", "List events"],
    ["respond_to_event", "RSVP"],
    ["get_availability", "Check availability"],
  ])("humanizes known key %s to %s", (raw, expected) => {
    expect(capabilityLabel(raw)).toBe(expected);
  });

  it("falls back to Title Case for unknown keys (registry widening)", () => {
    expect(capabilityLabel("some_new_cap")).toBe("Some New Cap");
  });

  it("leaves single-word keys alone (humanizer still upper-cases first letter)", () => {
    expect(capabilityLabel("foo")).toBe("Foo");
  });
});

describe("modeLabel", () => {
  it("labels direct + disabled without a backend", () => {
    expect(modeLabel("direct", null)).toBe("Direct");
    expect(modeLabel("disabled", null)).toBe("Disabled");
  });

  it("includes backend for delegated", () => {
    expect(modeLabel("delegated", "claude")).toBe("Delegated — claude");
    expect(modeLabel("delegated", "codex")).toBe("Delegated — codex");
  });

  it("falls back to plain Delegated when backend missing (transient state)", () => {
    expect(modeLabel("delegated", null)).toBe("Delegated");
  });

  // INTEGRATION_NATIVE_MODE_DESIGN.md §11.5 — native gets its own pill so the
  // 4-state mode picker is glanceable. The backend is part of the label
  // because §3.3 binds native to a specific backend.
  it("includes backend for native", () => {
    expect(modeLabel("native", "claude")).toBe("Native — claude");
    expect(modeLabel("native", "gemini")).toBe("Native — gemini");
  });

  it("falls back to plain Native when backend missing (transient state)", () => {
    expect(modeLabel("native", null)).toBe("Native");
  });
});

describe("subTierLabel", () => {
  it("names draft-only and full-auto", () => {
    expect(subTierLabel("draft-only")).toBe("Draft-Only");
    expect(subTierLabel("full-auto")).toBe("Full-Auto");
  });

  it("returns null for non-gmail integrations (no sub-tier split)", () => {
    expect(subTierLabel(null)).toBeNull();
  });
});

describe("buildFeatureMatrix", () => {
  it("returns empty when features is null (direct mode)", () => {
    expect(buildFeatureMatrix(null, gmailDescriptor, "claude")).toEqual([]);
  });

  it("returns empty when backend is null", () => {
    expect(buildFeatureMatrix({ search: true }, gmailDescriptor, null)).toEqual(
      [],
    );
  });

  it("returns empty when registry does not list the chosen backend", () => {
    const narrow: IntegrationListItem = {
      ...gmailDescriptor,
      backendConnectors: {},
    };
    expect(buildFeatureMatrix({ search: true }, narrow, "claude")).toEqual([]);
  });

  it("sorts present-required ahead of present-optional, then missing", () => {
    // For Claude Gmail: required = [search,read,draft,label], optional adds [create_label].
    // Mark search+draft+create_label as present — the rest missing.
    const features = {
      search: true,
      read: false,
      draft: true,
      label: false,
      create_label: true,
    };
    const rows = buildFeatureMatrix(features, gmailDescriptor, "claude");
    const names = rows.map((r) => r.label);
    // present+required group first (alphabetical within): Drafts, Search
    // then present-optional: Create labels
    // then missing-required (alphabetical): Labels, Read
    // then missing-optional: — (none; all optionals are also in required)
    expect(names.slice(0, 2).sort()).toEqual(["Drafts", "Search"]);
    expect(names[2]).toBe("Create labels");
    expect(names.slice(3).sort()).toEqual(["Labels", "Read"]);
  });

  it("deduplicates capabilities that appear in both required and optional lists", () => {
    // Claude Gmail has `draft` and `label` in both required and optional.
    const features = { search: true, read: true, draft: true, label: true };
    const rows = buildFeatureMatrix(features, gmailDescriptor, "claude");
    const draftRows = rows.filter((r) => r.capability === "draft");
    expect(draftRows.length).toBe(1);
    expect(draftRows[0].required).toBe(true);
  });

  it("marks required capabilities correctly", () => {
    const rows = buildFeatureMatrix(
      { search: true, read: true, draft: true, label: true, create_label: true },
      gmailDescriptor,
      "claude",
    );
    const required = rows.filter((r) => r.required).map((r) => r.capability);
    expect(required.sort()).toEqual(["draft", "label", "read", "search"]);
  });
});

describe("availableDelegatedBackends + modeIsAvailable", () => {
  it("lists both backends for gmail", () => {
    expect(availableDelegatedBackends(gmailDescriptor).sort()).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("rejects delegated when no backend has a connector", () => {
    const orphan: IntegrationListItem = {
      ...gmailDescriptor,
      backendConnectors: {},
    };
    expect(modeIsAvailable(orphan, "delegated")).toBe(false);
  });

  it("allows direct / disabled regardless of connectors", () => {
    const orphan: IntegrationListItem = {
      ...gmailDescriptor,
      backendConnectors: {},
    };
    expect(modeIsAvailable(orphan, "direct")).toBe(true);
    expect(modeIsAvailable(orphan, "disabled")).toBe(true);
  });

  it("respects supportedModes (descriptor might ship without disabled)", () => {
    const narrow: IntegrationListItem = {
      ...gmailDescriptor,
      supportedModes: ["direct", "delegated"],
    };
    expect(modeIsAvailable(narrow, "disabled")).toBe(false);
    expect(modeIsAvailable(narrow, "direct")).toBe(true);
  });
});

describe("directCredentialsPresent", () => {
  // Per-integration flag mapping isn't a uniform `${key}Configured` pattern
  // — Google has two flags, Notion has one, Gmail piggy-backs on Calendar's
  // pair. Lock the mapping in so a future refactor that consolidates flag
  // names doesn't quietly break the dialog's "needs setup" branch.
  const config = (over: Partial<ConfigResponse> = {}): ConfigResponse =>
    ({
      googleCalendarCredentialsConfigured: false,
      googleCalendarTokenConfigured: false,
      notionConfigured: false,
      ...over,
    }) as ConfigResponse;

  it("returns false when config is undefined (initial render)", () => {
    expect(directCredentialsPresent("notion", undefined)).toBe(false);
    expect(directCredentialsPresent("gmail", undefined)).toBe(false);
  });

  it("notion → notionConfigured", () => {
    expect(
      directCredentialsPresent("notion", config({ notionConfigured: true })),
    ).toBe(true);
    expect(directCredentialsPresent("notion", config({}))).toBe(false);
  });

  it("notion does NOT read Google flags (regression: pre-fix bug used Google's pair for any key)", () => {
    const cfg = config({
      googleCalendarCredentialsConfigured: true,
      googleCalendarTokenConfigured: true,
      notionConfigured: false,
    });
    expect(directCredentialsPresent("notion", cfg)).toBe(false);
  });

  it("gmail / google_calendar require both Google flags", () => {
    const both = config({
      googleCalendarCredentialsConfigured: true,
      googleCalendarTokenConfigured: true,
    });
    expect(directCredentialsPresent("gmail", both)).toBe(true);
    expect(directCredentialsPresent("google_calendar", both)).toBe(true);

    const onlyCreds = config({
      googleCalendarCredentialsConfigured: true,
      googleCalendarTokenConfigured: false,
    });
    expect(directCredentialsPresent("gmail", onlyCreds)).toBe(false);
    expect(directCredentialsPresent("google_calendar", onlyCreds)).toBe(false);
  });

  it("outlook_mail / outlook_calendar read outlookClientConfigConfigured (SETUP-FLOW-REDESIGN-PLAN §6.1)", () => {
    const configured = {
      ...config({}),
      outlookClientConfigConfigured: true,
    } as ConfigResponse;
    expect(directCredentialsPresent("outlook_mail", configured)).toBe(true);
    expect(directCredentialsPresent("outlook_calendar", configured)).toBe(true);

    const missing = {
      ...config({}),
      outlookClientConfigConfigured: false,
    } as ConfigResponse;
    expect(directCredentialsPresent("outlook_mail", missing)).toBe(false);
    expect(directCredentialsPresent("outlook_calendar", missing)).toBe(false);
  });
});

describe("modeIsAvailable — Outlook descriptor regression (SETUP-FLOW-REDESIGN-PLAN §6.1)", () => {
  // Build a synthetic Outlook descriptor matching the registry shape:
  // supportedModes excludes `delegated` and backendConnectors is empty.
  const outlookCalendarDescriptor: IntegrationListItem = {
    ...gmailDescriptor,
    key: "outlook_calendar",
    displayName: "Outlook Calendar",
    supportedModes: ["direct", "disabled"],
    backendConnectors: {},
  };

  it("rejects delegated mode for Outlook because supportedModes excludes it", () => {
    expect(modeIsAvailable(outlookCalendarDescriptor, "delegated")).toBe(false);
  });

  it("allows direct and disabled for Outlook", () => {
    expect(modeIsAvailable(outlookCalendarDescriptor, "direct")).toBe(true);
    expect(modeIsAvailable(outlookCalendarDescriptor, "disabled")).toBe(true);
  });

  it("availableDelegatedBackends is empty when backendConnectors is empty (no Delegated radio shown)", () => {
    expect(availableDelegatedBackends(outlookCalendarDescriptor)).toEqual([]);
  });

  // docs/design/appendices/opencode-backend.md Phase 2 — `RUNTIME_AVAILABLE_BACKEND_IDS`
  // now includes opencode. For user-managed-connector integrations the
  // delegated picker mirrors the shared constant so the user can route a
  // delegated row to opencode once they wire the corresponding MCP on
  // that backend. NATIVE_CONNECTOR_BACKEND_IDS stays without opencode
  // (design §11) — see the matching `availableNativeBackends` test.
  it("availableDelegatedBackends for user-managed connectors mirrors RUNTIME_AVAILABLE_BACKEND_IDS (now includes opencode)", () => {
    const userManaged: IntegrationListItem = {
      ...outlookCalendarDescriptor,
      backendConnectors: {},
      userManagedConnector: true,
    };
    expect(availableDelegatedBackends(userManaged).sort()).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
  });
});

describe("classifyModeSwitch", () => {
  it("swallows exact same-mode same-backend flips", () => {
    expect(
      classifyModeSwitch(
        { mode: "delegated", backend: "claude", directCredentialsPresent: true },
        { toMode: "delegated", toBackend: "claude" },
      ),
    ).toEqual({ kind: "no-op" });
  });

  it("detects a delegated backend change as its own action", () => {
    expect(
      classifyModeSwitch(
        { mode: "delegated", backend: "claude", directCredentialsPresent: true },
        { toMode: "delegated", toBackend: "codex" },
      ),
    ).toEqual({ kind: "delegated-backend-change", toBackend: "codex" });
  });

  it("classifies direct→delegated", () => {
    expect(
      classifyModeSwitch(
        { mode: "direct", backend: null, directCredentialsPresent: true },
        { toMode: "delegated", toBackend: "claude" },
      ),
    ).toEqual({ kind: "direct-to-delegated", toBackend: "claude" });
  });

  it("refuses direct→delegated with no toBackend", () => {
    expect(() =>
      classifyModeSwitch(
        { mode: "direct", backend: null, directCredentialsPresent: true },
        { toMode: "delegated" },
      ),
    ).toThrow();
  });

  it("classifies delegated→direct with dormant tokens (no setup)", () => {
    expect(
      classifyModeSwitch(
        { mode: "delegated", backend: "claude", directCredentialsPresent: true },
        { toMode: "direct" },
      ),
    ).toEqual({ kind: "delegated-to-direct", needsOauthSetup: false });
  });

  it("classifies delegated→direct without tokens (OAuth flow required)", () => {
    expect(
      classifyModeSwitch(
        { mode: "delegated", backend: "claude", directCredentialsPresent: false },
        { toMode: "direct" },
      ),
    ).toEqual({ kind: "delegated-to-direct", needsOauthSetup: true });
  });

  it("classifies disabled→delegated", () => {
    expect(
      classifyModeSwitch(
        { mode: "disabled", backend: null, directCredentialsPresent: false },
        { toMode: "delegated", toBackend: "codex" },
      ),
    ).toEqual({ kind: "enable-from-disabled", to: "delegated", toBackend: "codex" });
  });

  it("classifies disabled→direct", () => {
    expect(
      classifyModeSwitch(
        { mode: "disabled", backend: null, directCredentialsPresent: true },
        { toMode: "direct" },
      ),
    ).toEqual({ kind: "enable-from-disabled", to: "direct" });
  });

  it("classifies any-active→disabled", () => {
    expect(
      classifyModeSwitch(
        { mode: "direct", backend: null, directCredentialsPresent: true },
        { toMode: "disabled" },
      ),
    ).toEqual({ kind: "disable-from-active" });

    expect(
      classifyModeSwitch(
        { mode: "delegated", backend: "codex", directCredentialsPresent: false },
        { toMode: "disabled" },
      ),
    ).toEqual({ kind: "disable-from-active" });
  });
});

// ── DELEGATED-PROXY-API-DESIGN.md §C2 — proxy-call cost estimation ─────────

describe("estimateCostPerCallUsd", () => {
  it("multiplies per-token rates by the §7 prompt-length estimate", () => {
    // Pin the math: $0.005/1k in × 800 + $0.025/1k out × 200 = $0.009.
    const usd = estimateCostPerCallUsd(0.005, 0.025);
    expect(usd).not.toBeNull();
    expect(usd!).toBeCloseTo(0.009, 6);
  });

  it("returns null when either price is null (registry has no pricing)", () => {
    expect(estimateCostPerCallUsd(null, 0.001)).toBeNull();
    expect(estimateCostPerCallUsd(0.001, null)).toBeNull();
    expect(estimateCostPerCallUsd(null, null)).toBeNull();
  });

  it("uses the §7 token estimate constants", () => {
    expect(PROXY_CALL_TOKEN_ESTIMATE.inputTokens).toBe(800);
    expect(PROXY_CALL_TOKEN_ESTIMATE.outputTokens).toBe(200);
  });
});

describe("formatPerCallUsd", () => {
  it("renders sub-cent values with 4 decimals", () => {
    expect(formatPerCallUsd(0.0042)).toBe("$0.0042");
  });
  it("renders >= 1c values with 3 decimals", () => {
    expect(formatPerCallUsd(0.012)).toBe("$0.012");
    expect(formatPerCallUsd(0.5)).toBe("$0.500");
  });
  it("returns the floor sentinel for tiny values", () => {
    expect(formatPerCallUsd(0.00001)).toBe("<$0.001");
  });
});

describe("PROXY_MODEL_AUTO_VALUE", () => {
  it("is distinct from any plausible model id", () => {
    // Sanity: the sentinel uses double underscores so it cannot collide
    // with a real Claude / Codex / Gemini model identifier.
    expect(PROXY_MODEL_AUTO_VALUE).toBe("__auto__");
    expect(PROXY_MODEL_AUTO_VALUE.includes("-")).toBe(false);
  });
});

// ── DELEGATED-PROXY-API-DESIGN.md §7 — Recent calls table formatters ──────

describe("formatRecentCallCost", () => {
  it("renders an em-dash when cost is null", () => {
    expect(formatRecentCallCost(null)).toBe("—");
  });
  it("renders $0 exactly for the zero-cost saturation rows", () => {
    expect(formatRecentCallCost(0)).toBe("$0");
  });
  it("renders the floor sentinel for tiny positive values", () => {
    expect(formatRecentCallCost(0.0005)).toBe("<$0.001");
  });
  it("renders sub-cent values with 4 decimals", () => {
    expect(formatRecentCallCost(0.0042)).toBe("$0.0042");
  });
  it("renders >= 1c values with 3 decimals", () => {
    expect(formatRecentCallCost(0.012)).toBe("$0.012");
  });
});

describe("formatRecentCallDuration", () => {
  it("renders ms below 1s", () => {
    expect(formatRecentCallDuration(250)).toBe("250ms");
  });
  it("renders seconds with 1 decimal at and above 1s", () => {
    expect(formatRecentCallDuration(1000)).toBe("1.0s");
    expect(formatRecentCallDuration(2750)).toBe("2.8s");
  });
  it("renders an em-dash when duration is null", () => {
    expect(formatRecentCallDuration(null)).toBe("—");
  });
});

describe("formatRecentCallTimestamp", () => {
  it("renders an em-dash when null", () => {
    expect(formatRecentCallTimestamp(null)).toBe("—");
  });
  it("falls through to raw input when the iso string is unparseable", () => {
    expect(formatRecentCallTimestamp("not a date")).toBe("not a date");
  });
  it("uses time-only formatting when the call is from today", () => {
    // Construct an ISO string for "today at 09:30" against an injected `now`,
    // so the same-day branch fires deterministically.
    const now = new Date("2026-04-25T20:00:00Z");
    const iso = "2026-04-25T09:30:00Z";
    const out = formatRecentCallTimestamp(iso, now);
    // Must not contain a date component (locale-dependent — assert it lacks
    // the year, which any locale's full timestamp would include).
    expect(out.includes("2026")).toBe(false);
  });
  it("includes a date component for older calls", () => {
    const now = new Date("2026-04-25T20:00:00Z");
    const iso = "2026-04-20T09:30:00Z";
    const out = formatRecentCallTimestamp(iso, now);
    expect(out.includes("2026")).toBe(true);
  });
});

describe("shortenRecentCallTool", () => {
  it("strips the namespace prefix from a Claude-shaped tool name", () => {
    expect(shortenRecentCallTool("mcp__claude_ai_Gmail__search_threads")).toBe(
      "search_threads",
    );
  });
  it("strips the double-underscore namespace prefix from a Codex-shaped tool name", () => {
    // Codex names use `__` between mcp/codex_apps/<service>, then a single
    // `.` before the leaf — so splitting on `__` lands the user-recognisable
    // service+leaf together. Acceptable: keeps the service hint (e.g. gmail)
    // alongside the action when the row's own backend column is codex.
    expect(
      shortenRecentCallTool("mcp__codex_apps__gmail._search_emails"),
    ).toBe("gmail._search_emails");
  });
  it("returns the original when the name has no namespace separator", () => {
    expect(shortenRecentCallTool("plain_tool")).toBe("plain_tool");
  });
  it("renders an em-dash when the name is null", () => {
    expect(shortenRecentCallTool(null)).toBe("—");
  });
});

// ── INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 / §11.1 — native-mode helpers ────

const gmailNativeDescriptor: IntegrationListItem = {
  ...gmailDescriptor,
  supportedModes: ["direct", "delegated", "native", "disabled"],
};

describe("availableNativeBackends", () => {
  it("lists every backend with a registry connector", () => {
    expect(availableNativeBackends(gmailNativeDescriptor).sort()).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("returns every backend for user-managed connectors", () => {
    // INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 (2026-05 amendment) — the
    // restriction "native requires a registry connector" was lifted for
    // `userManagedConnector` descriptors so users with their own MCP
    // harness on any backend can flip Outlook (etc.) to native. The list
    // is sourced from the shared `NATIVE_CONNECTOR_BACKEND_IDS`.
    //
    // docs/design/appendices/opencode-backend.md §11 — opencode is *permanently* excluded
    // from native-mode hosting (different protocol surface). This must
    // NOT widen when `RUNTIME_AVAILABLE_BACKEND_IDS` widens for opencode
    // in Phase 2 — the two constants intentionally diverge then.
    const userManaged: IntegrationListItem = {
      ...gmailNativeDescriptor,
      backendConnectors: {},
      userManagedConnector: true,
    };
    expect(availableNativeBackends(userManaged).sort()).toEqual([
      "claude",
      "codex",
      "gemini",
    ]);
    expect(availableNativeBackends(userManaged)).not.toContain("opencode");
  });

  it("returns empty when descriptor has no backendConnectors and is not user-managed", () => {
    const orphan: IntegrationListItem = {
      ...gmailNativeDescriptor,
      backendConnectors: {},
    };
    expect(availableNativeBackends(orphan)).toEqual([]);
  });
});

describe("canFlipToNative", () => {
  it("rejects when descriptor.supportedModes lacks 'native'", () => {
    expect(canFlipToNative(gmailDescriptor, "claude")).toBe(false);
  });

  it("rejects when main backend is null / undefined (no main backend chosen)", () => {
    expect(canFlipToNative(gmailNativeDescriptor, null)).toBe(false);
    expect(canFlipToNative(gmailNativeDescriptor, undefined)).toBe(false);
  });

  it("rejects when main backend has no registry connector", () => {
    // Gmail descriptor today has claude + codex but no gemini connector;
    // a Gemini main backend can't host native Gmail.
    expect(canFlipToNative(gmailNativeDescriptor, "gemini")).toBe(false);
  });

  it("accepts when main backend ships a connector and native is supported", () => {
    expect(canFlipToNative(gmailNativeDescriptor, "claude")).toBe(true);
    expect(canFlipToNative(gmailNativeDescriptor, "codex")).toBe(true);
  });

  it("accepts every backend for user-managed connectors when supportedModes includes 'native'", () => {
    // §5.3 (2026-05 amendment) — Outlook (`userManagedConnector: true`)
    // now declares `native` in `supportedModes`, and the helper returns
    // all three backends so the Native radio surfaces regardless of
    // which backend is main.
    const outlookLike: IntegrationListItem = {
      ...gmailNativeDescriptor,
      backendConnectors: {},
      userManagedConnector: true,
    };
    expect(canFlipToNative(outlookLike, "claude")).toBe(true);
    expect(canFlipToNative(outlookLike, "codex")).toBe(true);
    expect(canFlipToNative(outlookLike, "gemini")).toBe(true);
  });
});

describe("classifyModeSwitch — native paths (§11.3)", () => {
  it("classifies direct → native via 'to-native' with source fromMode", () => {
    expect(
      classifyModeSwitch(
        { mode: "direct", backend: null, directCredentialsPresent: true },
        { toMode: "native", toBackend: "claude" },
      ),
    ).toEqual({ kind: "to-native", fromMode: "direct", toBackend: "claude" });
  });

  it("classifies delegated → native via 'to-native' (with fromMode preserved)", () => {
    expect(
      classifyModeSwitch(
        { mode: "delegated", backend: "claude", directCredentialsPresent: false },
        { toMode: "native", toBackend: "claude" },
      ),
    ).toEqual({
      kind: "to-native",
      fromMode: "delegated",
      toBackend: "claude",
    });
  });

  it("classifies disabled → native (e.g. user re-binding after a main-backend cascade)", () => {
    expect(
      classifyModeSwitch(
        { mode: "disabled", backend: null, directCredentialsPresent: false },
        { toMode: "native", toBackend: "codex" },
      ),
    ).toEqual({ kind: "to-native", fromMode: "disabled", toBackend: "codex" });
  });

  it("throws when target is native but no backend is provided (caller bug)", () => {
    expect(() =>
      classifyModeSwitch(
        { mode: "direct", backend: null, directCredentialsPresent: true },
        { toMode: "native" },
      ),
    ).toThrow();
  });

  it("classifies native → direct with dormant credentials (no setup)", () => {
    expect(
      classifyModeSwitch(
        { mode: "native", backend: "claude", directCredentialsPresent: true },
        { toMode: "direct" },
      ),
    ).toEqual({ kind: "native-to-direct", needsOauthSetup: false });
  });

  it("classifies native → direct without credentials (must run OAuth setup)", () => {
    expect(
      classifyModeSwitch(
        { mode: "native", backend: "claude", directCredentialsPresent: false },
        { toMode: "direct" },
      ),
    ).toEqual({ kind: "native-to-direct", needsOauthSetup: true });
  });

  it("classifies native → delegated with backend, requiring a target backend", () => {
    expect(
      classifyModeSwitch(
        { mode: "native", backend: "claude", directCredentialsPresent: false },
        { toMode: "delegated", toBackend: "gemini" },
      ),
    ).toEqual({ kind: "native-to-delegated", toBackend: "gemini" });

    expect(() =>
      classifyModeSwitch(
        { mode: "native", backend: "claude", directCredentialsPresent: false },
        { toMode: "delegated" },
      ),
    ).toThrow();
  });

  it("classifies native → disabled", () => {
    expect(
      classifyModeSwitch(
        { mode: "native", backend: "claude", directCredentialsPresent: false },
        { toMode: "disabled" },
      ),
    ).toEqual({ kind: "native-to-disabled" });
  });

  it("swallows native → native as a no-op (rebind impossible by §3.3)", () => {
    expect(
      classifyModeSwitch(
        { mode: "native", backend: "claude", directCredentialsPresent: false },
        { toMode: "native", toBackend: "claude" },
      ),
    ).toEqual({ kind: "no-op" });
  });
});

// ── INTEGRATION_NATIVE_MODE_DESIGN.md §11.5 — reconfigure banner gate ──────

describe("shouldShowReconfigureBanner", () => {
  // Cascade: main-backend switch landed at 12:00:00 UTC.
  // Audit row uses SQLite `datetime('now')` shape (no `Z`, space separator).
  const cascadeStartedAt = "2026-05-11 12:00:00";
  // Row touched immediately by the cascade itself (same instant, JS ISO).
  const cascadeLastChanged = "2026-05-11T12:00:00.000Z";
  // Row touched 1 hour later — represents the user manually changing the
  // mode after the cascade.
  const userTouchedLater = "2026-05-11T13:00:00.000Z";

  it("hides when the user dismissed locally", () => {
    expect(
      shouldShowReconfigureBanner({
        mode: "disabled",
        unboundEntry: { startedAt: cascadeStartedAt },
        stateLastChangedAt: cascadeLastChanged,
        dismissedLocally: true,
      }),
    ).toBe(false);
  });

  it("hides when no cascade entry exists for this row", () => {
    expect(
      shouldShowReconfigureBanner({
        mode: "disabled",
        unboundEntry: undefined,
        stateLastChangedAt: cascadeLastChanged,
        dismissedLocally: false,
      }),
    ).toBe(false);
  });

  it("hides when the row has been re-bound (mode !== disabled)", () => {
    for (const mode of ["direct", "delegated", "native"] as const) {
      expect(
        shouldShowReconfigureBanner({
          mode,
          unboundEntry: { startedAt: cascadeStartedAt },
          stateLastChangedAt: userTouchedLater,
          dismissedLocally: false,
        }),
      ).toBe(false);
    }
  });

  it("shows when the cascade just landed and nothing else has been touched", () => {
    // lastChangedAt == cascade.startedAt → user has not interacted since.
    expect(
      shouldShowReconfigureBanner({
        mode: "disabled",
        unboundEntry: { startedAt: cascadeStartedAt },
        stateLastChangedAt: cascadeLastChanged,
        dismissedLocally: false,
      }),
    ).toBe(true);
  });

  it("HIDES when the user has touched the row after the cascade (manual re-disable case)", () => {
    // This is the regression the fix addresses: pre-fix the banner kept
    // appearing because `entry.mode === "disabled"` was the only mode
    // gate. A user who consciously re-disables after the cascade would
    // be pestered on every page reload (Dismiss is local state and does
    // not survive a reload).
    expect(
      shouldShowReconfigureBanner({
        mode: "disabled",
        unboundEntry: { startedAt: cascadeStartedAt },
        stateLastChangedAt: userTouchedLater,
        dismissedLocally: false,
      }),
    ).toBe(false);
  });

  it("handles SQLite-style timestamps and JS ISO timestamps without lexical confusion", () => {
    // Naive string comparison would say "2026-05-11T...Z" > "2026-05-11 ..."
    // because 'T' (0x54) > ' ' (0x20). Without normalization the banner
    // would suppress immediately after a cascade — wrong direction.
    // Normalized comparison must report the two strings as the SAME instant,
    // keeping the banner visible.
    expect(
      shouldShowReconfigureBanner({
        mode: "disabled",
        unboundEntry: { startedAt: cascadeStartedAt },
        stateLastChangedAt: cascadeLastChanged,
        dismissedLocally: false,
      }),
    ).toBe(true);
  });

  it("shows when timestamps are unparseable (safe default — don't hide a legitimate banner)", () => {
    expect(
      shouldShowReconfigureBanner({
        mode: "disabled",
        unboundEntry: { startedAt: "garbage" },
        stateLastChangedAt: "also garbage",
        dismissedLocally: false,
      }),
    ).toBe(true);
  });

  it("shows when cascade startedAt is null (older audit row with missing timestamp)", () => {
    expect(
      shouldShowReconfigureBanner({
        mode: "disabled",
        unboundEntry: { startedAt: null },
        stateLastChangedAt: cascadeLastChanged,
        dismissedLocally: false,
      }),
    ).toBe(true);
  });

  it("handles tz-offset timestamps without re-appending Z", () => {
    // Defense-in-depth: if a future change starts emitting "+09:00" in
    // either timestamp, parseTimestamp must not mangle it by appending Z.
    const offsetTimestamp = "2026-05-11T21:00:00+09:00"; // = 12:00 UTC
    expect(
      shouldShowReconfigureBanner({
        mode: "disabled",
        unboundEntry: { startedAt: cascadeStartedAt },
        stateLastChangedAt: offsetTimestamp,
        dismissedLocally: false,
      }),
      // 12:00 UTC == cascade.startedAt → not strictly after → show.
    ).toBe(true);
  });
});

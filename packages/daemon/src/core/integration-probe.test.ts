import { describe, it, expect } from "vitest";
import { INTEGRATION_DESCRIPTORS } from "@aitne/shared";
import {
  descriptorDefaultFeaturesMap,
  evaluateProbe,
  getConnector,
  makeUserManagedProbeResult,
  probeFeaturesMap,
} from "./integration-probe.js";

// Tool inventories taken from
// `scripts/poc/google-connector-inheritance/REPORT.md` and Appendix B of
// the design doc. Tests pin against the exact shipped namespaces.

const CLAUDE_GMAIL_TOOLS = [
  "mcp__claude_ai_Gmail__create_draft",
  "mcp__claude_ai_Gmail__create_label",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__label_message",
  "mcp__claude_ai_Gmail__label_thread",
  "mcp__claude_ai_Gmail__list_drafts",
  "mcp__claude_ai_Gmail__list_labels",
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__unlabel_message",
  "mcp__claude_ai_Gmail__unlabel_thread",
];

const CODEX_GMAIL_TOOLS = [
  "mcp__codex_apps__gmail._apply_labels_to_emails",
  "mcp__codex_apps__gmail._archive_emails",
  "mcp__codex_apps__gmail._batch_modify_email",
  "mcp__codex_apps__gmail._batch_read_email",
  "mcp__codex_apps__gmail._batch_read_email_threads",
  "mcp__codex_apps__gmail._bulk_label_matching_emails",
  "mcp__codex_apps__gmail._create_draft",
  "mcp__codex_apps__gmail._create_label",
  "mcp__codex_apps__gmail._delete_emails",
  "mcp__codex_apps__gmail._forward_emails",
  "mcp__codex_apps__gmail._get_profile",
  "mcp__codex_apps__gmail._list_drafts",
  "mcp__codex_apps__gmail._list_labels",
  "mcp__codex_apps__gmail._read_attachment",
  "mcp__codex_apps__gmail._read_email",
  "mcp__codex_apps__gmail._read_email_thread",
  "mcp__codex_apps__gmail._search_email_ids",
  "mcp__codex_apps__gmail._search_emails",
  "mcp__codex_apps__gmail._send_draft",
  "mcp__codex_apps__gmail._send_email",
  "mcp__codex_apps__gmail._update_draft",
];

const CLAUDE_CALENDAR_TOOLS = [
  "mcp__claude_ai_Google_Calendar__create_event",
  "mcp__claude_ai_Google_Calendar__delete_event",
  "mcp__claude_ai_Google_Calendar__get_event",
  "mcp__claude_ai_Google_Calendar__list_calendars",
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__respond_to_event",
  "mcp__claude_ai_Google_Calendar__suggest_time",
  "mcp__claude_ai_Google_Calendar__update_event",
];

// Notion connector tool inventory verified 2026-04-24 against the live
// `mcp__claude_ai_Notion__*` schema. See NOTION_DELEGATION_DESIGN.md §2.1.
const CLAUDE_NOTION_TOOLS = [
  "mcp__claude_ai_Notion__notion-create-comment",
  "mcp__claude_ai_Notion__notion-create-database",
  "mcp__claude_ai_Notion__notion-create-pages",
  "mcp__claude_ai_Notion__notion-create-view",
  "mcp__claude_ai_Notion__notion-duplicate-page",
  "mcp__claude_ai_Notion__notion-fetch",
  "mcp__claude_ai_Notion__notion-get-comments",
  "mcp__claude_ai_Notion__notion-get-teams",
  "mcp__claude_ai_Notion__notion-get-users",
  "mcp__claude_ai_Notion__notion-move-pages",
  "mcp__claude_ai_Notion__notion-search",
  "mcp__claude_ai_Notion__notion-update-data-source",
  "mcp__claude_ai_Notion__notion-update-page",
  "mcp__claude_ai_Notion__notion-update-view",
];

// Codex Notion connector tool inventory (Phase 5). Codex's namespace
// terminates with `._`, so search and read are bare (`_search`, `_fetch`)
// while every other tool is prefixed with `notion_`. Two capabilities are
// Codex-only: `query_data_sources` (SQL filter — closes the §3.2 / Q2 gap
// Claude leaves open) and `query_meeting_notes`. See
// NOTION_DELEGATION_DESIGN.md §2.2.
const CODEX_NOTION_TOOLS = [
  "mcp__codex_apps__notion._fetch",
  "mcp__codex_apps__notion._notion_create_comment",
  "mcp__codex_apps__notion._notion_create_database",
  "mcp__codex_apps__notion._notion_create_pages",
  "mcp__codex_apps__notion._notion_create_view",
  "mcp__codex_apps__notion._notion_duplicate_page",
  "mcp__codex_apps__notion._notion_get_comments",
  "mcp__codex_apps__notion._notion_get_teams",
  "mcp__codex_apps__notion._notion_get_users",
  "mcp__codex_apps__notion._notion_move_pages",
  "mcp__codex_apps__notion._notion_query_data_sources",
  "mcp__codex_apps__notion._notion_query_meeting_notes",
  "mcp__codex_apps__notion._notion_update_data_source",
  "mcp__codex_apps__notion._notion_update_page",
  "mcp__codex_apps__notion._notion_update_view",
  "mcp__codex_apps__notion._search",
];

describe("evaluateProbe (registry contract — uses real shipped tool names)", () => {
  it("Claude Gmail: every required capability is satisfied by the POC tool list", () => {
    const result = evaluateProbe({
      tools: CLAUDE_GMAIL_TOOLS,
      integration: "gmail",
      backend: "claude",
      probedAt: "2026-04-19T12:00:00Z",
    });
    expect(result.present).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(result.presentTools).toEqual(CLAUDE_GMAIL_TOOLS);
    const features = probeFeaturesMap(result);
    // Claude's Gmail connector is draft-only — these capabilities are
    // declared in the registry but should NOT appear in the features map
    // because the descriptor doesn't list them as optional.
    expect(features).not.toHaveProperty("send");
    expect(features).not.toHaveProperty("delete");
    expect(features).not.toHaveProperty("read_attachment");
    expect(features.search).toBe(true);
    expect(features.read).toBe(true);
    expect(features.draft).toBe(true);
    expect(features.label).toBe(true);
  });

  it("Codex Gmail: every required AND optional capability is satisfied", () => {
    const result = evaluateProbe({
      tools: CODEX_GMAIL_TOOLS,
      integration: "gmail",
      backend: "codex",
    });
    expect(result.present).toBe(true);
    const features = probeFeaturesMap(result);
    for (const cap of [
      "search",
      "read",
      "draft",
      "label",
      "create_label",
      "update_draft",
      "send",
      "forward",
      "delete",
      "read_attachment",
      "batch",
    ]) {
      expect(features[cap], `expected Codex Gmail feature ${cap} to be present`).toBe(true);
    }
  });

  it("Claude Calendar: required + optional capabilities are all present", () => {
    const result = evaluateProbe({
      tools: CLAUDE_CALENDAR_TOOLS,
      integration: "google_calendar",
      backend: "claude",
    });
    expect(result.present).toBe(true);
    const features = probeFeaturesMap(result);
    expect(features.list_events).toBe(true);
    expect(features.suggest_time).toBe(true);
    expect(features.delete_event).toBe(true);
  });

  it("Claude Notion: every required AND optional capability is satisfied", () => {
    const result = evaluateProbe({
      tools: CLAUDE_NOTION_TOOLS,
      integration: "notion",
      backend: "claude",
    });
    expect(result.present).toBe(true);
    expect(result.missingRequired).toEqual([]);
    const features = probeFeaturesMap(result);
    for (const cap of [
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
    ]) {
      expect(features[cap], `expected Claude Notion feature ${cap} to be present`).toBe(true);
    }
  });

  it("Codex Notion: every required AND optional capability is satisfied", () => {
    const result = evaluateProbe({
      tools: CODEX_NOTION_TOOLS,
      integration: "notion",
      backend: "codex",
    });
    expect(result.present).toBe(true);
    expect(result.missingRequired).toEqual([]);
    const features = probeFeaturesMap(result);
    for (const cap of [
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
    ]) {
      expect(features[cap], `expected Codex Notion feature ${cap} to be present`).toBe(true);
    }
  });

  it("Codex Notion: query_data_sources closes the structured-filter gap Claude has", () => {
    // §3.2 / Q2 in NOTION_DELEGATION_DESIGN.md — Claude has no structured
    // property filter; Codex does via `_notion_query_data_sources`. Verify
    // the registry attests this asymmetry.
    const claude = probeFeaturesMap(
      evaluateProbe({
        tools: CLAUDE_NOTION_TOOLS,
        integration: "notion",
        backend: "claude",
      }),
    );
    const codex = probeFeaturesMap(
      evaluateProbe({
        tools: CODEX_NOTION_TOOLS,
        integration: "notion",
        backend: "codex",
      }),
    );
    expect(claude).not.toHaveProperty("query_data_sources");
    expect(codex.query_data_sources).toBe(true);
  });

  it("Claude Notion: missing notion-update-page collapses five capabilities together", () => {
    // §5 capability-tool overlap: update_properties / patch_content /
    // replace_content / archive / apply_template all map to
    // notion-update-page. Removing the tool flips them all to false.
    const tools = CLAUDE_NOTION_TOOLS.filter(
      (t) => t !== "mcp__claude_ai_Notion__notion-update-page",
    );
    const result = evaluateProbe({
      tools,
      integration: "notion",
      backend: "claude",
    });
    expect(result.present).toBe(false);
    expect([...result.missingRequired].sort()).toEqual([
      "archive",
      "patch_content",
      "update_properties",
    ]);
    const features = probeFeaturesMap(result);
    expect(features.update_properties).toBe(false);
    expect(features.patch_content).toBe(false);
    expect(features.replace_content).toBe(false);
    expect(features.archive).toBe(false);
    expect(features.apply_template).toBe(false);
  });
});

describe("evaluateProbe (degraded scenarios)", () => {
  it("reports missing required capabilities when the live tool list is empty", () => {
    const result = evaluateProbe({
      tools: [],
      integration: "gmail",
      backend: "claude",
    });
    expect(result.present).toBe(false);
    expect([...result.missingRequired].sort()).toEqual([
      "draft",
      "label",
      "read",
      "search",
    ]);
    expect(result.presentTools).toEqual([]);
  });

  it("filters tools outside the connector's namespace from presentTools", () => {
    const result = evaluateProbe({
      tools: [
        "mcp__claude_ai_Gmail__search_threads",
        "mcp__claude_ai_Gmail__get_thread",
        "mcp__some_other_server__random",
        "mcp__claude_ai_Slack__send_message",
      ],
      integration: "gmail",
      backend: "claude",
    });
    expect([...result.presentTools].sort()).toEqual([
      "mcp__claude_ai_Gmail__get_thread",
      "mcp__claude_ai_Gmail__search_threads",
    ]);
  });

  it("reports a partial-match degradation when only some tools are present", () => {
    const result = evaluateProbe({
      tools: ["mcp__claude_ai_Gmail__search_threads"],
      integration: "gmail",
      backend: "claude",
    });
    expect(result.present).toBe(false);
    expect([...result.missingRequired].sort()).toEqual(["draft", "label", "read"]);
    const features = probeFeaturesMap(result);
    expect(features.search).toBe(true);
    expect(features.read).toBe(false);
    expect(features.draft).toBe(false);
  });

  // The "no connector for backend" throw branch is reserved for future
  // integrations that omit a backend from `backendConnectors`. Today
  // every (integrationKey, BackendId) pair has a connector — see the
  // equivalent comment in integrations.test.ts (validateDeniedTools).
  // The runtime check survives in code as forward-compat.

  it("uses the supplied probedAt verbatim", () => {
    const result = evaluateProbe({
      tools: CLAUDE_GMAIL_TOOLS,
      integration: "gmail",
      backend: "claude",
      probedAt: "2099-01-01T00:00:00Z",
    });
    expect(result.probedAt).toBe("2099-01-01T00:00:00Z");
  });

  it("falls back to a fresh ISO timestamp when probedAt is omitted", () => {
    const result = evaluateProbe({
      tools: [],
      integration: "gmail",
      backend: "claude",
    });
    expect(result.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("getConnector", () => {
  it("returns the descriptor's connector entry by backend", () => {
    const connector = getConnector("gmail", "codex");
    expect(connector?.toolNamespace).toBe("mcp__codex_apps__gmail._");
  });

  it("returns the gemini descriptor's single-underscore namespace", () => {
    // Regression guard for the convention switch: Gemini's MCP namespace
    // is `mcp_<server>_<tool>`, not `mcp__<server>__<tool>`. Confirmed
    // via stream-event probe 2026-04-26.
    const connector = getConnector("gmail", "gemini");
    expect(connector?.toolNamespace).toBe("mcp_google-workspace_gmail.");
  });
});

describe("registry self-consistency", () => {
  it("every required+optional capability has an entry in capabilityTools", () => {
    for (const descriptor of Object.values(INTEGRATION_DESCRIPTORS)) {
      for (const [backend, connector] of Object.entries(
        descriptor.backendConnectors,
      )) {
        if (!connector) continue;
        const declared = new Set([
          ...connector.requiredCapabilities,
          ...connector.optionalCapabilities,
        ]);
        for (const capability of declared) {
          expect(
            connector.capabilityTools[capability],
            `${descriptor.key} × ${backend}: capability "${capability}" missing from capabilityTools`,
          ).toBeDefined();
        }
      }
    }
  });
});

describe("descriptorDefaultFeaturesMap", () => {
  it("returns every required + optional capability marked true", () => {
    const map = descriptorDefaultFeaturesMap("gmail", "codex");
    expect(map).toBeTruthy();
    expect(map!.search).toBe(true);
    expect(map!.send).toBe(true);
    expect(map!.batch).toBe(true);
  });

  it("returns a populated map for Gemini connectors (single-underscore namespace)", () => {
    const map = descriptorDefaultFeaturesMap("gmail", "gemini");
    expect(map).toBeTruthy();
    expect(map!.search).toBe(true);
    expect(map!.send).toBe(true);
    expect(map!.batch).toBe(true);
  });

  it("does not include optional capabilities Claude Gmail omits", () => {
    const map = descriptorDefaultFeaturesMap("gmail", "claude");
    expect(map).toBeTruthy();
    expect(map).not.toHaveProperty("send");
    expect(map).not.toHaveProperty("delete");
  });
});

describe("makeUserManagedProbeResult + evaluateProbe (user-managed connector branch)", () => {
  // User-managed integrations (Outlook today) ship without a
  // descriptor-side connector. The probe path returns a synthetic
  // "present" result with no capability rows; the live tool list rides
  // along as `presentTools` so dashboards can render diagnostics.

  it("makeUserManagedProbeResult returns a present result with the live tool list", () => {
    const result = makeUserManagedProbeResult(
      "outlook_mail",
      "claude",
      ["mcp__user_outlook__send_mail", "mcp__user_outlook__search"],
      "2026-05-04T12:00:00Z",
    );
    expect(result.integration).toBe("outlook_mail");
    expect(result.backend).toBe("claude");
    expect(result.present).toBe(true);
    expect(result.capabilities).toEqual([]);
    expect(result.missingRequired).toEqual([]);
    expect(result.presentTools).toEqual([
      "mcp__user_outlook__send_mail",
      "mcp__user_outlook__search",
    ]);
    expect(result.probedAt).toBe("2026-05-04T12:00:00Z");
  });

  it("makeUserManagedProbeResult defaults probedAt to now when omitted", () => {
    const before = Date.now();
    const result = makeUserManagedProbeResult("outlook_calendar", "codex", []);
    const after = Date.now();
    const probedMs = Date.parse(result.probedAt);
    expect(probedMs).toBeGreaterThanOrEqual(before);
    expect(probedMs).toBeLessThanOrEqual(after);
  });

  it("makeUserManagedProbeResult copies the tools array (mutating callers cannot affect the result)", () => {
    const tools = ["a", "b"];
    const result = makeUserManagedProbeResult("outlook_mail", "gemini", tools);
    tools.push("c");
    expect(result.presentTools).toEqual(["a", "b"]);
  });

  it("evaluateProbe routes user-managed integrations through makeUserManagedProbeResult", () => {
    // Sanity-check: outlook_mail is the canonical user-managed key.
    expect(
      INTEGRATION_DESCRIPTORS.outlook_mail.userManagedConnector,
    ).toBe(true);
    expect(INTEGRATION_DESCRIPTORS.outlook_mail.backendConnectors).toEqual({});

    const result = evaluateProbe({
      tools: ["mcp__user_outlook__x", "unrelated_tool"],
      integration: "outlook_mail",
      backend: "claude",
    });
    expect(result.present).toBe(true);
    expect(result.capabilities).toEqual([]);
    expect(result.missingRequired).toEqual([]);
    // No namespace filter for user-managed — the full live list is
    // preserved so the dashboard can render "we found N tools."
    expect(result.presentTools).toEqual([
      "mcp__user_outlook__x",
      "unrelated_tool",
    ]);
  });

  it("evaluateProbe returns the synthetic shape for outlook_calendar (the other user-managed key)", () => {
    const result = evaluateProbe({
      tools: [],
      integration: "outlook_calendar",
      backend: "gemini",
    });
    expect(result.present).toBe(true);
    expect(result.capabilities).toEqual([]);
    expect(result.presentTools).toEqual([]);
    expect(result.backend).toBe("gemini");
  });
});

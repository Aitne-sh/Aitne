import { describe, it, expect } from "vitest";

import {
  applyAllDeniedToolsForSkill,
  applyDeniedTools,
  buildSameBackendDenyBlock,
} from "./skills-compiler-denied-tools.js";

/**
 * Pure-helper unit coverage for the §7.7 deny-list composition. Each
 * branch (Claude allowed-tools strip, Codex append-block, idempotent
 * re-apply, stale-entry filter, empty-list no-op) is pinned here so a
 * future refactor of the deny pipeline surfaces in a focused failure
 * rather than in a far-removed materialization test.
 */
describe("applyDeniedTools (§7.7)", () => {
  it("removes denied entries from a Claude allowed-tools block list", () => {
    const skillBody = `---
name: notion
description: Notion delegated
allowed-tools:
  - Bash(curl *)
  - mcp__claude_ai_Notion__notion-search
  - mcp__claude_ai_Notion__notion-create-database
  - mcp__claude_ai_Notion__notion-update-data-source
---

# body
`;
    const out = applyDeniedTools(skillBody, "notion", "claude", [
      "notion-create-database",
      "notion-update-data-source",
    ]);
    expect(out).toContain("- mcp__claude_ai_Notion__notion-search");
    expect(out).not.toContain("notion-create-database");
    expect(out).not.toContain("notion-update-data-source");
    // Other frontmatter fields preserved.
    expect(out).toContain("name: notion");
    expect(out).toContain("description: Notion delegated");
    // Body untouched.
    expect(out).toContain("# body");
  });

  it("handles the inline-array allowed-tools form", () => {
    const skillBody = `---
name: notion
allowed-tools: [mcp__claude_ai_Notion__notion-search, mcp__claude_ai_Notion__notion-create-database]
---
body
`;
    const out = applyDeniedTools(skillBody, "notion", "claude", [
      "notion-create-database",
    ]);
    expect(out).toContain("mcp__claude_ai_Notion__notion-search");
    expect(out).not.toContain("notion-create-database");
  });

  it("appends a soft-enforcement deny block on Codex", () => {
    const skillBody = `---
name: notion
description: Notion delegated codex
---

# body
`;
    const out = applyDeniedTools(skillBody, "notion", "codex", [
      "notion_create_database",
    ]);
    expect(out).toContain("## Denied tools (do not invoke)");
    expect(out).toContain("`mcp__codex_apps__notion._notion_create_database`");
    // Frontmatter intact.
    expect(out).toContain("name: notion");
    expect(out).toContain("# body");
  });

  it("re-running on a body with a prior deny block replaces it (idempotent on changed list)", () => {
    let out = `---
name: notion
---

# body
`;
    out = applyDeniedTools(out, "notion", "codex", ["notion_create_database"]);
    out = applyDeniedTools(out, "notion", "codex", ["notion_update_data_source"]);
    // Old entry is gone, new entry is present, only one deny block.
    const denyHeadings = out.match(/## Denied tools \(do not invoke\)/g);
    expect(denyHeadings).toHaveLength(1);
    expect(out).not.toContain("notion_create_database");
    expect(out).toContain("notion_update_data_source");
  });

  it("silently ignores stale entries that don't match the active backend's tool universe", () => {
    // `notion-create-database` is the Claude name; passing it to a Codex
    // backend should leave content unchanged (filterDeniedToolsForBackend
    // drops it as stale).
    const skillBody = `---
name: notion
---
body
`;
    const out = applyDeniedTools(skillBody, "notion", "codex", [
      "notion-create-database",
    ]);
    expect(out).toBe(skillBody);
  });

  it("returns input unchanged when deniedTools is empty", () => {
    const body = "---\nname: x\n---\nbody\n";
    expect(applyDeniedTools(body, "notion", "claude", [])).toBe(body);
  });

  // The "input unchanged when descriptor has no connector for backend"
  // branch is reserved for future integrations that omit a backend.
  // Today every (integrationKey, BackendId) pair has a connector.
});

describe("applyAllDeniedToolsForSkill (§7.7 — per-integration aggregation)", () => {
  it("applies the deny pass for each integration whose skillsTouched matches the skill", () => {
    const skillBody = `---
name: notion
allowed-tools:
  - mcp__claude_ai_Notion__notion-search
  - mcp__claude_ai_Notion__notion-create-database
---
body
`;
    const out = applyAllDeniedToolsForSkill(skillBody, "notion", "claude", {
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: ["notion-create-database"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).not.toContain("notion-create-database");
    expect(out).toContain("notion-search");
  });

  it("no-ops when integration is not delegated", () => {
    const body = "---\nname: x\n---\nbody\n";
    const out = applyAllDeniedToolsForSkill(body, "notion", "claude", {
      notion: {
        mode: "direct",
        deniedTools: ["notion-create-database"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).toBe(body);
  });

  it("no-ops when delegatedBackend doesn't match the session backend", () => {
    // User picked Codex but we're materializing for Claude — the deny list
    // is ineligible (different namespace).
    const body = "---\nname: x\n---\nbody\n";
    const out = applyAllDeniedToolsForSkill(body, "notion", "claude", {
      notion: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: ["notion_create_database"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).toBe(body);
  });

  it("no-ops when the integration's deniedTools is empty", () => {
    const body = "---\nname: x\n---\nbody\n";
    const out = applyAllDeniedToolsForSkill(body, "notion", "claude", {
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).toBe(body);
  });

  it("skips skills not declared in any integration's skillsTouched", () => {
    const body = "---\nname: x\n---\nbody\n";
    // `today` is not in any descriptor's skillsTouched, so passing it
    // through should leave content untouched even with denied entries set.
    const out = applyAllDeniedToolsForSkill(body, "today", "claude", {
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: ["notion-create-database"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).toBe(body);
  });

  it("applies the deny pass via deniedToolsAppliesToSkills (kept for symmetry with non-default-variant cases)", () => {
    // DELEGATED-MODE-V2 Phase 3.4 restored `skillsTouched: ["mail"]` on
    // gmail, so the OR-arm `deniedToolsAppliesToSkills` is structurally
    // redundant for the default case. Pinned anyway because the v2
    // design explicitly keeps the field.
    const skillBody = `---
name: mail
allowed-tools:
  - Bash(curl *)
  - mcp__claude_ai_Gmail__search_threads
  - mcp__claude_ai_Gmail__create_draft
---
body
`;
    const out = applyAllDeniedToolsForSkill(skillBody, "mail", "claude", {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: ["create_draft"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).not.toContain("mcp__claude_ai_Gmail__create_draft");
    expect(out).toContain("mcp__claude_ai_Gmail__search_threads");
  });

  it("deniedToolsAppliesToSkills is also wired for google_calendar → external-services", () => {
    const skillBody = `---
name: external-services
allowed-tools:
  - Bash(curl *)
  - mcp__claude_ai_Google_Calendar__list_events
  - mcp__claude_ai_Google_Calendar__delete_event
---
body
`;
    const out = applyAllDeniedToolsForSkill(skillBody, "external-services", "claude", {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: ["delete_event"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).not.toContain("mcp__claude_ai_Google_Calendar__delete_event");
    expect(out).toContain("mcp__claude_ai_Google_Calendar__list_events");
  });
});

describe("buildSameBackendDenyBlock", () => {
  it("returns null when no integrations declare denied tools for the session backend", () => {
    expect(
      buildSameBackendDenyBlock(
        {
          gmail: {
            mode: "delegated",
            delegatedBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-04-25T00:00:00Z",
          },
        },
        "claude",
      ),
    ).toBeNull();
  });

  it("returns null when integrations are delegated to a different backend than the session", () => {
    // gmail is delegated to codex but the session is claude — collectSessionDeniedTools
    // filters by `delegatedBackend === sessionBackend`, so nothing is contributed.
    expect(
      buildSameBackendDenyBlock(
        {
          gmail: {
            mode: "delegated",
            delegatedBackend: "codex",
            deniedTools: ["create_draft"],
            lastChangedAt: "2026-04-25T00:00:00Z",
          },
        },
        "claude",
      ),
    ).toBeNull();
  });

  it("returns null when integrations are in direct mode", () => {
    expect(
      buildSameBackendDenyBlock(
        {
          gmail: {
            mode: "direct",
            deniedTools: ["create_draft"],
            lastChangedAt: "2026-04-25T00:00:00Z",
          },
        },
        "claude",
      ),
    ).toBeNull();
  });

  it("renders the heading + a per-integration subsection with namespaced tool names", () => {
    const block = buildSameBackendDenyBlock(
      {
        gmail: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: ["create_draft"],
          lastChangedAt: "2026-04-25T00:00:00Z",
        },
      },
      "claude",
    );
    expect(block).not.toBeNull();
    expect(block).toContain("## Denied tools (per-integration)");
    expect(block).toContain("### gmail");
    // The block must namespace the unsuffixed name with the connector's
    // `toolNamespace` — a regression that drops the prefix would let the
    // agent invoke the bare tool unfiltered.
    expect(block).toContain("`mcp__claude_ai_Gmail__create_draft`");
  });

  it("aggregates multiple integrations into separate subsections in registry order", () => {
    const block = buildSameBackendDenyBlock(
      {
        gmail: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: ["create_draft"],
          lastChangedAt: "2026-04-25T00:00:00Z",
        },
        google_calendar: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: ["delete_event"],
          lastChangedAt: "2026-04-25T00:00:00Z",
        },
      },
      "claude",
    );
    expect(block).not.toBeNull();
    expect(block).toContain("### gmail");
    expect(block).toContain("### google_calendar");
    expect(block).toContain("`mcp__claude_ai_Gmail__create_draft`");
    expect(block).toContain("`mcp__claude_ai_Google_Calendar__delete_event`");
  });

  it("ignores stale denied entries that don't map to any tool in the active backend's connector", () => {
    // `not_a_real_capability` doesn't appear in the gmail/claude connector's
    // capabilityTools, so filterDeniedToolsForBackend strips it. With nothing
    // else to render, the block collapses back to null.
    expect(
      buildSameBackendDenyBlock(
        {
          gmail: {
            mode: "delegated",
            delegatedBackend: "claude",
            deniedTools: ["not_a_real_capability"],
            lastChangedAt: "2026-04-25T00:00:00Z",
          },
        },
        "claude",
      ),
    ).toBeNull();
  });
});

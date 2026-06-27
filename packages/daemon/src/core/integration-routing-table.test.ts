import { describe, it, expect } from "vitest";
import {
  renderIntegrationRoutingTable,
  renderIntegrationRoutingTableActionable,
} from "./management-md.js";
import type { IntegrationsRecord } from "../db/integrations-store.js";
import { defaultIntegrationsMap } from "@aitne/shared";

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §6.5.2 / §7.3 — routing-table renderer
 * tests. The full table is read-only audit prose; the actionable table
 * drives the activity_scan / DM task-flow iteration.
 */

function withState(overrides: Partial<IntegrationsRecord>): IntegrationsRecord {
  return { ...defaultIntegrationsMap(), ...overrides } as IntegrationsRecord;
}

describe("renderIntegrationRoutingTable (§7.3 — full audit table)", () => {
  it("renders every registered integration even when all are direct", () => {
    const integrations = withState({
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const rendered = renderIntegrationRoutingTable(integrations);
    expect(rendered).toContain("| gmail | direct |");
    expect(rendered).toContain("| google_calendar | direct |");
    // Disabled rows still surface so the agent can answer "do I have X?"
    expect(rendered).toMatch(/\| notion \| disabled \|/);
  });

  it("renders the data path for native rows using the connector's toolNamespace", () => {
    const integrations = withState({
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const rendered = renderIntegrationRoutingTable(integrations);
    expect(rendered).toContain("mcp__claude_ai_Gmail__");
    expect(rendered).toContain("DO NOT call /api/gmail/*");
  });

  it("renders the proxy path for delegated rows", () => {
    const integrations = withState({
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const rendered = renderIntegrationRoutingTable(integrations);
    expect(rendered).toContain("/api/integrations/google_calendar/exec");
    expect(rendered).toContain("→ codex");
  });

  it("renders direct rows pointing at the daemon API prefix", () => {
    const integrations = withState({
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const rendered = renderIntegrationRoutingTable(integrations);
    expect(rendered).toContain("/api/mail/*");
  });
});

describe("renderIntegrationRoutingTableActionable (§6.5.2 — filtered)", () => {
  it("filters out disabled rows so the task-flow loop has zero iterations for them", () => {
    const integrations = withState({
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      // notion stays disabled by default
    });
    const rendered = renderIntegrationRoutingTableActionable(integrations);
    expect(rendered).toContain("gmail");
    expect(rendered).toContain("google_calendar");
    expect(rendered).not.toContain("| notion |");
  });

  it("returns an italic empty-table marker when every registered key is disabled", () => {
    const integrations = defaultIntegrationsMap();
    // git / github default to direct, so override them to disabled here.
    integrations.git = { mode: "disabled", deniedTools: [], lastChangedAt: "2026-05-11T00:00:00Z" };
    integrations.github = { mode: "disabled", deniedTools: [], lastChangedAt: "2026-05-11T00:00:00Z" };
    const rendered = renderIntegrationRoutingTableActionable(integrations);
    expect(rendered).toMatch(/_No actionable integrations/);
  });

  it("preserves stable ordering across rows", () => {
    const integrations = withState({
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      notion: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const rendered = renderIntegrationRoutingTableActionable(integrations);
    const gmailIdx = rendered.indexOf("| gmail |");
    const calIdx = rendered.indexOf("| google_calendar |");
    const notionIdx = rendered.indexOf("| notion |");
    // INTEGRATION_KEYS declares gmail, google_calendar, notion in that order.
    expect(gmailIdx).toBeLessThan(calIdx);
    expect(calIdx).toBeLessThan(notionIdx);
  });
});

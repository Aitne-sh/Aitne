import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { writeProbe } from "../db/integration-probe-store.js";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";
import {
  consultDelegatedConnectorHealth,
  markSignoutWarned,
  renderSignoutDm,
} from "./delegated-connector-health.js";
import type { ProbeResult } from "./integration-probe.js";

function makeProbe(
  integration: IntegrationKey,
  backend: BackendId,
  present: boolean,
  missingRequired: readonly string[] = [],
): ProbeResult {
  return {
    integration,
    backend,
    presentTools: [],
    capabilities: [],
    missingRequired,
    present,
    probedAt: "2026-04-26T00:00:00.000Z",
  };
}

describe("consultDelegatedConnectorHealth (DELEGATED-MODE-V2 §4.5)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function delegate(
    key: IntegrationKey,
    backend: BackendId,
    deniedTools: readonly string[] = [],
  ): void {
    writeIntegrations(db, {
      [key]: {
        mode: "delegated",
        delegatedBackend: backend,
        deniedTools,
        lastChangedAt: "2026-04-26T00:00:00.000Z",
      },
    });
  }

  it("returns no warnings when no integrations are delegated to the session backend", () => {
    const result = consultDelegatedConnectorHealth(db, "claude");
    expect(result.warnings).toEqual([]);
    expect(result.recovered).toEqual([]);
  });

  it("skips cross-backend delegated integrations (proxy chokepoint owns failure)", () => {
    // Gmail delegated to codex, but session is on claude — that's the
    // cross-backend invoke path; the helper must stay silent.
    delegate("gmail", "codex");
    writeProbe(db, makeProbe("gmail", "codex", false, ["send"]));

    const result = consultDelegatedConnectorHealth(db, "claude");

    expect(result.warnings).toEqual([]);
    expect(result.recovered).toEqual([]);
  });

  it("returns no warning when the cached probe reports the connector is healthy", () => {
    delegate("gmail", "codex");
    writeProbe(db, makeProbe("gmail", "codex", true));

    const result = consultDelegatedConnectorHealth(db, "codex");

    expect(result.warnings).toEqual([]);
    expect(result.recovered).toEqual([]);
  });

  it("returns no warning when no cached probe row exists (insufficient evidence)", () => {
    delegate("gmail", "codex");
    // Intentionally no writeProbe call.

    const result = consultDelegatedConnectorHealth(db, "codex");

    expect(result.warnings).toEqual([]);
    expect(result.recovered).toEqual([]);
  });

  it("warns when cached probe shows missing required capabilities — without writing the marker", () => {
    delegate("gmail", "codex");
    writeProbe(db, makeProbe("gmail", "codex", false, ["send", "read"]));

    const result = consultDelegatedConnectorHealth(db, "codex");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      integration: "gmail",
      backend: "codex",
      displayName: "Gmail",
      missingRequired: ["send", "read"],
    });
    expect(result.recovered).toEqual([]);

    // Critical: the consult does NOT write the marker — the dispatcher
    // commits it only after a successful DM dispatch (advisor item 2).
    expect(
      readRuntimeState(db, "delegated_signout_warned:gmail:codex"),
    ).toBeNull();
  });

  it("re-warns if the dispatcher never calls markSignoutWarned (DM dispatch failed)", () => {
    delegate("gmail", "codex");
    writeProbe(db, makeProbe("gmail", "codex", false, ["send"]));

    const first = consultDelegatedConnectorHealth(db, "codex");
    expect(first.warnings).toHaveLength(1);

    // Simulating a Slack outage: dispatcher's notification.send rejected,
    // so markSignoutWarned was never called. Next consult must re-warn.
    const second = consultDelegatedConnectorHealth(db, "codex");
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0].integration).toBe("gmail");
  });

  it("stays silent on subsequent consults once the dispatcher commits the marker via markSignoutWarned", () => {
    delegate("gmail", "codex");
    writeProbe(db, makeProbe("gmail", "codex", false, ["send"]));

    const first = consultDelegatedConnectorHealth(db, "codex");
    expect(first.warnings).toHaveLength(1);
    // Simulate the dispatcher's success path.
    markSignoutWarned(db, first.warnings[0]);

    const second = consultDelegatedConnectorHealth(db, "codex");
    expect(second.warnings).toEqual([]);
    expect(second.recovered).toEqual([]);
  });

  it("clears the marker and reports recovery when the cached probe transitions back to present", () => {
    delegate("gmail", "codex");
    writeRuntimeState(db, "delegated_signout_warned:gmail:codex", {
      warnedAt: "2026-04-25T00:00:00.000Z",
      missingRequired: ["send"],
    });
    writeProbe(db, makeProbe("gmail", "codex", true));

    const result = consultDelegatedConnectorHealth(db, "codex");

    expect(result.warnings).toEqual([]);
    expect(result.recovered).toEqual(["gmail"]);
    expect(
      readRuntimeState(db, "delegated_signout_warned:gmail:codex"),
    ).toBeNull();
  });

  it("re-arms the alarm when probe goes present → missing → present → missing", () => {
    delegate("gmail", "codex");
    // Round 1: missing → warn + dispatcher commits marker.
    writeProbe(db, makeProbe("gmail", "codex", false, ["send"]));
    const first = consultDelegatedConnectorHealth(db, "codex");
    expect(first.warnings).toHaveLength(1);
    markSignoutWarned(db, first.warnings[0]);

    // Round 2: recovered → marker cleared.
    writeProbe(db, makeProbe("gmail", "codex", true));
    expect(consultDelegatedConnectorHealth(db, "codex").recovered).toEqual([
      "gmail",
    ]);

    // Round 3: missing again → warns again because marker was cleared.
    writeProbe(db, makeProbe("gmail", "codex", false, ["send"]));
    const third = consultDelegatedConnectorHealth(db, "codex");
    expect(third.warnings).toHaveLength(1);
    expect(third.warnings[0].integration).toBe("gmail");
  });

  it("isolates warnings per (integration, backend) — gmail can warn while calendar stays silent", () => {
    delegate("gmail", "codex");
    delegate("google_calendar", "codex");
    writeProbe(db, makeProbe("gmail", "codex", false, ["send"]));
    writeProbe(db, makeProbe("google_calendar", "codex", true));

    const result = consultDelegatedConnectorHealth(db, "codex");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].integration).toBe("gmail");
    // Calendar marker stays absent — its probe is healthy.
    expect(
      readRuntimeState(db, "delegated_signout_warned:google_calendar:codex"),
    ).toBeNull();
  });

  it("markSignoutWarned persists a marker readable on the next consult", () => {
    delegate("gmail", "codex");
    markSignoutWarned(db, {
      integration: "gmail",
      backend: "codex",
      displayName: "Gmail",
      missingRequired: ["send"],
    });
    const stored = readRuntimeState<{
      warnedAt: string;
      missingRequired: string[];
    }>(db, "delegated_signout_warned:gmail:codex");
    expect(stored).not.toBeNull();
    expect(stored!.missingRequired).toEqual(["send"]);
  });

  it("ignores integrations in direct or disabled mode", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "direct",
        delegatedBackend: null,
        deniedTools: [],
        lastChangedAt: "2026-04-26T00:00:00.000Z",
      },
      google_calendar: {
        mode: "disabled",
        delegatedBackend: null,
        deniedTools: [],
        lastChangedAt: "2026-04-26T00:00:00.000Z",
      },
    });
    // Even with a present=false probe row, non-delegated integrations
    // must not be inspected — they have no skill body relying on the
    // cached connector.
    writeProbe(db, makeProbe("gmail", "codex", false, ["send"]));

    const result = consultDelegatedConnectorHealth(db, "codex");
    expect(result.warnings).toEqual([]);
    expect(result.recovered).toEqual([]);
  });
});

describe("renderSignoutDm (DELEGATED-MODE-V2 §4.5)", () => {
  it("includes the integration display name, backend, and missing capabilities", () => {
    const dm = renderSignoutDm({
      integration: "gmail",
      backend: "codex",
      displayName: "Gmail",
      missingRequired: ["send", "read"],
    });
    expect(dm).toContain("Gmail");
    expect(dm).toContain("codex");
    expect(dm).toContain("send, read");
    expect(dm).toContain("non-functional");
  });

  it("omits the missing-capabilities clause when none reported", () => {
    const dm = renderSignoutDm({
      integration: "google_calendar",
      backend: "claude",
      displayName: "Google Calendar",
      missingRequired: [],
    });
    expect(dm).toContain("Google Calendar");
    expect(dm).not.toContain("missing:");
  });
});

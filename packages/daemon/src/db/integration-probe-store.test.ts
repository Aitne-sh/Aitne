import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  deleteProbesForIntegration,
  listProbes,
  probeKey,
  readProbe,
  writeProbe,
} from "./integration-probe-store.js";
import type { ProbeResult } from "../core/integration-probe.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function makeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    integration: "gmail",
    backend: "claude",
    presentTools: [
      "mcp__claude_ai_Gmail__search_threads",
      "mcp__claude_ai_Gmail__get_thread",
    ],
    capabilities: [
      {
        capability: "search",
        present: true,
        matchedTools: ["mcp__claude_ai_Gmail__search_threads"],
        required: true,
      },
    ],
    missingRequired: [],
    present: true,
    probedAt: "2026-04-19T12:00:00Z",
    ...overrides,
  };
}

describe("integration-probe-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("readProbe returns null when no row exists", () => {
    expect(readProbe(db, "gmail", "claude")).toBeNull();
  });

  it("writeProbe persists the result and readProbe round-trips it", () => {
    const result = makeResult();
    writeProbe(db, result);
    const read = readProbe(db, "gmail", "claude");
    expect(read).toEqual(result);
  });

  it("writeProbe upserts on conflicting (integration, backend)", () => {
    writeProbe(db, makeResult({ probedAt: "2026-04-19T10:00:00Z" }));
    writeProbe(db, makeResult({ probedAt: "2026-04-19T13:00:00Z", presentTools: [] }));
    const read = readProbe(db, "gmail", "claude");
    expect(read?.probedAt).toBe("2026-04-19T13:00:00Z");
    expect(read?.presentTools).toEqual([]);
  });

  it("listProbes returns every persisted result keyed by (integration, backend)", () => {
    writeProbe(db, makeResult({ integration: "gmail", backend: "claude" }));
    writeProbe(db, makeResult({ integration: "gmail", backend: "codex" }));
    writeProbe(
      db,
      makeResult({
        integration: "google_calendar",
        backend: "claude",
        presentTools: [],
      }),
    );
    const map = listProbes(db);
    expect(map.size).toBe(3);
    expect(map.get(probeKey("gmail", "claude"))).toBeDefined();
    expect(map.get(probeKey("gmail", "codex"))).toBeDefined();
    expect(map.get(probeKey("google_calendar", "claude"))?.presentTools).toEqual(
      [],
    );
  });

  it("listProbes silently drops corrupted rows", () => {
    writeProbe(db, makeResult());
    db.prepare(
      `INSERT INTO integration_probes (integration_key, backend_id, result_json, probed_at)
       VALUES ('gmail', 'codex', '{not json', '2026-04-19T00:00:00Z')`,
    ).run();
    const map = listProbes(db);
    expect(map.size).toBe(1);
  });

  it("listProbes drops rows whose integration_key is no longer in the registry", () => {
    writeProbe(db, makeResult());
    // A row whose `integration_key` is valid SQL but not in
    // IntegrationKey — e.g. a registry deprecation. parseRow returns null
    // and listProbes skips it rather than mis-typing the result.
    db.prepare(
      `INSERT INTO integration_probes (integration_key, backend_id, result_json, probed_at)
       VALUES ('slack', 'claude', ?, '2026-04-19T00:00:00Z')`,
    ).run(JSON.stringify({ ...makeResult(), integration: "slack" }));
    const map = listProbes(db);
    expect(map.size).toBe(1);
    expect(map.get(probeKey("gmail", "claude"))).toBeDefined();
  });

  it("probeKey is stable and round-trippable", () => {
    expect(probeKey("gmail", "claude")).toBe("gmail::claude");
  });

  it("deleteProbesForIntegration removes all probe rows for the given integration", () => {
    writeProbe(db, makeResult({ integration: "gmail", backend: "claude" }));
    writeProbe(db, makeResult({ integration: "gmail", backend: "codex" }));
    writeProbe(db, makeResult({ integration: "google_calendar", backend: "claude" }));

    const deleted = deleteProbesForIntegration(db, "gmail");
    expect(deleted).toBe(2);
    expect(listProbes(db).size).toBe(1);
  });
});

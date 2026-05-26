/**
 * MANAGEMENT-POLICY-CAPTURE-PLAN §P3 — audit-trail verification.
 *
 * Two layers of evidence the plan promises (§4.4.1 step 7 + §5.5),
 * updated for DELEGATED-MODE-V2 §4.5 (Notify-tier abolition):
 *
 *   1. `classifyRisk()` returns RiskTier.Autonomous for every write the
 *      policy skill issues against `rules/policies/*` and
 *      `routines/custom/*`. The legacy Notify tier was abolished in
 *      Phase 1; the user's `deniedTools` policy + on-demand
 *      retrospective via `GET /api/agent/actions` cover what Notify
 *      used to surface. Bearer auth is not required for Autonomous,
 *      keeping the agent's curl path open.
 *
 *   2. `md_file_snapshots` rows are written with `trigger='api_put' /
 *      'api_patch' / 'api_delete'` for the same operations, so the
 *      pre-write content is recoverable if the skill needs to roll
 *      back. The plan §5.5 frames this as "audit trail reconstructible
 *      by joining snapshot rows" — these tests prove the snapshots
 *      exist and the file_path column matches the canonical context
 *      path. This is the durable audit trail in the post-Notify model.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyRisk, RiskTier } from "./safety/risk-classifier.js";
import { createContextRoutes } from "./api/routes/context/index.js";
import { applySchema } from "./db/schema.js";
import type { AgentConfig } from "./config.js";

describe("management-policy audit — classifyRisk Autonomous-tier coverage (post-Notify)", () => {
  it("PUT /api/context/rules/policies/<slug> classifies as Autonomous", () => {
    expect(
      classifyRisk("PUT", "/api/context/policies/management-captures/morning-finance-check"),
    ).toBe(RiskTier.Autonomous);
  });

  it("PATCH /api/context/rules/policies/<slug> classifies as Autonomous (pause/resume frontmatter)", () => {
    expect(
      classifyRisk("PATCH", "/api/context/policies/management-captures/morning-finance-check"),
    ).toBe(RiskTier.Autonomous);
  });

  it("PATCH /api/context/rules/policies/_index classifies as Autonomous (skill step 5.4)", () => {
    expect(
      classifyRisk("PATCH", "/api/context/policies/management-captures/_index"),
    ).toBe(RiskTier.Autonomous);
  });

  it("PUT /api/context/routines/custom/<slug> classifies as Autonomous (skill step 5.2)", () => {
    expect(
      classifyRisk("PUT", "/api/context/policies/routines/custom/morning-finance-check"),
    ).toBe(RiskTier.Autonomous);
  });

  it("DELETE /api/context/routines/custom/<slug> classifies as Autonomous (remove flow)", () => {
    expect(
      classifyRisk(
        "DELETE",
        "/api/context/policies/routines/custom/morning-finance-check",
      ),
    ).toBe(RiskTier.Autonomous);
  });

  it("PUT /api/context/dossiers/<topic> classifies as Autonomous (data, not policy)", () => {
    expect(classifyRisk("PUT", "/api/context/dossiers/finance")).toBe(
      RiskTier.Autonomous,
    );
  });

  it("DELETE on rules/policies/* falls through to RiskTier.Approve (no specific entry)", () => {
    // The classifier table has explicit Notify entries for PUT/PATCH on
    // rules/* but no DELETE entry. Unmatched routes default to Approve,
    // which forces a Bearer token for any caller. Combined with the
    // route layer's `forbidden` (integration test) this is two
    // overlapping defenses for the policy-file-no-delete invariant
    // (plan §4.6 / §5.1). A future whitelist change would have to
    // override BOTH layers to expose a deletion path.
    expect(
      classifyRisk(
        "DELETE",
        "/api/context/policies/management-captures/morning-finance-check",
      ),
    ).toBe(RiskTier.Approve);
  });
});

describe("management-policy audit — md_file_snapshots rows on write paths", () => {
  let dataDir: string;
  let contextDir: string;
  let db: Database.Database;
  let app: Hono;

  function makeConfig(): AgentConfig {
    return {
      dataDir,
      executeTimeoutMinutes: 60,
    } as unknown as AgentConfig;
  }

  function policyBody(status: "active" | "paused" | "removed" = "active"): string {
    return [
      "---",
      "type: rule",
      "kind: policy",
      "owner: agent",
      "updated: 2026-04-24",
      "slug: morning-finance-check",
      `status: ${status}`,
      "created_at: 2026-04-24",
      'origin: "User DM 2026-04-24"',
      "---",
      "# Morning Finance Check",
      "",
      "## Why",
      "Daily snapshot.",
      "",
    ].join("\n");
  }

  function routineBody(enabled: "true" | "false" = "true"): string {
    return [
      "---",
      "type: rule",
      "slug: morning-finance-check",
      "process_key: routine.custom.morning-finance-check",
      'cron: "0 7 * * *"',
      "backend_tier: light",
      "max_budget_usd: 0.20",
      `enabled: ${enabled}`,
      "---",
      "# Morning Finance Check",
      "",
      "## Checks",
      "- step",
      "",
    ].join("\n");
  }

  function indexBody(): string {
    return [
      "---",
      "type: index",
      "owner: agent",
      "updated: 2026-04-24",
      "---",
      "# Policy index",
      "",
      "## Active",
      "",
      "| Slug | Status |",
      "|---|---|",
      "",
      "## Removed",
      "",
      "| Slug | Removed at |",
      "|---|---|",
      "",
    ].join("\n");
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-mp-audit-"));
    contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "policies", "management-captures"), {
      recursive: true,
    });
    mkdirSync(join(contextDir, "policies", "routines", "custom"), { recursive: true });
    writeFileSync(
      join(contextDir, "policies", "management-captures", "_index.md"),
      indexBody(),
      "utf-8",
    );

    db = new Database(":memory:");
    applySchema(db);

    const routes = createContextRoutes({
      db,
      config: makeConfig(),
    } as unknown as Parameters<typeof createContextRoutes>[0]);
    app = new Hono();
    app.route("/api", routes);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function snapshotsFor(filePath: string): { trigger: string; content: string }[] {
    return db
      .prepare(
        "SELECT trigger, content FROM md_file_snapshots WHERE file_path = ? ORDER BY id ASC",
      )
      .all(filePath) as { trigger: string; content: string }[];
  }

  async function put(path: string, content: string): Promise<Response> {
    return await app.request(`/api/context/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

  it("first-PUT (creating new file) does NOT create a snapshot", async () => {
    // The route only snapshots PRE-existing content. A first PUT has
    // nothing to preserve — no row is written. This is by design (no
    // wasted bytes) and the skill's rollback-policy-only-on-update path
    // assumes it.
    const res = await put("policies/management-captures/morning-finance-check", policyBody());
    expect(res.status).toBe(200);
    expect(snapshotsFor("policies/management-captures/morning-finance-check")).toHaveLength(0);
  });

  it("second-PUT (pause flip) writes one api_put snapshot of the previous content", async () => {
    // Plan §5.5 — pause GET-merge-PUT preserves the prior content as
    // a snapshot row labeled `api_put`. The skill's rollback path can
    // recover the pre-pause file by reading the latest snapshot.
    await put("policies/management-captures/morning-finance-check", policyBody("active"));
    await put("policies/management-captures/morning-finance-check", policyBody("paused"));

    const rows = snapshotsFor("policies/management-captures/morning-finance-check");
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("api_put");
    expect(rows[0].content).toContain("status: active");
  });

  it("PATCH section=append on _index writes an api_patch snapshot", async () => {
    // Step 5.4 PATCH — the snapshot trigger column distinguishes
    // section-edit operations from full-file replaces.
    await app.request("/api/context/policies/management-captures/_index", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        section: "Active",
        mode: "append",
        content: "| s | active |",
      }),
    });

    const rows = snapshotsFor("policies/management-captures/_index");
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("api_patch");
    // The snapshot captures the pre-patch content (no row in Active yet).
    expect(rows[0].content).not.toContain("| s | active |");
    expect(rows[0].content).toContain("## Active");
  });

  it("DELETE on routines/custom/<slug> writes an api_delete snapshot", async () => {
    // Plan §4.6 remove flow — the routine is deleted but its content
    // survives in `md_file_snapshots` so the agent can show the user
    // what they removed.
    await put("policies/routines/custom/morning-finance-check", routineBody("true"));
    await app.request(
      "/api/context/policies/routines/custom/morning-finance-check",
      { method: "DELETE" },
    );

    const rows = snapshotsFor("policies/routines/custom/morning-finance-check");
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("api_delete");
    expect(rows[0].content).toContain("enabled: true");
  });

  it("audit trail is queryable by file_path prefix (skill scope)", async () => {
    // The snapshot table has an index on `(file_path, created_at DESC)`.
    // A LIKE-prefix query reconstructs the full chronology of edits for
    // a given policy slug — this is the durable audit substrate the
    // plan §5.5 promises.
    await put("policies/management-captures/morning-finance-check", policyBody("active"));
    await put("policies/management-captures/morning-finance-check", policyBody("paused"));
    await put("policies/routines/custom/morning-finance-check", routineBody("true"));
    await put("policies/routines/custom/morning-finance-check", routineBody("false"));

    const policyRows = db
      .prepare(
        "SELECT trigger FROM md_file_snapshots WHERE file_path LIKE 'policies/management-captures/%' ORDER BY id ASC",
      )
      .all() as { trigger: string }[];
    expect(policyRows.map((r) => r.trigger)).toEqual(["api_put"]);

    const routineRows = db
      .prepare(
        "SELECT trigger FROM md_file_snapshots WHERE file_path LIKE 'policies/routines/custom/%' ORDER BY id ASC",
      )
      .all() as { trigger: string }[];
    expect(routineRows.map((r) => r.trigger)).toEqual(["api_put"]);
  });
});

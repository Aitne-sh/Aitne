/**
 * MANAGEMENT-POLICY-CAPTURE-PLAN §P3 — fan-out integration tests.
 *
 * Exercises the four-step create order from §4.4.1 (dossier → routine →
 * policy → _index) end-to-end through the live `createContextRoutes`
 * handler, plus the pause/resume/remove flows from §4.6 and the partial-
 * failure rollback contract.
 *
 * The skill-level guidance (similarity detection, echo, confirm) lives
 * in `management-policy.skill.test.ts` — this file proves the API the
 * skill calls actually behaves as the skill describes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createContextRoutes } from "./api/routes/context/index.js";
import { applySchema } from "./db/schema.js";
import type { AgentConfig } from "./config.js";

const POLICY_SLUG = "morning-finance-check";
const POLICY_TOPIC = "finance";

function makeConfig(dataDir: string): AgentConfig {
  return {
    dataDir,
    executeTimeoutMinutes: 60,
  } as unknown as AgentConfig;
}

function policyContent(overrides: Partial<{
  status: string;
  updated: string;
  origin: string;
  kind: string;
}> = {}): string {
  const status = overrides.status ?? "active";
  const updated = overrides.updated ?? "2026-04-24";
  const origin = overrides.origin ?? "User DM 2026-04-24T14:30Z";
  const kind = overrides.kind ?? "policy";
  return [
    "---",
    "type: rule",
    `kind: ${kind}`,
    "owner: agent",
    `updated: ${updated}`,
    `slug: ${POLICY_SLUG}`,
    `status: ${status}`,
    "created_at: 2026-04-24",
    `origin: "${origin}"`,
    "---",
    "# Morning Finance Check",
    "",
    "## Why",
    "Daily snapshot of balance and recent transactions.",
    "",
    "## How",
    "1. Wake at 07:00 local time.",
    "2. Append to dossiers/finance.md.",
    "",
  ].join("\n");
}

function routineContent(overrides: Partial<{ enabled: string; cron: string }> = {}): string {
  const enabled = overrides.enabled ?? "true";
  const cronExpr = overrides.cron ?? "0 7 * * *";
  return [
    "---",
    "type: rule",
    `slug: ${POLICY_SLUG}`,
    `process_key: routine.custom.${POLICY_SLUG}`,
    `cron: "${cronExpr}"`,
    "backend_tier: light",
    "max_budget_usd: 0.20",
    `enabled: ${enabled}`,
    "---",
    "# Morning Finance Check",
    "",
    "## Checks",
    "",
    "### Read balance",
    "- **Action**: read latest balance",
    "",
  ].join("\n");
}

function dossierContent(): string {
  return [
    "---",
    "type: dossier",
    "owner: agent",
    "updated: 2026-04-24",
    "---",
    "# Finance",
    "",
    "## Daily Log",
    "",
  ].join("\n");
}

function seededIndexContent(): string {
  // Mirrors `agent-assets/templates/rules/policies/_index.md`. Seeded
  // by the skeleton on first setup; the integration test materializes
  // it directly because no skeleton runs in this harness.
  return [
    "---",
    "type: index",
    "owner: agent",
    "updated: 2026-04-24",
    "template_version: 1",
    "---",
    "# Policy index",
    "",
    "## Active",
    "",
    "| Slug | Status | Cadence | Linked routine | Linked dossier | Why |",
    "|---|---|---|---|---|---|",
    "",
    "## Removed",
    "",
    "| Slug | Removed at | Why |",
    "|---|---|---|",
    "",
  ].join("\n");
}

describe("management-policy fan-out — HTTP integration (plan §4.4.1, §4.6)", () => {
  let dataDir: string;
  let contextDir: string;
  let db: Database.Database;
  let app: Hono;
  let onIndexableContextChangeCalls: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-mp-integration-"));
    contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "policies", "management-captures"), { recursive: true });
    mkdirSync(join(contextDir, "policies", "routines", "custom"), { recursive: true });
    mkdirSync(join(contextDir, "knowledge", "dossiers"), { recursive: true });
    writeFileSync(
      join(contextDir, "policies", "management-captures", "_index.md"),
      seededIndexContent(),
      "utf-8",
    );

    db = new Database(":memory:");
    applySchema(db);

    onIndexableContextChangeCalls = [];

    const routes = createContextRoutes({
      db,
      config: makeConfig(dataDir),
      onIndexableContextChange: (path: string) => {
        onIndexableContextChangeCalls.push(path);
      },
    } as unknown as Parameters<typeof createContextRoutes>[0]);

    app = new Hono();
    app.route("/api", routes);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function putContext(path: string, content: string): Promise<Response> {
    return await app.request(`/api/context/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

  async function getContext(path: string): Promise<{ status: number; content?: string }> {
    const res = await app.request(`/api/context/${path}`);
    if (res.status !== 200) return { status: res.status };
    const data = (await res.json()) as { content: string };
    return { status: 200, content: data.content };
  }

  async function patchSection(
    path: string,
    payload: { section: string; mode: string; content: string },
  ): Promise<Response> {
    return await app.request(`/api/context/${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async function deleteContext(path: string): Promise<Response> {
    return await app.request(`/api/context/${path}`, { method: "DELETE" });
  }

  describe("create flow — strict order, all four steps green", () => {
    it("dossier → routine → policy → _index PATCH all succeed", async () => {
      // 5.1 dossier
      const dossierRes = await putContext(`dossiers/${POLICY_TOPIC}`, dossierContent());
      expect(dossierRes.status).toBe(200);

      // 5.2 routine — legacy path; still accepted + validated (the cron
      // scheduler that used to reload on this write was retired at the
      // Agents-hub redesign).
      const routineRes = await putContext(
        `routines/custom/${POLICY_SLUG}`,
        routineContent(),
      );
      expect(routineRes.status).toBe(200);

      // 5.3 policy file
      const policyRes = await putContext(
        `rules/policies/${POLICY_SLUG}`,
        policyContent(),
      );
      expect(policyRes.status).toBe(200);

      // 5.4 _index update via PATCH section append
      const indexRes = await patchSection("policies/management-captures/_index", {
        section: "Active",
        mode: "append",
        content: `| ${POLICY_SLUG} | active | 0 7 * * * | ${POLICY_SLUG} | ${POLICY_TOPIC} | Daily finance snapshot |`,
      });
      expect(indexRes.status).toBe(200);

      // All four files are readable.
      const policyRead = await getContext(`rules/policies/${POLICY_SLUG}`);
      expect(policyRead.status).toBe(200);
      expect(policyRead.content).toContain(`slug: ${POLICY_SLUG}`);

      const indexRead = await getContext("policies/management-captures/_index");
      expect(indexRead.status).toBe(200);
      expect(indexRead.content).toContain(`| ${POLICY_SLUG} | active | 0 7 * * * |`);
    });

    it("routes that should fire onIndexableContextChange do so for every step", async () => {
      // Plan §5.6 — the global FS-watch reconciler picks up writes via
      // chokidar within ~1s, but the `onIndexableContextChange` synchronous
      // hook lets the daemon nudge it immediately. Drift here would
      // delay policy visibility in `context-index.md`.
      await putContext(`dossiers/${POLICY_TOPIC}`, dossierContent());
      await putContext(`routines/custom/${POLICY_SLUG}`, routineContent());
      await putContext(`rules/policies/${POLICY_SLUG}`, policyContent());
      await patchSection("policies/management-captures/_index", {
        section: "Active",
        mode: "append",
        content: "| s | active | 0 0 * * * | s | t | w |",
      });

      const indexable = onIndexableContextChangeCalls;
      expect(indexable.some((p) => p === `knowledge/dossiers/${POLICY_TOPIC}.md`)).toBe(true);
      expect(indexable.some((p) => p === `policies/routines/custom/${POLICY_SLUG}.md`)).toBe(true);
      expect(indexable.some((p) => p === `policies/management-captures/${POLICY_SLUG}.md`)).toBe(true);
      expect(indexable.some((p) => p === "policies/management-captures/_index.md")).toBe(true);
    });
  });

  describe("create flow — failure-mode observability", () => {
    it("policy PUT with malformed kind is rejected before write (rollback observability)", async () => {
      // Plan §5.4 — the frontmatter validator must catch `kind != policy`
      // at the API boundary so the skill sees a 422 and can roll back
      // the prior dossier+routine writes deterministically.
      await putContext(`dossiers/${POLICY_TOPIC}`, dossierContent());
      await putContext(`routines/custom/${POLICY_SLUG}`, routineContent());

      const policyRes = await putContext(
        `rules/policies/${POLICY_SLUG}`,
        policyContent({ kind: "other" }),
      );
      expect(policyRes.status).toBe(422);

      // The policy file did NOT get created — ensures the skill's
      // rollback only has to undo dossier+routine.
      expect(
        existsSync(
          join(contextDir, "policies", "management-captures", `${POLICY_SLUG}.md`),
        ),
      ).toBe(false);
    });

    it("routine PUT with mismatched process_key is rejected before write", async () => {
      // Plan step 5.2 — parseCustomRoutineSpec runs at PUT time. A
      // mismatched process_key returns 400 so the skill knows step 5.2
      // failed and rolls back step 5.1 (the dossier).
      const res = await putContext(`routines/custom/${POLICY_SLUG}`, [
        "---",
        "type: rule",
        `slug: ${POLICY_SLUG}`,
        "process_key: routine.custom.different-slug",
        'cron: "0 7 * * *"',
        "backend_tier: light",
        "max_budget_usd: 0.20",
        "enabled: true",
        "---",
        "# X",
        "",
        "## Checks",
        "- step",
      ].join("\n"));
      expect(res.status).toBe(400);
      expect(
        existsSync(
          join(contextDir, "policies", "routines", "custom", `${POLICY_SLUG}.md`),
        ),
      ).toBe(false);
      // No reload fired for an invalid file.
    });

    it("DELETE on rules/policies/* is intentionally not whitelisted (plan §5.1)", async () => {
      // Plan §4.6 + §5.1 — the design uses status:removed instead of
      // file deletion to keep history. The route returns 403 ("forbidden")
      // because `rules/*` lacks DELETE in CONTEXT_WRITE_PERMISSIONS — a
      // future 200 (or even a 405) would silently lose audit value.
      await putContext(`rules/policies/${POLICY_SLUG}`, policyContent());
      const res = await deleteContext(`rules/policies/${POLICY_SLUG}`);
      expect(res.status).toBe(403);
      const errBody = (await res.json()) as { error: string };
      expect(errBody.error).toBe("forbidden");
      expect(
        existsSync(
          join(contextDir, "policies", "management-captures", `${POLICY_SLUG}.md`),
        ),
      ).toBe(true);
    });
  });

  describe("policy listing — the skill's source-of-truth call", () => {
    // Plan §4.4.1 step 1 / §4.5 — the directory listing is the
    // authoritative input to similarity detection; `_index.md` is only
    // the convenience snapshot. An earlier SKILL.md draft called
    // `/api/context/list/rules/policies` (multi-segment), which falls
    // through to `/context/*` and returns 404 for every invocation —
    // the bug was masked because the skill test only string-matched
    // the buggy URL. The route now flattens `rules/policies/` so the
    // skill can use the single-segment endpoint.
    it("GET /api/context/list/rules returns flattened `policies/<slug>.md` entries", async () => {
      await putContext(
        `rules/policies/${POLICY_SLUG}`,
        policyContent(),
      );
      await putContext(
        "policies/management-captures/another-policy",
        policyContent({ updated: "2026-04-25" })
          .replace(`slug: ${POLICY_SLUG}`, "slug: another-policy"),
      );
      const res = await app.request("/api/context/list/rules");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        files: { name: string; lastModified: string }[];
      };
      const names = data.files.map((f) => f.name);
      expect(names).toContain(`management-captures/${POLICY_SLUG}.md`);
      expect(names).toContain("management-captures/another-policy.md");
      // The seeded `_index.md` MUST also appear so the skill can
      // cross-check listing vs index in a single pass.
      expect(names).toContain("management-captures/_index.md");
    });

    it("GET /api/context/list/rules/policies (broken multi-segment form) does NOT 200", async () => {
      // Pin the negative contract: the multi-segment URL must NOT be
      // silently routed to a list response. If a future refactor adds
      // sub-dir listing under `:dir/:subdir`, the skill's drift
      // detection assumptions would change and this test should be
      // updated deliberately.
      await putContext(
        `rules/policies/${POLICY_SLUG}`,
        policyContent(),
      );
      const res = await app.request("/api/context/list/rules/policies");
      expect(res.status).not.toBe(200);
    });
  });

  describe("_index cell mutation (skill pause/resume step 3)", () => {
    // Plan §4.6 — section append cannot mutate a cell, so the skill is
    // told to GET → edit row → PUT the full file when flipping a row's
    // Status from `active` to `paused`. This test pins that round-trip
    // contract: the rewritten _index passes validation, the snapshot
    // captures the prior content, and `onIndexableContextChange` fires.
    it("GET → edit row → PUT survives validation and snapshots the prior content", async () => {
      await putContext(`rules/policies/${POLICY_SLUG}`, policyContent());
      await patchSection("policies/management-captures/_index", {
        section: "Active",
        mode: "append",
        content: `| ${POLICY_SLUG} | active | 0 7 * * * | ${POLICY_SLUG} | ${POLICY_TOPIC} | Why |`,
      });

      const beforeRead = await getContext("policies/management-captures/_index");
      expect(beforeRead.status).toBe(200);
      const before = beforeRead.content!;
      expect(before).toContain(`| ${POLICY_SLUG} | active |`);

      const flipped = before.replace(
        `| ${POLICY_SLUG} | active |`,
        `| ${POLICY_SLUG} | paused |`,
      );
      // Bump `updated` so frontmatter validation still passes after the
      // edit (the validator requires an ISO date but does not require
      // forward motion).
      const flippedWithDate = flipped.replace(
        /^updated:\s*.+$/m,
        "updated: 2026-04-25",
      );

      onIndexableContextChangeCalls = [];
      const putRes = await putContext("policies/management-captures/_index", flippedWithDate);
      expect(putRes.status).toBe(200);
      expect(onIndexableContextChangeCalls).toContain(
        "policies/management-captures/_index.md",
      );

      const after = await getContext("policies/management-captures/_index");
      expect(after.content).toContain(`| ${POLICY_SLUG} | paused |`);
      expect(after.content).not.toContain(`| ${POLICY_SLUG} | active |`);
    });
  });

  describe("pause flow (plan §4.6)", () => {
    beforeEach(async () => {
      // Seed an active policy + linked routine for pause/resume/remove tests.
      await putContext(`dossiers/${POLICY_TOPIC}`, dossierContent());
      await putContext(`routines/custom/${POLICY_SLUG}`, routineContent());
      await putContext(`rules/policies/${POLICY_SLUG}`, policyContent());
      await patchSection("policies/management-captures/_index", {
        section: "Active",
        mode: "append",
        content: `| ${POLICY_SLUG} | active | 0 7 * * * | ${POLICY_SLUG} | ${POLICY_TOPIC} | Why |`,
      });
    });

    it("pause = policy.status:paused + routine.enabled:false (both succeed)", async () => {
      // Step 1 — policy file
      const policyRes = await putContext(
        `rules/policies/${POLICY_SLUG}`,
        policyContent({ status: "paused", updated: "2026-04-25" }),
      );
      expect(policyRes.status).toBe(200);

      // Step 2 — routine file with enabled flipped
      const routineRes = await putContext(
        `routines/custom/${POLICY_SLUG}`,
        routineContent({ enabled: "false" }),
      );
      expect(routineRes.status).toBe(200);

      // Confirm both files reflect the new state.
      const policyRead = await getContext(`rules/policies/${POLICY_SLUG}`);
      expect(policyRead.content).toContain("status: paused");
      const routineRead = await getContext(`routines/custom/${POLICY_SLUG}`);
      expect(routineRead.content).toContain("enabled: false");
    });

    it("pause via mid-write block-scalar origin is rejected (skill must use single-line)", async () => {
      // Plan §4.1.1 + §5.4 — a pause GET-merge-PUT that accidentally
      // promotes `origin` to a block scalar must fail. Catches the
      // line-scalar truncation hazard.
      const res = await putContext(
        `rules/policies/${POLICY_SLUG}`,
        policyContent({ origin: "|", status: "paused" }),
      );
      expect(res.status).toBe(422);
    });

    it("resume = policy.status:active + routine.enabled:true round-trips", async () => {
      await putContext(
        `rules/policies/${POLICY_SLUG}`,
        policyContent({ status: "paused", updated: "2026-04-25" }),
      );
      await putContext(
        `routines/custom/${POLICY_SLUG}`,
        routineContent({ enabled: "false" }),
      );
      // Resume.
      await putContext(
        `rules/policies/${POLICY_SLUG}`,
        policyContent({ status: "active", updated: "2026-04-26" }),
      );
      await putContext(
        `routines/custom/${POLICY_SLUG}`,
        routineContent({ enabled: "true" }),
      );

      const policyRead = await getContext(`rules/policies/${POLICY_SLUG}`);
      expect(policyRead.content).toContain("status: active");
      const routineRead = await getContext(`routines/custom/${POLICY_SLUG}`);
      expect(routineRead.content).toContain("enabled: true");
    });
  });

  describe("remove flow (plan §4.6)", () => {
    beforeEach(async () => {
      await putContext(`dossiers/${POLICY_TOPIC}`, dossierContent());
      await putContext(`routines/custom/${POLICY_SLUG}`, routineContent());
      await putContext(`rules/policies/${POLICY_SLUG}`, policyContent());
    });

    it("policy → status:removed; routine DELETEd; reload hook fires", async () => {
      // Step 1 — policy with status: removed (file kept for history).
      const policyRes = await putContext(
        `rules/policies/${POLICY_SLUG}`,
        policyContent({ status: "removed", updated: "2026-05-01" }),
      );
      expect(policyRes.status).toBe(200);

      // Step 2 — routine file DELETE (whitelisted on routines/custom/*).
      const routineDelete = await deleteContext(`routines/custom/${POLICY_SLUG}`);
      expect(routineDelete.status).toBe(200);

      // Policy file still exists for audit.
      expect(
        existsSync(
          join(contextDir, "policies", "management-captures", `${POLICY_SLUG}.md`),
        ),
      ).toBe(true);
      // Routine file is gone.
      expect(
        existsSync(
          join(contextDir, "policies", "routines", "custom", `${POLICY_SLUG}.md`),
        ),
      ).toBe(false);
    });

    it("removing a routine that no longer exists is idempotent (404 ignored by the skill)", async () => {
      // Plan §8 — pause/remove on a manually-deleted routine returns 404;
      // the skill is documented to ignore that and surface a warning.
      // Verify the API actually returns 404 (not 500) so the skill's
      // contract holds.
      await deleteContext(`routines/custom/${POLICY_SLUG}`);
      const second = await deleteContext(`routines/custom/${POLICY_SLUG}`);
      expect(second.status).toBe(404);
    });
  });

  describe("_index maintenance", () => {
    it("PATCH section=Active mode=append adds a row without disturbing Removed", async () => {
      const before = readFileSync(
        join(contextDir, "policies", "management-captures", "_index.md"),
        "utf-8",
      );
      expect(before).toContain("## Removed");

      await patchSection("policies/management-captures/_index", {
        section: "Active",
        mode: "append",
        content: "| a | active | 0 7 * * * | a | t | w |",
      });

      const after = readFileSync(
        join(contextDir, "policies", "management-captures", "_index.md"),
        "utf-8",
      );
      expect(after).toContain("| a | active | 0 7 * * * | a | t | w |");
      // The Removed section table headers survive intact.
      expect(after).toContain("## Removed");
      expect(after).toContain("| Slug | Removed at | Why |");
    });

    it("appending to a missing section returns 400 with availableSections list", async () => {
      // Plan §4.4.1 step 5.4 — on legacy installs that predate the
      // `## Active` section, PATCH section=append fails with 400 and
      // the body lists `availableSections`. That payload is the
      // trigger for the skill's GET-merge-PUT fallback. (Earlier
      // skill text claimed 404; this test pins the real 400 contract
      // so the skill doesn't drift.)
      const res = await patchSection("policies/management-captures/_index", {
        section: "NonExistent",
        mode: "append",
        content: "| x |",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        availableSections: string[];
      };
      expect(body.error).toBe("section_not_found");
      expect(body.availableSections).toContain("active");
    });
  });
});

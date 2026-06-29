// P22 — skill-curation API routes (the chokepoint for the optimizer agent).
//
// Read endpoints (always available, no opt-in):
//   GET  /skill-curation/skills
//   GET  /skill-curation/skills/:slug
//   GET  /skill-curation/skills/:slug/sections/:section_id
//   GET  /skill-curation/skills/:slug/sections/:section_id/history
//   GET  /skill-curation/signals
//   GET  /skill-curation/knowledge-map
//   GET  /skill-curation/proposals/:id
//   GET  /skill-curation/proposals
//   GET  /skill-curation/runs
//   GET  /skill-curation/orphans
//
// Mutation endpoints (gated by `skill_curation.config.enabled`):
//   POST /skill-curation/runs                          (test seam — direct token mint)
//   POST /skill-curation/runs/manual                   (owner via dashboard, Approve)
//   POST /skill-curation/proposals                     (optimizer agent — atomic apply)
//   POST /skill-curation/proposals/dryrun              (optimizer agent — validate only)
//   POST /skill-curation/runs/:id/finalize             (optimizer agent — last call)
//   POST /skill-curation/orphans/discard               (owner via dashboard, Approve)
//
// Per design §2.2, every successful proposal lands directly in
// `status='applied'` — there is no owner-approval queue, no `/approve` /
// `/reject` / `/revert` routes. Failed proposals (smoke_failed,
// diff_caps, render_budget) are persisted for inspection but do not
// write an overlay. The only roll-back path is the system-driven
// auto-revert in `auto-revert.ts` (`status='auto_reverted'`).
//
// The chokepoint POST /proposals runs through:
//   token verify → declaration check → kind match → Zod parse →
//   diff caps → render → byte budget → smoke test → applyProposal
//   (overlay write + history snapshot + audit) → markSignalsConsumed.

import { resolve } from "node:path";
import { Hono } from "hono";
import {
  createEvent,
  type CurationPayloadValue,
  DEFAULT_SKILL_CURATION_CONFIG,
  DiscardOrphanRequest,
  EventPriority,
  ManualRunRequest,
  type RoutineEvent,
  type SectionKind,
  SKILL_CURATION_BYTE_BUDGET,
  SkillCurationConfig,
  SubmitProposalRequest,
} from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import { readJsonBody } from "../json-body.js";
import { createLogger } from "../../logging.js";
import {
  applyProposal,
  type DiffSummary,
  recordFailedProposal,
} from "../../core/skill-curation/apply-proposal.js";
import { classifyDiff, exceedsDiffCaps, payloadEntryCount } from "../../core/skill-curation/classify-diff.js";
import {
  loadCurationDeclaration,
  loadAllCurationDeclarations,
} from "../../core/skill-curation/declarations.js";
import { buildKnowledgeMap } from "../../core/skill-curation/knowledge-map.js";
import { OverlayStore } from "../../core/skill-curation/overlay-store.js";
import { rendererVersionFor, renderCurationSection } from "../../core/skill-curation/render/index.js";
import { RunTokenManager } from "../../core/skill-curation/run-token.js";
import { runSmokeTest } from "../../core/skill-curation/smoke-test.js";
import {
  markSignalsConsumed,
  selectSkillsForRun,
  unconsumedSignalsAll,
  unconsumedSignalsForSkill,
} from "../../core/skill-curation/signals.js";
import { readFrozenSet as readFrozenSetShared } from "../../core/skill-curation/auto-revert.js";
import {
  detectOrphanOverlays,
  discardOrphanOverlay,
} from "../../core/skill-curation/orphan-overlay.js";
import { getContextDir } from "../../config.js";

const logger = createLogger("skill-curation-api");

const MAX_PROPOSALS_PER_RUN = 20;

export function createSkillCurationRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const runTokenManager = new RunTokenManager(deps.secretBroker as unknown as import("../../secrets/secret-store.js").SecretStore);
  // Note: SecretBroker doesn't expose internal secret accessors, so the API
  // route uses the underlying SecretStore (same pattern as encrypted-blob-store).
  // The cast is safe because both surfaces share the get/set/has/delete shape.
  const skillsRoot = resolve(process.cwd(), "agent-assets", "skills");
  const overlay = () => new OverlayStore(config.dataDir, skillsRoot);

  // ── Read endpoints ────────────────────────────────────────────────────

  app.get("/skill-curation/skills", (c) => {
    const all = loadAllCurationDeclarations(skillsRoot);
    const skills = all.map((d) => ({
      slug: d.slug,
      has_curation: d.declaration !== null,
      sections: d.declaration
        ? d.declaration.sections.map((s) => ({
            id: s.id,
            kind: s.kind,
            human_label: s.human_label,
            description: s.description,
          }))
        : [],
    }));
    return c.json({ skills });
  });

  app.get("/skill-curation/skills/:slug", (c) => {
    const slug = c.req.param("slug");
    const decl = loadCurationDeclaration(skillsRoot, slug);
    if (!decl) return c.json({ error: "skill_has_no_curation" }, 404);
    const ov = overlay();
    const sections = decl.sections.map((s) => {
      const env = ov.read(slug, s.id, s.kind);
      const counts = countProposalsForSection(db, slug, s.id);
      const frozen = isFrozen(db, slug, s.id);
      return {
        id: s.id,
        kind: s.kind,
        human_label: s.human_label,
        description: s.description,
        scope_paths: s.scope_paths,
        applied_overlay: env?.applied_proposal_id ?? null,
        applied_at: env?.applied_at ?? null,
        proposals: counts,
        frozen,
      };
    });
    return c.json({ slug, sections });
  });

  app.get("/skill-curation/skills/:slug/sections/:section_id", (c) => {
    const slug = c.req.param("slug");
    const sectionId = c.req.param("section_id");
    const decl = loadCurationDeclaration(skillsRoot, slug);
    if (!decl) return c.json({ error: "skill_has_no_curation" }, 404);
    const sec = decl.sections.find((s) => s.id === sectionId);
    if (!sec) return c.json({ error: "section_not_declared" }, 404);
    const env = overlay().read(slug, sectionId, sec.kind);
    return c.json({
      slug,
      section_id: sectionId,
      kind: sec.kind,
      payload: env ? env.payload : null,
      origin: env?.applied_proposal_id ? "overlay" : env ? "seed" : "empty",
    });
  });

  // §2.1 — per-section overlay history. Newest first; an empty list means
  // the section has never been written. Read-only audit surface.
  app.get("/skill-curation/skills/:slug/sections/:section_id/history", (c) => {
    const slug = c.req.param("slug");
    const sectionId = c.req.param("section_id");
    const decl = loadCurationDeclaration(skillsRoot, slug);
    if (!decl) return c.json({ error: "skill_has_no_curation" }, 404);
    const sec = decl.sections.find((s) => s.id === sectionId);
    if (!sec) return c.json({ error: "section_not_declared" }, 404);
    const rows = db
      .prepare(
        `SELECT id, run_id, status, diff_kind, diff_additions, diff_modifications,
                diff_removals, prev_payload_json, new_payload_json, rendered_md,
                rationale, proposed_at, decided_at, decided_by, applied_overlay_path
         FROM skill_curation_proposals
         WHERE skill_slug = ? AND section_id = ?
         ORDER BY proposed_at DESC
         LIMIT 50`,
      )
      .all(slug, sectionId) as Record<string, unknown>[];
    return c.json({
      slug,
      section_id: sectionId,
      kind: sec.kind,
      history: rows.map((r) => ({
        proposal_id: r.id,
        run_id: r.run_id,
        status: r.status,
        diff_kind: r.diff_kind,
        diff_additions: r.diff_additions,
        diff_modifications: r.diff_modifications,
        diff_removals: r.diff_removals,
        rationale: r.rationale,
        prev_payload: safeParse(r.prev_payload_json as string),
        new_payload: safeParse(r.new_payload_json as string),
        rendered_md: r.rendered_md,
        proposed_at: r.proposed_at,
        decided_at: r.decided_at,
        decided_by: r.decided_by,
        overlay_path: r.applied_overlay_path,
      })),
    });
  });

  app.get("/skill-curation/signals", (c) => {
    const skill = c.req.query("skill");
    const sinceParam = c.req.query("since");
    const since = sinceParam ? Date.parse(sinceParam) : null;
    const rows = skill ? unconsumedSignalsForSkill(db, skill) : unconsumedSignalsAll(db);
    const filtered = since !== null ? rows.filter((r) => r.observed_at >= since) : rows;
    return c.json({
      signals: filtered.map((s) => ({
        id: s.id,
        skill_slug: s.skill_slug,
        section_id: s.section_id,
        signal_type: s.signal_type,
        observed_at: s.observed_at,
        payload: safeParse(s.payload_json),
      })),
    });
  });

  app.get("/skill-curation/knowledge-map", (c) => {
    const scope = c.req.query("scope") ?? "all";
    const snap = buildKnowledgeMap(getContextDir(config));
    if (scope === "all") return c.json(snap);
    const filtered = {
      ...snap,
      files: snap.files.filter((f) => f.path.startsWith(`${scope}/`) || f.path === `${scope}.md`),
    };
    return c.json(filtered);
  });

  app.get("/skill-curation/proposals/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);
    const row = db.prepare(`SELECT * FROM skill_curation_proposals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({
      id: row.id,
      run_id: row.run_id,
      skill_slug: row.skill_slug,
      section_id: row.section_id,
      kind: row.section_kind,
      status: row.status,
      diff_kind: row.diff_kind,
      diff_additions: row.diff_additions,
      diff_modifications: row.diff_modifications,
      diff_removals: row.diff_removals,
      rationale: row.rationale,
      signals: safeParse(row.signals_json as string),
      rendered_md: row.rendered_md,
      proposed_at: row.proposed_at,
      decided_at: row.decided_at,
      decided_by: row.decided_by,
      smoke_failures: row.smoke_failures_json ? safeParse(row.smoke_failures_json as string) : null,
      payload: safeParse(row.new_payload_json as string),
      prev_payload: safeParse(row.prev_payload_json as string),
    });
  });

  // ── Mutation endpoints ────────────────────────────────────────────────

  // P22 §2.1 — direct run minting. In production this surface is unused:
  // the dispatcher's `materializeOptimizerWorkdir` (§3.4) is what actually
  // mints the runId/runToken and inserts the row, and the optimizer agent
  // reads both from its workdir preamble's env. This route exists for
  // completeness (and for tests that need to drive `/proposals` without
  // standing up a full dispatcher). The cadence-interval gate keys on the
  // resulting row's `started_at` regardless of which path created it.
  app.post("/skill-curation/runs", async (c) => {
    if (!isCurationEnabled(db)) return c.json({ error: "curation_disabled" }, 403);
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;
    const body = (bodyResult.body ?? {}) as { cadence?: string; backend?: string; model?: string; target_skills?: string[] };
    const cfg = readCurationConfig(db);
    const runId = `skcur-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const autoTargets = selectSkillsForRun(db, { excludedSlugs: new Set(cfg.excluded_skills) })
      .filter((s) => !s.cooldown_blocked)
      .map((s) => s.skill_slug);
    db.prepare(
      `INSERT INTO skill_curation_runs
        (id, started_at, cadence, backend, model, target_skills_json, status, is_manual)
       VALUES (?, ?, ?, ?, ?, ?, 'running', 0)`,
    ).run(
      runId,
      Date.now(),
      body.cadence ?? cfg.cadence,
      body.backend ?? cfg.backend,
      body.model ?? cfg.model,
      JSON.stringify(body.target_skills ?? autoTargets),
    );
    const token = await runTokenManager.mint(runId);
    return c.json({ runId, runToken: token.raw, expiresAt: token.expiresAt });
  });

  // P22 §6.4 — owner-clicked "Run optimization now" button. Emits a
  // `routine.skill_curation` event that the dispatcher's
  // `executeSkillCurationRoutine` consumes (see dispatcher.ts §3.4) — the
  // dispatcher materializes the optimizer workdir, which mints the runId,
  // run-token, and inserts the row with `is_manual=1`. The server here
  // is responsible only for: (a) authn + curation_disabled gate, (b)
  // single-run-at-a-time enforcement, (c) emitting the event. The
  // post-run cadence-interval gate keys on `is_manual=1` rows just like
  // it does for cron-driven runs (see scheduler.ts).
  app.post("/skill-curation/runs/manual", async (c) => {
    if (!isCurationEnabled(db)) return c.json({ error: "curation_disabled" }, 403);
    if (!deps.eventBus) return c.json({ error: "event_bus_unavailable" }, 503);
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;
    const parsed = ManualRunRequest.safeParse(bodyResult.body ?? {});
    if (!parsed.success) {
      return c.json({ error: "invalid_body", details: parsed.error.issues }, 422);
    }
    // One run at a time — concurrent manual clicks must be rejected with
    // a clear signal so the dashboard can disable the button.
    const inFlight = db
      .prepare(`SELECT id FROM skill_curation_runs WHERE status = 'running' LIMIT 1`)
      .get() as { id: string } | undefined;
    if (inFlight) {
      return c.json({ error: "run_in_flight", runId: inFlight.id }, 409);
    }
    const cfg = readCurationConfig(db);
    const event: RoutineEvent = {
      ...createEvent({
        type: "routine.skill_curation",
        source: "dashboard_manual_run",
        priority: EventPriority.HIGH,
        data: {
          cadence: cfg.cadence,
          manual: true,
          ...(parsed.data.target_skills ? { target_skills: parsed.data.target_skills } : {}),
        },
      }),
      routine: "skill_curation",
    };
    await deps.eventBus.put(event);
    logger.info({ source: "dashboard_manual_run" }, "Manual skill-curation run enqueued");
    return c.json({ ok: true });
  });

  app.post("/skill-curation/proposals", async (c) => {
    if (!isCurationEnabled(db)) return c.json({ error: "curation_disabled" }, 403);
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;
    const parsed = SubmitProposalRequest.safeParse(bodyResult.body);
    if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.issues }, 422);
    const req = parsed.data;

    // 1. Verify run-token (header) matches runId.
    const tokenHeader = c.req.header("x-optimizer-token");
    const tokenResult = await runTokenManager.verify(tokenHeader, req.runId);
    if (!tokenResult.ok) return c.json({ error: "bad_token", reason: tokenResult.error }, 403);

    // 2. Per-run rate limit — max 20 proposals.
    const runCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM skill_curation_proposals WHERE run_id = ?`)
      .get(req.runId) as { n: number }).n;
    if (runCount >= MAX_PROPOSALS_PER_RUN) {
      return c.json({ error: "rate_limit_exceeded", count: runCount, cap: MAX_PROPOSALS_PER_RUN }, 429);
    }

    return await processProposalSubmission(c, deps, req, false);
  });

  app.post("/skill-curation/proposals/dryrun", async (c) => {
    if (!isCurationEnabled(db)) return c.json({ error: "curation_disabled" }, 403);
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;
    const parsed = SubmitProposalRequest.safeParse(bodyResult.body);
    if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.issues }, 422);
    const req = parsed.data;
    const tokenHeader = c.req.header("x-optimizer-token");
    const tokenResult = await runTokenManager.verify(tokenHeader, req.runId);
    if (!tokenResult.ok) return c.json({ error: "bad_token", reason: tokenResult.error }, 403);
    return await processProposalSubmission(c, deps, req, true);
  });

  // §3.4 step 6 — optimizer's last call. With auto-apply, every passing
  // proposal already landed in `status='applied'` at submit time; this
  // endpoint only writes the run summary (counts + notes + finalized_at)
  // so the Settings page's "Recent runs" list has accurate totals.
  app.post("/skill-curation/runs/:id/finalize", async (c) => {
    if (!isCurationEnabled(db)) return c.json({ error: "curation_disabled" }, 403);
    const runId = c.req.param("id");
    const tokenHeader = c.req.header("x-optimizer-token");
    const tokenResult = await runTokenManager.verify(tokenHeader, runId);
    if (!tokenResult.ok) return c.json({ error: "bad_token", reason: tokenResult.error }, 403);
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;
    const body = (bodyResult.body ?? {}) as { notes?: string };
    const proposals = db
      .prepare(`SELECT id, status FROM skill_curation_proposals WHERE run_id = ?`)
      .all(runId) as { id: number; status: string }[];

    const counts = proposals.reduce<Record<string, number>>((acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    }, {});

    db.prepare(
      `UPDATE skill_curation_runs
       SET status = 'finalized', finalized_at = ?, proposal_count = ?, notes = ?
       WHERE id = ?`,
    ).run(Date.now(), proposals.length, body?.notes ?? null, runId);

    return c.json({
      runId,
      proposals_total: proposals.length,
      counts,
    });
  });

  // ── §6.2 settings (runtime_state) — config + recent runs + orphan list ─

  app.get("/settings/skill-curation", (c) => {
    const cfg = readCurationConfig(db);
    const recentRuns = db
      .prepare(
        `SELECT id, started_at, finalized_at, cadence, backend, model, status,
                proposal_count, target_skills_json, is_manual
         FROM skill_curation_runs
         ORDER BY started_at DESC
         LIMIT 5`,
      )
      .all() as {
      id: string;
      started_at: number;
      finalized_at: number | null;
      cadence: string;
      backend: string;
      model: string;
      status: string;
      proposal_count: number;
      target_skills_json: string;
      is_manual: number;
    }[];
    const eligibleSkills = loadAllCurationDeclarations(skillsRoot)
      .filter((d) => d.declaration !== null)
      .map((d) => d.slug);
    const orphanReport = detectOrphanOverlays(config.dataDir, skillsRoot);
    const runStats = aggregateRunStats(db, recentRuns.map((r) => r.id));
    return c.json({
      config: cfg,
      eligible_skills: eligibleSkills,
      // `counts` is an opaque map of `status → count` so adding a new
      // status enum value never requires touching this route. The
      // dashboard reads known keys (applied / auto_reverted / smoke_failed
      // / diff_caps / render_budget / conflict) and falls back to 0.
      recent_runs: recentRuns.map((r) => ({
        id: r.id,
        started_at: r.started_at,
        finalized_at: r.finalized_at,
        cadence: r.cadence,
        backend: r.backend,
        model: r.model,
        status: r.status,
        proposal_count: r.proposal_count,
        target_skills: safeParse(r.target_skills_json),
        is_manual: r.is_manual === 1,
        counts: runStats[r.id] ?? {},
      })),
      orphan_overlays: orphanReport.orphans,
    });
  });

  app.patch("/settings/skill-curation", async (c) => {
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;
    const current = readCurationConfig(db);
    const merged = { ...current, ...(bodyResult.body as object) };
    const parsed = SkillCurationConfig.safeParse(merged);
    if (!parsed.success) {
      return c.json({ error: "invalid_config", details: parsed.error.issues }, 422);
    }
    db.prepare(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES ('skill_curation.config', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(JSON.stringify(parsed.data));
    // §6.3 — re-derive cron when cadence/enabled changed.
    if (current.cadence !== parsed.data.cadence || current.enabled !== parsed.data.enabled) {
      try {
        deps.onScheduleConfigChanged?.();
      } catch (err) {
        logger.warn({ err }, "onScheduleConfigChanged hook failed");
      }
    }
    return c.json({ config: parsed.data });
  });

  // ── Listing endpoints used by the Settings page ──────────────────────

  app.get("/skill-curation/proposals", (c) => {
    const status = c.req.query("status");
    const skill = c.req.query("skill");
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) { where.push("status = ?"); params.push(status); }
    if (skill) { where.push("skill_slug = ?"); params.push(skill); }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT id, run_id, skill_slug, section_id, section_kind, status,
                diff_kind, diff_additions, diff_modifications, diff_removals,
                rationale, proposed_at, decided_at, decided_by
         FROM skill_curation_proposals
         ${whereClause}
         ORDER BY proposed_at DESC
         LIMIT ?`,
      )
      .all(...params, limit);
    return c.json({ proposals: rows });
  });

  app.get("/skill-curation/runs", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
    const rows = db
      .prepare(
        `SELECT id, started_at, finalized_at, cadence, backend, model, status,
                proposal_count, target_skills_json, is_manual
         FROM skill_curation_runs
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      started_at: number;
      finalized_at: number | null;
      cadence: string;
      backend: string;
      model: string;
      status: string;
      proposal_count: number;
      target_skills_json: string;
      is_manual: number;
    }[];
    return c.json({
      runs: rows.map((r) => ({
        id: r.id,
        started_at: r.started_at,
        finalized_at: r.finalized_at,
        cadence: r.cadence,
        backend: r.backend,
        model: r.model,
        status: r.status,
        proposal_count: r.proposal_count,
        target_skills: safeParse(r.target_skills_json),
        is_manual: r.is_manual === 1,
      })),
    });
  });

  // ── §5.4 orphan overlay surface ──

  app.get("/skill-curation/orphans", (c) => {
    const report = detectOrphanOverlays(config.dataDir, skillsRoot);
    return c.json({ orphans: report.orphans, scanned: report.scanned_overlays });
  });

  app.post("/skill-curation/orphans/discard", async (c) => {
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;
    const parsed = DiscardOrphanRequest.safeParse(bodyResult.body);
    if (!parsed.success) {
      return c.json({ error: "invalid_body", details: parsed.error.issues }, 422);
    }
    const r = discardOrphanOverlay(
      config.dataDir,
      skillsRoot,
      parsed.data.slug,
      parsed.data.section_id,
    );
    if (!r.ok) return c.json({ error: "discard_failed", reason: r.reason }, 409);
    return c.json({ ok: true, discarded: r.discarded_path });
  });

  return app;
}

async function processProposalSubmission(
  c: import("hono").Context,
  deps: ApiDependencies,
  req: import("@aitne/shared").SubmitProposalRequestValue,
  dryRun: boolean,
): Promise<Response> {
  const { db, config } = deps;
  const skillsRoot = resolve(process.cwd(), "agent-assets", "skills");
  const overlay = new OverlayStore(config.dataDir, skillsRoot);

  // 3. Skill must declare this section.
  const decl = loadCurationDeclaration(skillsRoot, req.skill_slug);
  if (!decl) return c.json({ error: "skill_has_no_curation" }, 404);
  const section = decl.sections.find((s) => s.id === req.section_id);
  if (!section) return c.json({ error: "section_not_declared" }, 404);

  // 4. Payload kind matches declared kind.
  if (req.payload.kind !== section.kind) {
    return c.json({ error: "kind_mismatch", expected: section.kind, got: req.payload.kind }, 422);
  }

  // 5. Zod is already validated by SubmitProposalRequest.

  // 6. Diff classification (cheap — payload-only, no I/O).
  const prevPayload =
    (overlay.readPayload(req.skill_slug, req.section_id, section.kind) as CurationPayloadValue | null)
    ?? emptyPayloadFor(section.kind);
  const diff = classifyDiff(prevPayload, req.payload, section.kind);
  const diffSummary: DiffSummary = {
    additions: diff.additions,
    modifications: diff.modifications,
    removals: diff.removals,
    kind: diff.kind,
  };

  // Common ProposalCore fields shared across apply/conflict/failure paths.
  // Built once so each gate's failure persistence reuses the same shape.
  // `rendered_md` is filled in after the render gate runs successfully.
  const core = {
    runId: req.runId,
    skill_slug: req.skill_slug,
    section_id: req.section_id,
    section_kind: section.kind,
    prev_payload: prevPayload,
    new_payload: req.payload,
    rendererVersion: rendererVersionFor(section.kind),
    rationale: req.rationale,
    signal_ids: req.signal_ids,
    diff: diffSummary,
  };

  // Closure used by every failure gate. Persists a failed-proposal row for
  // audit (so operators can investigate why the optimizer gave up) but
  // skips persistence in dry-run mode.
  const persistFailure = (
    status: "smoke_failed" | "diff_caps" | "render_budget",
    rendered_md: string,
    failure_detail: unknown,
  ): void => {
    if (dryRun) return;
    recordFailedProposal({ db, ...core, rendered_md, status, failure_detail });
  };

  // Gates run in cheap-to-expensive order so a bad payload short-circuits
  // before paying for render / smoke.

  // 7. Diff caps — payload-only comparison.
  const capsCheck = exceedsDiffCaps(diff, section.kind, payloadEntryCount(prevPayload));
  if (!capsCheck.ok) {
    persistFailure("diff_caps", "", { reason: capsCheck.reason, diff });
    return c.json({ error: "diff_caps_exceeded", reason: capsCheck.reason, diff }, 422);
  }

  // 8. Render to markdown. A render exception means the renderer rejected
  //    a Zod-valid payload — record under `render_budget` (the closest
  //    failure category for "rendered output is unusable") with an explicit
  //    reason in the failure_detail so the operator can distinguish it
  //    from byte-overrun on the dashboard.
  let rendered: string;
  try {
    rendered = renderCurationSection(section.kind, req.payload);
  /* c8 ignore next 5 — render throws only when payload.kind mismatches section.kind,
   * which cannot happen here because the kind_mismatch gate above already returned 422. */
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    persistFailure("render_budget", "", { reason: "render_failed", message });
    return c.json({ error: "render_failed", message }, 422);
  }

  // 9. Byte budget — bound the rendered SKILL.md fragment so anchored
  //    blocks stay within their per-kind ceiling (P22 §1.4.5).
  const renderedBytes = Buffer.byteLength(rendered, "utf-8");
  const byteBudget = SKILL_CURATION_BYTE_BUDGET[section.kind];
  if (renderedBytes > byteBudget) {
    persistFailure("render_budget", rendered, {
      reason: "byte_budget_exceeded",
      bytes: renderedBytes,
      budget: byteBudget,
    });
    return c.json(
      { error: "render_budget_exceeded", bytes: renderedBytes, budget: byteBudget },
      422,
    );
  }

  // 10. Smoke test — most expensive (filesystem snapshot + DB queries).
  const smoke = runSmokeTest({
    db,
    skill_slug: req.skill_slug,
    section_id: req.section_id,
    section_kind: section.kind,
    payload: req.payload,
    rendered_md: rendered,
    signal_ids: req.signal_ids,
    snapshot: buildKnowledgeMap(getContextDir(config)),
    overlay,
    frozenSet: readFrozenSetShared(db),
    siblingPayloads: collectSiblingPayloads(overlay, decl, req),
  });
  if (!smoke.ok) {
    persistFailure("smoke_failed", rendered, { failures: smoke.failures });
    return c.json({ error: "smoke_failed", failures: smoke.failures, diff }, 422);
  }

  if (dryRun) {
    return c.json({ ok: true, diff, rendered, dryRun: true });
  }

  // 11. Apply — inserts the row with `status='applied'`, writes the
  //     overlay JSON, snapshots prior history (inside OverlayStore.write),
  //     and emits an audit log entry. A conflict (current overlay differs
  //     from prev_payload) persists the row in `status='conflict'` without
  //     writing an overlay; signals stay unconsumed so the next run can
  //     retry with a fresh `prev_payload`.
  const apply = applyProposal({ db, overlay, ...core, rendered_md: rendered });
  /* c8 ignore next 6 — conflict requires two requests to interleave between
   * prevPayload read and applyProposal; not testable in single-threaded tests. */
  if (!apply.ok) {
    return c.json(
      { error: apply.status, message: apply.message, proposalId: apply.proposalId, diff },
      409,
    );
  }

  // 12. Mark signals consumed — only when an overlay actually landed.
  markSignalsConsumed(db, req.signal_ids, apply.proposalId);

  return c.json({
    proposalId: apply.proposalId,
    status: "applied",
    overlayPath: apply.overlayPath,
    rendered,
    diff,
  });
}

function collectSiblingPayloads(
  overlay: OverlayStore,
  decl: { sections: { id: string; kind: SectionKind }[] },
  req: import("@aitne/shared").SubmitProposalRequestValue,
): Record<string, CurationPayloadValue> {
  const out: Record<string, CurationPayloadValue> = {};
  for (const s of decl.sections) {
    if (s.id === req.section_id) continue;
    const p = overlay.readPayload(req.skill_slug, s.id, s.kind);
    if (p) out[s.id] = p;
  }
  return out;
}

function emptyPayloadFor(kind: SectionKind): CurationPayloadValue {
  switch (kind) {
    case "knowledge_layout":
      return { kind, files: [{ path: "_empty.md", purpose: "placeholder seed", sections: [{ heading: "## _", contains: "empty placeholder content" }] }] };
    case "routing_table":
      return { kind, rules: [{ trigger_pattern: "placeholder seed", destination_path: "_empty.md", destination_section: "## _", destination_mode: "append" }] };
    case "frontmatter_schema":
      return { kind, file_types: [{ glob: "_empty.md", required: [], conventional: [] }] };
    case "search_recipes":
      return { kind, recipes: [{ question_shape: "placeholder seed", lookup_path: "_empty.md" }] };
    case "convention_notes":
      return { kind, notes: [{ topic: "placeholder", rule: "Placeholder seed value." }] };
    case "cross_references":
      return { kind, refs: [{ from_path: "_empty.md", to_path: "_empty.md", relation: "placeholder seed" }] };
  }
}

function isCurationEnabled(db: import("better-sqlite3").Database): boolean {
  const row = db
    .prepare(`SELECT value_json FROM runtime_state WHERE key = 'skill_curation.config'`)
    .get() as { value_json: string } | undefined;
  if (!row) return false;
  try {
    const parsed = SkillCurationConfig.parse(JSON.parse(row.value_json));
    return parsed.enabled;
  } catch {
    return false;
  }
}

function readCurationConfig(db: import("better-sqlite3").Database) {
  const row = db
    .prepare(`SELECT value_json FROM runtime_state WHERE key = 'skill_curation.config'`)
    .get() as { value_json: string } | undefined;
  if (!row) return DEFAULT_SKILL_CURATION_CONFIG;
  try {
    return SkillCurationConfig.parse(JSON.parse(row.value_json));
  } catch {
    return DEFAULT_SKILL_CURATION_CONFIG;
  }
}

function isFrozen(db: import("better-sqlite3").Database, slug: string, sectionId: string): boolean {
  return readFrozenSetShared(db).has(`${slug}:${sectionId}`);
}

function aggregateRunStats(
  db: import("better-sqlite3").Database,
  runIds: string[],
): Record<string, Record<string, number>> {
  if (runIds.length === 0) return {};
  const placeholders = runIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT run_id, status, COUNT(*) AS n
       FROM skill_curation_proposals
       WHERE run_id IN (${placeholders})
       GROUP BY run_id, status`,
    )
    .all(...runIds) as { run_id: string; status: string; n: number }[];
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (!out[r.run_id]) out[r.run_id] = {};
    out[r.run_id][r.status] = r.n;
  }
  return out;
}

function countProposalsForSection(db: import("better-sqlite3").Database, slug: string, sectionId: string) {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n
       FROM skill_curation_proposals WHERE skill_slug = ? AND section_id = ?
       GROUP BY status`,
    )
    .all(slug, sectionId) as { status: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

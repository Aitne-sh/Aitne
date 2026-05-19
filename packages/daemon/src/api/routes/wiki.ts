import { Hono } from "hono";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  wikiBridgeProposalSchema,
  wikiFilePatchSchema,
  wikiFilePostSchema,
  wikiImportDecisionSchema,
  wikiWorkspaceCreateSchema,
  wikiWorkspacePatchSchema,
  wikiWorkspaceProbeSchema,
} from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";
import { writeFileAtomically } from "../../core/atomic-write.js";
import {
  buildWikiWorkspaceStats,
  createExternalWikiWorkspace,
  ensureDefaultWikiWorkspace,
  listWikiWorkspaces,
  readWikiWorkspaceByName,
  validateWikiRootPath,
  type WikiWorkspaceRow,
} from "../../core/wiki/workspaces.js";
import { probeExistingWikiVault } from "../../core/wiki/import-probe.js";
import {
  applyImportMigration,
  planImportMigration,
} from "../../core/wiki/import-migrate.js";
import { estimateFullCompileCost } from "../../core/wiki/cost-estimate.js";
import { buildCompilePreview } from "../../core/wiki/compile-preview.js";
import {
  isGitRepo,
  previewGitPreCompile,
} from "../../core/wiki/git-precompile.js";
import {
  WikiWriteStrategyResolver,
  probeWikiWriteStrategyHealth,
} from "../../core/wiki/write-strategy.js";
import { WikiIndexCache } from "../../core/wiki/index-cache.js";
import { BRIDGE_FILE_RE, processBridgeProposal } from "../../core/wiki/bridge.js";
import {
  deleteWikiFulltextWorkspace,
  reindexWikiWorkspace,
  searchWikiFulltext,
  upsertWikiFulltextRow,
  type WikiFtsLayer,
} from "../../core/wiki/wiki-fts.js";
import { z } from "zod";

const WIKI_BODY_MAX_BYTES = 512 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const OUTPUT_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

type WikiLayer = "inbox" | "raw" | "wiki" | "output" | "meta" | "log";

interface ClassifiedWikiPath {
  layer: WikiLayer;
  relPath: string;
}

const importApplyBodySchema = z.object({
  // §7 — `adopt` keeps existing schema and layout verbatim (no flatten,
  // no frontmatter rename — the wizard relies on `wiki-vault-rules` to
  // teach the agent the existing layout). `migrate` runs the full
  // flatten + rename pipeline. `split` is deferred to the multi-workspace
  // phase (§P5.C) and currently aborts with `import_split_unsupported`.
  // Body-less requests default to `migrate` so existing P2 callers
  // (dashboard wizard pre-decision) keep their current behaviour.
  decision: wikiImportDecisionSchema.optional(),
  allowConflicts: z.boolean().optional(),
  dateStamp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export function createWikiRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  // WIKI_BUILDER_DESIGN.md §14 Q6 — single per-route-set cache so all
  // `/index` reads (and writes that invalidate it) share the same
  // watcher/TTL state. Internal-mode reads bypass the cache inside
  // `WikiIndexCache.get`; external-mode reads register a chokidar
  // watcher on first access.
  const indexCache = new WikiIndexCache();
  // The strategy resolver is constructed lazily: the obsidian service is
  // only present once setup is complete, and a wiki workspace might exist
  // before it. The closure reads `deps.services.obsidian` per call so a
  // re-init that swaps the service does not strand a stale reference.
  function getStrategyResolver(): WikiWriteStrategyResolver | null {
    const obs = deps.services.obsidian;
    if (!obs) return null;
    return new WikiWriteStrategyResolver({ db: deps.db, obsidian: obs });
  }

  app.get("/wiki/workspaces", (c) => {
    return c.json({
      defaultWorkspace: "default",
      defaultInternalRoot: join(deps.config.dataDir, "wiki"),
      workspaces: listWikiWorkspaces(deps.db).map((row) =>
        serializeWorkspace(row, deps.db),
      ),
    });
  });

  // P2.C / §P5.C — workspace create. Empty body still defaults to the
  // internal-mode default workspace (the P1 quick path / wizard's
  // first-run hop). Phase 5 lifts the "one active workspace at a time"
  // ceiling: when the caller supplies an external `rootPath` AND a
  // distinct `name`, we add a second active workspace alongside the
  // first. Re-posting the same `name` is idempotent (re-activates an
  // archived row); re-posting without a name still resolves to the
  // default. Path-collision is enforced by `validateWikiRootPath` so
  // two external workspaces cannot overlap on disk.
  app.post("/wiki/workspaces", async (c) => {
    // Empty body — quick-path: the dashboard "Enable Wiki" CTA hits this
    // endpoint without payload. We pre-check whether the default already
    // exists so we don't accidentally re-seed an archived row's tree.
    let body: unknown = null;
    try {
      const text = await c.req.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text);
      }
    } catch {
      return c.json({ error: "invalid_json", message: "Body is not valid JSON." }, 400);
    }
    if (!body) {
      // No payload — re-emit the existing default (idempotent) or seed it.
      const workspace = ensureDefaultWikiWorkspace(deps.db, deps.config);
      const status = workspace.id > 0 && workspace.created_at !== workspace.updated_at ? 200 : 201;
      return c.json({ workspace: serializeWorkspace(workspace, deps.db) }, status);
    }
    const parsed = wikiWorkspaceCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", issues: parsed.error.issues },
        400,
      );
    }
    if (parsed.data.kind === "internal") {
      const workspace = ensureDefaultWikiWorkspace(deps.db, deps.config);
      return c.json({ workspace: serializeWorkspace(workspace, deps.db) }, 201);
    }
    // External — validate the root path before creating the row.
    const validation = validateWikiRootPath(
      parsed.data.rootPath!,
      deps.db,
      deps.config,
      { selfWorkspaceName: parsed.data.name },
    );
    if (!validation.ok) {
      return c.json(
        {
          error: validation.error ?? "invalid_root_path",
          message: validation.message ?? "Wiki root path failed validation.",
        },
        400,
      );
    }
    const workspace = createExternalWikiWorkspace(deps.db, deps.config, {
      name: parsed.data.name,
      rootPath: validation.resolvedPath ?? parsed.data.rootPath!,
      language: parsed.data.language,
    });
    return c.json({ workspace: serializeWorkspace(workspace, deps.db) }, 201);
  });

  // P2.C — pre-create probe. Returns the import-probe result without
  // touching the DB so the wizard can render the Adopt / Migrate / Split
  // branching and the path-collision diagnostics.
  app.post("/wiki/workspaces/probe", async (c) => {
    const parsedBody = await readJsonBody(c, { maxBytes: 8 * 1024 });
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = wikiWorkspaceProbeSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    const validation = validateWikiRootPath(parsed.data.rootPath, deps.db, deps.config);
    if (!validation.ok) {
      return c.json(
        {
          ok: false,
          error: validation.error,
          message: validation.message,
        },
        400,
      );
    }
    const probe = probeExistingWikiVault(validation.resolvedPath!);
    return c.json({ ok: true, validation, probe });
  });

  app.patch("/wiki/workspaces/:workspace", async (c) => {
    const workspaceName = c.req.param("workspace");
    const workspace = readWikiWorkspaceByName(deps.db, workspaceName);
    if (!workspace) {
      return respondWithAgentError(c, 404, [
        composeIssue("wiki.workspace_not_found", {
          field: "workspace",
          received: workspaceName,
        }),
      ], { legacyFields: { message: "Wiki workspace not found" } });
    }
    const parsedBody = await readJsonBody(c, { maxBytes: 16 * 1024 });
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = wikiWorkspacePatchSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", issues: parsed.error.issues },
        400,
      );
    }
    deps.db
      .prepare(
        `UPDATE wiki_workspaces
         SET language = COALESCE(?, language),
             dispatch_mode = COALESCE(?, dispatch_mode),
             concurrency_cap = COALESCE(?, concurrency_cap),
             dm_agent_write_enabled = COALESCE(?, dm_agent_write_enabled),
             bridge_enabled = COALESCE(?, bridge_enabled),
             bridge_measurement_only = COALESCE(?, bridge_measurement_only),
             bridge_min_confidence = COALESCE(?, bridge_min_confidence),
             full_compile_approval_threshold_usd = COALESCE(?, full_compile_approval_threshold_usd),
             write_strategy = COALESCE(?, write_strategy),
             git_pre_compile_enabled = COALESCE(?, git_pre_compile_enabled),
             active = COALESCE(?, active),
             updated_at = CURRENT_TIMESTAMP
         WHERE name = ?`,
      )
      .run(
        parsed.data.language ?? null,
        parsed.data.dispatchMode ?? null,
        parsed.data.concurrencyCap ?? null,
        parsed.data.dmAgentWriteEnabled === undefined
          ? null
          : Number(parsed.data.dmAgentWriteEnabled),
        parsed.data.bridgeEnabled === undefined ? null : Number(parsed.data.bridgeEnabled),
        parsed.data.bridgeMeasurementOnly === undefined
          ? null
          : Number(parsed.data.bridgeMeasurementOnly),
        parsed.data.bridgeMinConfidence ?? null,
        parsed.data.fullCompileApprovalThresholdUsd ?? null,
        parsed.data.writeStrategy ?? null,
        parsed.data.gitPreCompileEnabled === undefined
          ? null
          : Number(parsed.data.gitPreCompileEnabled),
        parsed.data.active === undefined ? null : Number(parsed.data.active),
        workspaceName,
      );
    const updated = readWikiWorkspaceByName(deps.db, workspaceName);
    return c.json({ workspace: serializeWorkspace(updated ?? workspace, deps.db) });
  });

  app.post("/wiki/workspaces/:workspace/archive", (c) => {
    const workspaceName = c.req.param("workspace");
    const workspace = readWikiWorkspaceByName(deps.db, workspaceName);
    if (!workspace) {
      return respondWithAgentError(c, 404, [
        composeIssue("wiki.workspace_not_found", {
          field: "workspace",
          received: workspaceName,
        }),
      ], { legacyFields: { message: "Wiki workspace not found" } });
    }
    deps.db
      .prepare(
        `UPDATE wiki_workspaces
         SET active = 0, updated_at = CURRENT_TIMESTAMP
         WHERE name = ?`,
      )
      .run(workspaceName);
    // §P4.A — archived workspaces drop out of `/search` results because
    // `resolveRequestWorkspace` rejects active=0, but the FTS rows stay
    // accessible to any direct caller that knows the workspace_id. Clear
    // them eagerly so a re-enable on the same id pulls fresh content from
    // disk via the boot backfill or the `/reindex` endpoint.
    deleteWikiFulltextWorkspace(deps.db, workspace.id);
    return c.json({ ok: true });
  });

  app.delete("/wiki/workspaces/:workspace", (c) => {
    const workspaceName = c.req.param("workspace");
    const workspace = readWikiWorkspaceByName(deps.db, workspaceName);
    if (!workspace) {
      return respondWithAgentError(c, 404, [
        composeIssue("wiki.workspace_not_found", {
          field: "workspace",
          received: workspaceName,
        }),
      ], { legacyFields: { message: "Wiki workspace not found" } });
    }
    deleteWikiFulltextWorkspace(deps.db, workspace.id);
    deps.db.prepare(`DELETE FROM wiki_workspaces WHERE name = ?`).run(workspaceName);
    return c.json({ ok: true, rootPathPreserved: workspace.root_path });
  });

  // P2.E — cost estimate endpoint. Pure JS, no agent session. The dashboard
  // banner and the bang-handler approval gate both read from this so the
  // numbers cannot drift. P4.C — now token-level (per-file char-based
  // scaling) by default; legacy flat-heuristic is reachable via
  // `?strategy=flat`.
  app.get("/wiki/:workspace/estimate", (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "GET", null);
    if (auth) return auth;
    const strategy = (c.req.query("strategy") ?? "per-file").toLowerCase();
    const estimate =
      strategy === "flat"
        ? estimateFullCompileCost(workspace.row, { avgInputTokensPerRaw: 1500 })
        : estimateFullCompileCost(workspace.row);
    return c.json({ workspace: workspace.row.name, estimate });
  });

  // §P4.B — compile diff preview. Mirrors `!compile --preview` in HTTP form
  // so the dashboard can render the touch set / cost / duration before
  // the operator approves the real compile. Pure JS — no agent session.
  app.get("/wiki/:workspace/compile/preview", (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "GET", null);
    if (auth) return auth;
    const modeParam = c.req.query("mode") ?? "incremental";
    const mode = modeParam === "full" ? "full" : "incremental";
    const preview = buildCompilePreview({ workspace: workspace.row, mode });
    return c.json({ workspace: workspace.row.name, preview });
  });

  // P2.D — existing-vault import flow. Two-step: GET /import/plan inspects
  // the vault, POST /import/apply commits the migration. The plan is also
  // exposed via the wizard's /probe response, but a dedicated endpoint
  // matches the dashboard's "review plan → apply" UX.
  app.get("/wiki/:workspace/import/plan", (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "GET", null);
    if (auth) return auth;
    const probe = probeExistingWikiVault(workspace.row.root_path);
    const plan = planImportMigration(workspace.row.root_path);
    return c.json({ workspace: workspace.row.name, probe, plan });
  });

  app.post("/wiki/:workspace/import/apply", async (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "POST", null);
    if (auth) return auth;
    const parsedBody = await readJsonBody(c, { maxBytes: 4 * 1024 });
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = importApplyBodySchema.safeParse(parsedBody.body ?? {});
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    const decision = parsed.data.decision ?? "migrate";
    if (decision === "split") {
      return c.json(
        {
          error: "import_split_unsupported",
          message:
            "Split is deferred until the multi-workspace phase. Run the import-apply against the existing workspace with `decision: \"adopt\"` or `\"migrate\"`.",
        },
        501,
      );
    }
    const plan = planImportMigration(workspace.row.root_path);
    if (decision === "adopt") {
      // Adopt = no flatten, no frontmatter rename. The agent learns the
      // existing layout from `wiki-vault-rules`. We still emit a probe
      // snapshot for the wizard, plus a degenerate "no-op" plan so the
      // dashboard can render a consistent shape.
      return c.json({
        workspace: workspace.row.name,
        decision,
        plan: {
          ...plan,
          flattenMoves: [],
          frontmatterMigrations: [],
        },
        outcome: {
          backupDir: null,
          filesWritten: 0,
          filesMoved: 0,
        },
      });
    }
    try {
      const outcome = applyImportMigration(plan, {
        dateStamp: parsed.data.dateStamp,
        allowConflicts: parsed.data.allowConflicts,
      });
      // §P4.A — the migration flattens/renames files on disk without going
      // through the wiki write chokepoint, so the FTS index is stale until
      // we rebuild it. The boot-time backfill only fires when the per-
      // workspace row count is zero; for workspaces that already had FTS
      // rows before the migration we need an explicit reindex so search
      // results match the new on-disk shape immediately. Boot-time backfill
      // alone would only help after a daemon restart.
      const ftsOutcome = reindexWikiWorkspace(deps.db, workspace.row);
      return c.json({
        workspace: workspace.row.name,
        decision,
        plan,
        outcome,
        ftsReindex: ftsOutcome,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EWIKI_IMPORT_CONFLICT") {
        return c.json(
          {
            error: "import_conflict",
            message: err instanceof Error ? err.message : "Conflict",
            conflicts: plan.conflicts,
          },
          409,
        );
      }
      throw err;
    }
  });

  // P2.E — pre-compile git status surface. Lets the dashboard render the
  // commit/stash hint before the operator runs `!compile full`. This is a
  // strict GET: `previewGitPreCompile` reads `git status` only, never
  // runs `add`/`commit`, so dashboard polling cannot create empty commits.
  app.get("/wiki/:workspace/git/status", async (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "GET", null);
    if (auth) return auth;
    const isRepo = isGitRepo(workspace.row.root_path);
    const preview = await previewGitPreCompile(workspace.row);
    return c.json({
      workspace: workspace.row.name,
      kind: workspace.row.kind,
      isGitRepo: isRepo,
      gitPreCompileEnabled: workspace.row.git_pre_compile_enabled === 1,
      preview,
    });
  });

  // P2.B — health probe for the resolved write strategy. Surfaced under
  // /api/health.wiki via `/health` aggregation when it lands; for now it
  // is also reachable directly for the dashboard's strategy badge.
  app.get("/wiki/:workspace/health", async (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "GET", null);
    if (auth) return auth;
    const obs = deps.services.obsidian;
    if (workspace.row.kind === "external" && !obs) {
      return c.json({
        workspace: workspace.row.name,
        kind: workspace.row.kind,
        strategy: workspace.row.write_strategy,
        cliAvailable: false,
        notes: "Obsidian service not configured; CLI fallback unavailable.",
      });
    }
    if (!obs) {
      // Internal workspace, no obsidian service — still safe: no fallback needed.
      return c.json({
        workspace: workspace.row.name,
        kind: workspace.row.kind,
        strategy: "fs",
        cliAvailable: null,
      });
    }
    const health = await probeWikiWriteStrategyHealth(workspace.row, obs);
    return c.json(health);
  });

  app.get("/wiki/:workspace/search", (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "GET", null);
    if (auth) return auth;
    const q = c.req.query("q")?.trim() ?? "";
    const limit = Math.max(1, Math.min(50, Number(c.req.query("limit") ?? 20)));
    // §P4.A — `kind` selects the backend. `fts` (default) queries the
    // SQLite FTS5 virtual table maintained by wiki-fts.ts. `grep` is the
    // legacy substring fallback retained for callers that want a literal
    // case-insensitive match or when FTS5 returns zero hits for terms
    // the tokenizer split (e.g. trailing/embedded punctuation).
    const requestedKind = (c.req.query("kind") ?? "fts").toLowerCase();
    const kind = requestedKind === "grep" ? "grep" : "fts";
    const layerParam = c.req.query("layer");
    const layer = isWikiFtsLayer(layerParam) ? layerParam : undefined;
    if (kind === "fts") {
      const results = searchWikiFulltext(deps.db, workspace.row.id, q, { layer, limit });
      // Empty-query is a valid "list-everything" UX in the previous
      // implementation but FTS5 rejects empty MATCH. Fall back to grep
      // for that single case so the route remains backward-compatible
      // with callers that issue `/search?q=` to enumerate the vault.
      if (results.length === 0 && q.length === 0) {
        return c.json({
          workspace: workspace.row.name,
          kind: "grep",
          results: searchWikiFiles(workspace.row.root_path, q.toLowerCase(), limit),
        });
      }
      return c.json({ workspace: workspace.row.name, kind: "fts", results });
    }
    return c.json({
      workspace: workspace.row.name,
      kind: "grep",
      results: searchWikiFiles(workspace.row.root_path, q.toLowerCase(), limit),
    });
  });

  // §P4.A — operator escape hatch. Walks the workspace tree and rebuilds
  // the FTS5 index from disk. Used when the index drifts (e.g. external
  // vault edited outside the daemon, or after the schema is rebuilt by
  // `aitne reinstall`). Requires a wiki-tier process key so it cannot be
  // triggered from a DM session.
  app.post("/wiki/:workspace/reindex", (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "POST", null);
    if (auth) return auth;
    const outcome = reindexWikiWorkspace(deps.db, workspace.row);
    return c.json({ workspace: workspace.row.name, ...outcome });
  });

  app.get("/wiki/:workspace/index", (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "GET", null);
    if (auth) return auth;
    // WIKI_BUILDER_DESIGN.md §8 — `/index` is the `_index.md` catalog
    // (not a generic file listing). The file tree is still useful for the
    // DM-agent's `Bash(curl)` workflow (§9.4), so we keep it alongside
    // the cached catalog. External-mode reads go through `WikiIndexCache`
    // (§14 Q6); internal mode short-circuits to disk inside `get()`.
    const snapshot = indexCache.get(workspace.row);
    return c.json({
      workspace: workspace.row.name,
      rootPath: workspace.row.root_path,
      indexFile: snapshot,
      files: listWikiIndex(workspace.row.root_path),
    });
  });

  // WIKI_BUILDER_DESIGN.md §P5.A / §P5.B — bridge proposal endpoint.
  //
  // The DM agent's `wiki-bridge` skill (and any future in-process
  // caller) POSTs a proposal here. The route enforces the two-key
  // safety (`bridge_enabled` AND `dm_agent_write_enabled`) for DM-tier
  // callers, defers the trigger-confidence-dedup-loopguard cascade to
  // the pure `processBridgeProposal` helper, and surfaces the outcome
  // back to the caller for reply phrasing.
  //
  // Auth shape:
  //   - DM-tier process keys are accepted (the agent is the proposer);
  //     they must come paired with both workspace toggles on.
  //   - Wiki-tier process keys are accepted unconditionally — internal
  //     callers (a hypothetical `wiki.bridge_propose` background task)
  //     do not need owner consent because the dispatcher already gates
  //     them on Approve tier.
  app.post("/wiki/:workspace/bridge", async (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const processKey = c.req.header("x-process-key");
    if (!processKey) {
      return c.json(
        { error: "forbidden", code: "missing_process_key", message: "x-process-key is required" },
        403,
      );
    }
    const isDmTier = isDmReadProcess(processKey);
    const isWikiTier = processKey.startsWith("wiki.");
    if (!isDmTier && !isWikiTier) {
      return c.json({ error: "forbidden", code: "bridge_write_denied" }, 403);
    }
    if (isDmTier) {
      if (workspace.row.dm_agent_write_enabled !== 1) {
        return c.json(
          {
            error: "forbidden",
            code: "dm_write_disabled",
            message: "Enable `Allow DM agent bridge writes` in /settings/wiki.",
          },
          403,
        );
      }
      if (workspace.row.bridge_enabled !== 1) {
        return c.json(
          {
            error: "forbidden",
            code: "bridge_feature_disabled",
            message: "Enable the Bridge feature in /settings/wiki.",
          },
          403,
        );
      }
    }
    const parsedBody = await readJsonBody(c, { maxBytes: 32 * 1024 });
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = wikiBridgeProposalSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    // Inject a strategy-aware writer so bridge files on external-mode
    // vaults (iCloud-sandboxed) fall back to the Obsidian CLI rather
    // than EPERM-ing out of the raw write path. Internal workspaces
    // still take the local-fs path inside the resolver. When the
    // obsidian service is unavailable we omit the override entirely
    // and the processor falls back to `writeFileAtomically` (correct
    // for internal mode; for external mode this matches the
    // pre-fix behaviour and lets the EPERM surface to the caller).
    const bridgeStrategyResolver =
      workspace.row.kind === "external" ? getStrategyResolver() : null;
    const writeFile = bridgeStrategyResolver
      ? async (relPath: string, content: string): Promise<void> => {
          await bridgeStrategyResolver.writeFile({
            workspace: workspace.row,
            relPath,
            content,
          });
        }
      : undefined;
    const result = await processBridgeProposal({
      db: deps.db,
      workspace: workspace.row,
      proposal: parsed.data,
      actor: isWikiTier ? "wiki-agent" : "dm-agent",
      ...(writeFile ? { writeFile } : {}),
    });
    const status = result.outcome === "written" ? 201 : 200;
    return c.json({ result }, status);
  });

  // GET /wiki/:ws/bridge — list recent bridge audit rows for the
  // dashboard's "observation log" view. `since` (ISO) windows results;
  // `limit` clamps to 200. Wiki-tier and DM-tier callers can read.
  app.get("/wiki/:workspace/bridge", (c) => {
    const workspace = resolveRequestWorkspace(deps, c.req.param("workspace"));
    if ("response" in workspace) return workspace.response;
    const auth = authorizeWikiRequest(workspace.row, c.req.header("x-process-key"), "GET", null);
    if (auth) return auth;
    const since = c.req.query("since");
    const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
    const rows = deps.db
      .prepare(
        `SELECT id, action_type, result, detail, started_at
         FROM agent_actions
         WHERE source_kind = 'wiki' AND source_ref = ?
           AND (action_type = 'wiki.bridge'
                OR action_type = 'wiki.bridge.candidate'
                OR action_type = 'wiki.bridge.dedup'
                OR action_type = 'wiki.bridge.skip')
           AND (? IS NULL OR started_at >= ?)
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(workspace.row.name, since ?? null, since ?? null, limit) as Array<{
        id: number;
        action_type: string;
        result: string;
        detail: string;
        started_at: string;
      }>;
    const entries = rows.map((row) => {
      let detail: Record<string, unknown> = {};
      try {
        detail = JSON.parse(row.detail) as Record<string, unknown>;
      } catch {
        detail = {};
      }
      return {
        id: row.id,
        actionType: row.action_type,
        result: row.result,
        detectedAt: row.started_at,
        outcome: detail.outcome ?? null,
        trigger: detail.trigger ?? null,
        confidence: detail.confidence ?? null,
        contentHash: detail.content_hash ?? null,
        targets: Array.isArray(detail.targets) ? detail.targets : [],
        existingPath: detail.existing_path ?? null,
        sourceKindOf: detail.source_kind_of ?? null,
        sourceRefOf: detail.source_ref_of ?? null,
      };
    });
    return c.json({ workspace: workspace.row.name, entries });
  });

  // Hono 4.x does not surface bare `*` captures via `c.req.param("*")` (it
  // always returns `undefined`), so the wildcard is declared as a named
  // parameter with a regex constraint instead. `:path{.+}` matches a single
  // segment OR a `/`-joined chain, and `c.req.param("path")` is already
  // percent-decoded by Hono — no manual `decodeURIComponent` needed.
  app.get("/wiki/:workspace/files/:path{.+}", (c) => {
    const workspaceName = c.req.param("workspace");
    const workspace = resolveRequestWorkspace(deps, workspaceName);
    if ("response" in workspace) return workspace.response;
    const resolved = resolveWikiFileTarget(workspace.row, c.req.param("path"));
    if ("response" in resolved) return resolved.response;
    const auth = authorizeWikiRequest(
      workspace.row,
      c.req.header("x-process-key"),
      "GET",
      resolved.classified,
    );
    if (auth) return auth;
    if (!existsSync(resolved.fullPath)) {
      return respondWithAgentError(c, 404, [
        composeIssue("wiki.file_not_found", {
          field: "path",
          received: resolved.classified.relPath,
        }),
      ], { legacyFields: { path: resolved.classified.relPath } });
    }
    const stat = statSync(resolved.fullPath);
    if (!stat.isFile()) {
      return respondWithAgentError(c, 400, [
        composeIssue("wiki.not_file", {
          field: "path",
          received: resolved.classified.relPath,
        }),
      ], { legacyFields: { path: resolved.classified.relPath } });
    }
    return c.json({
      path: resolved.classified.relPath,
      content: readFileSync(resolved.fullPath, "utf-8"),
      mtime: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    });
  });

  app.post("/wiki/:workspace/files/:path{.+}", async (c) => {
    const workspaceName = c.req.param("workspace");
    const workspace = resolveRequestWorkspace(deps, workspaceName);
    if ("response" in workspace) return workspace.response;
    const resolved = resolveWikiFileTarget(workspace.row, c.req.param("path"));
    if ("response" in resolved) return resolved.response;
    const processKey = c.req.header("x-process-key");
    const auth = authorizeWikiRequest(workspace.row, processKey, "POST", resolved.classified);
    if (auth) return auth;
    const parsedBody = await readJsonBody(c, { maxBytes: WIKI_BODY_MAX_BYTES });
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = wikiFilePostSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    if (resolved.classified.layer === "raw" && existsSync(resolved.fullPath)) {
      return respondWithAgentError(c, 409, [
        composeIssue("wiki.append_only_raw", {
          field: "path",
          received: resolved.classified.relPath,
        }),
      ], { legacyFields: { message: "10_raw files are create-only" } });
    }
    if (resolved.classified.layer === "log" && existsSync(resolved.fullPath)) {
      return respondWithAgentError(c, 409, [
        composeIssue("wiki.append_only_log", {
          field: "path",
          received: resolved.classified.relPath,
        }),
      ], { legacyFields: { message: "Use PATCH to append log.md" } });
    }
    snapshotIfNeeded(workspace.row, resolved.classified.relPath, resolved.fullPath);
    const normalizedPostBody = ensureTrailingNewline(parsed.data.content);
    await writeWikiFile(workspace.row, resolved.classified.relPath, normalizedPostBody);
    syncWikiFts(
      deps.db,
      workspace.row.id,
      resolved.classified,
      normalizedPostBody,
    );
    recordWikiWrite(
      deps.db,
      workspace.row,
      processKey ?? "unknown",
      "post",
      resolved.classified.relPath,
      Buffer.byteLength(normalizedPostBody, "utf8"),
    );
    updateWikiProcessTimestamp(deps.db, workspace.row.name, processKey);
    await appendWikiLog(workspace.row, processKey ?? "unknown", "post", resolved.classified.relPath);
    return c.json({ ok: true, path: resolved.classified.relPath });
  });

  app.patch("/wiki/:workspace/files/:path{.+}", async (c) => {
    const workspaceName = c.req.param("workspace");
    const workspace = resolveRequestWorkspace(deps, workspaceName);
    if ("response" in workspace) return workspace.response;
    const resolved = resolveWikiFileTarget(workspace.row, c.req.param("path"));
    if ("response" in resolved) return resolved.response;
    const processKey = c.req.header("x-process-key");
    const auth = authorizeWikiRequest(workspace.row, processKey, "PATCH", resolved.classified);
    if (auth) return auth;
    if (resolved.classified.layer === "raw") {
      return respondWithAgentError(c, 409, [
        composeIssue("wiki.raw_patch_forbidden", {
          field: "path",
          received: resolved.classified.relPath,
        }),
      ], { legacyFields: { message: "10_raw files cannot be patched" } });
    }
    const parsedBody = await readJsonBody(c, { maxBytes: WIKI_BODY_MAX_BYTES });
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = wikiFilePatchSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    const previous = existsSync(resolved.fullPath)
      ? readFileSync(resolved.fullPath, "utf-8")
      : "";
    snapshotIfNeeded(workspace.row, resolved.classified.relPath, resolved.fullPath);
    const content =
      parsed.data.mode === "prepend"
        ? `${ensureTrailingNewline(parsed.data.content)}${previous}`
        : `${previous}${ensureLeadingNewline(parsed.data.content)}`;
    await writeWikiFile(workspace.row, resolved.classified.relPath, content);
    syncWikiFts(deps.db, workspace.row.id, resolved.classified, content);
    recordWikiWrite(
      deps.db,
      workspace.row,
      processKey ?? "unknown",
      "patch",
      resolved.classified.relPath,
      Buffer.byteLength(content, "utf8"),
    );
    updateWikiProcessTimestamp(deps.db, workspace.row.name, processKey);
    if (resolved.classified.layer !== "log") {
      await appendWikiLog(workspace.row, processKey ?? "unknown", "patch", resolved.classified.relPath);
    }
    return c.json({ ok: true, path: resolved.classified.relPath });
  });

  return app;

  async function writeWikiFile(
    workspace: WikiWorkspaceRow,
    relPath: string,
    content: string,
  ): Promise<void> {
    // External workspaces try fs first then fall back to the Obsidian CLI
    // when the OS rejects the write — typical for iCloud-sandboxed vaults.
    // Internal workspaces always take the local-fs path. The resolver
    // persists the resolved strategy back into the row so the probe
    // is amortised across daemon restarts.
    try {
      if (workspace.kind === "external") {
        const resolver = getStrategyResolver();
        if (resolver) {
          await resolver.writeFile({ workspace, relPath, content });
          return;
        }
      }
      writeFileAtomically(resolve(workspace.root_path, relPath), content);
    } finally {
      // WIKI_BUILDER_DESIGN.md §14 Q6 — invalidate the cached catalog when
      // `_index.md` is rewritten. We do this in `finally` so a failed
      // partial write still invalidates rather than serving stale.
      if (relPath === "20_wiki/_index.md") {
        indexCache.invalidate(workspace.id);
      }
    }
  }

  async function appendWikiLog(
    workspace: WikiWorkspaceRow,
    processKey: string,
    operation: string,
    relPath: string,
  ): Promise<void> {
    const logRelPath = "log.md";
    const fullPath = resolve(workspace.root_path, logRelPath);
    const previous = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : "# Wiki Log\n\n";
    const line = `- ${new Date().toISOString()} ${processKey} ${operation} ${relPath}\n`;
    const next = `${previous}${previous.endsWith("\n") ? "" : "\n"}${line}`;
    await writeWikiFile(workspace, logRelPath, next);
  }
}

function resolveRequestWorkspace(
  deps: ApiDependencies,
  name: string,
): { row: WikiWorkspaceRow } | { response: Response } {
  const row = readWikiWorkspaceByName(deps.db, name);
  // WIKI_BUILDER_DESIGN.md §0 / §8 — opt-in invariant. A missing row OR an
  // archived row (active=0) means the wiki is disabled for callers. Return
  // the design-prescribed `wiki_not_enabled` shape so the dashboard / agent
  // sessions can react with the enable hint instead of treating it as a
  // generic 404.
  if (!row || row.active !== 1) {
    return {
      response: new Response(
        JSON.stringify({
          error: "wiki_not_enabled",
          hint: "Open /settings/wiki to enable",
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    };
  }
  return { row };
}

function resolveWikiFileTarget(
  workspace: WikiWorkspaceRow,
  rawPath: string | undefined,
): { classified: ClassifiedWikiPath; fullPath: string } | { response: Response } {
  // `c.req.param("path")` is already percent-decoded by Hono; the route
  // regex (`:path{.+}`) also guarantees a non-empty match before this
  // function runs. The `?? ""` is purely defensive against a future
  // refactor that bypasses the route param.
  const relPath = normalizeRelativeWikiPath(rawPath ?? "");
  if (!relPath) {
    return jsonResponse({ error: "invalid_path", message: "Invalid wiki path" }, 400);
  }
  const classified = classifyWikiPath(relPath);
  if (!classified) {
    return jsonResponse({ error: "invalid_layer", message: "Path is outside the wiki layer contract" }, 400);
  }
  const fullPath = resolve(workspace.root_path, classified.relPath);
  const rel = relative(workspace.root_path, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return jsonResponse({ error: "invalid_path", message: "Path escapes workspace root" }, 400);
  }
  return { classified, fullPath };
}

function normalizeRelativeWikiPath(input: string): string | null {
  if (!input || input.includes("\\") || input.includes("\0")) return null;
  if (isAbsolute(input)) return null;
  const parts = input.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    return null;
  }
  return parts.join("/");
}

function classifyWikiPath(relPath: string): ClassifiedWikiPath | null {
  if (relPath === "log.md") return { layer: "log", relPath };
  const [root, ...rest] = relPath.split("/");
  const leaf = rest.at(-1) ?? "";
  const stem = leaf.endsWith(".md") ? leaf.slice(0, -3) : leaf;
  switch (root) {
    case "00_inbox":
      return rest.length > 0 ? { layer: "inbox", relPath } : null;
    case "10_raw":
      if (rest.length === 1 && leaf.endsWith(".md") && SLUG_RE.test(stem)) {
        return { layer: "raw", relPath };
      }
      if (rest.length === 3 && rest[0] === "images" && SLUG_RE.test(rest[1])) {
        return { layer: "raw", relPath };
      }
      return null;
    case "20_wiki":
      if (rest.length !== 1 || !leaf.endsWith(".md")) return null;
      if (stem === "_index" || SLUG_RE.test(stem)) return { layer: "wiki", relPath };
      return null;
    case "30_outputs":
      if (rest.length === 1 && leaf.endsWith(".md") && OUTPUT_RE.test(stem)) {
        return { layer: "output", relPath };
      }
      return null;
    case "90_meta":
      if (relPath === "90_meta/taxonomy.md") return { layer: "meta", relPath };
      if (
        rest.length === 2 &&
        (rest[0] === "schemas" || rest[0] === "health") &&
        leaf.endsWith(".md") &&
        SLUG_RE.test(stem)
      ) {
        return { layer: "meta", relPath };
      }
      return null;
    default:
      return null;
  }
}

function authorizeWikiRequest(
  workspace: WikiWorkspaceRow,
  processKey: string | undefined,
  method: "GET" | "POST" | "PATCH",
  target: ClassifiedWikiPath | null,
): Response | null {
  if (!processKey) {
    return rawJson({ error: "forbidden", code: "missing_process_key", message: "x-process-key is required" }, 403);
  }
  if (method === "GET") {
    if (processKey.startsWith("wiki.") || isDmReadProcess(processKey)) return null;
    return rawJson({ error: "forbidden", code: "read_denied" }, 403);
  }
  if (!target) {
    // Non-file POST routes (import/apply) still require a wiki-tier
    // process key; the matrix's "writes" semantics extend to them.
    return processKey.startsWith("wiki.")
      ? null
      : rawJson({ error: "forbidden", code: "write_target_required" }, 403);
  }
  if (target.layer === "inbox") {
    return rawJson({ error: "forbidden", code: "human_only_layer" }, 403);
  }
  if (target.layer === "log") {
    return processKey.startsWith("wiki.") ? null : rawJson({ error: "forbidden", code: "log_write_denied" }, 403);
  }
  if (target.layer === "raw") {
    if (processKey === "wiki.ingest_url") return null;
    // WIKI_BUILDER_DESIGN.md §P5.B — two-key safety for DM-agent
    // bridge writes. BOTH `dm_agent_write_enabled` AND `bridge_enabled`
    // must be on. The `bridge_enabled` gate is the feature switch;
    // `dm_agent_write_enabled` is the per-workspace "I've reviewed the
    // bridge surface" consent. Either toggle off → 403.
    if (
      workspace.dm_agent_write_enabled === 1 &&
      workspace.bridge_enabled === 1 &&
      isDmReadProcess(processKey) &&
      BRIDGE_FILE_RE.test(target.relPath)
    ) {
      return null;
    }
    return rawJson({ error: "forbidden", code: "raw_write_denied" }, 403);
  }
  if (target.layer === "wiki") {
    return processKey === "wiki.compile"
      ? null
      : rawJson({ error: "forbidden", code: "wiki_write_denied" }, 403);
  }
  if (target.layer === "output") {
    // WIKI_BUILDER_DESIGN.md Phase 3 — `wiki.trace` and `wiki.connect`
    // both write `30_outputs/<YYYY-MM-DD>-<kind>-<slug>.md`. The
    // path-level OUTPUT_RE already enforces the date-prefix shape; this
    // layer auth just widens write eligibility from `wiki.ask` to the
    // P3 triad's two output-writers.
    if (processKey === "wiki.ask" || processKey === "wiki.trace" || processKey === "wiki.connect") {
      return null;
    }
    return rawJson({ error: "forbidden", code: "output_write_denied" }, 403);
  }
  if (target.layer === "meta") {
    // `wiki.compile` is the original meta writer (taxonomy + schemas).
    // Phase 3's `wiki.lint` writes `90_meta/health/<date>.md` and may
    // PATCH `90_meta/taxonomy.md` to append its `# Candidates` section
    // — same layer permission, narrower in spirit (lint never rewrites
    // schemas). Both keys land here.
    if (processKey === "wiki.compile" || processKey === "wiki.lint") return null;
    return rawJson({ error: "forbidden", code: "meta_write_denied" }, 403);
  }
  return rawJson({ error: "forbidden", code: "write_denied" }, 403);
}

function isDmReadProcess(processKey: string): boolean {
  return ["message.dm", "message.mention", "dashboard.chat"].includes(processKey);
}

function snapshotIfNeeded(
  workspace: WikiWorkspaceRow,
  relPath: string,
  fullPath: string,
): void {
  // WIKI_BUILDER_DESIGN.md §14 Q3 — external-mode workspaces are excluded
  // from `md_file_snapshots`. The user's git / cloud sync is the recovery
  // surface; the daemon does not duplicate it.
  if (workspace.kind !== "internal" || !existsSync(fullPath)) return;
  const stat = statSync(fullPath);
  if (!stat.isFile()) return;
  const snapshotPath = join(
    workspace.root_path,
    ".snapshots",
    `${Date.now()}`,
    relPath,
  );
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileAtomically(snapshotPath, readFileSync(fullPath, "utf-8"));
}

function recordWikiWrite(
  db: import("better-sqlite3").Database,
  workspace: WikiWorkspaceRow,
  processKey: string,
  operation: "post" | "patch",
  relPath: string,
  bytesWritten: number,
): void {
  // WIKI_BUILDER_DESIGN.md §11.1 — `action_type = 'wiki.<command>'` so the
  // existing `idx_agent_actions_source` lookup pivots on the same process
  // key the dispatcher already records for the agent session. A generic
  // `wiki.file_write` row would force every dashboard timeline query to
  // re-derive the originating command from `detail` JSON.
  const actionType = processKey.startsWith("wiki.") ? processKey : "wiki.file_write";
  db.prepare(
    `INSERT INTO agent_actions
       (event_id, action_type, trigger, result, detail, started_at, completed_at, source_kind, source_ref)
     VALUES (?, ?, 'autonomous', 'success', json(?), datetime('now'), datetime('now'), 'wiki', ?)`,
  ).run(
    `${processKey}:${workspace.name}:${relPath}`,
    actionType,
    JSON.stringify({
      processKey,
      operation,
      workspace: workspace.name,
      workspace_id: workspace.id,
      targets: [relPath],
      bytes_written: bytesWritten,
    }),
    workspace.name,
  );
}

function updateWikiProcessTimestamp(
  db: import("better-sqlite3").Database,
  workspaceName: string,
  processKey: string | undefined,
): void {
  if (processKey === "wiki.ingest_url") {
    db.prepare(
      `UPDATE wiki_workspaces SET last_ingest_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
    ).run(workspaceName);
  } else if (processKey === "wiki.compile") {
    db.prepare(
      `UPDATE wiki_workspaces SET last_compile_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
    ).run(workspaceName);
  }
}

function serializeWorkspace(row: WikiWorkspaceRow, db: import("better-sqlite3").Database) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    rootPath: row.root_path,
    language: row.language,
    dispatchMode: row.dispatch_mode,
    concurrencyCap: row.concurrency_cap,
    dmAgentWriteEnabled: row.dm_agent_write_enabled === 1,
    bridgeEnabled: row.bridge_enabled === 1,
    // WIKI_BUILDER_DESIGN.md §P5.A / §P5.B — surface the measurement
    // gate and confidence threshold so the dashboard can render the
    // "Bridge — observation mode" badge during the 2-week measurement
    // window. The toggle stays hidden when `bridge_enabled = 0`.
    bridgeMeasurementOnly: row.bridge_measurement_only === 1,
    bridgeMinConfidence: row.bridge_min_confidence,
    fullCompileApprovalThresholdUsd: row.full_compile_approval_threshold_usd,
    writeStrategy: row.write_strategy,
    gitPreCompileEnabled: row.git_pre_compile_enabled === 1,
    isGitRepo: row.kind === "external" ? isGitRepo(row.root_path) : undefined,
    schemaVersion: row.schema_version,
    active: row.active === 1,
    lastIngestAt: row.last_ingest_at,
    lastCompileAt: row.last_compile_at,
    stats: buildWikiWorkspaceStats(row),
    bridgeStats: readBridgeStats(db, row.id),
    recentCosts: readRecentWikiCosts(db),
  };
}

function readBridgeStats(
  db: import("better-sqlite3").Database,
  workspaceId: number,
): {
  candidates: number;
  written: number;
  deduplicated: number;
  lastDetectedAt: string | null;
} {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN accepted = 1 AND bridge_path IS NOT NULL THEN 1 ELSE 0 END) AS written,
         SUM(CASE WHEN accepted = 0 THEN 1 ELSE 0 END) AS candidates,
         COUNT(*) AS total,
         MAX(detected_at) AS last_at
       FROM wiki_bridge_dedup WHERE workspace_id = ?`,
    )
    .get(workspaceId) as
    | { written: number | null; candidates: number | null; total: number | null; last_at: string | null }
    | undefined;
  const written = row?.written ?? 0;
  const candidates = row?.candidates ?? 0;
  const total = row?.total ?? 0;
  return {
    candidates,
    written,
    deduplicated: Math.max(0, total - written - candidates),
    lastDetectedAt: row?.last_at ?? null,
  };
}

function readRecentWikiCosts(db: import("better-sqlite3").Database) {
  return db
    .prepare(
      `SELECT action_type AS processKey,
              COUNT(*) AS count,
              COALESCE(SUM(cost_usd), 0) AS totalCostUsd,
              AVG(cost_usd) AS avgCostUsd,
              MAX(cost_usd) AS lastCostUsd
       FROM agent_actions
       WHERE started_at >= datetime('now', '-7 days')
         AND (source_kind = 'wiki' OR action_type LIKE 'wiki.%')
       GROUP BY action_type
       ORDER BY action_type`,
    )
    .all() as Array<{
      processKey: string;
      count: number;
      totalCostUsd: number;
      avgCostUsd: number | null;
      lastCostUsd: number | null;
    }>;
}

function searchWikiFiles(rootPath: string, query: string, limit: number) {
  const files = listWikiIndex(rootPath);
  const results = [];
  for (const file of files) {
    if (!file.path.endsWith(".md")) continue;
    const full = join(rootPath, file.path);
    const content = readFileSync(full, "utf-8");
    const lower = content.toLowerCase();
    const idx = query ? lower.indexOf(query) : 0;
    if (idx < 0) continue;
    results.push({
      path: file.path,
      title: firstHeading(content) ?? file.path,
      snippet: content.slice(Math.max(0, idx - 80), idx + 180),
      mtime: file.mtime,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function listWikiIndex(rootPath: string) {
  const out: Array<{ path: string; sizeBytes: number; mtime: string }> = [];
  for (const rel of walkFiles(rootPath)) {
    if (rel.startsWith(".snapshots/")) continue;
    const full = join(rootPath, rel);
    const stat = statSync(full);
    out.push({ path: rel, sizeBytes: stat.size, mtime: stat.mtime.toISOString() });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function walkFiles(rootPath: string, relDir = ""): string[] {
  const dir = join(rootPath, relDir);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(rootPath, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function firstHeading(content: string): string | null {
  return content
    .split("\n")
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim() ?? null;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function ensureLeadingNewline(content: string): string {
  const trailing = ensureTrailingNewline(content);
  return trailing.startsWith("\n") ? trailing : `\n${trailing}`;
}

function jsonResponse(body: unknown, status: number): { response: Response } {
  return { response: rawJson(body, status) };
}

function rawJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// WIKI_BUILDER_DESIGN.md §P4.A — keep fts_wiki in sync with disk
// writes. The mail FTS pattern uses DB triggers (schema.ts line 692)
// because mail rows live in `mail_messages_index`. Wiki content does
// not — the canonical store is the filesystem — so this helper sits at
// the write chokepoint instead. The §2.3 layer classifier in wiki.ts
// uses a slightly different vocabulary ("log", "inbox") than the FTS
// layer enum ("log", "inbox" too), so the mapping is a pass-through;
// guarded by `isWikiFtsLayer` so an unexpected layer (added later but
// not registered with the FTS) does not silently skip indexing.
function syncWikiFts(
  db: import("better-sqlite3").Database,
  workspaceId: number,
  classified: ClassifiedWikiPath,
  content: string,
): void {
  if (!isWikiFtsLayer(classified.layer)) return;
  upsertWikiFulltextRow(db, {
    workspaceId,
    path: classified.relPath,
    layer: classified.layer,
    content,
  });
}

function isWikiFtsLayer(value: unknown): value is WikiFtsLayer {
  return (
    value === "raw" ||
    value === "wiki" ||
    value === "output" ||
    value === "meta" ||
    value === "log" ||
    value === "inbox"
  );
}

/**
 * Unified Repositories API — see
 * `docs/design/appendices/unified-repositories.md`.
 *
 * One Repository row pairs an optional GitHub remote and an optional
 * local clone. This route covers:
 *
 *   §4.1  CRUD                       /repositories[, /:id, /link-github, /link-local]
 *   §4.3  Run-in-clone / run-in-temp /repositories/:id/run
 *   §4.4  Trigger CRUD + test        /repositories/:id/triggers[, /:triggerId, /test, /run]
 *   §4.5  Daily git management       /repositories/:id/management[, /init, /scan]
 *
 * The CRUD layer is the single source of truth for the dashboard
 * `connections > repositories` page (registration) and for the
 * `my life > git` page (polling, triggers, management). Observers and
 * legacy `/api/git`, `/api/github` routes resolve via the same store.
 *
 * `run` and trigger endpoints schedule a backend session by emitting a
 * `scheduled.task` event onto the EventBus. Daily management init/scan writes
 * the mandatory markdown artifacts in-process so the dashboard buttons have a
 * deterministic file-production guarantee; trigger dispatch from observer
 * hooks goes through the EventBus path, see §4.4 dispatch loop.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  createEvent,
  EventPriority,
  type AgentTaskEvent,
} from "@aitne/shared";
import {
  createRepository,
  createTrigger,
  deleteRepository,
  deleteTrigger,
  getManagement,
  getRepository,
  getTrigger,
  listRepositories,
  listTriggers,
  markManagementScanQueued,
  recordManagementInitDone,
  recordManagementScan,
  RepositoryStoreError,
  setManagementEnabled,
  updateRepository,
  updateTrigger,
  type RepositoryDTO,
  type RepositoryTriggerDTO,
  type TriggerBackend,
  type TriggerWorkdirMode,
} from "../../db/repositories-store.js";
import {
  evaluateTriggers,
} from "../../core/trigger-evaluator.js";
import { getModelsForBackend } from "../../core/backends/model-registry.js";
import {
  copyRepositoryReadmeForRefresh,
  enqueueArchitectureRefresh,
  findInFlightArchitectureRefresh,
  runRepositoryArchitectureSectionReplace,
  runRepositoryManagementInit,
  runRepositoryManagementScan,
  validateArchitectureMarkdown,
} from "../../core/repository-management-docs.js";
import { getContextDir } from "../../config.js";
import { RUNTIME_AVAILABLE_BACKEND_IDS, type BackendId } from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import { createLogger } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("repositories-api");

// Repository triggers fire through the BackendRouter at run time, so the
// accepted set must match `RUNTIME_AVAILABLE_BACKEND_IDS` (claude/codex/gemini
// today; opencode joins in `docs/design/appendices/opencode-backend.md` Phase 2). The schema
// CHECK on `repository_triggers.backend` already accepts `'opencode'` — the
// API gate here keeps the shape API-rejected until the runtime catches up.
const VALID_BACKENDS: ReadonlySet<TriggerBackend> = new Set(
  RUNTIME_AVAILABLE_BACKEND_IDS,
);
const VALID_BACKENDS_LABEL = RUNTIME_AVAILABLE_BACKEND_IDS.join("/");
const VALID_WORKDIR_MODES: ReadonlySet<TriggerWorkdirMode> = new Set([
  "temp",
  "local-clone",
]);

function mapStoreError(err: unknown): { status: number; body: { error: string; message: string } } {
  if (err instanceof RepositoryStoreError) {
    const status = err.code === "not_found" ? 404 : 400;
    return { status, body: { error: err.code, message: err.message } };
  }
  return {
    status: 500,
    body: {
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

/**
 * Replace the previous `c.json(errBody, status)` pattern in catch blocks with
 * an envelope-shaped response that preserves the legacy `error`/`message`
 * fields (dashboard pages still pattern-match on those) while giving the
 * agent a structured `errors[].hint` to act on.
 */
function respondWithStoreError(
  c: Parameters<typeof respondWithAgentError>[0],
  err: unknown,
): Response {
  const { status, body } = mapStoreError(err);
  if (body.error === "not_found") {
    return respondWithAgentError(
      c,
      404,
      [
        composeIssue("repositories.not_found", {
          field: "id",
          received: body.message,
        }),
      ],
      { legacyFields: { message: body.message } },
    );
  }
  if (status === 500) {
    return respondWithAgentError(
      c,
      500,
      [
        composeIssue("repositories.internal_error", {
          field: "internal",
          received: body.message,
        }),
      ],
      { legacyErrorCode: body.error, legacyFields: { message: body.message } },
    );
  }
  // RepositoryStoreError with a non-not_found code — surface as a generic
  // validation_error but keep the store's exact code as the legacy alias so
  // dashboard branches keyed on body.error keep firing.
  return respondWithAgentError(
    c,
    400,
    [
      composeIssue("repositories.validation_error", {
        field: "body",
        received: body.message,
        expected: body.message,
      }),
    ],
    { legacyErrorCode: body.error, legacyFields: { message: body.message } },
  );
}

/** Map a validator's discriminated-union error onto the registry. */
function respondWithValidationError(
  c: Parameters<typeof respondWithAgentError>[0],
  v: { error: string; message: string },
): Response {
  const codeMap: Record<string, string> = {
    validation_error: "repositories.validation_error",
    local_clone_required: "repositories.local_clone_required",
    instruction_required: "repositories.instruction_required",
  };
  const code = codeMap[v.error] ?? "repositories.validation_error";
  return respondWithAgentError(
    c,
    400,
    [composeIssue(code, { field: "body", received: v.message })],
    { legacyErrorCode: v.error, legacyFields: { message: v.message } },
  );
}

function dtoToResponse(repo: RepositoryDTO): Record<string, unknown> {
  return {
    id: repo.id,
    githubOwner: repo.githubOwner,
    githubRepo: repo.githubRepo,
    githubAccount: repo.githubAccount,
    localPath: repo.localPath,
    localOnly: repo.localOnly,
    displayName: repo.displayName,
    classification: repo.classification,
    category: repo.category,
    pollPriority: repo.pollPriority,
    pollIntervalSec: repo.pollIntervalSec,
    slug: repo.slug,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function triggerDtoToResponse(
  trg: RepositoryTriggerDTO,
): Record<string, unknown> {
  return {
    id: trg.id,
    repositoryId: trg.repositoryId,
    name: trg.name,
    enabled: trg.enabled,
    eventType: trg.eventType,
    filters: trg.filters,
    backend: trg.backend,
    model: trg.model,
    workdirMode: trg.workdirMode,
    prompt: trg.prompt,
    instructionMd: trg.instructionMd,
    lastFiredAt: trg.lastFiredAt,
    fireCount: trg.fireCount,
    createdAt: trg.createdAt,
    updatedAt: trg.updatedAt,
  };
}

export type RepositoriesRouteDeps = Pick<
  ApiDependencies,
  "db" | "eventBus" | "config" | "writeTracker" | "onIndexableContextChange"
>;

/**
 * Trigger model validator wired into store-level create/update calls.
 * Mirrors `/settings/models`' `ensureModelBelongsToBackend` gate
 * (backends.ts:229) so an operator can't create a trigger pointing at
 * a model the corresponding backend isn't running. The TriggerBackend
 * literals (`'claude'|'codex'|'gemini'`) are a subset of `BackendId`,
 * so the cast is safe.
 */
const triggerModelValidator = (
  backend: TriggerBackend,
  model: string,
): boolean => {
  return getModelsForBackend(backend as BackendId).some(
    (entry) => entry.modelId === model,
  );
};

export function createRepositoriesRoutes(deps: RepositoriesRouteDeps): Hono {
  const { db, eventBus } = deps;
  const app = new Hono();

  // ─── §4.1 CRUD ──────────────────────────────────────────────────

  app.get("/repositories", (c) => {
    const filters = {
      hasGithub: parseBool(c.req.query("has_github")),
      hasLocal: parseBool(c.req.query("has_local")),
      localOnly: parseBool(c.req.query("local_only")),
      account: c.req.query("account"),
    };
    const rows = listRepositories(db, filters);
    return c.json({ repositories: rows.map(dtoToResponse) });
  });

  app.get("/repositories/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const row = getRepository(db, id);
    if (!row) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    return c.json({ repository: dtoToResponse(row) });
  });

  app.post("/repositories", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    try {
      const row = createRepository(db, {
        githubOwner: typeof body.githubOwner === "string" ? body.githubOwner : null,
        githubRepo: typeof body.githubRepo === "string" ? body.githubRepo : null,
        githubAccount:
          typeof body.githubAccount === "string" ? body.githubAccount : null,
        localPath: typeof body.localPath === "string" ? body.localPath : null,
        localOnly: body.localOnly === true,
        displayName:
          typeof body.displayName === "string" ? body.displayName : null,
        classification:
          body.classification === "project" || body.classification === "repo-only"
            ? body.classification
            : undefined,
        category:
          typeof body.category === "string"
            && ["work", "personal", "research", "client", "other"].includes(
              body.category,
            )
            ? (body.category as RepositoryDTO["category"])
            : undefined,
        pollPriority:
          body.pollPriority === "high" || body.pollPriority === "normal"
            ? body.pollPriority
            : undefined,
        pollIntervalSec:
          typeof body.pollIntervalSec === "number"
            ? body.pollIntervalSec
            : null,
      });
      return c.json({ repository: dtoToResponse(row) }, 201);
    } catch (err) {
      return respondWithStoreError(c, err);
    }
  });

  app.patch("/repositories/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    try {
      const row = updateRepository(db, id, {
        githubOwner:
          "githubOwner" in body
            ? (body.githubOwner as string | null)
            : undefined,
        githubRepo:
          "githubRepo" in body ? (body.githubRepo as string | null) : undefined,
        githubAccount:
          "githubAccount" in body
            ? (body.githubAccount as string | null)
            : undefined,
        localPath:
          "localPath" in body ? (body.localPath as string | null) : undefined,
        localOnly:
          typeof body.localOnly === "boolean" ? body.localOnly : undefined,
        displayName:
          "displayName" in body
            ? (body.displayName as string | null)
            : undefined,
        classification:
          body.classification === "project" || body.classification === "repo-only"
            ? body.classification
            : undefined,
        category:
          typeof body.category === "string"
            && ["work", "personal", "research", "client", "other"].includes(
              body.category,
            )
            ? (body.category as RepositoryDTO["category"])
            : undefined,
        pollPriority:
          body.pollPriority === "high" || body.pollPriority === "normal"
            ? body.pollPriority
            : undefined,
        pollIntervalSec:
          "pollIntervalSec" in body
            ? (body.pollIntervalSec as number | null)
            : undefined,
      });
      return c.json({ repository: dtoToResponse(row) });
    } catch (err) {
      return respondWithStoreError(c, err);
    }
  });

  app.delete("/repositories/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const ok = deleteRepository(db, id);
    if (!ok) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    return c.json({ status: "deleted" });
  });

  // POST /repositories/:id/link-github { owner, repo, account? } — idempotent
  app.post("/repositories/:id/link-github", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    if (typeof body.owner !== "string" || typeof body.repo !== "string") {
      return respondWithValidationError(c, {
        error: "validation_error",
        message: "owner and repo are required (POST /repositories/:id/link-github { owner, repo, account? }; both fields must be strings)",
      });
    }
    try {
      const row = updateRepository(db, id, {
        githubOwner: body.owner,
        githubRepo: body.repo,
        githubAccount:
          typeof body.account === "string" ? body.account : undefined,
        localOnly: false,
      });
      return c.json({ repository: dtoToResponse(row) });
    } catch (err) {
      return respondWithStoreError(c, err);
    }
  });

  // POST /repositories/:id/link-local { localPath } — idempotent
  app.post("/repositories/:id/link-local", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    if (typeof body.localPath !== "string") {
      return respondWithValidationError(c, {
        error: "validation_error",
        message: "localPath is required (POST /repositories/:id/link-local { localPath: '<absolute path>' }; relative paths are rejected, a leading ~/ is expanded)",
      });
    }
    try {
      const row = updateRepository(db, id, { localPath: body.localPath });
      return c.json({ repository: dtoToResponse(row) });
    } catch (err) {
      return respondWithStoreError(c, err);
    }
  });

  // ─── §4.3 Run-in-clone / run-in-temp ────────────────────────────

  app.post("/repositories/:id/run", async (c) => {
    if (!eventBus) {
      return respondWithAgentError(c, 503, [
        composeIssue("repositories.event_bus_unavailable", {
          field: "eventBus",
          received: "<unavailable>",
        }),
      ]);
    }
    const id = decodeURIComponent(c.req.param("id"));
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;

    const repo = getRepository(db, id);
    if (!repo) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }

    const validation = validateRunRequest(body, repo);
    if ("error" in validation) {
      return respondWithValidationError(c, validation);
    }
    if (!triggerModelValidator(validation.backend, validation.model)) {
      return respondWithAgentError(
        c,
        400,
        [
          composeIssue("repositories.model_invalid", {
            field: "model",
            received: validation.model,
            expected: `model registered for backend '${validation.backend}'`,
          }),
        ],
        {
          legacyFields: {
            message: `Model '${validation.model}' is not registered for backend '${validation.backend}'`,
          },
        },
      );
    }

    const event = buildRunEvent(repo, validation, "manual");
    recordRepoRunAuditAction(db, repo, {
      mode: "manual_run",
      backend: validation.backend,
      model: validation.model,
      workdirMode: validation.workdirMode,
      correlationId: event.correlationId,
    });
    await eventBus.put(event);
    logger.info(
      { id, workdirMode: validation.workdirMode, backend: validation.backend },
      "Repository run scheduled",
    );
    return c.json({ status: "scheduled", correlationId: event.correlationId });
  });

  // ─── §4.4 Triggers ─────────────────────────────────────────────

  app.get("/repositories/:id/triggers", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!getRepository(db, id)) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    return c.json({
      triggers: listTriggers(db, id).map(triggerDtoToResponse),
    });
  });

  app.post("/repositories/:id/triggers", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    const valid = validateTriggerCreate(body);
    if ("error" in valid) return respondWithValidationError(c, valid);
    try {
      const trg = createTrigger(db, id, valid, {
        validateModel: triggerModelValidator,
      });
      return c.json({ trigger: triggerDtoToResponse(trg) }, 201);
    } catch (err) {
      return respondWithStoreError(c, err);
    }
  });

  app.patch("/repositories/:id/triggers/:triggerId", async (c) => {
    const triggerId = decodeURIComponent(c.req.param("triggerId"));
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    try {
      const trg = updateTrigger(
        db,
        triggerId,
        {
          name: typeof body.name === "string" ? body.name : undefined,
          enabled:
            typeof body.enabled === "boolean" ? body.enabled : undefined,
          eventType:
            typeof body.eventType === "string" ? body.eventType : undefined,
          filters:
            body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
              ? (body.filters as Record<string, unknown>)
              : undefined,
          backend:
            typeof body.backend === "string" && VALID_BACKENDS.has(body.backend as TriggerBackend)
              ? (body.backend as TriggerBackend)
              : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          workdirMode:
            typeof body.workdirMode === "string"
              && VALID_WORKDIR_MODES.has(body.workdirMode as TriggerWorkdirMode)
              ? (body.workdirMode as TriggerWorkdirMode)
              : undefined,
          prompt: typeof body.prompt === "string" ? body.prompt : undefined,
          instructionMd:
            "instructionMd" in body
              ? (body.instructionMd as string | null)
              : undefined,
        },
        { validateModel: triggerModelValidator },
      );
      return c.json({ trigger: triggerDtoToResponse(trg) });
    } catch (err) {
      return respondWithStoreError(c, err);
    }
  });

  app.delete("/repositories/:id/triggers/:triggerId", (c) => {
    const triggerId = decodeURIComponent(c.req.param("triggerId"));
    const ok = deleteTrigger(db, triggerId);
    if (!ok) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", {
          field: "triggerId",
          received: triggerId,
        }),
      ]);
    }
    return c.json({ status: "deleted" });
  });

  // POST .../triggers/:triggerId/test — dry-run with a mock event payload.
  // Returns whether the filters match without dispatching a session.
  app.post("/repositories/:id/triggers/:triggerId/test", async (c) => {
    const triggerId = decodeURIComponent(c.req.param("triggerId"));
    const trg = getTrigger(db, triggerId);
    if (!trg) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", {
          field: "triggerId",
          received: triggerId,
        }),
      ]);
    }
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    const eventType = typeof body.eventType === "string" ? body.eventType : trg.eventType;
    const payload =
      body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};
    const matched = evaluateTriggers([trg], eventType, payload);
    return c.json({
      matched: matched.length === 1,
      trigger: triggerDtoToResponse(trg),
      eventType,
    });
  });

  // POST .../triggers/:triggerId/run — fire the trigger's action immediately
  // (skips condition evaluation, used by the dashboard "Fire now" button).
  app.post("/repositories/:id/triggers/:triggerId/run", async (c) => {
    if (!eventBus) {
      return respondWithAgentError(c, 503, [
        composeIssue("repositories.event_bus_unavailable", {
          field: "eventBus",
          received: "<unavailable>",
        }),
      ]);
    }
    const id = decodeURIComponent(c.req.param("id"));
    const triggerId = decodeURIComponent(c.req.param("triggerId"));
    const repo = getRepository(db, id);
    if (!repo) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    const trg = getTrigger(db, triggerId);
    if (!trg || trg.repositoryId !== id) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", {
          field: "triggerId",
          received: triggerId,
          expected: `trigger belonging to repository ${id}`,
        }),
      ]);
    }
    const event = buildRunEvent(repo, {
      backend: trg.backend,
      model: trg.model,
      workdirMode: trg.workdirMode,
      prompt: trg.prompt,
      instructionMd: trg.instructionMd ?? undefined,
    }, "trigger_manual_fire", { triggerId: trg.id, triggerName: trg.name });
    recordRepoRunAuditAction(db, repo, {
      mode: "trigger_manual_fire",
      backend: trg.backend,
      model: trg.model,
      workdirMode: trg.workdirMode,
      triggerId: trg.id,
      triggerName: trg.name,
      correlationId: event.correlationId,
    });
    await eventBus.put(event);
    return c.json({ status: "scheduled", correlationId: event.correlationId });
  });

  // ─── §4.5 Daily git management ──────────────────────────────────

  app.get("/repositories/:id/management", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const repo = getRepository(db, id);
    if (!repo) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    const m = getManagement(db, id);
    // Surface any pending/running `git.project.refresh_architecture` row so
    // the dashboard can poll for completion of the async architecture-refresh
    // half of the init / refresh-architecture flows. The synchronous skeleton
    // write returns immediately; the agent run that fills the Architecture
    // section is async and otherwise invisible to the UI.
    const inFlight = findInFlightArchitectureRefresh(db, id);
    const architectureRefresh = inFlight
      ? { scheduleId: inFlight.scheduleId, status: inFlight.status }
      : null;
    return c.json({
      management: m
        ? m
        : {
          repositoryId: id,
          enabled: false,
          initCompletedAt: null,
          lastScanAt: null,
          lastScanStatus: null,
          scanFailureCount: 0,
        },
      architectureRefresh,
    });
  });

  app.put("/repositories/:id/management", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    if (typeof body.enabled !== "boolean") {
      return respondWithValidationError(c, {
        error: "validation_error",
        message: "enabled (boolean) required — pass `{ enabled: true }` or `{ enabled: false }`",
      });
    }
    const repo = getRepository(db, id);
    if (!repo) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    if (body.enabled && !repo.localPath) {
      return respondWithAgentError(
        c,
        400,
        [
          composeIssue("repositories.local_clone_required", {
            field: "repo.localPath",
            received: null,
          }),
        ],
        {
          legacyFields: {
            message:
              "Daily git management requires the repository to have a local clone (v1).",
          },
        },
      );
    }
    try {
      const m = setManagementEnabled(db, id, body.enabled);
      return c.json({ management: m });
    } catch (err) {
      return respondWithStoreError(c, err);
    }
  });

  // POST .../management/init — one-shot: generate the overview MD now.
  // The mandatory artifact is produced in-process; earlier versions only
  // enqueued an autonomous session, which could succeed without writing.
  app.post("/repositories/:id/management/init", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const repo = getRepository(db, id);
    if (!repo) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    if (!repo.localPath) {
      return respondWithAgentError(
        c,
        400,
        [
          composeIssue("repositories.local_clone_required", {
            field: "repo.localPath",
            received: null,
          }),
        ],
        {
          legacyFields: {
            message:
              "Management init requires the repository to have a local clone (v1).",
          },
        },
      );
    }
    const correlationId = randomUUID();
    recordRepoRunAuditAction(db, repo, {
      mode: "management_init",
      correlationId,
    });
    try {
      ensureManagementRow(db, repo.id);
      // `runRepositoryManagementInit` owns both halves of producing a
      // complete overview.md: write the skeleton when the file is missing
      // and enqueue the architecture-refresh agent run that fills the
      // `## Architecture` section. Idempotency lives inside the core
      // function — re-clicking init while a previous refresh is still
      // in flight returns that schedule id instead of inserting a
      // duplicate row, and an existing overview whose architecture has
      // already landed (`architecture_status: complete`) yields
      // `architectureScheduleId: null` rather than burning quota
      // re-running a finished analysis.
      const result = runRepositoryManagementInit({
        db,
        repo,
        contextDir: getContextDir(deps.config, db),
        timezone: deps.config.timezone || undefined,
        writeTracker: deps.writeTracker,
        onIndexableContextChange: deps.onIndexableContextChange,
      });
      recordManagementInitDone(db, repo.id);
      return c.json({
        status: "completed",
        correlationId,
        result: result.status,
        overviewPath: result.overviewPath,
        readmeCopiedTo: result.readmeCopiedTo,
        architectureScheduleId: result.architectureScheduleId,
      });
    } catch (err) {
      logger.error({ err, repositoryId: repo.id }, "Repository management init failed");
      const message = err instanceof Error ? err.message : String(err);
      return respondWithAgentError(
        c,
        500,
        [
          composeIssue("repositories.management_init_failed", {
            field: "init",
            received: message,
          }),
        ],
        { legacyFields: { message, correlationId } },
      );
    }
  });

  // POST .../management/refresh-architecture — enqueue an agent run that
  // re-reads the repo and rewrites only the `## Architecture` section of
  // overview.md. Dashboard "Refresh architecture" button.
  //
  // Distinct from the init flow: management init also auto-enqueues a
  // refresh when its skeleton is fresh or the existing file's
  // `architecture_status` is `pending`, but it short-circuits to `null`
  // when the field is `complete`, missing, or malformed. This endpoint
  // is the explicit user-driven path that bypasses those gates and
  // *unconditionally* wants a fresh agent run. There is no cron-fired
  // auto-schedule for refresh on a timer — refresh enqueues only happen
  // through init's auto-recovery or this endpoint.
  //
  // Idempotency: if a pending or running `git.project.refresh_architecture`
  // row already exists for this repo, return 409 with that schedule id
  // instead of inserting a duplicate. Two concurrent agent sessions
  // would race on the chokepoint write and burn model quota.
  //
  // Side effect: refreshes `knowledge/repos/<slug>/README.md` synchronously before
  // enqueueing so the README mirror tracks the source the agent is
  // about to read. Mirror failures (e.g. README removed) are non-fatal
  // — they just leave the previous mirror untouched.
  app.post("/repositories/:id/management/refresh-architecture", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const repo = getRepository(db, id);
    if (!repo) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    if (!repo.localPath) {
      return respondWithAgentError(
        c,
        400,
        [
          composeIssue("repositories.local_clone_required", {
            field: "repo.localPath",
            received: null,
          }),
        ],
        {
          legacyFields: {
            message:
              "Refresh architecture requires the repository to have a local clone.",
          },
        },
      );
    }
    const inFlight = findInFlightArchitectureRefresh(db, repo.id);
    if (inFlight) {
      return respondWithAgentError(
        c,
        409,
        [
          composeIssue("repositories.already_in_flight", {
            field: "scheduleId",
            received: inFlight.scheduleId,
          }),
        ],
        {
          legacyFields: {
            message:
              "An architecture refresh is already pending or running for this repository.",
            scheduleId: inFlight.scheduleId,
            status: inFlight.status,
          },
        },
      );
    }
    try {
      let readmeCopiedTo: string | null = null;
      try {
        readmeCopiedTo = copyRepositoryReadmeForRefresh({
          db,
          repo,
          contextDir: getContextDir(deps.config, db),
          timezone: deps.config.timezone || undefined,
          writeTracker: deps.writeTracker,
          onIndexableContextChange: deps.onIndexableContextChange,
        });
      } catch (readmeErr) {
        logger.warn(
          { err: readmeErr, repositoryId: repo.id },
          "Failed to refresh README mirror — continuing with architecture enqueue",
        );
      }
      const enqueued = enqueueArchitectureRefresh(db, repo);
      recordRepoRunAuditAction(db, repo, {
        mode: "management_refresh_architecture",
        correlationId: enqueued.correlationId,
        scheduleId: enqueued.scheduleId,
        readmeCopiedTo,
      });
      return c.json({
        status: "scheduled",
        scheduleId: enqueued.scheduleId,
        correlationId: enqueued.correlationId,
        readmeCopiedTo,
      });
    } catch (err) {
      logger.error(
        { err, repositoryId: repo.id },
        "Failed to enqueue architecture refresh",
      );
      const message = err instanceof Error ? err.message : String(err);
      return respondWithAgentError(
        c,
        500,
        [
          composeIssue("repositories.architecture_refresh_enqueue_failed", {
            field: "enqueue",
            received: message,
          }),
        ],
        { legacyFields: { message } },
      );
    }
  });

  // PUT .../architecture-section — agent-callable chokepoint. Replaces only
  // the marker-bracketed Architecture block; other sections of overview.md
  // are preserved by the daemon.
  app.put("/repositories/:id/architecture-section", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const repo = getRepository(db, id);
    if (!repo) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    const v = validateArchitectureMarkdown(body.markdown);
    if (!v.ok) {
      const code =
        v.error === "payload_too_large"
          ? "repositories.payload_too_large"
          : "repositories.validation_error";
      return respondWithAgentError(
        c,
        v.error === "payload_too_large" ? 413 : 400,
        [
          composeIssue(code, {
            field: "markdown",
            received: v.message,
            expected: v.message,
          }),
        ],
        { legacyErrorCode: v.error, legacyFields: { message: v.message } },
      );
    }
    try {
      const result = await runRepositoryArchitectureSectionReplace(
        {
          db,
          repo,
          contextDir: getContextDir(deps.config, db),
          timezone: deps.config.timezone || undefined,
          writeTracker: deps.writeTracker,
          onIndexableContextChange: deps.onIndexableContextChange,
        },
        v.body,
      );
      if (result.status === "no_overview") {
        return respondWithAgentError(
          c,
          409,
          [
            composeIssue("repositories.no_overview", {
              field: "overview.md",
              received: "<missing>",
            }),
          ],
          {
            legacyFields: {
              message:
                "overview.md does not exist for this repository — run management init first.",
            },
          },
        );
      }
      return c.json({
        status: "written",
        overviewPath: result.overviewPath,
        refreshedAt: result.refreshedAt,
      });
    } catch (err) {
      logger.error(
        { err, repositoryId: repo.id },
        "Failed to replace architecture section",
      );
      const message = err instanceof Error ? err.message : String(err);
      return respondWithAgentError(
        c,
        500,
        [
          composeIssue("repositories.architecture_section_write_failed", {
            field: "write",
            received: message,
          }),
        ],
        { legacyFields: { message } },
      );
    }
  });

  app.post("/repositories/:id/management/scan", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const repo = getRepository(db, id);
    if (!repo) {
      return respondWithAgentError(c, 404, [
        composeIssue("repositories.not_found", { field: "id", received: id }),
      ]);
    }
    if (!repo.localPath) {
      return respondWithAgentError(
        c,
        400,
        [
          composeIssue("repositories.local_clone_required", {
            field: "repo.localPath",
            received: null,
          }),
        ],
        {
          legacyFields: {
            message:
              "Management scan requires the repository to have a local clone (v1).",
          },
        },
      );
    }
    const correlationId = randomUUID();
    recordRepoRunAuditAction(db, repo, {
      mode: "management_scan",
      correlationId,
    });
    try {
      // Prevent the hourly cron from racing with a manual scan while the
      // in-process writer collects git evidence and writes markdown.
      ensureManagementRow(db, repo.id);
      markManagementScanQueued(db, repo.id);
      const result = await runRepositoryManagementScan({
        db,
        repo,
        contextDir: getContextDir(deps.config, db),
        timezone: deps.config.timezone || undefined,
        writeTracker: deps.writeTracker,
        onIndexableContextChange: deps.onIndexableContextChange,
      });
      recordManagementScan(
        db,
        repo.id,
        result.status === "skipped_no_activity" ? "skipped_no_activity" : "ok",
      );
      return c.json({
        status: result.status === "skipped_no_activity" ? "skipped_no_activity" : "completed",
        correlationId,
        overviewPath: result.overviewPath,
        journalPath: result.journalPath,
        commitCount: result.commitCount,
        prEvents: result.prEvents,
        workflowEvents: result.workflowEvents,
      });
    } catch (err) {
      recordManagementScan(db, repo.id, "failed");
      logger.error({ err, repositoryId: repo.id }, "Repository management scan failed");
      const message = err instanceof Error ? err.message : String(err);
      return respondWithAgentError(
        c,
        500,
        [
          composeIssue("repositories.management_scan_failed", {
            field: "scan",
            received: message,
          }),
        ],
        { legacyFields: { message, correlationId } },
      );
    }
  });

  return app;
}

// ── helpers ──────────────────────────────────────────────────────

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

interface RunRequestValid {
  backend: TriggerBackend;
  model: string;
  workdirMode: TriggerWorkdirMode;
  prompt: string;
  instructionMd?: string;
}

function validateRunRequest(
  body: Record<string, unknown>,
  repo: RepositoryDTO,
): RunRequestValid | { error: string; message: string } {
  const backend = body.backend;
  if (typeof backend !== "string" || !VALID_BACKENDS.has(backend as TriggerBackend)) {
    return { error: "validation_error", message: `backend must be ${VALID_BACKENDS_LABEL}` };
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return { error: "validation_error", message: "model is required" };
  }
  const workdirMode = body.workdirMode;
  if (
    typeof workdirMode !== "string"
    || !VALID_WORKDIR_MODES.has(workdirMode as TriggerWorkdirMode)
  ) {
    return { error: "validation_error", message: "workdirMode must be temp or local-clone" };
  }
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    return { error: "validation_error", message: "prompt is required" };
  }
  if (workdirMode === "local-clone" && !repo.localPath) {
    return {
      error: "local_clone_required",
      message: "workdirMode='local-clone' requires the repository to have a localPath",
    };
  }
  if (workdirMode === "temp" && typeof body.instructionMd !== "string") {
    return {
      error: "instruction_required",
      message: "workdirMode='temp' requires instructionMd",
    };
  }
  if (body.timeoutMinutes !== undefined && body.timeoutMinutes !== null) {
    // Was accepted (and silently ignored) by earlier versions — the
    // execution path has no per-run timeout override; the wall-clock
    // limit is the global `executeTimeoutMinutes` runtime setting.
    // Reject explicitly rather than pretend the knob works.
    return {
      error: "validation_error",
      message:
        "timeoutMinutes is not supported — the run uses the global executeTimeoutMinutes setting; remove the field",
    };
  }
  return {
    backend: backend as TriggerBackend,
    model: body.model,
    workdirMode: workdirMode as TriggerWorkdirMode,
    prompt: body.prompt,
    instructionMd:
      typeof body.instructionMd === "string" ? body.instructionMd : undefined,
  };
}

function validateTriggerCreate(
  body: Record<string, unknown>,
): { error: string; message: string }
  | {
    name: string;
    enabled?: boolean;
    eventType: string;
    filters?: Record<string, unknown>;
    backend: TriggerBackend;
    model: string;
    workdirMode: TriggerWorkdirMode;
    prompt: string;
    instructionMd?: string | null;
  } {
  if (typeof body.name !== "string" || body.name.length === 0) {
    return { error: "validation_error", message: "name is required" };
  }
  if (typeof body.eventType !== "string" || body.eventType.length === 0) {
    return { error: "validation_error", message: "eventType is required" };
  }
  if (
    typeof body.backend !== "string"
    || !VALID_BACKENDS.has(body.backend as TriggerBackend)
  ) {
    return { error: "validation_error", message: `backend must be ${VALID_BACKENDS_LABEL}` };
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return { error: "validation_error", message: "model is required" };
  }
  if (
    typeof body.workdirMode !== "string"
    || !VALID_WORKDIR_MODES.has(body.workdirMode as TriggerWorkdirMode)
  ) {
    return { error: "validation_error", message: "workdirMode must be temp or local-clone" };
  }
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    return { error: "validation_error", message: "prompt is required" };
  }
  return {
    name: body.name,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    eventType: body.eventType,
    filters:
      body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
        ? (body.filters as Record<string, unknown>)
        : undefined,
    backend: body.backend as TriggerBackend,
    model: body.model,
    workdirMode: body.workdirMode as TriggerWorkdirMode,
    prompt: body.prompt,
    instructionMd:
      typeof body.instructionMd === "string"
        ? body.instructionMd
        : "instructionMd" in body
          ? null
          : undefined,
  };
}

function ensureManagementRow(
  db: Database.Database,
  repositoryId: string,
): void {
  if (!getManagement(db, repositoryId)) {
    setManagementEnabled(db, repositoryId, false);
  }
}

export function buildRunEvent(
  repo: RepositoryDTO,
  request: RunRequestValid,
  triggerSource: string,
  extra: Record<string, unknown> = {},
): AgentTaskEvent {
  const base = createEvent({
    type: "scheduled.task",
    source: "repositories-route",
    priority: EventPriority.HIGH,
  });
  return {
    ...base,
    task: `Run agent against ${repo.slug} (${request.workdirMode}).`,
    taskContext: {
      triggerSource,
      processKey: "agent.task",
      repositoryId: repo.id,
      slug: repo.slug,
      localPath: repo.localPath,
      githubRepo:
        repo.githubOwner && repo.githubRepo
          ? `${repo.githubOwner}/${repo.githubRepo}`
          : null,
      workdirMode: request.workdirMode,
      prompt: request.prompt,
      instructionMd: request.instructionMd ?? null,
      ...extra,
    },
    requestedBackendId: request.backend,
    requestedModelId: request.model,
  };
}

/**
 * Audit-log a repository-bound agent run before it's queued. Best-effort:
 * a logging failure must never block dispatch (the repo_run row is for
 * after-the-fact retrospective via /api/agent/actions; the actual run is
 * what the user cares about).
 *
 * Used by:
 *   - POST /repositories/:id/run                       (mode='manual_run')
 *   - POST /repositories/:id/triggers/:tid/run         (mode='trigger_manual_fire')
 *   - POST /repositories/:id/management/init           (mode='management_init')
 *   - POST /repositories/:id/management/scan           (mode='management_scan')
 *
 * Trigger evaluator-fired sessions log their own row in
 * core/trigger-dispatch.ts (recordTriggerFire updates the trigger row);
 * we do not double-log here.
 */
function recordRepoRunAuditAction(
  db: Database.Database,
  repo: RepositoryDTO,
  detail: Record<string, unknown> & { mode: string; correlationId: string },
): void {
  try {
    const fullDetail = {
      repositoryId: repo.id,
      slug: repo.slug,
      githubRepo:
        repo.githubOwner && repo.githubRepo
          ? `${repo.githubOwner}/${repo.githubRepo}`
          : null,
      localPath: repo.localPath,
      ...detail,
    };
    db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
       VALUES ('repo_run', 'dashboard', NULL, ?, datetime('now'))`,
    ).run(JSON.stringify(fullDetail));
  } catch (err) {
    logger.warn(
      { err, repositoryId: repo.id, mode: detail.mode },
      "Failed to record repo_run audit row — continuing dispatch",
    );
  }
}

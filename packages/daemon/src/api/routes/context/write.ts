// drift-allow-file: route handlers document append-only enforcement for
// legacy aliases (`agent/journal`, `routines/custom/*`); the comments
// explain attack vectors against legacy paths and are load-bearing.
import type { Hono } from "hono";
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import type { ZodError } from "zod";
import {
  contextPatchSchema,
  contextPutSchema,
  getAgentDayDateStr,
  localDateStr,
} from "@aitne/shared";
import { writeFileAtomically } from "../../../core/atomic-write.js";
import { serializeContextFileWrite } from "../../../core/context-file-serializer.js";
import { lintAgentDefinitionMarkdown } from "../../../core/agents/validate-agent-md.js";
import {
  clearEntriesBefore,
  findSection,
  getAvailableSections,
  isLegacyTodayContent,
  prepareContextContentForWrite,
  trimBulletEntries,
  type ContentWriteValidationOptions,
} from "../../../core/context-validation/index.js";
import { createLogger } from "../../../logging.js";
import {
  composeIssue,
  respondWithAgentError,
} from "../../helpers/agent-errors.js";
import { readJsonBody } from "../../json-body.js";
import {
  APPEND_ONLY_PATCH_MODES,
  CREATE_ONLY_PUT,
  isWriteAllowed,
  notifyPromptContextChanged,
  shouldRefreshPromptContext,
} from "./permissions.js";
import {
  normalizeContextPath,
  resolveContextTarget,
  safePath,
} from "./path-resolve.js";
import { performContextFileWrite } from "./write-step.js";
import { mergeFrontmatter } from "./frontmatter-merge.js";
import type { ContextRouteContext } from "./index.js";

const logger = createLogger("context-api");

/**
 * Cap on the JSON body accepted by the Context PUT/PATCH endpoints.
 *
 * Real context files are well under this — `today.md` is typically
 * ~10 KB at the busiest point of the day, `roadmap.md` runs ~50 KB,
 * project pages ~50 KB, and `agent/journal.md` is bounded by the
 * retention rollup. 1 MB leaves >10x headroom for legitimate writes
 * while preventing a runaway-payload denial-of-service:
 *
 *   - The agent could otherwise be tricked (prompt injection from a
 *     poisoned email or Obsidian note) into PATCHing a multi-megabyte
 *     payload, and each PATCH writes a snapshot row in
 *     `md_file_snapshots`. Snapshots are pruned at 30 days, so a
 *     burst of large writes can balloon the DB before retention
 *     catches up.
 *
 *   - 1 MB is an order of magnitude smaller than the attachment route's
 *     25 MB cap; context files have no legitimate need to be that big.
 *
 * Only PUT/PATCH against the wildcard route apply this cap. Smaller
 * structured endpoints (lock, archive-today, repair/stub) use
 * `readOptionalJsonBody` whose payloads are tiny by construction.
 */
const CONTEXT_BODY_MAX_BYTES = 1024 * 1024;

const CONTEXT_PATCH_MODE_VALID_VALUES = [
  "append",
  "replace",
  "clear",
  "clear_before",
  "append_to_file",
] as const;

/**
 * Decompose a failed Zod parse into actionable issues the agent can
 * self-correct from. Each Zod issue becomes its own AgentErrorIssue with:
 *   - `field`: dotted Zod path (e.g. "mode")
 *   - `received`: the value that actually failed validation, so the agent
 *     sees what it sent — not just the schema's expectation.
 *   - `validValues`: for enum-like fields, surface the accepted list.
 *
 * When the top-level body is not an object (or is null/array), emit a
 * single `context.body_not_object` issue so the existing hint kicks in.
 * Otherwise each field-level failure is `context.invalid_body_field` —
 * a new code introduced because the legacy `body_not_object` was emitted
 * for both shapes and confused the agent (the prior hint said "wrap in
 * {}" even when the body was already an object).
 */
function buildSchemaIssues(body: unknown, error: ZodError) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return [
      composeIssue("context.body_not_object", {
        field: "body",
        received:
          body === null
            ? "null"
            : Array.isArray(body)
              ? "array"
              : typeof body,
      }),
    ];
  }
  const seen = new Set<string>();
  const issues = [];
  for (const issue of error.issues) {
    const field = issue.path.length === 0 ? "body" : issue.path.join(".");
    // Zod refinements emit duplicate path entries — dedupe so the response
    // doesn't repeat the same row-level error.
    const key = `${field}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Zod 4 exposes the failing value on issue.input; fall back to walking
    // the body by path so older issue shapes still surface something useful.
    const received = readPath(body as Record<string, unknown>, issue.path);
    const validValues =
      field === "mode" ? CONTEXT_PATCH_MODE_VALID_VALUES : undefined;
    issues.push(
      composeIssue("context.invalid_body_field", {
        field,
        received,
        expected: issue.message,
        validValues,
      }),
    );
  }
  // If Zod produced no issues (unreachable from safeParse, but defensive),
  // emit a single fallback so the agent still gets actionable output.
  if (issues.length === 0) {
    issues.push(
      composeIssue("context.invalid_body_field", {
        field: "body",
        received: "(see route schema)",
      }),
    );
  }
  return issues;
}

function readPath(
  root: Record<string, unknown>,
  path: ReadonlyArray<PropertyKey>,
): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

/**
 * Non-blocking prompt-quality warnings to attach to a SUCCESSFUL context write
 * of an `agent.md` (audit B5). Returns `{}` for every non-agent path, so the
 * response shape for today.md / roadmap / etc. is byte-identical to before; only
 * an agent.md write can add a `warnings` array (mirroring the create route's
 * 201 shape). Runs strictly on the success side — never turns a write into a 400.
 */
function agentMdWriteWarnings(
  relativePath: string,
  content: string,
): { warnings?: unknown } {
  const warnings = lintAgentDefinitionMarkdown(relativePath, content);
  return warnings.length > 0 ? { warnings } : {};
}

/**
 * SELF_IMPROVEMENT_PHASE2 — normalizer options for a potential lessons-store
 * write. Passed on every PUT/PATCH; `prepareContextContentForWrite` applies
 * them only when the target actually is a lessons store, so non-lessons
 * writes are byte-identical to before.
 */
function lessonNormalizationFor(
  config: {
    timezone: string;
    feedbackPromotionThreshold: number;
    feedbackLessonStaleDays: number;
    feedbackLessonConfidenceFloor: number;
    feedbackContradictionGuardCf: number;
  },
  previousContent: string | null,
): ContentWriteValidationOptions["lessonNormalization"] {
  return {
    previousContent,
    nowIso: new Date().toISOString(),
    promotionThreshold: config.feedbackPromotionThreshold,
    enactExpiration: true,
    staleDays: config.feedbackLessonStaleDays,
    confidenceFloor: config.feedbackLessonConfidenceFloor,
    contradictionGuardCf: config.feedbackContradictionGuardCf,
  };
}

export function registerWriteRoutes(app: Hono, ctx: ContextRouteContext): void {
  const {
    deps,
    getCurrentContextDir,
    morningRoutineLock,
    roadmapWriteLock,
    saveSnapshot,
    isRoadmapValidationDisabled,
    logRoadmapValidationBypass,
    roadmapDefaultLongTermPlanSource,
  } = ctx;
  const { config, writeTracker } = deps;

  // PUT /context/* — Full replace
  app.put("/context/*", async (c) => {
    const rawPath = c.req.path.replace("/api/context/", "");
    const target = resolveContextTarget(rawPath);
    const path = target.base;

    const contextDir = getCurrentContextDir();
    const fullPath = safePath(contextDir, rawPath);
    if (!fullPath) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_invalid", {
          field: "path",
          received: path,
        }),
      ]);
    }
    if (!isWriteAllowed(path, "PUT")) {
      logger.warn({ path, method: "PUT" }, "Context write forbidden");
      return respondWithAgentError(c, 403, [
        composeIssue("context.write_forbidden", {
          field: "path",
          received: { path, method: "PUT" },
        }),
      ]);
    }
    // Morning Routine lock: reject writes to today while lock is held
    if (morningRoutineLock.getHolder() && path === "state/today") {
      const lockId = c.req.header("X-Lock-Id");
      if (!morningRoutineLock.isHeldBy(lockId)) {
        logger.info({ path }, "Context PUT rejected — morning routine lock held");
        return respondWithAgentError(c, 409, [
          composeIssue("context.morning_routine_lock_held", {
            field: "X-Lock-Id",
            received: lockId ?? "<missing>",
          }),
        ]);
      }
    }
    // Roadmap write lock: reject writes to roadmap while another session holds it
    if (roadmapWriteLock.getHolder() && path === "plans/roadmap") {
      const lockId = c.req.header("X-Lock-Id");
      if (!roadmapWriteLock.isHeldBy(lockId)) {
        logger.info({ path }, "Context PUT rejected — roadmap write lock held");
        return respondWithAgentError(c, 409, [
          composeIssue("context.roadmap_write_lock_held", {
            field: "X-Lock-Id",
            received: lockId ?? "<missing>",
          }),
        ]);
      }
    }

    const parsedBody = await readJsonBody(c, { maxBytes: CONTEXT_BODY_MAX_BYTES });
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body;
    const parsed = contextPutSchema.safeParse(body);
    if (!parsed.success) {
      return respondWithAgentError(c, 400, buildSchemaIssues(body, parsed.error));
    }
    const roadmapValidationOff = isRoadmapValidationDisabled(
      path,
      c.req.header("X-Roadmap-Validation"),
    );
    if (roadmapValidationOff) {
      logRoadmapValidationBypass(c, "PUT", path);
    }
    const expectedAgentDay = path === "state/today"
      ? getAgentDayDateStr(config.timezone || undefined, config.dayBoundaryHour ?? 4)
      : undefined;
    const preflight = prepareContextContentForWrite(target, parsed.data.content, {
      timezone: config.timezone || undefined,
      disableRoadmapValidation: roadmapValidationOff,
      defaultLongTermPlanSource: roadmapDefaultLongTermPlanSource(c),
      expectedAgentDay,
      lessonNormalization: lessonNormalizationFor(config, null),
    });
    if (!preflight.ok) {
      return respondWithAgentError(c, preflight.status, [
        composeIssue("context.content_validation_failed", {
          field: preflight.path ?? "content",
          received: preflight.message,
        }),
      ], {
        legacyFields: {
          message: preflight.message,
          path: preflight.path,
        },
      });
    }

    const sessionId = c.req.header("X-Session-Id");

    return serializeContextFileWrite(fullPath, () => {
      // Append-only files: PUT is only allowed for initial creation.
      // Once the file exists, all writes must go through PATCH to preserve
      // the append-only contract. This check MUST be inside the serializer
      // to prevent TOCTOU races where two concurrent PUTs both pass an
      // outer existsSync check and then sequentially overwrite.
      if (CREATE_ONLY_PUT.has(path) && existsSync(fullPath)) {
        logger.warn({ path }, "Context PUT rejected — file exists, use PATCH to append");
        return respondWithAgentError(c, 409, [
          composeIssue("context.append_only_violation", {
            field: "path",
            received: { path, hint: `Use PATCH to append new sections to ${path}.` },
          }),
        ]);
      }

      // Optimistic concurrency check: if client supplied expectedMtime,
      // compare against the current file. On mismatch, return 409 with
      // the current state so the UI can surface a conflict dialog without
      // a second round-trip.
      let contentToWrite = preflight.content;
      if (existsSync(fullPath)) {
        const currentStat = statSync(fullPath);
        const currentMtime = currentStat.mtime.toISOString();
        const existing = readFileSync(fullPath, "utf-8");

        if (
          parsed.data.expectedMtime !== undefined &&
          parsed.data.expectedMtime !== currentMtime
        ) {
          logger.info({ path, expectedMtime: parsed.data.expectedMtime, currentMtime }, "Context PUT conflict");
          return c.json(
            {
              ok: false,
              error: "conflict",
              summary:
                `PUT conflict on ${path}: expectedMtime ${parsed.data.expectedMtime} did not match current ${currentMtime}. GET the file, replay your change, and retry.`,
              errors: [
                composeIssue("context.write_conflict", {
                  field: "expectedMtime",
                  received: { expectedMtime: parsed.data.expectedMtime, currentMtime },
                }),
              ],
              retryable: true,
              currentMtime,
              currentContent: existing,
            },
            409,
          );
        }

        const prepared = prepareContextContentForWrite(target, parsed.data.content, {
          timezone: config.timezone || undefined,
          disableRoadmapValidation: roadmapValidationOff,
          previousRoadmapContent: existing,
          today: localDateStr(new Date(), config.timezone || undefined),
          defaultLongTermPlanSource: roadmapDefaultLongTermPlanSource(c),
          expectedAgentDay,
          lessonNormalization: lessonNormalizationFor(config, existing),
        });
        if (!prepared.ok) {
          return respondWithAgentError(c, prepared.status, [
            composeIssue("context.content_validation_failed", {
              field: prepared.path ?? "content",
              received: prepared.message,
            }),
          ], {
            legacyFields: {
              message: prepared.message,
              path: prepared.path,
            },
          });
        }
        contentToWrite = prepared.content;
      } else if (parsed.data.expectedMtime !== undefined) {
        // Client expected a specific mtime but the file is gone
        return c.json(
          {
            ok: false,
            error: "conflict",
            summary: `PUT conflict on ${path}: expectedMtime ${parsed.data.expectedMtime} but file no longer exists.`,
            errors: [
              composeIssue("context.write_conflict", {
                field: "expectedMtime",
                received: { expectedMtime: parsed.data.expectedMtime, currentMtime: "" },
              }),
            ],
            retryable: true,
            currentMtime: "",
            currentContent: "",
          },
          409,
        );
      }

      // Shared write step — daily-skeleton frontmatter validation,
      // atomic write, snapshot, writeTracker, indexable hint. See
      // `write-step.ts:performContextFileWrite` for the contract.
      const writeResult = performContextFileWrite(
        {
          saveSnapshot,
          ...(writeTracker ? { writeTracker } : {}),
          onIndexableContextChange: deps.onIndexableContextChange ?? undefined,
        },
        {
          absolutePath: fullPath,
          relativePath: `${path}${target.ext}`,
          snapshotKey: path,
          mode: "put",
          content: contentToWrite,
          trigger: "api_put",
          forceSnapshot: true,
          sessionId: sessionId ?? null,
          validateDailySkeleton: true,
        },
      );
      if (!writeResult.ok) {
        if (writeResult.reason === "daily_skeleton_drift") {
          return respondWithAgentError(
            c,
            422,
            writeResult.driftErrors.map((drift) =>
              composeIssue("context.daily_skeleton_field_drift", {
                field: drift.field,
                received: drift.received ?? "<missing>",
                expected: drift.expected,
              }),
            ),
          );
        }
        // `missing_for_append` is unreachable in the PUT branch — the
        // helper only returns it for `mode = "append_block"`. Defensive
        // fall-through keeps the type narrow.
        /* c8 ignore next 6 */
        return respondWithAgentError(c, 500, [
          composeIssue("context.write_failed", {
            field: "path",
            received: path,
          }),
        ]);
      }
      if (shouldRefreshPromptContext(path, "PUT")) {
        notifyPromptContextChanged(
          deps,
          path,
          `context_put:${path}`,
          { path, method: "PUT" },
        );
      }
      const writtenStat = statSync(fullPath);
      logger.info(
        {
          path,
          method: "PUT",
          bytesWritten: writeResult.bytesWritten,
          snapshotId: writeResult.snapshotId ?? undefined,
        },
        "Context file updated",
      );
      return c.json({
        status: "updated",
        snapshotId: writeResult.snapshotId ?? 0,
        lastModified: writtenStat.mtime.toISOString(),
        ...agentMdWriteWarnings(`${path}${target.ext}`, contentToWrite),
      });
    });
  });

  // PATCH /context/* — Section operation
  app.patch("/context/*", async (c) => {
    const rawPath = c.req.path.replace("/api/context/", "");
    const target = resolveContextTarget(rawPath);
    const path = target.base;

    const contextDir = getCurrentContextDir();
    const fullPath = safePath(contextDir, rawPath);
    if (!fullPath) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_invalid", {
          field: "path",
          received: path,
        }),
      ]);
    }
    if (!isWriteAllowed(path, "PATCH")) {
      logger.warn({ path, method: "PATCH" }, "Context write forbidden");
      return respondWithAgentError(c, 403, [
        composeIssue("context.write_forbidden", {
          field: "path",
          received: { path, method: "PATCH" },
        }),
      ]);
    }
    // Morning Routine lock: reject writes to today while lock is held
    if (morningRoutineLock.getHolder() && path === "state/today") {
      const lockId = c.req.header("X-Lock-Id");
      if (!morningRoutineLock.isHeldBy(lockId)) {
        logger.info({ path }, "Context PATCH rejected — morning routine lock held");
        return respondWithAgentError(c, 409, [
          composeIssue("context.morning_routine_lock_held", {
            field: "X-Lock-Id",
            received: lockId ?? "<missing>",
          }),
        ]);
      }
    }
    // Roadmap write lock: reject writes to roadmap while another session holds it
    if (roadmapWriteLock.getHolder() && path === "plans/roadmap") {
      const lockId = c.req.header("X-Lock-Id");
      if (!roadmapWriteLock.isHeldBy(lockId)) {
        logger.info({ path }, "Context PATCH rejected — roadmap write lock held");
        return respondWithAgentError(c, 409, [
          composeIssue("context.roadmap_write_lock_held", {
            field: "X-Lock-Id",
            received: lockId ?? "<missing>",
          }),
        ]);
      }
    }

    const parsedBody = await readJsonBody(c, { maxBytes: CONTEXT_BODY_MAX_BYTES });
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body;
    const parsed = contextPatchSchema.safeParse(body);
    if (!parsed.success) {
      return respondWithAgentError(c, 400, buildSchemaIssues(body, parsed.error));
    }
    if (target.ext === ".base") {
      return respondWithAgentError(c, 400, [
        composeIssue("context.unsupported_operation", {
          field: "method",
          received: { method: "PATCH", ext: ".base", hint: "Use PUT to replace .base files." },
        }),
      ]);
    }

    const { section, mode, content: newContent, cutoff, maxEntries, frontmatter } = parsed.data;

    // Append-only enforcement — see `permissions.ts:CREATE_ONLY_PUT` /
    // `APPEND_ONLY_PATCH_MODES`. The PUT-side gate at line ~267 rejects
    // re-creates of these files; this gate is the PATCH-side half. Without
    // it, a prompt-injected agent could PATCH `agent/journal` with
    // `mode:"replace"` (or `"clear"` / `"clear_before"`) and silently erase
    // historical entries. We check OUTSIDE the per-path serializer
    // because the decision is body-only and we want to fail fast before
    // queueing behind any in-flight write to the same file.
    if (CREATE_ONLY_PUT.has(path) && !APPEND_ONLY_PATCH_MODES.has(mode)) {
      logger.warn(
        { path, mode },
        "Context PATCH rejected — append-only path requires append mode",
      );
      return respondWithAgentError(c, 409, [
        composeIssue("context.append_only_violation", {
          field: "mode",
          received: {
            path,
            mode,
            hint: `${path} is append-only. Use mode:"append" or "append_to_file" — existing sections cannot be replaced or cleared.`,
            validModes: Array.from(APPEND_ONLY_PATCH_MODES),
          },
        }),
      ]);
    }

    const sessionId = c.req.header("X-Session-Id");
    const roadmapValidationOff = isRoadmapValidationDisabled(
      path,
      c.req.header("X-Roadmap-Validation"),
    );
    if (roadmapValidationOff) {
      logRoadmapValidationBypass(c, "PATCH", path);
    }
    const expectedAgentDay = path === "state/today"
      ? getAgentDayDateStr(config.timezone || undefined, config.dayBoundaryHour ?? 4)
      : undefined;

    return serializeContextFileWrite(fullPath, () => {
      if (!existsSync(fullPath)) {
        return respondWithAgentError(c, 404, [
          composeIssue("context.path_not_found", {
            field: "path",
            received: path,
          }),
        ]);
      }

      const fileContent = readFileSync(fullPath, "utf-8");

      // ── append_to_file: append content to end of file (no section lookup) ──
      // Designed for agent/journal.md and similar append-only files where
      // each write adds a new top-level ## section rather than modifying
      // an existing one. Avoids the hack of targeting the last section's
      // body and injecting H2 headers inside it.
      if (mode === "append_to_file") {
        // Preserve the existing file's line-ending convention: a CRLF-bodied
        // vault file (Windows / Obsidian on Windows) must get CRLF separators
        // and terminator, not LF, or the file ends up with mixed endings that
        // round-trip dirty under git autocrlf. LF files (macOS/Linux) keep "\n".
        const eol = /\r\n/.test(fileContent) ? "\r\n" : "\n";
        const separator = fileContent.endsWith("\n") ? "" : eol;
        const updated = fileContent + separator + (newContent ?? "") + eol;
        // Run the same content-validation chain as before — this is
        // call-site-specific (allowLegacyToday flag, previousRoadmapContent)
        // and intentionally lives on the HTTP route. The shared helper
        // then performs the raw atomic-write step against the already-
        // validated byte stream so HTTP and the in-process daemon
        // composer share one snapshot/writeTracker/indexable invariant.
        const prepared = prepareContextContentForWrite(target, updated, {
          timezone: config.timezone || undefined,
          disableRoadmapValidation: roadmapValidationOff,
          previousRoadmapContent: fileContent,
          today: localDateStr(new Date(), config.timezone || undefined),
          defaultLongTermPlanSource: roadmapDefaultLongTermPlanSource(c),
          allowLegacyToday: path === "state/today" && isLegacyTodayContent(fileContent),
          expectedAgentDay,
          lessonNormalization: lessonNormalizationFor(config, fileContent),
        });
        if (!prepared.ok) {
          return respondWithAgentError(c, prepared.status, [
            composeIssue("context.content_validation_failed", {
              field: prepared.path ?? "content",
              received: prepared.message,
            }),
          ], {
            legacyFields: {
              message: prepared.message,
              path: prepared.path,
            },
          });
        }
        // The validator may rewrite content; PUT the rewritten bytes
        // directly rather than re-running the append through the helper
        // (which would otherwise double-append). The PATCH-side caller
        // ALREADY did the read-modify-write — we just need the atomic-
        // replace at this point. Hence `mode: "put"` even though this is
        // the PATCH route — what's atomic from the helper's perspective
        // is the disk-replace step, not the source operation.
        const writeResult = performContextFileWrite(
          {
            saveSnapshot,
            ...(writeTracker ? { writeTracker } : {}),
            onIndexableContextChange: deps.onIndexableContextChange ?? undefined,
          },
          {
            absolutePath: fullPath,
            relativePath: `${path}${target.ext}`,
            snapshotKey: path,
            mode: "put",
            content: prepared.content,
            trigger: "api_patch",
            forceSnapshot: false,
            sessionId: sessionId ?? null,
            // append_to_file is used for agent/journal.md and other
            // non-daily files; the daily-skeleton validator is not
            // applicable. (The composer's daily-file revision branch
            // calls the helper with `mode: "append_block"` directly.)
            validateDailySkeleton: false,
          },
        );
        if (!writeResult.ok) {
          /* c8 ignore next 6 — defensive guard for unreachable branches */
          return respondWithAgentError(c, 500, [
            composeIssue("context.write_failed", {
              field: "path",
              received: path,
            }),
          ]);
        }
        if (shouldRefreshPromptContext(path, "PATCH")) {
          notifyPromptContextChanged(
            deps,
            path,
            `context_patch:${path}`,
            {
              path,
              method: "PATCH",
              mode,
              section,
              content: newContent,
              previousContent: fileContent,
            },
          );
        }
        logger.info({ path, method: "PATCH", mode }, "Content appended to file");
        return c.json({
          status: "appended",
          ...agentMdWriteWarnings(`${path}${target.ext}`, prepared.content),
        });
      }

      // ── frontmatterMerge: deep-merge a partial frontmatter object ──
      // (docs/design/21-management-registry-and-entities.md §10.4 step 4b —
      // entity sources.<app>.<id> linkage + last_synced_at). The schema
      // guarantees `frontmatter` is a non-empty object for this mode and no
      // section is needed; the body is preserved verbatim. Runs the same
      // content-validation + atomic-write chain as the other modes.
      if (mode === "frontmatterMerge") {
        const merged = mergeFrontmatter(fileContent, frontmatter!);
        if (!merged.ok) {
          return respondWithAgentError(c, 400, [
            composeIssue("context.content_validation_failed", {
              field: "frontmatter",
              received: merged.message,
            }),
          ]);
        }
        const prepared = prepareContextContentForWrite(target, merged.content, {
          timezone: config.timezone || undefined,
          disableRoadmapValidation: roadmapValidationOff,
          previousRoadmapContent: fileContent,
          today: localDateStr(new Date(), config.timezone || undefined),
          defaultLongTermPlanSource: roadmapDefaultLongTermPlanSource(c),
          allowLegacyToday: path === "state/today" && isLegacyTodayContent(fileContent),
          expectedAgentDay,
          lessonNormalization: lessonNormalizationFor(config, fileContent),
        });
        if (!prepared.ok) {
          return respondWithAgentError(c, prepared.status, [
            composeIssue("context.content_validation_failed", {
              field: prepared.path ?? "content",
              received: prepared.message,
            }),
          ], {
            legacyFields: {
              message: prepared.message,
              path: prepared.path,
            },
          });
        }
        const writeResult = performContextFileWrite(
          {
            saveSnapshot,
            ...(writeTracker ? { writeTracker } : {}),
            onIndexableContextChange: deps.onIndexableContextChange ?? undefined,
          },
          {
            absolutePath: fullPath,
            relativePath: `${path}${target.ext}`,
            snapshotKey: path,
            mode: "put",
            content: prepared.content,
            trigger: "api_patch",
            forceSnapshot: false,
            sessionId: sessionId ?? null,
            validateDailySkeleton: false,
          },
        );
        if (!writeResult.ok) {
          /* c8 ignore next 6 — defensive guard for unreachable branches */
          return respondWithAgentError(c, 500, [
            composeIssue("context.write_failed", {
              field: "path",
              received: path,
            }),
          ]);
        }
        if (shouldRefreshPromptContext(path, "PATCH")) {
          notifyPromptContextChanged(deps, path, `context_patch:${path}`, {
            path,
            method: "PATCH",
            mode,
            section,
            content: newContent,
            previousContent: fileContent,
          });
        }
        logger.info({ path, method: "PATCH", mode }, "Frontmatter merged");
        return c.json({
          status: "merged",
          ...agentMdWriteWarnings(`${path}${target.ext}`, prepared.content),
        });
      }

      // ── Section-based modes: require section lookup ──
      const sectionBounds = findSection(fileContent, section!);

      if (!sectionBounds) {
        const availableSections = getAvailableSections(fileContent);
        return respondWithAgentError(c, 400, [
          composeIssue("context.section_not_found", {
            field: "section",
            received: { section, availableSections },
          }),
        ], {
          legacyFields: {
            section,
            availableSections,
          },
        });
      }

      let updated: string;
      const before = fileContent.slice(0, sectionBounds.start);
      const after = fileContent.slice(sectionBounds.end);
      const currentBody = fileContent.slice(
        sectionBounds.start,
        sectionBounds.end,
      );
      let removedCount: number | undefined;
      let trimmedCount: number | undefined;

      // Preserve the existing file's line-ending convention (see append_to_file
      // above): emit CRLF separators/terminators for a CRLF-bodied file so we
      // don't produce mixed endings. LF files (macOS/Linux) keep "\n".
      const eol = /\r\n/.test(fileContent) ? "\r\n" : "\n";

      switch (mode) {
        case "append": {
          // Ensure a single newline separator without destroying existing content
          const separator = currentBody.endsWith("\n") ? "" : eol;
          let appendedBody = currentBody + separator + (newContent ?? "") + eol;

          // maxEntries: trim oldest bullet entries from the top
          if (maxEntries !== undefined) {
            const trimResult = trimBulletEntries(appendedBody, maxEntries);
            appendedBody = trimResult.body;
            trimmedCount = trimResult.trimmed;
          }

          updated = before + appendedBody + after;
          break;
        }
        case "replace":
          updated = before + (newContent ?? "") + eol + after;
          break;
        case "clear":
          updated = before + eol + after;
          break;
        case "clear_before": {
          // Schema refinements validate format, but defense-in-depth for
          // direct API callers that bypass schema validation.
          if (!cutoff || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cutoff)) {
            return respondWithAgentError(c, 400, [
              composeIssue("context.cutoff_required", {
                field: "cutoff",
                received: cutoff ?? "<missing>",
                expected: "'YYYY-MM-DD HH:MM:SS' format (zero-padded)",
              }),
            ]);
          }
          const clearResult = clearEntriesBefore(currentBody, cutoff);
          updated = before + clearResult.remaining + after;
          removedCount = clearResult.removedCount;
          break;
        }
      }

      const prepared = prepareContextContentForWrite(target, updated, {
        timezone: config.timezone || undefined,
        disableRoadmapValidation: roadmapValidationOff,
        previousRoadmapContent: fileContent,
        today: localDateStr(new Date(), config.timezone || undefined),
        defaultLongTermPlanSource: roadmapDefaultLongTermPlanSource(c),
        allowLegacyToday: path === "state/today" && isLegacyTodayContent(fileContent),
        expectedAgentDay,
        lessonNormalization: lessonNormalizationFor(config, fileContent),
      });
      if (!prepared.ok) {
        return respondWithAgentError(c, prepared.status, [
          composeIssue("context.content_validation_failed", {
            field: prepared.path ?? "content",
            received: prepared.message,
          }),
        ], {
          legacyFields: {
            message: prepared.message,
            path: prepared.path,
          },
        });
      }

      // Force snapshot on replace (bypass debounce) to ensure recovery
      // from accidental overwrites. Other modes use normal debounce.
      const forceSnapshot = mode === "replace" || mode === "clear" || mode === "clear_before";
      saveSnapshot(path, fileContent, "api_patch", forceSnapshot, sessionId);

      // Mark before the rename so FS-watch consumers attribute the
      // resulting event to the agent. Roll back on failure (C2).
      writeTracker?.markWriting(fullPath, prepared.content);
      try {
        writeFileAtomically(fullPath, prepared.content);
      } catch (writeErr) {
        writeTracker?.unmark(fullPath);
        throw writeErr;
      }
      if (shouldRefreshPromptContext(path, "PATCH")) {
        notifyPromptContextChanged(
          deps,
          path,
          `context_patch:${path}`,
          {
            path,
            method: "PATCH",
            mode,
            section,
            content: newContent,
            previousContent: fileContent,
          },
        );
      }
      deps.onIndexableContextChange?.(`${path}${target.ext}`);
      const resultStatus = mode === "append" ? "appended" : mode === "replace" ? "replaced" : "cleared";
      logger.info({ path, method: "PATCH", section, mode, removedCount, trimmedCount }, "Context section " + resultStatus);
      return c.json({
        status: resultStatus,
        removedCount,
        trimmedCount,
        ...agentMdWriteWarnings(`${path}${target.ext}`, prepared.content),
      });
    });
  });

  // DELETE /context/* — File delete (currently limited to `routines/custom/*`
  // via the write-permission whitelist). B-007 §5.8 Q3: the agent retires a
  // custom routine after the user confirms. (Legacy path — custom routines
  // no longer fire; they were converted to user Agents at the Agents-hub
  // redesign. The delete surface stays so leftover files can be removed.)
  app.delete("/context/*", (c) => {
    const path = normalizeContextPath(c.req.path.replace("/api/context/", ""));

    const contextDir = getCurrentContextDir();
    const fullPath = safePath(contextDir, path);
    if (!fullPath) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_invalid", {
          field: "path",
          received: path,
        }),
      ]);
    }
    if (!isWriteAllowed(path, "DELETE")) {
      logger.warn({ path, method: "DELETE" }, "Context delete forbidden");
      return respondWithAgentError(c, 403, [
        composeIssue("context.write_forbidden", {
          field: "path",
          received: { path, method: "DELETE" },
        }),
      ]);
    }

    return serializeContextFileWrite(fullPath, () => {
      if (!existsSync(fullPath)) {
        return respondWithAgentError(c, 404, [
          composeIssue("context.path_not_found", {
            field: "path",
            received: path,
          }),
        ]);
      }
      const existing = readFileSync(fullPath, "utf-8");
      const snapshotId = saveSnapshot(path, existing, "api_delete", true);
      unlinkSync(fullPath);
      deps.onIndexableContextChange?.(path);
      logger.info({ path, method: "DELETE", snapshotId: snapshotId ?? undefined }, "Context file deleted");
      return c.json({ status: "deleted", snapshotId: snapshotId ?? 0 });
    });
  });
}

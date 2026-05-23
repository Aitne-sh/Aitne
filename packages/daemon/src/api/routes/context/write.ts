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
import { validateDailySkeletonFrontmatter } from "../../../core/context-frontmatter.js";
import {
  clearEntriesBefore,
  findSection,
  getAvailableSections,
  isLegacyTodayContent,
  prepareContextContentForWrite,
  trimBulletEntries,
} from "../../../core/context-validation/index.js";
import { createLogger } from "../../../logging.js";
import {
  composeIssue,
  respondWithAgentError,
} from "../../helpers/agent-errors.js";
import { readJsonBody } from "../../json-body.js";
import {
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

export function registerWriteRoutes(app: Hono, ctx: ContextRouteContext): void {
  const {
    deps,
    getCurrentContextDir,
    morningRoutineLock,
    roadmapWriteLock,
    saveSnapshot,
    withWriteLock,
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
    if (morningRoutineLock.getHolder() && path === "today") {
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
    if (roadmapWriteLock.getHolder() && path === "roadmap") {
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
    const expectedAgentDay = path === "today"
      ? getAgentDayDateStr(config.timezone || undefined, config.dayBoundaryHour ?? 4)
      : undefined;
    const preflight = prepareContextContentForWrite(target, parsed.data.content, {
      timezone: config.timezone || undefined,
      disableRoadmapValidation: roadmapValidationOff,
      defaultLongTermPlanSource: roadmapDefaultLongTermPlanSource(c),
      expectedAgentDay,
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

    // morning-routine-optimization.md §"PUT /api/context/daily/<date>
    // skeleton-preservation validator" — only runs once generic
    // frontmatter validation (type/owner/updated/H1) has passed.
    // Returns per-field structured drift errors for the five
    // skeleton-owned frontmatter fields (date, weekday,
    // agent_generated, calendar_events, messages_handled) so Stage B
    // can fix every missing/malformed field in a single retry rather
    // than discovering them one at a time. Body is NOT validated —
    // Stage B authors body per rules/journal-format.md.
    if (target.base.startsWith("daily/")) {
      const dailyRelativePath = `${target.base}${target.ext}`;
      const driftErrors = validateDailySkeletonFrontmatter(
        preflight.content,
        dailyRelativePath,
      );
      if (driftErrors.length > 0) {
        return respondWithAgentError(
          c,
          422,
          driftErrors.map((drift) =>
            composeIssue("context.daily_skeleton_field_drift", {
              field: drift.field,
              received: drift.received ?? "<missing>",
              expected: drift.expected,
            }),
          ),
        );
      }
    }

    const sessionId = c.req.header("X-Session-Id");

    return withWriteLock(() => {
      // Append-only files: PUT is only allowed for initial creation.
      // Once the file exists, all writes must go through PATCH to preserve
      // the append-only contract. This check MUST be inside withWriteLock
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
      let snapshotId: number | null = null;
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

        snapshotId = saveSnapshot(path, existing, "api_put", true, sessionId);
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

      // Symlink-safe atomic write — protects against a TOCTOU swap of
      // `fullPath` to a symlink between safePath validation and the write.
      // Mark before the rename so FS-watch consumers attribute the
      // resulting event to the agent. Roll back on failure (C2).
      writeTracker?.markWriting(fullPath, contentToWrite);
      try {
        writeFileAtomically(fullPath, contentToWrite);
      } catch (writeErr) {
        writeTracker?.unmark(fullPath);
        throw writeErr;
      }
      if (shouldRefreshPromptContext(path, "PUT")) {
        notifyPromptContextChanged(
          deps,
          path,
          `context_put:${path}`,
          { path, method: "PUT" },
        );
      }
      if (path.startsWith("routines/custom/")) {
        deps.onCustomRoutinesChanged?.();
      }
      deps.onIndexableContextChange?.(`${path}${target.ext}`);
      const writtenStat = statSync(fullPath);
      logger.info(
        { path, method: "PUT", bytesWritten: writtenStat.size, snapshotId: snapshotId ?? undefined },
        "Context file updated",
      );
      return c.json({
        status: "updated",
        snapshotId: snapshotId ?? 0,
        lastModified: writtenStat.mtime.toISOString(),
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
    if (morningRoutineLock.getHolder() && path === "today") {
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
    if (roadmapWriteLock.getHolder() && path === "roadmap") {
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

    const { section, mode, content: newContent, cutoff, maxEntries } = parsed.data;
    const sessionId = c.req.header("X-Session-Id");
    const roadmapValidationOff = isRoadmapValidationDisabled(
      path,
      c.req.header("X-Roadmap-Validation"),
    );
    if (roadmapValidationOff) {
      logRoadmapValidationBypass(c, "PATCH", path);
    }
    const expectedAgentDay = path === "today"
      ? getAgentDayDateStr(config.timezone || undefined, config.dayBoundaryHour ?? 4)
      : undefined;

    return withWriteLock(() => {
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
        const separator = fileContent.endsWith("\n") ? "" : "\n";
        const updated = fileContent + separator + (newContent ?? "") + "\n";
        const prepared = prepareContextContentForWrite(target, updated, {
          timezone: config.timezone || undefined,
          disableRoadmapValidation: roadmapValidationOff,
          previousRoadmapContent: fileContent,
          today: localDateStr(new Date(), config.timezone || undefined),
          defaultLongTermPlanSource: roadmapDefaultLongTermPlanSource(c),
          allowLegacyToday: path === "today" && isLegacyTodayContent(fileContent),
          expectedAgentDay,
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
        saveSnapshot(path, fileContent, "api_patch", false, sessionId);
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
        if (path.startsWith("routines/custom/")) {
          deps.onCustomRoutinesChanged?.();
        }
        deps.onIndexableContextChange?.(`${path}${target.ext}`);
        logger.info({ path, method: "PATCH", mode }, "Content appended to file");
        return c.json({ status: "appended" });
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

      switch (mode) {
        case "append": {
          // Ensure a single newline separator without destroying existing content
          const separator = currentBody.endsWith("\n") ? "" : "\n";
          let appendedBody = currentBody + separator + (newContent ?? "") + "\n";

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
          updated = before + (newContent ?? "") + "\n" + after;
          break;
        case "clear":
          updated = before + "\n" + after;
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
        allowLegacyToday: path === "today" && isLegacyTodayContent(fileContent),
        expectedAgentDay,
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
      if (path.startsWith("routines/custom/")) {
        deps.onCustomRoutinesChanged?.();
      }
      deps.onIndexableContextChange?.(`${path}${target.ext}`);
      const resultStatus = mode === "append" ? "appended" : mode === "replace" ? "replaced" : "cleared";
      logger.info({ path, method: "PATCH", section, mode, removedCount, trimmedCount }, "Context section " + resultStatus);
      return c.json({ status: resultStatus, removedCount, trimmedCount });
    });
  });

  // DELETE /context/* — File delete (currently limited to `routines/custom/*`
  // via the write-permission whitelist). B-007 §5.8 Q3: the agent retires a
  // custom routine after the user confirms. The scheduler listens via
  // `onCustomRoutinesChanged` and unregisters the cron job on reload.
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

    return withWriteLock(() => {
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
      if (path.startsWith("routines/custom/")) {
        deps.onCustomRoutinesChanged?.();
      }
      deps.onIndexableContextChange?.(path);
      logger.info({ path, method: "DELETE", snapshotId: snapshotId ?? undefined }, "Context file deleted");
      return c.json({ status: "deleted", snapshotId: snapshotId ?? 0 });
    });
  });
}

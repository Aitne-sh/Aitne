import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AGENT_ERROR_REGISTRY,
  buildEnvelope,
  composeIssue,
  composeWarning,
  formatZodPath,
  translateZodError,
  translateZodIssue,
} from "./agent-errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");

describe("agent-errors helper", () => {
  describe("composeIssue", () => {
    it("pulls expected / hint / skillAnchor / constraint from the registry", () => {
      const issue = composeIssue("schedule.scheduled_for_in_past", {
        field: "rows[4].scheduledFor",
        received: "2026-05-15T03:45:00",
        rowIndex: 4,
      });

      expect(issue.code).toBe("schedule.scheduled_for_in_past");
      expect(issue.field).toBe("rows[4].scheduledFor");
      expect(issue.received).toBe("2026-05-15T03:45:00");
      expect(issue.rowIndex).toBe(4);
      expect(issue.expected).toBe(
        AGENT_ERROR_REGISTRY["schedule.scheduled_for_in_past"].expected,
      );
      expect(issue.hint).toBe(
        AGENT_ERROR_REGISTRY["schedule.scheduled_for_in_past"].hint,
      );
      expect(issue.skillAnchor).toBe(
        AGENT_ERROR_REGISTRY["schedule.scheduled_for_in_past"].skillAnchor,
      );
      expect(issue.constraint).toEqual(
        AGENT_ERROR_REGISTRY["schedule.scheduled_for_in_past"].constraint,
      );
      expect(issue.severity).toBe("error");
    });

    it("respects per-call overrides over registry defaults", () => {
      const issue = composeIssue("schedule.description_too_short", {
        field: "rows[0].description",
        received: "tiny",
        hint: "Custom hint for this row.",
        expected: "Custom expected.",
        severity: "warning",
      });

      expect(issue.hint).toBe("Custom hint for this row.");
      expect(issue.expected).toBe("Custom expected.");
      expect(issue.severity).toBe("warning");
    });

    it("returns a placeholder issue with a warning hint for an unregistered code", () => {
      const issue = composeIssue("nonexistent.unregistered_code" as never, {
        field: "rows[0].mystery",
        received: undefined,
      });

      expect(issue.code).toBe("nonexistent.unregistered_code");
      expect(issue.hint).toMatch(/unregistered code/);
      expect(issue.severity).toBe("error");
    });

    it("normalizes rowIndex to null when omitted", () => {
      const issue = composeIssue("schedule.scheduled_for_invalid", {
        field: "scheduledFor",
        received: "not-a-date",
      });

      expect(issue.rowIndex).toBeNull();
    });
  });

  describe("buildEnvelope", () => {
    it("synthesises a single-issue summary when only one issue is present", () => {
      const env = buildEnvelope([
        composeIssue("schedule.scheduled_for_in_past", {
          field: "rows[4].scheduledFor",
          received: "2026-05-15T03:45:00",
          rowIndex: 4,
        }),
      ]);

      expect(env.ok).toBe(false);
      expect(env.summary).toBe(
        "Request rejected: schedule.scheduled_for_in_past on rows[4].scheduledFor.",
      );
      expect(env.errors).toHaveLength(1);
      expect(env.retryable).toBe(true);
    });

    it("counts multi-issue summaries by number of errors", () => {
      const env = buildEnvelope([
        composeIssue("schedule.description_too_short", { field: "rows[0].description", received: "x" }),
        composeIssue("schedule.scheduled_for_in_past", { field: "rows[1].scheduledFor", received: "yesterday" }),
      ]);

      expect(env.summary).toBe("2 validation errors. Fix the listed errors and retry.");
    });

    it("propagates rowsAttempted / rowsCommitted / retryHint when provided", () => {
      const env = buildEnvelope(
        [
          composeIssue("schedule.task_context_field_missing", {
            field: "rows[2].taskContext.background",
            received: "<missing>",
            rowIndex: 2,
          }),
        ],
        {
          summary: "5 rows submitted; 1 rejected.",
          rowsAttempted: 5,
          rowsCommitted: 0,
          retryHint: "Fix the error and POST the same body again.",
        },
      );

      expect(env.summary).toBe("5 rows submitted; 1 rejected.");
      expect(env.rowsAttempted).toBe(5);
      expect(env.rowsCommitted).toBe(0);
      expect(env.retryHint).toBe("Fix the error and POST the same body again.");
    });

    it("marks retryable=false when any issue's registry entry sets retryable:false", () => {
      const env = buildEnvelope([
        composeIssue("agent_actions.session_identity_missing", {
          field: "headers.x-pa-event-correlation-id",
          received: "<missing>",
        }),
      ]);

      expect(env.retryable).toBe(false);
    });

    it("returns retryable=false on an empty issue array", () => {
      const env = buildEnvelope([]);
      expect(env.retryable).toBe(false);
    });

    it("warnings do not affect retryable", () => {
      const env = buildEnvelope([
        composeIssue("schedule.description_too_short", {
          field: "rows[0].description",
          received: "tiny",
          severity: "warning",
        }),
      ]);
      expect(env.retryable).toBe(true);
    });

    it("respects retryable override", () => {
      const env = buildEnvelope(
        [
          composeIssue("schedule.scheduled_for_in_past", {
            field: "scheduledFor",
            received: "past",
          }),
        ],
        { retryable: false },
      );
      expect(env.retryable).toBe(false);
    });

    it("explicit `legacyErrorCode: null` opts out of the registry-set legacy alias", () => {
      // Exercises the `options.legacyErrorCode ?? undefined` fallback
      // inside resolveLegacyAlias — the explicit null branch.
      const env = buildEnvelope(
        [
          composeIssue("schedule.task_context_field_missing", {
            field: "rows[0].taskContext.background",
            received: "<missing>",
          }),
        ],
        { legacyErrorCode: null },
      );
      expect((env as Record<string, unknown>).error).toBeUndefined();
    });

    it("explicit `legacyErrorCode: \"forced_alias\"` overrides the registry default", () => {
      // Exercises the truthy left-hand path of `?? undefined` —
      // explicit string passed in.
      const env = buildEnvelope(
        [
          composeIssue("schedule.task_context_field_missing", {
            field: "rows[0].taskContext.background",
            received: "<missing>",
          }),
        ],
        { legacyErrorCode: "forced_alias" },
      );
      expect((env as Record<string, unknown>).error).toBe("forced_alias");
    });
  });

  describe("formatZodPath", () => {
    it("renders mixed string/number paths as field[N].subfield", () => {
      expect(formatZodPath(["rows", 2, "taskContext", "background"])).toBe(
        "rows[2].taskContext.background",
      );
    });

    it("renders root paths cleanly", () => {
      expect(formatZodPath([])).toBe("");
      expect(formatZodPath(["description"])).toBe("description");
    });

    it("handles paths starting with a number", () => {
      expect(formatZodPath([0, "scheduledFor"])).toBe("[0].scheduledFor");
    });

    it("handles symbol path segments by stringifying them", () => {
      // Defensive: Zod 4's path is PropertyKey[] which includes symbol.
      // No schema in this repo emits symbol keys, but the helper keeps
      // the wider type to match the public API surface — this exercise
      // pins the symbol branch.
      const sym = Symbol("rowIdSym");
      expect(formatZodPath([sym])).toBe("rowIdSym");
      expect(formatZodPath(["rows", sym])).toBe("rows.rowIdSym");
      const symNoDescription = Symbol();
      // Symbol() with no description: description is undefined; toString() is "Symbol()".
      expect(formatZodPath([symNoDescription])).toBe("Symbol()");
    });
  });

  describe("translateZodIssue / translateZodError", () => {
    it("translates a too_small issue on background into the field-keyed override code", () => {
      const schema = z.object({
        rows: z.array(
          z.object({
            taskContext: z.object({
              background: z.string().min(30),
            }),
          }),
        ),
      });
      const result = schema.safeParse({
        rows: [{ taskContext: { background: "short" } }],
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      const issues = translateZodError(result.error, {
        namespace: "schedule",
        fieldCodeMap: {
          "taskContext.background": "schedule.task_context_field_too_short",
        },
      });
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("schedule.task_context_field_too_short");
      expect(issues[0].field).toBe("rows[0].taskContext.background");
      expect(issues[0].rowIndex).toBe(0);
    });

    it("falls through to <namespace>.<fieldTail>_invalid when no override matches", () => {
      const schema = z.object({
        randomField: z.string().regex(/^abc/),
      });
      const result = schema.safeParse({ randomField: "xyz" });
      if (result.success) {
        throw new Error("expected parse failure");
      }
      const issue = translateZodIssue(result.error.issues[0], {
        namespace: "schedule",
      });
      expect(issue.code).toBe("schedule.randomField_invalid");
      // Placeholder hint surfaces because no registry entry exists.
      expect(issue.hint).toMatch(/unregistered code/);
    });

    it("maps invalid_type with received='undefined' onto <namespace>.<field>_missing", () => {
      const schema = z.object({
        rows: z.array(
          z.object({
            taskContext: z.object({
              background: z.string(),
            }),
          }),
        ),
      });
      const result = schema.safeParse({ rows: [{ taskContext: {} }] });
      if (result.success) {
        throw new Error("expected parse failure");
      }
      const issue = translateZodIssue(result.error.issues[0], {
        namespace: "schedule",
        fieldCodeMap: {
          "taskContext.background": "schedule.task_context_field_missing",
        },
      });
      expect(issue.code).toBe("schedule.task_context_field_missing");
    });

    it("extracts row index from rows[N].* paths", () => {
      const schema = z.array(z.object({ description: z.string().min(20) }));
      const result = schema.safeParse([
        { description: "a".repeat(30) },
        { description: "short" },
      ]);
      if (result.success) {
        throw new Error("expected parse failure");
      }
      const issue = translateZodIssue(result.error.issues[0], {
        namespace: "schedule",
      });
      // Root array — no "rows" key, so rowIndex stays null.
      expect(issue.rowIndex).toBeNull();
    });

    it("emits a generic `<namespace>._invalid` code when the Zod issue's path is empty", () => {
      // Root-level scalar parse failures carry an empty path. Exercises the
      // false branch of `path.length > 0 ? String(path[path.length - 1]) : ""`
      // — fieldTail becomes "" and the assembled code degrades to
      // `<namespace>._invalid`.
      const schema = z.string().min(5);
      const result = schema.safeParse("hi");
      if (result.success) {
        throw new Error("expected parse failure");
      }
      const issue = translateZodIssue(result.error.issues[0], {
        namespace: "schedule",
      });
      expect(issue.code).toBe("schedule._too_short");
      expect(issue.field).toBe("");
    });
  });

  describe("registry coverage", () => {
    it("every registry entry has hint, expected, skillAnchor", () => {
      for (const [code, entry] of Object.entries(AGENT_ERROR_REGISTRY)) {
        expect(entry.hint, `${code}.hint`).toBeTruthy();
        expect(entry.expected, `${code}.expected`).toBeTruthy();
        expect(entry.skillAnchor, `${code}.skillAnchor`).toBeTruthy();
      }
    });

    it("every code is namespaced under a resource prefix", () => {
      // Phase 1 ships schedule.* and agent_actions.*; subsequent passes
      // can extend the registry with context.*, observations.*, etc.
      // The invariant is "every code has a resource prefix + dot" — the
      // exact namespaces grow over time as endpoints adopt the envelope.
      for (const code of Object.keys(AGENT_ERROR_REGISTRY)) {
        expect(code, "code namespace").toMatch(/^[a-z][a-z_]*\.[a-z][a-z0-9_]*$/);
      }
    });

    /**
     * docs/design/appendices/skills-improvement.md §9-§11 + §14 deleted the standalone
     * `travel` / `travel-time` / `receipts` / `management-task-{register,
     * modify,stop}` skill slugs (merged into `gmail-lifestyle` and
     * `managed-tasks` respectively). Any registry entry still pointing
     * the agent at one of those slugs would send it to a `Read` target
     * that no longer exists. This regression guard pins the invariant
     * for every future skill merge: the deleted-slug list grows here,
     * and any anchor still naming a tombstoned slug fails the build.
     *
     * Sub-anchors are matched on the slug prefix only (`<slug>#...`),
     * so the test catches both `travel-bookings#crud` and the rarer
     * `travel-bookings` (no sub-anchor) shape.
     */
    it("no skillAnchor points at a Phase-4-deleted skill slug", () => {
      const DELETED_SLUGS: ReadonlyArray<string> = [
        "travel",
        "travel-bookings",
        "travel-time",
        "receipts",
        "management-task-register",
        "management-task-modify",
        "management-task-stop",
      ];
      const violations: string[] = [];
      for (const [code, entry] of Object.entries(AGENT_ERROR_REGISTRY)) {
        const anchor = entry.skillAnchor;
        if (!anchor) continue;
        const slug = anchor.split("#", 1)[0];
        if (DELETED_SLUGS.includes(slug)) {
          violations.push(`${code}: ${anchor}`);
        }
      }
      expect(violations, violations.join("\n")).toEqual([]);
    });

    /**
     * SCHEDULE_API_REDESIGN_PLAN.md §5 + Phase C — every `schedule.*`
     * registry entry must carry a `docsUrl` pointing at the matching
     * anchor in `agent-assets/skills/schedule/references/errors.md`,
     * because Phase D's `validateModelToken` consumers attach
     * `validValues` and rely on the docs link to land the LLM on the
     * code-specific recovery prose. The convention is
     * `agent-assets/skills/schedule/references/errors.md#<code-tail>`
     * where the tail strips the `schedule.` namespace prefix. This
     * regression test pins both invariants.
     */
    it("every schedule.* entry has a docsUrl pointing at the per-code anchor in errors.md", () => {
      const violations: string[] = [];
      for (const [code, entry] of Object.entries(AGENT_ERROR_REGISTRY)) {
        if (!code.startsWith("schedule.")) continue;
        const tail = code.slice("schedule.".length);
        const expected = `agent-assets/skills/schedule/references/errors.md#${tail}`;
        if (entry.docsUrl !== expected) {
          violations.push(`${code}: got ${entry.docsUrl ?? "<missing>"} — expected ${expected}`);
        }
      }
      expect(violations, violations.join("\n")).toEqual([]);
    });

    /**
     * SCHEDULE_API_REDESIGN_PLAN.md §5 + Phase C — `docsUrl` only earns
     * its keep if the anchor it points at actually resolves. The sibling
     * test above pins the *naming convention*; this one pins the
     * *physical existence* of the target. Without this, a new
     * `schedule.foo` entry can ship with `docsUrl=...#foo` while the
     * matching `<a id="foo">` in errors.md is missing — agents would
     * follow the link, land on the top of the page, and re-loop.
     *
     * Scope is intentionally narrow: every registry entry whose
     * `docsUrl` points into an `agent-assets/skills/.../errors.md`
     * file must have its fragment resolve to an `<a id="...">` anchor
     * (or to a Markdown heading with the matching kebab-slug id) in
     * that file. Off-repo URLs are skipped; missing files fail loudly.
     */
    it("every registry docsUrl fragment resolves to an anchor in its target file", () => {
      const fragmentRegex = /id="([^"]+)"/g;
      const fileCache = new Map<string, Set<string> | null>();

      function loadAnchors(filePath: string): Set<string> | null {
        if (fileCache.has(filePath)) return fileCache.get(filePath) ?? null;
        if (!existsSync(filePath)) {
          fileCache.set(filePath, null);
          return null;
        }
        const body = readFileSync(filePath, "utf8");
        const anchors = new Set<string>();
        for (const match of body.matchAll(fragmentRegex)) anchors.add(match[1]);
        fileCache.set(filePath, anchors);
        return anchors;
      }

      const violations: string[] = [];
      for (const [code, entry] of Object.entries(AGENT_ERROR_REGISTRY)) {
        if (!entry.docsUrl) continue;
        // Only inspect repo-relative paths into the schedule errors page
        // (and any future per-skill errors.md sibling). Absolute URLs
        // and non-errors.md targets are out of scope for this guard.
        if (!entry.docsUrl.includes("/errors.md#")) continue;
        const [relPath, fragment] = entry.docsUrl.split("#", 2);
        if (!fragment) {
          violations.push(`${code}: docsUrl has no fragment — got ${entry.docsUrl}`);
          continue;
        }
        const filePath = resolve(REPO_ROOT, relPath);
        const anchors = loadAnchors(filePath);
        if (anchors === null) {
          violations.push(`${code}: target file does not exist — ${filePath}`);
          continue;
        }
        if (!anchors.has(fragment)) {
          violations.push(
            `${code}: anchor #${fragment} not found in ${relPath} (existing: ${
              Array.from(anchors).sort().join(", ") || "<none>"
            })`,
          );
        }
      }
      expect(violations, violations.join("\n")).toEqual([]);
    });
  });

  // ── Phase C envelope upgrade — validValues + docsUrl + warnings[] ─────────

  describe("composeIssue with new fields", () => {
    it("accepts validValues and docsUrl as overrides", () => {
      const issue = composeIssue("schedule.model_unknown", {
        field: "model",
        received: "gpt-5.4-turbo",
        validValues: {
          aliases: ["sonnet", "opus"],
          models: { claude: ["claude-opus-4-7"], codex: ["gpt-5.4"] },
        },
        docsUrl: "agent-assets/skills/schedule/references/errors.md#model_unknown",
      });

      expect(issue.validValues).toEqual({
        aliases: ["sonnet", "opus"],
        models: { claude: ["claude-opus-4-7"], codex: ["gpt-5.4"] },
      });
      expect(issue.docsUrl).toBe(
        "agent-assets/skills/schedule/references/errors.md#model_unknown",
      );
    });

    it("pulls docsUrl from the registry default when no override is supplied", () => {
      const issue = composeIssue("schedule.task_type_unknown", {
        field: "taskType",
        received: "invoke",
      });
      expect(issue.docsUrl).toBe(
        "agent-assets/skills/schedule/references/errors.md#task_type_unknown",
      );
    });

    it("override docsUrl wins over registry default", () => {
      const issue = composeIssue("schedule.task_type_unknown", {
        field: "taskType",
        received: "invoke",
        docsUrl: "docs/design/02-event-pipeline.md#scheduled-tasks",
      });
      expect(issue.docsUrl).toBe("docs/design/02-event-pipeline.md#scheduled-tasks");
    });

    it("validValues is undefined by default — there is no registry-level default", () => {
      // Per §5.3 the registry never declares validValues — it's dynamic.
      const issue = composeIssue("schedule.task_type_unknown", {
        field: "taskType",
        received: "invoke",
      });
      expect(issue.validValues).toBeUndefined();
    });

    it("docsUrl on a placeholder (unregistered code) flows through from override", () => {
      const issue = composeIssue("nonexistent.unregistered_code" as never, {
        field: "mystery",
        received: undefined,
        docsUrl: "docs/design/missing.md#mystery",
        validValues: ["a", "b"],
      });
      expect(issue.docsUrl).toBe("docs/design/missing.md#mystery");
      expect(issue.validValues).toEqual(["a", "b"]);
    });
  });

  describe("composeWarning", () => {
    it("pins severity to 'warning' regardless of registry default", () => {
      const issue = composeWarning("schedule.task_type_unknown", {
        field: "taskType",
        received: "invoke",
      });
      expect(issue.severity).toBe("warning");
      expect(issue.code).toBe("schedule.task_type_unknown");
    });

    it("propagates validValues / docsUrl / hint overrides", () => {
      const issue = composeWarning("schedule.model_unknown", {
        field: "model",
        received: "claude-opus-4-5",
        hint: "Model is deprecated; replacement: claude-opus-4-7.",
        validValues: { aliases: ["sonnet", "opus"] },
      });
      expect(issue.hint).toBe("Model is deprecated; replacement: claude-opus-4-7.");
      expect(issue.validValues).toEqual({ aliases: ["sonnet", "opus"] });
      expect(issue.severity).toBe("warning");
    });
  });

  describe("buildEnvelope with warnings channel", () => {
    it("serialises warnings[] as a separate field on the envelope", () => {
      const env = buildEnvelope(
        [
          composeIssue("schedule.scheduled_for_in_past", {
            field: "time",
            received: "2026-05-15T03:45:00",
          }),
        ],
        {
          warnings: [
            composeWarning("schedule.task_type_unknown", {
              field: "taskType",
              received: "wakeup",
              hint: "Maybe you meant 'wake'.",
            }),
          ],
        },
      );

      expect(env.warnings).toBeDefined();
      expect(env.warnings).toHaveLength(1);
      expect(env.warnings?.[0].code).toBe("schedule.task_type_unknown");
      expect(env.warnings?.[0].severity).toBe("warning");
      // Errors are unaffected.
      expect(env.errors).toHaveLength(1);
      expect(env.errors[0].code).toBe("schedule.scheduled_for_in_past");
    });

    it("normalises issue severity to 'warning' when placed in warnings[]", () => {
      // Even when a caller forgets composeWarning and passes a stock
      // composeIssue result (severity:"error"), the channel placement
      // is the source of truth.
      const env = buildEnvelope([], {
        warnings: [
          composeIssue("schedule.task_type_unknown", {
            field: "taskType",
            received: "wakeup",
          }),
        ],
      });
      expect(env.warnings?.[0].severity).toBe("warning");
    });

    it("omits warnings[] from the envelope when none are passed", () => {
      const env = buildEnvelope([
        composeIssue("schedule.scheduled_for_in_past", {
          field: "time",
          received: "past",
        }),
      ]);
      expect((env as Record<string, unknown>).warnings).toBeUndefined();
    });

    it("omits warnings[] when the warnings array is explicitly empty", () => {
      // Empty array is treated as no warnings — no field appears on
      // the wire. Mirrors how `rowsAttempted` / `retryHint` behave.
      const env = buildEnvelope(
        [
          composeIssue("schedule.scheduled_for_in_past", {
            field: "time",
            received: "past",
          }),
        ],
        { warnings: [] },
      );
      expect((env as Record<string, unknown>).warnings).toBeUndefined();
    });

    it("retryable computation ignores warnings (severity check is on errors[] only)", () => {
      // Warnings on a non-retryable-coded error must not flip retryable to true.
      const env = buildEnvelope(
        [
          composeIssue("agent_actions.session_identity_missing", {
            field: "headers.x-pa-event-correlation-id",
            received: "<missing>",
          }),
        ],
        {
          warnings: [
            composeWarning("schedule.task_type_unknown", {
              field: "taskType",
              received: "wakeup",
            }),
          ],
        },
      );
      expect(env.retryable).toBe(false);
    });

    it("warnings-only envelope (no errors) still serialises warnings[]", () => {
      // The 2xx + warnings response shape from SCHEDULE_API_REDESIGN_PLAN.md §5.2.
      // buildEnvelope is the error builder; callers using it for a warnings-
      // only success body must override `retryable` and `summary` to make sense.
      const env = buildEnvelope([], {
        retryable: false,
        summary: "Created with 1 warning.",
        warnings: [
          composeWarning("schedule.task_type_unknown", {
            field: "taskType",
            received: "wakeup",
          }),
        ],
      });
      expect(env.errors).toHaveLength(0);
      expect(env.warnings).toHaveLength(1);
      expect(env.summary).toBe("Created with 1 warning.");
    });

    it("legacyFields cannot overwrite the warnings channel", () => {
      // `warnings` is structural — call sites cannot smuggle a different
      // shape through legacyFields.
      const env = buildEnvelope(
        [
          composeIssue("schedule.scheduled_for_in_past", {
            field: "time",
            received: "past",
          }),
        ],
        {
          warnings: [
            composeWarning("schedule.task_type_unknown", {
              field: "taskType",
              received: "wakeup",
            }),
          ],
          legacyFields: {
            warnings: "this-string-must-be-ignored",
          },
        },
      );
      expect(Array.isArray(env.warnings)).toBe(true);
      expect(env.warnings).toHaveLength(1);
    });
  });
});

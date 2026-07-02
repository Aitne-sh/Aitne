import { parseCustomRoutineSpec } from "../custom-routines.js";
import { validateContextFileFrontmatter } from "../context-frontmatter.js";
import {
  isAgentDefinitionPath,
  validateAgentDefinitionMarkdown,
} from "../agents/validate-agent-md.js";
import {
  normalizeLessonsFileContent,
  type LessonNormalizerOptions,
} from "../feedback/lesson-normalizer.js";
import { isSafeAgentSlug } from "../feedback/scope-parser.js";
import {
  normalizeRoadmapForWrite,
  validateRoadmap,
  validateRoadmapTransition,
  type RoadmapValidationError,
} from "../roadmap-validate.js";
import type { LongTermPlanSource } from "../roadmap-horizon.js";
import {
  explainCustomRoutineValidationError,
  validateBaseYamlSyntax,
  validateBuiltInRoutineRulebook,
} from "./routine-rulebook.js";
import { validateTodayContent } from "./today.js";

/**
 * Two-stage write-preparation pipeline for the `/api/context` PUT/PATCH
 * routes.
 *
 * `validateContextContent` is the schema check — it dispatches by
 * resolved target (today.md, roadmap.md, routine rulebooks, `.base`
 * files, frontmatter-bearing markdown) and returns a typed error with
 * the appropriate HTTP status (400 for content shape, 422 for
 * frontmatter shape). It is exposed independently so callers that
 * need to validate without normalizing (e.g. snapshot restore
 * preflight) can use it directly.
 *
 * `prepareContextContentForWrite` is the full pipeline used by the
 * write handlers — for `roadmap.md` it additionally normalizes
 * Long-term Plans (adding default `source:` annotations, etc.) and
 * runs a transition check against the previous content to enforce
 * roadmap state-machine invariants. For every other target it
 * delegates to `validateContextContent`.
 */

/**
 * A user-supplied context path after extension extraction:
 *
 *   - `base` is the path without the trailing `.md` / `.base`
 *   - `ext` records which extension was either supplied or chosen by
 *     default (`.md`) or required (`.base` for the small set of
 *     reserved YAML stems).
 *
 * Produced by the path-resolve layer (currently still in `context.ts`
 * until the PR 4 split); referenced here because every validator
 * dispatches on `target.base`.
 */
export interface ResolvedContextTarget {
  base: string;
  ext: ".md" | ".base";
}

export interface ContentWriteValidationOptions {
  timezone?: string;
  disableRoadmapValidation?: boolean;
  previousRoadmapContent?: string;
  today?: string;
  defaultLongTermPlanSource?: LongTermPlanSource;
  allowLegacyToday?: boolean;
  skipFrontmatterValidation?: boolean;
  /**
   * Expected agent-day date (`YYYY-MM-DD`) for today.md line 1. When set,
   * `validateTodayContent` returns a 400 with an error message that echoes
   * both the written and the expected date string, so the agent can correct
   * in the same session — see EXECUTION-MODE-DESIGN follow-up
   * §morning-routine.
   */
  expectedAgentDay?: string;
  /**
   * SELF_IMPROVEMENT_PHASE2 §2.1/§2.3 — when the write targets a lessons
   * store (`policies/agent-lessons`, `policies/agents/<slug>/lessons`), run
   * the deterministic normalizer over the outgoing content (stamp/repair
   * `cf=`, enact expiration verdicts) against `previousContent` so the file
   * is never persisted un-normalized. Ignored for every other target;
   * omitted ⇒ no normalization (validation-only callers, snapshot restore).
   */
  lessonNormalization?: LessonNormalizerOptions & {
    previousContent: string | null;
  };
}

export interface ContextContentValidationError {
  message: string;
  status: 400 | 422;
  path?: string;
}

/**
 * Schema-validate a context-file payload. Dispatches by resolved
 * target:
 *
 *   - `today` → `validateTodayContent` (400)
 *   - `roadmap` → `validateRoadmap` (400 with path hint)
 *   - `policies/routines/custom/*` → `parseCustomRoutineSpec` (400)
 *   - `routines/*` (excluding `_index`) → `validateBuiltInRoutineRulebook` (400)
 *   - everything else → frontmatter validation (422) + `.base` YAML check (400)
 *
 * Returns `null` if the payload is valid. The caller maps `null` to
 * the success branch and the typed error to the matching HTTP status.
 */
export function validateContextContent(
  target: ResolvedContextTarget,
  content: string,
  options?: Pick<
    ContentWriteValidationOptions,
    "allowLegacyToday" | "skipFrontmatterValidation" | "expectedAgentDay"
  >,
): ContextContentValidationError | null {
  if (target.base === "state/today") {
    const message = validateTodayContent(content, {
      allowLegacyToday: options?.allowLegacyToday ?? false,
      expectedAgentDay: options?.expectedAgentDay,
    });
    return message ? { message, status: 400 } : null;
  }
  if (target.base === "plans/roadmap") {
    const result = validateRoadmap(content);
    if (!result.ok && result.error) {
      return {
        message: formatRoadmapValidationError(result.error),
        status: 400,
        path: result.error.path,
      };
    }
    return null;
  }
  if (target.base.startsWith("policies/routines/custom/")) {
    const slug = target.base.slice("policies/routines/custom/".length);
    const result = parseCustomRoutineSpec(slug, content);
    if (!result.ok) {
      return {
        message: explainCustomRoutineValidationError(result.error),
        status: 400,
      };
    }
    return null;
  }
  if (target.base.startsWith("policies/routines/") && target.base !== "policies/routines/_index") {
    const message = validateBuiltInRoutineRulebook(target.base, content);
    return message ? { message, status: 400 } : null;
  }

  const relativePath = `${target.base}${target.ext}`;

  // policies/agents/<slug>/agent.md — user Agent definitions are written
  // through this same chokepoint (AGENT_DEFINITIONS_DESIGN.md §3.3). Their
  // frontmatter is the nested `agentDefinitionSchema`, not the context-vault
  // rule schema, so validate the agent-definition shape here (400 with the
  // offending fields) instead of falling through to the generic frontmatter
  // validator — which would wrongly demand `type`/`owner`/`updated`.
  if (isAgentDefinitionPath(relativePath)) {
    const message = validateAgentDefinitionMarkdown(relativePath, content);
    return message ? { message, status: 400 } : null;
  }

  if (!options?.skipFrontmatterValidation) {
    const frontmatterError = validateContextFileFrontmatter(content, relativePath);
    if (frontmatterError) {
      return { message: frontmatterError.message, status: 422 };
    }
  }

  if (target.ext !== ".base") return null;
  const message = validateBaseYamlSyntax(content);
  return message ? { message, status: 400 } : null;
}

/**
 * Full write-pipeline preflight. For roadmap writes, normalizes the
 * Long-term Plans section first (adding default `source:` annotations
 * keyed off the caller — manual via DM vs. dashboard form), validates
 * against the canonical schema, and runs an optional transition check
 * against the previous content. For every other target, delegates to
 * `validateContextContent`.
 *
 * Returns `{ ok: true, content }` where `content` may be the
 * roadmap-normalized form (different from the input) or the verbatim
 * input. On failure, returns `{ ok: false, status, message, path? }`
 * suitable for the API error response.
 */
export function prepareContextContentForWrite(
  target: ResolvedContextTarget,
  content: string,
  options?: ContentWriteValidationOptions,
):
  | { ok: true; content: string }
  | { ok: false; message: string; status: 400 | 422; path?: string } {
  if (target.base !== "plans/roadmap") {
    const contentError = validateContextContent(target, content, {
      allowLegacyToday: options?.allowLegacyToday,
      expectedAgentDay: options?.expectedAgentDay,
    });
    if (contentError) {
      return {
        ok: false,
        message: contentError.message,
        status: contentError.status,
        path: contentError.path,
      };
    }
    // Lessons stores get the deterministic Phase-2 normalizer inside the
    // same pipeline slot the roadmap normalizer occupies — every writer
    // (evening consolidation, monthly regeneralization, dashboard/manual
    // API edits) flows through here, so `cf=` and expiration verdicts can
    // never depend on the LLM honouring them.
    const lessonNorm = options?.lessonNormalization;
    if (lessonNorm && isLessonsStoreTarget(target)) {
      const normalized = normalizeLessonsFileContent(
        content,
        lessonNorm.previousContent,
        lessonNorm,
      );
      return { ok: true, content: normalized.content };
    }
    return { ok: true, content };
  }

  if (options?.disableRoadmapValidation) {
    return { ok: true, content };
  }

  const normalized = normalizeRoadmapForWrite(content, {
    timezone: options?.timezone,
    defaultLongTermPlanSource: options?.defaultLongTermPlanSource ?? "manual",
  });
  const result = validateRoadmap(normalized.content);
  if (!result.ok && result.error) {
    return {
      ok: false,
      message: formatRoadmapValidationError(result.error),
      status: 400,
      path: result.error.path,
    };
  }

  if (options?.previousRoadmapContent !== undefined) {
    const transition = validateRoadmapTransition(
      options.previousRoadmapContent,
      normalized.content,
      {
        today: options.today,
        timezone: options.timezone,
      },
    );
    if (!transition.ok && transition.error) {
      return {
        ok: false,
        message: formatRoadmapValidationError(transition.error),
        status: 400,
        path: transition.error.path,
      };
    }
  }

  return { ok: true, content: normalized.content };
}

/**
 * A write target that stores scoped lessons — the global
 * `policies/agent-lessons.md` or a per-agent
 * `policies/agents/<slug>/lessons.md` (slug validated with the same guard
 * the scope parser applies, so an unsafe path never reaches the normalizer).
 */
function isLessonsStoreTarget(target: ResolvedContextTarget): boolean {
  if (target.ext !== ".md") return false;
  if (target.base === "policies/agent-lessons") return true;
  const match = /^policies\/agents\/([^/]+)\/lessons$/.exec(target.base);
  return match !== null && isSafeAgentSlug(match[1]);
}

function formatRoadmapValidationError(error: RoadmapValidationError): string {
  // `validateRoadmap` always supplies a line number for row-shape failures
  // the route surfaces; the `error.line` falsy branch fires only for
  // section-missing structural errors. The HTTP route tests exercise this
  // indirectly; the dedicated unit-test fan-out is left to roadmap-validate.test.ts.
  /* c8 ignore next */
  const line = error.line ? `line ${error.line}: ` : "";
  return `${line}${error.message}`;
}

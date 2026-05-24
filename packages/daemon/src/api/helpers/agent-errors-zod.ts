import type { ZodError, ZodIssue } from "zod";

import { composeIssue } from "./agent-errors-envelope.js";
import type { AgentErrorIssue } from "./agent-errors-types.js";

// ── Zod issue translator ─────────────────────────────────────────────────────
//
// Maps Zod issues onto registry codes so endpoints that already use Zod
// schemas (POST /api/schedule, POST /api/schedule/batch) don't have to
// re-implement field-by-field validation prose. Endpoints that need
// custom-typed errors (auth-header missing, row-not-found) compose issues
// manually via `composeIssue`.
//
// The mapping is intentionally conservative — only Zod issue codes that
// correspond cleanly to a registry code get translated; anything else
// falls through to a generic `<namespace>.field_invalid` placeholder so
// the call site notices and adds a registry entry.

/**
 * Stringify a Zod issue path into a JSON-pointer-ish string.
 *
 * Zod 4 typed paths as `PropertyKey[]` (string | number | symbol). We
 * render strings/numbers verbatim and best-effort `String(seg)` symbols
 * — none of the schemas in this repo emit symbol keys, but accepting
 * the wider type keeps us compatible with the public API surface.
 *
 * Output: `rows[0].taskContext.background` (numbers become `[N]`).
 */
export function formatZodPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else if (typeof seg === "symbol") {
      const s = seg.description ?? seg.toString();
      out += out.length === 0 ? s : `.${s}`;
    } else if (out.length === 0) {
      out = seg;
    } else {
      out += `.${seg}`;
    }
  }
  return out;
}

/**
 * Heuristic — given a Zod issue at path `rows[i].field.subfield`, return
 * the leading row index when applicable. Otherwise null.
 */
function extractRowIndex(path: readonly PropertyKey[]): number | null {
  if (path.length >= 2 && path[0] === "rows" && typeof path[1] === "number") {
    return path[1];
  }
  return null;
}

export interface ZodTranslationContext {
  namespace: "schedule" | "agent_actions";
  /**
   * Field-path → code overrides. When the path tail matches one of the
   * keys (e.g. `taskContext.background`), the override wins regardless of
   * the issue's Zod code. Lets the call site distinguish between "missing"
   * and "too short" with one entry each.
   */
  fieldCodeMap?: Record<string, string>;
}

const MISSING_SENTINEL = "<missing>" as const;

function inferReceivedFromIssue(issue: ZodIssue): unknown {
  // Zod 4 dropped the `received` field on invalid_type issues — the
  // information leaks only through the issue's `message` ("…received
  // undefined" / "…received number"). For non-invalid_type codes the
  // received value is not exposed at all without the original input, so
  // the call site that needs verbatim received must compose manually.
  const msg = issue.message;
  if (typeof msg === "string") {
    const match = msg.match(/received (\w+)/);
    if (match) {
      return match[1] === "undefined" ? MISSING_SENTINEL : match[1];
    }
  }
  return MISSING_SENTINEL;
}

/**
 * Zod 4 dropped the `received` field on invalid_type issues, so detect
 * "missing field" by inspecting the issue's message. The match is
 * intentionally tight ("received undefined") so a string literal
 * `"undefined"` payload — which is a wrong-type bug, not a missing one
 * — is NOT classified as missing.
 */
function isMissingFieldIssue(issue: ZodIssue): boolean {
  return (
    issue.code === "invalid_type" &&
    typeof issue.message === "string" &&
    /received undefined\b/.test(issue.message)
  );
}

/**
 * Translate a single Zod issue into an AgentErrorIssue. The `namespace`
 * controls which code prefix is used for the fallback path.
 */
export function translateZodIssue(
  issue: ZodIssue,
  ctx: ZodTranslationContext,
): AgentErrorIssue {
  const path = issue.path;
  const field = formatZodPath(path);
  const fieldTail = path.length > 0 ? String(path[path.length - 1]) : "";
  const rowIndex = extractRowIndex(path);

  // Field-name-keyed override wins. Pick by the longest matching suffix so
  // `taskContext.background` beats `background`.
  let code: string | undefined;
  if (ctx.fieldCodeMap) {
    let bestLen = -1;
    for (const key of Object.keys(ctx.fieldCodeMap)) {
      if (field === key || field.endsWith(`.${key}`) || field.endsWith(`]${key}`)) {
        if (key.length > bestLen) {
          bestLen = key.length;
          code = ctx.fieldCodeMap[key];
        }
      }
    }
  }

  if (!code) {
    // Generic Zod-code → registry-code mapping. Zod 4 changed several
    // issue shapes vs. Zod 3 — `received` dropped from invalid_type;
    // `invalid_enum_value` renamed to `invalid_value`.
    if (isMissingFieldIssue(issue)) {
      code = `${ctx.namespace}.${fieldTail}_missing`;
    } else if (issue.code === "too_small") {
      code = `${ctx.namespace}.${fieldTail}_too_short`;
    } else if (issue.code === "too_big") {
      code = `${ctx.namespace}.${fieldTail}_too_long`;
    } else if (
      issue.code === "invalid_value" ||
      // @ts-expect-error — Zod 3 compatibility for migrations in flight.
      issue.code === "invalid_enum_value"
    ) {
      code = `${ctx.namespace}.${fieldTail}_unknown`;
    } else {
      code = `${ctx.namespace}.${fieldTail}_invalid`;
    }
  }

  return composeIssue(code, {
    field,
    received: inferReceivedFromIssue(issue),
    rowIndex,
  });
}

/**
 * Translate every issue from a Zod safeParse error. Stable order — issues
 * are emitted in the order Zod produced them, which matches input traversal.
 */
export function translateZodError(
  error: ZodError,
  ctx: ZodTranslationContext,
): AgentErrorIssue[] {
  return error.issues.map((issue) => translateZodIssue(issue, ctx));
}

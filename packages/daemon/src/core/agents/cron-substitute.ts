/**
 * Cron placeholder substitution + drift / validity checks
 * (AGENT_DEFINITIONS_DESIGN.md §4.2 / §5.5).
 *
 * Built-in Agents whose cron depends on a runtime config (the day boundary)
 * carry a placeholder in their YAML `schedule.expression` — e.g.
 * `"0 {dayBoundaryHour} * * *"` or `"50 {dayBoundaryHour-1} * * *"`. The loader
 * substitutes the live value before handing the expression to `node-cron`, and
 * cross-checks the result against the authoritative `BUILTIN_AGENT_REGISTRY`
 * resolver for drift.
 *
 * All three functions are pure, total, and never throw — a malformed input is
 * surfaced as a returned warning string, not an exception, so a bad YAML can
 * never crash boot. `node-cron` remains the authoritative schedule-time parser;
 * `validateCronExpression` here is a cheap pre-flight that catches the two
 * failure modes the substitution layer can introduce (unresolved placeholder,
 * wrong field count).
 */

/**
 * Matches `{dayBoundaryHour}` or `{dayBoundaryHour±N}` (e.g.
 * `{dayBoundaryHour-1}`). The optional `(sign)(digits)` group lets a single
 * regex cover the bare form and the offset forms the design uses.
 */
const DAY_BOUNDARY_PLACEHOLDER = /\{dayBoundaryHour(?:([+-])(\d+))?\}/g;

/** Wrap an hour offset into `[0, 23]` (a negative offset crosses midnight). */
function wrapHour(hour: number): number {
  return ((hour % 24) + 24) % 24;
}

/**
 * Substitute `{dayBoundaryHour[±N]}` placeholders in a cron expression with
 * the live day-boundary hour (wrapping across midnight). Expressions with no
 * placeholder pass through unchanged.
 *
 * Examples (dayBoundaryHour = 4):
 *   "0 {dayBoundaryHour} * * *"    → "0 4 * * *"
 *   "50 {dayBoundaryHour-1} * * *" → "50 3 * * *"   (4 − 1)
 *   "0 18 * * *"                   → "0 18 * * *"    (unchanged)
 * Wrap (dayBoundaryHour = 0):
 *   "45 {dayBoundaryHour-1} * * *" → "45 23 * * *"
 */
export function substituteCron(
  expr: string,
  config: { dayBoundaryHour: number },
): string {
  return expr.replace(DAY_BOUNDARY_PLACEHOLDER, (_match, sign?: string, digits?: string) => {
    let hour = config.dayBoundaryHour;
    if (sign && digits) {
      const delta = Number.parseInt(digits, 10);
      hour = sign === "+" ? hour + delta : hour - delta;
    }
    return String(wrapHour(hour));
  });
}

/** Collapse runs of whitespace and trim so cosmetic spacing isn't "drift". */
function normalizeCron(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

/**
 * Compare a (resolved) YAML cron expression against the authoritative registry
 * expression. Returns a non-fatal warning string on mismatch, or `null` when
 * they agree.
 *
 * `registryExpr` is `null` for the runtime-window builtins (`activity-scan`)
 * whose cadence is not a fixed expression — drift is meaningless there, so the
 * check is a no-op (returns `null`, §5.5.1). Whitespace differences are
 * normalised away before comparing.
 */
export function checkCronDrift(
  yamlExpr: string,
  registryExpr: string | null,
): string | null {
  if (registryExpr === null) return null;
  if (normalizeCron(yamlExpr) === normalizeCron(registryExpr)) return null;
  return `cron drift: YAML "${yamlExpr}" differs from registry "${registryExpr}"`;
}

/**
 * Pre-flight validity check for a fully-substituted cron expression. Surfaces
 * the failure modes the substitution layer can introduce, as a warning string
 * (or `null` when the expression looks well-formed):
 *
 *   - empty / whitespace-only
 *   - an unresolved `{...}` placeholder (substitution missed it)
 *   - a field count other than 5 (standard) or 6 (with seconds — node-cron
 *     accepts both)
 *
 * This is intentionally NOT a full cron grammar parser; `node-cron` validates
 * field syntax at schedule time. The point is to fail loud and early on the
 * shapes a placeholder typo produces, rather than passing a broken string to
 * the scheduler.
 */
export function validateCronExpression(expr: string): string | null {
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    return "empty cron expression";
  }
  if (trimmed.includes("{") || trimmed.includes("}")) {
    return `unresolved placeholder in cron expression: "${expr}"`;
  }
  const fieldCount = trimmed.split(/\s+/).length;
  if (fieldCount !== 5 && fieldCount !== 6) {
    return `cron expression must have 5 or 6 fields, got ${fieldCount}: "${expr}"`;
  }
  return null;
}

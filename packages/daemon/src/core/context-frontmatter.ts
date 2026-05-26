import { extractContextFrontmatter } from "./context-frontmatter-extract.js";
import {
  CONTEXT_FRONTMATTER_TYPES,
  CONTEXT_RELATIVE_PATHS,
} from "./context-paths.js";

const VALID_TYPES = new Set<string>(CONTEXT_FRONTMATTER_TYPES);
const VALID_OWNERS = new Set(["agent", "shared", "user"]);

export type ContextFrontmatterValidationCode =
  | "missing_frontmatter"
  | "missing_field"
  | "invalid_type"
  | "invalid_owner"
  | "invalid_updated"
  | "missing_h1"
  | "invalid_kind"
  | "invalid_slug"
  | "invalid_status"
  | "invalid_created_at";

export interface ContextFrontmatterValidationError {
  code: ContextFrontmatterValidationCode;
  message: string;
}

export interface ExpectedContextFrontmatter {
  type: string;
  owners: readonly string[];
}

/**
 * Path-prefix predicate consumed by the write chokepoint to decide
 * whether the strict frontmatter validator should fire. After the
 * vault restructure (CONTEXT_VAULT_REDESIGN_PLAN.md §3) the prefixes
 * are the new class-prefixed paths. Legacy prefixes are normalised by
 * the API alias resolver upstream, so the matcher only ever sees
 * canonical paths.
 */
export function shouldValidateContextFileFrontmatter(
  relativePath: string,
): boolean {
  if (!relativePath.endsWith(".md")) return false;
  return (
    relativePath.startsWith("identity/") ||
    relativePath.startsWith("policies/") ||
    relativePath.startsWith("plans/projects/") ||
    relativePath.startsWith("knowledge/repos/legacy-registry/") ||
    relativePath.startsWith("journal/daily/") ||
    relativePath.startsWith("journal/weekly/") ||
    relativePath.startsWith("journal/monthly/") ||
    relativePath.startsWith("knowledge/dossiers/") ||
    relativePath === CONTEXT_RELATIVE_PATHS.contextIndex ||
    relativePath === CONTEXT_RELATIVE_PATHS.rootIndex
  );
}

export function validateContextFileFrontmatter(
  content: string,
  relativePath: string,
): ContextFrontmatterValidationError | null {
  if (!shouldValidateContextFileFrontmatter(relativePath)) return null;

  const frontmatter = extractContextFrontmatter(content);
  if (!frontmatter) {
    return {
      code: "missing_frontmatter",
      message: `${relativePath} requires YAML frontmatter with type, owner, and updated fields.`,
    };
  }

  const type = frontmatter.values.type;
  if (!type) {
    return missingField(relativePath, "type");
  }
  if (!VALID_TYPES.has(type)) {
    return {
      code: "invalid_type",
      message: `${relativePath} frontmatter type must be one of: ${CONTEXT_FRONTMATTER_TYPES.join(", ")}.`,
    };
  }

  const owner = frontmatter.values.owner;
  if (!owner) {
    return missingField(relativePath, "owner");
  }
  if (!VALID_OWNERS.has(owner)) {
    return {
      code: "invalid_owner",
      message: `${relativePath} frontmatter owner must be agent, shared, or user.`,
    };
  }

  const expected = expectedFrontmatterForPath(relativePath);
  if (expected && type !== expected.type) {
    return {
      code: "invalid_type",
      message: `${relativePath} frontmatter type must be \`${expected.type}\` for this path.`,
    };
  }
  if (expected && !expected.owners.includes(owner)) {
    return {
      code: "invalid_owner",
      message: `${relativePath} frontmatter owner must be ${formatExpectedOwners(expected.owners)} for this path.`,
    };
  }

  const updated = frontmatter.values.updated;
  if (!updated) {
    return missingField(relativePath, "updated");
  }
  if (!isIsoDateString(updated)) {
    return {
      code: "invalid_updated",
      message: `${relativePath} frontmatter updated must be an ISO date string.`,
    };
  }

  if (!/^#\s+\S.*$/m.test(frontmatter.body)) {
    return {
      code: "missing_h1",
      message: `${relativePath} requires at least one H1 heading.`,
    };
  }

  const policyError = validatePolicyFileFrontmatter(
    relativePath,
    frontmatter.values,
  );
  if (policyError) return policyError;

  return null;
}

const POLICY_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const POLICY_STATUSES = new Set(["active", "paused", "removed"]);
const POLICY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POLICY_INDEX_PATH = "policies/management-captures/_index.md";
// MANAGEMENT-POLICY-CAPTURE-PLAN §4.1.1 — `extractFrontmatter` is a flat
// line-scalar parser; it does NOT expand YAML block scalars. A policy
// file written as `origin: |\n  …` produces `values.origin === "|"` —
// truthy, so a naive non-empty check would pass while losing the actual
// captured DM. Reject the bare block-scalar markers explicitly so the
// policy skill is forced to use a single-line string. If multi-line
// `origin` becomes necessary, expand the extractor first.
const POLICY_BLOCK_SCALAR_MARKER_RE = /^[|>][-+]?$/;

function validatePolicyFileFrontmatter(
  relativePath: string,
  values: Record<string, string>,
): ContextFrontmatterValidationError | null {
  if (!relativePath.startsWith("policies/management-captures/")) return null;
  if (relativePath === POLICY_INDEX_PATH) return null;
  /* c8 ignore start — caller filters to .md before reaching here; defensive
     guard for future callers that pass non-.md files. */
  if (!relativePath.endsWith(".md")) return null;
  /* c8 ignore stop */

  const kind = values.kind;
  if (kind !== "policy") {
    return {
      code: "invalid_kind",
      message: `${relativePath} frontmatter requires \`kind: policy\` (rules/policies files are discriminated from other rules by kind).`,
    };
  }

  const slug = values.slug;
  if (!slug) {
    return {
      code: "missing_field",
      message: `${relativePath} frontmatter requires \`slug\`.`,
    };
  }
  if (slug.length > 64 || !POLICY_SLUG_RE.test(slug)) {
    return {
      code: "invalid_slug",
      message: `${relativePath} frontmatter slug must be kebab-case (a-z, 0-9, hyphen), 1-64 chars, no leading/trailing hyphen.`,
    };
  }
  const filenameStem = relativePath.slice(
    "policies/management-captures/".length,
    -".md".length,
  );
  if (slug !== filenameStem) {
    return {
      code: "invalid_slug",
      message: `${relativePath} frontmatter slug \`${slug}\` must equal the filename stem \`${filenameStem}\`.`,
    };
  }

  const status = values.status;
  if (!status) {
    return {
      code: "missing_field",
      message: `${relativePath} frontmatter requires \`status\`.`,
    };
  }
  if (!POLICY_STATUSES.has(status)) {
    return {
      code: "invalid_status",
      message: `${relativePath} frontmatter status must be one of: active, paused, removed.`,
    };
  }

  const createdAt = values.created_at;
  if (!createdAt) {
    return {
      code: "missing_field",
      message: `${relativePath} frontmatter requires \`created_at\`.`,
    };
  }
  if (!POLICY_DATE_RE.test(createdAt) || !isIsoDateString(createdAt)) {
    return {
      code: "invalid_created_at",
      message: `${relativePath} frontmatter created_at must be a YYYY-MM-DD date.`,
    };
  }

  const origin = values.origin;
  if (!origin) {
    return {
      code: "missing_field",
      message: `${relativePath} frontmatter requires \`origin\` (capture the original DM or trigger that motivated this policy).`,
    };
  }
  if (POLICY_BLOCK_SCALAR_MARKER_RE.test(origin)) {
    return {
      code: "missing_field",
      message: `${relativePath} frontmatter \`origin\` must be a single-line string (block scalars like \`|\` or \`>\` are not supported by the frontmatter extractor and would silently lose content).`,
    };
  }

  return null;
}

// morning-routine-optimization.md §"PUT /api/context/daily/<date>
// skeleton-preservation validator" — the daily/<date>.md file's
// frontmatter is owned by the daemon-prepared journal skeleton, NOT
// by Stage B. Stage B reads the skeleton via `<journal_skeleton>` in
// its prompt, copies the skeleton-owned frontmatter byte-for-byte,
// authors the body per `policies/journal-format.md`, and PUTs the full
// file. The daemon's PUT chokepoint validates the seven skeleton-
// owned fields are present and well-typed; drift surfaces as 422
// with per-field structured errors so Stage B can self-correct in
// one retry.
//
// `type` (`= "daily"`) and `owner` (`= "agent"`) are already pinned
// by `expectedFrontmatterForPath` + `validateContextFileFrontmatter`,
// so this helper covers the remaining FIVE: date, weekday,
// agent_generated, calendar_events, messages_handled.
//
// The daemon does NOT byte-for-byte verify field VALUES against the
// skeleton — the skeleton lives in memory inside the orchestrator
// run and is not persisted. The contract is presence + well-typedness
// (e.g. `calendar_events` is a non-negative integer), which catches
// the realistic Stage-B failure mode (silently dropping a field) and
// declines to couple the validator to inter-process skeleton state.
export interface DailySkeletonFrontmatterDriftError {
  field: string;
  received: string | null;
  expected: string;
}

const DAILY_WEEKDAY_VALUES = new Set([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);
const DAILY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NON_NEGATIVE_INT_RE = /^\d+$/;

export function validateDailySkeletonFrontmatter(
  content: string,
  relativePath: string,
): DailySkeletonFrontmatterDriftError[] {
  if (!relativePath.startsWith("journal/daily/")) return [];
  if (!relativePath.endsWith(".md")) return [];

  const frontmatter = extractContextFrontmatter(content);
  // Missing frontmatter is already a 422 from validateContextFileFrontmatter
  // (`missing_frontmatter`); don't double-fire here. Return an empty list so
  // the generic validator owns the "no frontmatter at all" message.
  if (!frontmatter) return [];

  const errors: DailySkeletonFrontmatterDriftError[] = [];
  const values = frontmatter.values;

  // date — must equal the path's date stem (journal/daily/YYYY-MM-DD.md).
  // The daemon's PUT route also pins line 1 of the body via H1 date,
  // so this is the frontmatter-side of the same contract.
  const stem = relativePath.slice(
    "journal/daily/".length,
    relativePath.length - ".md".length,
  );
  const dateValue = values.date;
  if (!dateValue) {
    errors.push({
      field: "frontmatter.date",
      received: null,
      expected: `ISO date matching the file path stem (\`${stem}\`)`,
    });
  } else if (!DAILY_DATE_RE.test(dateValue) || dateValue !== stem) {
    errors.push({
      field: "frontmatter.date",
      received: dateValue,
      expected: `ISO date matching the file path stem (\`${stem}\`)`,
    });
  }

  // weekday — long-form English (Stage B reads this from skeleton).
  const weekday = values.weekday;
  if (!weekday) {
    errors.push({
      field: "frontmatter.weekday",
      received: null,
      expected: "one of Monday / Tuesday / Wednesday / Thursday / Friday / Saturday / Sunday",
    });
  } else if (!DAILY_WEEKDAY_VALUES.has(weekday)) {
    errors.push({
      field: "frontmatter.weekday",
      received: weekday,
      expected: "one of Monday / Tuesday / Wednesday / Thursday / Friday / Saturday / Sunday",
    });
  }

  // agent_generated — must be literally `true` (the skeleton emits
  // this so downstream consumers can distinguish daemon-authored
  // journals from any future user-handcrafted variant).
  const agentGenerated = values.agent_generated;
  if (!agentGenerated) {
    errors.push({
      field: "frontmatter.agent_generated",
      received: null,
      expected: "literal `true`",
    });
  } else if (agentGenerated !== "true") {
    errors.push({
      field: "frontmatter.agent_generated",
      received: agentGenerated,
      expected: "literal `true`",
    });
  }

  // calendar_events — non-negative integer (count from skeleton).
  const calendarEvents = values.calendar_events;
  if (!calendarEvents) {
    errors.push({
      field: "frontmatter.calendar_events",
      received: null,
      expected: "non-negative integer",
    });
  } else if (!NON_NEGATIVE_INT_RE.test(calendarEvents)) {
    errors.push({
      field: "frontmatter.calendar_events",
      received: calendarEvents,
      expected: "non-negative integer",
    });
  }

  // messages_handled — non-negative integer (count from skeleton).
  // Semantic pinned in morning-routine-optimization.md §"messages_handled
  // semantic": counts incoming user messages only.
  const messagesHandled = values.messages_handled;
  if (!messagesHandled) {
    errors.push({
      field: "frontmatter.messages_handled",
      received: null,
      expected: "non-negative integer",
    });
  } else if (!NON_NEGATIVE_INT_RE.test(messagesHandled)) {
    errors.push({
      field: "frontmatter.messages_handled",
      received: messagesHandled,
      expected: "non-negative integer",
    });
  }

  return errors;
}

export function expectedFrontmatterForPath(
  relativePath: string,
): ExpectedContextFrontmatter | null {
  if (relativePath === "identity/_index.md") {
    return { type: "index", owners: ["shared"] };
  }
  if (relativePath.startsWith("identity/")) {
    return { type: "user", owners: ["shared"] };
  }

  if (relativePath === "policies/_index.md") {
    return { type: "index", owners: ["shared"] };
  }
  // MANAGEMENT-POLICY-CAPTURE-PLAN §4.1.1 / §4.3 — policy capture files
  // use the existing `rule` type plus a `kind: policy` discriminator,
  // and the captures sub-index is agent-owned (the `management-policy`
  // skill is its sole writer). These rules MUST precede the generic
  // `policies/` catch-all below; first match wins.
  if (relativePath === "policies/management-captures/_index.md") {
    return { type: "index", owners: ["agent"] };
  }
  if (relativePath.startsWith("policies/management-captures/")) {
    return { type: "rule", owners: ["agent"] };
  }
  // Routine and skill sub-indices retain index frontmatter even though
  // they live under the policies/ prefix.
  if (relativePath === "policies/routines/_index.md") {
    return { type: "index", owners: ["shared"] };
  }
  if (relativePath === "policies/skills/_index.md") {
    return { type: "index", owners: ["shared"] };
  }
  if (relativePath.startsWith("policies/")) {
    return { type: "rule", owners: ["agent", "shared", "user"] };
  }

  if (relativePath === "plans/projects/_index.md") {
    return { type: "index", owners: ["shared"] };
  }
  if (relativePath.startsWith("plans/projects/")) {
    return { type: "project", owners: ["shared"] };
  }
  if (relativePath.startsWith("knowledge/repos/legacy-registry/")) {
    return { type: "git-repo", owners: ["shared"] };
  }

  if (relativePath.startsWith("journal/daily/")) {
    return { type: "daily", owners: ["agent"] };
  }
  if (relativePath.startsWith("journal/weekly/")) {
    return { type: "weekly", owners: ["agent"] };
  }
  if (relativePath.startsWith("journal/monthly/")) {
    return { type: "monthly", owners: ["agent"] };
  }

  // Agent-owned dossiers + system-prose context index. Validated on
  // write via the same chokepoint so the Vault Health dashboard never
  // flags a file that the API just permitted.
  if (relativePath === CONTEXT_RELATIVE_PATHS.dossiers.index) {
    return { type: "index", owners: ["agent"] };
  }
  if (relativePath.startsWith("knowledge/dossiers/")) {
    return { type: "dossier", owners: ["agent"] };
  }
  // contextIndex and rootIndex collapse to the same `_index.md` after
  // CONTEXT_VAULT_REDESIGN. The file is mixed-authorship (V15) — user
  // prose around a `<!-- reconciler-section -->` block — so `shared` is
  // the canonical owner; `agent` is grandfathered from the pre-V15 era.
  if (relativePath === CONTEXT_RELATIVE_PATHS.rootIndex) {
    return { type: "index", owners: ["shared", "agent"] };
  }

  return null;
}

function formatExpectedOwners(owners: readonly string[]): string {
  return owners.map((owner) => `\`${owner}\``).join(", ");
}

function missingField(
  relativePath: string,
  field: "type" | "owner" | "updated",
): ContextFrontmatterValidationError {
  return {
    code: "missing_field",
    message: `${relativePath} frontmatter requires \`${field}\`.`,
  };
}

function isIsoDateString(value: string): boolean {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

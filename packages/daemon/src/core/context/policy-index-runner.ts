import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { localDateStr } from "@aitne/shared";
import { CONTEXT_RELATIVE_PATHS } from "../context-paths.js";
import { validateContextFileFrontmatter } from "../context-frontmatter.js";
import type { PromptContextChangedCallback } from "../context-staleness.js";
import {
  writeRuntimeState,
  getDegradedMode,
} from "../../db/runtime-state.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { createLogger } from "../../logging.js";
import type {
  ReconcilerRunRecord,
  ReconcilerTrigger,
} from "./reconciler-runner.js";
import {
  bucketPolicies,
  renderActivePoliciesSection,
  renderPolicyIndex,
  upsertManagementRulesActivePolicies,
  type PolicySnapshotEntry,
  type PolicyStatus,
} from "./policy-index-reconciler.js";

const logger = createLogger("policy-index-reconciler");

/** Runtime-state key for the policy-index reconciler's last run record. */
export const POLICY_INDEX_RECONCILER_LAST_RUN_KEY =
  "reconciler.policy_index.last_run";

/**
 * MANAGEMENT-POLICY-CAPTURE-PLAN §9 P4 — drive one pass of the
 * policy-index reconciler:
 *
 *   1. Walk `policies/management-captures/<slug>.md` (excluding `_index.md`), parse each
 *      file's frontmatter + body, attach the linked routine's cron.
 *   2. Render the desired `_index.md` body and `## Active Policies`
 *      section content for `management.md`.
 *   3. Compare against on-disk content; short-circuit on no-op.
 *   4. Snapshot prior contents to `md_file_snapshots`
 *      (trigger `policy_index_reconciled`), write both files, mark them
 *      on the agent-write tracker, and notify the prompt-context sink.
 *   5. Persist a single `runtime_state` row regardless of outcome.
 *
 * Runs under its own per-process mutex so concurrent calls serialise.
 */

export interface RunPolicyIndexReconcilerOptions {
  db: Database.Database;
  contextDir: string;
  writeTracker?: AgentWriteTracker;
  onPromptContextChanged?: PromptContextChangedCallback;
  timezone?: string;
  trigger: ReconcilerTrigger;
  /** Injectable clock for deterministic test output. */
  now?: () => Date;
}

let runnerMutex: Promise<void> = Promise.resolve();

export async function runPolicyIndexReconciler(
  opts: RunPolicyIndexReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const prev = runnerMutex;
  let releaseMutex!: () => void;
  runnerMutex = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });
  try {
    await prev;
    return await runOnce(opts);
  } finally {
    releaseMutex();
  }
}

async function runOnce(
  opts: RunPolicyIndexReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const now = opts.now ? opts.now() : new Date();
  const today = localDateStr(now, opts.timezone || undefined);
  const recordBase = {
    at: now.toISOString(),
    trigger: opts.trigger,
    added: 0,
    removed: 0,
    refreshedMtime: 0,
  };

  const degraded = getDegradedMode(opts.db);
  if (degraded) {
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "noop",
      error: `degraded_mode:${degraded.reason}`,
    };
    persistRunRecord(opts.db, record);
    return record;
  }

  try {
    const snapshots = collectPolicySnapshots(opts.contextDir);
    const buckets = bucketPolicies(snapshots);
    const indexBody = renderPolicyIndex(buckets, today);
    const sectionBody = renderActivePoliciesSection(buckets);

    const indexPath = join(
      opts.contextDir,
      CONTEXT_RELATIVE_PATHS.rules.policiesIndex,
    );
    const managementPath = join(
      opts.contextDir,
      CONTEXT_RELATIVE_PATHS.rules.management,
    );

    const previousIndex = readIfExists(indexPath);
    const previousManagement = readIfExists(managementPath);

    const desiredManagement =
      previousManagement !== null
        ? upsertManagementRulesActivePolicies(previousManagement, sectionBody)
        : null;

    // Skip fabricating the index from scratch when there are no policy
    // files AND no existing index — the skeleton seeder owns first
    // creation, the reconciler only maintains. Once either side is
    // present (a policy file is added, or the seeder has run), the
    // standard diff path takes over.
    const indexChanged =
      previousIndex !== indexBody &&
      !(snapshots.length === 0 && previousIndex === null);
    const managementChanged =
      desiredManagement !== null && desiredManagement !== previousManagement;

    if (!indexChanged && !managementChanged) {
      const record: ReconcilerRunRecord = {
        ...recordBase,
        result: "noop",
        error: null,
      };
      persistRunRecord(opts.db, record);
      return record;
    }

    // Self-validate the rendered index before writing — render bugs would
    // otherwise leave a 422-shaped file on disk that the API chokepoint
    // would later reject. Mirrors `runReconciler`'s self-validation.
    const indexValidation = validateContextFileFrontmatter(
      indexBody,
      CONTEXT_RELATIVE_PATHS.rules.policiesIndex,
    );
    if (indexValidation) {
      const record: ReconcilerRunRecord = {
        ...recordBase,
        result: "error",
        error: `self_validation_failed:${indexValidation.code}`,
      };
      persistRunRecord(opts.db, record);
      logger.error(
        { validation: indexValidation, trigger: opts.trigger },
        "Policy-index render failed self-validation — leaving files untouched",
      );
      return record;
    }

    if (indexChanged) {
      writeWithSnapshot(opts, indexPath, indexBody, previousIndex);
      opts.onPromptContextChanged?.(
        CONTEXT_RELATIVE_PATHS.rules.policiesIndex,
        "policy_index_reconciler",
        "quiet",
        { tierReason: "derived_policy_index" },
      );
    }
    if (managementChanged && desiredManagement !== null) {
      writeWithSnapshot(
        opts,
        managementPath,
        desiredManagement,
        previousManagement,
      );
      opts.onPromptContextChanged?.(
        CONTEXT_RELATIVE_PATHS.rules.management,
        "policy_index_reconciler",
        "quiet",
        { tierReason: "derived_policy_index" },
      );
    }

    // We reuse the shared `ReconcilerRunRecord` shape from the context-
    // index reconciler so existing dashboards / tests can read this
    // runner's runtime_state row with the same parser. The numeric slots
    // are repurposed for policy-status counts and that mapping is sticky:
    //   added           → active policy count
    //   removed         → removed policy count
    //   refreshedMtime  → paused policy count
    // If a third reconciler ever lands, split the interface rather than
    // overloading the slots a second time.
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "applied",
      error: null,
      added: snapshots.filter((p) => p.status === "active").length,
      removed: snapshots.filter((p) => p.status === "removed").length,
      refreshedMtime: snapshots.filter((p) => p.status === "paused").length,
    };
    persistRunRecord(opts.db, record);
    logger.info(
      {
        trigger: opts.trigger,
        active: record.added,
        paused: record.refreshedMtime,
        removed: record.removed,
        wroteIndex: indexChanged,
        wroteManagement: managementChanged,
      },
      "Policy-index reconciler applied",
    );
    return record;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "error",
      error: message.slice(0, 200),
    };
    persistRunRecord(opts.db, record);
    logger.error({ err, trigger: opts.trigger }, "Policy-index reconciler run failed");
    return record;
  }
}

/**
 * Walk `policies/management-captures/`, parse each policy file, attach linked-routine
 * cadence. Files that fail validation (missing kind, malformed slug, etc.)
 * are skipped with a warn — the API chokepoint is the authoritative
 * validator and would have rejected them at write time, so a malformed
 * file on disk implies an out-of-band edit. Reporting yet another error
 * here would just create snapshot churn.
 */
export function collectPolicySnapshots(
  contextDir: string,
): PolicySnapshotEntry[] {
  const policiesDir = join(
    contextDir,
    CONTEXT_RELATIVE_PATHS.rules.policiesDir,
  );
  if (!existsSync(policiesDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(policiesDir);
  } catch (err) {
    logger.warn({ err, policiesDir }, "Could not read policies directory");
    return [];
  }
  const out: PolicySnapshotEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if (name === "_index.md") continue;
    const absolute = join(policiesDir, name);
    let content: string;
    try {
      content = readFileSync(absolute, "utf-8");
    } catch (err) {
      logger.warn({ err, file: absolute }, "Skipping unreadable policy file");
      continue;
    }
    const parsed = parsePolicyFile(content);
    if (!parsed) {
      logger.warn(
        { file: absolute },
        "Skipping policy file: frontmatter could not be parsed",
      );
      continue;
    }
    const filenameStem = name.slice(0, -".md".length);
    if (parsed.slug !== filenameStem) {
      logger.warn(
        { file: absolute, slug: parsed.slug, filenameStem },
        "Skipping policy file: slug does not match filename",
      );
      continue;
    }
    const cadence = parsed.linkedRoutine
      ? readRoutineCron(contextDir, parsed.linkedRoutine)
      : null;
    out.push({
      slug: parsed.slug,
      status: parsed.status,
      cadence,
      linkedRoutine: parsed.linkedRoutine,
      linkedDossier: parsed.linkedDossier,
      why: parsed.why,
      createdAt: parsed.createdAt,
      removedAt: parsed.status === "removed" ? parsed.updated : null,
    });
  }
  return out;
}

interface ParsedPolicyFile {
  slug: string;
  status: PolicyStatus;
  linkedRoutine: string | null;
  linkedDossier: string | null;
  why: string;
  createdAt: string;
  updated: string;
}

const POLICY_STATUSES = new Set<PolicyStatus>(["active", "paused", "removed"]);

/**
 * Parse a policy `.md` file's frontmatter (including the nested `linked:`
 * mapping) and pull the first paragraph of the body's `## Why` section.
 * Returns null when the file is unrecognisable as a policy.
 *
 * The frontmatter parser here is a deliberate small superset of the global
 * `extractFrontmatter` in `context-frontmatter.ts`: it understands
 * one-level nested mappings under a parent key (e.g. `linked:` followed by
 * indented `routine:`/`dossier:` lines). The skill emits this nested form
 * for human/LLM readability — the global validator stays flat-only.
 */
export function parsePolicyFile(content: string): ParsedPolicyFile | null {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if ((lines[0] ?? "").trim() !== "---") return null;
  const closeIndex = lines.findIndex(
    (line, idx) => idx > 0 && line.trim() === "---",
  );
  if (closeIndex < 0) return null;

  const flat: Record<string, string> = {};
  const linked: Record<string, string> = {};
  let currentNest: Record<string, string> | null = null;
  let nestKey: string | null = null;

  for (const rawLine of lines.slice(1, closeIndex)) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) {
      continue;
    }
    // Indented child of a nested mapping.
    if (/^\s+\S/.test(rawLine) && currentNest) {
      const childMatch = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(rawLine);
      if (childMatch) {
        currentNest[childMatch[1]] = stripQuotes(childMatch[2]);
      }
      continue;
    }
    // Top-level key.
    const topMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(rawLine);
    if (!topMatch) {
      currentNest = null;
      nestKey = null;
      continue;
    }
    const [, key, valueRaw] = topMatch;
    const value = stripQuotes(valueRaw);
    if (value === "" && key === "linked") {
      currentNest = linked;
      nestKey = key;
      continue;
    }
    flat[key] = value;
    currentNest = null;
    nestKey = null;
  }
  // Suppress unused-var warning for nestKey; it documents intent.
  void nestKey;

  if (flat.kind !== "policy") return null;

  const slug = flat.slug;
  if (!slug) return null;

  const statusRaw = flat.status as PolicyStatus | undefined;
  if (!statusRaw || !POLICY_STATUSES.has(statusRaw)) return null;

  const createdAt = flat.created_at;
  if (!createdAt) return null;
  const updated = flat.updated || createdAt;

  const body = lines.slice(closeIndex + 1).join("\n");
  const why = extractWhy(body) || flat.origin || "—";

  return {
    slug,
    status: statusRaw,
    linkedRoutine: linked.routine || null,
    linkedDossier: linked.dossier || null,
    why,
    createdAt,
    updated,
  };
}

/**
 * Pull the first non-empty paragraph from the `## Why` section. Falls back
 * to null when the section is absent or empty — caller substitutes
 * `origin` or em-dash.
 *
 * Implementation note: JavaScript regex has no `\Z` anchor (it would
 * silently match the literal letter Z), so we resolve "next H2 or EOF"
 * with explicit string scanning instead — same pattern the section-
 * upsert helper uses in `policy-index-reconciler.ts`.
 */
function extractWhy(body: string): string | null {
  const startMatch = /^##\s+Why\s*$/m.exec(body);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterHeader = startMatch.index + startMatch[0].length;
  const nextHeadingPattern = /^##\s/gm;
  nextHeadingPattern.lastIndex = afterHeader;
  const nextMatch = nextHeadingPattern.exec(body);
  const end = nextMatch ? nextMatch.index : body.length;
  return collapseFirstParagraph(body.slice(afterHeader, end));
}

function collapseFirstParagraph(chunk: string): string | null {
  const lines = chunk.split("\n");
  const paragraph: string[] = [];
  let started = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!started) {
      if (line === "") continue;
      started = true;
      paragraph.push(line);
      continue;
    }
    if (line === "") break;
    if (line.startsWith("#")) break;
    paragraph.push(line);
  }
  if (paragraph.length === 0) return null;
  return paragraph.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Read the cadence of a policy's linked execution vehicle. Post
 * Agents-hub redesign (AGENTS_HUB_REDESIGN_PLAN.md §3) `linked.routine`
 * names a recurring **Agent** — the cron comes from
 * `policies/agents/<slug>/agent.md`'s `schedule.expression`. Legacy
 * `policies/routines/custom/<slug>.md` files (inert, pre-migration) are
 * still consulted as a fallback so old policy rows keep their cadence
 * cell. Returns null when neither file resolves. Intentionally
 * tolerant — the policy file is the source of truth, the link is a
 * convenience pointer.
 */
function readRoutineCron(
  contextDir: string,
  routineSlug: string,
): string | null {
  const agentPath = join(contextDir, "policies", "agents", routineSlug, "agent.md");
  const fromAgent = readFrontmatterField(agentPath, /^\s*expression\s*:\s*(.*?)\s*$/);
  if (fromAgent !== null) return fromAgent;
  const legacyPath = join(
    contextDir,
    CONTEXT_RELATIVE_PATHS.routines.customDir,
    `${routineSlug}.md`,
  );
  return readFrontmatterField(legacyPath, /^cron\s*:\s*(.*?)\s*$/);
}

/**
 * Line-scalar frontmatter scan: first line inside the `---` fences
 * matching `pattern` (capture group 1, quotes stripped), or null. For
 * agent.md the `expression:` line lives nested under `schedule:`; a
 * line-anchored match is sufficient because the definition schema emits
 * exactly one `expression` key.
 */
function readFrontmatterField(path: string, pattern: RegExp): string | null {
  if (!existsSync(path)) return null;
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if ((lines[0] ?? "").trim() !== "---") return null;
  const closeIndex = lines.findIndex(
    (line, idx) => idx > 0 && line.trim() === "---",
  );
  if (closeIndex < 0) return null;
  for (const rawLine of lines.slice(1, closeIndex)) {
    const match = pattern.exec(rawLine);
    if (match) {
      return stripQuotes(match[1]) || null;
    }
  }
  return null;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readIfExists(absolutePath: string): string | null {
  if (!existsSync(absolutePath)) return null;
  try {
    return readFileSync(absolutePath, "utf-8");
  } catch (err) {
    logger.warn({ err, file: absolutePath }, "Reconciler could not read file");
    return null;
  }
}

function writeWithSnapshot(
  opts: RunPolicyIndexReconcilerOptions,
  absolutePath: string,
  content: string,
  previousContent: string | null,
): void {
  const directory = dirname(absolutePath);
  mkdirSync(directory, { recursive: true });
  if (previousContent !== null) {
    try {
      const relativePath = relativizeToContext(opts.contextDir, absolutePath);
      opts.db
        .prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
        )
        .run(relativePath, previousContent, "policy_index_reconciled", null);
    } catch (err) {
      logger.warn(
        { err, file: absolutePath },
        "Failed to snapshot prior content before policy-index write",
      );
    }
  }
  // Mark before the visible-write boundary so FS-watch consumers attribute
  // the resulting event to the agent. Roll back on failure (C2).
  opts.writeTracker?.markWriting(absolutePath, content);
  try {
    writeFileSync(absolutePath, content, "utf-8");
  } catch (writeErr) {
    opts.writeTracker?.unmark(absolutePath);
    throw writeErr;
  }
}

function relativizeToContext(contextDir: string, absolutePath: string): string {
  if (absolutePath.startsWith(contextDir)) {
    return absolutePath.slice(contextDir.length).replace(/^[\\/]+/, "");
  }
  return absolutePath;
}

function persistRunRecord(
  db: Database.Database,
  record: ReconcilerRunRecord,
): void {
  try {
    writeRuntimeState(db, POLICY_INDEX_RECONCILER_LAST_RUN_KEY, record);
  } catch (err) {
    logger.warn(
      { err, record },
      "Policy-index reconciler run record persistence failed",
    );
  }
}

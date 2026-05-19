import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import * as chokidar from "chokidar";
import {
  isValidOutputPath,
  sotBindingsSchema,
  type ManagedTask,
  type SotBinding,
  type SotBindings,
} from "@aitne/shared";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { writeFileAtomically } from "./atomic-write.js";
import {
  InMemoryManagementMdWriteLockManager,
  withManagementMdWriteLock,
  type ManagementMdWriteLockManager,
} from "./management-md-write-lock.js";
import {
  listManagedTasks,
} from "../db/managed-tasks-store.js";
import {
  readSotBindings,
  writeSotBindings,
} from "../db/sot-bindings-store.js";
import {
  clearManagementParseFailures,
  recordManagementParseFailure,
  type ManagementParseFailureSection,
} from "../db/management-parse-failures-store.js";
import { recordManagementMdRenderDuration } from "./management-telemetry.js";
import { createLogger } from "../logging.js";

const logger = createLogger("management-registry");

/**
 * `rules/management.md` registry — render / parse / boot / watch
 * (docs/design/21-management-registry-and-entities.md §7.2, §11, P2).
 *
 * Architectural mirror of `core/management-md.ts` (which owns the
 * top-level `integrations.md`): SQLite is authoritative; the file is a
 * deterministic render. The registry guarantees:
 *
 *   - Boot — read DB → render → write file (NFR-2: ≤ 200 ms for 100 rows).
 *     A file whose `schema_version` does not match the current schema is
 *     overwritten with a fresh render (clean-reinstall policy — no
 *     forward/back migration).
 *   - Render — preserves §C "Active Policies" stub verbatim and any
 *     free prose between the four canonical sections (FR-18, §0.1).
 *   - Parse — round-trips §A and §B tables; rows that fail their
 *     domain/type-plural/`mt_id` invariants are dropped with a
 *     `management_parse_failures` entry (§9.1 parse rules, NFR-7).
 *   - Watch — chokidar-driven; self-writes are stamped + skipped to
 *     avoid the file→DB→file loop (NFR-4). Fatal parse errors revert
 *     the file from DB. Section A hand-edits are applied to
 *     `settings.sot_bindings`. Section B hand-edits to managed tasks
 *     are NOT applied in P2 — registering / mutating managed tasks
 *     ships with the API surface in P3 — but a structurally-clean §B
 *     parse that disagrees with the DB triggers a re-render so the
 *     file converges back to the DB state (and a parse_failures row
 *     surfaces a hint on the dashboard).
 *
 * Concurrency: every write goes through {@link withManagementMdWriteLock}
 * so a competing API write or a chokidar reconciliation cannot
 * interleave between (render → atomic write → snapshot). The
 * boot reconciler also acquires the lock.
 */

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Frontmatter `schema_version` written by this module. Bumped only on
 * incompatible structural changes (§0.1, §16.3). The package's
 * `template_version` is owned by the asset-packaging step and lives in
 * the template file, not here.
 */
export const MANAGEMENT_MD_SCHEMA_VERSION = 3;

const RELATIVE_PATH = CONTEXT_RELATIVE_PATHS.rules.management;

const SECTION_A_HEADER = "## A. Source-of-Truth bindings";
const SECTION_B_HEADER = "## B. Managed tasks (active only)";
const SECTION_C_HEADER = "## C. Active Policies";

const SECTION_A_TABLE_HEADER = "| Category | SoT app | Mirror MD path | Policy | Writer |";
const SECTION_A_TABLE_DIVIDER = "|---|---|---|---|---|";

const SECTION_B_TABLE_HEADER =
  "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |";
const SECTION_B_TABLE_DIVIDER = "|---|---|---|---|---|---|---|---|";

const DEFAULT_C_STUB = [
  SECTION_C_HEADER,
  "",
  "Auto-maintained by the daemon (do not edit). Source files live under",
  "`rules/policies/<slug>.md`; capture new policies via the",
  "`management-policy` skill. Full index: [[rules/policies/_index.md]]",
  "",
  "_No active policies yet._",
  "",
].join("\n");

const DEFAULT_NOTES_BLOCK = [
  "## Notes",
  "",
  "- The agent cannot use `Edit` / `Write` tools on this file — writes go",
  "  through `/api/context/rules/management` (locked + snapshotted) or the",
  "  managed-tasks / sot-bindings API surfaces.",
  "- This file is injected into every flow via `policy-files.ts`. Keep it",
  "  concise so prompt assembly stays cheap.",
  "- Free prose between sections (Language, Conflict handling, etc.) is",
  "  preserved across re-renders. Tables and frontmatter stay English.",
  "",
].join("\n");

/**
 * `## H1` headers the parser recognizes as canonical section markers.
 * Anything between two consecutive markers is "free prose" preserved
 * verbatim across re-renders (§9.1 render rules; §0.1).
 */
const SECTION_HEADERS = [
  SECTION_A_HEADER,
  SECTION_B_HEADER,
  SECTION_C_HEADER,
] as const;

// ── Path resolution ────────────────────────────────────────────────────────

export function getManagementMdPath(contextDir: string): string {
  return resolve(contextDir, RELATIVE_PATH);
}

// ── Self-write suppression ─────────────────────────────────────────────────
//
// Same pattern as `core/management-md.ts`: every daemon-initiated write
// stamps the absolute path; the chokidar handler consumes the stamp and
// short-circuits. The 5 s window matches `management-md.ts` and
// chokidar's default `awaitWriteFinish` budget.

const pendingSelfWrites = new Set<string>();

function markSelfWrite(absPath: string): void {
  pendingSelfWrites.add(absPath);
  setTimeout(() => pendingSelfWrites.delete(absPath), 5_000).unref();
}

function consumeSelfWrite(absPath: string): boolean {
  return pendingSelfWrites.delete(absPath);
}

// ── Render ─────────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Optional override of the §C stub — injected verbatim when the
   * caller wants to round-trip a hand-edited Active Policies section
   * (§A.10 ADR — preserve §C verbatim). When omitted, the default
   * stub is rendered. */
  preservedSectionC?: string;
  /**
   * Free prose blocks indexed by their leading H2 (e.g. `## Language`).
   * Preserved across re-renders so users can keep notes in the file
   * without losing them on the next DB-driven render.
   */
  preservedFreeProse?: ReadonlyMap<string, string>;
  /**
   * Frontmatter timestamp written into `updated:`. Defaults to today
   * (UTC YYYY-MM-DD); test fixtures override for byte-deterministic
   * golden comparisons.
   */
  updatedDate?: string;
}

export interface RenderInput {
  sotBindings: SotBindings;
  managedTasks: readonly ManagedTask[];
}

function renderFrontmatter(updatedDate: string): string {
  return [
    "---",
    "type: rule",
    "slug: management",
    "owner: shared",
    `updated: ${updatedDate}`,
    "template_version: 2",
    `schema_version: ${MANAGEMENT_MD_SCHEMA_VERSION}`,
    "---",
  ].join("\n");
}

function escapeCell(value: string): string {
  // §13.3 — defense-in-depth: pipe and newline characters never appear
  // in a rendered cell (the parser would split them mid-row). Validators
  // already strip these from inputs; the renderer's escape is the
  // belt-and-suspenders layer.
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim();
}

function emDashOr(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return v.length === 0 ? "—" : v;
}

function renderSotBindingRow(b: SotBinding): string {
  return [
    "|",
    escapeCell(b.category),
    "|",
    escapeCell(b.sotApp),
    "|",
    escapeCell(emDashOr(b.mirrorPath)),
    "|",
    escapeCell(emDashOr(b.policy)),
    "|",
    escapeCell(b.writer),
    "|",
  ].join(" ");
}

function renderSectionA(bindings: SotBindings): string {
  const lines: string[] = [SECTION_A_HEADER, ""];
  if (bindings.length === 0) {
    lines.push(SECTION_A_TABLE_HEADER);
    lines.push(SECTION_A_TABLE_DIVIDER);
    lines.push("");
    lines.push(
      "_No SoT bindings yet — populate via the setup wizard or `PUT /api/sot-bindings`._",
    );
    lines.push("");
    return lines.join("\n");
  }
  lines.push(SECTION_A_TABLE_HEADER);
  lines.push(SECTION_A_TABLE_DIVIDER);
  for (const b of bindings) lines.push(renderSotBindingRow(b));
  lines.push("");
  return lines.join("\n");
}

function renderManagedTaskRow(row: ManagedTask): string {
  return [
    "|",
    escapeCell(row.id),
    "|",
    escapeCell(row.intent),
    "|",
    escapeCell(row.app),
    "|",
    escapeCell(row.cadence),
    "|",
    escapeCell(emDashOr(row.output_path)),
    "|",
    escapeCell(`rs:${row.schedule_id}`),
    "|",
    escapeCell(emDashOr(row.last_run_at)),
    "|",
    escapeCell(emDashOr(row.last_result)),
    "|",
  ].join(" ");
}

function renderSectionB(rows: readonly ManagedTask[]): string {
  const lines: string[] = [SECTION_B_HEADER, ""];
  if (rows.length === 0) {
    lines.push(SECTION_B_TABLE_HEADER);
    lines.push(SECTION_B_TABLE_DIVIDER);
    lines.push("");
    lines.push(
      '_No managed tasks yet — register via DM (e.g. "Check Zoom every day at 10am")',
    );
    lines.push("or the dashboard's Settings → Management page._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(SECTION_B_TABLE_HEADER);
  lines.push(SECTION_B_TABLE_DIVIDER);
  for (const row of rows) lines.push(renderManagedTaskRow(row));
  lines.push("");
  return lines.join("\n");
}

function renderSectionC(preserved?: string): string {
  if (preserved && preserved.trim().length > 0) {
    // The reconciler hands back the §C block verbatim — including its
    // header — so the renderer doesn't strip a user's annotation.
    return preserved.replace(/\s*$/, "\n");
  }
  return DEFAULT_C_STUB;
}

function renderFreeProse(preserved?: ReadonlyMap<string, string>): string {
  if (!preserved || preserved.size === 0) return DEFAULT_NOTES_BLOCK;
  const blocks: string[] = [];
  for (const [, body] of preserved) {
    blocks.push(body.replace(/\s*$/, "\n"));
  }
  // Always trail with the canonical Notes block so the standard text
  // does not disappear when the user keeps their own free prose.
  if (!preserved.has("## Notes")) blocks.push(DEFAULT_NOTES_BLOCK);
  return blocks.join("\n");
}

/**
 * Render the file body from DB-resident state. Idempotent: same input
 * → byte-identical output across calls and across releases of the same
 * `schema_version` (NFR-2 / NFR-1c).
 */
export function renderManagementMd(
  input: RenderInput,
  options: RenderOptions = {},
): string {
  const updatedDate = options.updatedDate ?? new Date().toISOString().slice(0, 10);
  return [
    renderFrontmatter(updatedDate),
    "# Management Rules",
    "",
    "This file is the agent's structured registry of (a) Source-of-Truth",
    "bindings and (b) active managed tasks. It is rendered from the",
    "daemon's DB and re-parsed when hand-edited; see",
    "`docs/design/21-management-registry-and-entities.md` for the spec.",
    "",
    renderSectionA(input.sotBindings),
    renderSectionB(input.managedTasks),
    renderSectionC(options.preservedSectionC),
    renderFreeProse(options.preservedFreeProse),
  ].join("\n");
}

// ── Parse ──────────────────────────────────────────────────────────────────

export interface ParsedManagedTaskRow {
  id: string;
  intent: string;
  app: string;
  cadence: string;
  outputPath: string | null;
  scheduleId: number | null;
  lastRunAt: string | null;
  lastResult: string | null;
}

export interface ParseFailure {
  section: ManagementParseFailureSection;
  reason: string;
  raw?: string | null;
}

export interface ParseResult {
  /**
   * `true` only when the frontmatter parses *and* every recognized
   * canonical section is structurally valid. Section-internal warnings
   * (dropped rows, unknown columns) are accumulated in `failures`
   * without flipping `ok` to false — they are recoverable through the
   * daemon's re-render path.
   */
  ok: boolean;
  /** Frontmatter `schema_version` (null when absent or non-numeric). */
  schemaVersion: number | null;
  /** Section A rows (Zod-validated). */
  sotBindings: SotBindings;
  /** Section B rows that survived the §9.1 invariants. */
  managedTasks: ParsedManagedTaskRow[];
  /** Section C verbatim block (header + body), preserved across renders. */
  preservedSectionC: string | null;
  /** Map of `## H2` → verbatim body for free prose between sections. */
  preservedFreeProse: ReadonlyMap<string, string>;
  /** Per-row drop reasons; surfaced via `management_parse_failures`. */
  failures: ParseFailure[];
  /** File-level fatal errors (header missing, frontmatter malformed). */
  errors: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]+?)\r?\n---\r?\n?/;

function parseFrontmatter(body: string): {
  schemaVersion: number | null;
  rest: string;
  /** True when the frontmatter block exists at all. */
  hasFrontmatter: boolean;
} {
  const match = FRONTMATTER_RE.exec(body);
  if (!match) {
    return { schemaVersion: null, rest: body, hasFrontmatter: false };
  }
  const fmBody = match[1];
  const rest = body.slice(match[0].length);
  const versionLine = fmBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("schema_version:"));
  if (!versionLine) {
    return { schemaVersion: null, rest, hasFrontmatter: true };
  }
  const value = versionLine.slice("schema_version:".length).trim();
  const n = Number.parseInt(value, 10);
  return {
    schemaVersion: Number.isFinite(n) ? n : null,
    rest,
    hasFrontmatter: true,
  };
}

interface SectionSlice {
  header: string;
  body: string;
}

function sliceSections(body: string): {
  canonical: Map<string, SectionSlice>;
  freeProse: Map<string, string>;
} {
  const lines = body.split(/\r?\n/);
  const canonical = new Map<string, SectionSlice>();
  const freeProse = new Map<string, string>();

  let currentHeader: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentHeader === null) return;
    const sliceBody = buffer.join("\n");
    if ((SECTION_HEADERS as readonly string[]).includes(currentHeader)) {
      canonical.set(currentHeader, { header: currentHeader, body: sliceBody });
    } else {
      freeProse.set(currentHeader, `${currentHeader}\n${sliceBody}`);
    }
  };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush();
      currentHeader = line.trim();
      buffer = [];
      continue;
    }
    if (currentHeader !== null) buffer.push(line);
  }
  flush();
  return { canonical, freeProse };
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function isDividerRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

function emDashToNull(value: string): string | null {
  const v = value.trim();
  if (v === "" || v === "—") return null;
  return v;
}

function parseSectionA(
  slice: SectionSlice | undefined,
  failures: ParseFailure[],
): SotBindings {
  if (!slice) return [];
  const rawRows = slice.body
    .split(/\r?\n/)
    .map(splitTableRow)
    .filter((r): r is string[] => r !== null);
  if (rawRows.length === 0) return [];
  // Header + divider + data
  if (rawRows.length < 2 || !isDividerRow(rawRows[1])) {
    failures.push({
      section: "A",
      reason: "section A table missing header/divider",
    });
    return [];
  }
  const dataRows = rawRows.slice(2);
  const bindings: SotBinding[] = [];
  for (const row of dataRows) {
    if (row.length < 5) {
      failures.push({
        section: "A",
        reason: `section A row has ${row.length} cells, expected 5`,
        raw: `| ${row.join(" | ")} |`,
      });
      continue;
    }
    if (row.length > 5) {
      // §9.1 parse rules — "Unknown columns are dropped with a warning in
      // parse_failures table." Keep the row (best-effort recovery), but
      // surface the divergence so the dashboard banner prompts the user
      // to clean up the extra cells.
      failures.push({
        section: "A",
        reason: `section A row has ${row.length} cells; expected 5 (extra columns dropped)`,
        raw: `| ${row.join(" | ")} |`,
      });
    }
    const candidate = {
      category: row[0],
      sotApp: row[1],
      mirrorPath: emDashToNull(row[2]),
      policy: emDashToNull(row[3]),
      writer: row[4],
    };
    const parsed = sotBindingsSchema.safeParse([candidate]);
    if (!parsed.success) {
      failures.push({
        section: "A",
        reason: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
        raw: `| ${row.join(" | ")} |`,
      });
      continue;
    }
    bindings.push(parsed.data[0]);
  }
  return bindings;
}

const RS_REF_RE = /^rs:(\d+)$/;
const MT_ID_RE = /^mt_[1-9]\d*$/;

function parseSectionB(
  slice: SectionSlice | undefined,
  failures: ParseFailure[],
): ParsedManagedTaskRow[] {
  if (!slice) return [];
  const rawRows = slice.body
    .split(/\r?\n/)
    .map(splitTableRow)
    .filter((r): r is string[] => r !== null);
  if (rawRows.length === 0) return [];
  if (rawRows.length < 2 || !isDividerRow(rawRows[1])) {
    failures.push({
      section: "B",
      reason: "section B table missing header/divider",
    });
    return [];
  }
  const dataRows = rawRows.slice(2);
  const out: ParsedManagedTaskRow[] = [];
  for (const row of dataRows) {
    if (row.length < 8) {
      failures.push({
        section: "B",
        reason: `section B row has ${row.length} cells, expected 8`,
        raw: `| ${row.join(" | ")} |`,
      });
      continue;
    }
    if (row.length > 8) {
      // §9.1 parse rules — "Unknown columns are dropped with a warning in
      // parse_failures table." Keep the row (best-effort recovery), but
      // surface the divergence so the dashboard banner prompts the user
      // to clean up the extra cells. The id may not be valid yet at this
      // point in parsing, so the warning is row-shape-only.
      failures.push({
        section: "B",
        reason: `section B row has ${row.length} cells; expected 8 (extra columns dropped)`,
        raw: `| ${row.join(" | ")} |`,
      });
    }
    const id = row[0].trim();
    const intent = row[1].trim();
    const app = row[2].trim();
    const cadence = row[3].trim();
    const outputCell = emDashToNull(row[4]);
    const scheduleCell = row[5].trim();
    const lastRunAt = emDashToNull(row[6]);
    const lastResult = emDashToNull(row[7]);

    if (!MT_ID_RE.test(id)) {
      failures.push({
        section: "B",
        reason: `section B: invalid id "${id}" (must match /^mt_[1-9]\\d*$/)`,
        raw: `| ${row.join(" | ")} |`,
      });
      continue;
    }
    if (app === "") {
      failures.push({
        section: "B",
        reason: `section B (${id}): empty App column`,
        raw: `| ${row.join(" | ")} |`,
      });
      continue;
    }
    let scheduleId: number | null = null;
    if (scheduleCell !== "" && scheduleCell !== "—") {
      const m = RS_REF_RE.exec(scheduleCell);
      if (!m) {
        failures.push({
          section: "B",
          reason: `section B (${id}): Schedule cell "${scheduleCell}" does not match /^rs:\\d+$/`,
          raw: `| ${row.join(" | ")} |`,
        });
        continue;
      }
      scheduleId = Number.parseInt(m[1], 10);
    }
    if (outputCell !== null && !isValidOutputPath(outputCell)) {
      failures.push({
        section: "B",
        reason: `section B (${id}): invalid output_path "${outputCell}"`,
        raw: `| ${row.join(" | ")} |`,
      });
      continue;
    }
    out.push({
      id,
      intent,
      app,
      cadence,
      outputPath: outputCell,
      scheduleId,
      lastRunAt,
      lastResult,
    });
  }
  return out;
}

/**
 * Parse a management.md body. Frontmatter without `schema_version`
 * yields `schemaVersion === null`; the boot reconciler treats any
 * value other than `MANAGEMENT_MD_SCHEMA_VERSION` as a mismatch and
 * re-renders.
 *
 * Section-level errors (missing canonical header, malformed table)
 * accumulate into `failures` but do not flip `ok` unless they make the
 * file structurally unparseable. The strict-fail bar is reserved for
 * frontmatter that does not parse at all.
 */
export function parseManagementMd(body: string): ParseResult {
  const failures: ParseFailure[] = [];
  const errors: string[] = [];
  const fm = parseFrontmatter(body);
  if (!fm.hasFrontmatter) {
    errors.push("frontmatter missing");
  }
  const { canonical, freeProse } = sliceSections(fm.rest);
  const sotBindings = parseSectionA(canonical.get(SECTION_A_HEADER), failures);
  const managedTasks = parseSectionB(canonical.get(SECTION_B_HEADER), failures);
  const sectionC = canonical.get(SECTION_C_HEADER);
  // §A.10 — preserve §C *verbatim* including its header so the renderer
  // round-trips a hand-edited Active Policies block without diff.
  const preservedSectionC = sectionC
    ? `${sectionC.header}\n${sectionC.body}`.replace(/\s*$/, "\n")
    : null;
  return {
    ok: errors.length === 0,
    schemaVersion: fm.schemaVersion,
    sotBindings,
    managedTasks,
    preservedSectionC,
    preservedFreeProse: freeProse,
    failures,
    errors,
  };
}

// ── File I/O ───────────────────────────────────────────────────────────────

/**
 * Render the current DB state and write it to disk atomically. Stamps
 * the path as a self-write so the watcher skips the resulting event,
 * and snapshots the rendered bytes into `md_file_snapshots` so the
 * dashboard's snapshot-restore surface (P6) has history to show.
 *
 * Caller MUST hold the management-md write lock — `withManagementMdWriteLock`
 * is the canonical wrapper. The `lockId` is required to prevent the
 * accidental fire-and-forget calls that bypass the lock; callers that
 * already use {@link withManagementMdWriteLock} get the id back from
 * the manager.
 */
export interface WriteOptions {
  /**
   * The lockId held by the caller. Asserted via `isHeldBy` so a
   * fire-and-forget call without acquiring the lock fails loudly.
   */
  lockId: string;
  lockManager: ManagementMdWriteLockManager;
  /** Trigger string written into `md_file_snapshots.trigger`. */
  trigger: string;
  /**
   * Optional render overrides (preserved §C, free prose, updatedDate)
   * — used by the watcher when echoing back a hand-edit so the
   * canonical form picks up user-authored prose without losing it.
   */
  render?: RenderOptions;
}

export async function renderAndWriteManagementMd(
  contextDir: string,
  db: Database.Database,
  input: RenderInput,
  options: WriteOptions,
): Promise<{ path: string; body: string; snapshotId: number | null }> {
  if (!options.lockManager.isHeldBy(options.lockId)) {
    throw new Error(
      "renderAndWriteManagementMd: lockId is not the current holder of the management.md write lock",
    );
  }
  // §14.3 `aitne_management_md_render_seconds` — capture wall-clock for
  // the full render+write+snapshot path so the histogram reflects what
  // a caller actually pays. Recorded in `finally` so the metric is
  // emitted even when the snapshot insert below throws.
  const renderStartedAt = Date.now();
  try {
    const path = getManagementMdPath(contextDir);
    await mkdir(dirname(path), { recursive: true });
    const body = renderManagementMd(input, options.render);
    markSelfWrite(path);
    writeFileAtomically(path, body);

    let snapshotId: number | null = null;
    try {
      const result = db
        .prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
        )
        .run(RELATIVE_PATH, body, options.trigger);
      snapshotId = Number(result.lastInsertRowid);
    } catch (err) {
      // Snapshot is best-effort: a single insert failure should not
      // strand the file write itself. Surface the error so observability
      // catches recurring DB pressure.
      logger.warn(
        { err, path: RELATIVE_PATH, trigger: options.trigger },
        "management.md snapshot insert failed (file write succeeded)",
      );
    }
    return { path, body, snapshotId };
  } finally {
    recordManagementMdRenderDuration(Date.now() - renderStartedAt);
  }
}

export async function readAndParseManagementMd(
  contextDir: string,
): Promise<ParseResult | null> {
  const path = getManagementMdPath(contextDir);
  try {
    const body = await readFile(path, "utf-8");
    return parseManagementMd(body);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Boot reconciler ────────────────────────────────────────────────────────

export interface BootResult {
  path: string;
  /** True when the previous file was missing OR overwritten. */
  rewritten: boolean;
  /** The render input that produced the on-disk file. */
  rendered: RenderInput;
}

/**
 * Schema-version handling: only `schema_version === MANAGEMENT_MD_SCHEMA_VERSION`
 * is reconciled in place. Any other value (absent, older, newer) triggers a
 * fresh render — the project's clean-reinstall policy means there is no
 * forward/back migration path to honor.
 */
export async function bootstrapManagementRegistry(
  contextDir: string,
  db: Database.Database,
  lockManager: ManagementMdWriteLockManager = new InMemoryManagementMdWriteLockManager(),
): Promise<BootResult> {
  const path = getManagementMdPath(contextDir);

  const lockResult = await withManagementMdWriteLock(lockManager, async () => {
    const dbState: RenderInput = {
      sotBindings: readSotBindings(db),
      managedTasks: listManagedTasks(db),
    };

    let fileExists = true;
    try {
      await stat(path);
    } catch (err) {
      // Non-ENOENT stat errors (EACCES, EIO) are platform-rare; the
      // rethrow exists so a permissions issue surfaces loudly instead
      // of being silently treated as missing.
      /* c8 ignore next */
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      fileExists = false;
    }

    if (!fileExists) {
      const lockId = lockManager.getHolder();
      // Defensive guard: held lock invariant means lockId is always
      // present here. The branch exists only to surface a corrupted-
      // lock state loudly rather than silently.
      /* c8 ignore start */
      if (!lockId) {
        throw new Error(
          "management-registry: lock holder lost mid-boot (missing-file path)",
        );
      }
      /* c8 ignore stop */
      // Fresh write resets the parse-failure banner: there is no
      // partially-recovered state to surface, so any prior diagnostic
      // is moot.
      clearManagementParseFailures(db);
      const written = await renderAndWriteManagementMd(
        contextDir,
        db,
        dbState,
        { lockManager, lockId, trigger: "management-registry.boot.create" },
      );
      logger.info(
        { path: written.path },
        "management.md created from DB defaults (file was missing)",
      );
      return {
        path,
        rewritten: true,
        rendered: dbState,
      } satisfies BootResult;
    }

    const parsed = await readAndParseManagementMd(contextDir);
    /* c8 ignore start — race-recovery path: the file existed at stat()
       but vanished before read (concurrent rm). Tested through the
       missing-file path above; reproducing the race in unit tests is
       brittle and the recovery is the same code shape. */
    if (!parsed) {
      const raceLockId = lockManager.getHolder();
      if (!raceLockId) {
        throw new Error(
          "management-registry: lock holder lost mid-boot (race path)",
        );
      }
      await renderAndWriteManagementMd(contextDir, db, dbState, {
        lockManager,
        lockId: raceLockId,
        trigger: "management-registry.boot.race",
      });
      return {
        path,
        rewritten: true,
        rendered: dbState,
      } satisfies BootResult;
    }
    /* c8 ignore stop */

    const lockId = lockManager.getHolder();
    // Defensive guard mirroring the missing-file branch above.
    /* c8 ignore start */
    if (!lockId) {
      throw new Error(
        "management-registry: lock holder lost mid-boot (parsed path)",
      );
    }
    /* c8 ignore stop */

    let renderOptions: RenderOptions = {};
    const schemaMatches =
      parsed.schemaVersion === MANAGEMENT_MD_SCHEMA_VERSION;

    if (!schemaMatches) {
      logger.warn(
        {
          detected: parsed.schemaVersion,
          current: MANAGEMENT_MD_SCHEMA_VERSION,
        },
        "management.md schema_version does not match current — re-rendering",
      );
    } else {
      // Round-trip parsed §A back into the DB so a hand-edit lands in
      // the canonical store. §B is render-only in P2 (the API surface
      // is P3); a divergence triggers a re-render.
      reconcileSectionAToDb(db, parsed, dbState);
      renderOptions = {
        preservedSectionC: parsed.preservedSectionC ?? undefined,
        preservedFreeProse: parsed.preservedFreeProse,
      };
    }

    if (parsed.failures.length > 0) {
      // Replay the failures into the DB diagnostic table so the
      // dashboard banner reflects them; the boot pass clears stale
      // failures first so a clean parse drops the banner.
      clearManagementParseFailures(db);
      for (const f of parsed.failures) {
        recordManagementParseFailure(db, f);
      }
      logger.warn(
        { failureCount: parsed.failures.length },
        "management.md boot parse produced row failures; recorded for the dashboard banner",
      );
    } else if (parsed.errors.length === 0) {
      clearManagementParseFailures(db);
    }

    // Always re-render so daemon-owned columns and any reverted §B
    // hand-edits round-trip back to canonical form. The renderer reads
    // the (possibly updated) DB state again — `dbState` above might be
    // stale after `reconcileSectionAToDb`.
    const rendered: RenderInput = {
      sotBindings: readSotBindings(db),
      managedTasks: listManagedTasks(db),
    };
    await renderAndWriteManagementMd(contextDir, db, rendered, {
      lockManager,
      lockId,
      trigger: schemaMatches
        ? "management-registry.boot.reconcile"
        : "management-registry.boot.schema-mismatch",
      render: renderOptions,
    });

    return {
      path,
      rewritten: !schemaMatches,
      rendered,
    } satisfies BootResult;
  });

  if (!lockResult.ok) {
    // Another caller holds the lock (e.g. a competing boot). Render
    // in read-only mode so callers still see consistent state.
    logger.warn(
      { holder: lockResult.holder },
      "management-registry boot skipped — write lock contended",
    );
    return {
      path,
      rewritten: false,
      rendered: {
        sotBindings: readSotBindings(db),
        managedTasks: listManagedTasks(db),
      },
    };
  }
  return lockResult.value;
}

/**
 * Apply a parsed §A block to the DB. Compared cell-by-cell against the
 * current state so semantically-identical edits don't churn the
 * `settings.updated_at` timestamp.
 */
function reconcileSectionAToDb(
  db: Database.Database,
  parsed: ParseResult,
  dbState: RenderInput,
): void {
  if (parsed.sotBindings.length === 0 && dbState.sotBindings.length === 0) {
    return;
  }
  if (
    parsed.sotBindings.length === dbState.sotBindings.length &&
    parsed.sotBindings.every((row, i) => {
      const cur = dbState.sotBindings[i];
      return (
        cur.category === row.category &&
        cur.sotApp === row.sotApp &&
        cur.mirrorPath === row.mirrorPath &&
        cur.policy === row.policy &&
        cur.writer === row.writer
      );
    })
  ) {
    return;
  }
  writeSotBindings(db, parsed.sotBindings);
  logger.info(
    { count: parsed.sotBindings.length },
    "management.md hand-edit applied to settings.sot_bindings",
  );
}

// ── Watcher ────────────────────────────────────────────────────────────────

export interface ManagementRegistryWatcherHandle {
  stop(): Promise<void>;
}

export interface ManagementRegistryWatcherOptions {
  /** Override the lock manager (tests use a deterministic instance). */
  lockManager?: ManagementMdWriteLockManager;
}

/**
 * Outcome of a single reconcile pass — surfaced for tests + telemetry.
 *
 * `noop` means the file event was a daemon self-write or the on-disk
 * file vanished mid-handler; `revert-fatal-parse` / `revert-v2`
 * represent the two reasons the watcher rewrites from DB instead of
 * applying the edit; `applied` is the success path.
 */
export type WatcherReconcileResult =
  | { kind: "noop" }
  | { kind: "lock-contended"; holder: string }
  | { kind: "revert-fatal-parse" }
  | { kind: "revert-v2" }
  | { kind: "applied"; failures: number };

/**
 * Pure reconciler used by the chokidar watcher. Encapsulates the full
 * (read-file → parse → mutate-DB → re-render) pipeline so unit tests
 * can exercise every branch without booting chokidar.
 */
export async function reconcileManagementMdFromFile(
  contextDir: string,
  db: Database.Database,
  lockManager: ManagementMdWriteLockManager,
  reason: "change" | "add" | "manual" = "manual",
): Promise<WatcherReconcileResult> {
  const path = getManagementMdPath(contextDir);
  if (consumeSelfWrite(path)) {
    logger.debug({ path, reason }, "management.md self-write ignored");
    return { kind: "noop" };
  }
  const parsed = await readAndParseManagementMd(contextDir);
  if (!parsed) return { kind: "noop" };

  let outcome: WatcherReconcileResult = { kind: "applied", failures: 0 };
  const result = await withManagementMdWriteLock(lockManager, async () => {
    const lockId = lockManager.getHolder();
    /* c8 ignore next 4 — held lock guarantees a holder; defensive only. */
    if (!lockId) {
      outcome = { kind: "noop" };
      return;
    }
    if (!parsed.ok) {
      logger.warn(
        { path, errors: parsed.errors, failureCount: parsed.failures.length },
        "management.md hand-edit failed to parse; reverting from DB",
      );
      for (const e of parsed.errors) {
        recordManagementParseFailure(db, { reason: e });
      }
      for (const f of parsed.failures) recordManagementParseFailure(db, f);
      await renderAndWriteManagementMd(
        contextDir,
        db,
        {
          sotBindings: readSotBindings(db),
          managedTasks: listManagedTasks(db),
        },
        {
          lockManager,
          lockId,
          trigger: "management-registry.watcher.revert",
        },
      );
      outcome = { kind: "revert-fatal-parse" };
      return;
    }
    if (parsed.schemaVersion === null) {
      logger.warn(
        { path },
        "management.md hand-edit lacks schema_version; reverting from DB",
      );
      await renderAndWriteManagementMd(
        contextDir,
        db,
        {
          sotBindings: readSotBindings(db),
          managedTasks: listManagedTasks(db),
        },
        {
          lockManager,
          lockId,
          trigger: "management-registry.watcher.v2-revert",
        },
      );
      outcome = { kind: "revert-v2" };
      return;
    }

    reconcileSectionAToDb(db, parsed, {
      sotBindings: readSotBindings(db),
      managedTasks: listManagedTasks(db),
    });
    if (parsed.failures.length > 0) {
      for (const f of parsed.failures) recordManagementParseFailure(db, f);
    } else {
      clearManagementParseFailures(db);
    }
    await renderAndWriteManagementMd(
      contextDir,
      db,
      {
        sotBindings: readSotBindings(db),
        managedTasks: listManagedTasks(db),
      },
      {
        lockManager,
        lockId,
        trigger: "management-registry.watcher.reconcile",
        render: {
          preservedSectionC: parsed.preservedSectionC ?? undefined,
          preservedFreeProse: parsed.preservedFreeProse,
        },
      },
    );
    outcome = { kind: "applied", failures: parsed.failures.length };
  });
  if (!result.ok) {
    logger.debug(
      { holder: result.holder, reason },
      "management.md watcher: lock contended; will reconcile on next change",
    );
    return { kind: "lock-contended", holder: result.holder };
  }
  return outcome;
}

/**
 * Watch `rules/management.md` for hand-edits and reconcile them against
 * the DB (§7.2 watch path). Self-writes are ignored. Fatal parse errors
 * trigger a re-render from the DB; row-level failures are recorded in
 * `management_parse_failures` and the dashboard surfaces a banner.
 *
 * The watcher does NOT mutate `managed_tasks` from the file in P2 — the
 * mutation surface is the P3 API. A row-count or column divergence is
 * treated as a hand-edit-revert: log + re-render from DB.
 */
/* c8 ignore start — chokidar wrapper; the logic lives in
   reconcileManagementMdFromFile, which is fully unit-tested. The
   wrapper itself is only event-binding glue. */
export function startManagementRegistryWatcher(
  contextDir: string,
  db: Database.Database,
  options: ManagementRegistryWatcherOptions = {},
): ManagementRegistryWatcherHandle {
  const path = getManagementMdPath(contextDir);
  const lockManager =
    options.lockManager ?? new InMemoryManagementMdWriteLockManager();
  const watcher = chokidar.watch(path, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  const handle = async (reason: "change" | "add"): Promise<void> => {
    try {
      await reconcileManagementMdFromFile(contextDir, db, lockManager, reason);
    } catch (err) {
      logger.error({ err, path, reason }, "management.md watcher handler error");
    }
  };

  watcher.on("change", () => void handle("change"));
  watcher.on("add", () => void handle("add"));
  watcher.on("error", (err: unknown) =>
    logger.error({ err }, "management.md watcher error"),
  );

  logger.info({ path }, "management.md watcher started");

  return {
    async stop() {
      await watcher.close();
      logger.info({ path }, "management.md watcher stopped");
    },
  };
}
/* c8 ignore stop */

// ── policy-files.ts compatibility check (P2 acceptance gate) ───────────────

/**
 * §0.2 — `rules/management.md` is the first wildcard ref in
 * `policy-files.ts`'s registry. The P2 plan calls out a verification
 * gate: "Verify `policy-files.ts` wildcard ref still loads the v3 file
 * unchanged." This helper is exposed so the boot path (and tests)
 * can sanity-check the file is reachable and below the per-file cap.
 *
 * Returns `null` when the file is missing — boot is responsible for
 * creating it. `tooLarge: true` flags a byte count above
 * `POLICY_FILE_MAX_BYTES` (32 KB) so prompt assembly skipping the file
 * (a silent failure mode) gets a loud diagnostic instead.
 */
export function verifyManagementMdLoadable(
  contextDir: string,
  policyFileMaxBytes: number,
): { ok: true; bytes: number } | { ok: false; reason: string } {
  const path = join(contextDir, RELATIVE_PATH);
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  const body = readFileSync(path, "utf-8");
  const bytes = Buffer.byteLength(body, "utf-8");
  if (bytes > policyFileMaxBytes) {
    return {
      ok: false,
      reason: `exceeds policy-file cap (${bytes} > ${policyFileMaxBytes})`,
    };
  }
  return { ok: true, bytes };
}

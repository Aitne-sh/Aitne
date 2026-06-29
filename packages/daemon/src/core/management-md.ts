import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import * as chokidar from "chokidar";
import {
  BACKEND_IDS,
  defaultIntegrationsMap,
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  integrationPatchSchema,
  isIntegrationKey,
  type BackendId,
  type IntegrationKey,
  type IntegrationMode,
  type IntegrationState,
} from "@aitne/shared";
import {
  readIntegrations,
  writeIntegrations,
  type IntegrationsRecord,
} from "../db/integrations-store.js";
import { missingDelegatedVariants, missingNativeVariants } from "./skills-compiler-variants.js";
import { createLogger } from "../logging.js";

const logger = createLogger("management-md");

const VAULT_RELATIVE_PATH = "policies/integrations.md";

/**
 * Integration Delegation Framework — `integrations.md` render + parse + watch
 * (Phase 1).
 *
 * After the CONTEXT_VAULT_REDESIGN restructure (§11.5), `integrations.md`
 * lives at `<contextDir>/policies/integrations.md` — inside the vault,
 * under the policies class. The legacy `~/.personal-agent/integrations.md`
 * location is migrated on the first boot post-upgrade by the
 * `0004-context-vault-restructure` migration. The DB (`settings` table,
 * key `"integrations"`) remains the authoritative source for the daemon.
 *
 * Write paths:
 *   - `PATCH /api/integrations/:key` → DB update → `renderManagementMd()`
 *     rewrites the file.
 *   - User hand-edits → chokidar fires → `parseManagementMd()` → DB update.
 *
 * Self-write suppression: every file write through `writeManagementMd()`
 * stamps the absolute path in a module-scoped Set cleared on the next tick.
 * The watcher checks this before re-parsing, so the PATCH-then-rewrite
 * flow doesn't loop back into itself.
 *
 * The file is fully idempotent: booting re-renders it from the DB state
 * unconditionally, so hand-edits that round-trip cleanly through the
 * parser produce identical bytes on the next render (no churn).
 */

/**
 * Resolve the canonical absolute path to the management/integrations
 * markdown file under the vault: `<contextDir>/policies/integrations.md`.
 *
 * `contextDir` is the preferred input — production callers thread
 * `getContextDir(config, db)` through so the path is correct in both
 * plain and Obsidian-vault modes. The optional `(dataDir)` fallback to
 * `<dataDir>/context` exists for test fixtures that don't construct a
 * full `AgentConfig`; it is NOT correct for Obsidian users (V18) and is
 * scheduled for removal once every test thread has been audited.
 */
export function getManagementMdPath(
  dataDir: string,
  contextDir?: string,
): string {
  const root = contextDir ?? resolve(dataDir, "context");
  return resolve(root, VAULT_RELATIVE_PATH);
}

const pendingSelfWrites = new Set<string>();

function markSelfWrite(absPath: string): void {
  pendingSelfWrites.add(absPath);
  // Clear on next tick so a round-trip through chokidar (which debounces)
  // doesn't hang onto the mark indefinitely. Chokidar's default
  // `awaitWriteFinish` settles within a few hundred ms; a 5s window is
  // generous without being open-ended.
  setTimeout(() => pendingSelfWrites.delete(absPath), 5000).unref();
}

function consumeSelfWrite(absPath: string): boolean {
  return pendingSelfWrites.delete(absPath);
}

// ── Render ─────────────────────────────────────────────────────────────────

// Frontmatter contract. `policies/integrations.md` lives inside the vault
// under the `policies/` authority class, so it MUST satisfy the vault
// frontmatter validator (`context-frontmatter.ts`): `type: rule`,
// `owner ∈ {agent, shared, user}`, and an ISO `updated` date. Before the
// CONTEXT_VAULT_REDESIGN restructure this file lived at the un-validated
// `~/.personal-agent/integrations.md`, so it shipped a bespoke
// daemon-snapshot frontmatter (`owner: daemon`, no `type`/`updated`). The
// restructure moved it under `policies/` and added the generic `policies/`
// validation, but this renderer was never reconciled — leaving every
// install's file flagged "frontmatter requires `type`" by Vault Health.
//
// `owner` is `shared` because the file is a daemon-rendered snapshot of
// `settings.integrations_json` that the user may also hand-edit (chokidar
// reconciles edits back into the DB) — the same mixed authority as
// `policies/management.md`. The Dashboard (Settings → Connections) remains
// the canonical edit surface. See §14.3 of
// docs/design/14-integration-delegation.md.
//
// `updated` is derived from the most recent `lastChangedAt` across all
// integration rows (truncated to a calendar date) so the render stays a
// pure function of DB state: booting re-renders byte-identical output until
// a mode actually changes, preserving the idempotency contract above.
const FRONTMATTER_FALLBACK_UPDATED = "2026-04-17";

function renderFrontmatter(integrations: IntegrationsRecord): string {
  let latest = "";
  for (const key of INTEGRATION_KEYS) {
    const ts = integrations[key].lastChangedAt;
    if (ts > latest) latest = ts;
  }
  const updated = /^\d{4}-\d{2}-\d{2}/.test(latest)
    ? latest.slice(0, 10)
    : FRONTMATTER_FALLBACK_UPDATED;
  return `---
type: rule
slug: integrations
owner: shared
updated: ${updated}
schema_version: 1
---
`;
}

const MODES_SECTION = `## Modes

- **direct** — daemon holds credentials and polls; full feature set; setup required.
- **delegated** — daemon proxies a separate backend connector on a cadence; reduced features; zero setup.
- **native** — main backend's own native MCP / connector reaches the integration on-demand within the same DM / activity_scan turn; no daemon polling and no daemon-side proxy.
- **disabled** — integration off.
`;

function renderCurrentStateTable(integrations: IntegrationsRecord): string {
  const rows: string[] = [
    "| Integration | Mode | Backend | Sub-tier | Last changed |",
    "|---|---|---|---|---|",
  ];
  for (const key of INTEGRATION_KEYS) {
    const state = integrations[key];
    // INTEGRATION_NATIVE_MODE_DESIGN.md §11.5 — the "Backend" column
    // surfaces whichever backend binding is active for the row, since
    // delegated and native are mutually exclusive. Direct/disabled
    // remain `—`.
    const backend =
      state.delegatedBackend ?? state.nativeBackend ?? "—";
    const subTier = renderSubTier(key, state);
    rows.push(
      `| ${key} | ${state.mode} | ${backend} | ${subTier} | ${state.lastChangedAt} |`,
    );
  }
  return `## Current state\n\n${rows.join("\n")}\n`;
}

function renderSubTier(key: IntegrationKey, state: IntegrationState): string {
  if (state.mode !== "delegated" || !state.delegatedBackend) return "—";
  // Per §4.6.1: Claude Code Gmail = Draft-Only, Codex Gmail = Full-Auto.
  // Calendar is close to parity on both backends.
  if (key === "gmail") {
    if (state.delegatedBackend === "claude") return "draft-only";
    if (state.delegatedBackend === "codex") return "full-auto";
  }
  return "full";
}

function renderActiveTodaySection(integrations: IntegrationsRecord): string {
  const active = INTEGRATION_KEYS.filter(
    (k) => integrations[k].mode !== "disabled",
  );
  if (active.length === 0) {
    return `## Active today\n\n_No integrations active._\n`;
  }
  return `## Active today\n\n${active.map((k) => `- \`${k}\``).join("\n")}\n`;
}

/**
 * SETUP-FLOW-REDESIGN-PLAN §6.2 — declarative "where do the user's notes
 * live" routing for the agent. The body is regenerated from the
 * integrations record (notion mode + delegated backend) plus runtime
 * settings (`externalObsidianVaultPath`, `externalObsidianWatch`). The
 * file remains a renderer-only surface — `parseManagementMd` ignores
 * this section and hand-edits are silently overwritten on the next
 * render, matching the read-only contract used by the connector-support
 * snapshot.
 */
export interface NoteSourcesInput {
  externalObsidianVaultPath: string | null;
  externalObsidianWatch: boolean;
}

export function renderNoteSourcesSection(
  integrations: IntegrationsRecord,
  notes: NoteSourcesInput,
): string {
  const obsidianLine = notes.externalObsidianVaultPath
    ? `${notes.externalObsidianVaultPath}${notes.externalObsidianWatch ? "" : " (watching disabled)"}`
    : "—";
  const notion = integrations.notion;
  let notionLine: string;
  if (notion.mode === "disabled") {
    notionLine = "disabled";
  } else if (notion.mode === "delegated" && notion.delegatedBackend) {
    notionLine = `enabled (delegated via ${notion.delegatedBackend})`;
  } else if (notion.mode === "native" && notion.nativeBackend) {
    notionLine = `enabled (native via ${notion.nativeBackend})`;
  } else {
    notionLine = "enabled (direct)";
  }
  const notionTargets = (notion.fetchTargets ?? []).map((target) => target.label);
  const notionTargetsLine = notionTargets.length > 0
    ? notionTargets.join(", ")
    : "—";
  return [
    "## Note Sources",
    "",
    "<!-- Auto-generated. Edit settings via Dashboard → Settings → Note. Hand-edits are overwritten on next render. -->",
    `- Obsidian vault (personal): ${obsidianLine}`,
    `- Notion: ${notionLine}`,
    `- Notion routine fetch targets: ${notionTargetsLine}`,
    "",
  ].join("\n");
}

const PLANNED_SECTION = `## Planned / not yet shipped

- \`google_drive\`
- \`slack\`
`;

/**
 * Human-friendly column header for the connector-support table.
 *
 * Centralised here (rather than colocated with `BACKEND_IDS`) because
 * the table is the only surface that needs the long-form name —
 * elsewhere the backend id itself is sufficient. Adding a new backend
 * to `BACKEND_IDS` requires only one entry here.
 */
const BACKEND_TABLE_LABEL: Record<BackendId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

function renderConnectorSupportTable(): string {
  // Drive columns from `BACKEND_IDS` so adding a new backend never
  // touches this renderer again — only the label map above.
  const backendHeaders = BACKEND_IDS.map((b) => BACKEND_TABLE_LABEL[b]);
  const headerRow = `| Integration | Direct | ${backendHeaders.join(" | ")} |`;
  const separatorRow = `|---|:---:|${BACKEND_IDS.map(() => ":---:").join("|")}|`;
  const rows: string[] = [headerRow, separatorRow];
  for (const key of INTEGRATION_KEYS) {
    const desc = INTEGRATION_DESCRIPTORS[key];
    const directCell = desc.directSetup ? "✅" : "—";
    const backendCells = BACKEND_IDS.map((backend) =>
      renderConnectorCell(desc.backendConnectors[backend], key, backend),
    );
    rows.push(`| ${key} | ${directCell} | ${backendCells.join(" | ")} |`);
  }
  return `## Per-backend connector support (read-only snapshot, rendered by daemon)\n\n${rows.join(
    "\n",
  )}\n`;
}

function renderConnectorCell(
  connector: { optionalCapabilities: readonly string[] } | undefined,
  integrationKey: IntegrationKey,
  backend: BackendId,
): string {
  if (!connector) return backend === "gemini" ? "🕓 unverified" : "—";
  if (integrationKey === "gmail" && backend === "claude") {
    return "⚠️ draft-only";
  }
  return "✅";
}

function renderToolDenySection(integrations: IntegrationsRecord): string {
  // §7.7 — render the per-integration deny list. Skip integrations with
  // an empty list so the section stays compact. The header always renders
  // (even when every integration is empty) so users / round-trip parsers
  // know the section exists.
  const blocks: string[] = [];
  for (const key of INTEGRATION_KEYS) {
    const denied = integrations[key].deniedTools ?? [];
    if (denied.length === 0) continue;
    const lines = [`### ${key}`, ""];
    for (const tool of denied) {
      lines.push(`- \`${tool}\``);
    }
    lines.push("");
    blocks.push(lines.join("\n"));
  }
  const header =
    "## Tool deny policy (§7.7)\n\n" +
    "Per-tool deny list, materialized into the delegated skill body. Hard\n" +
    "enforcement on Claude (`allowed-tools` frontmatter is filtered); soft\n" +
    "enforcement on Codex / Gemini (a \"Denied tools (do not invoke)\" prose\n" +
    "block is appended to the skill body). Edit via the dashboard's Tool\n" +
    "Permissions card under each integration.\n\n";
  if (blocks.length === 0) {
    return header + "_No tools denied._\n";
  }
  return header + blocks.join("\n");
}

// ── Integration routing tables (§6.5.2 / §7.3) ─────────────────────────────

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §7.3 — render the full per-session
 * routing table that the per-backend instruction file (`CLAUDE.md` /
 * `AGENTS.md` / `GEMINI.md`) and the activity_scan / DM task-flow files
 * substitute in for the `<integration-routing-table>` placeholder.
 *
 * Always renders every registered integration, even when all rows are
 * `direct`, so the agent's mental model converges on "read the routing
 * table first, then dispatch." Disabled rows appear as `(disabled)` so
 * the agent can answer "do I have Gmail?" honestly even when the audit
 * surface is suppressed.
 *
 * Pure function — no I/O, no DB reads. Callers pass the integration
 * snapshot they want rendered (typically from `readIntegrations(db)`).
 */
export function renderIntegrationRoutingTable(
  integrations: IntegrationsRecord,
): string {
  const rows: string[] = [
    "| Integration | Mode | Data path |",
    "|---|---|---|",
  ];
  for (const key of INTEGRATION_KEYS) {
    const state = integrations[key];
    rows.push(
      `| ${key} | ${state.mode} | ${describeDataPath(key, state)} |`,
    );
  }
  return rows.join("\n");
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §6.5.2 — the actionable variant of
 * the routing table. Identical rendering for `direct` / `delegated` /
 * `native` rows; `disabled` rows are filtered out entirely so the
 * task-flow's "for each integration" loop has zero iterations for them.
 *
 * This is what the activity_scan and DM task-flow files iterate over;
 * the full {@link renderIntegrationRoutingTable} is for the instruction
 * file's read-only audit summary.
 */
export function renderIntegrationRoutingTableActionable(
  integrations: IntegrationsRecord,
): string {
  const rows: string[] = [
    "| Integration | Mode | Data path |",
    "|---|---|---|",
  ];
  let actionableCount = 0;
  for (const key of INTEGRATION_KEYS) {
    const state = integrations[key];
    if (state.mode === "disabled") continue;
    actionableCount++;
    rows.push(
      `| ${key} | ${state.mode} | ${describeDataPath(key, state)} |`,
    );
  }
  if (actionableCount === 0) {
    // Empty-table marker the task-flow author can branch on. Renders as
    // a single italic line so the surrounding prompt stays parseable.
    return "_No actionable integrations — every registered key is currently disabled._";
  }
  return rows.join("\n");
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §7.3 / §6.5.2 — substitute the two
 * angle-bracket placeholders documented in the design with their
 * rendered tables. The placeholders are deliberately literal strings
 * (not `{handlebars}` template tokens) so they survive the existing
 * `resolveTemplate` pass in `prompt-utils.ts` (which only touches
 * `{…}` braces) without escaping. Substitution is idempotent — running
 * the helper twice on already-substituted text is a no-op because the
 * placeholder strings have already been replaced.
 *
 * Callers:
 *   - `prompts.getTaskFlow` substitutes after `applyIntegrationModeFilter`
 *     so the rendered template carries the final per-session table
 *     before `resolveTemplate` fills `{context}` and `{event_data[*]}`.
 *   - `skills-compiler.materializeClaudeSession` /
 *     `materializeCliSession` substitute inside the rendered profile
 *     body before writing `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`.
 *
 * Returns `content` unchanged when neither placeholder is present so
 * call sites can apply this unconditionally without measuring impact.
 */
export const INTEGRATION_ROUTING_TABLE_PLACEHOLDER = "<integration-routing-table>";
export const INTEGRATION_ROUTING_TABLE_ACTIONABLE_PLACEHOLDER =
  "<integration-routing-table-actionable>";

export function substituteIntegrationRoutingTables(
  content: string,
  integrations:
    | IntegrationsRecord
    | Partial<Record<IntegrationKey, IntegrationState>>,
): string {
  if (
    !content.includes(INTEGRATION_ROUTING_TABLE_PLACEHOLDER)
    && !content.includes(INTEGRATION_ROUTING_TABLE_ACTIONABLE_PLACEHOLDER)
  ) {
    return content;
  }
  // Fill missing keys with the registry default (disabled for most,
  // direct for git/github) so the renderer always sees a full record.
  // Callers from `prompts.ts` and `skills-compiler.ts` hold a Partial
  // (the SkillsCompiler constructor parameter is Partial by design —
  // tests instantiate it with `{}` for direct-mode coverage). Filling
  // here keeps every consumer's call site noise-free.
  const filled = ensureFullIntegrationsRecord(integrations);
  // Order matters: substitute the longer/actionable token first so a
  // future placeholder that contains the shorter token as a substring
  // (e.g. a hypothetical `<integration-routing-table-X>`) still binds
  // exactly. `replaceAll` so multiple insertions in one profile / flow
  // all get rendered.
  return content
    .replaceAll(
      INTEGRATION_ROUTING_TABLE_ACTIONABLE_PLACEHOLDER,
      renderIntegrationRoutingTableActionable(filled),
    )
    .replaceAll(
      INTEGRATION_ROUTING_TABLE_PLACEHOLDER,
      renderIntegrationRoutingTable(filled),
    );
}

function ensureFullIntegrationsRecord(
  integrations:
    | IntegrationsRecord
    | Partial<Record<IntegrationKey, IntegrationState>>,
): IntegrationsRecord {
  const defaults = defaultIntegrationsMap();
  const out = {} as IntegrationsRecord;
  for (const key of INTEGRATION_KEYS) {
    out[key] = integrations[key] ?? defaults[key];
  }
  return out;
}

function describeDataPath(
  key: IntegrationKey,
  state: IntegrationState,
): string {
  switch (state.mode) {
    case "direct":
      return `curl http://localhost:8321/api/${dataPathPrefixFor(key)}/*`;
    case "delegated": {
      const backend = state.delegatedBackend;
      if (!backend) return "delegated (no backend bound — re-configure)";
      return `POST /api/integrations/${key}/exec (proxy → ${backend})`;
    }
    case "native": {
      const backend = state.nativeBackend;
      if (!backend) return "native (no backend bound — re-configure)";
      // The descriptor's `toolNamespace` is the bare prefix the agent
      // sees; suffix with `*` so the rendered string reads as a glob.
      const namespace =
        INTEGRATION_DESCRIPTORS[key].backendConnectors[backend]?.toolNamespace;
      const surface = namespace
        ? `${namespace}* (${backend} native MCP)`
        : `${backend} native MCP`;
      return `${surface} — DO NOT call /api/${key}/*`;
    }
    case "disabled":
      return "(disabled)";
  }
}

/**
 * Per-integration daemon-API path prefix used in {@link describeDataPath}.
 * Mirrors the documented routes; we don't introspect `apiRoutesTouched`
 * because that field is intentionally empty for multi-provider routes
 * (gmail under /api/mail/*) and we still want the routing table to name
 * a concrete path the agent can grep for.
 */
function dataPathPrefixFor(key: IntegrationKey): string {
  switch (key) {
    case "gmail":
      return "mail";
    case "google_calendar":
      return "calendar";
    case "notion":
      return "notion";
    case "git":
      return "git";
    case "github":
      return "github";
    case "outlook_mail":
      return "mail";
    case "outlook_calendar":
      return "calendar/outlook";
    case "browser_history":
      return "browser-history";
  }
}

export function renderManagementMd(
  integrations: IntegrationsRecord,
  notes: NoteSourcesInput = {
    externalObsidianVaultPath: null,
    externalObsidianWatch: true,
  },
): string {
  return [
    renderFrontmatter(integrations),
    "# Integration Management\n",
    MODES_SECTION,
    renderCurrentStateTable(integrations),
    renderActiveTodaySection(integrations),
    renderNoteSourcesSection(integrations, notes),
    PLANNED_SECTION,
    renderConnectorSupportTable(),
    renderToolDenySection(integrations),
  ].join("\n");
}

// ── Parse ──────────────────────────────────────────────────────────────────

export interface ParsedCurrentStateRow {
  key: string;
  mode: string;
  backend: string;
  lastChanged: string;
}

export interface ParseResult {
  ok: boolean;
  /** Validated per-key states, keyed by recognized IntegrationKey only. */
  integrations: Partial<Record<IntegrationKey, IntegrationState>>;
  /** Non-fatal issues (unknown keys, malformed rows) — logged, not an abort. */
  warnings: string[];
  /** Fatal issues (invalid mode value, missing column) — caller should revert. */
  errors: string[];
}

/**
 * Parse the "Current state" table from an `integrations.md` body. Free prose,
 * `Modes`, `Active today`, `Planned`, and the connector-support snapshot are
 * all ignored — the Current-state table is authoritative. `Last changed` is
 * written by the daemon; user edits to that column are tolerated and
 * preserved only when valid ISO-8601.
 */
export function parseManagementMd(body: string): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const integrations: Partial<Record<IntegrationKey, IntegrationState>> = {};

  const currentStateRows = extractCurrentStateRows(body);
  if (currentStateRows === null) {
    errors.push("missing or malformed 'Current state' table");
    return { ok: false, integrations, warnings, errors };
  }

  // §7.7 — extract the per-integration deny list once; merge into rows below.
  // Unknown integrations are warned, not fatal (schema-admin lock-down is a
  // soft policy — a malformed deny block must not block the whole file).
  const denyByKey = extractToolDenyBlocks(body, warnings);

  for (const row of currentStateRows) {
    if (!isIntegrationKey(row.key)) {
      warnings.push(`unknown integration key: ${row.key}`);
      continue;
    }
    const mode = row.mode as IntegrationMode;
    const backendCell = row.backend === "—" || row.backend === "" ? undefined : row.backend;
    // INTEGRATION_NATIVE_MODE_DESIGN.md §5.2 — the rendered table has a
    // single "Backend" column whose semantics flip on mode: delegated
    // rows carry `delegatedBackend`, native rows carry `nativeBackend`,
    // direct / disabled carry `—`. Route the parsed cell to the correct
    // field so a round-trip (render → hand-edit → parseManagementMd →
    // DB) preserves the binding. Sending a native cell into
    // `delegatedBackend` would either fail the schema's mutual-exclusion
    // `superRefine` or silently drop the binding (whichever field
    // `superRefine` clears when mode flips).
    const backendForMode =
      mode === "delegated"
        ? { delegatedBackend: backendCell }
        : mode === "native"
          ? { nativeBackend: backendCell }
          : {};
    const patch = integrationPatchSchema.safeParse({
      mode,
      ...backendForMode,
    });
    if (!patch.success) {
      errors.push(
        `integration ${row.key}: ${patch.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      );
      continue;
    }
    const lastChanged = isIsoDate(row.lastChanged)
      ? row.lastChanged
      : new Date().toISOString();
    integrations[row.key] = {
      mode: patch.data.mode,
      ...(patch.data.delegatedBackend
        ? { delegatedBackend: patch.data.delegatedBackend }
        : {}),
      ...(patch.data.nativeBackend
        ? { nativeBackend: patch.data.nativeBackend }
        : {}),
      deniedTools: denyByKey[row.key] ?? [],
      lastChangedAt: lastChanged,
    };
  }

  return { ok: errors.length === 0, integrations, warnings, errors };
}

/**
 * Walk the rendered body for `### <integration-key>` blocks under the
 * `## Tool deny policy` section. Each block lists denied tool names as
 * backtick-wrapped bullets; we strip backticks and return a per-integration
 * map. The watcher uses this to round-trip hand-edits without losing the
 * deny list.
 */
function extractToolDenyBlocks(
  body: string,
  warnings: string[],
): Partial<Record<IntegrationKey, string[]>> {
  const out: Partial<Record<IntegrationKey, string[]>> = {};
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^##\s+Tool deny policy/i.test(lines[i])) {
    i++;
  }
  if (i >= lines.length) return out;
  i++;

  let currentKey: IntegrationKey | null = null;
  while (i < lines.length) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break; // next h2 → leave the deny section
    const subHeader = /^###\s+(\S+)/.exec(line);
    if (subHeader) {
      const key = subHeader[1];
      if (isIntegrationKey(key)) {
        currentKey = key;
        out[currentKey] = [];
      } else {
        warnings.push(`unknown integration key in tool deny section: ${key}`);
        currentKey = null;
      }
      i++;
      continue;
    }
    if (currentKey) {
      const bullet = /^\s*-\s+`?([^`\s]+)`?/.exec(line);
      if (bullet) {
        out[currentKey]!.push(bullet[1]);
      }
    }
    i++;
  }
  return out;
}

function extractCurrentStateRows(body: string): ParsedCurrentStateRow[] | null {
  // Find the "## Current state" section and walk forward to the first
  // pipe-delimited table. Markdown tables have a separator line (`|---|...`)
  // that we skip.
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^##\s+Current state\s*$/i.test(lines[i])) {
    i++;
  }
  if (i >= lines.length) return null;

  // Skip blank lines, then expect a table header.
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !lines[i].trim().startsWith("|")) return null;

  // Consume header + separator.
  i += 2;

  const rows: ParsedCurrentStateRow[] = [];
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "" || !line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) {
      i++;
      continue;
    }
    rows.push({
      key: cells[0],
      mode: cells[1],
      backend: cells[2],
      // cells[3] is sub-tier — rendered-only, ignored by parser
      lastChanged: cells[4],
    });
    i++;
  }
  return rows;
}

function isIsoDate(value: string): boolean {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && value.includes("T");
}

// ── File I/O ───────────────────────────────────────────────────────────────

/**
 * Write the rendered body to disk, creating parent directories if needed.
 * Stamps the path as a self-write so the watcher skips the resulting event.
 *
 * `notes` is optional for backward compatibility — callers that have not
 * yet been wired to surface external-vault state pass nothing and the
 * section renders the "—" placeholder. The dashboard config PATCH
 * handler is wired (SETUP-FLOW-REDESIGN-PLAN §6.2) so any user edit
 * round-trips through the proper inputs.
 */
export async function writeManagementMd(
  dataDir: string,
  integrations: IntegrationsRecord,
  notes?: NoteSourcesInput,
  contextDir?: string,
): Promise<string> {
  const path = getManagementMdPath(dataDir, contextDir);
  await mkdir(dirname(path), { recursive: true });
  const body = renderManagementMd(integrations, notes);
  markSelfWrite(path);
  await writeFile(path, body, "utf-8");
  return path;
}

/**
 * Read + parse the file from disk. Returns `null` when the file does not
 * exist — callers treat that as "first run, write defaults and move on".
 */
export async function readAndParseManagementMd(
  dataDir: string,
  contextDir?: string,
): Promise<ParseResult | null> {
  const path = getManagementMdPath(dataDir, contextDir);
  try {
    const body = await readFile(path, "utf-8");
    return parseManagementMd(body);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Boot + watch ───────────────────────────────────────────────────────────

export interface ManagementMdBootResult {
  path: string;
  /** True if the file was missing and just created from DB state. */
  created: boolean;
  /** Integrations record after reconciliation with any user-edited file. */
  integrations: IntegrationsRecord;
  /** Delegated flips rejected for missing variants (§4.7). */
  rejections: VariantRejection[];
}

/**
 * First-start reconciliation:
 *   1. If the file is missing → render it from the DB and return.
 *   2. If the file is present and parses clean → merge user-visible fields
 *      (mode + delegatedBackend) back into the DB. Any delegated flip
 *      whose required variant files are missing is reverted per
 *      `enforceVariantAvailability` (§4.7 symmetry with the PATCH edge).
 *      Then re-render so daemon-owned columns (lastChanged adjustments,
 *      reverted rows) round-trip cleanly.
 *   3. If parse fails → log, leave the DB alone, re-render from DB so the
 *      file moves back to a known-good state. The owner-DM branch is
 *      Phase 2+; for now we only log.
 */
export async function bootstrapManagementMd(
  dataDir: string,
  db: Database.Database,
  workspaceDir?: string,
  notes?: NoteSourcesInput,
  contextDir?: string,
): Promise<ManagementMdBootResult> {
  const path = getManagementMdPath(dataDir, contextDir);
  const dbState = readIntegrations(db);

  let fileExists = true;
  try {
    await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fileExists = false;
    } else {
      throw err;
    }
  }

  if (!fileExists) {
    await writeManagementMd(dataDir, dbState, notes, contextDir);
    logger.info({ path }, "integrations.md created with default integrations map");
    return { path, created: true, integrations: dbState, rejections: [] };
  }

  const parsed = await readAndParseManagementMd(dataDir, contextDir);
  if (!parsed || !parsed.ok) {
    logger.warn(
      { path, errors: parsed?.errors, warnings: parsed?.warnings },
      "integrations.md did not parse cleanly; re-rendering from DB",
    );
    await writeManagementMd(dataDir, dbState, notes, contextDir);
    return { path, created: false, integrations: dbState, rejections: [] };
  }

  const merged = mergeParsedIntoDb(dbState, parsed.integrations);
  // `workspaceDir` is optional so older integration tests that only care
  // about parse/render behavior keep passing; pre-existing startup code
  // threads the real value through. When absent, the missing-variant
  // guard is a no-op — equivalent to pre-follow-up behavior.
  const { filtered, rejections } = workspaceDir
    ? enforceVariantAvailability(merged, dbState, workspaceDir)
    : { filtered: merged, rejections: [] as VariantRejection[] };
  if (rejections.length > 0) {
    logger.warn(
      { path, rejections },
      "integrations.md: delegated flip(s) reverted — required variant files missing",
    );
  }
  if (changed(dbState, filtered)) {
    writeIntegrations(db, filtered);
    logger.info(
      { path, changedKeys: diffKeys(dbState, filtered) },
      "applied integrations.md edits to DB on boot",
    );
  }
  // Always re-render so daemon-owned columns are canonical — and so any
  // reverted rows are visibly corrected in the file even when the user
  // doesn't re-edit.
  await writeManagementMd(dataDir, filtered, notes, contextDir);
  if (parsed.warnings.length > 0) {
    logger.warn({ warnings: parsed.warnings }, "integrations.md boot warnings");
  }
  return { path, created: false, integrations: filtered, rejections };
}

function mergeParsedIntoDb(
  dbState: IntegrationsRecord,
  parsed: Partial<Record<IntegrationKey, IntegrationState>>,
): IntegrationsRecord {
  const merged = { ...dbState } as IntegrationsRecord;
  for (const key of INTEGRATION_KEYS) {
    const next = parsed[key];
    if (!next) continue;
    const prev = dbState[key];
    const semanticChange =
      prev.mode !== next.mode ||
      (prev.delegatedBackend ?? undefined) !==
        (next.delegatedBackend ?? undefined);
    if (semanticChange) {
      merged[key] = {
        ...next,
        fetchTargets: prev.fetchTargets ?? [],
        lastChangedAt: new Date().toISOString(),
      };
    }
  }
  return merged;
}

export interface VariantRejection {
  key: IntegrationKey;
  backend: BackendId;
  missing: string[];
}

/**
 * §4.7 "Missing-variant policy" enforcement on the integrations.md side.
 *
 * For every delegated flip introduced by the merge, verify the target
 * backend's skill + task-flow variants exist on disk. Any key with a
 * missing variant is reverted to its previous DB state; accepted keys
 * pass through untouched. The returned `rejections` list lets the caller
 * log / DM / re-render to surface the rollback.
 *
 * This mirrors the 400 `missing_variants` response on
 * `PATCH /api/integrations/:key` — both the API edge and the file-edit
 * edge now refuse to commit a delegated state the agent would silently
 * fall back out of.
 */
export function enforceVariantAvailability(
  merged: IntegrationsRecord,
  dbState: IntegrationsRecord,
  workspaceDir: string,
): { filtered: IntegrationsRecord; rejections: VariantRejection[] } {
  const filtered = { ...merged } as IntegrationsRecord;
  const rejections: VariantRejection[] = [];
  for (const key of INTEGRATION_KEYS) {
    const next = merged[key];
    const prev = dbState[key];
    // DELEGATED-MODE-V2-DESIGN.md §11 (Phase 3) re-activated the variant
    // gate for every delegated integration: gmail and google_calendar
    // now ship `SKILL.delegated.<sessionBackend>.md` variants
    // (cross-backend) plus the `null` resolution for same-backend.
    // INTEGRATION_NATIVE_MODE_DESIGN.md §11.3 — mirror the gate for
    // native flips so a hand-edit that introduces native + a missing
    // skill variant gets rolled back the same way a delegated flip does.
    //
    // Only validate when this edit introduces a new (mode, backend)
    // binding. A row whose state matches the DB pre-merge has already
    // cleared the check at some prior boot / PATCH; re-running here
    // would churn on every unrelated edit.
    let missing: { skills: string[]; taskFlows: string[] } | null = null;
    let activeBackend: BackendId | null = null;
    if (next.mode === "delegated" && next.delegatedBackend) {
      const semanticallyNew =
        prev.mode !== next.mode ||
        (prev.delegatedBackend ?? null) !== (next.delegatedBackend ?? null);
      if (!semanticallyNew) continue;
      activeBackend = next.delegatedBackend;
      missing = missingDelegatedVariants(workspaceDir, key, activeBackend);
    } else if (next.mode === "native" && next.nativeBackend) {
      const semanticallyNew =
        prev.mode !== next.mode ||
        (prev.nativeBackend ?? null) !== (next.nativeBackend ?? null);
      if (!semanticallyNew) continue;
      activeBackend = next.nativeBackend;
      missing = missingNativeVariants(workspaceDir, key, activeBackend);
    } else {
      continue;
    }
    const paths = [...missing.skills, ...missing.taskFlows];
    if (paths.length === 0) continue;
    filtered[key] = prev;
    rejections.push({ key, backend: activeBackend, missing: paths });
  }
  return { filtered, rejections };
}

function changed(a: IntegrationsRecord, b: IntegrationsRecord): boolean {
  for (const key of INTEGRATION_KEYS) {
    if (integrationRowChanged(a[key], b[key])) return true;
  }
  return false;
}

function diffKeys(
  a: IntegrationsRecord,
  b: IntegrationsRecord,
): IntegrationKey[] {
  return INTEGRATION_KEYS.filter((key) =>
    integrationRowChanged(a[key], b[key]),
  );
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §5.2 — a row changed when ANY of
 * `mode`, `delegatedBackend`, or `nativeBackend` differs. Pre-native
 * code compared only mode + delegatedBackend, which silently swallowed
 * a native-binding flip (e.g. `nativeBackend: claude → codex` after a
 * main-backend change, where the §11.4 cascade clears the row to
 * `disabled` — the cascade itself flips mode, so this didn't matter in
 * practice, but missing the comparison risks a future code path that
 * mutates nativeBackend without flipping mode).
 */
function integrationRowChanged(
  a: IntegrationState,
  b: IntegrationState,
): boolean {
  return (
    a.mode !== b.mode ||
    (a.delegatedBackend ?? undefined) !== (b.delegatedBackend ?? undefined) ||
    (a.nativeBackend ?? undefined) !== (b.nativeBackend ?? undefined)
  );
}

export interface ManagementMdWatcherHandle {
  stop(): Promise<void>;
}

export interface ManagementMdWatcherOptions {
  /**
   * Repo root — used to locate `agent-assets/skills/` and
   * `agent-assets/task-flows/` for the §4.7 variant-availability check.
   * When omitted, the check is a no-op (legacy behavior).
   */
  workspaceDir?: string;
  /**
   * Optional owner-DM hook. Called with the reverted-delegated-flip list
   * whenever the watcher rejects a hand-edit. Leave undefined to skip;
   * the log line is always written either way.
   */
  sendNotification?: (params: {
    message: string;
    notificationType?: string;
    priority?: "low" | "normal" | "high";
  }) => Promise<unknown>;
  /**
   * SETUP-FLOW-REDESIGN-PLAN §6.2 — live external-vault state. Each
   * reconcile re-renders `integrations.md` with the current Note Sources
   * section; the callback gives chokidar the latest values without us
   * having to invalidate `AgentConfig` snapshots through the watcher.
   * Returning null/true defaults preserves legacy boot behavior.
   */
  getNoteSources?: () => NoteSourcesInput;
}

/**
 * Watch `integrations.md` for out-of-band edits and reconcile them into the
 * DB. Self-writes stamped via `writeManagementMd()` are ignored; bad parses
 * trigger a rewrite from the DB state.
 *
 * §4.7 symmetry: delegated flips whose skill or task-flow variant files
 * are absent on disk are reverted to the previous DB state, the file is
 * re-rendered to show the rollback, and (if `sendNotification` is wired)
 * the owner gets a DM explaining which files need to be authored.
 */
export function startManagementMdWatcher(
  dataDir: string,
  db: Database.Database,
  options: ManagementMdWatcherOptions = {},
  contextDir?: string,
): ManagementMdWatcherHandle {
  const path = getManagementMdPath(dataDir, contextDir);
  const watcher = chokidar.watch(path, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  const handle = async (reason: "change" | "add"): Promise<void> => {
    if (consumeSelfWrite(path)) {
      logger.debug({ path, reason }, "integrations.md: self-write ignored");
      return;
    }
    try {
      const parsed = await readAndParseManagementMd(dataDir, contextDir);
      if (!parsed) return;
      if (!parsed.ok) {
        logger.warn(
          { path, errors: parsed.errors, warnings: parsed.warnings },
          "integrations.md parse failed — rewriting from DB",
        );
        const dbState = readIntegrations(db);
        await writeManagementMd(dataDir, dbState, options.getNoteSources?.(), contextDir);
        return;
      }
      const dbState = readIntegrations(db);
      const merged = mergeParsedIntoDb(dbState, parsed.integrations);
      const { filtered, rejections } = options.workspaceDir
        ? enforceVariantAvailability(merged, dbState, options.workspaceDir)
        : { filtered: merged, rejections: [] as VariantRejection[] };
      if (rejections.length > 0) {
        logger.warn(
          { path, rejections, reason },
          "integrations.md: delegated flip(s) reverted — required variant files missing",
        );
        if (options.sendNotification) {
          try {
            await options.sendNotification({
              message: buildRevertDm(rejections),
              notificationType: "integration.variant_missing",
              priority: "normal",
            });
          } catch (err) {
            logger.warn(
              { err, rejections },
              "integrations.md: failed to DM owner about variant-missing revert",
            );
          }
        }
      }
      if (changed(dbState, filtered)) {
        writeIntegrations(db, filtered);
        logger.info(
          { path, changedKeys: diffKeys(dbState, filtered), reason },
          "integrations.md edit applied to DB",
        );
        // Re-render so timestamps the parser stamped with `now` become
        // the canonical serialized form.
        await writeManagementMd(dataDir, filtered, options.getNoteSources?.(), contextDir);
      } else if (rejections.length > 0) {
        // The only change was a rejected delegated flip — filtered
        // equals dbState, so no DB write, but we still want the file to
        // visibly reflect the reverted state (otherwise the user's edit
        // would appear to "stick" on disk).
        await writeManagementMd(dataDir, filtered, options.getNoteSources?.(), contextDir);
      } else if (parsed.warnings.length > 0) {
        logger.warn(
          { warnings: parsed.warnings },
          "integrations.md: semantic-equivalent edit with warnings",
        );
      }
    } catch (err) {
      logger.error({ err, path }, "integrations.md watcher handler error");
    }
  };

  watcher.on("change", () => void handle("change"));
  watcher.on("add", () => void handle("add"));
  watcher.on("error", (err: unknown) =>
    logger.error({ err }, "integrations.md watcher error"),
  );

  logger.info({ path }, "integrations.md watcher started");

  return {
    async stop() {
      await watcher.close();
      logger.info({ path }, "integrations.md watcher stopped");
    },
  };
}

function buildRevertDm(rejections: VariantRejection[]): string {
  const lines = [
    `integrations.md: reverted ${rejections.length} delegated flip(s) — required variant file(s) missing:`,
  ];
  for (const r of rejections) {
    lines.push(
      `• ${r.key} → ${r.backend}: ${r.missing.length} file(s)`,
    );
    for (const p of r.missing) {
      lines.push(`    ${p}`);
    }
  }
  lines.push(
    "Author these variants (or narrow the registry's skillsTouched / taskFlowsTouched) before retrying.",
  );
  return lines.join("\n");
}

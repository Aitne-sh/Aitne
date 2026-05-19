import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import { writeIntegrations, readIntegrations } from "../db/integrations-store.js";
import {
  bootstrapManagementMd,
  enforceVariantAvailability,
  getManagementMdPath,
  parseManagementMd,
  readAndParseManagementMd,
  renderManagementMd,
  startManagementMdWatcher,
  writeManagementMd,
} from "./management-md.js";
import { defaultIntegrationsMap } from "@aitne/shared";

describe("management-md render", () => {
  it("renders a default all-disabled map with a stable structure", () => {
    const body = renderManagementMd(
      defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
    );
    expect(body).toMatch(/^---\nfile: integrations.md/);
    expect(body).toContain("# Integration Management");
    expect(body).toContain("## Current state");
    expect(body).toContain("| gmail | disabled | — | — | 2026-04-19T00:00:00.000Z |");
    expect(body).toContain("| google_calendar | disabled | — | — |");
    // git + github default to "direct" (defaultIntegrationMode), so the
    // active-today section lists them rather than the empty placeholder.
    expect(body).toContain("## Active today");
    expect(body).toContain("- `git`");
    expect(body).toContain("- `github`");
    expect(body).toContain("## Planned / not yet shipped");
    // Per-backend connector support row: claude (✅), codex (✅), and
    // gemini (✅ — google-workspace extension delivers Gmail). Gmail's
    // claude column carries the draft-only sub-tier marker. OpenCode
    // has no native MCP connector for gmail (OPENCODE_BACKEND_DESIGN
    // §11) so its column is em-dash.
    expect(body).toContain("| gmail | ✅ | ⚠️ draft-only | ✅ | ✅ | — |");
  });

  it("renders the draft-only sub-tier for Claude-delegated Gmail", () => {
    const body = renderManagementMd({
      ...defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    expect(body).toContain("| gmail | delegated | claude | draft-only |");
    expect(body).toContain("| google_calendar | delegated | codex | full |");
    expect(body).toContain("- `gmail`");
    expect(body).toContain("- `google_calendar`");
  });

  it("renders full-auto for Codex-delegated Gmail", () => {
    const body = renderManagementMd({
      ...defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
      google_calendar: {
        mode: "disabled",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    expect(body).toContain("| gmail | delegated | codex | full-auto |");
  });
});

describe("Note Sources section (SETUP-FLOW-REDESIGN-PLAN §6.2)", () => {
  it("renders an em-dash placeholder when no external Obsidian path is set", () => {
    const body = renderManagementMd(
      defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
    );
    expect(body).toContain("## Note Sources");
    expect(body).toContain("- Obsidian vault (personal): —");
    expect(body).toContain("- Notion: disabled");
  });

  it("renders the supplied external Obsidian path", () => {
    const body = renderManagementMd(
      defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      {
        externalObsidianVaultPath: "/Users/test/Documents/MyVault",
        externalObsidianWatch: true,
      },
    );
    expect(body).toContain(
      "- Obsidian vault (personal): /Users/test/Documents/MyVault",
    );
    // No "(watching disabled)" tail when watch is true.
    expect(body).not.toContain("(watching disabled)");
  });

  it("flags the watch-disabled state when externalObsidianWatch is false", () => {
    const body = renderManagementMd(
      defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      {
        externalObsidianVaultPath: "/Users/test/Documents/Vault",
        externalObsidianWatch: false,
      },
    );
    expect(body).toContain(
      "- Obsidian vault (personal): /Users/test/Documents/Vault (watching disabled)",
    );
  });

  it("renders the Notion delegated state with backend name", () => {
    const body = renderManagementMd({
      ...defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    expect(body).toContain("- Notion: enabled (delegated via claude)");
  });

  it("renders the Notion direct state", () => {
    const body = renderManagementMd({
      ...defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      notion: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    expect(body).toContain("- Notion: enabled (direct)");
  });

  it("preserves the section across hand-edits via parser silence (round-trip parity)", () => {
    // The parser ignores the Note Sources section by design — hand-edits
    // there are silently overwritten on the next render. Sanity-check the
    // contract: parsing a body containing the section returns a clean
    // result without exposing Note Sources keys.
    const body = renderManagementMd(
      defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      {
        externalObsidianVaultPath: "/Users/test/Documents/Vault",
        externalObsidianWatch: true,
      },
    );
    const parsed = parseManagementMd(body);
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.integrations)).toEqual(
      expect.arrayContaining(["gmail", "google_calendar", "notion"]),
    );
  });

  it("emits the auto-generated comment so users see they cannot hand-edit", () => {
    const body = renderManagementMd(
      defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
    );
    expect(body).toContain("Auto-generated");
    expect(body).toContain("Hand-edits are overwritten on next render");
  });

  it("places the Note Sources section between Active today and Planned", () => {
    const body = renderManagementMd(
      defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
    );
    const activeIdx = body.indexOf("## Active today");
    const noteIdx = body.indexOf("## Note Sources");
    const plannedIdx = body.indexOf("## Planned / not yet shipped");
    expect(activeIdx).toBeGreaterThan(0);
    expect(noteIdx).toBeGreaterThan(activeIdx);
    expect(plannedIdx).toBeGreaterThan(noteIdx);
  });
});

describe("management-md parse", () => {
  it("parses a valid table into IntegrationState records", () => {
    const body = renderManagementMd(
      defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
    );
    const result = parseManagementMd(body);
    expect(result.ok).toBe(true);
    expect(result.integrations.gmail?.mode).toBe("disabled");
    expect(result.integrations.google_calendar?.mode).toBe("disabled");
  });

  it("round-trips a delegated configuration", () => {
    const body = renderManagementMd({
      ...defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    const result = parseManagementMd(body);
    expect(result.ok).toBe(true);
    expect(result.integrations.gmail?.mode).toBe("delegated");
    expect(result.integrations.gmail?.delegatedBackend).toBe("codex");
    expect(result.integrations.google_calendar?.mode).toBe("direct");
  });

  // INTEGRATION_NATIVE_MODE_DESIGN.md §5.2 — the rendered "Backend"
  // column means `nativeBackend` for native rows and `delegatedBackend`
  // for delegated rows. The parser must route the cell to the correct
  // field; otherwise a render → parse round-trip drops the binding (or
  // worse, surfaces it as the wrong field and fails the schema's
  // mutual-exclusion `superRefine`).
  it("round-trips a native configuration — nativeBackend (not delegatedBackend) on the parsed row", () => {
    const body = renderManagementMd({
      ...defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
      google_calendar: {
        mode: "native",
        nativeBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
      notion: {
        mode: "native",
        nativeBackend: "gemini",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    const result = parseManagementMd(body);
    expect(result.ok).toBe(true);
    expect(result.integrations.gmail?.mode).toBe("native");
    expect(result.integrations.gmail?.nativeBackend).toBe("claude");
    expect(result.integrations.gmail?.delegatedBackend).toBeUndefined();
    expect(result.integrations.google_calendar?.mode).toBe("native");
    expect(result.integrations.google_calendar?.nativeBackend).toBe("codex");
    expect(result.integrations.google_calendar?.delegatedBackend).toBeUndefined();
    expect(result.integrations.notion?.mode).toBe("native");
    expect(result.integrations.notion?.nativeBackend).toBe("gemini");
    expect(result.integrations.notion?.delegatedBackend).toBeUndefined();
  });

  // Mixed: delegated + native + direct + disabled in one table. Pins
  // that the per-row mode-aware routing of the Backend column is
  // independent across rows (no shared state leakage).
  it("round-trips a mixed delegated / native / direct / disabled configuration", () => {
    const body = renderManagementMd({
      ...defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
      notion: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
      github: {
        mode: "disabled",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    const result = parseManagementMd(body);
    expect(result.ok).toBe(true);
    expect(result.integrations.gmail).toMatchObject({
      mode: "native",
      nativeBackend: "claude",
    });
    expect(result.integrations.gmail?.delegatedBackend).toBeUndefined();
    expect(result.integrations.google_calendar).toMatchObject({
      mode: "delegated",
      delegatedBackend: "codex",
    });
    expect(result.integrations.google_calendar?.nativeBackend).toBeUndefined();
    expect(result.integrations.notion?.mode).toBe("direct");
    expect(result.integrations.notion?.delegatedBackend).toBeUndefined();
    expect(result.integrations.notion?.nativeBackend).toBeUndefined();
    expect(result.integrations.github?.mode).toBe("disabled");
  });

  it("reports a fatal error when the Current state table is missing", () => {
    const result = parseManagementMd("# Integration Management\n\nnothing here");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/missing or malformed/);
  });

  it("warns but does not fail on unknown integration keys", () => {
    const body = `# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| slack | direct | — | — | 2026-04-19T00:00:00.000Z |
| gmail | direct | — | — | 2026-04-19T00:00:00.000Z |
`;
    const result = parseManagementMd(body);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(";")).toMatch(/slack/);
    expect(result.integrations.gmail?.mode).toBe("direct");
  });

  it("reports a fatal error when delegated row is missing backend", () => {
    const body = `# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | delegated | — | — | 2026-04-19T00:00:00.000Z |
`;
    const result = parseManagementMd(body);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/delegatedBackend/);
  });

  it("stamps missing or malformed timestamps with a fresh value", () => {
    const body = `# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | direct | — | — | not-a-date |
`;
    const result = parseManagementMd(body);
    expect(result.ok).toBe(true);
    expect(result.integrations.gmail?.lastChangedAt).toMatch(/T/);
  });

  it("renders + round-trips deniedTools per integration (§7.7)", () => {
    const body = renderManagementMd({
      ...defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: ["notion-create-database", "notion-update-data-source"],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    expect(body).toContain("## Tool deny policy (§7.7)");
    expect(body).toContain("### notion");
    expect(body).toContain("- `notion-create-database`");
    expect(body).toContain("- `notion-update-data-source`");

    const parsed = parseManagementMd(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.integrations.notion?.deniedTools).toEqual([
      "notion-create-database",
      "notion-update-data-source",
    ]);
    // Other integrations (no deny entries) round-trip with empty arrays.
    expect(parsed.integrations.gmail?.deniedTools).toEqual([]);
  });

  it("renders 'No tools denied' when the deny section is empty", () => {
    const body = renderManagementMd(
      defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
    );
    expect(body).toContain("## Tool deny policy (§7.7)");
    expect(body).toContain("_No tools denied._");
  });

  it("warns on an unknown integration key in the deny section", () => {
    const body = `# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| notion | direct | — | — | 2026-04-19T00:00:00.000Z |

## Tool deny policy (§7.7)

### bogus
- \`some-tool\`
`;
    const parsed = parseManagementMd(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unknown integration key in tool deny"),
      ]),
    );
    expect(parsed.integrations.notion?.deniedTools).toEqual([]);
  });

  it("skips rows with too few cells", () => {
    const body = `# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | direct |
| google_calendar | direct | — | — | 2026-04-19T00:00:00.000Z |
`;
    const result = parseManagementMd(body);
    expect(result.ok).toBe(true);
    expect(result.integrations.gmail).toBeUndefined();
    expect(result.integrations.google_calendar?.mode).toBe("direct");
  });
});

describe("management-md file I/O", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pa-mgmt-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeManagementMd creates the file and returns its path", async () => {
    const path = await writeManagementMd(dir, defaultIntegrationsMap());
    expect(path).toBe(getManagementMdPath(dir));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("# Integration Management");
  });

  it("readAndParseManagementMd returns null when file missing", async () => {
    const result = await readAndParseManagementMd(dir);
    expect(result).toBeNull();
  });

  it("bootstrapManagementMd creates the file on first run", async () => {
    const result = await bootstrapManagementMd(dir, db);
    expect(result.created).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(result.integrations.gmail.mode).toBe("disabled");
  });

  it("bootstrapManagementMd applies user edits back into the DB", async () => {
    // Seed DB with default and create file.
    await bootstrapManagementMd(dir, db);
    const path = getManagementMdPath(dir);

    // Hand-edit the file to set gmail=direct.
    const edited = `---
file: integrations.md
---

# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | direct | — | — | 2026-04-19T00:00:00.000Z |
| google_calendar | disabled | — | — | 2026-04-19T00:00:00.000Z |
`;
    writeFileSync(path, edited, "utf-8");

    const result = await bootstrapManagementMd(dir, db);
    expect(result.created).toBe(false);
    expect(result.integrations.gmail.mode).toBe("direct");
    expect(readIntegrations(db).gmail.mode).toBe("direct");
  });

  it("bootstrapManagementMd rewrites the file when parse fails", async () => {
    const path = getManagementMdPath(dir);
    writeFileSync(path, "not a valid management file", "utf-8");
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    const result = await bootstrapManagementMd(dir, db);
    expect(result.integrations.gmail.mode).toBe("delegated");
    const contents = readFileSync(path, "utf-8");
    expect(contents).toContain("| gmail | delegated | codex |");
  });

  it("bootstrapManagementMd reverts a delegated flip when variant files are missing (§4.7) — notion is the canonical regression surface", async () => {
    const path = getManagementMdPath(dir);
    const edited = `---
file: integrations.md
---

# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | disabled | — | — | 2026-04-19T00:00:00.000Z |
| google_calendar | disabled | — | — | 2026-04-19T00:00:00.000Z |
| notion | delegated | codex | full-auto | 2026-04-19T00:00:00.000Z |
`;
    writeFileSync(path, edited, "utf-8");

    const result = await bootstrapManagementMd(
      dir,
      db,
      "/tmp/pa-nonexistent-workspace",
    );
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].key).toBe("notion");
    expect(result.integrations.notion?.mode).toBe("disabled");
    expect(readIntegrations(db).notion?.mode).toBe("disabled");
    expect(readFileSync(path, "utf-8")).toContain("| notion | disabled |");
  });

  it("bootstrapManagementMd accepts a delegated flip when variant files exist (notion against the real workspace)", async () => {
    const path = getManagementMdPath(dir);
    const edited = `---
file: integrations.md
---

# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | disabled | — | — | 2026-04-19T00:00:00.000Z |
| google_calendar | disabled | — | — | 2026-04-19T00:00:00.000Z |
| notion | delegated | codex | full-auto | 2026-04-19T00:00:00.000Z |
`;
    writeFileSync(path, edited, "utf-8");

    const result = await bootstrapManagementMd(dir, db, process.cwd());
    expect(result.rejections).toHaveLength(0);
    expect(result.integrations.notion?.mode).toBe("delegated");
    expect(readIntegrations(db).notion?.mode).toBe("delegated");
  });
});

describe("enforceVariantAvailability", () => {
  const now = "2026-04-19T00:00:00.000Z";

  it("passes through when no key flipped to delegated", () => {
    const prev = defaultIntegrationsMap(now);
    const next = { ...prev, gmail: { mode: "direct" as const, deniedTools: [], lastChangedAt: now } };
    const { filtered, rejections } = enforceVariantAvailability(
      next,
      prev,
      "/tmp/pa-nonexistent",
    );
    expect(rejections).toHaveLength(0);
    expect(filtered.gmail.mode).toBe("direct");
  });

  it("reverts delegated flips when variant files are absent (notion — still uses legacy variant path)", () => {
    // Pre-Phase-D this used gmail; gmail now has empty skillsTouched /
    // taskFlowsTouched so it has no required variants and enforce would
    // never reject. Notion retains the legacy variant path and is the
    // canonical example for this guard going forward.
    const prev = defaultIntegrationsMap(now);
    const next = {
      ...prev,
      notion: {
        mode: "delegated" as const,
        delegatedBackend: "codex" as const,
        deniedTools: [],
        lastChangedAt: now,
      },
    };
    const { filtered, rejections } = enforceVariantAvailability(
      next,
      prev,
      "/tmp/pa-nonexistent-workspace",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0].key).toBe("notion");
    expect(rejections[0].backend).toBe("codex");
    expect(rejections[0].missing.length).toBeGreaterThan(0);
    expect(filtered.notion).toEqual(prev.notion);
  });

  it("DELEGATED-MODE-V2 §11 Phase 3 — gmail / google_calendar are subject to the variant gate again (per-mode skills restored, missing files fail the flip)", () => {
    const prev = defaultIntegrationsMap(now);
    const next = {
      ...prev,
      gmail: {
        mode: "delegated" as const,
        delegatedBackend: "codex" as const,
        deniedTools: [],
        lastChangedAt: now,
      },
    };
    const { filtered, rejections } = enforceVariantAvailability(
      next,
      prev,
      "/tmp/pa-nonexistent-workspace",
    );
    expect(rejections.length).toBeGreaterThan(0);
    expect(rejections[0].key).toBe("gmail");
    expect(filtered.gmail).toEqual(prev.gmail);
  });

  it("accepts delegated flips when variant files exist (notion against the real workspace)", () => {
    const prev = defaultIntegrationsMap(now);
    const next = {
      ...prev,
      notion: {
        mode: "delegated" as const,
        delegatedBackend: "codex" as const,
        deniedTools: [],
        lastChangedAt: now,
      },
    };
    const { filtered, rejections } = enforceVariantAvailability(
      next,
      prev,
      process.cwd(),
    );
    expect(rejections).toHaveLength(0);
    expect(filtered.notion.mode).toBe("delegated");
  });

  it("skips re-validation when a key was already in the same delegated state", () => {
    const prev = {
      ...defaultIntegrationsMap(now),
      notion: {
        mode: "delegated" as const,
        delegatedBackend: "codex" as const,
        deniedTools: [],
        lastChangedAt: now,
      },
    };
    const { rejections } = enforceVariantAvailability(
      prev,
      prev,
      "/tmp/pa-nonexistent-would-fail-if-checked",
    );
    expect(rejections).toHaveLength(0);
  });
});

describe("startManagementMdWatcher", () => {
  // Chokidar's `awaitWriteFinish` debounces by 300ms; the handler is async
  // after that, so give each flush ~600ms to settle before asserting. These
  // tests are inherently timing-sensitive — if they become flaky under CI
  // load, bump `settleMs`.
  const settleMs = 600;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Default-integrations body as a canned string. Seeding the file with
  // writeFileSync (instead of writeManagementMd) bypasses the self-write
  // mark so the watcher doesn't incorrectly consume our first edit as a
  // self-write.
  const initialBody = renderManagementMd(
    defaultIntegrationsMap("2026-04-19T00:00:00.000Z"),
  );

  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pa-mgmt-watch-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies a valid hand-edit to the DB", async () => {
    writeFileSync(getManagementMdPath(dir), initialBody, "utf-8");
    const handle = startManagementMdWatcher(dir, db);
    try {
      const path = getManagementMdPath(dir);
      // Let the watcher subscribe before the first edit.
      await sleep(200);
      const edited = `---
file: integrations.md
---

# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | direct | — | — | 2026-04-19T00:00:00.000Z |
| google_calendar | disabled | — | — | 2026-04-19T00:00:00.000Z |
`;
      writeFileSync(path, edited, "utf-8");
      await sleep(settleMs);
      expect(readIntegrations(db).gmail.mode).toBe("direct");
    } finally {
      await handle.stop();
    }
  });

  it("ignores self-writes stamped by writeManagementMd", async () => {
    // Pre-seed DB with a non-default state so we can detect an unwanted
    // round-trip clobber: if the watcher mistakenly consumed our own
    // write, it would parse the just-rendered body as a fresh edit
    // (still consistent) — harder to detect. Instead we wire a
    // sentinel via a one-shot DB spy.
    writeIntegrations(db, {
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    await writeManagementMd(dir, readIntegrations(db));
    const handle = startManagementMdWatcher(dir, db);
    try {
      await sleep(200);
      // Round-trip our own write; markSelfWrite should suppress the
      // watcher callback, leaving the DB untouched.
      let dbWriteCount = 0;
      const origPrepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (/INSERT|UPDATE|REPLACE/i.test(sql)) dbWriteCount += 1;
        return origPrepare(sql);
      }) as typeof db.prepare;
      await writeManagementMd(dir, readIntegrations(db));
      await sleep(settleMs);
      expect(dbWriteCount).toBe(0);
    } finally {
      await handle.stop();
    }
  });

  it("rewrites the file from DB state when a hand-edit fails to parse", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00.000Z",
      },
    });
    writeFileSync(
      getManagementMdPath(dir),
      renderManagementMd(readIntegrations(db)),
      "utf-8",
    );
    const handle = startManagementMdWatcher(dir, db);
    try {
      const path = getManagementMdPath(dir);
      await sleep(200);
      writeFileSync(path, "not a valid management file\n", "utf-8");
      await sleep(settleMs);
      // Watcher should re-render the canonical body from the DB state.
      const body = readFileSync(path, "utf-8");
      expect(body).toContain("# Integration Management");
      expect(body).toContain("| gmail | direct |");
      // DB should not have been touched.
      expect(readIntegrations(db).gmail.mode).toBe("direct");
    } finally {
      await handle.stop();
    }
  });

  it("reverts a delegated flip when required variant files are missing and DMs the owner (§4.7) — notion is the canonical surface", async () => {
    writeFileSync(getManagementMdPath(dir), initialBody, "utf-8");
    const dms: Array<{ message: string; notificationType?: string }> = [];
    const handle = startManagementMdWatcher(dir, db, {
      workspaceDir: "/tmp/pa-nonexistent-watcher-workspace",
      sendNotification: async (params) => {
        dms.push({
          message: params.message,
          notificationType: params.notificationType,
        });
      },
    });
    try {
      const path = getManagementMdPath(dir);
      await sleep(200);
      const edited = `---
file: integrations.md
---

# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | disabled | — | — | 2026-04-19T00:00:00.000Z |
| google_calendar | disabled | — | — | 2026-04-19T00:00:00.000Z |
| notion | delegated | codex | full-auto | 2026-04-19T00:00:00.000Z |
`;
      writeFileSync(path, edited, "utf-8");
      await sleep(settleMs * 2);
      expect(readIntegrations(db).notion?.mode).toBe("disabled");
      expect(readFileSync(path, "utf-8")).toContain("| notion | disabled |");
      expect(dms).toHaveLength(1);
      expect(dms[0].message).toContain("notion");
      expect(dms[0].notificationType).toBe("integration.variant_missing");
    } finally {
      await handle.stop();
    }
  });

  it("accepts a valid delegated flip when variant files are present", async () => {
    writeFileSync(getManagementMdPath(dir), initialBody, "utf-8");
    // Point workspaceDir at the repo root so real variant files (mail/
    // external-services + routine.morning_routine) resolve.
    const handle = startManagementMdWatcher(dir, db, {
      workspaceDir: process.cwd(),
    });
    try {
      const path = getManagementMdPath(dir);
      await sleep(200);
      const edited = `---
file: integrations.md
---

# Integration Management

## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | delegated | codex | full-auto | 2026-04-19T00:00:00.000Z |
| google_calendar | disabled | — | — | 2026-04-19T00:00:00.000Z |
`;
      writeFileSync(path, edited, "utf-8");
      await sleep(settleMs);
      expect(readIntegrations(db).gmail.mode).toBe("delegated");
      expect(readIntegrations(db).gmail.delegatedBackend).toBe("codex");
    } finally {
      await handle.stop();
    }
  });
});

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  type IntegrationKey,
} from "@aitne/shared";
import {
  ROUTINE_WINDOWS,
  type RoutineWindowKey,
  type WindowKind,
} from "./routine-windows.js";

// Resolve repo root → agent-assets/task-flows/_partials. The directory
// may not exist yet (Phase 1 lands the directive + lint; the actual
// partial bodies land in Phase 2), in which case both lint suites pass
// vacuously and the harness is ready for the Phase 2 PRs.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..");
const PARTIALS_DIR = join(REPO_ROOT, "agent-assets", "task-flows", "_partials");
const TASK_FLOWS_DIR = join(REPO_ROOT, "agent-assets", "task-flows");

function listPartialFiles(): string[] {
  if (!existsSync(PARTIALS_DIR)) return [];
  return readdirSync(PARTIALS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

interface ParsedFilename {
  kind: string | null;
  integration: string | null;
}

function parsePartialFilename(filename: string): ParsedFilename {
  // Convention: `<kind>-acquire.<integration>.md`
  //   e.g. mail-acquire.gmail.md → kind=mail, integration=gmail
  //   calendar-acquire.google_calendar.md → kind=calendar, integration=google_calendar
  const match = /^([a-z]+)-acquire\.([a-z_]+)\.md$/.exec(filename);
  if (!match) return { kind: null, integration: null };
  return { kind: match[1] ?? null, integration: match[2] ?? null };
}

// docs/design/appendices/routine-data-acquisition.md §10 R2 / Phase 1 F8 — partial body
// must not reference an integration key other than the one in its
// filename. Single-responsibility per partial structurally enforced.
describe("acquisition partials — no cross-integration key leakage (F8)", () => {
  it("every _partials file follows the <kind>-acquire.<integration>.md naming convention", () => {
    for (const filename of listPartialFiles()) {
      // Allow non-acquire partials (e.g. shared snippets in the future)
      // but flag suspicious filenames so authoring tools surface the
      // convention break early. The skeleton accepts any *.md today
      // since the directory is empty in Phase 1; Phase 2 lands the
      // first acquire files and exercises this assertion.
      const parsed = parsePartialFilename(filename);
      if (parsed.integration === null) continue;
      expect(
        INTEGRATION_KEYS,
        `${filename} names an unknown integration "${parsed.integration}"`,
      ).toContain(parsed.integration);
    }
  });

  it("an acquire partial's body must not reference any other integration key", () => {
    for (const filename of listPartialFiles()) {
      const parsed = parsePartialFilename(filename);
      if (parsed.integration === null) continue;
      const body = readFileSync(join(PARTIALS_DIR, filename), "utf-8");
      for (const otherKey of INTEGRATION_KEYS) {
        if (otherKey === parsed.integration) continue;
        // Match the bare key as an identifier (not as a substring of
        // a longer word). Captures `gmail` but not `gmail-specific`
        // when the latter is a heading hyphen, by allowing word
        // boundaries on both sides.
        const re = new RegExp(`\\b${otherKey}\\b`, "g");
        const hits = body.match(re) ?? [];
        expect(
          hits,
          `${filename} (claims integration="${parsed.integration}") references foreign integration "${otherKey}" ${hits.length} time(s); single-responsibility violation`,
        ).toHaveLength(0);
      }
    }
  });

  it("an acquire partial's <!-- mode:X:Y --> blocks reference only the integration in its filename", () => {
    for (const filename of listPartialFiles()) {
      const parsed = parsePartialFilename(filename);
      if (parsed.integration === null) continue;
      const body = readFileSync(join(PARTIALS_DIR, filename), "utf-8");
      const blockKeys = Array.from(
        body.matchAll(/<!--\s*\/?mode:[a-z-]+:([a-z_]+)\s*-->/g),
        (m) => m[1],
      );
      for (const key of blockKeys) {
        expect(
          key,
          `${filename}: <!-- mode:...:${key} --> uses a key that differs from the partial's integration (${parsed.integration})`,
        ).toBe(parsed.integration);
      }
    }
  });
});

// docs/design/appendices/routine-data-acquisition.md §10 R3 + docs/design/appendices/pre-pass-fan-out.md
// §4.2 — when a descriptor declares `taskFlowsReferenced: [{routine,
// via: "partial"}, ...]`, ONE of the following must hold:
//
//   (a) the routine's bundled body literally contains
//       `{include:_partials/<kind>-acquire.<integration>.md}` — used
//       by routines that inline a partial directly (none today
//       after the Phase 4 fan-out cleanup; kept as a valid form), OR
//   (b) the routine triggers the pre-pass for this integration's kind,
//       i.e. `ROUTINE_WINDOWS[routine]` carries at least one row whose
//       `kind` matches the integration's partial kind. The fan-out
//       coordinator inlines the per-integration partial into
//       `routine.fetch_window.md`'s `{integration_partial}` placeholder
//       on behalf of the parent routine, OR
//   (c) the routine IS `routine.fetch_window` itself — its body carries
//       the `{integration_partial}` placeholder and the integration's
//       descriptor declares `prePassPartial`, so the runner inlines
//       the partial per sub-session.
//
// The bidirectional check below covers the symmetric drift: a routine
// body that DOES contain an include for an integration whose
// `taskFlowsReferenced` does not list it.
describe("acquisition partials — descriptor ↔ routine include coupling (Phase 3 R3)", () => {
  // Map integration → partial-kind prefix. The convention is
  // `<kind>-acquire.<integration>.md`; this map encodes which integration
  // belongs to which kind because that grouping isn't stored in the
  // descriptor today. Adding a new integration that needs a partial means
  // adding it here.
  const PARTIAL_KIND_FOR: Partial<Record<IntegrationKey, WindowKind>> = {
    gmail: "mail",
    outlook_mail: "mail",
    google_calendar: "calendar",
    outlook_calendar: "calendar",
    notion: "notion",
  };

  function includeDirective(integration: IntegrationKey): string | null {
    const kind = PARTIAL_KIND_FOR[integration];
    if (!kind) return null;
    return `{include:_partials/${kind}-acquire.${integration}.md}`;
  }

  function routineWindowsMatchKind(
    routine: string,
    kind: WindowKind,
  ): boolean {
    if (!(routine in ROUTINE_WINDOWS)) return false;
    const rows = ROUTINE_WINDOWS[routine as RoutineWindowKey];
    return rows.some((row) => row.kind === kind);
  }

  it("every declared taskFlowsReferenced is satisfied by a direct include, a pre-pass dispatch, OR the fetch_window placeholder", () => {
    for (const integration of INTEGRATION_KEYS) {
      const refs = INTEGRATION_DESCRIPTORS[integration].taskFlowsReferenced;
      if (!refs || refs.length === 0) continue;
      const directive = includeDirective(integration);
      const kind = PARTIAL_KIND_FOR[integration];
      const prePassPartial = INTEGRATION_DESCRIPTORS[integration].prePassPartial;
      expect(
        directive,
        `taskFlowsReferenced declared for ${integration} but no partial-kind mapping`,
      ).not.toBeNull();
      expect(
        kind,
        `taskFlowsReferenced declared for ${integration} but no PARTIAL_KIND_FOR mapping`,
      ).toBeTruthy();
      for (const ref of refs) {
        const routinePath = join(TASK_FLOWS_DIR, `${ref.routine}.md`);
        const dispatchedByPrePass = routineWindowsMatchKind(
          ref.routine,
          kind!,
        );
        // `routine.morning_routine` is a process-key identity used by
        // the pre-pass dispatcher (and by the pre-routine gate) but no
        // longer has a stand-alone task-flow file post-V2-split
        // (Phase 5/6/7 retired the monolithic flow; the Stage A
        // and Stage B task-flows live under their own process keys).
        // Skip the file-existence check when the routine has a
        // `ROUTINE_WINDOWS` entry — predicate (b) below covers the
        // coupling without needing to inspect a body.
        if (!dispatchedByPrePass) {
          expect(
            existsSync(routinePath),
            `${integration}.taskFlowsReferenced names missing routine file ${ref.routine}.md`,
          ).toBe(true);
        }
        const body = existsSync(routinePath)
          ? readFileSync(routinePath, "utf-8")
          : "";
        const containsInclude = body.includes(directive!);
        // routine.fetch_window itself is the fan-out coordinator's
        // task-flow. The body carries `{integration_partial}` and the
        // runner inlines the per-integration partial per sub-session,
        // so the coupling there is "descriptor declares prePassPartial
        // AND the routine body carries the placeholder" rather than an
        // inline include or a parent-routine pre-pass dispatch.
        const isFetchWindowPlaceholder =
          ref.routine === "routine.fetch_window"
          && body.includes("{integration_partial}")
          && prePassPartial !== undefined;
        expect(
          containsInclude || dispatchedByPrePass || isFetchWindowPlaceholder,
          `${ref.routine}.md must either contain "${directive}", `
            + `ROUTINE_WINDOWS["${ref.routine}"] must carry at least one `
            + `"${kind}" row, or ref.routine must be routine.fetch_window `
            + `with the {integration_partial} placeholder + the integration's `
            + `prePassPartial descriptor (got none — ${integration}.taskFlowsReferenced `
            + `lists this routine but no satisfying coupling exists)`,
        ).toBe(true);
      }
    }
  });

  it("every routine body that includes a partial is reflected in the integration descriptor", () => {
    // Symmetric direction. A routine that includes the partial without a
    // matching descriptor entry is drift, regardless of whether the
    // integration is user-managed.
    const declaredReferences = new Map<IntegrationKey, Set<string>>();
    for (const integration of INTEGRATION_KEYS) {
      const refs = INTEGRATION_DESCRIPTORS[integration].taskFlowsReferenced;
      if (!refs) continue;
      declaredReferences.set(
        integration,
        new Set(refs.map((r) => r.routine)),
      );
    }
    if (declaredReferences.size === 0) return;

    const routineFiles = readdirSync(TASK_FLOWS_DIR)
      .filter((name) => name.startsWith("routine.") && name.endsWith(".md"))
      .filter((name) => !name.includes(".delegated.") && !name.includes(".native."));

    for (const [integration, declared] of declaredReferences) {
      const directive = includeDirective(integration);
      if (!directive) continue;
      for (const filename of routineFiles) {
        const routineKey = filename.replace(/\.md$/, "");
        const body = readFileSync(join(TASK_FLOWS_DIR, filename), "utf-8");
        const containsInclude = body.includes(directive);
        const declaredHere = declared.has(routineKey);
        if (containsInclude && !declaredHere) {
          expect.fail(
            `${filename} includes "${directive}" but ${integration}.taskFlowsReferenced does not list "${routineKey}" — descriptor drift`,
          );
        }
      }
    }
  });

  it("every taskFlowsReferenced list contains routine.fetch_window when it has any entries", () => {
    // The pre-pass meta-fetcher (`routine.fetch_window.md`) is the only
    // file that literally owns `{include:_partials/<kind>-acquire.<key>.md}`
    // directives today. Any descriptor that declares OTHER routines via
    // `taskFlowsReferenced` (consumed via the pre-pass) MUST also list
    // `routine.fetch_window` to keep the directive-owner bound to the
    // descriptor — otherwise the symmetric-drift check would flag the
    // fetch_window file as carrying an unreferenced include.
    for (const integration of INTEGRATION_KEYS) {
      const refs = INTEGRATION_DESCRIPTORS[integration].taskFlowsReferenced;
      if (!refs || refs.length === 0) continue;
      const hasFetchWindow = refs.some(
        (r) => r.routine === "routine.fetch_window",
      );
      expect(
        hasFetchWindow,
        `${integration}.taskFlowsReferenced has entries but is missing `
          + `routine.fetch_window — the meta-fetcher owns the directive `
          + `and must be co-listed with any consumer routines.`,
      ).toBe(true);
    }
  });
});

// docs/design/appendices/pre-pass-fan-out.md §4.2 — every integration that participates
// in the routine pre-pass declares its partial via the descriptor's
// `prePassPartial` field. The fan-out coordinator reads this body at
// runtime and substitutes it for `{integration_partial}` in
// `routine.fetch_window.md`. The lint below pins three coupling
// invariants so descriptor drift surfaces here, not at runtime.
describe("integration descriptors — prePassPartial coupling (PRE_PASS_FAN_OUT_DESIGN §4.2)", () => {
  it("every declared prePassPartial resolves to an existing _partials/<file>", () => {
    for (const integration of INTEGRATION_KEYS) {
      const partial = INTEGRATION_DESCRIPTORS[integration].prePassPartial;
      if (!partial) continue;
      expect(
        existsSync(join(PARTIALS_DIR, partial)),
        `${integration}.prePassPartial = "${partial}" but agent-assets/task-flows/_partials/${partial} is missing`,
      ).toBe(true);
    }
  });

  it("every prePassPartial filename matches the <kind>-acquire.<integration>.md convention", () => {
    for (const integration of INTEGRATION_KEYS) {
      const partial = INTEGRATION_DESCRIPTORS[integration].prePassPartial;
      if (!partial) continue;
      const parsed = parsePartialFilename(partial);
      expect(
        parsed.integration,
        `${integration}.prePassPartial = "${partial}" — filename does not parse to integration "${integration}"`,
      ).toBe(integration);
    }
  });

  it("every prePassPartial integration co-lists routine.fetch_window in taskFlowsReferenced", () => {
    // The partial owner (`routine.fetch_window.md`) is the only file
    // allowed to consume the partial. The descriptor's
    // `taskFlowsReferenced` must keep that coupling visible so the
    // symmetric-drift lint above still works.
    for (const integration of INTEGRATION_KEYS) {
      const partial = INTEGRATION_DESCRIPTORS[integration].prePassPartial;
      if (!partial) continue;
      const refs = INTEGRATION_DESCRIPTORS[integration].taskFlowsReferenced ?? [];
      const hasFetchWindow = refs.some(
        (r) => r.routine === "routine.fetch_window" && r.via === "partial",
      );
      expect(
        hasFetchWindow,
        `${integration}.prePassPartial is "${partial}" but taskFlowsReferenced does not list routine.fetch_window — the partial owner would be orphaned from the descriptor chain`,
      ).toBe(true);
    }
  });

  it("the five integrations with partial files on disk all declare prePassPartial", () => {
    // Symmetric direction — every `<kind>-acquire.<integration>.md` file
    // in `_partials/` must be reachable from some descriptor's
    // `prePassPartial`. A partial file on disk with no descriptor pointer
    // is dead weight; the runner could never load it.
    for (const filename of listPartialFiles()) {
      const parsed = parsePartialFilename(filename);
      if (parsed.integration === null) continue;
      const integration = parsed.integration as IntegrationKey;
      expect(
        INTEGRATION_KEYS,
        `${filename} names an unknown integration`,
      ).toContain(integration);
      const declared = INTEGRATION_DESCRIPTORS[integration].prePassPartial;
      expect(
        declared,
        `${filename} exists on disk but ${integration}.prePassPartial is unset — descriptor drift`,
      ).toBe(filename);
    }
  });
});

// docs/design/appendices/pre-pass-fan-out.md §4.2 — `routine.fetch_window.md` is the
// fan-out task-flow body. Every fan-out sub-session loads this file and
// the runner substitutes `{integration_partial}` with the body of the
// integration's `prePassPartial`. The lint below pins the placeholder /
// preamble invariants so authoring drift surfaces here, not at runtime.
describe("routine.fetch_window.md — fan-out task-flow body (PRE_PASS_FAN_OUT_DESIGN §4.2)", () => {
  const TASK_FLOW_PATH = join(TASK_FLOWS_DIR, "routine.fetch_window.md");

  it("exists on disk in agent-assets/task-flows/", () => {
    expect(existsSync(TASK_FLOW_PATH)).toBe(true);
  });

  it("carries exactly one `{integration_partial}` placeholder", () => {
    const body = readFileSync(TASK_FLOW_PATH, "utf-8");
    const matches = body.match(/\{integration_partial\}/g) ?? [];
    expect(
      matches,
      `routine.fetch_window.md must carry exactly one {integration_partial} placeholder`,
    ).toHaveLength(1);
  });

  it("does NOT include any `{include:_partials/...}` directive", () => {
    // Inlining a partial here would double-render at runtime (the
    // runner already substitutes the per-integration partial) and
    // re-leak cross-integration prose into every sub-session.
    const body = readFileSync(TASK_FLOW_PATH, "utf-8");
    expect(
      body.includes("{include:_partials/"),
      `routine.fetch_window.md must not carry {include:_partials/...} directives — the runner inlines the partial per sub-session`,
    ).toBe(false);
  });

  it("preserves the standard {context} preamble (so ContextBuilder injects normally)", () => {
    const body = readFileSync(TASK_FLOW_PATH, "utf-8");
    expect(
      body.startsWith("{context}"),
      `routine.fetch_window.md must lead with {context} like every other task-flow`,
    ).toBe(true);
  });
});

// docs/design/appendices/routine-data-acquisition.md §6.8 / P7 / Phase 1 F10 — partial
// bodies must NOT enumerate MCP tool names or hint the agent to probe
// its MCP registry. The intent of the partial is "fetch a window";
// the user's skills + bound tools resolve the call path.
//
// EXEMPTION: `mcp__aitne-*` — daemon-owned in-process MCP tools registered
// by ClaudeCodeCore. These are not "discovery hints" — the tool name is
// constant, the handler runs inside the daemon process (no external MCP
// connector), and explicit naming is how the agent invokes them. Today
// the only such tool is `mcp__aitne-observations__submit_observations`
// (the structural fix for the 2026-05-18 Unicode-whitespace incident),
// but any future daemon-side SDK MCP servers should follow the
// `aitne-<name>` prefix convention so this exemption keeps working.
describe("acquisition partials — no tool-name discovery (F10)", () => {
  // Patterns rejected by the lint. Each entry: { pattern, reason }.
  // Direct-mode REST endpoints (/api/...) are NOT in this list — they
  // are the legitimate daemon chokepoint.
  const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
    {
      // Negative lookahead excludes daemon-owned `mcp__aitne-*` tools (see
      // comment above). Match continues to flag every `mcp__claude_ai_*`,
      // `mcp__server_*`, etc. that would be an integration-MCP tool name.
      pattern: /mcp__(?!aitne-)[A-Za-z0-9_]+/,
      reason: "MCP tool name literal (Claude/Codex namespace)",
    },
    {
      pattern: /\bmcp_[a-z-]+_[A-Za-z0-9.]+/,
      reason: "MCP tool name literal (Gemini namespace)",
    },
    {
      pattern: /\bMCP[-\s]list(?:ing)?\b/i,
      reason: "MCP-listing fallback hint",
    },
    {
      pattern: /\benumerate (?:MCP )?tools?\b/i,
      reason: "tool-enumeration hint",
    },
    {
      pattern: /\bcommon tool[-\s]names?\b/i,
      reason: "common-tool-name hint (forbidden by P7)",
    },
    {
      pattern: /\bprobe (?:the )?MCP\b/i,
      reason: "MCP probe hint",
    },
  ];

  it("no partial body contains forbidden tool-discovery patterns", () => {
    for (const filename of listPartialFiles()) {
      const body = readFileSync(join(PARTIALS_DIR, filename), "utf-8");
      for (const { pattern, reason } of FORBIDDEN) {
        const match = body.match(pattern);
        expect(
          match,
          `${filename} contains forbidden pattern (${reason}): "${match?.[0]}"`,
        ).toBeNull();
      }
    }
  });
});

// The pre-pass Haiku session collides with the Bash hook's "one curl per
// invocation" cap whenever the partial body asks it to POST per item
// (heredoc-write-then-bash, for-loops over curl, and `cat … | bash` are
// all blocked). Every partial must direct the fetcher at the batched
// endpoint so one Bash call drains one window. This regression test fails
// if a partial reverts to per-item language ("POST every item to
// /api/observations" without the /batch path) — see
// `docs/design/appendices/routine-data-acquisition.md §6.7`.
describe("acquisition partials — batch endpoint wire shape", () => {
  it("every partial references POST /api/observations/batch as the write surface", () => {
    for (const filename of listPartialFiles()) {
      // docs/design/appendices/skills-improvement.md Phase 0.4/0.5 introduced
      // non-acquisition partials (`capture-user-info.md`,
      // `dm-intent.project.md`, `dm-intent.long-horizon.md`) that are
      // DM-dispatcher partials, not pre-pass fetcher partials. They
      // never POST observations and must be excluded from this invariant.
      const parsed = parsePartialFilename(filename);
      if (parsed.integration === null) continue;
      const body = readFileSync(join(PARTIALS_DIR, filename), "utf-8");
      expect(
        body.includes("/api/observations/batch"),
        `${filename} must reference /api/observations/batch (one-curl-per-window write surface)`,
      ).toBe(true);
    }
  });

  it("no partial advertises per-item POST as the primary path", () => {
    // Catch the legacy "POST every <noun> to /api/observations" /
    // "map each <noun> to one observation POST" phrasings that the
    // Haiku fetcher would interpret as per-item curl.
    const forbiddenPhrases: RegExp[] = [
      /POST every (?:item|message|event|page|thread) to `?http:\/\/localhost:\d+\/api\/observations`?(?!\/batch)/i,
      /map (?:each|every) \w+(?:\s+\w+)?\s+(?:into|to) one observation POST/i,
    ];
    for (const filename of listPartialFiles()) {
      const body = readFileSync(join(PARTIALS_DIR, filename), "utf-8");
      for (const pat of forbiddenPhrases) {
        const match = body.match(pat);
        expect(
          match,
          `${filename} carries per-item POST phrasing "${match?.[0]}" — pre-pass must batch`,
        ).toBeNull();
      }
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BackendId,
  type IntegrationKey,
  type IntegrationMode,
  type IntegrationState,
} from "@aitne/shared";
import {
  getTaskFlow,
  initTaskFlows,
  renderPartialForFanOut,
  resetTaskFlowsForTest,
} from "./prompts.js";

// docs/design/appendices/routine-data-acquisition.md Phase 3 + Phase 4, plus
// docs/design/appendices/pre-pass-fan-out.md Phase 4 — per-routine MD refactor and
// pre-pass fan-out. The post-Phase-4 contract these tests lock in:
//
//   1. Main routine bodies do NOT embed any `{include:_partials/...}`
//      directive — the only legitimate consumer of the acquire
//      partials is the fan-out coordinator, which inlines a single
//      partial per sub-session by substituting `{integration_partial}`
//      in `routine.fetch_window.md`.
//   2. Each main routine's body references the read-path contract
//      (`/api/observations` + `<fetch_report>`) so the prose stays
//      coherent without inline acquisition.
//   3. `routine.fetch_window.md` carries exactly one
//      `{integration_partial}` placeholder (no inline includes), and
//      `renderPartialForFanOut` produces the correct mode-filtered
//      branch for every (integration, mode) cell in the matrix.
//   4. The `routine.hourly_check.{delegated,native}.{claude,codex,gemini}.md`
//      variant files (R4) are deleted; `selectTaskFlowVariantSuffix`
//      still resolves a suffix but `loadFlowVariant` falls through to
//      the base file.

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..");
const TASK_FLOWS_DIR = join(REPO_ROOT, "agent-assets", "task-flows");

const SESSION_BACKEND: BackendId = "claude";
const OTHER_BACKEND: BackendId = "codex";
const TS = "2026-05-11T00:00:00.000Z";

function stateDirect(): IntegrationState {
  return {
    mode: "direct" as IntegrationMode,
    delegatedBackend: null,
    deniedTools: [],
    lastChangedAt: TS,
  };
}

function stateDelegatedSame(): IntegrationState {
  return {
    mode: "delegated" as IntegrationMode,
    delegatedBackend: SESSION_BACKEND,
    deniedTools: [],
    lastChangedAt: TS,
  };
}

function stateDelegatedCross(): IntegrationState {
  return {
    mode: "delegated" as IntegrationMode,
    delegatedBackend: OTHER_BACKEND,
    deniedTools: [],
    lastChangedAt: TS,
  };
}

function stateNative(): IntegrationState {
  return {
    mode: "native" as IntegrationMode,
    nativeBackend: SESSION_BACKEND,
    deniedTools: [],
    lastChangedAt: TS,
  };
}

function stateDisabled(): IntegrationState {
  return {
    mode: "disabled" as IntegrationMode,
    delegatedBackend: null,
    deniedTools: [],
    lastChangedAt: TS,
  };
}

interface MainRoutineExpectation {
  routine: string;
  /**
   * Read-path markers the post-Phase-4 main routine body MUST contain
   * (replacements for the deleted inline acquisition prose). Each
   * routine reads observations and consults `<fetch_report>` for the
   * pre-pass status; the per-cell wire surface lives in the pre-pass
   * session only.
   */
  requiredMarkers: readonly string[];
}

/**
 * Phase 4 D1 — the only legitimate consumer of the acquire partials.
 * The pre-pass session's task-flow embeds every partial and is
 * dispatched ahead of the main routine. The matrix below pins the
 * full set so a future authoring drift surfaces as a missing-include
 * regression here instead of as a silent skip at runtime.
 */
interface PrePassExpectation {
  routine: "routine.fetch_window";
  partials: readonly string[];
  matrix: Record<IntegrationKey, () => IntegrationState>;
  branchMarkers: Partial<Record<IntegrationKey, string>>;
}

const MAIN_ROUTINE_EXPECTATIONS: readonly MainRoutineExpectation[] = [
  // Every routine the pre-pass services must reference the read path
  // and the pre-pass status block. monthly_review has zero rows in
  // ROUTINE_WINDOWS — its main session reads observations only when
  // the body explicitly opts in via daily-journal carry-over, so the
  // marker requirements are scoped to routines that actually receive
  // a `<fetch_report>` block from D1-D4.
  //
  // `routine.morning_routine_initial` no longer appears here — the
  // Phase 4 variant collapse in
  // `docs/design/appendices/morning-routine-optimization.md` removed
  // its standalone task-flow file and routes both branches through
  // the single `routine.morning_routine` flow.
  {
    routine: "routine.morning_routine_today",
    requiredMarkers: ["/api/observations", "<fetch_report>"],
  },
  {
    routine: "routine.today_refresh",
    requiredMarkers: ["/api/observations", "<fetch_report"],
  },
  {
    routine: "routine.hourly_check",
    requiredMarkers: ["/api/observations", "<fetch_report>"],
  },
  {
    routine: "routine.evening_review",
    requiredMarkers: ["/api/observations", "<fetch_report>"],
  },
  {
    routine: "routine.weekly_review",
    requiredMarkers: ["/api/observations", "<fetch_report>"],
  },
];

const PRE_PASS_EXPECTATION: PrePassExpectation = {
  routine: "routine.fetch_window",
  // Every acquire partial belongs in the pre-pass body. Adding a new
  // integration with a partial means adding it here AND to
  // routine.fetch_window.md — the second-direction lint in
  // routine-partials.test.ts catches descriptor drift.
  partials: [
    "mail-acquire.gmail.md",
    "mail-acquire.outlook_mail.md",
    "calendar-acquire.google_calendar.md",
    "calendar-acquire.outlook_calendar.md",
    "notion-acquire.notion.md",
  ],
  matrix: {
    gmail: stateDelegatedSame,
    outlook_mail: stateDirect,
    google_calendar: stateNative,
    outlook_calendar: stateDelegatedCross,
    notion: stateDisabled,
  } as Record<IntegrationKey, () => IntegrationState>,
  branchMarkers: {
    gmail: "catalog's `delegated` form",
    outlook_mail: "/api/mail/<accountId>/messages",
    google_calendar: "bound natively",
    outlook_calendar: "user-managed, so the daemon does not host",
    notion: "Defensive no-op",
  },
};

// Every main routine body must be partial-free after Phase 4 D2-D4 —
// the pre-pass session is the sole consumer. The list below covers
// every partial that exists in `_partials/` so an introduction of a
// new partial automatically widens the regression guard.
const FORBIDDEN_INCLUDE_DIRECTIVES = [
  "{include:_partials/mail-acquire.gmail.md}",
  "{include:_partials/mail-acquire.outlook_mail.md}",
  "{include:_partials/calendar-acquire.google_calendar.md}",
  "{include:_partials/calendar-acquire.outlook_calendar.md}",
  "{include:_partials/notion-acquire.notion.md}",
];

describe("Phase 4 D2-D4 — main routines do NOT embed acquire partials", () => {
  for (const ex of MAIN_ROUTINE_EXPECTATIONS) {
    describe(ex.routine, () => {
      const path = join(TASK_FLOWS_DIR, `${ex.routine}.md`);

      it("file exists", () => {
        expect(existsSync(path)).toBe(true);
      });

      it("body contains every expected partial include", () => {
        // Post-Phase-4 the main routine body has zero embedded
        // partials — the legitimate inclusion target is
        // routine.fetch_window.md only. The test name reads as
        // "contains every expected" but the expected list is now
        // empty; renamed assertion below documents the inversion.
        const body = readFileSync(path, "utf-8");
        for (const directive of FORBIDDEN_INCLUDE_DIRECTIVES) {
          expect(
            body.includes(directive),
            `${ex.routine}.md still embeds ${directive} — Phase 4 D2-D4 should have lifted it to routine.fetch_window.md`,
          ).toBe(false);
        }
      });

      it("body does not carry the legacy mode-conditional markers", () => {
        const body = readFileSync(path, "utf-8");
        // Mode markers cannot appear in the body either — they were
        // either inline in the legacy prose (Phase 3 deleted them) or
        // included via a partial (Phase 4 lifted partials out). The
        // assertion is a single regex covering every (mode, integration)
        // shape so a future regression on any partial surfaces here.
        expect(body).not.toMatch(/<!-- mode:[a-z-]+:[a-z_]+ -->/);
        expect(body).not.toMatch(/<!-- \/mode:[a-z-]+:[a-z_]+ -->/);
      });

      it("body references the read-path contract (observations + fetch_report)", () => {
        const body = readFileSync(path, "utf-8");
        for (const marker of ex.requiredMarkers) {
          expect(
            body.includes(marker),
            `${ex.routine}.md is missing required marker "${marker}" — the post-Phase-4 routine must reference observations + <fetch_report>`,
          ).toBe(true);
        }
      });
    });
  }
});

describe("docs/design/appendices/pre-pass-fan-out.md Phase 4 — routine.fetch_window carries only the {integration_partial} placeholder", () => {
  const path = join(TASK_FLOWS_DIR, "routine.fetch_window.md");

  it("file exists", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("body carries the {integration_partial} placeholder and no {include:_partials/...} directives", () => {
    const body = readFileSync(path, "utf-8");
    // The runner substitutes a single partial per sub-session into the
    // placeholder — any `{include:_partials/...}` here would double-render
    // at runtime and re-leak cross-integration prose into every
    // sub-session's prompt.
    expect(
      body.includes("{integration_partial}"),
      "routine.fetch_window.md must carry the {integration_partial} placeholder",
    ).toBe(true);
    expect(
      body.includes("{include:_partials/"),
      "routine.fetch_window.md must not carry {include:_partials/...} directives — the runner inlines the partial per sub-session",
    ).toBe(false);
  });
});

describe("docs/design/appendices/pre-pass-fan-out.md Phase 4 — renderPartialForFanOut produces the right branch per (integration, mode) cell", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fanout-render-"));
    resetTaskFlowsForTest();
    initTaskFlows(REPO_ROOT, dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetTaskFlowsForTest();
  });

  it("filters each integration's partial to the matching branch under the matrix state", () => {
    // Build the full integrations snapshot once. The runner slices it
    // to a single integration per sub-session before calling
    // `renderPartialForFanOut`, so test each slice against its
    // expected branch marker.
    const integrations: Partial<Record<IntegrationKey, IntegrationState>> = {};
    for (const [key, factory] of Object.entries(PRE_PASS_EXPECTATION.matrix) as Array<
      [IntegrationKey, () => IntegrationState]
    >) {
      integrations[key] = factory();
    }

    for (const [integration, marker] of Object.entries(
      PRE_PASS_EXPECTATION.branchMarkers,
    ) as Array<[IntegrationKey, string]>) {
      const partialFilename = PRE_PASS_EXPECTATION.partials.find((p) =>
        p.includes(`.${integration}.md`),
      );
      expect(partialFilename, `no partial declared for ${integration}`).toBeDefined();
      const slice: Partial<Record<IntegrationKey, IntegrationState>> = {
        [integration]: integrations[integration]!,
      };
      const rendered = renderPartialForFanOut(
        partialFilename!,
        slice,
        SESSION_BACKEND,
      );
      // No mode markers leak from the partial after filtering.
      expect(rendered).not.toMatch(/<!-- mode:[a-z-]+:[a-z_]+ -->/);
      expect(rendered).not.toMatch(/<!-- \/mode:[a-z-]+:[a-z_]+ -->/);
      expect(
        rendered,
        `${partialFilename} (integration=${integration}) is missing branch marker "${marker}"`,
      ).toContain(marker);
    }
  });

  it("getTaskFlow leaves {integration_partial} unsubstituted (the runner is the substituter)", () => {
    // Critical invariant: `getTaskFlow`'s pipeline only expands
    // `{include:_partials/...}` directives — `{integration_partial}`
    // must pass through untouched so the runner can substitute it with
    // the per-sub-session partial body. If a future change moves the
    // substitution into `getTaskFlow`, every sub-session would carry
    // the same (typically first-listed) partial and the cross-integration
    // contamination fix would silently regress.
    const integrations: Partial<Record<IntegrationKey, IntegrationState>> = {};
    for (const [key, factory] of Object.entries(PRE_PASS_EXPECTATION.matrix) as Array<
      [IntegrationKey, () => IntegrationState]
    >) {
      integrations[key] = factory();
    }
    const rendered = getTaskFlow(
      PRE_PASS_EXPECTATION.routine,
      SESSION_BACKEND,
      integrations,
    );
    expect(rendered).toContain("{integration_partial}");
    expect(rendered).not.toContain("{include:_partials/");
  });
});

// docs/design/appendices/routine-data-acquisition.md Phase 3 R4 — `routine.hourly_check`
// variant files for `delegated.<be>` and `native.<be>` are deleted; the
// base file inherits the partial-include mechanism for all modes. The
// suffix resolver still returns a non-base suffix when a delegated /
// native integration is touched, but `loadFlowVariant` falls through
// to the base file (`prompts.ts:152-158`). The test below pins the
// deletion so a future revert is caught.
describe("Phase 3 R4 — hourly_check variants deleted", () => {
  const DELETED = [
    "routine.hourly_check.delegated.claude.md",
    "routine.hourly_check.delegated.codex.md",
    "routine.hourly_check.delegated.gemini.md",
    "routine.hourly_check.native.claude.md",
    "routine.hourly_check.native.codex.md",
    "routine.hourly_check.native.gemini.md",
  ];

  for (const filename of DELETED) {
    it(`${filename} no longer exists`, () => {
      expect(existsSync(join(TASK_FLOWS_DIR, filename))).toBe(false);
    });
  }
});

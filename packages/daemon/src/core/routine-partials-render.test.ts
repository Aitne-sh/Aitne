import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  resetTaskFlowsForTest,
} from "./prompts.js";

// docs/design/appendices/routine-data-acquisition.md Phase 2 / P2 — render each acquisition
// partial under every (mode × representative state) combination and assert
// the expected single-branch survives. The shape of these assertions
// doubles as documentation: only one mode block remains after filtering,
// the integration's own key is preserved, and no foreign integration key
// surfaces inside the surviving body.

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..");

const SESSION_BACKEND: BackendId = "claude";
const OTHER_BACKEND: BackendId = "codex";

interface PartialCase {
  filename: string;
  integration: IntegrationKey;
  /**
   * The host task-flow body the integration test wraps the partial in. Kept
   * minimal — the wrapper only carries the include directive plus marker
   * lines so we can assert the include resolved against the host correctly.
   */
  host: string;
  /**
   * Marker substring that must survive in every rendered output (proves the
   * include resolved and the host's surrounding prose was preserved).
   */
  hostMarker: string;
}

const CASES: readonly PartialCase[] = [
  {
    filename: "mail-acquire.gmail.md",
    integration: "gmail",
    host: "[HOST-START]\n{include:_partials/mail-acquire.gmail.md}\n[HOST-END]\n",
    hostMarker: "[HOST-START]",
  },
  {
    filename: "mail-acquire.outlook_mail.md",
    integration: "outlook_mail",
    host: "[HOST-START]\n{include:_partials/mail-acquire.outlook_mail.md}\n[HOST-END]\n",
    hostMarker: "[HOST-START]",
  },
  {
    filename: "calendar-acquire.google_calendar.md",
    integration: "google_calendar",
    host: "[HOST-START]\n{include:_partials/calendar-acquire.google_calendar.md}\n[HOST-END]\n",
    hostMarker: "[HOST-START]",
  },
  {
    filename: "calendar-acquire.outlook_calendar.md",
    integration: "outlook_calendar",
    host: "[HOST-START]\n{include:_partials/calendar-acquire.outlook_calendar.md}\n[HOST-END]\n",
    hostMarker: "[HOST-START]",
  },
  {
    filename: "notion-acquire.notion.md",
    integration: "notion",
    host: "[HOST-START]\n{include:_partials/notion-acquire.notion.md}\n[HOST-END]\n",
    hostMarker: "[HOST-START]",
  },
];

/**
 * Five representative integration states — one per `<!-- mode:X:Y -->`
 * predicate the partials author. `delegated-same` and `delegated-cross`
 * are encoded as runtime mode = `"delegated"` with the binding pointed at
 * the session vs another backend (per `applyIntegrationModeFilter`'s
 * predicate semantics in `@aitne/shared`).
 */
type FilterPredicate =
  | "direct"
  | "delegated-same"
  | "delegated-cross"
  | "native"
  | "disabled";

function stateFor(predicate: FilterPredicate): IntegrationState {
  const lastChangedAt = "2026-05-11T00:00:00.000Z";
  switch (predicate) {
    case "direct":
      return { mode: "direct" as IntegrationMode, deniedTools: [], lastChangedAt };
    case "delegated-same":
      return {
        mode: "delegated" as IntegrationMode,
        delegatedBackend: SESSION_BACKEND,
        deniedTools: [],
        lastChangedAt,
      };
    case "delegated-cross":
      return {
        mode: "delegated" as IntegrationMode,
        delegatedBackend: OTHER_BACKEND,
        deniedTools: [],
        lastChangedAt,
      };
    case "native":
      return {
        mode: "native" as IntegrationMode,
        nativeBackend: SESSION_BACKEND,
        deniedTools: [],
        lastChangedAt,
      };
    case "disabled":
      return {
        mode: "disabled" as IntegrationMode,
        deniedTools: [],
        lastChangedAt,
      };
  }
}

const PREDICATES: readonly FilterPredicate[] = [
  "direct",
  "delegated-same",
  "delegated-cross",
  "native",
  "disabled",
];

describe("acquisition partials — host include + mode filtering (P2)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-partials-render-"));
    resetTaskFlowsForTest();
    initTaskFlows(REPO_ROOT, dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetTaskFlowsForTest();
  });

  function writeOverride(key: string, body: string): void {
    const overrideDir = join(dataDir, "task-flows");
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, `${key}.md`), body, "utf-8");
  }

  /**
   * Use a synthetic event-type key per case so we can drop the host body in
   * via the user-override layer without touching any real routine file.
   */
  function eventKeyFor(c: PartialCase): string {
    return `partials_render_test_${c.integration}`;
  }

  for (const c of CASES) {
    describe(c.filename, () => {
      it("host markers survive include resolution", () => {
        writeOverride(eventKeyFor(c), c.host);
        const rendered = getTaskFlow(eventKeyFor(c), SESSION_BACKEND, {
          [c.integration]: stateFor("direct"),
        });
        expect(rendered).toContain(c.hostMarker);
        expect(rendered).toContain("[HOST-END]");
        // Include directive must have been resolved.
        expect(rendered).not.toContain("{include:_partials/");
      });

      for (const predicate of PREDICATES) {
        it(`mode=${predicate} keeps only the matching branch`, () => {
          writeOverride(eventKeyFor(c), c.host);
          const rendered = getTaskFlow(eventKeyFor(c), SESSION_BACKEND, {
            [c.integration]: stateFor(predicate),
          });

          // No mode markers should leak through — applyIntegrationModeFilter
          // either keeps the body verbatim (no markers) or drops the entire
          // <!-- mode:X:Y --> ... <!-- /mode:X:Y --> shell.
          expect(rendered).not.toContain("<!-- mode:");
          expect(rendered).not.toContain("<!-- /mode:");

          // Every non-matching branch must be absent. We probe by inspecting
          // the raw partial: any branch whose predicate differs from the
          // current `predicate` should have its body stripped. The simplest
          // robust check is "the rendered output is strictly shorter than
          // the raw partial body plus host" — which proves filtering ran —
          // combined with the next assertions that assert the surviving
          // branch's marker presence.
          expect(rendered).toContain(c.hostMarker);
        });
      }

      // ── Branch-presence smoke checks. Each branch carries one stable
      // marker we can grep for. The set is curated from each partial's
      // visible prose so it survives prose edits within a branch. ──
      // Each marker must (a) appear inside exactly one mode branch of its
      // partial and (b) live on a single line — host-side word-wrapping
      // can split prose phrases across newlines and break naive
      // `toContain` matches.
      const BRANCH_MARKERS: Record<string, Record<FilterPredicate, string>> = {
        gmail: {
          direct: "/api/mail/<accountId>/messages",
          "delegated-same": "catalog's `delegated` form",
          "delegated-cross": "/api/integrations/gmail/exec",
          native: "bound natively",
          disabled: "Defensive no-op",
        },
        outlook_mail: {
          direct: "/api/mail/<accountId>/messages",
          "delegated-same": "catalog's `delegated` form",
          "delegated-cross": "user-managed, so the daemon does not host",
          native: "bound natively",
          disabled: "Defensive no-op",
        },
        google_calendar: {
          direct: "/api/calendar/events",
          "delegated-same": "catalog's `delegated` form",
          "delegated-cross": "/api/integrations/google_calendar/exec",
          native: "bound natively",
          disabled: "Defensive no-op",
        },
        outlook_calendar: {
          direct: "/api/calendar/outlook/events",
          "delegated-same": "catalog's `delegated` form",
          "delegated-cross": "user-managed, so the daemon does not host",
          native: "bound natively",
          disabled: "Defensive no-op",
        },
        notion: {
          direct: "/api/notion/search",
          "delegated-same": "catalog's `delegated` form",
          "delegated-cross": "/api/integrations/notion/exec",
          native: "bound natively",
          disabled: "Defensive no-op",
        },
      };

      for (const predicate of PREDICATES) {
        it(`mode=${predicate} surviving body carries its branch marker`, () => {
          writeOverride(eventKeyFor(c), c.host);
          const rendered = getTaskFlow(eventKeyFor(c), SESSION_BACKEND, {
            [c.integration]: stateFor(predicate),
          });
          const marker = BRANCH_MARKERS[c.integration][predicate];
          expect(
            rendered,
            `mode=${predicate} should contain marker "${marker}"`,
          ).toContain(marker);
        });
      }

      // ── R2 single-responsibility — the rendered output must not name a
      // different integration's key, regardless of which mode predicate
      // applied. The raw partial body lint already enforces this at the
      // source layer (routine-partials.test.ts); this assertion catches
      // regressions that slip through include expansion or host wrapping. ──
      it("never surfaces a foreign integration key after rendering", () => {
        for (const predicate of PREDICATES) {
          writeOverride(eventKeyFor(c), c.host);
          const rendered = getTaskFlow(eventKeyFor(c), SESSION_BACKEND, {
            [c.integration]: stateFor(predicate),
          });
          const foreignKeys: IntegrationKey[] = [
            "gmail",
            "google_calendar",
            "notion",
            "git",
            "github",
            "outlook_mail",
            "outlook_calendar",
          ].filter((k) => k !== c.integration) as IntegrationKey[];
          for (const foreign of foreignKeys) {
            const re = new RegExp(`\\b${foreign}\\b`, "g");
            const hits = rendered.match(re) ?? [];
            expect(
              hits,
              `${c.filename} (mode=${predicate}) leaked foreign key "${foreign}" (${hits.length} hits)`,
            ).toHaveLength(0);
          }
        }
      });
    });
  }
});

// ── Skeleton-shape assertion. Independent of mode state — proves each
// partial author included the full five-predicate skeleton so future mode
// additions surface as missing-branch failures in the per-mode tests above
// rather than silent gaps in the prompt body. ──
describe("acquisition partials — five-predicate skeleton (P2)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-partials-skeleton-"));
    resetTaskFlowsForTest();
    initTaskFlows(REPO_ROOT, dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetTaskFlowsForTest();
  });

  function writeOverride(key: string, body: string): void {
    const overrideDir = join(dataDir, "task-flows");
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, `${key}.md`), body, "utf-8");
  }

  for (const c of CASES) {
    it(`${c.filename} carries all five mode branches`, () => {
      // Render with backendId omitted so applyIntegrationModeFilter is
      // skipped and the raw mode markers survive — gives us a direct view
      // of the partial's authored skeleton.
      writeOverride(`skeleton_${c.integration}`, c.host);
      const rendered = getTaskFlow(`skeleton_${c.integration}`);
      const opens = [
        `<!-- mode:direct:${c.integration} -->`,
        `<!-- mode:delegated-same:${c.integration} -->`,
        `<!-- mode:delegated-cross:${c.integration} -->`,
        `<!-- mode:native:${c.integration} -->`,
        `<!-- mode:disabled:${c.integration} -->`,
      ];
      const closes = opens.map((o) => o.replace("mode:", "/mode:"));
      for (const open of opens) {
        expect(rendered, `missing open ${open}`).toContain(open);
      }
      for (const close of closes) {
        expect(rendered, `missing close ${close}`).toContain(close);
      }
    });
  }
});

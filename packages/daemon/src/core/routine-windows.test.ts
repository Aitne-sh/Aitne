import { describe, expect, it } from "vitest";
import {
  INTEGRATION_KEYS,
  INTEGRATION_MODES,
  type IntegrationKey,
  type IntegrationMode,
} from "@aitne/shared";
import {
  ROUTINE_WINDOWS,
  ROUTINE_WINDOW_KEYS,
  WINDOW_QUERIES,
  WINDOW_SYMBOLS,
  lookupWindowQuery,
  routineHasWindows,
} from "./routine-windows.js";

describe("ROUTINE_WINDOWS catalog", () => {
  it("declares an entry for every routine window key", () => {
    for (const key of ROUTINE_WINDOW_KEYS) {
      expect(ROUTINE_WINDOWS[key]).toBeDefined();
    }
  });

  it("each row's window symbol appears in WINDOW_SYMBOLS", () => {
    for (const rows of Object.values(ROUTINE_WINDOWS)) {
      for (const row of rows) {
        expect(WINDOW_SYMBOLS).toContain(row.window);
      }
    }
  });

  it("each row's kind matches the integration family the window symbol targets", () => {
    // The kind drives partial selection: a "mail" row must reference a
    // symbol whose WINDOW_QUERIES entries name mail integrations, etc.
    // Catches accidental rows like { kind: "mail", window: "cal_next_24h" }.
    for (const rows of Object.values(ROUTINE_WINDOWS)) {
      for (const row of rows) {
        const integrations = Object.keys(
          WINDOW_QUERIES[row.window] ?? {},
        ) as IntegrationKey[];
        for (const integration of integrations) {
          const expectedKind: Record<IntegrationKey, string | undefined> = {
            gmail: "mail",
            outlook_mail: "mail",
            google_calendar: "calendar",
            outlook_calendar: "calendar",
            notion: "notion",
            git: undefined,
            github: undefined,
            browser_history: undefined,
          };
          const expected = expectedKind[integration];
          if (expected !== undefined) {
            expect(row.kind).toBe(expected);
          }
        }
      }
    }
  });

  // `routine.morning_routine_initial` retired by Phase 7 (2026-05-16);
  // the previous "share the same plan shape" invariant is moot because
  // the key no longer exists. Regression guard below pins the
  // absence — re-adding the key without re-adding the plan would
  // silently bypass the pre-pass for the first-run branch.
  it("routine.morning_routine_initial is no longer in ROUTINE_WINDOWS (Phase 7 retirement)", () => {
    expect(
      (ROUTINE_WINDOWS as Record<string, unknown>)["routine.morning_routine_initial"],
    ).toBeUndefined();
  });

  it("monthly_review acquires nothing (covered entirely by ContextBuilder + journals)", () => {
    expect(ROUTINE_WINDOWS["routine.monthly_review"]).toEqual([]);
    expect(routineHasWindows("routine.monthly_review")).toBe(false);
  });

  it("perAccount is true exactly for mail windows (calendar / notion are workspace-scoped)", () => {
    for (const rows of Object.values(ROUTINE_WINDOWS)) {
      for (const row of rows) {
        if (row.kind === "mail") {
          expect(row.perAccount).toBe(true);
        } else {
          expect(row.perAccount).toBe(false);
        }
      }
    }
  });

  it("morning_routine's calendar row is gated to non-direct modes only (A8 / Finding 5)", () => {
    // R7 from the design — pre-pass must not duplicate the window the
    // `<calendar_events_*>` block already covers. ContextBuilder
    // pre-fetches inline events for `direct` mode via the daemon's
    // CalendarService, so a `cal_morning_7d` row would double-fetch
    // in direct mode. The fix (Finding 5, 2026-05-13) is to leave the
    // calendar row in `ROUTINE_WINDOWS` but OMIT the `direct` cell
    // from `WINDOW_QUERIES[cal_morning_7d]` — `lookupQuery` returns
    // undefined and the dispatcher silently skips the row in direct
    // mode. Non-direct modes get the row (Sonnet otherwise drove the
    // MCP fan-out itself and burned the seeded $1.00 envelope).
    const morning = ROUTINE_WINDOWS["routine.morning_routine"];
    const calendarRow = morning.find((r) => r.kind === "calendar");
    expect(calendarRow).toBeDefined();
    expect(calendarRow?.window).toBe("cal_morning_7d");
    expect(calendarRow?.perAccount).toBe(false);

    const cell = WINDOW_QUERIES.cal_morning_7d?.google_calendar;
    expect(cell?.direct).toBeUndefined();
    expect(cell?.delegated).toBeDefined();
    expect(cell?.native).toBeDefined();
    const outlookCell = WINDOW_QUERIES.cal_morning_7d?.outlook_calendar;
    expect(outlookCell?.direct).toBeUndefined();
    expect(outlookCell?.delegated).toBeDefined();
    expect(outlookCell?.native).toBeDefined();
  });
});

describe("WINDOW_QUERIES catalog", () => {
  it("every window symbol has at least one integration mapping", () => {
    for (const symbol of WINDOW_SYMBOLS) {
      const entry = WINDOW_QUERIES[symbol];
      expect(entry).toBeDefined();
      expect(Object.keys(entry!).length).toBeGreaterThan(0);
    }
  });

  it("every integration cell maps at least the direct mode, except non-direct-only catalog rows (A8 / Finding 5)", () => {
    // Direct mode is the daemon REST path; every supported integration
    // ships that branch — with one exception. `cal_morning_7d` is a
    // non-direct-only window introduced by Finding 5 to push calendar
    // fetching into the lite-tier pre-pass for `delegated` / `native`
    // modes; `direct` is intentionally omitted because ContextBuilder
    // already pre-fetches the same window via `services.calendar`. The
    // dispatcher's `lookupQuery` returns undefined for those cells,
    // which it treats as "skip this row" — not "missing data."
    const NON_DIRECT_ONLY_SYMBOLS = new Set<string>(["cal_morning_7d"]);
    for (const symbol of WINDOW_SYMBOLS) {
      if (NON_DIRECT_ONLY_SYMBOLS.has(symbol)) continue;
      const cells = WINDOW_QUERIES[symbol];
      for (const [integration, modeMap] of Object.entries(cells ?? {})) {
        expect(
          modeMap?.direct,
          `${symbol}/${integration} missing direct mode`,
        ).toBeDefined();
      }
    }
  });

  it("every integration cell uses only known modes", () => {
    const modeSet = new Set<string>(INTEGRATION_MODES);
    for (const symbol of WINDOW_SYMBOLS) {
      const cells = WINDOW_QUERIES[symbol];
      for (const [, modeMap] of Object.entries(cells ?? {})) {
        for (const mode of Object.keys(modeMap ?? {})) {
          expect(modeSet.has(mode), `unknown mode '${mode}' in ${symbol}`).toBe(true);
        }
      }
    }
  });

  it("every integration cell uses only known integration keys", () => {
    const keySet = new Set<string>(INTEGRATION_KEYS);
    for (const symbol of WINDOW_SYMBOLS) {
      const cells = WINDOW_QUERIES[symbol];
      for (const integration of Object.keys(cells ?? {})) {
        expect(keySet.has(integration)).toBe(true);
      }
    }
  });

  it("disabled mode is never present (the dispatcher omits disabled rows before the partial is consulted)", () => {
    for (const symbol of WINDOW_SYMBOLS) {
      const cells = WINDOW_QUERIES[symbol];
      for (const [, modeMap] of Object.entries(cells ?? {})) {
        expect(modeMap?.disabled).toBeUndefined();
      }
    }
  });

  // docs/design/appendices/routine-data-acquisition.md §7.2 / B2 — `cal_next_24h_drift`
  // is a full-window fetch in every mode; server `contentHash` dedup
  // catches the actual drift. A delegated/native row that pinned
  // `updatedMin` / `lastModifiedDateTime ge` (the original Phase-3
  // shape) would lose any change that happened before the current
  // hour boundary, breaking today_refresh's 4h cron cadence.
  it("cal_next_24h_drift never pins a server-side delta filter (drift = observation-layer)", () => {
    for (const integration of ["google_calendar", "outlook_calendar"] as const) {
      const cell = WINDOW_QUERIES.cal_next_24h_drift[integration];
      expect(cell).toBeDefined();
      for (const [mode, query] of Object.entries(cell ?? {})) {
        expect(
          query,
          `cal_next_24h_drift/${integration}/${mode} must not include a delta filter`,
        ).not.toMatch(/updatedMin/);
        expect(
          query,
          `cal_next_24h_drift/${integration}/${mode} must not include a Graph lastModifiedDateTime filter`,
        ).not.toMatch(/lastModifiedDateTime\s+ge/);
      }
    }
  });

  it("user-managed Outlook integrations carry only direct / delegated / native (no daemon proxy semantics)", () => {
    // outlook_mail / outlook_calendar are userManagedConnector; the
    // delegated-cross branch collapses with delegated-same and native
    // — but at the WINDOW_QUERIES layer that distinction lives in the
    // partial, not in this table. Sanity-check the keys present.
    for (const symbol of WINDOW_SYMBOLS) {
      for (const key of ["outlook_mail", "outlook_calendar"] as const) {
        const modeMap = WINDOW_QUERIES[symbol]?.[key];
        if (!modeMap) continue;
        for (const m of Object.keys(modeMap) as IntegrationMode[]) {
          expect(["direct", "delegated", "native"]).toContain(m);
        }
      }
    }
  });
});

describe("lookupWindowQuery", () => {
  it("returns the mapped expression for a known cell", () => {
    expect(lookupWindowQuery("inbox_today", "gmail", "direct")).toBeDefined();
    expect(lookupWindowQuery("imminent_2h", "google_calendar", "native"))
      .toBeDefined();
  });

  it("returns undefined for unmapped cells (caller must treat as skip)", () => {
    expect(lookupWindowQuery("updated_24h", "gmail", "direct")).toBeUndefined();
    expect(lookupWindowQuery("inbox_today", "notion", "direct")).toBeUndefined();
  });
});

describe("routineHasWindows", () => {
  it("returns true for routines with at least one row", () => {
    expect(routineHasWindows("routine.morning_routine")).toBe(true);
    expect(routineHasWindows("routine.activity_scan")).toBe(true);
  });

  it("returns false for routines whose plan is empty", () => {
    expect(routineHasWindows("routine.monthly_review")).toBe(false);
  });
});

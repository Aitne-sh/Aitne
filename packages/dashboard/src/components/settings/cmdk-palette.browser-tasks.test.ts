import { describe, expect, it } from "vitest";
import { SETTINGS_INDEX } from "./cmdk-palette";

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §13 — pure-data snapshot test on the
 * cmdk-palette entry list, guarding against the obsolete
 * `"Workflow Approvals (B-3)"` entry sneaking back via a merge or
 * partial cherry-pick. The Phase 6 drop migration removes the
 * `browser_automation_approvals` table that backed that entry, so if
 * a future merge re-introduces the cmdk label the user lands on a
 * page that 404s its data endpoint.
 *
 * The positive Browser-Tasks entries are asserted alongside so a
 * future cleanup pass cannot accidentally drop them in the same
 * sweep that would have killed Workflow Approvals.
 */
describe("cmdk-palette — Browser Tasks regression", () => {
  it("lists the three Browser Tasks entries pointing at /browser-tasks", () => {
    const labels = SETTINGS_INDEX.filter((e) => e.page === "/browser-tasks").map(
      (e) => e.label,
    );
    // Three entries pinned by §9a.1: list, needs-your-attention,
    // and cancel. Any drop here breaks the cmdk discoverability the
    // design relies on.
    expect(labels).toEqual([
      "Browser Tasks (list)",
      "Browser Task — needs your attention",
      "Cancel browser task",
    ]);
  });

  it("does not ship the obsolete Workflow Approvals (B-3) entry", () => {
    // Wide net — match either the literal label or any keyword string
    // mentioning workflow approval / B-3. A reviewer adding a similar
    // entry will trip this assertion and have to think about whether
    // they really need to revive the workflow surface.
    for (const e of SETTINGS_INDEX) {
      expect(e.label).not.toMatch(/workflow approvals?/i);
      expect(e.label).not.toMatch(/\bB-3\b/i);
      expect(e.keywords).not.toMatch(/workflow_approvals?/i);
    }
  });

  it("removed the legacy 'B-3' / 'B-2.5' jargon from the Browser Automation labels", () => {
    // §9a.1 + §9a.6 — the cmdk entries refresh their labels to drop
    // the phase-number jargon and the workflow→task rename now that the
    // user-visible terms are "Browser Tasks" / "Authenticated sites" /
    // "Purchase confirmations".
    const managedLabels = SETTINGS_INDEX.filter((e) =>
      e.page.startsWith("/settings/integrations/browser-history-managed"),
    ).map((e) => e.label);
    for (const label of managedLabels) {
      expect(label).not.toMatch(/\bB-2\.5\b/);
      expect(label).not.toMatch(/\bB-3\b/);
    }
  });

  it("removed 'workflows' from purchase / B-4 user-visible labels", () => {
    // §9a.6 — the workflow registry is gone; "Purchase workflows" /
    // "Experimental purchase workflows" labels are bit-rot pointing
    // at a feature surface that no longer matches the user-visible
    // shape. The keyword field is allowed to retain "workflows" so a
    // user searching the legacy term still finds the page; the label
    // itself is what the user reads in the palette and must use the
    // post-rename terminology.
    const b4Labels = SETTINGS_INDEX.filter((e) =>
      e.page.startsWith("/settings/integrations/browser-history-managed/b4"),
    ).map((e) => e.label);
    for (const label of b4Labels) {
      expect(label).not.toMatch(/workflows?/i);
    }
  });
});

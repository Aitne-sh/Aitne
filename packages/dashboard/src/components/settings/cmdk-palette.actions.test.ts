import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ACTION_ENTRIES } from "./cmdk-palette";
import { getDocsHelpSlideoverState } from "@/lib/docs/slideover-cache";

/**
 * §12 / §15-D5 regression coverage: the cmdk refactor (settings-only →
 * discriminated union with an Actions group) must surface the
 * `docs.ask` entry, keep it keyword-searchable, and route its
 * `onSelect` into `openDocsHelpSlideover` with the resolved docId.
 *
 * The CmdkPalette component itself is dialog-state heavy and needs
 * an open palette to assert against the rendered DOM; the action
 * registry and its dispatch are pure data, so we test those directly.
 */

function getDocsAsk() {
  const e = ACTION_ENTRIES.find((a) => a.id === "docs.ask");
  if (!e) throw new Error("docs.ask action missing from ACTION_ENTRIES");
  return e;
}

describe("cmdk-palette — docs.ask action", () => {
  it("ships a docs.ask entry in the Help group", () => {
    const e = getDocsAsk();
    expect(e.group).toBe("Help");
    expect(e.label).toBe("Ask docs…");
  });

  it("is keyword-searchable for the operator-language terms", () => {
    const e = getDocsAsk();
    // Keywords are concatenated into the cmdk Item value alongside the
    // label; cmdk fuzzy-matches against that string. Asserting on the
    // raw `keywords` field is the simplest invariant: if these terms
    // disappear, the operator typing "help" or "manual" will lose the
    // entry.
    for (const t of ["docs", "help", "question", "manual"]) {
      expect(e.keywords).toContain(t);
    }
  });

  it("opens the slide-over with the path-resolved docId and autoFocusComposer=true", () => {
    const e = getDocsAsk();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const router = { push() {} } as unknown as Parameters<
      typeof e.onSelect
    >[0]["router"];
    e.onSelect({
      pathname: "/settings/models",
      searchParams: new URLSearchParams(),
      queryClient: qc,
      router,
    });
    const state = getDocsHelpSlideoverState(qc);
    expect(state.open).toBe(true);
    expect(state.autoFocusComposer).toBe(true);
    // The /settings/models path resolves to concepts/backends-and-tiers
    // per PAGE_DOC_MAP — exercises the path-resolution path end-to-end
    // rather than just asserting "some docId".
    expect(state.docId).toBe("concepts/backends-and-tiers");
  });

  it("opens with docId=null when the path has no map entry", () => {
    const e = getDocsAsk();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const router = { push() {} } as unknown as Parameters<
      typeof e.onSelect
    >[0]["router"];
    e.onSelect({
      pathname: "/totally-unmapped-path",
      searchParams: new URLSearchParams(),
      queryClient: qc,
      router,
    });
    const state = getDocsHelpSlideoverState(qc);
    expect(state.open).toBe(true);
    expect(state.docId).toBeNull();
  });
});

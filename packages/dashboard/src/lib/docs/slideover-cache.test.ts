import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  closeDocsHelpSlideover,
  getDocsHelpSlideoverState,
  openDocsHelpSlideover,
} from "./slideover-cache";

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

describe("slideover-cache", () => {
  it("returns the closed initial state when nothing has been written", () => {
    const qc = freshClient();
    const state = getDocsHelpSlideoverState(qc);
    expect(state).toEqual({
      open: false,
      docId: null,
      autoFocusComposer: false,
      anchor: null,
      openCount: 0,
    });
  });

  it("openDocsHelpSlideover writes open=true with the supplied docId", () => {
    const qc = freshClient();
    openDocsHelpSlideover(qc, { docId: "concepts/agent-day" });
    expect(getDocsHelpSlideoverState(qc)).toEqual({
      open: true,
      docId: "concepts/agent-day",
      autoFocusComposer: false,
      anchor: null,
      openCount: 1,
    });
  });

  it("autoFocusComposer flag round-trips through the cache", () => {
    const qc = freshClient();
    openDocsHelpSlideover(qc, {
      docId: "features/messaging/overview",
      autoFocusComposer: true,
    });
    expect(getDocsHelpSlideoverState(qc).autoFocusComposer).toBe(true);
  });

  it("supports a null docId — palette opens without a paired doc", () => {
    const qc = freshClient();
    openDocsHelpSlideover(qc, { docId: null, autoFocusComposer: true });
    const state = getDocsHelpSlideoverState(qc);
    expect(state.open).toBe(true);
    expect(state.docId).toBeNull();
  });

  it("closeDocsHelpSlideover clears open and autoFocusComposer but preserves docId", () => {
    const qc = freshClient();
    openDocsHelpSlideover(qc, {
      docId: "concepts/skills",
      autoFocusComposer: true,
    });
    closeDocsHelpSlideover(qc);
    const state = getDocsHelpSlideoverState(qc);
    expect(state.open).toBe(false);
    expect(state.docId).toBe("concepts/skills");
    expect(state.autoFocusComposer).toBe(false);
  });

  it("re-opening overwrites the previous docId", () => {
    const qc = freshClient();
    openDocsHelpSlideover(qc, { docId: "concepts/agent-day" });
    openDocsHelpSlideover(qc, { docId: "concepts/routines" });
    expect(getDocsHelpSlideoverState(qc).docId).toBe("concepts/routines");
  });

  it("threads anchor through open and bumps openCount on re-open", () => {
    const qc = freshClient();
    openDocsHelpSlideover(qc, {
      docId: "concepts/safety-and-execution",
      anchor: "what-it-does",
    });
    const first = getDocsHelpSlideoverState(qc);
    expect(first.anchor).toBe("what-it-does");
    expect(first.openCount).toBe(1);

    // Re-opening with the same (docId, anchor) must still bump openCount
    // so <DocsContent>'s scroll effect re-fires after the operator has
    // scrolled away from the anchor.
    openDocsHelpSlideover(qc, {
      docId: "concepts/safety-and-execution",
      anchor: "what-it-does",
    });
    expect(getDocsHelpSlideoverState(qc).openCount).toBe(2);
  });

  it("clears anchor when not supplied — does not leak across opens", () => {
    const qc = freshClient();
    openDocsHelpSlideover(qc, {
      docId: "concepts/agent-day",
      anchor: "definitions",
    });
    expect(getDocsHelpSlideoverState(qc).anchor).toBe("definitions");
    openDocsHelpSlideover(qc, { docId: "concepts/routines" });
    expect(getDocsHelpSlideoverState(qc).anchor).toBeNull();
  });
});

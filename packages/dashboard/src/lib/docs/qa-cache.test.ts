import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

// jsdom is not configured for the dashboard test workspace, so the
// qa-cache module's `typeof window === "undefined"` guard would skip
// real exercise. We install a minimal in-memory sessionStorage on
// globalThis before importing the module so the read/write paths run
// against a real Map rather than the SSR no-op branch.
class MemorySessionStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const storage = new MemorySessionStorage();
beforeAll(() => {
  // Vitest runs each test file in a fresh worker so cross-test pollution
  // is bounded; nevertheless install once at the start of this file.
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage: storage },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
});

import type { DocsQAMessage, DocsQAState } from "./qa-cache";

const {
  computeOrphanResetPatch,
  DOCS_QA_RESET_REASON_RECONNECT,
  DOCS_QA_RESET_REASON_STALE,
  DOCS_QA_STALE_BUSY_THRESHOLD_MS,
  getDocsQASessionId,
  patchDocsQAState,
  prefillComposerWithSelection,
  shouldFireStaleBusy,
} = await import("./qa-cache");

/** Build a state for the recovery-helper tests. Defaults to an empty,
 *  not-busy state; callers override only the fields they care about. */
function makeState(patch: Partial<DocsQAState> = {}): DocsQAState {
  return {
    sessionId: "test-session",
    scope: "all",
    messages: [],
    composerDraft: "",
    busy: false,
    error: null,
    ...patch,
  };
}

const placeholder: DocsQAMessage = {
  id: "p",
  role: "assistant",
  content: "",
  streaming: true,
};
const partialAssistant: DocsQAMessage = {
  id: "a",
  role: "assistant",
  content: "Half an answer…",
  streaming: true,
};
const finishedAssistant: DocsQAMessage = {
  id: "a",
  role: "assistant",
  content: "Done.",
};
const userMsg: DocsQAMessage = { id: "u", role: "user", content: "hi" };

describe("qa-cache", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    storage.clear();
    queryClient = new QueryClient();
  });

  afterEach(() => {
    queryClient.clear();
    storage.clear();
  });

  it("getDocsQASessionId is stable within a tab session", () => {
    const a = getDocsQASessionId();
    const b = getDocsQASessionId();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("patchDocsQAState merges fields and preserves untouched ones", () => {
    patchDocsQAState(queryClient, { scope: "current", composerDraft: "hi" });
    const sessionId = getDocsQASessionId();
    const stored = queryClient.getQueryData([
      "docs-qa",
      sessionId,
    ]) as { scope: string; composerDraft: string; messages: unknown[] };
    expect(stored.scope).toBe("current");
    expect(stored.composerDraft).toBe("hi");
    expect(stored.messages).toEqual([]);

    patchDocsQAState(queryClient, { busy: true });
    const next = queryClient.getQueryData([
      "docs-qa",
      sessionId,
    ]) as { scope: string; composerDraft: string; busy: boolean };
    expect(next.scope).toBe("current");
    expect(next.composerDraft).toBe("hi");
    expect(next.busy).toBe(true);
  });

  describe("prefillComposerWithSelection", () => {
    it("blockquotes the selection and appends the canonical question", () => {
      prefillComposerWithSelection(queryClient, "first line\nsecond line");
      const sessionId = getDocsQASessionId();
      const draft = (queryClient.getQueryData([
        "docs-qa",
        sessionId,
      ]) as { composerDraft: string }).composerDraft;
      expect(draft).toBe(
        "> first line\n> second line\n\nWhat does this mean?",
      );
    });

    it("trims trailing whitespace before blockquoting", () => {
      prefillComposerWithSelection(queryClient, "trailing spaces   \n\n");
      const sessionId = getDocsQASessionId();
      const draft = (queryClient.getQueryData([
        "docs-qa",
        sessionId,
      ]) as { composerDraft: string }).composerDraft;
      expect(draft).toBe("> trailing spaces\n\nWhat does this mean?");
    });

    it("soft-caps at 2000 characters and adds a truncation marker", () => {
      const huge = "a".repeat(3000);
      prefillComposerWithSelection(queryClient, huge);
      const sessionId = getDocsQASessionId();
      const draft = (queryClient.getQueryData([
        "docs-qa",
        sessionId,
      ]) as { composerDraft: string }).composerDraft;
      expect(draft).toContain("> " + "a".repeat(2000));
      expect(draft).not.toContain("> " + "a".repeat(2001));
      expect(draft).toContain("[selection truncated]");
    });

    it("does NOT append the truncation marker when under the cap", () => {
      prefillComposerWithSelection(queryClient, "small selection");
      const sessionId = getDocsQASessionId();
      const draft = (queryClient.getQueryData([
        "docs-qa",
        sessionId,
      ]) as { composerDraft: string }).composerDraft;
      expect(draft).not.toContain("[selection truncated]");
    });
  });

  describe("computeOrphanResetPatch", () => {
    it("returns null when no turn is in flight", () => {
      const state = makeState({ busy: false, messages: [userMsg] });
      expect(
        computeOrphanResetPatch(state, DOCS_QA_RESET_REASON_RECONNECT),
      ).toBeNull();
    });

    it("drops an empty streaming placeholder (no ghost bubble)", () => {
      const state = makeState({
        busy: true,
        messages: [userMsg, placeholder],
      });
      const patch = computeOrphanResetPatch(
        state,
        DOCS_QA_RESET_REASON_RECONNECT,
      );
      expect(patch).not.toBeNull();
      expect(patch!.busy).toBe(false);
      expect(patch!.error).toBe(DOCS_QA_RESET_REASON_RECONNECT);
      expect(patch!.messages).toEqual([userMsg]);
    });

    it("preserves partial content but clears the streaming flag", () => {
      const state = makeState({
        busy: true,
        messages: [userMsg, partialAssistant],
      });
      const patch = computeOrphanResetPatch(
        state,
        DOCS_QA_RESET_REASON_STALE,
      );
      expect(patch).not.toBeNull();
      expect(patch!.busy).toBe(false);
      expect(patch!.error).toBe(DOCS_QA_RESET_REASON_STALE);
      expect(patch!.messages).toHaveLength(2);
      const lastPatched = patch!.messages![1]!;
      expect(lastPatched.content).toBe("Half an answer…");
      expect(lastPatched.streaming).toBe(false);
      // Original state untouched (purity check).
      expect(partialAssistant.streaming).toBe(true);
    });

    it("does not touch a non-streaming assistant message", () => {
      // Edge: busy=true but the last message is already finished (e.g.,
      // a finished assistant from the prior turn followed by a queued
      // POST that hadn't yet appended the new placeholder). Patch
      // should still clear busy + set the error but leave messages alone.
      const state = makeState({
        busy: true,
        messages: [userMsg, finishedAssistant],
      });
      const patch = computeOrphanResetPatch(
        state,
        DOCS_QA_RESET_REASON_RECONNECT,
      );
      expect(patch).not.toBeNull();
      expect(patch!.messages).toBe(state.messages);
      expect(patch!.busy).toBe(false);
    });

    it("handles an empty message list while busy", () => {
      // Pathological but representable: busy=true with no placeholder.
      // The patch should still clear busy without throwing on the
      // missing `last`.
      const state = makeState({ busy: true, messages: [] });
      const patch = computeOrphanResetPatch(
        state,
        DOCS_QA_RESET_REASON_RECONNECT,
      );
      expect(patch).not.toBeNull();
      expect(patch!.messages).toEqual([]);
      expect(patch!.busy).toBe(false);
      expect(patch!.error).toBe(DOCS_QA_RESET_REASON_RECONNECT);
    });

    it("ignores a trailing user message", () => {
      // If somehow the user message is the trailing one (no placeholder
      // appended yet), don't strip it — it represents real intent.
      const state = makeState({ busy: true, messages: [userMsg] });
      const patch = computeOrphanResetPatch(
        state,
        DOCS_QA_RESET_REASON_RECONNECT,
      );
      expect(patch!.messages).toEqual([userMsg]);
    });

    it("is idempotent: re-applying the patch on the result is a no-op", () => {
      const state = makeState({
        busy: true,
        messages: [userMsg, placeholder],
      });
      const patch = computeOrphanResetPatch(
        state,
        DOCS_QA_RESET_REASON_RECONNECT,
      );
      const after = { ...state, ...patch } as DocsQAState;
      const second = computeOrphanResetPatch(
        after,
        DOCS_QA_RESET_REASON_RECONNECT,
      );
      // After patching once, busy=false, so the second pass returns
      // null. Without idempotence, an interval that fires twice in the
      // same tick would clobber the user's recovery action.
      expect(second).toBeNull();
    });
  });

  describe("shouldFireStaleBusy", () => {
    const NOW = 1_000_000;

    it("is false when the turn is not in flight", () => {
      const state = makeState({ busy: false });
      expect(shouldFireStaleBusy(state, NOW - 999_999, NOW)).toBe(false);
    });

    it("is false when activity is recent (under threshold)", () => {
      const state = makeState({ busy: true });
      expect(
        shouldFireStaleBusy(
          state,
          NOW - (DOCS_QA_STALE_BUSY_THRESHOLD_MS - 1),
          NOW,
        ),
      ).toBe(false);
    });

    it("is true at exactly the threshold", () => {
      const state = makeState({ busy: true });
      expect(
        shouldFireStaleBusy(state, NOW - DOCS_QA_STALE_BUSY_THRESHOLD_MS, NOW),
      ).toBe(true);
    });

    it("is true when activity is older than the threshold", () => {
      const state = makeState({ busy: true });
      expect(
        shouldFireStaleBusy(
          state,
          NOW - (DOCS_QA_STALE_BUSY_THRESHOLD_MS + 5_000),
          NOW,
        ),
      ).toBe(true);
    });

    it("honors a custom threshold override", () => {
      const state = makeState({ busy: true });
      expect(shouldFireStaleBusy(state, NOW - 10_000, NOW, 5_000)).toBe(true);
      expect(shouldFireStaleBusy(state, NOW - 4_999, NOW, 5_000)).toBe(false);
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  applyPromptContextStaleness,
  classifyContextWriteStaleness,
  resolvePromptContextStaleness,
} from "./context-staleness.js";

describe("classifyContextWriteStaleness", () => {
  it("treats today.md Agent Log section patches as quiet", () => {
    expect(
      classifyContextWriteStaleness({
        path: "today",
        method: "PATCH",
        mode: "append",
        section: "agent_log",
        content: "- 09:35 Synced calendar",
      }),
    ).toEqual({
      tier: "quiet",
      tierReason: "today_agent_log_section",
    });
  });

  it("keeps today.md Agent Plan patches loud", () => {
    expect(
      classifyContextWriteStaleness({
        path: "today",
        method: "PATCH",
        mode: "replace",
        section: "agent_plan",
        content: "- [ ] 10:00 Send reminder [work] ->DM",
      }).tier,
    ).toBe("loud");
  });

  it("treats project activity-log patches as quiet", () => {
    expect(
      classifyContextWriteStaleness({
        path: "projects/acme.md",
        method: "PATCH",
        mode: "append",
        section: "Daily Activity Log",
        content: "- Updated deployment note",
      }).tier,
    ).toBe("quiet");
  });

  it("recognizes safe append_to_file writes only when they land in Agent Log", () => {
    expect(
      classifyContextWriteStaleness({
        path: "today.md",
        method: "PATCH",
        mode: "append_to_file",
        content: "- 12:00 Quiet hourly check",
        previousContent: "# Today\n\n## Agent Log\n- old\n",
      }).tier,
    ).toBe("quiet");

    expect(
      classifyContextWriteStaleness({
        path: "today.md",
        method: "PATCH",
        mode: "append_to_file",
        content: "- 12:00 Quiet hourly check",
        previousContent: "# Today\n\n## Handoff\n- old\n",
      }).tier,
    ).toBe("loud");
  });

  it("treats an append with no prior `## ` heading as loud (defensive headings.length === 0 branch)", () => {
    // previousContent contains no `## ` heading at all → appendWouldLandInAgentLog
    // returns false via the `headings.length === 0` guard.
    expect(
      classifyContextWriteStaleness({
        path: "today.md",
        method: "PATCH",
        mode: "append_to_file",
        content: "- 12:00 brand-new entry",
        previousContent: "# Today\n\nNo headings yet.\n",
      }).tier,
    ).toBe("loud");
  });

  it("treats an append against missing previousContent as loud (defensive !content branch)", () => {
    // previousContent is undefined → appendWouldLandInAgentLog returns false
    // via the `!content` guard.
    expect(
      classifyContextWriteStaleness({
        path: "today.md",
        method: "PATCH",
        mode: "append_to_file",
        content: "- 12:00 brand-new entry",
      }).tier,
    ).toBe("loud");
  });
});

describe("resolvePromptContextStaleness", () => {
  it("does not invalidate DM sessions for quiet writes by default", () => {
    expect(
      resolvePromptContextStaleness({
        tier: "quiet",
        dmStalenessStrict: false,
        setupInProgress: false,
      }),
    ).toMatchObject({
      effectiveTier: "quiet",
      invalidatesDmSessions: false,
    });
  });

  it("forces quiet writes to loud when strict mode is enabled", () => {
    expect(
      resolvePromptContextStaleness({
        tier: "quiet",
        dmStalenessStrict: true,
        setupInProgress: false,
      }),
    ).toMatchObject({
      requestedTier: "quiet",
      effectiveTier: "loud",
      invalidatesDmSessions: true,
    });
  });

  it("defaults the requested tier to `loud` when none is supplied", () => {
    // Exercises the `input.tier ?? \"loud\"` fallback.
    const decision = resolvePromptContextStaleness({
      dmStalenessStrict: false,
      setupInProgress: false,
    });
    expect(decision.requestedTier).toBe("loud");
    expect(decision.effectiveTier).toBe("loud");
  });

  it("skips invalidation while setup is in progress", () => {
    expect(
      resolvePromptContextStaleness({
        tier: "loud",
        dmStalenessStrict: true,
        setupInProgress: true,
      }),
    ).toMatchObject({
      effectiveTier: "loud",
      invalidatesDmSessions: false,
      skippedForSetup: true,
    });
  });
});

describe("applyPromptContextStaleness", () => {
  it("calls the persistent timestamp before marking active DMs stale", () => {
    const calls: string[] = [];
    applyPromptContextStaleness(
      { path: "today", reason: "context_patch:today", tier: "loud" },
      {
        dmStalenessStrict: false,
        setupInProgress: false,
        markContextChanged: vi.fn(() => calls.push("context")),
        markActiveDmSessionsStale: vi.fn(() => calls.push("dm")),
      },
    );

    expect(calls).toEqual(["context", "dm"]);
  });

  it("does not call stale markers for quiet writes", () => {
    const markContextChanged = vi.fn();
    const markActiveDmSessionsStale = vi.fn();
    applyPromptContextStaleness(
      { path: "today", reason: "context_patch:today", tier: "quiet" },
      {
        dmStalenessStrict: false,
        setupInProgress: false,
        markContextChanged,
        markActiveDmSessionsStale,
      },
    );

    expect(markContextChanged).not.toHaveBeenCalled();
    expect(markActiveDmSessionsStale).not.toHaveBeenCalled();
  });
});

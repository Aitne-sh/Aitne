/**
 * schemas — §5 / §14.9 / §14.12 coverage.
 *
 * Focus: Zod validation for the 11 tools' args. Particular load-bearing
 * cases:
 *   - wait_for rejects fn / predicate / evaluate keys (§14.9 — no JS).
 *   - press_key enforces the closed allowlist.
 *   - extract caps maxChars at EXTRACT_PER_CALL_MAX_CHARS.
 *   - selector-or-coords union accepts both shapes; coords are
 *     bounded.
 *   - browserTaskToolFqn returns mcp__aitne-browser__<name>.
 */

import { describe, expect, it } from "vitest";

import {
  EXTRACT_PER_CALL_MAX_CHARS,
} from "./extract-cap.js";
import {
  BROWSER_TASK_MCP_SERVER_NAME,
  BROWSER_TASK_TOOL_FQNS,
  BROWSER_TASK_TOOL_NAMES,
  askUserArgsZod,
  browserTaskToolFqn,
  clickArgsZod,
  domSnapshotArgsZod,
  extractArgsZod,
  finishArgsZod,
  navigateArgsZod,
  pressKeyArgsZod,
  PRESS_KEY_ALLOWED,
  screenshotArgsZod,
  selectorOrCoordsSchema,
  typeArgsZod,
  waitForArgsZod,
  yieldForClarificationArgsZod,
} from "./schemas.js";

describe("BROWSER_TASK_TOOL_NAMES + FQN catalogue", () => {
  it("lists exactly the 11 tools", () => {
    expect(BROWSER_TASK_TOOL_NAMES.length).toBe(11);
    expect(BROWSER_TASK_TOOL_FQNS.length).toBe(11);
  });

  it("FQNs follow mcp__aitne-browser__<name>", () => {
    expect(BROWSER_TASK_MCP_SERVER_NAME).toBe("aitne-browser");
    for (const fqn of BROWSER_TASK_TOOL_FQNS) {
      expect(fqn.startsWith("mcp__aitne-browser__")).toBe(true);
    }
  });

  it("browserTaskToolFqn round-trips a name", () => {
    expect(browserTaskToolFqn("navigate")).toBe("mcp__aitne-browser__navigate");
    expect(browserTaskToolFqn("finish")).toBe("mcp__aitne-browser__finish");
  });
});

describe("selectorOrCoordsSchema", () => {
  it("accepts {kind:'selector', value:'#x'}", () => {
    const r = selectorOrCoordsSchema.safeParse({
      kind: "selector",
      value: "#x",
    });
    expect(r.success).toBe(true);
  });

  it("accepts {kind:'coords', x:100, y:200}", () => {
    const r = selectorOrCoordsSchema.safeParse({
      kind: "coords",
      x: 100,
      y: 200,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unrecognised key on either arm", () => {
    const r = selectorOrCoordsSchema.safeParse({
      kind: "selector",
      value: "#x",
      extra: 1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative coords", () => {
    const r = selectorOrCoordsSchema.safeParse({
      kind: "coords",
      x: -1,
      y: 0,
    });
    expect(r.success).toBe(false);
  });

  it("rejects coords above 10 000", () => {
    const r = selectorOrCoordsSchema.safeParse({
      kind: "coords",
      x: 20_000,
      y: 0,
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty selector value", () => {
    const r = selectorOrCoordsSchema.safeParse({ kind: "selector", value: "" });
    expect(r.success).toBe(false);
  });
});

describe("navigateArgsZod", () => {
  it("accepts an https URL", () => {
    expect(navigateArgsZod.safeParse({ url: "https://example.com/" }).success).toBe(true);
  });

  it("rejects a non-URL string", () => {
    expect(navigateArgsZod.safeParse({ url: "not a url" }).success).toBe(false);
  });

  it("rejects URLs over 4096 chars", () => {
    const big = `https://example.com/${"x".repeat(5000)}`;
    expect(navigateArgsZod.safeParse({ url: big }).success).toBe(false);
  });

  it("rejects unrecognised keys (strict)", () => {
    expect(
      navigateArgsZod.safeParse({ url: "https://example.com/", extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe("screenshotArgsZod", () => {
  it("accepts no args (fullPage optional)", () => {
    expect(screenshotArgsZod.safeParse({}).success).toBe(true);
  });

  it("accepts {fullPage:true}", () => {
    expect(screenshotArgsZod.safeParse({ fullPage: true }).success).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(screenshotArgsZod.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("domSnapshotArgsZod", () => {
  it("accepts {maxNodes:500}", () => {
    expect(domSnapshotArgsZod.safeParse({ maxNodes: 500 }).success).toBe(true);
  });

  it("rejects maxNodes < 1 or > 5000", () => {
    expect(domSnapshotArgsZod.safeParse({ maxNodes: 0 }).success).toBe(false);
    expect(domSnapshotArgsZod.safeParse({ maxNodes: 5001 }).success).toBe(false);
  });

  it("accepts an empty object (maxNodes optional)", () => {
    expect(domSnapshotArgsZod.safeParse({}).success).toBe(true);
  });
});

describe("clickArgsZod", () => {
  it("accepts a selector target", () => {
    expect(
      clickArgsZod.safeParse({ target: { kind: "selector", value: "#x" } })
        .success,
    ).toBe(true);
  });

  it("accepts a coords target", () => {
    expect(
      clickArgsZod.safeParse({ target: { kind: "coords", x: 1, y: 1 } })
        .success,
    ).toBe(true);
  });

  it("rejects a missing target", () => {
    expect(clickArgsZod.safeParse({}).success).toBe(false);
  });
});

describe("typeArgsZod", () => {
  it("accepts the common shape", () => {
    expect(
      typeArgsZod.safeParse({
        target: { kind: "selector", value: "#email" },
        text: "user@example.com",
      }).success,
    ).toBe(true);
  });

  it("respects the 8 KB text cap", () => {
    const big = "x".repeat(9000);
    expect(
      typeArgsZod.safeParse({
        target: { kind: "selector", value: "#x" },
        text: big,
      }).success,
    ).toBe(false);
  });

  it("accepts replaceExisting flag", () => {
    expect(
      typeArgsZod.safeParse({
        target: { kind: "selector", value: "#x" },
        text: "y",
        replaceExisting: true,
      }).success,
    ).toBe(true);
  });
});

describe("pressKeyArgsZod", () => {
  it("accepts every key in the allowlist", () => {
    for (const k of PRESS_KEY_ALLOWED) {
      expect(pressKeyArgsZod.safeParse({ key: k }).success).toBe(true);
    }
  });

  it("rejects an arbitrary key", () => {
    expect(pressKeyArgsZod.safeParse({ key: "F12" }).success).toBe(false);
    expect(pressKeyArgsZod.safeParse({ key: "a" }).success).toBe(false);
  });
});

describe("waitForArgsZod (§14.9 — no JS predicate)", () => {
  it("accepts selector + timeoutMs", () => {
    expect(
      waitForArgsZod.safeParse({ selector: "#ready", timeoutMs: 5000 }).success,
    ).toBe(true);
  });

  it("accepts urlPattern + timeoutMs", () => {
    expect(
      waitForArgsZod.safeParse({ urlPattern: "https://example.com/*", timeoutMs: 1000 })
        .success,
    ).toBe(true);
  });

  it("accepts a bare timeoutMs", () => {
    expect(waitForArgsZod.safeParse({ timeoutMs: 1000 }).success).toBe(true);
  });

  it("rejects empty {} (must specify at least one wait condition)", () => {
    expect(waitForArgsZod.safeParse({}).success).toBe(false);
  });

  it("rejects fn / predicate / evaluate keys (§14.9 strict)", () => {
    expect(
      waitForArgsZod.safeParse({
        selector: "#x",
        fn: "() => true",
      }).success,
    ).toBe(false);
    expect(
      waitForArgsZod.safeParse({
        selector: "#x",
        predicate: "() => true",
      }).success,
    ).toBe(false);
    expect(
      waitForArgsZod.safeParse({
        selector: "#x",
        evaluate: "() => document.title",
      }).success,
    ).toBe(false);
  });

  it("rejects timeoutMs below 100 or above 30 000", () => {
    expect(
      waitForArgsZod.safeParse({ selector: "#x", timeoutMs: 50 }).success,
    ).toBe(false);
    expect(
      waitForArgsZod.safeParse({ selector: "#x", timeoutMs: 60_000 }).success,
    ).toBe(false);
  });
});

describe("extractArgsZod", () => {
  it("requires queryHint", () => {
    expect(extractArgsZod.safeParse({}).success).toBe(false);
  });

  it("accepts queryHint alone (selector + maxChars optional)", () => {
    expect(
      extractArgsZod.safeParse({ queryHint: "headline text" }).success,
    ).toBe(true);
  });

  it("caps maxChars at EXTRACT_PER_CALL_MAX_CHARS", () => {
    expect(
      extractArgsZod.safeParse({
        queryHint: "x",
        maxChars: EXTRACT_PER_CALL_MAX_CHARS + 1,
      }).success,
    ).toBe(false);
  });

  it("rejects maxChars < 1", () => {
    expect(
      extractArgsZod.safeParse({ queryHint: "x", maxChars: 0 }).success,
    ).toBe(false);
  });
});

describe("askUserArgsZod", () => {
  it("accepts the common shape", () => {
    expect(
      askUserArgsZod.safeParse({
        question: "Which option?",
        contextSummary: "Two checkboxes visible.",
      }).success,
    ).toBe(true);
  });

  it("accepts optional screenshotKey", () => {
    expect(
      askUserArgsZod.safeParse({
        question: "?",
        contextSummary: "ctx",
        screenshotKey: "/api/browser-task/abc/screenshots/0.png",
      }).success,
    ).toBe(true);
  });

  it("rejects question over 512 chars", () => {
    expect(
      askUserArgsZod.safeParse({
        question: "x".repeat(600),
        contextSummary: "ctx",
      }).success,
    ).toBe(false);
  });
});

describe("yieldForClarificationArgsZod", () => {
  it("requires a uuid clarificationId", () => {
    expect(
      yieldForClarificationArgsZod.safeParse({ clarificationId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      yieldForClarificationArgsZod.safeParse({
        clarificationId: "00000000-0000-4000-8000-000000000000",
      }).success,
    ).toBe(true);
  });
});

describe("finishArgsZod", () => {
  it("accepts a non-empty report + empty screenshot array", () => {
    expect(
      finishArgsZod.safeParse({ report: "Done.", screenshotKeys: [] })
        .success,
    ).toBe(true);
  });

  it("rejects an empty report", () => {
    expect(
      finishArgsZod.safeParse({ report: "", screenshotKeys: [] }).success,
    ).toBe(false);
  });

  it("rejects more than 50 screenshot keys", () => {
    expect(
      finishArgsZod.safeParse({
        report: "Done.",
        screenshotKeys: Array.from({ length: 60 }, (_, i) => `${i}.png`),
      }).success,
    ).toBe(false);
  });
});

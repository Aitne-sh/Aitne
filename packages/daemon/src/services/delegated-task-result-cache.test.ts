import { describe, expect, it } from "vitest";
import {
  DelegatedTaskResultCache,
  execScope,
  integrationVersionFor,
  runScope,
  type DelegatedTaskCacheEntry,
  type DelegatedTaskCacheKey,
} from "./delegated-task-result-cache.js";

const COST = {
  tokensInput: 100,
  tokensOutput: 50,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0.001,
  durationMs: 1000,
  numTurns: 2,
} as const;

function makeEntry(label: string): DelegatedTaskCacheEntry {
  return {
    result: { label },
    needsConfirmation: false,
    confirmationPlan: null,
    cost: { ...COST },
    trace: [],
    backendId: "claude",
    modelId: "claude-haiku-4-5",
    retried: false,
  };
}

function makeKey(overrides: Partial<DelegatedTaskCacheKey> = {}): DelegatedTaskCacheKey {
  return {
    scope: "exec:gmail",
    task: "search for emails from alice",
    outputSchema: { type: "object" },
    modelId: "claude-haiku-4-5",
    backendId: "claude",
    allowDestructive: false,
    integrationVersion: "v1",
    ...overrides,
  };
}

describe("DelegatedTaskResultCache constructor validation", () => {
  it("throws on non-positive ttlMs", () => {
    expect(() => new DelegatedTaskResultCache({ ttlMs: 0, maxEntries: 10 }))
      .toThrow(/ttlMs must be > 0/);
    expect(() => new DelegatedTaskResultCache({ ttlMs: -1, maxEntries: 10 }))
      .toThrow(/ttlMs must be > 0/);
    expect(() => new DelegatedTaskResultCache({ ttlMs: NaN, maxEntries: 10 }))
      .toThrow(/ttlMs must be > 0/);
  });

  it("throws on non-positive maxEntries", () => {
    expect(() => new DelegatedTaskResultCache({ ttlMs: 60_000, maxEntries: 0 }))
      .toThrow(/maxEntries must be > 0/);
    expect(() => new DelegatedTaskResultCache({ ttlMs: 60_000, maxEntries: NaN }))
      .toThrow(/maxEntries must be > 0/);
  });
});

describe("DelegatedTaskResultCache.computeKey", () => {
  it("is deterministic across schema-key reordering", () => {
    const a = DelegatedTaskResultCache.computeKey(
      makeKey({ outputSchema: { type: "object", properties: { a: 1, b: 2 } } }),
    );
    const b = DelegatedTaskResultCache.computeKey(
      makeKey({ outputSchema: { properties: { b: 2, a: 1 }, type: "object" } }),
    );
    expect(a).toBe(b);
  });

  it("differs on backendId / modelId / scope / task / allowDestructive / integrationVersion", () => {
    const base = DelegatedTaskResultCache.computeKey(makeKey());
    expect(DelegatedTaskResultCache.computeKey(makeKey({ backendId: "gemini" })))
      .not.toBe(base);
    expect(DelegatedTaskResultCache.computeKey(makeKey({ modelId: "x" })))
      .not.toBe(base);
    expect(DelegatedTaskResultCache.computeKey(makeKey({ scope: "exec:notion" })))
      .not.toBe(base);
    expect(DelegatedTaskResultCache.computeKey(makeKey({ task: "different" })))
      .not.toBe(base);
    expect(DelegatedTaskResultCache.computeKey(makeKey({ allowDestructive: true })))
      .not.toBe(base);
    expect(DelegatedTaskResultCache.computeKey(makeKey({ integrationVersion: "v2" })))
      .not.toBe(base);
  });

  it("treats an undefined integrationVersion the same as the empty-string fallback", () => {
    // The `key.integrationVersion ?? ""` branch's null arm is reached when
    // integrationVersion is omitted entirely. The hash should match a key
    // that explicitly passes "".
    const undef = DelegatedTaskResultCache.computeKey(
      makeKey({ integrationVersion: undefined }),
    );
    const empty = DelegatedTaskResultCache.computeKey(
      makeKey({ integrationVersion: "" }),
    );
    expect(undef).toBe(empty);
  });

  it("array order in schema is significant", () => {
    const a = DelegatedTaskResultCache.computeKey(
      makeKey({ outputSchema: { enum: ["a", "b"] } }),
    );
    const b = DelegatedTaskResultCache.computeKey(
      makeKey({ outputSchema: { enum: ["b", "a"] } }),
    );
    expect(a).not.toBe(b);
  });
});

describe("DelegatedTaskResultCache get/set + LRU + TTL", () => {
  it("returns the entry on hit", () => {
    let now = 1000;
    const cache = new DelegatedTaskResultCache({
      ttlMs: 60_000,
      maxEntries: 4,
      now: () => now,
    });
    const key = makeKey();
    cache.set(key, makeEntry("a"));
    const got = cache.get(key);
    expect(got).toBeTruthy();
    expect((got!.result as { label: string }).label).toBe("a");
  });

  it("returns undefined on miss", () => {
    const cache = new DelegatedTaskResultCache({ ttlMs: 60_000, maxEntries: 4 });
    expect(cache.get(makeKey())).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it("evicts entries past TTL on get", () => {
    let now = 1000;
    const cache = new DelegatedTaskResultCache({
      ttlMs: 1000,
      maxEntries: 4,
      now: () => now,
    });
    const key = makeKey();
    cache.set(key, makeEntry("a"));
    now = 2500; // past TTL
    expect(cache.get(key)).toBeUndefined();
    expect(cache.stats().expirations).toBe(1);
    expect(cache.stats().size).toBe(0);
  });

  it("evicts LRU entry when over maxEntries", () => {
    let now = 1000;
    const cache = new DelegatedTaskResultCache({
      ttlMs: 60_000,
      maxEntries: 2,
      now: () => now,
    });
    cache.set(makeKey({ task: "a" }), makeEntry("a"));
    cache.set(makeKey({ task: "b" }), makeEntry("b"));
    // Read "a" to promote — "b" becomes LRU.
    cache.get(makeKey({ task: "a" }));
    cache.set(makeKey({ task: "c" }), makeEntry("c"));
    expect(cache.get(makeKey({ task: "a" }))).toBeTruthy();
    expect(cache.get(makeKey({ task: "b" }))).toBeUndefined();
    expect(cache.get(makeKey({ task: "c" }))).toBeTruthy();
    expect(cache.stats().evictions).toBe(1);
  });

  it("set on existing key promotes to MRU without growing size", () => {
    let now = 1000;
    const cache = new DelegatedTaskResultCache({
      ttlMs: 60_000,
      maxEntries: 2,
      now: () => now,
    });
    cache.set(makeKey({ task: "a" }), makeEntry("a"));
    cache.set(makeKey({ task: "b" }), makeEntry("b"));
    cache.set(makeKey({ task: "a" }), makeEntry("a-fresh"));
    cache.set(makeKey({ task: "c" }), makeEntry("c"));
    // "b" should be evicted because "a" was just refreshed.
    expect((cache.get(makeKey({ task: "a" }))!.result as { label: string }).label)
      .toBe("a-fresh");
    expect(cache.get(makeKey({ task: "b" }))).toBeUndefined();
  });

  it("clear() drops all entries", () => {
    const cache = new DelegatedTaskResultCache({ ttlMs: 60_000, maxEntries: 4 });
    cache.set(makeKey({ task: "a" }), makeEntry("a"));
    cache.set(makeKey({ task: "b" }), makeEntry("b"));
    cache.clear();
    expect(cache.stats().size).toBe(0);
    expect(cache.get(makeKey({ task: "a" }))).toBeUndefined();
  });

  it("prune() removes only expired idle entries", () => {
    let now = 1000;
    const cache = new DelegatedTaskResultCache({
      ttlMs: 1000,
      maxEntries: 4,
      now: () => now,
    });
    cache.set(makeKey({ task: "a" }), makeEntry("a"));
    now = 2500;
    cache.set(makeKey({ task: "b" }), makeEntry("b"));
    expect(cache.prune()).toBe(1);
    expect(cache.get(makeKey({ task: "a" }))).toBeUndefined();
    expect(cache.get(makeKey({ task: "b" }))).toBeTruthy();
  });
});

describe("integrationVersionFor + scope helpers", () => {
  it("integrationVersionFor returns lastChangedAt when present", () => {
    expect(integrationVersionFor({ lastChangedAt: "2026-04-29T00:00:00Z" }))
      .toBe("2026-04-29T00:00:00Z");
  });

  it("integrationVersionFor falls back to empty string", () => {
    expect(integrationVersionFor(undefined)).toBe("");
    expect(integrationVersionFor(null)).toBe("");
    expect(integrationVersionFor({})).toBe("");
  });

  it("execScope namespaces by integration key", () => {
    expect(execScope("gmail")).toBe("exec:gmail");
    expect(execScope("notion")).toBe("exec:notion");
  });

  it("runScope hashes allowedTools, order-insensitive", () => {
    const a = runScope(["mcp_x_tool", "mcp_y_tool"]);
    const b = runScope(["mcp_y_tool", "mcp_x_tool"]);
    expect(a).toBe(b);
    expect(a.startsWith("run:")).toBe(true);
  });

  it("runScope differs on different tool sets", () => {
    expect(runScope(["mcp_x_tool"])).not.toBe(runScope(["mcp_y_tool"]));
  });
});

describe("integration-version invalidation", () => {
  it("changing integrationVersion misses the previous entry", () => {
    const cache = new DelegatedTaskResultCache({ ttlMs: 60_000, maxEntries: 4 });
    cache.set(makeKey({ integrationVersion: "v1" }), makeEntry("a"));
    expect(cache.get(makeKey({ integrationVersion: "v1" }))).toBeTruthy();
    expect(cache.get(makeKey({ integrationVersion: "v2" }))).toBeUndefined();
  });
});

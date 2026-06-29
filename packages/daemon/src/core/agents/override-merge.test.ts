import { describe, expect, it } from "vitest";
import { type AgentDefinition, agentDefinitionSchema, OVERRIDE_EDIT_PATHS } from "@aitne/shared";
import {
  MERGEABLE_OVERRIDE_PATHS,
  mergeAgentDefinition,
} from "./override-merge.js";

/** A fully-populated, schema-valid built-in definition for merge inputs. */
function makeDefinition(overrides: Record<string, unknown> = {}): AgentDefinition {
  return agentDefinitionSchema.parse({
    slug: "morning-routine",
    name: "Morning Routine",
    description: "Daily check-in.",
    kind: "builtin",
    schedule: { kind: "cron", expression: "0 4 * * *", timezone: "UTC" },
    backend: { process_key: "routine.morning_routine", tier: "medium", model: null },
    limits: { max_turns: 30, max_budget_usd: 0.5, timeout_minutes: 15 },
    on_error: { retries: 0, retry_delay_seconds: 30, notify_owner: false },
    stop_warning: {
      level: "critical",
      services_lost: ["Daily state/today.md regeneration"],
      dependent_agents: [],
    },
    ...overrides,
  });
}

describe("MERGEABLE_OVERRIDE_PATHS", () => {
  it("is the frozen §6.4.1 allow-list", () => {
    expect([...MERGEABLE_OVERRIDE_PATHS]).toEqual([
      "enabled",
      "enabled_overridden_at",
      "backend.tier",
      "backend.model",
      "backend.backend_id",
      "limits.max_turns",
      "limits.max_budget_usd",
      "limits.timeout_minutes",
      "on_error.notify_owner",
    ]);
  });

  it("is derived from the shared OVERRIDE_EDIT_PATHS (single source of truth) + the two enabled* keys", () => {
    // Drift guard: MERGEABLE_OVERRIDE_PATHS must stay = the column-authority
    // enabled* keys + the shared field-edit allow-list. Re-hardcoding it (or a
    // 7th shared path) is caught here.
    expect([...MERGEABLE_OVERRIDE_PATHS]).toEqual([
      "enabled",
      "enabled_overridden_at",
      ...OVERRIDE_EDIT_PATHS,
    ]);
  });
});

describe("mergeAgentDefinition — base selection", () => {
  it("uses the shipped YAML as base when present", () => {
    const shipped = makeDefinition({ slug: "morning-routine" });
    const fallback = makeDefinition({ slug: "evening-review", name: "Evening Review" });
    const merged = mergeAgentDefinition(shipped, fallback, {});
    expect(merged.slug).toBe("morning-routine");
    expect(merged).toEqual(shipped);
  });

  it("falls back to the registry definition when no shipped YAML", () => {
    const fallback = makeDefinition({ slug: "evening-review", name: "Evening Review" });
    const merged = mergeAgentDefinition(null, fallback, {});
    expect(merged.slug).toBe("evening-review");
    expect(merged).toEqual(fallback);
  });

  it("never mutates its inputs", () => {
    const shipped = makeDefinition();
    const fallback = makeDefinition();
    const snapshot = { "limits.max_turns": 99, "backend.tier": "high" };
    const snapshotCopy = { ...snapshot };
    const merged = mergeAgentDefinition(shipped, fallback, snapshot);

    expect(merged).not.toBe(shipped);
    expect(shipped.limits.max_turns).toBe(30); // unchanged
    expect(shipped.backend.tier).toBe("medium"); // unchanged
    expect(snapshot).toEqual(snapshotCopy); // snapshot untouched
  });
});

describe("mergeAgentDefinition — override application", () => {
  it("empty snapshot leaves the base unchanged", () => {
    const shipped = makeDefinition();
    expect(mergeAgentDefinition(shipped, shipped, {})).toEqual(shipped);
  });

  it("ignores non-allow-listed snapshot keys", () => {
    const shipped = makeDefinition();
    const merged = mergeAgentDefinition(shipped, shipped, {
      slug: "hijacked",
      "backend.process_key": "message.dm",
      name: "Hijacked",
      "limits.max_turns": 7, // allow-listed → applied
    });
    expect(merged.slug).toBe("morning-routine");
    expect(merged.name).toBe("Morning Routine");
    expect(merged.backend.process_key).toBe("routine.morning_routine");
    expect(merged.limits.max_turns).toBe(7); // the one allow-listed key took effect
  });

  it("applies only the snapshot's keys (partial merge)", () => {
    const shipped = makeDefinition();
    const merged = mergeAgentDefinition(shipped, shipped, {
      "backend.tier": "high",
    });
    expect(merged.backend.tier).toBe("high");
    expect(merged.limits.max_turns).toBe(30); // other fields untouched
    expect(merged.on_error.notify_owner).toBe(false);
  });

  it("applies every allow-listed field when present", () => {
    const shipped = makeDefinition();
    const merged = mergeAgentDefinition(shipped, shipped, {
      enabled: false,
      "backend.tier": "high",
      "backend.model": "claude-opus-4-8",
      "backend.backend_id": "claude",
      "limits.max_turns": 50,
      "limits.max_budget_usd": 2.5,
      "limits.timeout_minutes": 25,
      "on_error.notify_owner": true,
    });
    expect(merged.enabled).toBe(false);
    expect(merged.backend.tier).toBe("high");
    expect(merged.backend.model).toBe("claude-opus-4-8");
    expect(merged.backend.backend_id).toBe("claude");
    expect(merged.limits.max_turns).toBe(50);
    expect(merged.limits.max_budget_usd).toBe(2.5);
    expect(merged.limits.timeout_minutes).toBe(25);
    expect(merged.on_error.notify_owner).toBe(true);
  });

  it("accepts null for backend.tier and backend.model (defer to config)", () => {
    const shipped = makeDefinition({ backend: { process_key: "routine.morning_routine", tier: "medium", model: "claude-sonnet-4-6" } });
    const merged = mergeAgentDefinition(shipped, shipped, {
      "backend.tier": null,
      "backend.model": null,
    });
    expect(merged.backend.tier).toBeNull();
    expect(merged.backend.model).toBeNull();
  });

  it("treats enabled_overridden_at as a no-op (metadata sidecar, not a definition field)", () => {
    const shipped = makeDefinition();
    const merged = mergeAgentDefinition(shipped, shipped, {
      enabled_overridden_at: 1_700_000_000_000,
    });
    expect(merged).toEqual(shipped);
  });
});

describe("mergeAgentDefinition — out-of-contract values are dropped (base survives)", () => {
  it("drops a non-boolean enabled", () => {
    const shipped = makeDefinition({ enabled: true });
    const merged = mergeAgentDefinition(shipped, shipped, { enabled: "yes" });
    expect(merged.enabled).toBe(true);
  });

  it("drops an unknown backend.tier (string and non-string)", () => {
    const shipped = makeDefinition();
    expect(
      mergeAgentDefinition(shipped, shipped, { "backend.tier": "ultra" }).backend.tier,
    ).toBe("medium");
    expect(
      mergeAgentDefinition(shipped, shipped, { "backend.tier": 3 }).backend.tier,
    ).toBe("medium");
  });

  it("drops an empty-string or non-string backend.model", () => {
    const shipped = makeDefinition({ backend: { process_key: "routine.morning_routine", tier: "medium", model: "claude-sonnet-4-6" } });
    expect(
      mergeAgentDefinition(shipped, shipped, { "backend.model": "" }).backend.model,
    ).toBe("claude-sonnet-4-6");
    expect(
      mergeAgentDefinition(shipped, shipped, { "backend.model": 42 }).backend.model,
    ).toBe("claude-sonnet-4-6");
  });

  it("accepts null and drops an unknown backend.backend_id", () => {
    const shipped = makeDefinition();
    expect(
      mergeAgentDefinition(shipped, shipped, { "backend.backend_id": "codex" }).backend.backend_id,
    ).toBe("codex");
    expect(
      mergeAgentDefinition(shipped, shipped, { "backend.backend_id": null }).backend.backend_id,
    ).toBeNull();
    expect(
      mergeAgentDefinition(shipped, shipped, { "backend.backend_id": "not-a-backend" }).backend.backend_id,
    ).toBe(shipped.backend.backend_id);
    expect(
      mergeAgentDefinition(shipped, shipped, { "backend.backend_id": 7 }).backend.backend_id,
    ).toBe(shipped.backend.backend_id);
  });

  it("drops a non-positive / non-integer / non-number max_turns", () => {
    const shipped = makeDefinition({ limits: { max_turns: 30, max_budget_usd: 0.5, timeout_minutes: 15 } });
    expect(mergeAgentDefinition(shipped, shipped, { "limits.max_turns": 0 }).limits.max_turns).toBe(30);
    expect(mergeAgentDefinition(shipped, shipped, { "limits.max_turns": 1.5 }).limits.max_turns).toBe(30);
    expect(mergeAgentDefinition(shipped, shipped, { "limits.max_turns": "5" }).limits.max_turns).toBe(30);
  });

  it("drops a negative / NaN / Infinity / non-number max_budget_usd", () => {
    const shipped = makeDefinition({ limits: { max_turns: 30, max_budget_usd: 0.5, timeout_minutes: 15 } });
    expect(mergeAgentDefinition(shipped, shipped, { "limits.max_budget_usd": -1 }).limits.max_budget_usd).toBe(0.5);
    expect(mergeAgentDefinition(shipped, shipped, { "limits.max_budget_usd": Number.NaN }).limits.max_budget_usd).toBe(0.5);
    expect(mergeAgentDefinition(shipped, shipped, { "limits.max_budget_usd": Number.POSITIVE_INFINITY }).limits.max_budget_usd).toBe(0.5);
    expect(mergeAgentDefinition(shipped, shipped, { "limits.max_budget_usd": "1.0" }).limits.max_budget_usd).toBe(0.5);
  });

  it("accepts max_budget_usd of 0 (free / soft-cap-disabled)", () => {
    const shipped = makeDefinition({ limits: { max_turns: 30, max_budget_usd: 0.5, timeout_minutes: 15 } });
    expect(
      mergeAgentDefinition(shipped, shipped, { "limits.max_budget_usd": 0 }).limits.max_budget_usd,
    ).toBe(0);
  });

  it("drops a non-positive / non-integer timeout_minutes", () => {
    const shipped = makeDefinition({ limits: { max_turns: 30, max_budget_usd: 0.5, timeout_minutes: 15 } });
    expect(mergeAgentDefinition(shipped, shipped, { "limits.timeout_minutes": -5 }).limits.timeout_minutes).toBe(15);
    expect(mergeAgentDefinition(shipped, shipped, { "limits.timeout_minutes": 2.2 }).limits.timeout_minutes).toBe(15);
  });

  it("drops a non-boolean on_error.notify_owner", () => {
    const shipped = makeDefinition({ on_error: { retries: 0, retry_delay_seconds: 30, notify_owner: true } });
    expect(
      mergeAgentDefinition(shipped, shipped, { "on_error.notify_owner": 1 }).on_error.notify_owner,
    ).toBe(true);
  });
});

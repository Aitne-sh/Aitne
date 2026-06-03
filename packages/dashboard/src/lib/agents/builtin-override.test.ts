import { describe, expect, it } from "vitest";
import { agentDefinitionSchema, OVERRIDE_EDIT_PATHS, type AgentDefinition } from "@aitne/shared";
import {
  BUILTIN_OVERRIDE_FIELDS,
  buildBuiltinPatchBody,
  buildOverrideResetBody,
  extractOverrideValues,
  overriddenFieldKeys,
  validateOverrideValue,
  validateOverrideValues,
  type OverrideValues,
} from "./builtin-override";

function definition(over: Partial<AgentDefinition> = {}): AgentDefinition {
  const base = agentDefinitionSchema.parse({
    slug: "morning-routine",
    name: "Morning Routine",
    description: "Daily check-in",
    kind: "builtin",
    schedule: { kind: "cron", expression: "0 4 * * *", timezone: "UTC" },
    backend: { process_key: "routine.morning_routine" },
    limits: { max_turns: 20, max_budget_usd: 0.25, timeout_minutes: 10 },
    stop_warning: { level: "critical", services_lost: ["today.md"] },
  });
  return { ...base, ...over };
}

describe("extractOverrideValues", () => {
  it("reads the editable fields from a definition", () => {
    const def = definition();
    expect(extractOverrideValues(def)).toEqual({
      "backend.tier": null,
      "backend.model": null,
      "limits.max_turns": 20,
      "limits.max_budget_usd": 0.25,
      "limits.timeout_minutes": 10,
      "on_error.notify_owner": false,
    });
  });
});

describe("validateOverrideValue", () => {
  it("accepts valid values per field", () => {
    expect(validateOverrideValue("backend.tier", "medium")).toBeNull();
    expect(validateOverrideValue("backend.tier", null)).toBeNull();
    expect(validateOverrideValue("backend.model", "claude-opus-4-8")).toBeNull();
    expect(validateOverrideValue("backend.model", null)).toBeNull();
    expect(validateOverrideValue("limits.max_turns", 5)).toBeNull();
    expect(validateOverrideValue("limits.timeout_minutes", 1)).toBeNull();
    expect(validateOverrideValue("limits.max_budget_usd", 0)).toBeNull();
    expect(validateOverrideValue("on_error.notify_owner", true)).toBeNull();
  });

  it("rejects invalid values per field", () => {
    expect(validateOverrideValue("backend.tier", "huge")).not.toBeNull();
    expect(validateOverrideValue("backend.model", "")).not.toBeNull();
    expect(validateOverrideValue("limits.max_turns", 0)).not.toBeNull();
    expect(validateOverrideValue("limits.max_turns", 2.5)).not.toBeNull();
    expect(validateOverrideValue("limits.timeout_minutes", -1)).not.toBeNull();
    expect(validateOverrideValue("limits.max_budget_usd", -0.01)).not.toBeNull();
    expect(validateOverrideValue("on_error.notify_owner", "yes" as never)).not.toBeNull();
  });
});

describe("validateOverrideValues", () => {
  it("returns only the failing fields", () => {
    const values: OverrideValues = {
      "backend.tier": "nope",
      "backend.model": null,
      "limits.max_turns": 20,
      "limits.max_budget_usd": -5,
      "limits.timeout_minutes": 10,
      "on_error.notify_owner": false,
    };
    const errors = validateOverrideValues(values);
    expect(Object.keys(errors).sort()).toEqual(["backend.tier", "limits.max_budget_usd"]);
  });

  it("returns no errors for a clean set", () => {
    expect(validateOverrideValues(extractOverrideValues(definition()))).toEqual({});
  });
});

describe("buildBuiltinPatchBody", () => {
  it("nests only changed fields under their parent block", () => {
    const original = extractOverrideValues(definition());
    const edited: OverrideValues = {
      ...original,
      "backend.tier": "high",
      "limits.max_turns": 30,
      "on_error.notify_owner": true,
    };
    const { body, changedKeys } = buildBuiltinPatchBody(original, edited);
    expect(changedKeys.sort()).toEqual(["backend.tier", "limits.max_turns", "on_error.notify_owner"]);
    expect(body).toEqual({
      backend: { tier: "high" },
      limits: { max_turns: 30 },
      on_error: { notify_owner: true },
    });
  });

  it("produces an empty body when nothing changed", () => {
    const original = extractOverrideValues(definition());
    const { body, changedKeys } = buildBuiltinPatchBody(original, { ...original });
    expect(body).toEqual({});
    expect(changedKeys).toEqual([]);
  });

  it("treats a null↔value change as a change", () => {
    const original = extractOverrideValues(definition());
    const { body, changedKeys } = buildBuiltinPatchBody(original, {
      ...original,
      "backend.model": "claude-sonnet-4-6",
    });
    expect(changedKeys).toEqual(["backend.model"]);
    expect(body).toEqual({ backend: { model: "claude-sonnet-4-6" } });
  });
});

describe("buildOverrideResetBody", () => {
  it("wraps the paths in a reset array", () => {
    expect(buildOverrideResetBody(["backend.tier", "limits.max_turns"])).toEqual({
      reset: ["backend.tier", "limits.max_turns"],
    });
  });
});

describe("overriddenFieldKeys", () => {
  it("lists snapshot keys that are editable fields", () => {
    expect(overriddenFieldKeys(null)).toEqual([]);
    expect(
      overriddenFieldKeys({ "backend.tier": "high", "unrelated.key": 1, "limits.max_turns": 30 }),
    ).toEqual(["backend.tier", "limits.max_turns"]);
  });
});

describe("BUILTIN_OVERRIDE_FIELDS", () => {
  it("covers exactly the shared OVERRIDE_EDIT_PATHS allow-list (single source of truth)", () => {
    // Assert against the imported constant (not a hardcoded copy) so adding a
    // 7th override path to @aitne/shared fails here until the form is updated.
    expect(BUILTIN_OVERRIDE_FIELDS.map((f) => f.key)).toEqual([...OVERRIDE_EDIT_PATHS]);
  });
});

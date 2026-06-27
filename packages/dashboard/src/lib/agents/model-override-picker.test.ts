import { describe, expect, it } from "vitest";
import type { BackendModel } from "@aitne/shared";
import type { PickerGroup } from "@/components/chat/chat-model-picker.logic";
import {
  MODEL_DEFAULT_VALUE,
  modelOverrideFromSelection,
  modelOverrideSelectState,
} from "./model-override-picker";
import type { OverrideValues } from "./builtin-override";

function model(backendId: BackendModel["backendId"], modelId: string): BackendModel {
  return {
    backendId,
    modelId,
    label: modelId,
    tier: "medium",
    available: true,
  } as BackendModel;
}

function group(
  backendId: PickerGroup["backendId"],
  models: BackendModel[],
  overrides: Partial<PickerGroup> = {},
): PickerGroup {
  return {
    backendId,
    label: backendId,
    authBlocked: false,
    authStatus: "ok",
    models,
    ...overrides,
  };
}

function values(over: Partial<OverrideValues> = {}): OverrideValues {
  return {
    "backend.tier": null,
    "backend.model": null,
    "backend.backend_id": null,
    "limits.max_turns": 20,
    "limits.max_budget_usd": 0.25,
    "limits.timeout_minutes": 10,
    "on_error.notify_owner": false,
    ...over,
  };
}

const GROUPS: PickerGroup[] = [
  group("claude", [model("claude", "claude-sonnet-4-6"), model("claude", "claude-opus-4-8")]),
  group("codex", [model("codex", "gpt-5.4")]),
];

describe("modelOverrideSelectState", () => {
  it("maps a null model to the default option with no legacy entry", () => {
    expect(modelOverrideSelectState(values(), GROUPS)).toEqual({
      value: MODEL_DEFAULT_VALUE,
      legacyOption: null,
    });
  });

  it("encodes a stored (model, backend_id) pair found in the catalog", () => {
    const state = modelOverrideSelectState(
      values({ "backend.model": "gpt-5.4", "backend.backend_id": "codex" }),
      GROUPS,
    );
    expect(state).toEqual({ value: "codex::gpt-5.4", legacyOption: null });
  });

  it("infers the backend for a legacy model-only pin that exists in the catalog", () => {
    const state = modelOverrideSelectState(
      values({ "backend.model": "claude-opus-4-8" }),
      GROUPS,
    );
    expect(state).toEqual({ value: "claude::claude-opus-4-8", legacyOption: null });
  });

  it("renders a legacy option for a pin no catalog backend knows", () => {
    const state = modelOverrideSelectState(
      values({ "backend.model": "totally-custom-model" }),
      GROUPS,
    );
    expect(state.legacyOption).not.toBeNull();
    expect(state.value).toBe(state.legacyOption!.value);
    expect(state.legacyOption!.label).toContain("totally-custom-model");
  });

  it("renders a legacy option when the stored backend no longer lists the model", () => {
    const state = modelOverrideSelectState(
      values({ "backend.model": "gpt-5.4", "backend.backend_id": "claude" }),
      GROUPS,
    );
    expect(state.legacyOption).not.toBeNull();
  });
});

describe("modelOverrideFromSelection", () => {
  it("maps the default option to a cleared pair", () => {
    expect(modelOverrideFromSelection(MODEL_DEFAULT_VALUE)).toEqual({
      model: null,
      backendId: null,
    });
  });

  it("maps an encoded selection to its pair", () => {
    expect(modelOverrideFromSelection("codex::gpt-5.4")).toEqual({
      model: "gpt-5.4",
      backendId: "codex",
    });
  });

  it("treats re-selecting the legacy option as a no-op", () => {
    const state = modelOverrideSelectState(
      values({ "backend.model": "totally-custom-model" }),
      GROUPS,
    );
    expect(modelOverrideFromSelection(state.value)).toBeNull();
  });

  it("treats a malformed value as a no-op", () => {
    expect(modelOverrideFromSelection("no-separator")).toBeNull();
  });
});

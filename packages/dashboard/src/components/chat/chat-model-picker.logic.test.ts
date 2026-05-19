import { describe, it, expect } from "vitest";
import type { BackendModel } from "@aitne/shared";
import type { BackendStatusRow } from "../../lib/api-types";
import {
  AUTO_VALUE,
  buildPickerGroups,
  decodeSelection,
  encodeSelection,
  heavyTierHint,
} from "./chat-model-picker.logic";

function model(
  backendId: BackendModel["backendId"],
  modelId: string,
  overrides: Partial<BackendModel> = {},
): BackendModel {
  return {
    backendId,
    modelId,
    label: modelId,
    tier: "high",
    available: true,
    ...overrides,
  };
}

function row(overrides: Partial<BackendStatusRow>): BackendStatusRow {
  return {
    id: "claude",
    enabled: true,
    authMethod: "cli_login",
    authStatus: "ok",
    authCheckedAt: null,
    authDetail: null,
    lastError: null,
    webSearchEnabled: false,
    webSearchSupported: true,
    authFirstExpiredAt: null,
    authLastSuccessAt: null,
    authNotificationCount: 0,
    cliInstalled: true,
    cliCommand: "claude",
    models: [],
    ...overrides,
  } as BackendStatusRow;
}

describe("encodeSelection / decodeSelection", () => {
  it("round-trips a selection through the encoded string", () => {
    const sel = { backendId: "gemini" as const, modelId: "gemini-2.5-pro" };
    expect(decodeSelection(encodeSelection(sel))).toEqual(sel);
  });

  it("decodes the AUTO sentinel to null", () => {
    expect(decodeSelection(AUTO_VALUE)).toBeNull();
  });

  it("decodes a malformed value (no separator) to null rather than throwing", () => {
    expect(decodeSelection("no-separator-here")).toBeNull();
  });

  it("preserves model ids that contain the separator by using the first occurrence as split point", () => {
    // `::` inside a model id is pathological but should at least decode
    // deterministically: everything after the first `::` is the model id.
    const encoded = "codex::weird::model::id";
    expect(decodeSelection(encoded)).toEqual({
      backendId: "codex",
      modelId: "weird::model::id",
    });
  });
});

describe("buildPickerGroups", () => {
  it("drops disabled backends", () => {
    const groups = buildPickerGroups([
      row({ id: "claude", enabled: true, models: [model("claude", "claude-opus-4-6")] }),
      row({ id: "codex", enabled: false, models: [model("codex", "gpt-5")] }),
    ]);
    expect(groups.map((g) => g.backendId)).toEqual(["claude"]);
  });

  it("drops enabled backends that have no models (prevents empty group labels)", () => {
    const groups = buildPickerGroups([
      row({ id: "claude", enabled: true, models: [] }),
    ]);
    expect(groups).toEqual([]);
  });

  it("marks auth-blocked statuses but keeps the group rendered", () => {
    const groups = buildPickerGroups([
      row({
        id: "codex",
        enabled: true,
        authStatus: "expired",
        models: [model("codex", "gpt-5")],
      }),
    ]);
    expect(groups[0]!.authBlocked).toBe(true);
    expect(groups[0]!.authStatus).toBe("expired");
  });

  it("does NOT mark recovering/unknown as blocked (they may resolve)", () => {
    const groups = buildPickerGroups([
      row({ id: "gemini", enabled: true, authStatus: "recovering", models: [model("gemini", "gemini-2.5-pro")] }),
      row({ id: "codex", enabled: true, authStatus: "unknown", models: [model("codex", "gpt-5")] }),
    ]);
    expect(groups.find((g) => g.backendId === "gemini")!.authBlocked).toBe(false);
    expect(groups.find((g) => g.backendId === "codex")!.authBlocked).toBe(false);
  });

  it("sorts models heavy-first then light within a group", () => {
    const light = model("claude", "claude-sonnet-4-6", { tier: "medium", label: "Sonnet" });
    const heavy = model("claude", "claude-opus-4-6", { tier: "high", label: "Opus" });
    const groups = buildPickerGroups([
      row({ id: "claude", enabled: true, models: [light, heavy] }),
    ]);
    expect(groups[0]!.models.map((m) => m.modelId)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("pushes deprecated models to the bottom of their tier", () => {
    const current = model("claude", "claude-opus-4-7", { tier: "high", label: "Opus 4.7" });
    const legacy = model("claude", "claude-opus-4-6", {
      tier: "high",
      label: "Opus 4.6 (legacy)",
      deprecated: true,
    });
    const groups = buildPickerGroups([
      row({ id: "claude", enabled: true, models: [legacy, current] }),
    ]);
    expect(groups[0]!.models.map((m) => m.modelId)).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-6",
    ]);
  });
});

describe("heavyTierHint", () => {
  const groups = [
    {
      backendId: "claude" as const,
      label: "Claude",
      authBlocked: false,
      authStatus: "ok",
      models: [
        model("claude", "claude-opus-4-6", { tier: "high", label: "Opus 4.6" }),
        model("claude", "claude-sonnet-4-6", { tier: "medium", label: "Sonnet 4.6" }),
      ],
    },
    {
      backendId: "codex" as const,
      label: "Codex",
      authBlocked: false,
      authStatus: "ok",
      models: [model("codex", "gpt-5", { tier: "high", label: "GPT-5" })],
    },
  ];

  it("returns null when no override is set (Auto mode)", () => {
    expect(heavyTierHint(null, groups)).toBeNull();
  });

  it("returns null for light-tier picks", () => {
    expect(
      heavyTierHint(
        { backendId: "claude", modelId: "claude-sonnet-4-6" },
        groups,
      ),
    ).toBeNull();
  });

  it("shows the hint for any heavy-tier pick", () => {
    expect(
      heavyTierHint(
        { backendId: "claude", modelId: "claude-opus-4-6" },
        groups,
      ),
    ).toEqual({ backendId: "claude", modelLabel: "Opus 4.6" });
    expect(
      heavyTierHint({ backendId: "codex", modelId: "gpt-5" }, groups),
    ).toEqual({ backendId: "codex", modelLabel: "GPT-5" });
  });

  it("returns null for unregistered models (no label to show)", () => {
    expect(
      heavyTierHint(
        { backendId: "claude", modelId: "claude-experimental-x" },
        groups,
      ),
    ).toBeNull();
  });
});

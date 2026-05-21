import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  createEvent,
  EventPriority,
  type AgentResult,
  type Event,
  type MessageEvent,
} from "@aitne/shared";
import type { AgentConfig } from "../../config.js";
import { applySchema } from "../../db/schema.js";
import { BackendRouter, BackendRouterHandledError } from "./backend-router.js";
import { BackendDecisiveFailure, BackendQuotaError, type IAgentCore } from "../agent-core.js";
import { AuthTelemetry } from "./auth-telemetry.js";
import {
  DEFAULT_CLAUDE_LITE_MODEL,
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  latestMediumFor,
} from "./model-registry.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    dataDir: "/tmp/test",
    workspaceDir: ".",
    apiPort: 8321,
    character: "",
    disallowedTools: [],
    allowedToolsOverride: null,
  } as unknown as AgentConfig;
}

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    output: "ok",
    sessionId: null,
    backendId: "claude",
    modelId: "claude-opus-4-6",
    costUsd: 0,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    modelUsage: {},
    numTurns: 1,
    durationMs: 10,
    durationApiMs: 10,
    model: "claude-opus-4-6",
    isError: false,
    stopReason: null,
    contextUpdated: false,
    // advisorCallCount omitted on purpose — it's optional now, consumers
    // treat undefined as 0. Leaving it out confirms the optional contract.
    ...overrides,
  };
}

function makeCore(overrides: Partial<IAgentCore> = {}): IAgentCore {
  return {
    backendId: "claude",
    execute: vi.fn().mockResolvedValue(makeResult()),
    executeResume: vi.fn().mockResolvedValue(makeResult()),
    summarize: vi.fn().mockResolvedValue("summary"),
    checkAuth: vi.fn().mockResolvedValue({ ok: true, method: "cli_login" }),
    checkAuthDetailed: vi
      .fn()
      .mockResolvedValue({ ok: true, status: "ok", method: "cli_login" }),
    probeTools: vi.fn().mockResolvedValue([]),
    runDelegatedTool: vi.fn().mockRejectedValue(new Error("not implemented")),
    listModels: vi.fn().mockReturnValue([
      {
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        label: "claude-sonnet-4-6",
        tier: "medium",
        available: true,
      },
      {
        backendId: "claude",
        modelId: "claude-opus-4-6",
        label: "claude-opus-4-6",
        tier: "high",
        available: true,
      },
    ]),
    ...overrides,
  } as IAgentCore;
}

function makeDmEvent(): MessageEvent {
  return {
    ...createEvent({
      type: "message.received",
      source: "dashboard",
      priority: EventPriority.HIGH,
    }),
    sender: "user",
    channel: "ch-1",
    content: "hello",
    platform: "dashboard",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

function makeNotifier() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  };
}

describe("BackendRouter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
  });

  it("falls back to config defaults when multi-backend tables are absent", () => {
    applySchema(db);
    const router = new BackendRouter(db, makeConfig(), [makeCore()]);

    const binding = router.resolveBinding(makeDmEvent());

    // Conservative-by-default: dashboard.chat resolves to the LIGHT tier and
    // therefore the light-tier model + envelope from AgentConfig. Heavy is
    // reachable from this surface only via the dashboard chat picker, which
    // injects requestedTier='heavy' (covered in dedicated tests below).
    expect(binding.processKey).toBe("dashboard.chat");
    expect(binding.resolvedTier).toBe("medium");
    expect(binding.main).toEqual({
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetUsd: 1.0,
    });
    expect(binding.fallback).toBeNull();
  });

  it("uses process_backend_config when the schema is applied", () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET main_model = ?, max_turns = ?, max_budget_usd = ?
       WHERE process_key = 'dashboard.chat'`,
    ).run("claude-sonnet-custom", 99, 9.9);

    const router = new BackendRouter(db, makeConfig(), [makeCore()]);
    const binding = router.resolveBinding(makeDmEvent());

    // resolvedTier reflects the process-key default even when DB config
    // overrides the model. dashboard.chat now defaults to light.
    expect(binding.resolvedTier).toBe("medium");
    expect(binding.main).toEqual({
      backendId: "claude",
      modelId: "claude-sonnet-custom",
      maxTurns: 99,
      maxBudgetUsd: 9.9,
    });
  });

  it("keeps processConfig.main_model when requestedTier matches the pinned model's registry tier", () => {
    applySchema(db);
    // Pin dashboard.chat to a registered heavy model. Caller then requests
    // heavy — the pinned model already satisfies the request, so no override.
    db.prepare(
      `UPDATE process_backend_config
         SET main_model = 'claude-opus-4-6', max_turns = 99, max_budget_usd = 9.9
       WHERE process_key = 'dashboard.chat'`,
    ).run();

    const router = new BackendRouter(db, makeConfig(), [makeCore()]);
    const binding = router.resolveBinding(makeDmEvent(), {
      processKey: "dashboard.chat",
      requestedTier: "high",
    });

    expect(binding.resolvedTier).toBe("high");
    // Pinned model is preserved — 4-6 is still a registered heavy model
    // (deprecated, but deprecated != unavailable), so its tier matches the
    // request and no canonical-model substitution is applied.
    expect(binding.main).toEqual({
      backendId: "claude",
      modelId: "claude-opus-4-6",
      maxTurns: 99,
      maxBudgetUsd: 9.9,
    });
  });

  it("honours requestedTier as a HARD override when the pinned model is the wrong tier", () => {
    applySchema(db);
    // Simulate Pro preset: dashboard.chat pinned to Sonnet, user manually
    // picks Opus via dashboard chat model picker → requestedTier: 'heavy'.
    db.prepare(
      `UPDATE process_backend_config
         SET main_model = 'claude-sonnet-4-6', max_turns = 99, max_budget_usd = 9.9
       WHERE process_key = 'dashboard.chat'`,
    ).run();

    const router = new BackendRouter(db, makeConfig(), [makeCore()]);
    const binding = router.resolveBinding(makeDmEvent(), {
      processKey: "dashboard.chat",
      requestedTier: "high",
    });

    expect(binding.resolvedTier).toBe("high");
    // Model swapped to canonical high, max_turns/budget preserved.
    // Canonical high = DEFAULT_CLAUDE_HIGH_MODEL (claude-opus-4-7);
    // backend_global_defaults is seeded by applySchema above, so
    // resolveCanonicalTierModel picks the seeded value.
    expect(binding.main).toEqual({
      backendId: "claude",
      modelId: "claude-opus-4-7",
      maxTurns: 99,
      maxBudgetUsd: 9.9,
    });
    // Fallback is dropped on override.
    expect(binding.fallback).toBeNull();
  });

  it("override drops wrong-tier fallback binding", () => {
    applySchema(db);
    // Fallback is a wrong-tier model (Sonnet light) — dropping it keeps the
    // override honest. Caller asked for heavy; routing into Sonnet on main
    // failure would defeat the explicit request.
    db.prepare(
      `UPDATE process_backend_config
         SET main_model = 'claude-sonnet-4-6',
             fallback_backend = 'claude',
             fallback_model = 'claude-sonnet-4-6'
       WHERE process_key = 'dashboard.chat'`,
    ).run();

    const router = new BackendRouter(db, makeConfig(), [makeCore()]);
    const binding = router.resolveBinding(makeDmEvent(), {
      processKey: "dashboard.chat",
      requestedTier: "high",
    });

    expect(binding.main.modelId).toBe("claude-opus-4-7");
    expect(binding.fallback).toBeNull();
  });

  it("override preserves tier-compatible fallback binding", () => {
    applySchema(db);
    // Fallback is already at the requested tier (Opus heavy). The override
    // should swap main Sonnet→Opus but leave the fallback alone — the
    // fallback represents "plan B on decisive failure", not tier selection.
    db.prepare(
      `UPDATE process_backend_config
         SET main_model = 'claude-sonnet-4-6',
             fallback_backend = 'claude',
             fallback_model = 'claude-opus-4-6'
       WHERE process_key = 'dashboard.chat'`,
    ).run();

    const router = new BackendRouter(db, makeConfig(), [makeCore()]);
    const binding = router.resolveBinding(makeDmEvent(), {
      processKey: "dashboard.chat",
      requestedTier: "high",
    });

    expect(binding.main.modelId).toBe("claude-opus-4-7");
    expect(binding.fallback).not.toBeNull();
    expect(binding.fallback?.modelId).toBe("claude-opus-4-6");
  });

  it("override for requestedTier='light' swaps heavy-pinned model to Sonnet", () => {
    applySchema(db);
    // Max-like baseline: dashboard.chat pinned to Opus. User picks Sonnet.
    db.prepare(
      `UPDATE process_backend_config
         SET main_model = 'claude-opus-4-6'
       WHERE process_key = 'dashboard.chat'`,
    ).run();

    const router = new BackendRouter(db, makeConfig(), [makeCore()]);
    const binding = router.resolveBinding(makeDmEvent(), {
      processKey: "dashboard.chat",
      requestedTier: "medium",
    });

    expect(binding.main.modelId).toBe("claude-sonnet-4-6");
  });

  it("unknown pinned model is PRESERVED under explicit requestedTier (regression guard)", () => {
    applySchema(db);
    // User-supplied custom model id not in the registry → tier unknown.
    // Earlier buggy implementation clobbered this with a canonical registry
    // model. Correct behavior: trust the user's explicit choice.
    db.prepare(
      `UPDATE process_backend_config
         SET main_model = 'claude-opus-custom'
       WHERE process_key = 'dashboard.chat'`,
    ).run();

    const router = new BackendRouter(db, makeConfig(), [makeCore()]);
    const binding = router.resolveBinding(makeDmEvent(), {
      processKey: "dashboard.chat",
      requestedTier: "high",
    });

    expect(binding.main.modelId).toBe("claude-opus-custom");
  });

  describe("TIER_LOCKED clamp (DOCS_QA_B7_DESIGN.md S2)", () => {
    function makeDocsQAEvent(): Event {
      return {
        ...makeDmEvent(),
        intent: "docs_qa",
      } as Event;
    }

    // Mirrors the fallback chain `docs.ts:397` uses for `/qa/binding`:
    // resolve via `latestMediumFor("claude")` and fall back to
    // `DEFAULT_CLAUDE_MEDIUM_MODEL` when the registry is empty (clean
    // reinstall fixture). Computing the expected this way makes the test
    // forward-track a `DEFAULT_CLAUDE_MEDIUM_MODEL` bump instead of
    // silently breaking when the canonical medium model is rotated.
    const expectedMediumClaudeModel = latestMediumFor("claude") ?? DEFAULT_CLAUDE_MEDIUM_MODEL;

    it("forces dashboard.docs_qa to light tier even when an operator pinned heavy", () => {
      applySchema(db);
      // Operator pinned the QA process to a heavy model in /settings/models.
      // The cascade leaves user-edited rows alone, so without the runtime
      // clamp the QA panel would silently drain heavy quota.
      db.prepare(
        `UPDATE process_backend_config
            SET main_backend = 'claude',
                main_model = 'claude-opus-4-6',
                max_turns = 99,
                max_budget_usd = 9.9,
                updated_by = 'user'
          WHERE process_key = 'dashboard.docs_qa'`,
      ).run();

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(makeDocsQAEvent());

      expect(binding.processKey).toBe("dashboard.docs_qa");
      // Clamp wins: model resolves to the canonical light model, not the pin.
      expect(binding.resolvedTier).toBe("medium");
      expect(binding.main.backendId).toBe("claude");
      expect(binding.main.modelId).toBe(expectedMediumClaudeModel);
    });

    it("clamp also overrides an explicit requestedTier='heavy' hint", () => {
      applySchema(db);
      const router = new BackendRouter(db, makeConfig(), [makeCore()]);

      const binding = router.resolveBinding(makeDocsQAEvent(), {
        processKey: "dashboard.docs_qa",
        requestedTier: "high",
      });

      expect(binding.resolvedTier).toBe("medium");
      expect(binding.main.modelId).toBe(expectedMediumClaudeModel);
    });
  });

  it("unknown pinned model is preserved under requestedTier='light' too", () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET main_model = 'some-internal-tuned-sonnet'
       WHERE process_key = 'dashboard.chat'`,
    ).run();

    const router = new BackendRouter(db, makeConfig(), [makeCore()]);
    const binding = router.resolveBinding(makeDmEvent(), {
      processKey: "dashboard.chat",
      requestedTier: "medium",
    });

    expect(binding.main.modelId).toBe("some-internal-tuned-sonnet");
  });

  describe("explicit backend+model override (dashboard chat picker superset)", () => {
    it("HARD-overrides process_backend_config with the requested backend and model", () => {
      applySchema(db);
      // dashboard.chat pinned to Sonnet; user picks a different backend's model.
      db.prepare(
        `UPDATE process_backend_config
           SET main_model = 'claude-sonnet-4-6',
               fallback_backend = 'claude',
               fallback_model = 'claude-opus-4-6'
         WHERE process_key = 'dashboard.chat'`,
      ).run();

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "dashboard.chat",
        requestedBackendId: "codex",
        requestedModelId: "gpt-5.2-codex",
      });

      expect(binding.main.backendId).toBe("codex");
      expect(binding.main.modelId).toBe("gpt-5.2-codex");
      // Fallback is dropped — user explicitly picked a backend, we don't
      // silently reroute to the pinned Claude fallback.
      expect(binding.fallback).toBeNull();
    });

    it("preserves maxTurns and maxBudget from process_backend_config", () => {
      applySchema(db);
      db.prepare(
        `UPDATE process_backend_config
           SET max_turns = 77, max_budget_usd = 7.7
         WHERE process_key = 'dashboard.chat'`,
      ).run();

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "dashboard.chat",
        requestedBackendId: "claude",
        requestedModelId: "claude-opus-4-6",
      });

      expect(binding.main.maxTurns).toBe(77);
      expect(binding.main.maxBudgetUsd).toBe(7.7);
    });

    it("supersedes requestedTier when both are provided", () => {
      applySchema(db);
      const router = new BackendRouter(db, makeConfig(), [makeCore()]);

      // Both requestedTier="medium" and an explicit heavy model override.
      // The explicit pair wins — requestedTier is the legacy narrower hatch.
      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "dashboard.chat",
        requestedTier: "medium",
        requestedBackendId: "claude",
        requestedModelId: "claude-opus-4-6",
      });

      expect(binding.main.modelId).toBe("claude-opus-4-6");
    });

    it("trusts an unknown model id (custom pin) and uses the processKey default tier", () => {
      // This path is unreachable from the dashboard chat picker — SSE
      // `validateChatModelOverride` rejects unregistered (backendId, modelId)
      // pairs at the wire boundary before they get here. The test documents
      // the router's contract for OTHER potential callers of `resolveBinding`
      // (future internal callers, tests, scheduled tasks if the override
      // API were ever extended to them): when a custom model id lands here,
      // (a) don't clobber it with a canonical registry model, and
      // (b) size the envelope from the ProcessKey's default tier, not a
      // hardcoded "high".
      applySchema(db);
      const router = new BackendRouter(db, makeConfig(), [makeCore()]);

      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "dashboard.chat",
        requestedBackendId: "claude",
        requestedModelId: "claude-experimental-custom",
      });

      expect(binding.main.modelId).toBe("claude-experimental-custom");
      // dashboard.chat defaults to `light` — the fallback picks that up,
      // NOT hardcoded heavy.
      expect(binding.resolvedTier).toBe("medium");
    });

    it("unknown model id on a MEDIUM processKey defaults the envelope to medium", () => {
      // Mirror of the medium-processKey test above for morning_routine
      // (seeded with Sonnet under the API-key-first design). Guards the
      // fallback path from regressing back to a hardcoded tier.
      applySchema(db);
      const router = new BackendRouter(db, makeConfig(), [makeCore()]);

      const event = {
        ...makeDmEvent(),
        type: "routine.morning_routine",
        platform: "cron",
      };

      const binding = router.resolveBinding(event, {
        processKey: "routine.morning_routine",
        requestedBackendId: "claude",
        requestedModelId: "claude-experimental-custom",
      });

      expect(binding.main.modelId).toBe("claude-experimental-custom");
      expect(binding.resolvedTier).toBe("medium");
    });

    it("execute() forwards the explicit backend+model override into the internal resolveBinding", async () => {
      applySchema(db);
      const core = makeCore();
      const router = new BackendRouter(db, makeConfig(), [core]);

      await router.execute({
        event: makeDmEvent(),
        prompt: "p",
        context: "c",
        processKey: "dashboard.chat",
        requestedBackendId: "claude",
        requestedModelId: "claude-opus-4-6",
      });

      expect(core.execute).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "claude-opus-4-6" }),
        undefined,
      );
    });
  });

  describe("backend-only override (routine.fetch_window per-integration routing)", () => {
    // Added alongside the `RoutineFetchWindowRunner` per-integration
    // backend routing fix. The runner passes only `requestedBackendId`
    // (no `requestedModelId`) so the router picks the canonical model
    // for that backend at the process's resolved tier — preserving
    // routine.fetch_window's lite-tier envelope while spawning the
    // sub-session on the integration's bound backend (native or
    // userManagedConnector delegated).

    it("picks the canonical (backend, tier) model from global defaults", () => {
      applySchema(db);
      // routine.fetch_window seeds with main_backend=claude. Caller asks
      // to spawn on codex without specifying a model — router should
      // resolve a codex model at the seeded lite tier.
      const codexCore = makeCore({
        backendId: "codex",
        listModels: () => [
          {
            backendId: "codex",
            modelId: "gpt-5-mini",
            label: "gpt-5-mini",
            tier: "lite",
            available: true,
          },
          {
            backendId: "codex",
            modelId: "gpt-5.2-codex",
            label: "gpt-5.2-codex",
            tier: "medium",
            available: true,
          },
        ],
      });
      const router = new BackendRouter(db, makeConfig(), [makeCore(), codexCore]);

      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "routine.fetch_window",
        requestedBackendId: "codex",
      });

      expect(binding.main.backendId).toBe("codex");
      // resolveDefaultModelId prefers default-backend defaults when matched;
      // when the override backend ≠ default, it walks the core's
      // listModels() for the resolved tier. routine.fetch_window's
      // default tier is "lite".
      expect(binding.main.modelId).toBe("gpt-5-mini");
      expect(binding.resolvedTier).toBe("lite");
      // Fallback dropped — caller pinned a backend, silently rerouting
      // to a different backend would defeat the per-integration routing.
      expect(binding.fallback).toBeNull();
    });

    it("inherits maxTurns / maxBudgetUsd from process_backend_config", () => {
      applySchema(db);
      // routine.fetch_window's seed: max_turns=20, max_budget_usd=0.50.
      const codexCore = makeCore({
        backendId: "codex",
        listModels: () => [
          {
            backendId: "codex",
            modelId: "gpt-5-mini",
            label: "gpt-5-mini",
            tier: "lite",
            available: true,
          },
        ],
      });
      const router = new BackendRouter(db, makeConfig(), [makeCore(), codexCore]);

      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "routine.fetch_window",
        requestedBackendId: "codex",
      });

      // Envelope from the seed row — backend swap doesn't reset caps.
      expect(binding.main.maxTurns).toBe(20);
      expect(binding.main.maxBudgetUsd).toBe(0.5);
    });

    it("reuses processConfig.main_model when override backend equals processConfig.main_backend (seed case)", () => {
      applySchema(db);
      // routine.fetch_window seed: main_backend=claude, main_model=haiku.
      // For the canonical seed the result equals the resolveDefaultModelId
      // path, but the route through pin-preservation is what protects
      // operators who customised main_model (see next test).
      const router = new BackendRouter(db, makeConfig(), [makeCore()]);

      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "routine.fetch_window",
        requestedBackendId: "claude",
      });

      expect(binding.main.backendId).toBe("claude");
      expect(binding.main.modelId).toMatch(/^claude-haiku/);
      expect(binding.fallback).toBeNull();
    });

    it("preserves operator's non-canonical pin when override backend matches processConfig.main_backend", () => {
      // Regression guard for the per-integration backend routing fix:
      // the runner ALWAYS passes `requestedBackendId` (including for
      // sub-plans whose required backend equals the default), so this
      // branch must reuse `processConfig.main_model` instead of
      // resolving the canonical (backend, tier) model. Without
      // pin-preservation, an operator who pinned `routine.fetch_window`
      // to Sonnet (e.g. Pro preset) would silently get Haiku on every
      // direct/delegated-same sub-session.
      applySchema(db);
      db.prepare(
        `UPDATE process_backend_config
           SET main_model = 'claude-sonnet-4-6'
         WHERE process_key = 'routine.fetch_window'`,
      ).run();

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "routine.fetch_window",
        requestedBackendId: "claude",
      });

      expect(binding.main.backendId).toBe("claude");
      expect(binding.main.modelId).toBe("claude-sonnet-4-6");
    });

    it("swaps pin to canonical when explicit requestedTier disagrees with the pinned tier (escalation)", () => {
      // The runner escalates the pre-pass to medium tier on retry via
      // `prePassRetryEscalationTier`. When the operator pinned the
      // canonical lite model and the runner asks for medium, the
      // canonical medium model must win — mirrors the no-override
      // branch's `maybeApplyTierOverride` semantics so escalation
      // produces the same result whether or not a backend override is
      // also in play.
      applySchema(db);
      // Pin to the registered lite model so `tierFromModelId` returns
      // "lite" (the swap is gated on registered-tier mismatch — see
      // pinnedTier-null defense in `trusts a custom pin` below).
      db.prepare(
        `UPDATE process_backend_config
           SET main_model = ?
         WHERE process_key = 'routine.fetch_window'`,
      ).run(DEFAULT_CLAUDE_LITE_MODEL);

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "routine.fetch_window",
        requestedBackendId: "claude",
        requestedTier: "medium",
      });

      expect(binding.main.backendId).toBe("claude");
      expect(binding.main.modelId).toBe(DEFAULT_CLAUDE_MEDIUM_MODEL);
      expect(binding.resolvedTier).toBe("medium");
    });

    it("trusts a custom pin (unknown registry tier) even when requestedTier is set", () => {
      // Same trust contract as `maybeApplyTierOverride`: an unknown
      // pinned tier (custom model id) is preserved verbatim, avoiding a
      // silent clobber of operator-supplied internal models.
      applySchema(db);
      db.prepare(
        `UPDATE process_backend_config
           SET main_model = 'claude-experimental-internal'
         WHERE process_key = 'routine.fetch_window'`,
      ).run();

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "routine.fetch_window",
        requestedBackendId: "claude",
        requestedTier: "medium",
      });

      expect(binding.main.modelId).toBe("claude-experimental-internal");
    });

    it("combined override (requestedBackendId + requestedModelId) takes priority over backend-only", () => {
      applySchema(db);
      // Sanity check that the existing combined-override branch still
      // wins when both fields are set — the new backend-only branch
      // must not shadow it.
      const router = new BackendRouter(db, makeConfig(), [makeCore()]);

      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "dashboard.chat",
        requestedBackendId: "claude",
        requestedModelId: "claude-opus-4-6",
      });

      expect(binding.main.modelId).toBe("claude-opus-4-6");
    });
  });

  it("execute() without preResolvedBinding still honors requestedTier override", async () => {
    applySchema(db);
    // Pro-preset shape: dashboard.chat pinned to Sonnet.
    db.prepare(
      `UPDATE process_backend_config
         SET main_model = 'claude-sonnet-4-6'
       WHERE process_key = 'dashboard.chat'`,
    ).run();

    const core = makeCore();
    const router = new BackendRouter(db, makeConfig(), [core]);

    // Call execute WITHOUT preResolvedBinding — forces the internal
    // resolveBinding path. Pass requestedTier directly.
    await router.execute({
      event: makeDmEvent(),
      prompt: "p",
      context: "c",
      processKey: "dashboard.chat",
      requestedTier: "high",
    });

    // Core.execute should be called with the OVERRIDDEN model id.
    expect(core.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "claude-opus-4-7",
      }),
      undefined,
    );
  });

  it("passes the resolved binding into the selected backend core", async () => {
    applySchema(db);
    const core = makeCore();
    const router = new BackendRouter(db, makeConfig(), [core]);
    const event = makeDmEvent();

    await router.execute({
      event,
      prompt: "prompt",
      context: "context",
      processKey: "dashboard.chat",
    });

    // dashboard.chat now seeds to the LIGHT envelope (Sonnet, 50 turns,
    // $1.00) under the conservative-by-default tier policy. The
    // dashboard chat picker is the explicit-Opus escape hatch and is
    // exercised by the requestedTier='heavy' tests above.
    expect(core.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        event,
        modelId: "claude-sonnet-4-6",
        maxTurns: 50,
        maxBudgetUsd: 1.0,
      }),
      undefined,
    );
  });

  it("falls back to the configured fallback backend on typed quota failures", async () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET fallback_backend = ?, fallback_model = ?
       WHERE process_key = 'dashboard.chat'`,
    ).run("codex", "gpt-5.4");

    const mainCore = makeCore({
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("claude", "rate_limited", null, "quota exceeded"),
      ),
    });
    const fallbackCore = makeCore({
      backendId: "codex",
      execute: vi.fn().mockResolvedValue(
        makeResult({
          backendId: "codex",
          modelId: "gpt-5.4",
          model: "gpt-5.4",
        }),
      ),
      listModels: vi.fn().mockReturnValue([
        {
          backendId: "codex",
          modelId: "gpt-5.4",
          label: "gpt-5.4",
          tier: "high",
          available: true,
        },
      ]),
    });

    const router = new BackendRouter(db, makeConfig(), [mainCore, fallbackCore]);
    const result = await router.execute({
      event: makeDmEvent(),
      prompt: "prompt",
      context: "context",
      processKey: "dashboard.chat",
    });

    expect(mainCore.execute).toHaveBeenCalledTimes(1);
    expect(fallbackCore.execute).toHaveBeenCalledTimes(1);
    expect(result.backendId).toBe("codex");
    expect(result.modelId).toBe("gpt-5.4");
  });

  it("calls prepareSessionDir before executing fallback when sessionDir is provided", async () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET fallback_backend = ?, fallback_model = ?
       WHERE process_key = 'dashboard.chat'`,
    ).run("codex", "gpt-5.4");

    const mainCore = makeCore({
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("claude", "rate_limited", null, "quota exceeded"),
      ),
    });
    const fallbackCore = makeCore({
      backendId: "codex",
      execute: vi.fn().mockResolvedValue(
        makeResult({ backendId: "codex", modelId: "gpt-5.4", model: "gpt-5.4" }),
      ),
      listModels: vi.fn().mockReturnValue([
        { backendId: "codex", modelId: "gpt-5.4", label: "gpt-5.4", tier: "high", available: true },
      ]),
    });

    const prepareSessionDir = vi.fn();
    const router = new BackendRouter(
      db,
      makeConfig(),
      [mainCore, fallbackCore],
      undefined,
      undefined,
      prepareSessionDir,
    );

    await router.execute({
      event: makeDmEvent(),
      prompt: "prompt",
      context: "context",
      processKey: "dashboard.chat",
      sessionDir: "/tmp/pa-test-session",
    });

    expect(prepareSessionDir).toHaveBeenCalledTimes(1);
    // WIKI_BUILDER_DESIGN.md §9.6 — the 5th positional arg is the wiki
    // workspace name lifted from `event.data.workspace` so a Claude →
    // Codex fallback re-materialises with the right per-workspace
    // skill bundle. For non-wiki events the field is `undefined`.
    //
    // docs/design/appendices/skills-improvement.md §9-§11 + §14 — the 6th positional arg
    // is the inbound message text (for `MessageEvent` only) so the
    // fallback's `gmailLifestyleActiveForDm` / `managedTasksActiveForDm`
    // predicates see the same trigger surface the main side saw. Pins
    // the propagation so a future fallback-path refactor can't drop
    // the field and silently regress the manifest symmetry contract.
    expect(prepareSessionDir).toHaveBeenCalledWith(
      "/tmp/pa-test-session",
      "codex",
      "message.received",
      "dashboard.chat",
      undefined,
      "hello",
    );
  });

  it("prefers workdirEventType / workdirProcessKey overrides when passed to fallback", async () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET fallback_backend = ?, fallback_model = ?
       WHERE process_key = 'dashboard.chat'`,
    ).run("codex", "gpt-5.4");

    const mainCore = makeCore({
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("claude", "rate_limited", null, "quota exceeded"),
      ),
    });
    const fallbackExecute = vi.fn().mockResolvedValue(
      makeResult({ backendId: "codex", modelId: "gpt-5.4", model: "gpt-5.4" }),
    );
    const fallbackCore = makeCore({
      backendId: "codex",
      execute: fallbackExecute,
      listModels: vi.fn().mockReturnValue([
        { backendId: "codex", modelId: "gpt-5.4", label: "gpt-5.4", tier: "high", available: true },
      ]),
    });

    const prepareSessionDir = vi.fn();
    const router = new BackendRouter(
      db,
      makeConfig(),
      [mainCore, fallbackCore],
      undefined,
      undefined,
      prepareSessionDir,
    );

    const reassemble = vi.fn((bid: string) => `prompt-for-${bid}`);
    await router.execute({
      event: makeDmEvent(),
      prompt: "prompt-for-claude",
      context: "context",
      processKey: "dashboard.chat",
      sessionDir: "/tmp/pa-test-session",
      workdirEventType: "setup.update",
      workdirProcessKey: "setup.update",
      reassemblePrompt: reassemble,
    });

    expect(prepareSessionDir).toHaveBeenCalledWith(
      "/tmp/pa-test-session",
      "codex",
      "setup.update",
      "setup.update",
      undefined,
      "hello",
    );
    expect(reassemble).toHaveBeenCalledWith("codex");
    expect(fallbackExecute).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "prompt-for-codex" }),
      undefined,
    );
  });

  it("does not call prepareSessionDir when sessionDir is not provided", async () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET fallback_backend = ?, fallback_model = ?
       WHERE process_key = 'dashboard.chat'`,
    ).run("codex", "gpt-5.4");

    const mainCore = makeCore({
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("claude", "rate_limited", null, "quota exceeded"),
      ),
    });
    const fallbackCore = makeCore({
      backendId: "codex",
      execute: vi.fn().mockResolvedValue(
        makeResult({ backendId: "codex", modelId: "gpt-5.4", model: "gpt-5.4" }),
      ),
      listModels: vi.fn().mockReturnValue([
        { backendId: "codex", modelId: "gpt-5.4", label: "gpt-5.4", tier: "high", available: true },
      ]),
    });

    const prepareSessionDir = vi.fn();
    const router = new BackendRouter(
      db,
      makeConfig(),
      [mainCore, fallbackCore],
      undefined,
      undefined,
      prepareSessionDir,
    );

    await router.execute({
      event: makeDmEvent(),
      prompt: "prompt",
      context: "context",
      processKey: "dashboard.chat",
      // sessionDir intentionally omitted — light-tier sessions create their own
    });

    expect(prepareSessionDir).not.toHaveBeenCalled();
  });

  it("emits a configured-only notification when fallback succeeds", async () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET fallback_backend = ?, fallback_model = ?
       WHERE process_key = 'dashboard.chat'`,
    ).run("codex", "gpt-5.4");

    const notifier = makeNotifier();
    const mainCore = makeCore({
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("claude", "rate_limited", null, "quota exceeded"),
      ),
    });
    const fallbackCore = makeCore({
      backendId: "codex",
      execute: vi.fn().mockResolvedValue(
        makeResult({
          backendId: "codex",
          modelId: "gpt-5.4",
          model: "gpt-5.4",
        }),
      ),
      listModels: vi.fn().mockReturnValue([
        {
          backendId: "codex",
          modelId: "gpt-5.4",
          label: "gpt-5.4",
          tier: "high",
          available: true,
        },
      ]),
    });

    const router = new BackendRouter(db, makeConfig(), [mainCore, fallbackCore], notifier);
    await router.execute({
      event: makeDmEvent(),
      prompt: "prompt",
      context: "context",
      processKey: "dashboard.chat",
    });
    await router.execute({
      event: makeDmEvent(),
      prompt: "prompt",
      context: "context",
      processKey: "dashboard.chat",
    });

    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send).toHaveBeenCalledWith(
      expect.stringContaining("Backend switch:"),
      expect.any(Object),
      expect.objectContaining({
        priority: "low",
        destinationMode: "configured_only",
      }),
    );
  });

  it("replies to the user and throws a handled error when no fallback is configured", async () => {
    applySchema(db);
    const notifier = makeNotifier();
    const mainCore = makeCore({
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("claude", "rate_limited", null, "quota exceeded"),
      ),
    });

    const router = new BackendRouter(db, makeConfig(), [mainCore], notifier);

    let caught: BackendRouterHandledError | null = null;
    try {
      await router.execute({
        event: makeDmEvent(),
        prompt: "prompt",
        context: "context",
        processKey: "dashboard.chat",
      });
    } catch (err) {
      caught = err as BackendRouterHandledError;
    }
    expect(caught).toBeInstanceOf(BackendRouterHandledError);
    // Root cause must surface in the top-level message — operators should
    // not need to crack open `cause` to see *why* the backend failed.
    expect(caught!.message).toBe(
      'Backend "claude" failed without fallback: quota:rate_limited — quota exceeded',
    );

    expect(notifier.send).toHaveBeenCalledTimes(2);
    expect(notifier.send).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("usage limit"),
      expect.any(Object),
    );
    expect(notifier.send).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("No fallback is configured"),
      expect.any(Object),
      expect.objectContaining({
        priority: "normal",
        destinationMode: "configured_only",
      }),
    );
  });

  it("replies once and sends a high-priority alert when fallback also fails", async () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET fallback_backend = ?, fallback_model = ?
       WHERE process_key = 'dashboard.chat'`,
    ).run("codex", "gpt-5.4");

    const notifier = makeNotifier();
    const mainCore = makeCore({
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("claude", "rate_limited", null, "quota exceeded"),
      ),
    });
    const fallbackCore = makeCore({
      backendId: "codex",
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("codex", "rate_limited", null, "rate limit reached"),
      ),
      listModels: vi.fn().mockReturnValue([
        {
          backendId: "codex",
          modelId: "gpt-5.4",
          label: "gpt-5.4",
          tier: "high",
          available: true,
        },
      ]),
    });

    const router = new BackendRouter(db, makeConfig(), [mainCore, fallbackCore], notifier);

    await expect(
      router.execute({
        event: makeDmEvent(),
        prompt: "prompt",
        context: "context",
        processKey: "dashboard.chat",
      }),
    ).rejects.toBeInstanceOf(BackendRouterHandledError);

    expect(notifier.send).toHaveBeenCalledTimes(2);
    expect(notifier.send).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("usage limit"),
      expect.any(Object),
    );
    expect(notifier.send).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Backend execution failed:"),
      expect.any(Object),
      expect.objectContaining({
        priority: "high",
        destinationMode: "configured_only",
      }),
    );
  });

  it("summarize delegates to the default backend core", async () => {
    applySchema(db);
    const core = makeCore();
    const router = new BackendRouter(db, makeConfig(), [core]);

    const result = await router.summarize("conversation text");
    expect(core.summarize).toHaveBeenCalledWith("conversation text");
    expect(result).toBe("summary");
  });

  it("summarize throws when no backends are registered", async () => {
    applySchema(db);
    const router = new BackendRouter(db, makeConfig(), []);

    await expect(router.summarize("text")).rejects.toThrow(
      "No agent backends are registered",
    );
  });

  describe("reactive auth self-heal wiring", () => {
    // These integration tests verify that the router's execute /
    // executeResume / summarize success paths actually call
    // recordReactiveAuthSuccess, and that the failure paths call
    // recordReactiveAuthFailure. The free functions themselves are
    // unit-tested in auth-health-monitor.test.ts — here we check that
    // the router wires them up on every code path, which is the fix
    // for the 60-day keepalive false-positive bug.

    function readState(backendId: string) {
      return db
        .prepare(
          "SELECT auth_status, auth_detail, auth_last_success_at FROM backends WHERE id = ?",
        )
        .get(backendId) as
        | {
            auth_status: string;
            auth_detail: string | null;
            auth_last_success_at: string | null;
          }
        | undefined;
    }

    it("execute() success bumps auth_last_success_at on the main backend", async () => {
      applySchema(db);
      const router = new BackendRouter(db, makeConfig(), [makeCore()]);

      const before = readState("claude");
      expect(before?.auth_last_success_at).toBeNull();

      await router.execute({
        event: makeDmEvent(),
        prompt: "hi",
        context: "",
      });

      const after = readState("claude");
      expect(after?.auth_last_success_at).toBeTruthy();
      // applySchema seeds 'unknown'; reactive success transitions unknown → ok.
      expect(after?.auth_status).toBe("ok");
    });

    it("execute() success self-heals an expired row and counts it in telemetry", async () => {
      applySchema(db);
      const telemetry = new AuthTelemetry(db);
      const router = new BackendRouter(
        db,
        makeConfig(),
        [makeCore()],
        undefined,
        telemetry,
      );

      db.prepare(
        "UPDATE backends SET auth_status='expired', auth_detail='401', auth_first_expired_at='2026-04-09T00:00:00Z' WHERE id='claude'",
      ).run();

      await router.execute({
        event: makeDmEvent(),
        prompt: "hi",
        context: "",
      });

      const after = readState("claude");
      expect(after?.auth_status).toBe("ok");
      expect(after?.auth_detail).toBeNull();
      expect(telemetry.snapshot().claude?.self_heal_observed).toBe(1);
    });

    it("executeResume() success bumps auth_last_success_at", async () => {
      applySchema(db);
      const router = new BackendRouter(db, makeConfig(), [makeCore()]);

      await router.executeResume({
        backendId: "claude",
        sessionId: "sess-1",
        message: "follow up",
        modelId: "claude-opus-4-6",
        sessionDir: "/tmp/pa-session",
      });

      const state = readState("claude");
      expect(state?.auth_last_success_at).toBeTruthy();
      expect(state?.auth_status).toBe("ok");
    });

    it("executeResume() records reactive auth failure on auth errors", async () => {
      applySchema(db);
      const router = new BackendRouter(
        db,
        makeConfig(),
        [
          makeCore({
            executeResume: vi.fn().mockRejectedValue(
              new BackendDecisiveFailure(
                "claude",
                "auth",
                new Error("401 Unauthorized"),
              ),
            ),
          }),
        ],
      );

      await expect(
        router.executeResume({
          backendId: "claude",
          sessionId: "sess-1",
          message: "follow up",
          modelId: "claude-opus-4-6",
          sessionDir: "/tmp/pa-session",
        }),
      ).rejects.toBeInstanceOf(BackendDecisiveFailure);

      const state = readState("claude");
      expect(state?.auth_status).toBe("expired");
      expect(state?.auth_detail).toContain("401");
    });

    it("summarize() success bumps auth_last_success_at on the chosen backend", async () => {
      applySchema(db);
      const router = new BackendRouter(db, makeConfig(), [makeCore()]);

      await router.summarize("conversation text");

      const state = readState("claude");
      expect(state?.auth_last_success_at).toBeTruthy();
      expect(state?.auth_status).toBe("ok");
    });

    it("fallback success bumps auth_last_success_at on the fallback backend (not main)", async () => {
      applySchema(db);
      // Configure dashboard.chat with a codex fallback.
      db.prepare(
        `UPDATE process_backend_config
            SET main_backend = 'claude',
                main_model = 'claude-opus-4-6',
                fallback_backend = 'codex',
                fallback_model = 'gpt-5.4'
          WHERE process_key = 'dashboard.chat'`,
      ).run();
      db.prepare("UPDATE backends SET enabled = 1 WHERE id IN ('claude','codex')").run();

      const mainCore = makeCore({
        backendId: "claude",
        execute: vi
          .fn()
          .mockRejectedValue(
            new BackendDecisiveFailure(
              "claude",
              "auth",
              new Error("401 Unauthorized"),
            ),
          ),
      });
      const codexCore = makeCore({
        backendId: "codex",
        execute: vi.fn().mockResolvedValue(makeResult({ backendId: "codex" })),
        listModels: vi.fn().mockReturnValue([
          {
            backendId: "codex",
            modelId: "gpt-5.4",
            label: "gpt-5.4",
            tier: "high" as const,
            available: true,
          },
        ]),
      });
      const router = new BackendRouter(
        db,
        makeConfig(),
        [mainCore, codexCore],
        makeNotifier(),
      );

      await router.execute({
        event: makeDmEvent(),
        prompt: "hi",
        context: "",
      });

      // Main should now be marked expired (reactive failure), fallback
      // should be marked ok with last_success_at stamped.
      const mainState = readState("claude");
      const fallbackState = readState("codex");
      expect(mainState?.auth_status).toBe("expired");
      expect(mainState?.auth_detail).toContain("401");
      expect(fallbackState?.auth_status).toBe("ok");
      expect(fallbackState?.auth_last_success_at).toBeTruthy();
    });
  });

  it("re-throws raw errors (not BackendFailure) from main backend", async () => {
    applySchema(db);
    const core = makeCore({
      execute: vi.fn().mockRejectedValue(new TypeError("bad argument")),
    });
    const router = new BackendRouter(db, makeConfig(), [core]);

    await expect(
      router.execute({
        event: makeDmEvent(),
        prompt: "p",
        context: "c",
        processKey: "dashboard.chat",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("re-throws raw errors (not BackendFailure) from fallback backend", async () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET fallback_backend = ?, fallback_model = ?
       WHERE process_key = 'dashboard.chat'`,
    ).run("codex", "gpt-5.4");

    const mainCore = makeCore({
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("claude", "rate_limited", null, "quota"),
      ),
    });
    const fallbackCore = makeCore({
      backendId: "codex",
      execute: vi.fn().mockRejectedValue(new RangeError("out of range")),
      listModels: vi.fn().mockReturnValue([]),
    });

    const router = new BackendRouter(db, makeConfig(), [mainCore, fallbackCore]);

    await expect(
      router.execute({
        event: makeDmEvent(),
        prompt: "p",
        context: "c",
        processKey: "dashboard.chat",
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("resolveTier defaults to medium for unknown process keys", () => {
    applySchema(db);
    const core = makeCore();
    const router = new BackendRouter(db, makeConfig(), [core]);

    const binding = router.resolveBinding(makeDmEvent(), {
      processKey: "custom.unknown" as any,
    });
    expect(binding.resolvedTier).toBe("medium");
  });

  it("deduplication expires after window", async () => {
    applySchema(db);
    db.prepare(
      `UPDATE process_backend_config
         SET fallback_backend = ?, fallback_model = ?
       WHERE process_key = 'dashboard.chat'`,
    ).run("codex", "gpt-5.4");

    const notifier = makeNotifier();
    const mainCore = makeCore({
      execute: vi.fn().mockRejectedValue(
        new BackendQuotaError("claude", "rate_limited", null, "quota"),
      ),
    });
    const fallbackCore = makeCore({
      backendId: "codex",
      execute: vi.fn().mockResolvedValue(
        makeResult({ backendId: "codex", modelId: "gpt-5.4" }),
      ),
      listModels: vi.fn().mockReturnValue([
        { backendId: "codex", modelId: "gpt-5.4", label: "gpt-5.4", tier: "high", available: true },
      ]),
    });

    const router = new BackendRouter(db, makeConfig(), [mainCore, fallbackCore], notifier);

    // First call - sends notification
    await router.execute({
      event: makeDmEvent(),
      prompt: "p",
      context: "c",
      processKey: "dashboard.chat",
    });
    expect(notifier.send).toHaveBeenCalledTimes(1);

    // Manually expire the dedup by manipulating the internal map
    const dedupMap = (router as any).notificationDedup as Map<string, number>;
    for (const [key] of dedupMap) {
      dedupMap.set(key, Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
    }

    // Second call - should send again because window expired
    await router.execute({
      event: makeDmEvent(),
      prompt: "p",
      context: "c",
      processKey: "dashboard.chat",
    });
    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  it("uses preResolvedBinding when provided", async () => {
    applySchema(db);
    const core = makeCore();
    const router = new BackendRouter(db, makeConfig(), [core]);

    await router.execute({
      event: makeDmEvent(),
      prompt: "p",
      context: "c",
      preResolvedBinding: {
        processKey: "dashboard.chat",
        resolvedTier: "medium",
        main: {
          backendId: "claude",
          modelId: "claude-sonnet-4-6",
          maxTurns: 5,
          maxBudgetUsd: 0.5,
        },
        fallback: null,
      },
    });

    expect(core.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "claude-sonnet-4-6",
        maxTurns: 5,
        maxBudgetUsd: 0.5,
      }),
      undefined,
    );
  });

  describe("web search flag", () => {
    it("passes webSearchEnabled=false when backends.web_search_enabled is 0", async () => {
      applySchema(db);
      const core = makeCore();
      const router = new BackendRouter(db, makeConfig(), [core]);

      await router.execute({
        event: makeDmEvent(),
        prompt: "p",
        context: "c",
        processKey: "dashboard.chat",
      });

      expect(core.execute).toHaveBeenCalledWith(
        expect.objectContaining({ webSearchEnabled: false }),
        undefined,
      );
    });

    it("passes webSearchEnabled=true when backends.web_search_enabled is 1", async () => {
      applySchema(db);
      db.prepare("UPDATE backends SET web_search_enabled = 1 WHERE id = 'claude'").run();

      const core = makeCore();
      const router = new BackendRouter(db, makeConfig(), [core]);

      await router.execute({
        event: makeDmEvent(),
        prompt: "p",
        context: "c",
        processKey: "dashboard.chat",
      });

      expect(core.execute).toHaveBeenCalledWith(
        expect.objectContaining({ webSearchEnabled: true }),
        undefined,
      );
    });

    it("reflects DB changes immediately without recreating the router", async () => {
      applySchema(db);
      const core = makeCore();
      const router = new BackendRouter(db, makeConfig(), [core]);

      // First call: disabled
      await router.execute({
        event: makeDmEvent(),
        prompt: "p",
        context: "c",
        processKey: "dashboard.chat",
      });
      expect(core.execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ webSearchEnabled: false }),
        undefined,
      );

      // Toggle in DB (simulates dashboard toggle)
      db.prepare("UPDATE backends SET web_search_enabled = 1 WHERE id = 'claude'").run();

      // Second call with same router: should now be enabled
      await router.execute({
        event: makeDmEvent(),
        prompt: "p",
        context: "c",
        processKey: "dashboard.chat",
      });
      expect(core.execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ webSearchEnabled: true }),
        undefined,
      );
    });

    it("passes webSearchEnabled to executeResume", async () => {
      applySchema(db);
      db.prepare("UPDATE backends SET web_search_enabled = 1 WHERE id = 'claude'").run();

      const core = makeCore();
      const router = new BackendRouter(db, makeConfig(), [core]);

      await router.executeResume({
        backendId: "claude",
        sessionId: "sess-1",
        message: "hi",
        modelId: "claude-opus-4-6",
      });

      expect(core.executeResume).toHaveBeenCalledWith(
        expect.objectContaining({ webSearchEnabled: true }),
        undefined,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3.3 — pre-flight auth cache check
  // -------------------------------------------------------------------------

  describe("pre-flight auth cache check (§3.3)", () => {
    function setupTwoBackendRouter(
      mainCore: IAgentCore,
      fallbackCore: IAgentCore,
      telemetry?: AuthTelemetry,
    ) {
      db.prepare(
        `UPDATE process_backend_config
            SET main_backend = 'claude',
                main_model = 'claude-opus-4-6',
                fallback_backend = 'codex',
                fallback_model = 'gpt-5.4'
          WHERE process_key = 'dashboard.chat'`,
      ).run();
      db.prepare(
        "UPDATE backends SET enabled = 1 WHERE id IN ('claude','codex')",
      ).run();
      return new BackendRouter(
        db,
        makeConfig(),
        [mainCore, fallbackCore],
        makeNotifier(),
        telemetry,
      );
    }

    function makeCodexCore(overrides: Partial<IAgentCore> = {}): IAgentCore {
      return makeCore({
        backendId: "codex",
        listModels: vi.fn().mockReturnValue([
          {
            backendId: "codex",
            modelId: "gpt-5.4",
            label: "gpt-5.4",
            tier: "high" as const,
            available: true,
          },
        ]),
        ...overrides,
      });
    }

    it("skips main and routes to fallback when main has fresh expired status", async () => {
      applySchema(db);
      // Mark main (claude) as freshly expired.
      db.prepare(
        `UPDATE backends
            SET auth_status = 'expired',
                auth_last_verified_at = ?
          WHERE id = 'claude'`,
      ).run(new Date().toISOString());

      const mainCore = makeCore();
      const codexCore = makeCodexCore({
        execute: vi.fn().mockResolvedValue(makeResult({ backendId: "codex" })),
      });
      const router = setupTwoBackendRouter(mainCore, codexCore);

      const result = await router.execute({
        event: makeDmEvent(),
        prompt: "hi",
        context: "",
      });

      // Main should NOT have been called.
      expect(mainCore.execute).not.toHaveBeenCalled();
      // Fallback should have been called.
      expect(codexCore.execute).toHaveBeenCalled();
      expect(result.backendId).toBe("codex");
    });

    it("does NOT skip main when expired status is stale (> 10 min)", async () => {
      applySchema(db);
      // Mark main as expired 15 minutes ago — stale cache.
      const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      db.prepare(
        `UPDATE backends
            SET auth_status = 'expired',
                auth_last_verified_at = ?
          WHERE id = 'claude'`,
      ).run(staleTime);

      const mainCore = makeCore();
      const codexCore = makeCodexCore();
      const router = setupTwoBackendRouter(mainCore, codexCore);

      await router.execute({
        event: makeDmEvent(),
        prompt: "hi",
        context: "",
      });

      // Main SHOULD have been called (stale cache → user may have re-authed).
      expect(mainCore.execute).toHaveBeenCalled();
    });

    it("does NOT skip main when there is no fallback", async () => {
      applySchema(db);
      // Mark main as freshly expired but ensure NO fallback is configured.
      db.prepare(
        `UPDATE process_backend_config
            SET fallback_backend = NULL,
                fallback_model = NULL
          WHERE process_key = 'dashboard.chat'`,
      ).run();
      db.prepare(
        `UPDATE backends
            SET auth_status = 'expired',
                auth_last_verified_at = ?
          WHERE id = 'claude'`,
      ).run(new Date().toISOString());

      const mainCore = makeCore();
      const router = new BackendRouter(db, makeConfig(), [mainCore]);

      await router.execute({
        event: makeDmEvent(),
        prompt: "hi",
        context: "",
      });

      // Main should still be called — no fallback means fall through.
      expect(mainCore.execute).toHaveBeenCalled();
    });

    it("skips main for recovering status regardless of freshness", async () => {
      applySchema(db);
      // recovering with no verified_at — should still skip.
      db.prepare(
        `UPDATE backends
            SET auth_status = 'recovering',
                auth_last_verified_at = NULL
          WHERE id = 'claude'`,
      ).run();

      const mainCore = makeCore();
      const codexCore = makeCodexCore({
        execute: vi.fn().mockResolvedValue(makeResult({ backendId: "codex" })),
      });
      const router = setupTwoBackendRouter(mainCore, codexCore);

      await router.execute({
        event: makeDmEvent(),
        prompt: "hi",
        context: "",
      });

      expect(mainCore.execute).not.toHaveBeenCalled();
      expect(codexCore.execute).toHaveBeenCalled();
    });

    it("records preflight_skipped_main telemetry when skipping", async () => {
      applySchema(db);
      db.prepare(
        `UPDATE backends
            SET auth_status = 'expired',
                auth_last_verified_at = ?
          WHERE id = 'claude'`,
      ).run(new Date().toISOString());

      const telemetry = new AuthTelemetry(db);
      const mainCore = makeCore();
      const codexCore = makeCodexCore({
        execute: vi.fn().mockResolvedValue(makeResult({ backendId: "codex" })),
      });
      const router = setupTwoBackendRouter(mainCore, codexCore, telemetry);

      await router.execute({
        event: makeDmEvent(),
        prompt: "hi",
        context: "",
      });

      const snap = telemetry.snapshot();
      expect(snap.claude?.preflight_skipped_main).toBe(1);
    });

    it("self-heal after re-auth: reactive success unblocks pre-flight on subsequent calls", async () => {
      applySchema(db);
      // 1. Mark claude as freshly expired.
      db.prepare(
        `UPDATE backends
            SET auth_status = 'expired',
                auth_last_verified_at = ?
          WHERE id = 'claude'`,
      ).run(new Date().toISOString());

      const mainCore = makeCore();
      const codexCore = makeCodexCore({
        execute: vi.fn().mockResolvedValue(makeResult({ backendId: "codex" })),
      });
      const telemetry = new AuthTelemetry(db);
      const router = setupTwoBackendRouter(mainCore, codexCore, telemetry);

      // 2. First call skips main → goes to fallback.
      await router.execute({
        event: makeDmEvent(),
        prompt: "hi",
        context: "",
      });
      expect(mainCore.execute).not.toHaveBeenCalled();

      // 3. Simulate: user manually re-auths, then a successful execute
      // updates the status. We simulate this by directly setting ok.
      db.prepare(
        `UPDATE backends
            SET auth_status = 'ok',
                auth_last_verified_at = ?
          WHERE id = 'claude'`,
      ).run(new Date().toISOString());

      // 4. Second call should now try main because status is ok.
      (mainCore.execute as ReturnType<typeof vi.fn>).mockClear();
      await router.execute({
        event: makeDmEvent(),
        prompt: "follow up",
        context: "",
      });
      expect(mainCore.execute).toHaveBeenCalled();
    });

    it("pre-flight fallback auth failure is tracked reactively + error shape is correct (B1 fix)", async () => {
      applySchema(db);
      db.prepare(
        `UPDATE backends
            SET auth_status = 'expired',
                auth_last_verified_at = ?
          WHERE id = 'claude'`,
      ).run(new Date().toISOString());

      const mainCore = makeCore();
      const codexCore = makeCodexCore({
        execute: vi
          .fn()
          .mockRejectedValue(
            new BackendDecisiveFailure(
              "codex",
              "auth",
              new Error("401 codex expired too"),
            ),
          ),
      });
      const router = setupTwoBackendRouter(mainCore, codexCore);

      let caught: BackendRouterHandledError | null = null;
      try {
        await router.execute({
          event: makeDmEvent(),
          prompt: "hi",
          context: "",
        });
      } catch (err) {
        caught = err as BackendRouterHandledError;
      }
      expect(caught).toBeInstanceOf(BackendRouterHandledError);
      expect(caught!.message).toMatch(/Fallback backend.*failed after/);
      // Both legs' root causes are embedded so the dashboard error column
      // tells the full story: which backend, which kind, which inner msg.
      expect(caught!.message).toMatch(/main: auth — /);
      expect(caught!.message).toMatch(/fallback: auth — 401 codex expired too/);

      // B1 fix: mainFailure should be a synthetic auth failure for the
      // pre-flight-skipped main, NOT the fallback error.
      expect(caught!.mainFailure).toBeInstanceOf(BackendDecisiveFailure);
      expect((caught!.mainFailure as BackendDecisiveFailure).backendId).toBe("claude");
      expect((caught!.mainFailure as BackendDecisiveFailure).kind).toBe("auth");

      // B1 fix: fallbackFailure must NOT be null — the fallback DID fail.
      expect(caught!.fallbackFailure).toBeInstanceOf(BackendDecisiveFailure);
      expect((caught!.fallbackFailure as BackendDecisiveFailure).backendId).toBe("codex");

      // Codex should be marked expired.
      const codexState = db
        .prepare("SELECT auth_status FROM backends WHERE id = 'codex'")
        .get() as { auth_status: string };
      expect(codexState.auth_status).toBe("expired");
    });
  });

  describe("chat-attachments forwarding (Phase 1)", () => {
    it("execute forwards stagedAttachments to the main core verbatim", async () => {
      applySchema(db);
      const core = makeCore();
      const router = new BackendRouter(db, makeConfig(), [core]);
      const staged = [
        {
          id: "a-1",
          safeFilename: "photo.png",
          mimeType: "image/png",
          absolutePath: "/tmp/s/_attachments/photo.png",
          relativePath: "_attachments/photo.png",
        },
      ];

      await router.execute({
        prompt: "describe the image",
        context: "",
        event: makeDmEvent(),
        stagedAttachments: staged,
      });

      const call = vi.mocked(core.execute).mock.calls[0][0];
      expect(call.stagedAttachments).toEqual(staged);
    });

    it("execute omits stagedAttachments entirely when the list is empty", async () => {
      applySchema(db);
      const core = makeCore();
      const router = new BackendRouter(db, makeConfig(), [core]);

      await router.execute({
        prompt: "no files this turn",
        context: "",
        event: makeDmEvent(),
        stagedAttachments: [],
      });

      const call = vi.mocked(core.execute).mock.calls[0][0];
      // Empty list must NOT appear as `stagedAttachments: []` — the core
      // treats undefined as "no translation needed" and forwarding an empty
      // array would defeat the `stagedAttachments && .length > 0` gates.
      expect("stagedAttachments" in call).toBe(false);
    });

    it("executeResume forwards stagedAttachments to the core", async () => {
      applySchema(db);
      const core = makeCore();
      const router = new BackendRouter(db, makeConfig(), [core]);
      const staged = [
        {
          id: "r-1",
          safeFilename: "doc.pdf",
          mimeType: "application/pdf",
          absolutePath: "/tmp/s/_attachments/doc.pdf",
          relativePath: "_attachments/doc.pdf",
        },
      ];

      await router.executeResume({
        backendId: "claude",
        sessionId: "sess-1",
        message: "summarize this",
        modelId: "claude-opus-4-6",
        stagedAttachments: staged,
      });

      const call = vi.mocked(core.executeResume).mock.calls[0][0];
      expect(call.stagedAttachments).toEqual(staged);
    });
  });

  // Phase 4 — Integration-delegation fallback gating (§Phase 4 in
  // GOOGLE_AUTH_DELEGATION_DESIGN.md). The router must null out a fallback
  // whose backend has no registry connector for any delegated integration
  // that `taskFlowsTouched` declares for the resolved process key.
  describe("fallback gating for delegated integrations", () => {
    /** Write an integrations row directly into the settings table. */
    function setIntegration(
      mode: "direct" | "delegated" | "disabled",
      key: "gmail" | "google_calendar",
      delegatedBackend?: "claude" | "codex" | "gemini",
    ) {
      const existing = db
        .prepare("SELECT value_json FROM settings WHERE key = 'integrations'")
        .get() as { value_json: string } | undefined;
      const now = new Date().toISOString();
      const current = existing
        ? (JSON.parse(existing.value_json) as Record<string, unknown>)
        : {
            gmail: { mode: "disabled", deniedTools: [], lastChangedAt: now },
            google_calendar: { mode: "disabled", deniedTools: [], lastChangedAt: now },
          };
      const next = {
        ...current,
        [key]:
          mode === "delegated"
            ? { mode, delegatedBackend, lastChangedAt: now }
            : { mode, lastChangedAt: now },
      };
      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('integrations', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = CURRENT_TIMESTAMP`,
      ).run(JSON.stringify(next));
    }

    /** Configure morning_routine with main=claude, fallback=<backend>. */
    function pinMorningRoutine(
      mainBackend: "claude" | "codex",
      fallbackBackend: "claude" | "codex" | "gemini" | null,
      fallbackModel: string | null = null,
    ) {
      const main = mainBackend === "claude"
        ? { backend: "claude", model: "claude-opus-4-6" }
        : { backend: "codex", model: "gpt-5.4" };
      db.prepare(
        `UPDATE process_backend_config
           SET main_backend = ?, main_model = ?,
               fallback_backend = ?, fallback_model = ?
         WHERE process_key = 'routine.morning_routine'`,
      ).run(
        main.backend,
        main.model,
        fallbackBackend,
        fallbackBackend ? fallbackModel ?? "claude-opus-4-6" : null,
      );
    }

    function routineEvent() {
      return { ...makeDmEvent(), type: "routine.morning_routine", platform: "cron" };
    }

    it("keeps a compatible fallback — Gmail delegated to Claude, fallback=Codex has Gmail connector", () => {
      applySchema(db);
      setIntegration("delegated", "gmail", "claude");
      pinMorningRoutine("claude", "codex", "gpt-5.4");

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(routineEvent(), {
        processKey: "routine.morning_routine",
      });

      expect(binding.fallback).not.toBeNull();
      expect(binding.fallback?.backendId).toBe("codex");
    });

    it("Phase D: keeps fallback even when fallback backend lacks the Gmail connector — daemon proxies the calls", () => {
      // Pre-Phase-D this test expected `binding.fallback === null`. The
      // router used `gmail.taskFlowsTouched` to detect that morning_routine
      // depended on the Gmail MCP surface, then refused a fallback whose
      // backend lacked the Gmail connector. After Phase D, gmail is in
      // `PROXY_DRIVEN_INTEGRATIONS` and `delegatedIntegrationsForProcessKey`
      // skips it, so the fallback-refusal gate is silent for proxied
      // integrations. Cross-backend Gmail work flows through the generic
      // `POST /api/integrations/:key/exec` task-mode chokepoint (the
      // legacy `/invoke` RPC was retired 2026-05-01) regardless of
      // which backend the session itself runs on, so the fallback no
      // longer needs the connector.
      applySchema(db);
      setIntegration("delegated", "gmail", "claude");
      pinMorningRoutine("claude", "gemini", "gemini-2.5-pro");

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(routineEvent(), {
        processKey: "routine.morning_routine",
      });

      expect(binding.fallback).not.toBeNull();
      expect(binding.fallback?.backendId).toBe("gemini");
    });

    it("keeps fallback for process keys no delegated integration touches — message.dm", () => {
      applySchema(db);
      setIntegration("delegated", "gmail", "claude");
      db.prepare(
        `UPDATE process_backend_config
           SET fallback_backend = 'gemini', fallback_model = 'gemini-2.5-pro'
         WHERE process_key = 'message.dm'`,
      ).run();

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      // message.dm is NOT in any descriptor's taskFlowsTouched after the
      // §4.1.1 narrowing — fallback must survive regardless of gmail state.
      const binding = router.resolveBinding(makeDmEvent(), {
        processKey: "message.dm",
      });
      expect(binding.fallback).not.toBeNull();
      expect(binding.fallback?.backendId).toBe("gemini");
    });

    it("keeps fallback when gmail is direct, not delegated", () => {
      applySchema(db);
      setIntegration("direct", "gmail");
      pinMorningRoutine("claude", "gemini", "gemini-2.5-pro");

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(routineEvent(), {
        processKey: "routine.morning_routine",
      });

      // gmail is direct — the integration isn't steering routing. Fallback
      // passes through untouched even though Gemini has no gmail connector.
      expect(binding.fallback).not.toBeNull();
      expect(binding.fallback?.backendId).toBe("gemini");
    });

    it("Phase D: keeps fallback even when both gmail+calendar are delegated and the fallback backend lacks both connectors", () => {
      // Pre-Phase-D, the gating for delegated integrations would null the
      // fallback when ANY one of them lacked a connector on the fallback
      // backend. With Phase D both gmail and google_calendar are members
      // of `PROXY_DRIVEN_INTEGRATIONS`; neither contributes to
      // `delegatedIntegrationsForProcessKey`, so the gate is silent and
      // the fallback survives.
      applySchema(db);
      setIntegration("delegated", "gmail", "claude");
      setIntegration("delegated", "google_calendar", "codex");
      pinMorningRoutine("claude", "gemini", "gemini-2.5-pro");

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(routineEvent(), {
        processKey: "routine.morning_routine",
      });

      expect(binding.fallback).not.toBeNull();
      expect(binding.fallback?.backendId).toBe("gemini");
    });

    it("keeps fallback when all delegated integrations have a connector on the fallback backend", () => {
      applySchema(db);
      setIntegration("delegated", "gmail", "claude");
      setIntegration("delegated", "google_calendar", "claude");
      pinMorningRoutine("claude", "codex", "gpt-5.4");

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(routineEvent(), {
        processKey: "routine.morning_routine",
      });

      // Codex has connectors for both gmail and google_calendar.
      expect(binding.fallback).not.toBeNull();
      expect(binding.fallback?.backendId).toBe("codex");
    });

    it("HARD override (requestedBackendId + requestedModelId) stays fallback-null", () => {
      // The hard override path drops fallback unconditionally — Phase D
      // didn't change this. Pin a delegated gmail to confirm the early
      // return still beats the (now-dormant for proxied integrations)
      // delegation gate.
      applySchema(db);
      setIntegration("delegated", "gmail", "claude");
      pinMorningRoutine("claude", "gemini", "gemini-2.5-pro");

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(routineEvent(), {
        processKey: "routine.morning_routine",
        requestedBackendId: "codex",
        requestedModelId: "gpt-5.4",
      });
      expect(binding.main.backendId).toBe("codex");
      expect(binding.fallback).toBeNull();
    });

    it("Phase D: tier override still upgrades main, and fallback stays untouched (delegation gate is no-op for proxied gmail)", () => {
      applySchema(db);
      setIntegration("delegated", "gmail", "claude");
      db.prepare(
        `UPDATE process_backend_config
           SET main_backend = 'claude', main_model = 'claude-sonnet-4-6',
               fallback_backend = 'gemini', fallback_model = 'gemini-2.5-pro'
         WHERE process_key = 'routine.morning_routine'`,
      ).run();

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(routineEvent(), {
        processKey: "routine.morning_routine",
        requestedTier: "high",
      });

      // Tier-override behaviour preserved: sonnet → opus on heavy.
      expect(binding.main.modelId).toBe("claude-opus-4-7");
      // Pre-Phase-D this expected `null` because gmail was claimed by
      // morning_routine. Now the gate is silent for proxied integrations,
      // so the configured gemini fallback survives.
      expect(binding.fallback?.backendId).toBe("gemini");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // INTEGRATION_NATIVE_MODE_DESIGN.md §10.1 — native fallback gate.
  //
  // Unlike delegated cross-backend (which can still serve calls via
  // `/api/integrations/:key/exec`), native pins the integration to a
  // SPECIFIC backend's MCP. A fallback whose `backendId` differs from
  // `nativeBackend` cannot serve the integration at all — drop it.
  //
  // The gate is NOT subject to the PROXY_DRIVEN_INTEGRATIONS carve-out
  // that the delegated gate honors: native has no daemon proxy, so the
  // connector must live on the running backend itself.
  // ──────────────────────────────────────────────────────────────────────
  describe("fallback gating for native integrations (§10.1)", () => {
    /** Seed `settings.integrations` directly with a native gmail row. */
    function setGmailNative(nativeBackend: "claude" | "codex" | "gemini") {
      const now = new Date().toISOString();
      const payload = {
        gmail: {
          mode: "native",
          nativeBackend,
          deniedTools: [],
          lastChangedAt: now,
        },
        google_calendar: {
          mode: "disabled",
          deniedTools: [],
          lastChangedAt: now,
        },
      };
      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('integrations', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = CURRENT_TIMESTAMP`,
      ).run(JSON.stringify(payload));
    }

    /** Pin routine.hourly_check (the process key gmail touches). */
    function pinHourlyCheck(
      mainBackend: "claude" | "codex",
      fallbackBackend: "claude" | "codex" | "gemini" | null,
    ) {
      const mainModel =
        mainBackend === "claude" ? "claude-sonnet-4-6" : "gpt-5.4";
      const fallbackModel =
        fallbackBackend === "claude"
          ? "claude-sonnet-4-6"
          : fallbackBackend === "codex"
            ? "gpt-5.4"
            : fallbackBackend === "gemini"
              ? "gemini-2.5-pro"
              : null;
      db.prepare(
        `UPDATE process_backend_config
           SET main_backend = ?, main_model = ?,
               fallback_backend = ?, fallback_model = ?
         WHERE process_key = 'routine.hourly_check'`,
      ).run(mainBackend, mainModel, fallbackBackend, fallbackModel);
    }

    function hourlyCheckEvent() {
      return { ...makeDmEvent(), type: "routine.hourly_check", platform: "cron" };
    }

    it("drops fallback when nativeBackend != fallback.backendId", () => {
      applySchema(db);
      setGmailNative("claude");
      pinHourlyCheck("claude", "gemini");

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(hourlyCheckEvent(), {
        processKey: "routine.hourly_check",
      });

      // gmail.nativeBackend=claude, fallback=gemini → gate fires, fallback
      // dropped. The agent cannot reach Gmail's MCP from gemini.
      expect(binding.fallback).toBeNull();
    });

    it("keeps fallback when nativeBackend matches fallback.backendId", () => {
      applySchema(db);
      setGmailNative("claude");
      pinHourlyCheck("codex", "claude");

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(hourlyCheckEvent(), {
        processKey: "routine.hourly_check",
      });

      // gmail.nativeBackend=claude, fallback=claude → gate silent, fallback
      // survives. (This is a contrived config — `main !== nativeBackend` —
      // but it exercises the equality branch.)
      expect(binding.fallback?.backendId).toBe("claude");
    });

    it("does not gate process keys the native integration does not touch", () => {
      applySchema(db);
      setGmailNative("claude");
      // routine.morning_routine is NOT in gmail.taskFlowsTouched. Pin a
      // mismatching fallback — gate must stay silent.
      db.prepare(
        `UPDATE process_backend_config
           SET fallback_backend = 'gemini', fallback_model = 'gemini-2.5-pro'
         WHERE process_key = 'routine.morning_routine'`,
      ).run();

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(
        { ...makeDmEvent(), type: "routine.morning_routine", platform: "cron" },
        { processKey: "routine.morning_routine" },
      );

      expect(binding.fallback?.backendId).toBe("gemini");
    });

    it("does not gate when no integration is native", () => {
      applySchema(db);
      // No settings.integrations row at all — `readIntegrations` returns
      // every key disabled.
      pinHourlyCheck("claude", "gemini");

      const router = new BackendRouter(db, makeConfig(), [makeCore()]);
      const binding = router.resolveBinding(hourlyCheckEvent(), {
        processKey: "routine.hourly_check",
      });

      expect(binding.fallback?.backendId).toBe("gemini");
    });
  });

  // BROWSER_HISTORY_INTEGRATION_PLAN §10.3 — the safety floor must validate
  // both `binding.main` and `binding.fallback`. The earlier implementation
  // only checked main, which silently allowed a `routine.research_dispatch`
  // (Claude-only) binding to fall back to Codex when Claude failed.
  describe("safety floor — main + fallback validation", () => {
    function makeMultiCore(): IAgentCore[] {
      return [
        makeCore({ backendId: "claude" }),
        makeCore({ backendId: "codex" }),
        makeCore({ backendId: "gemini" }),
      ];
    }
    function dispatchEvent(): Event {
      return createEvent({
        type: "routine.research_dispatch",
        source: "cron",
        priority: EventPriority.NORMAL,
      });
    }
    function pinResearchDispatch(
      database: Database.Database,
      mainBackend: string,
      mainModel: string,
      fallbackBackend: string | null = null,
      fallbackModel: string | null = null,
    ) {
      database
        .prepare(
          `INSERT INTO process_backend_config
             (process_key, main_backend, main_model, fallback_backend, fallback_model, max_turns, max_budget_usd)
           VALUES (?, ?, ?, ?, ?, 30, 0.5)
           ON CONFLICT(process_key) DO UPDATE SET
             main_backend = excluded.main_backend,
             main_model = excluded.main_model,
             fallback_backend = excluded.fallback_backend,
             fallback_model = excluded.fallback_model`,
        )
        .run(
          "routine.research_dispatch",
          mainBackend,
          mainModel,
          fallbackBackend,
          fallbackModel,
        );
    }

    it("refuses execute when main violates the Claude-only floor for research_dispatch", async () => {
      applySchema(db);
      pinResearchDispatch(db, "codex", "gpt-5-codex");
      const notifier = makeNotifier();
      const router = new BackendRouter(
        db,
        makeConfig(),
        makeMultiCore(),
        notifier,
      );
      await expect(
        router.execute({
          event: dispatchEvent(),
          prompt: "p",
          context: "",
        }),
      ).rejects.toBeInstanceOf(BackendRouterHandledError);
      const audit = db
        .prepare(
          "SELECT detail FROM agent_actions WHERE action_type = 'backend_floor_refused'",
        )
        .get() as { detail: string } | undefined;
      expect(audit).toBeDefined();
      const detail = JSON.parse(audit!.detail);
      expect(detail.side).toBe("main");
      expect(detail.backendId).toBe("codex");
    });

    it("refuses execute when fallback violates the floor even if main is eligible", async () => {
      applySchema(db);
      pinResearchDispatch(
        db,
        "claude",
        DEFAULT_CLAUDE_MEDIUM_MODEL,
        "codex",
        "gpt-5-codex",
      );
      const notifier = makeNotifier();
      const router = new BackendRouter(
        db,
        makeConfig(),
        makeMultiCore(),
        notifier,
      );
      await expect(
        router.execute({
          event: dispatchEvent(),
          prompt: "p",
          context: "",
        }),
      ).rejects.toBeInstanceOf(BackendRouterHandledError);
      const audit = db
        .prepare(
          "SELECT detail FROM agent_actions WHERE action_type = 'backend_floor_refused'",
        )
        .get() as { detail: string } | undefined;
      expect(audit).toBeDefined();
      const detail = JSON.parse(audit!.detail);
      expect(detail.side).toBe("fallback");
      expect(detail.backendId).toBe("codex");
    });

    it("allows execute when both main and fallback satisfy the floor", async () => {
      applySchema(db);
      // research_cluster_update is eligible on claude / gemini / opencode;
      // codex is forbidden in either mode. Pin claude main + gemini
      // fallback — both eligible — and confirm execute() proceeds.
      db.prepare(
        `INSERT INTO process_backend_config
           (process_key, main_backend, main_model, fallback_backend, fallback_model, max_turns, max_budget_usd)
         VALUES (?, ?, ?, ?, ?, 5, 0.02)
         ON CONFLICT(process_key) DO UPDATE SET
           main_backend = excluded.main_backend,
           main_model = excluded.main_model,
           fallback_backend = excluded.fallback_backend,
           fallback_model = excluded.fallback_model`,
      ).run(
        "routine.research_cluster_update",
        "claude",
        DEFAULT_CLAUDE_LITE_MODEL,
        "gemini",
        "gemini-2.5-pro",
      );
      const router = new BackendRouter(db, makeConfig(), makeMultiCore());
      const ev = createEvent({
        type: "routine.research_cluster_update",
        source: "cron",
        priority: EventPriority.NORMAL,
      });
      const result = await router.execute({
        event: ev,
        prompt: "p",
        context: "",
      });
      expect(result.output).toBe("ok");
      const audit = db
        .prepare(
          "SELECT 1 FROM agent_actions WHERE action_type = 'backend_floor_refused'",
        )
        .get();
      expect(audit).toBeUndefined();
    });
  });
});

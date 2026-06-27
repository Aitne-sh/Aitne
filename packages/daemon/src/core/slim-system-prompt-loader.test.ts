import { describe, it, expect, beforeEach } from "vitest";
import {
  SLIM_SYSTEM_PROMPT_LOADERS,
  isSlimSystemPromptKey,
  loadFetchWindowSystemPrompt,
  loadResearchClusterUpdateSystemPrompt,
  loadSlimSystemPrompt,
  resetFetchWindowSystemPromptForTest,
  resetSlimSystemPromptsForTest,
} from "./slim-system-prompt-loader.js";
import { SLIM_CLI_SKILL_SETS } from "./skills-compiler.js";
import type { ProcessKey } from "@aitne/shared";

describe("slim-system-prompt-loader", () => {
  beforeEach(() => {
    resetSlimSystemPromptsForTest();
  });

  describe("loadFetchWindowSystemPrompt", () => {
    it("loads the fetch_window slim template from disk", () => {
      const body = loadFetchWindowSystemPrompt();
      expect(body).toMatch(/routine\.fetch_window pre-pass/);
      // No literal brand token leaks through the substitution contract.
      expect(body).not.toMatch(/\{APP_NAME\}/);
    });

    it("caches the template (object identity on the second call)", () => {
      const first = loadFetchWindowSystemPrompt();
      expect(loadFetchWindowSystemPrompt()).toBe(first);
    });
  });

  describe("loadResearchClusterUpdateSystemPrompt", () => {
    it("loads the research_cluster_update slim template from disk", () => {
      const body = loadResearchClusterUpdateSystemPrompt();
      expect(body).toMatch(/routine\.research_cluster_update journal session/);
      // Stance anchors the F4 asset must carry.
      expect(body).toMatch(/append-only/i);
      expect(body).toMatch(/event\.data\.slug/);
      expect(body).toMatch(/context\/research\/<slug>\.md/);
      // Silent-by-contract: no owner DM / notify path.
      expect(body).toMatch(/No owner DM/i);
      expect(body).not.toMatch(/\{APP_NAME\}/);
    });

    it("caches the template (object identity on the second call)", () => {
      const first = loadResearchClusterUpdateSystemPrompt();
      expect(loadResearchClusterUpdateSystemPrompt()).toBe(first);
    });

    it("is distinct from the fetch_window template", () => {
      expect(loadResearchClusterUpdateSystemPrompt()).not.toBe(
        loadFetchWindowSystemPrompt(),
      );
    });
  });

  describe("loadSlimSystemPrompt", () => {
    it("returns the per-key body for every registered slim key", () => {
      expect(loadSlimSystemPrompt("routine.fetch_window")).toBe(
        loadFetchWindowSystemPrompt(),
      );
      expect(loadSlimSystemPrompt("routine.research_cluster_update")).toBe(
        loadResearchClusterUpdateSystemPrompt(),
      );
    });

    it("returns null for a non-slim process key", () => {
      expect(loadSlimSystemPrompt("message.dm")).toBeNull();
    });

    it("returns null for an undefined process key", () => {
      expect(loadSlimSystemPrompt(undefined)).toBeNull();
    });
  });

  describe("isSlimSystemPromptKey", () => {
    it("is true exactly for the registered slim keys", () => {
      expect(isSlimSystemPromptKey("routine.fetch_window")).toBe(true);
      expect(isSlimSystemPromptKey("routine.research_cluster_update")).toBe(true);
    });

    it("is false for non-slim keys and undefined", () => {
      expect(isSlimSystemPromptKey("message.dm")).toBe(false);
      expect(isSlimSystemPromptKey("routine.morning_routine")).toBe(false);
      expect(isSlimSystemPromptKey(undefined)).toBe(false);
    });
  });

  describe("resetSlimSystemPromptsForTest / back-compat alias", () => {
    // NOTE: the templates are primitive strings, so `toBe` is value equality —
    // a re-read cannot be distinguished from a cache hit by identity. These
    // tests assert the loaders still return the correct body across a reset
    // (i.e. the reset does not corrupt or blank the cache).
    it("returns the correct body again after reset", () => {
      const before = loadResearchClusterUpdateSystemPrompt();
      resetSlimSystemPromptsForTest();
      const after = loadResearchClusterUpdateSystemPrompt();
      expect(after).toBe(before);
      expect(after).toMatch(/routine\.research_cluster_update journal session/);
    });

    it("the fetch_window back-compat alias resets without corrupting either cache", () => {
      const fw = loadFetchWindowSystemPrompt();
      const rc = loadResearchClusterUpdateSystemPrompt();
      resetFetchWindowSystemPromptForTest();
      expect(loadFetchWindowSystemPrompt()).toBe(fw);
      expect(loadResearchClusterUpdateSystemPrompt()).toBe(rc);
    });
  });

  // Drift guard: the slim system-prompt registry (Claude SDK + CLI body) and
  // the slim CLI skill-set registry (Codex / Gemini skill copy) must cover the
  // exact same process keys. A key in one but not the other is a wiring bug —
  // either a slim prompt with no CLI skills, or a CLI skill set with no prompt.
  it("SLIM_SYSTEM_PROMPT_LOADERS and SLIM_CLI_SKILL_SETS cover identical keys", () => {
    const promptKeys = Object.keys(SLIM_SYSTEM_PROMPT_LOADERS).sort();
    const skillKeys = Object.keys(SLIM_CLI_SKILL_SETS).sort();
    expect(promptKeys).toEqual(skillKeys);
    // Sanity: both contain the two keys we expect at Phase 2.
    const expected: ProcessKey[] = [
      "routine.fetch_window",
      "routine.research_cluster_update",
    ];
    expect(promptKeys).toEqual([...expected].sort());
  });
});

import { describe, it, expect } from "vitest";
import {
  createDevLegRunner,
  deriveBashAllowlist,
  type DevBackend,
  type DevBackendRequest,
} from "./dev-loop-legs.js";
import { normalizeDevLoopConfig } from "./dev-loop-config.js";
import type { DevLegContext } from "./dev-loop-engine.js";
import type { DevSessionRow } from "../../db/dev-sessions-store.js";

describe("deriveBashAllowlist (D6 — never push)", () => {
  it("grants each verify command as its FULL prefix, never a bare root", () => {
    const tools = deriveBashAllowlist(["npm test", "npm run lint"]);
    expect(tools).toContain("Bash(npm test:*)");
    expect(tools).toContain("Bash(npm run lint:*)");
    // A bare `Bash(npm:*)` would allow `npm run <push-script>`.
    expect(tools).not.toContain("Bash(npm:*)");
  });

  it("never emits Bash(git:*) even when a verify command starts with git", () => {
    const tools = deriveBashAllowlist(["git diff --exit-code", "git status --porcelain"]);
    // The full commands are granted (their prefix), but NOT a bare git root.
    expect(tools).toContain("Bash(git diff --exit-code:*)");
    expect(tools).not.toContain("Bash(git:*)");
    // The only bare-git grants are the explicit read-only ones.
    for (const t of tools) {
      if (t.startsWith("Bash(git")) {
        expect(
          t === "Bash(git diff --exit-code:*)"
            || t === "Bash(git status --porcelain:*)"
            || t === "Bash(git status:*)"
            || t === "Bash(git diff:*)"
            || t === "Bash(git log:*)",
        ).toBe(true);
      }
    }
    // No grant permits `git push`.
    expect(tools.some((t) => /Bash\(git:\*\)/.test(t))).toBe(false);
  });

  it("never emits Bash(bash:*) / Bash(sh:*) shell-interpreter escapes", () => {
    const tools = deriveBashAllowlist(["bash scripts/check.sh"]);
    expect(tools).toContain("Bash(bash scripts/check.sh:*)");
    expect(tools).not.toContain("Bash(bash:*)");
  });

  it("always includes the read-only orientation commands", () => {
    const tools = deriveBashAllowlist(["true"]);
    expect(tools).toEqual(
      expect.arrayContaining([
        "Bash(true:*)",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git log:*)",
        "Bash(ls:*)",
        "Bash(cat:*)",
      ]),
    );
  });
});

describe("createDevLegRunner — per-leg budget reaches the backend", () => {
  function spyBackend(): { backend: DevBackend; reqs: DevBackendRequest[] } {
    const reqs: DevBackendRequest[] = [];
    return {
      reqs,
      backend: {
        async runLeg(req) {
          reqs.push(req);
          return { text: "", sessionId: null, costUsd: 0, numTurns: 1, isError: false };
        },
      },
    };
  }
  const session = { slug: "t", repositoryId: "r", costUsd: 0, baseRef: "HEAD" } as unknown as DevSessionRow;
  const ctx = (over: Partial<DevLegContext>): DevLegContext => ({
    repoPath: "/nonexistent-repo", session, config: normalizeDevLoopConfig({ verifyCommands: ["true"] }),
    iteration: 1, tier: "high", ...over,
  });

  it("passes the per-session cap as maxBudgetUsd when ③ is off", async () => {
    const { backend, reqs } = spyBackend();
    const runner = createDevLegRunner({ backend, loadTaskFlow: (k) => k });
    await runner.plan(ctx({ config: normalizeDevLoopConfig({ verifyCommands: ["true"], maxCostPerSessionUsd: 2, maxCostUsd: null }) }));
    expect(reqs[0]!.maxBudgetUsd).toBe(2);
  });

  it("clamps maxBudgetUsd to the remaining process budget when ③ is on (live spend)", async () => {
    const { backend, reqs } = spyBackend();
    const runner = createDevLegRunner({ backend, loadTaskFlow: (k) => k });
    // remaining = 5 − 4.5 = 0.5 < per-session 2 → 0.5 (uses ctx.spentUsd, the
    // live fleet-wide spend, not session.costUsd).
    await runner.implement(ctx({
      config: normalizeDevLoopConfig({ verifyCommands: ["true"], maxCostPerSessionUsd: 2, maxCostUsd: 5 }),
      spentUsd: 4.5,
    }));
    expect(reqs[0]!.maxBudgetUsd).toBe(0.5);
  });
});

#!/usr/bin/env node
/**
 * docs/design/appendices/opencode-backend.md Phase 2 §6.2 integration smoke.
 *
 * Drives `OpencodeCore` end-to-end against a **real** locally-spawned
 * `opencode serve` child via the `@opencode-ai/sdk` `createOpencode`
 * helper. Prints the assistant response, cost / token aggregates, and
 * a verdict.
 *
 * What this catches that the vitest suite cannot:
 *   - the bin shape of `opencode` on PATH (operators install via
 *     `npm i -g opencode-ai` or `brew install sst/tap/opencode`),
 *   - SDK→server protocol drift between the pinned 1.14.50 typings
 *     and the binary the operator actually has installed,
 *   - real provider credentials being present in
 *     `~/.local/share/opencode/auth.json`.
 *
 * Requirements (the script self-checks):
 *   - `opencode` binary on PATH
 *   - At least one provider configured (`opencode auth login` once)
 *
 * Usage:
 *   node scripts/smoke/opencode-dm.mjs
 *   PA_OPENCODE_SMOKE_MODEL="anthropic/claude-haiku-4-5" node scripts/smoke/opencode-dm.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL =
  process.env.PA_OPENCODE_SMOKE_MODEL ?? "anthropic/claude-haiku-4-5";
const PROMPT =
  process.env.PA_OPENCODE_SMOKE_PROMPT
  ?? "Reply with just the digit '4' to: what is 2+2?";

function pre() {
  const which = spawnSync("which", ["opencode"], { encoding: "utf8" });
  if (which.status !== 0 || !which.stdout.trim()) {
    throw new Error(
      "opencode binary not on PATH — install via `npm i -g opencode-ai` or `brew install sst/tap/opencode`",
    );
  }
}

async function main() {
  pre();
  const tmp = mkdtempSync(join(tmpdir(), "aitne-opencode-smoke-"));
  try {
    // Lazy-load the built daemon so we don't trip TS-only imports.
    const { OpencodeCore } = await import(
      "../../packages/daemon/dist/core/backends/opencode-core.js"
    );
    const { createOpencodeServerManager } = await import(
      "../../packages/daemon/dist/core/backends/opencode-server-manager.js"
    );
    const { AgentWriteTracker } = await import(
      "../../packages/daemon/dist/safety/agent-write-tracker.js"
    );

    const manager = createOpencodeServerManager();
    const core = new OpencodeCore(
      {
        workspaceDir: tmp,
        dataDir: tmp,
        apiPort: 8321,
        executeTimeoutMinutes: 2,
        opencodeExecutionPermissionMode: "strict",
        character: "",
      },
      new AgentWriteTracker(),
      manager,
    );

    process.stdout.write(`→ opencode smoke (model=${MODEL})\n`);
    const t0 = Date.now();
    let printedAny = false;
    const result = await core.execute(
      {
        prompt: PROMPT,
        context: "",
        event: {
          type: "routine.activity_scan",
          source: "smoke",
          priority: 1,
          timestamp: new Date(),
          data: {},
          correlationId: `smoke-${Date.now()}`,
        },
        modelId: MODEL,
        maxTurns: 1,
        maxBudgetUsd: 0.05,
      },
      {
        onText: (text) => {
          process.stdout.write(text);
          printedAny = true;
        },
      },
    );
    if (!printedAny) process.stdout.write(result.output);
    process.stdout.write("\n");
    const durSec = ((Date.now() - t0) / 1000).toFixed(2);
    process.stdout.write(
      `\n→ assistant=${result.modelId} cost=$${result.costUsd.toFixed(6)} ` +
        `in=${result.usage.inputTokens} out=${result.usage.outputTokens} ` +
        `duration=${durSec}s\n`,
    );
    await manager.shutdown();
    if (!result.output || result.output.trim().length === 0) {
      throw new Error("opencode returned empty output");
    }
    process.stdout.write("PASS\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});

#!/usr/bin/env node
// POC: Verify whether @anthropic-ai/claude-agent-sdk subprocess
// inherits the user's installed Gmail / Calendar / google-workspace plugins.
//
// Mirrors the invocation style used by packages/daemon/src/core/backends/claude-code-core.ts.
// Run from repo root:  node scripts/poc/google-connector-inheritance/claude-sdk-probe.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt =
  'Print every tool name you have access to whose name contains "gmail", "calendar", or "google-workspace" (case-insensitive). ' +
  'One tool name per line. No prose, no markdown fences. If none, print "NONE". Do not call the tools.';

async function main() {
  const toolNames = new Set();
  let finalText = "";
  let systemInit = null;
  let result = null;

  const iter = query({
    prompt,
    options: {
      // Do NOT set mcpServers — we are testing default inheritance.
      // Do NOT pass cwd — let it default so user-level ~/.claude/ config applies.
    },
  });

  for await (const msg of iter) {
    if (msg.type === "system" && msg.subtype === "init") {
      systemInit = {
        model: msg.model,
        tools: Array.isArray(msg.tools) ? msg.tools : [],
        mcpServers: Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [],
      };
      for (const t of systemInit.tools) toolNames.add(t);
    } else if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text") finalText += block.text;
      }
    } else if (msg.type === "result") {
      result = {
        subtype: msg.subtype,
        durationMs: msg.duration_ms,
        costUsd: msg.total_cost_usd,
        numTurns: msg.num_turns,
      };
    }
  }

  const googleToolsInInit = [...toolNames].filter((t) =>
    /gmail|calendar|google-workspace/i.test(t),
  );

  const report = {
    sdkVersion: "0.2.98",
    systemInit: systemInit
      ? {
          model: systemInit.model,
          toolCount: systemInit.tools.length,
          mcpServerCount: systemInit.mcpServers.length,
          mcpServerNames: systemInit.mcpServers.map((s) => s.name ?? s),
        }
      : null,
    googleToolsInInit,
    assistantTextGoogleTools: finalText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /gmail|calendar|google-workspace/i.test(l)),
    result,
    rawAssistantText: finalText.slice(0, 2000),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("POC failed:", err);
  process.exit(1);
});

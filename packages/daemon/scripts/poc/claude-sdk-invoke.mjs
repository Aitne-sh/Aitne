#!/usr/bin/env node
// POC: Actually invoke a Gmail tool via SDK to confirm it returns real user data.

import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt =
  'Using the tool mcp__claude_ai_Gmail__search_threads, search for the query "newer_than:30d" with max_results=3. ' +
  'Report back ONLY: (a) whether the call succeeded, (b) how many threads were returned, ' +
  '(c) the subject of the first thread if any. No other commentary.';

async function main() {
  const toolUses = [];
  const toolResults = [];
  let finalText = "";
  let result = null;
  let systemInit = null;

  const iter = query({
    prompt,
    options: {
      permissionMode: "bypassPermissions",
      allowedTools: [
        "mcp__claude_ai_Gmail__search_threads",
      ],
    },
  });

  for await (const msg of iter) {
    if (msg.type === "system" && msg.subtype === "init") {
      systemInit = { model: msg.model, toolCount: (msg.tools ?? []).length };
    } else if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text") finalText += block.text;
        if (block.type === "tool_use") {
          toolUses.push({ name: block.name, input: block.input });
        }
      }
    } else if (msg.type === "user" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result") {
          toolResults.push({
            is_error: block.is_error ?? false,
            content: typeof block.content === "string" ? block.content.slice(0, 500) : JSON.stringify(block.content).slice(0, 500),
          });
        }
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

  console.log(JSON.stringify({
    systemInit,
    toolUses,
    toolResultsSummary: toolResults.map((r) => ({ is_error: r.is_error, previewLen: r.content.length })),
    toolResultsFirstPreview: toolResults[0]?.content ?? null,
    assistantText: finalText,
    result,
  }, null, 2));
}

main().catch((err) => {
  console.error("POC failed:", err);
  process.exit(1);
});

import type { BackendId } from "@aitne/shared";
import type { McpServer } from "../types.js";
import {
  generateClaudeConfig,
  SPEC_VERSION as CLAUDE_SPEC_VERSION,
} from "./claude.js";
import {
  generateCodexConfig,
  SPEC_VERSION as CODEX_SPEC_VERSION,
} from "./codex.js";
import {
  generateGeminiConfig,
  SPEC_VERSION as GEMINI_SPEC_VERSION,
} from "./gemini.js";
import type { GeneratedMcpConfig, GeneratorOptions } from "./types.js";

export { generateClaudeConfig, generateCodexConfig, generateGeminiConfig };
export type { GeneratedMcpConfig, GeneratorOptions };

/** Spec versions for each backend generator — bumped when the upstream
 *  config shape changes. Surface in `/api/mcp/servers` responses so the
 *  dashboard can warn about incompatibility.
 */
export const GENERATOR_SPEC_VERSIONS = {
  claude: CLAUDE_SPEC_VERSION,
  codex: CODEX_SPEC_VERSION,
  gemini: GEMINI_SPEC_VERSION,
  opencode: "deferred",
} as const satisfies Record<BackendId, string>;

/** Dispatch to the generator for the given backend. */
export function generateMcpConfig(
  backend: BackendId,
  servers: readonly McpServer[],
  options: GeneratorOptions,
): GeneratedMcpConfig {
  switch (backend) {
    case "claude":
      return generateClaudeConfig(servers, options);
    case "codex":
      return generateCodexConfig(servers, options);
    case "gemini":
      return generateGeminiConfig(servers, options);
    case "opencode":
      throw new Error("MCP generation for OpenCode is deferred until OpenCode runtime integration is enabled.");
    default: {
      const never: never = backend;
      throw new Error(`Unsupported backend for MCP generation: ${String(never)}`);
    }
  }
}

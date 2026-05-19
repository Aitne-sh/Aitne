import { z } from "zod";
import { BACKEND_IDS, type BackendId } from "@aitne/shared";

/**
 * B-003 Phase 2 — MCP server model.
 *
 * Source-of-truth shape for a single MCP server definition. Persisted in the
 * `mcp_servers` table; per-server secrets referenced by `envKeys` and
 * `headerKeys` live in the encrypted blob store under
 * `mcp:<serverId>:<keyName>` (never in this table).
 */
export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_RISK_TIERS = ["read", "approve"] as const;
export type McpRiskTier = (typeof MCP_RISK_TIERS)[number];

/**
 * Server id — used as the server name in every generated config file, so it
 * must survive Claude / Codex / Gemini identifier rules. We constrain to
 * lowercase-kebab: `[a-z0-9][a-z0-9-]{0,62}`.
 */
export const McpServerIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "id must be lowercase alphanumeric + dash, starting with a letter or digit",
  );

/**
 * Probe result shape. Persisted verbatim to `last_probe_status` so the
 * dashboard can render the tool list without re-invoking the server.
 */
export const McpProbeResultSchema = z.object({
  ok: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
});
export type McpProbeResult = z.infer<typeof McpProbeResultSchema>;

const BackendIdSchema = z.enum(BACKEND_IDS as unknown as [BackendId, ...BackendId[]]);

export const McpServerSchema = z.object({
  id: McpServerIdSchema,
  name: z.string().min(1).max(200),
  transport: z.enum(MCP_TRANSPORTS),
  command: z.string().min(1).nullable().optional(),
  args: z.array(z.string()).nullable().optional(),
  cwd: z.string().min(1).nullable().optional(),
  url: z.string().url().nullable().optional(),
  envKeys: z.array(z.string().min(1)).default([]),
  headerKeys: z.array(z.string().min(1)).default([]),
  backends: z.array(BackendIdSchema).min(1),
  enabled: z.boolean(),
  riskTier: z.enum(MCP_RISK_TIERS),
  toolAllowlist: z.array(z.string().min(1)).nullable().optional(),
  lastProbeAt: z.number().int().nullable().optional(),
  lastProbeStatus: McpProbeResultSchema.nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/**
 * Transport-shape invariants checked on insert/update. SQLite's CHECK
 * constraint can only enforce the enum; cross-column constraints (stdio
 * needs command, http/sse need url) are enforced here.
 */
export function validateTransportShape(
  input: Pick<McpServer, "transport" | "command" | "args" | "url">,
): { ok: true } | { ok: false; message: string } {
  if (input.transport === "stdio") {
    if (!input.command || input.command.trim().length === 0) {
      return { ok: false, message: "stdio transport requires `command`" };
    }
    if (input.url) {
      return {
        ok: false,
        message: "stdio transport must not set `url`",
      };
    }
    return { ok: true };
  }

  // http / sse
  if (!input.url) {
    return {
      ok: false,
      message: `${input.transport} transport requires \`url\``,
    };
  }
  if (input.command) {
    return {
      ok: false,
      message: `${input.transport} transport must not set \`command\``,
    };
  }
  return { ok: true };
}

/** Encrypted blob name convention for a per-server secret value. */
export function mcpSecretBlobName(serverId: string, keyName: string): string {
  return `mcp:${serverId}:${keyName}`;
}

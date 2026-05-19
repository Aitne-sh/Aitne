import type { ExecutionPermissionMode } from "./backend.js";

export type OpencodePermissionValue = "allow" | "ask" | "deny";

export type OpencodeBashPermission =
  | OpencodePermissionValue
  | Record<string, OpencodePermissionValue>;

export interface OpencodePermissionConfig {
  edit?: OpencodePermissionValue;
  bash?: OpencodeBashPermission;
  webfetch?: OpencodePermissionValue;
  doom_loop?: OpencodePermissionValue;
  external_directory?: OpencodePermissionValue;
}

export interface OpencodeMcpLocalServerConfig {
  type: "local";
  command: string[];
  enabled?: boolean;
  environment?: Record<string, string>;
  /** Tools-listing timeout in ms (opencode defaults to 5000). */
  timeout?: number;
}

export interface OpencodeMcpRemoteServerConfig {
  type: "remote";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  /** Tools-listing timeout in ms (opencode defaults to 5000). */
  timeout?: number;
}

export type OpencodeMcpServerConfig =
  | OpencodeMcpLocalServerConfig
  | OpencodeMcpRemoteServerConfig;

export interface OpencodeRuntimeConfig {
  model?: string;
  small_model?: string;
  permission?: OpencodePermissionConfig;
  tools?: Record<string, boolean>;
  mcp?: Record<string, OpencodeMcpServerConfig>;
  instructions?: string[];
  agent?: Record<string, unknown>;
}

export interface OpencodePermissionBuildInput {
  disallowedTools: readonly string[];
  allowedToolsOverride: readonly string[] | null;
  mcpDisallowed: readonly string[];
  mode: ExecutionPermissionMode;
}

export interface OpencodePermissionBuildResult {
  permission: OpencodePermissionConfig;
  toolsHardDisable: Record<string, boolean>;
  warnings: string[];
}

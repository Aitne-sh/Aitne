import { APP_NAME } from "./branding.js";

/**
 * Default proper-noun the agent uses to sign messages, when the operator
 * has not explicitly set `agentDisplayName`. Tracks `APP_NAME` so a rebrand
 * propagates to fresh installs while existing operators keep whatever name
 * they chose (DB value > default).
 */
export const DEFAULT_AGENT_DISPLAY_NAME = APP_NAME;

export function normalizeAgentDisplayName(
  name: string | null | undefined,
): string {
  const trimmed = (name ?? "").trim().replace(/\s+/g, " ");
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unwrapped || DEFAULT_AGENT_DISPLAY_NAME;
}

export function validateAgentDisplayName(
  name: string | null | undefined,
): string | null {
  const normalized = normalizeAgentDisplayName(name);
  if (normalized.length > 40) {
    return "Must be 40 characters or fewer";
  }
  if (/[\r\n<>]/.test(normalized)) {
    return "Must be a single line without angle brackets";
  }
  return null;
}

export function formatAgentOutboundLabel(
  name: string | null | undefined,
): string {
  return `[${normalizeAgentDisplayName(name)}]`;
}

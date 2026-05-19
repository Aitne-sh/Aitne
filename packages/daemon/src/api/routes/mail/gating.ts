import {
  INTEGRATION_DESCRIPTORS,
  type IntegrationKey,
} from "@aitne/shared";
import type { MailProviderKind } from "../../../services/mail/provider.js";

export const ALL_KINDS: readonly MailProviderKind[] = [
  "gmail",
  "outlook",
  "yahoo",
  "icloud",
];

export const PROVIDER_LABELS: Record<MailProviderKind, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  yahoo: "Yahoo Mail",
  icloud: "iCloud Mail",
};

/**
 * Maps a mail provider kind to the `IntegrationKey` whose mode gates that
 * kind under the §4.8 per-account delegated rule. Kinds outside the
 * registry return null — iCloud, Yahoo, and generic IMAP are direct-only
 * by design and never enter the delegated surface.
 */
export type MailGatedIntegrationKey = Extract<
  IntegrationKey,
  "gmail" | "outlook_mail"
>;

export function gatedIntegrationForKind(
  kind: MailProviderKind,
): MailGatedIntegrationKey | null {
  if (kind === "gmail") return "gmail";
  if (kind === "outlook") return "outlook_mail";
  return null;
}

export function delegatedMailIntegrationMessage(
  key: MailGatedIntegrationKey,
  delegatedBackend: string | null | undefined,
): string {
  const descriptor = INTEGRATION_DESCRIPTORS[key];
  const displayName = descriptor.displayName;
  const owner = delegatedBackend
    ? `delegated to ${delegatedBackend}`
    : "delegated";
  // User-managed connector integrations (Outlook today) ship no
  // daemon-side proxy. The agent must use whatever Outlook MCP /
  // connector the user wired up on the chosen backend; pointing at
  // any daemon-side `/exec` chokepoint (or the retired `/invoke` RPC)
  // would be a lie because no such proxy exists for user-managed keys.
  if (descriptor.userManagedConnector) {
    return [
      `${displayName} is in delegated mode (${owner}).`,
      `The agent backend is expected to use the user-installed ${displayName} MCP / connector tools — the daemon does not proxy this integration.`,
      "Other mail accounts remain available through /api/mail/*.",
    ].join(" ");
  }
  return [
    `${displayName} is in delegated mode (${owner}).`,
    `Same-backend sessions: use the connector's native ${displayName} MCP tools.`,
    `Cross-backend sessions: call POST /api/integrations/${key}/exec (task-mode chokepoint; the legacy /invoke RPC was retired 2026-05-01).`,
    `Non-${displayName} mail accounts remain available through /api/mail/*.`,
  ].join(" ");
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §9.2 — `/api/mail/*` cannot be
 * prefix-gated by `integration-route-gate.ts` because it is
 * multi-provider; the gated kinds (Gmail, Outlook) get a per-account
 * 410 inside the handler. This helper produces the body for
 * `delegated` and `native` modes (the two daemonless modes that have
 * an explicit redirect target — the user's MCP). `disabled` is
 * intentionally NOT gated here: the integration map defaults to
 * `disabled`, and a fresh install with Gmail/Outlook accounts already
 * provisioned would otherwise 410 their entire `/api/mail/*` surface
 * before the user has even visited the mode picker. The integration
 * registry's poller filter handles the `disabled` case at the data
 * path; the route-level 410 for disabled is reserved for the
 * centralised middleware where `apiRoutesTouched` declares prefix
 * coverage.
 *
 * The error codes mirror the centralised middleware's vocabulary so
 * dashboards can branch on the same string regardless of which gate
 * fired.
 */
export function gatedMailIntegrationResponse(
  key: MailGatedIntegrationKey,
  state: {
    mode: string;
    delegatedBackend?: string | null;
    nativeBackend?: string | null;
  },
): {
  error: "integration_delegated" | "integration_native";
  message: string;
  integration: MailGatedIntegrationKey;
  backend: string | null;
  mode: "delegated" | "native";
} | null {
  const descriptor = INTEGRATION_DESCRIPTORS[key];
  const displayName = descriptor.displayName;
  if (state.mode === "delegated") {
    return {
      error: "integration_delegated",
      message: delegatedMailIntegrationMessage(
        key,
        state.delegatedBackend ?? null,
      ),
      integration: key,
      backend: state.delegatedBackend ?? null,
      mode: "delegated",
    };
  }
  if (state.mode === "native") {
    const nb = state.nativeBackend ?? null;
    // User-managed integrations (Outlook) point at the user's installed
    // MCP; descriptor-driven (Gmail) point at the backend's hosted
    // connector and the SKILL.native.<backend>.md body. Mirrors the
    // central route gate's branching so the agent gets symmetric copy
    // whether the request hits a prefix-gated route or a multi-provider
    // route.
    const message = descriptor.userManagedConnector
      ? `${displayName} is in native mode (bound to ${nb ?? "main backend"}). The agent backend is expected to use the user-installed ${displayName} MCP / connector tools — the daemon does not poll and does not expose a proxy for this integration. Other mail accounts remain available through /api/mail/*.`
      : `${displayName} is in native mode (bound to ${nb ?? "main backend"}). Use the backend's native MCP tools (see the SKILL.native.${nb ?? "<backend>"}.md body); the daemon does not poll and does not expose a proxy for this integration. Other mail accounts remain available through /api/mail/*.`;
    return {
      error: "integration_native",
      message,
      integration: key,
      backend: nb,
      mode: "native",
    };
  }
  return null;
}

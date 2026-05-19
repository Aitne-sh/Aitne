import type {
  BackendId,
  IntegrationKey,
  IntegrationMode,
} from "@aitne/shared";
import type { IntegrationListItem } from "@/lib/api-types";

/**
 * Per-mode explainer copy used by ModeExplainer (the radio-card mode
 * picker). Brief lines render inline next to each radio; bullet lists
 * appear inside the "Details" disclosure under each card.
 *
 * Wording is intentionally action-oriented (what happens, what it costs,
 * what you need) rather than generic ("flexible", "powerful"). The mode
 * picker has historically given users no way to make an informed choice;
 * this copy is the explanation surface that fixes that.
 *
 * Direct-mode credential language is integration-key-aware so the bullet
 * for git/github (local CLI, no daemon-managed credential) does not lie
 * about needing a GCP / Notion key.
 */

export interface ModeExplainerCopy {
  /** Human label rendered next to the radio. */
  title: string;
  /** Short single-sentence summary visible without expanding details. */
  brief: string;
  /** Bullet list under the "Details" disclosure. */
  details: readonly string[];
  /** When set, rendered as a subdued footnote below the bullet list. */
  footnote?: string;
}

/**
 * What direct-mode setup looks like for a given integration. Drives the
 * "Requires …" bullet inside the Direct details so each integration
 * names its actual credential surface instead of a generic example list.
 */
function directSetupSentence(key: IntegrationKey): string {
  switch (key) {
    case "gmail":
    case "google_calendar":
      return "Requires a Google Cloud OAuth credential — upload the credentials JSON and complete the browser consent step on this screen before the daemon can poll.";
    case "notion":
      return "Requires a Notion internal-integration API key — paste it in this app and share each target database with the integration in Notion.";
    case "git":
      return "Requires the local git CLI plus a watched-repository list — no credential is stored in this app; the daemon reads the repos with your existing git config.";
    case "github":
      return "Requires the local gh CLI authenticated outside the daemon (gh auth login) — no credential is stored in this app; the daemon shells out to gh.";
    case "outlook_mail":
    case "outlook_calendar":
      return "Requires a Microsoft Identity (Azure BYOA) client config plus a per-account MSAL sign-in for each Outlook mailbox.";
  }
}

/**
 * Concrete sentence describing the cross-backend flow for the chosen
 * integration. This is the wording the user explicitly asked for:
 *   "main agent (Claude) → this app's API → Gemini CLI → Gmail".
 *
 * Generated from the integration's display name so the example reads
 * naturally (e.g. Notion / Calendar / Gmail) without a separate copy
 * site per integration.
 */
function delegatedFlowSentence(displayName: string): string {
  return `Concrete flow: your main DM agent (e.g. Claude) is asked to read ${displayName}; it calls this app's API; the daemon invokes the chosen CLI (e.g. Gemini CLI) which uses its already-configured connector to talk to ${displayName}; the result flows back through the daemon to your main agent.`;
}

/**
 * Pretty-print a backend id for end-user copy. Keeps the codepoints in the
 * brief / details lines stable across CLI ids (which match the backend
 * provider name today, but a future "claude-pro" / "codex-cloud" split
 * should not break the explainer copy).
 */
function backendDisplay(backend: BackendId | null | undefined): string {
  switch (backend) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "opencode":
      return "OpenCode";
    default:
      return "your main backend";
  }
}

/**
 * Build the explainer copy for one mode of one integration. The integration
 * descriptor is read for displayName + key so the sentences read naturally
 * for each card and the credential setup language is correct.
 *
 * `mainBackend` carries the current `backend_global_defaults.default_backend`.
 * It only affects the native variant's copy — every other branch is
 * insensitive. Passing `null` (no main backend selected yet) falls back to
 * a generic "your main backend" phrasing so the wizard's first-launch
 * Mail/Calendar step can render the card before the main backend is set.
 */
export function buildModeExplainer(
  mode: IntegrationMode,
  descriptor: IntegrationListItem,
  mainBackend: BackendId | null = null,
): ModeExplainerCopy {
  const name = descriptor.displayName;
  if (mode === "direct") {
    return {
      title: "Direct",
      brief: `The daemon talks to ${name} itself using credentials you provide.`,
      details: [
        `Lowest token cost — your conversation backend (Claude / Codex / Gemini) does not pay tokens to fetch ${name} data; the daemon makes the API call directly and hands results to the agent.`,
        `Built-in safety guardrails apply: the daemon classifies destructive operations (send / delete / overwrite) and routes them through approval flows before they reach ${name}.`,
        directSetupSentence(descriptor.key),
        `Local observers stay on — receipts, travel, calendar-imminent alerts, and FTS5 search continue to run.`,
      ],
      footnote:
        "Recommended when you have the credentials ready and want the lowest token cost.",
    };
  }

  if (mode === "delegated") {
    return {
      title: "Delegated",
      brief: `Reuse Claude Code / Gemini CLI / Codex's existing connectors (MCP, plugin, or built-in connector) to reach ${name}.`,
      details: [
        `When the agent needs ${name} data, the daemon invokes the chosen CLI (Claude Code / Codex / Gemini) which calls ${name} through its already-configured connector. A small per-call token cost is incurred each time the CLI is invoked.`,
        delegatedFlowSentence(name),
        `Effective when the backend that handles your DM conversation differs from the backend that has the ${name} connector — for example, a Claude Code main agent borrowing Gemini CLI's Gmail connector to save on Claude tokens or to leverage a connector you already configured there.`,
        `No extra credentials live in this app — auth is whatever Claude / Codex / Gemini already had configured (claude.ai/connections, ~/.codex MCP entries, ~/.gemini extensions).`,
        `Daemon-side safety guardrails run more loosely here because the actual API call happens inside the CLI, not on the daemon. Per-tool deny-lists still apply on the proxy layer.`,
      ],
      footnote:
        "Recommended when you want one backend to handle conversation and another to handle integration access, or when you do not want to manage GCP / Notion credentials yourself.",
    };
  }

  if (mode === "native") {
    const bk = backendDisplay(mainBackend);
    return {
      title: `Native — via ${bk}`,
      brief: `Your DM agent (${bk}) reaches ${name} directly through its own connector — no background polling and no daemon-side proxy.`,
      details: [
        `Pick this when you already use ${bk}'s ${name} connector for ad-hoc work and just want the agent's hourly check and DM replies to use the same connector instead of the daemon. No background poller runs, no delegated worker ticks, no per-call proxy hop — the agent fetches in-turn when it needs ${name}.`,
        `Token cost moves from the (cheap) delegated worker to your main DM session. Reads sit on the same prompt as the rest of the turn, which raises the medium-tier token bill — typically by an order of magnitude per integration vs. delegated. Worth it when you would otherwise leave the integration "Disabled" and lose hourly-check awareness entirely.`,
        `${bk} must already have its ${name} connector configured (e.g. claude.ai/connections for Claude, an MCP entry for Codex, an extension for Gemini). The daemon never sees your ${name} credentials; auth and revocation live in ${bk}.`,
        `Daemon-side safety guardrails (destructive-op confirmation, deny-lists) still cover the absolute-block layer. Per-tool deny lists do NOT apply here — the call never crosses the daemon proxy, so deny enforcement is whatever your backend allows.`,
        `If you switch the main backend later, this row is automatically flipped to Disabled and you'll be asked to re-configure. Native is an explicit binding to the backend, not a routing rule.`,
      ],
      footnote: `Recommended when ${bk} already has the ${name} connector wired up and you want the agent to use it for hourly check / DM, instead of either running a background poller or leaving the integration disabled.`,
    };
  }

  return {
    title: "Disabled",
    brief: `The daemon does not observe or act on ${name} at all.`,
    details: [
      `The agent loses awareness of ${name} entirely — no observers, no skill body, no task-flow guidance. It will not bring up ${name} data on its own.`,
      `Pick this when the backend you DM with already has ${name} access through its own connectors and you do not need cross-backend delegation. Your agent can still answer ad-hoc questions about ${name} via that backend's native tools, but the daemon will not orchestrate it.`,
      `Pick this when you simply do not use ${name}.`,
      `Switching back to direct or delegated later is one click; no data is destroyed.`,
    ],
    footnote:
      "Recommended when this integration is not relevant to you, or your main backend already covers it natively.",
  };
}

/**
 * Inline label for the currently-selected mode, used in places where the
 * mode badge is rendered alongside other elements (e.g. card header).
 *
 * Mirrors the existing `modeLabel` helper but reads from the explainer
 * copy so the two stay aligned without a second copy site.
 */
export function modeShortLabel(mode: IntegrationMode): string {
  if (mode === "direct") return "Direct";
  if (mode === "delegated") return "Delegated";
  if (mode === "native") return "Native";
  return "Disabled";
}

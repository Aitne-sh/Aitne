import type { BackendId, IntegrationKey } from "@aitne/shared";
import type { IntegrationListItem } from "@/lib/api-types";
import { capabilityLabel } from "./integration-card.logic";

/**
 * Pure logic for the direct→delegated warning modal (§4.12.4). The component
 * layer renders the returned strings / lists; the decisions live here so the
 * multi-line copy can be unit-tested without React.
 */

// ── Direct-mode feature losses ─────────────────────────────────────────────

/**
 * Features the user loses when flipping an integration from direct → delegated.
 * These are NOT connector capabilities (those may shrink too, but that's the
 * `buildFeatureMatrix` concern) — they are **framework** losses the design
 * calls out: observers stop, FTS5 search goes away, multi-account collapses,
 * classifier shuts off, 15-min alerts downgrade to hourly granularity.
 *
 * The list is hand-curated per-integration and per-backend because the design
 * is specific about which combinations lose which features (e.g. Gmail+Claude
 * Draft-Only also loses direct Send/Forward/Delete/Attachment above the
 * framework-level losses).
 */
export interface DirectToDelegatedLoss {
  /** One-sentence user-facing description. */
  message: string;
  /**
   * When true, the loss is reversible by flipping back to direct — design
   * guarantees tokens stay dormant by default. The modal highlights
   * non-reversible losses in stronger language.
   */
  reversible: boolean;
}

export function directToDelegatedLosses(
  key: IntegrationKey,
  backend: BackendId,
  descriptor: IntegrationListItem,
): DirectToDelegatedLoss[] {
  const losses: DirectToDelegatedLoss[] = [];

  if (key === "gmail") {
    losses.push(
      {
        message:
          "Mail poller stops observing Gmail — receipts, travel, and Kindle classifiers will not run against new messages.",
        reversible: true,
      },
      {
        message:
          "Local FTS5 search on Gmail messages is unavailable. The agent searches through its backend connector instead.",
        reversible: true,
      },
      {
        message:
          "Only one Google account is reachable at a time. Additional Gmail accounts will be disabled.",
        reversible: true,
      },
    );
  }

  if (key === "google_calendar") {
    losses.push(
      {
        message:
          "Calendar poller stops running. Event awareness drops from 5-minute to hourly granularity.",
        reversible: true,
      },
      {
        message:
          "15-minute imminent-event alerts are unavailable — the agent learns about new events on the next hourly check.",
        reversible: true,
      },
    );
  }

  if (key === "notion") {
    // NOTION_DELEGATION_DESIGN.md §3.2 + §7.1. Page-archive does have
    // workarounds documented in the delegated skill body (status-property
    // update, move to a designated trash page) — phrase that loss as
    // "no native trash op" rather than "no archive at all".
    losses.push(
      {
        message:
          "Notion poller stops observing database edits. Recent-edit awareness shifts from per-poll to inline notion-search inside the hourly check, with reduced recall on less-typed databases.",
        reversible: true,
      },
      {
        message:
          "Structured property filter on database queries is unavailable. The agent falls back to semantic notion-search plus client-side filtering — fine for small databases, awkward for >100-row workspaces.",
        reversible: true,
      },
      {
        message:
          "Native page archive is unavailable. The agent uses workarounds (status-property update, or move-to-trash-page) and DMs you naming the workaround taken.",
        reversible: true,
      },
    );
  }

  if (key === "git") {
    losses.push(
      {
        message:
          "GitWatcher stops polling directly. Git lifecycle checks move to a scheduled backend session, so detection is bounded by the delegated cadence and backend quota.",
        reversible: true,
      },
      {
        message:
          "Daemon-side project document updates no longer run from direct classifier output. The delegated session must inspect the repo and update context through the project-doc API.",
        reversible: true,
      },
    );
  }

  if (key === "github") {
    losses.push(
      {
        message:
          "GitHubPoller stops polling notifications and workflow runs directly. The delegated session uses gh read-only checks on its cadence instead.",
        reversible: true,
      },
      {
        message:
          "Review requests, CI failures, assignments, and security alerts may arrive later because they depend on the delegated cron tick.",
        reversible: true,
      },
    );
  }

  // Outlook is user-managed — the daemon ships no descriptor-side
  // connector, so the dialog must call out the operator's responsibility
  // before they flip the mode.
  if (key === "outlook_mail") {
    losses.push(
      {
        message:
          "Mail poller stops observing Outlook accounts; receipts, travel, and Kindle classifiers will not run against new Outlook messages.",
        reversible: true,
      },
      {
        message:
          "Local FTS5 search on Outlook messages is unavailable. The agent searches through whichever Outlook MCP / connector you have wired up on the selected backend.",
        reversible: true,
      },
      {
        message:
          `You must register an Outlook / Microsoft Graph MCP server on the ${backend} backend before the agent can send, read, or label Outlook mail. The daemon does not proxy this integration.`,
        reversible: false,
      },
    );
  }

  if (key === "outlook_calendar") {
    losses.push(
      {
        message:
          "On-demand Outlook calendar reads via /api/calendar/outlook return 410. Calendar awareness depends entirely on the MCP / connector you configure on the selected backend.",
        reversible: true,
      },
      {
        message:
          `You must register an Outlook / Microsoft Graph MCP server on the ${backend} backend that exposes calendar reads/writes. The daemon does not proxy this integration.`,
        reversible: false,
      },
    );
  }

  // Per-backend connector gap — Claude Gmail is draft-only.
  const connector = descriptor.backendConnectors[backend];
  if (connector && key === "gmail") {
    const missingInDelegated = [
      "send",
      "forward",
      "delete",
      "read_attachment",
    ].filter((c) => !connector.optionalCapabilities.includes(c));
    for (const cap of missingInDelegated) {
      losses.push({
        message: `${capabilityLabel(cap)} is unavailable on this backend — the agent will draft but not ${verbFor(cap)}.`,
        reversible: true,
      });
    }
  }

  return losses;
}

function verbFor(cap: string): string {
  switch (cap) {
    case "send":
      return "send";
    case "forward":
      return "forward";
    case "delete":
      return "archive or delete";
    case "read_attachment":
      return "read attachments";
    default:
      return cap;
  }
}

// ── Native-mode cost delta (§11.6 / §14.4) ─────────────────────────────────

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §14.4 — reference cost figures used
 * by the "Switch to native" dialog. The design's back-of-envelope:
 *
 *   - Delegated (Haiku $0.25/$1.25 per MTok): ~$0.014/day per integration
 *   - Native (Sonnet $3/$15 per MTok): ~$0.39/day per integration
 *   - ~25–30× shift per integration when switching delegated → native
 *
 * We render these as a "typical delta" range rather than a precise
 * estimate because the actual numbers depend on the integration's
 * observation volume, the user's per-process backend overrides, and the
 * specific tools the connector calls per turn. A precise number would
 * require joining `process_backend_config` to the previous 30-day
 * observation count — Phase C ships the static range; a measurement-
 * driven follow-up (§16 open question 0) replaces it later.
 *
 * Numbers are USD per day for the named source-mode → native transition.
 */
export interface NativeCostDelta {
  /** Approximate USD/day in the source mode (delegated or polling poller). */
  fromDailyUsd: number;
  /** Approximate USD/day after the native flip. */
  toDailyUsd: number;
  /** Approximate USD/year delta (toDailyUsd − fromDailyUsd) × 365. */
  yearlyDeltaUsd: number;
  /** Multiplier (toDailyUsd / fromDailyUsd) when source > 0; null when N/A. */
  multiplier: number | null;
  /** Human-readable source label rendered in the chip prefix. */
  fromLabel: string;
}

export function nativeCostDelta(
  fromMode: "direct" | "delegated" | "disabled",
): NativeCostDelta {
  // §14.4 figures, expressed per-day.
  const DELEGATED_DAILY = 0.014;
  const DIRECT_DAILY = 0.0; // direct mode pays no LLM tokens for the fetch
  const NATIVE_DAILY = 0.39;
  const fromDaily =
    fromMode === "delegated"
      ? DELEGATED_DAILY
      : fromMode === "direct"
        ? DIRECT_DAILY
        : 0;
  const yearlyDelta = Math.round((NATIVE_DAILY - fromDaily) * 365);
  const multiplier = fromDaily > 0 ? Math.round(NATIVE_DAILY / fromDaily) : null;
  const fromLabel =
    fromMode === "delegated"
      ? "delegated worker"
      : fromMode === "direct"
        ? "direct poller (no LLM tokens)"
        : "disabled (no fetch at all)";
  return {
    fromDailyUsd: fromDaily,
    toDailyUsd: NATIVE_DAILY,
    yearlyDeltaUsd: yearlyDelta,
    multiplier,
    fromLabel,
  };
}

/** Format a USD/day figure for the delta chip. */
export function formatDailyUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `<$0.01`;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

// ── Native-mode flip impact ────────────────────────────────────────────────

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.3 / §11.6 — what the user trades
 * when flipping into native mode. Mirrors {@link directToDelegatedLosses}
 * in shape but the "losses" here are mostly things the user is opting OUT
 * of (poller cadence, worker ticks, daemon-side dedup) rather than
 * capabilities. The card surfaces these so the user understands the
 * shift from background to in-turn data collection.
 */
export interface ToNativeImpact {
  message: string;
  /** True when the impact is reversible by switching the mode back. */
  reversible: boolean;
}

export function toNativeImpacts(
  fromMode: "direct" | "delegated" | "disabled",
  descriptor: IntegrationListItem,
  toBackend: BackendId,
): ToNativeImpact[] {
  const out: ToNativeImpact[] = [];
  const name = descriptor.displayName;

  if (fromMode === "direct") {
    out.push({
      message: `The daemon's background poller for ${name} stops. The agent fetches via ${toBackend}'s native connector during DM and hourly_check turns instead.`,
      reversible: true,
    });
    out.push({
      message: `Local FTS5 search / classifier passes (receipts, travel, Kindle for mail; calendar reconcile for events) stop running. Direct-mode data already in the DB stays searchable; new data lands as in-turn observations only.`,
      reversible: true,
    });
    // §11.3 keep-dormant default — the native flip does not offer the
    // direct→delegated TokenHandlingPicker (no proxy worker to feed), so
    // the OAuth credentials stay in the keychain by default. Call this
    // out explicitly so users don't assume `direct → native` revokes
    // their tokens — a flip back to direct will re-use them without
    // re-consent. Users who want to purge can re-flip to delegated +
    // Purge, then to native; the registry's `directSetup.credentialKeys`
    // drives that deletion.
    out.push({
      message: `Your direct-mode credentials for ${name} stay in the keychain (dormant) so a future flip back to direct re-uses them without re-consent. Delete them explicitly via the direct→delegated "Purge from keychain" flow if you want them gone.`,
      reversible: true,
    });
  }

  if (fromMode === "delegated") {
    out.push({
      message: `The delegated-sync worker stops ticking on its cadence. Observations land at hourly_check granularity instead, fetched by the main DM session itself.`,
      reversible: true,
    });
    out.push({
      message: `Per-call proxy cost shifts from the (cheap) lite-tier delegated model to your main DM session's medium tier — typically ~20–30× more expensive per fetch.`,
      reversible: true,
    });
  }

  if (fromMode === "disabled") {
    out.push({
      message: `The integration becomes reachable from hourly_check and DM again — currently it is silent. No background poller runs; the agent fetches in-turn.`,
      reversible: true,
    });
  }

  // Apply across-from-mode for every native flip:
  out.push({
    message: `${toBackend} must already have its ${name} connector configured (e.g. claude.ai/connections, ~/.codex MCP entry, or ~/.gemini extension). The daemon does not see ${name} credentials.`,
    reversible: false,
  });
  out.push({
    message: `Switching the main backend later automatically disables this row (an explicit binding, not a routing rule). You'll be asked to re-configure on the new backend.`,
    reversible: true,
  });

  return out;
}

// ── Multi-account warning ──────────────────────────────────────────────────

/**
 * §4.12.4 "Multi-account direct → delegated" — when the user has more than
 * one Gmail account configured in direct mode, delegated collapses to one.
 * The card passes the count it reads from `/api/mail/accounts`; this helper
 * decides whether to show the warning.
 *
 * Returns `null` when no warning is needed.
 */
export function multiAccountWarning(
  key: IntegrationKey,
  gmailAccountCount: number,
): string | null {
  if (key !== "gmail") return null;
  if (gmailAccountCount <= 1) return null;
  const dropped = gmailAccountCount - 1;
  const plural = dropped === 1 ? "account" : "accounts";
  return `Delegated mode supports one Google account. Your other ${dropped} Gmail ${plural} will be disabled (tokens kept — re-enable by switching back to direct).`;
}

// ── Delegated → direct resume message ──────────────────────────────────────

/**
 * Per-integration copy for the resume-message wording. Direct-mode setup
 * differs in shape (OAuth flow vs. paste-an-API-key) and the credential
 * noun changes singular/plural agreement, so the wording is built from
 * full clauses rather than interpolated nouns.
 */
interface DirectModeResumeShape {
  /** Subject + verb clause, e.g. "Gmail OAuth tokens are still in the keychain". */
  presentClause: string;
  /** Subject + verb clause, e.g. "Gmail has no OAuth tokens yet". */
  absentClause: string;
  /** Setup phrase to fill `Switching to direct will walk through ${...}`. */
  setupPhrase: string;
}

const DIRECT_MODE_RESUME: Readonly<Record<IntegrationKey, DirectModeResumeShape>> = {
  gmail: {
    presentClause: "Gmail OAuth tokens are still in the keychain",
    absentClause: "Gmail has no OAuth tokens yet",
    setupPhrase: "the 5-step Google Cloud setup",
  },
  google_calendar: {
    presentClause: "Google Calendar OAuth tokens are still in the keychain",
    absentClause: "Google Calendar has no OAuth tokens yet",
    setupPhrase: "the 5-step Google Cloud setup",
  },
  notion: {
    presentClause: "The Notion API key is still in the keychain",
    absentClause: "Notion has no API key in the keychain yet",
    setupPhrase:
      "creating a Notion internal integration, pasting the key, and sharing each database with the integration",
  },
  git: {
    presentClause: "Git direct mode uses the local git CLI and watched repository list",
    absentClause: "Git direct mode needs watched repositories before it can poll",
    setupPhrase: "adding at least one watched repository",
  },
  github: {
    presentClause: "GitHub direct mode uses the local gh CLI",
    absentClause: "GitHub direct mode needs gh auth login outside the daemon",
    setupPhrase: "authenticating the gh CLI and optionally adding watched repositories",
  },
  // SETUP-FLOW-REDESIGN-PLAN §6.1 — Outlook does not support delegated mode
  // in v1 (`supportedModes: ["direct", "disabled"]`), so the
  // delegated→direct resume dialog never reaches these branches. Entries
  // exist to satisfy the exhaustive `Record<IntegrationKey, …>` contract;
  // copy mirrors the BYOA + per-account MSAL token model documented in the
  // §5.4 / §5.5 wizard steps so a future widening is correct on day one.
  outlook_mail: {
    presentClause: "The Outlook BYOA client config is still in the keychain",
    absentClause: "Outlook has no BYOA client config in the keychain yet",
    setupPhrase: "registering a Microsoft Identity (Azure) app and authenticating each Outlook mailbox",
  },
  outlook_calendar: {
    presentClause: "The Outlook BYOA client config is still in the keychain (shared with Outlook Mail)",
    absentClause: "Outlook Calendar has no BYOA client config to reuse yet",
    setupPhrase: "registering a Microsoft Identity (Azure) app via the Outlook Mail card",
  },
  // Browser history is direct-only — there is no delegated→direct resume
  // path. Entry exists to satisfy the exhaustive Record<IntegrationKey, …>
  // contract; copy mirrors the on-device consent latch model.
  browser_history: {
    presentClause: "Browser history consent is already accepted on this device",
    absentClause: "Browser history consent has not been accepted yet",
    setupPhrase: "accepting the on-device browser history consent latch",
  },
};

export function delegatedToDirectResumeMessage(
  key: IntegrationKey,
  credentialsPresent: boolean,
): string {
  const shape = DIRECT_MODE_RESUME[key];
  if (credentialsPresent) {
    return `${shape.presentClause}. Switching back re-enables polling with no re-consent step.`;
  }
  return `${shape.absentClause}. Switching to direct will walk through ${shape.setupPhrase}.`;
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.3 — message rendered when the user
 * flips a native row to direct mode. Mirrors {@link delegatedToDirectResumeMessage}
 * but the surrounding context is different: native mode left the daemon
 * with no credentials by design (auth was on the backend), so a flip to
 * direct always requires the credential setup unless the user previously
 * had direct mode configured and the keychain still carries the secrets.
 */
export function nativeToDirectResumeMessage(
  key: IntegrationKey,
  credentialsPresent: boolean,
): string {
  const shape = DIRECT_MODE_RESUME[key];
  if (credentialsPresent) {
    return `${shape.presentClause} from a previous direct-mode setup. Switching back re-enables polling without re-consent.`;
  }
  return `${shape.absentClause} — native mode left credential management to the backend. Switching to direct will walk through ${shape.setupPhrase}.`;
}

// ── Purge copy + targets (direct→delegated, "Purge from keychain") ────────

export interface PurgeCopy {
  /** Concrete secret-store keys to DELETE on confirm. */
  secretKeys: readonly string[];
  /** Body of the radio option (Picker). */
  optionDescription: string;
  /** Title of the second-confirmation dialog. */
  confirmTitle: string;
  /** Description of the second-confirmation dialog. */
  confirmDescription: string;
}

/**
 * Build the per-integration "Purge from keychain" copy + the secret-store
 * keys to delete on confirm. Driven by `descriptor.directSetup.credentialKeys`
 * so the dashboard never invents a key the registry didn't declare — this
 * was the root cause of the pre-fix bug where flipping Notion direct →
 * delegated + Purge would delete `googleCredentialsJson + googleTokenJson`.
 *
 * Returns null when the descriptor has no `directSetup` block (delegated-only
 * integration); the dialog suppresses the picker entirely in that case.
 */
export function purgeCopyForIntegration(
  descriptor: IntegrationListItem,
): PurgeCopy | null {
  const credentialKeys = descriptor.directSetup?.credentialKeys ?? [];
  if (credentialKeys.length === 0) return null;
  const shape = DIRECT_MODE_RESUME[descriptor.key];
  const keyList = credentialKeys.join(" + ");
  return {
    secretKeys: credentialKeys,
    optionDescription: `Deletes ${keyList} from the keychain after the mode flip. Reverting to direct later will require ${shape.setupPhrase}. Asks for a second confirmation.`,
    confirmTitle: `Purge ${descriptor.displayName} credentials?`,
    confirmDescription: `This removes ${keyList} from the keychain. To restore direct mode later you will need to redo ${shape.setupPhrase}.`,
  };
}

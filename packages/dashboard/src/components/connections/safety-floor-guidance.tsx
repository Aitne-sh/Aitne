"use client";

import type { BackendId, IntegrationKey } from "@aitne/shared";
import { Card } from "@/components/ui/card";

/**
 * DELEGATED-MODE-V2-DESIGN.md §7.1 — Safety guidance prose, US-English,
 * verbatim per Decision Log #11. Rendered above the deny-list editor on
 * the `/connections/<integration>` card. The wording is canonical and
 * intentionally direct: "single-operator audience, no corporate hedging."
 *
 * Entry structure mirrors the design exactly:
 * - When `parenNote` is set, it renders inside parentheses immediately
 *   after the tool name (matches `send_email (sending a freshly-composed
 *   message)` shape).
 * - `verdict` always renders after an em-dash and is italicized
 *   (matches `— *strictly destructive*` shape).
 */

interface Props {
  integrationKey: IntegrationKey;
  delegatedBackend: BackendId;
}

interface StarterEntry {
  tool: string;
  /** Optional parenthetical note rendered as `(...)` after the tool name. */
  parenNote?: string;
  /** Italicized verdict rendered after an em-dash. */
  verdict: string;
}

interface BackendStarterBlock {
  /** Heading line, rendered bold. */
  heading: string;
  /** Optional preamble paragraph rendered between heading and bullet list. */
  preamble?: string;
  /** Pre-populated bullet list. */
  entries: readonly StarterEntry[];
}

const STARTER_BLOCKS: Readonly<
  Partial<Record<IntegrationKey, Partial<Record<BackendId, BackendStarterBlock>>>>
> = {
  gmail: {
    codex: {
      heading: "Gmail (delegated to Codex) — pre-populated entries:",
      entries: [
        {
          tool: "send_email",
          parenNote: "sending a freshly-composed message",
          verdict: "strictly destructive",
        },
        {
          tool: "delete_emails",
          parenNote: "move to Trash — the connector's only delete primitive",
          verdict: "strictly destructive",
        },
        {
          tool: "archive_emails",
          parenNote: "archive",
          verdict: 'recoverable from "All Mail" but easy to lose track of',
        },
        {
          tool: "apply_labels_to_emails",
          verdict: "mutating; can hide threads",
        },
      ],
    },
    claude: {
      heading:
        "Gmail (delegated to Claude) — the hosted Gmail connector is draft-only (no send / delete / archive). The only mutating ops are label changes:",
      entries: [
        { tool: "label_message", verdict: "mutating" },
        { tool: "label_thread", verdict: "mutating" },
      ],
    },
  },
  google_calendar: {
    codex: {
      heading: "Google Calendar — pre-populated entries:",
      entries: [
        { tool: "delete_event", verdict: "strictly destructive" },
        {
          tool: "update_event",
          parenNote: "edits to existing events",
          verdict:
            "mutating; not strictly destructive but easy to undo wrong",
        },
      ],
    },
    claude: {
      heading: "Google Calendar — pre-populated entries:",
      entries: [
        { tool: "delete_event", verdict: "strictly destructive" },
        {
          tool: "update_event",
          parenNote: "edits to existing events",
          verdict:
            "mutating; not strictly destructive but easy to undo wrong",
        },
      ],
    },
  },
};

export function SafetyFloorGuidance({
  integrationKey,
  delegatedBackend,
}: Props) {
  const block = STARTER_BLOCKS[integrationKey]?.[delegatedBackend];

  return (
    <Card className="bg-amber-50/40 dark:bg-amber-950/20">
      <h4 className="text-sm font-semibold">Your destructive-action floor</h4>
      <p className="mt-2 text-xs text-muted-foreground">
        By default, the wizard pre-populated the destructive tools below into
        your deny list. The agent can still read, search, and draft — it just
        can&apos;t send, archive, or delete unless you remove the corresponding
        entry.
      </p>

      {block && (
        <div className="mt-3 space-y-2 text-xs">
          <p className="font-medium text-foreground">{block.heading}</p>
          {block.preamble && (
            <p className="text-muted-foreground">{block.preamble}</p>
          )}
          <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
            {block.entries.map((entry) => (
              <li key={entry.tool}>
                <code className="font-mono text-[11px] text-foreground">
                  {entry.tool}
                </code>
                {entry.parenNote && (
                  <span> ({entry.parenNote})</span>
                )}
                <span> — </span>
                <em>{entry.verdict}</em>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Why these defaults?</span>{" "}
          The list errs conservative on purpose: the floor here is what keeps
          the CLAUDE.md{" "}
          <em>&quot;destructive ops require user confirmation&quot;</em>{" "}
          invariant intact on a fresh install. If you want the agent to
          archive freely, remove <code className="font-mono">archive_emails</code>.
          If you trust it to update calendar events, remove{" "}
          <code className="font-mono">update_event</code>. The strictly-destructive
          entries (<code className="font-mono">send_email</code>,{" "}
          <code className="font-mono">delete_emails</code>,{" "}
          <code className="font-mono">delete_event</code>) are the ones we
          recommend keeping.
        </p>
        <p>
          Tool names are bare — no <code className="font-mono">mcp__*</code>{" "}
          prefix, no leading underscore (the daemon prepends the connector&apos;s
          namespace before forwarding). They match the connector you&apos;ve
          delegated to: Codex Gmail uses <code className="font-mono">send_email</code>/
          <code className="font-mono">delete_emails</code>/etc., Claude Gmail
          uses <code className="font-mono">label_message</code>/
          <code className="font-mono">label_thread</code>/etc. Patterns
          support <code className="font-mono">*</code> as a suffix — for
          example, <code className="font-mono">delete_*</code> matches
          everything that starts with <code className="font-mono">delete_</code>.
        </p>
        <p>
          Anything you deny here is rejected at the daemon, regardless of which
          path the agent takes (direct API, cross-backend proxy, or same-backend
          native MCP).
        </p>
      </div>
    </Card>
  );
}

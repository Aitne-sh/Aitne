"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lightbulb, RefreshCw, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface Tip {
  id: string;
  title: string;
  description: string;
  href?: string;
  cta?: string;
  badge?: string;
}

// Surfaces buried-but-useful capabilities. Order is presentation-only —
// the card picks one at random per mount. Keep entries concrete (link to
// the page that turns it on) and avoid overlap with what the user
// already sees on the overview (next check, today's cost, integrations).
export const TIPS: ReadonlyArray<Tip> = [
  {
    id: "self-learning",
    badge: "Preview",
    title: "Self-learning mode tunes its own skills",
    description:
      "Let the agent analyze how you actually work and curate small overlays on top of its built-in skills — so the daily-surface (today, schedule, user-profile) gets sharper over time without you editing prompts.",
    href: "/settings/self-learning",
    cta: "Enable self-learning",
  },
  {
    id: "voice",
    title: "Voice messages, transcribed on-device",
    description:
      "Send a Telegram voice note or WhatsApp PTT and the daemon transcribes it locally with Whisper before the agent reads it. Audio never leaves your machine.",
    href: "/settings/advanced",
    cta: "Turn on Voice mode",
  },
  {
    id: "harness",
    title: "Reuses your CLI agent harness as-is",
    description:
      "The brain runs as Claude Code, Codex, or Gemini CLI — the same hooks, skills, MCP servers, and permission model you already use in the terminal apply here.",
    href: "/settings/models",
    cta: "Choose a backend",
  },
  {
    id: "process-routing",
    title: "Different models for different jobs",
    description:
      "Route deep work like morning routines and DMs to Sonnet or Opus, and light triage like mail classification to Haiku — per ProcessKey, swappable any time.",
    href: "/settings/processes",
    cta: "Tune process routing",
  },
  {
    id: "md-memory",
    title: "Memory is plain Markdown you can read",
    description:
      "Every durable thing the agent learns lives in ~/.personal-agent/context/*.md. Open it in your editor, grep it, version it — there is no hidden vector store.",
    href: "/knowledge",
    cta: "Browse Knowledge",
  },
  {
    id: "messaging",
    title: "DM the agent on your favorite app",
    description:
      "Pair Slack, Telegram, Discord, or WhatsApp with a single magic phrase and chat with the agent from there. Single-owner only by design — no group chats.",
    href: "/settings/messaging",
    cta: "Set up messaging",
  },
  {
    id: "observations",
    title: "Hourly observations, not reactive polling",
    description:
      "Obsidian, Git, Notion, and Calendar changes flow into an observations queue. Once an hour the agent consolidates what changed and decides whether to act.",
    href: "/activity",
    cta: "See recent activity",
  },
  {
    id: "routines",
    title: "Morning, evening, and weekly routines",
    description:
      "Cron-driven routines reflect on your day, week, and month automatically — quiet hours respected, day boundary at 04:00 local. Fully customizable.",
    href: "/settings/routines",
    cta: "Customize routines",
  },
  {
    id: "mail",
    title: "Multi-provider mail with offline FTS5 search",
    description:
      "Gmail, Outlook, Yahoo, iCloud, and any IMAP account stream into a single local index. Search instantly, even when you're offline.",
    href: "/connections/mail",
    cta: "Connect a mailbox",
  },
  {
    id: "schedule",
    title: "It schedules itself",
    description:
      "Say 'remind me Friday at 4pm' or 'every Monday morning summarize my open PRs' — the agent owns its own schedule rows and wakes itself when the time comes.",
    href: "/schedule",
    cta: "View schedule",
  },
  {
    id: "lifestyle",
    title: "Reading, receipts, trips — all in one chat",
    description:
      "Beyond engineering work, the agent tracks books you're reading, receipts you photograph, and trip itineraries you forward to it. Same chat surface, different lenses.",
    href: "/reading",
    cta: "Open Reading",
  },
  {
    id: "approvals",
    title: "Notify and Approve safety tiers",
    description:
      "Reads are autonomous; writes are classified Notify (proceed after pinging you) or Approve (require explicit confirmation). Even Allow mode keeps the absolute-block layer.",
    href: "/settings/advanced",
    cta: "Review safety settings",
  },
];

/**
 * Pick a uniformly-random index in [0, length) that is not equal to
 * `except`. The naive "pick uniformly, bump if collision" approach
 * doubles the probability of `(except + 1) mod length` and halves
 * everywhere else — over 12 tips and a user clicking "Next" a few
 * times the bias is visible. Drawing from the (length-1) other
 * positions and adjusting the index keeps the distribution flat.
 *
 * Returns 0 when there is at most one tip; returns a uniformly
 * random index when `except` is out of range (e.g. -1 sentinel).
 */
export function pickRandomIndex(length: number, except: number): number {
  if (length <= 0) return -1;
  if (length === 1) return 0;
  if (except < 0 || except >= length) {
    return Math.floor(Math.random() * length);
  }
  const draw = Math.floor(Math.random() * (length - 1));
  return draw < except ? draw : draw + 1;
}

export function TipsCard({ tips = TIPS }: { tips?: ReadonlyArray<Tip> } = {}) {
  // Start at -1 so the SSR/initial-paint pass renders a stable
  // placeholder. Real selection happens after mount because
  // `Math.random` cannot run during render without producing a
  // hydration mismatch between server and client. The lint
  // suppression below covers that single, deliberate setState.
  const [index, setIndex] = useState<number>(-1);

  useEffect(() => {
    if (tips.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount-time random pick; required for hydration safety.
    setIndex(Math.floor(Math.random() * tips.length));
  }, [tips.length]);

  if (tips.length === 0) return null;

  const tip = index >= 0 ? tips[index] : null;
  return <TipsCardBody tip={tip} onCycle={() => setIndex((i) => pickRandomIndex(tips.length, i))} />;
}

/**
 * Pure-render body. Hooks-free so it can be exercised by
 * `renderToStaticMarkup` smoke tests for layout decisions
 * (placeholder vs filled, badge presence, CTA gating on `href`).
 * Same split pattern as NotificationsPanel / NotificationsPanelBody.
 */
export function TipsCardBody({
  tip,
  onCycle,
}: {
  tip: Tip | null;
  onCycle?: () => void;
}) {
  return (
    <Card className="border-dashed bg-card/60 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Lightbulb className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Did you know?
            </span>
            {tip?.badge && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
                {tip.badge}
              </span>
            )}
          </div>
          {/*
            aria-live so SR users hear the new tip when "Next tip" swaps
            the content. polite + atomic so the entire title+description
            is announced as a single utterance instead of fragmenting.
          */}
          <div aria-live="polite" aria-atomic="true">
            {tip ? (
              <>
                <p className="mt-1 text-sm font-medium text-foreground">{tip.title}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  {tip.description}
                </p>
              </>
            ) : (
              <>
                <p className="mt-1 h-4 w-2/3 animate-pulse rounded bg-muted" aria-hidden="true" />
                <p className="mt-2 h-3 w-full animate-pulse rounded bg-muted" aria-hidden="true" />
                <p className="mt-1.5 h-3 w-5/6 animate-pulse rounded bg-muted" aria-hidden="true" />
              </>
            )}
          </div>
          {tip && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {tip.href && (
                <Button asChild size="sm" variant="outline" className="h-7 px-2.5 text-xs">
                  <Link href={tip.href}>
                    {tip.cta ?? "Learn more"}
                    <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
                  </Link>
                </Button>
              )}
              {onCycle && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={onCycle}
                  aria-label="Show another tip"
                >
                  <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
                  Next tip
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

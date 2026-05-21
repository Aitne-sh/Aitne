/**
 * `!research` family — owner-facing bang commands for the browser
 * history research cluster surface (BROWSER_HISTORY_INTEGRATION_PLAN
 * §5.F1, P3 phasing).
 *
 * Subcommand grammar:
 *   !research                            list active + dormant clusters
 *   !research <slug>                     show cluster detail
 *   !research accept <slug>              dispatch routine.research_dispatch
 *   !research wiki <slug>                dispatch routine.research_wiki_summary
 *   !research decline <slug>             silence offers for 14 days
 *   !research mute <slug>                mark status=muted (offers off)
 *   !research unmute <slug>              restore status=active
 *   !research rename <slug> <new name>   rename display_name
 *   !research conclude <slug>            mark status=concluded
 *
 * All dispatch paths route through the EventBus via
 * `enqueueBrowserResearchEvent` on `BangCommandContext` so the bang
 * handler stays narrow (parse → DB stamp → enqueue). The handler does
 * NOT compose DM prose; the agent or the templated offer DM owns
 * messaging.
 */

import type { Event } from "@aitne/shared";
import type { BangPrefixCommand, BangCommandContext } from "./registry.js";
import { BangArgError } from "./registry.js";
import {
  clearClusterOfferStamps,
  deletePendingOffersForCluster,
  getResearchClusterDetail,
  listBrowserResearchClusters,
  renameResearchCluster,
  setResearchClusterStatus,
  stampClusterDmFields,
} from "../../db/browser-history-store.js";
import { createResearchCommandEvent } from "../browser-history/research-events.js";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/;

type Subcommand =
  | "list"
  | "show"
  | "accept"
  | "wiki"
  | "decline"
  | "mute"
  | "unmute"
  | "rename"
  | "conclude";

// Discriminated union — `list` carries no slug, every other subcommand
// is parsed with a non-null slug. This lets the dispatcher drop the
// `args.slug ?? ""` fallback that previously masked a parser-vs-dispatch
// contract mismatch.
type ResearchArgs =
  | { subcommand: "list"; slug: null; payload: "" }
  | {
      subcommand: Exclude<Subcommand, "list">;
      slug: string;
      payload: string;
    };

export function parseResearchArgs(rest: string): ResearchArgs {
  const trimmed = rest.trim();
  if (trimmed.length === 0) {
    return { subcommand: "list", slug: null, payload: "" };
  }
  const firstSpace = trimmed.indexOf(" ");
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const remainder = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  switch (head) {
    case "accept":
    case "wiki":
    case "decline":
    case "mute":
    case "unmute":
    case "conclude": {
      // `String.prototype.split(/\s+/)` always returns ≥1 element (the
      // empty string for an empty remainder), so `[0]` is never undefined.
      const slug = remainder.split(/\s+/)[0]!;
      if (!slug || !SLUG_PATTERN.test(slug)) {
        throw new BangArgError(
          `Usage: \`!research ${head} <slug>\` — slug must be lowercase letters, digits, and hyphens.`,
        );
      }
      return { subcommand: head, slug, payload: "" };
    }
    case "rename": {
      // `!research rename <slug> <new name…>` — the new name is the
      // remainder after the slug, free-form prose up to 120 chars.
      const tokens = remainder.split(/\s+/);
      const slug = tokens[0]!; // split always yields ≥1 element
      const newName = tokens.slice(1).join(" ").trim();
      if (!slug || !SLUG_PATTERN.test(slug)) {
        throw new BangArgError(
          "Usage: `!research rename <slug> <new name>` — slug must be lowercase letters, digits, and hyphens.",
        );
      }
      if (newName.length === 0) {
        throw new BangArgError("Usage: `!research rename <slug> <new name>` — new name required.");
      }
      if (newName.length > 120) {
        throw new BangArgError("New name must be 120 characters or fewer.");
      }
      return { subcommand: "rename", slug, payload: newName };
    }
    default: {
      // Either `!research <slug>` (show) or an unknown subcommand.
      if (!SLUG_PATTERN.test(head)) {
        throw new BangArgError(
          `Unknown subcommand \`${head}\`. Try \`!research\` (list), \`!research <slug>\` (show), or \`!research help\`.`,
        );
      }
      return { subcommand: "show", slug: head, payload: "" };
    }
  }
}

async function enqueueOrSkip(
  ctx: BangCommandContext,
  event: Event,
): Promise<boolean> {
  if (!ctx.enqueueBrowserResearchEvent) {
    await ctx.notify(
      "Browser-history dispatch is not wired in this daemon process.",
    );
    return false;
  }
  await ctx.enqueueBrowserResearchEvent(event);
  return true;
}

async function handleList(ctx: BangCommandContext): Promise<void> {
  const { clusters } = listBrowserResearchClusters(ctx.db);
  if (clusters.length === 0) {
    await ctx.notify(
      "No active or dormant research clusters yet. Browse the web for a few days on a topic — Aitne will notice and surface a cluster here.",
    );
    return;
  }
  const lines: string[] = [`Research clusters (${clusters.length}):`];
  for (const cluster of clusters.slice(0, 12)) {
    const hours = (
      cluster.meaningfulForegroundSecTotal / 3600
    ).toFixed(1);
    lines.push(
      `- \`${cluster.slug}\` — ${cluster.displayName} `
        + `(${cluster.meaningfulVisitsTotal} visits, ${hours}h, ${cluster.distinctMeaningfulDomains} domains, ${cluster.status})`,
    );
  }
  if (clusters.length > 12) {
    lines.push(`… and ${clusters.length - 12} more. Open the dashboard for the full list.`);
  }
  await ctx.notify(lines.join("\n"));
}

async function handleShow(
  ctx: BangCommandContext,
  slug: string,
): Promise<void> {
  const detail = getResearchClusterDetail(ctx.db, slug);
  if (!detail) {
    await ctx.notify(`No cluster \`${slug}\` found.`);
    return;
  }
  const hours = (detail.meaningfulForegroundSecTotal / 3600).toFixed(1);
  const startedDate = new Date(detail.startedAt).toISOString().slice(0, 10);
  const lastDate = new Date(detail.lastActivityAt).toISOString().slice(0, 10);
  await ctx.notify(
    [
      `\`${detail.slug}\` — ${detail.displayName} (${detail.status})`,
      `- ${detail.meaningfulVisitsTotal} meaningful visits, ${hours}h foreground, ${detail.distinctMeaningfulDomains} domains`,
      `- started ${startedDate}, last activity ${lastDate}`,
      detail.researchOfferAcceptedAt
        ? `- research_assist accepted: ${new Date(detail.researchOfferAcceptedAt).toISOString().slice(0, 10)}`
        : null,
      detail.wikiSummaryWrittenAt
        ? `- wiki summary written: ${new Date(detail.wikiSummaryWrittenAt).toISOString().slice(0, 10)}`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
}

async function handleAccept(
  ctx: BangCommandContext,
  slug: string,
): Promise<void> {
  const detail = getResearchClusterDetail(ctx.db, slug);
  if (!detail) {
    await ctx.notify(`No cluster \`${slug}\` found.`);
    return;
  }
  // Enqueue BEFORE stamping. If the bus isn't wired (test fixture or
  // pre-EventBus-boot path) `enqueueOrSkip` already notified — bailing
  // here leaves the cluster row untouched so the next poller cycle can
  // re-emit the same offer cleanly. Stamping before the enqueue used to
  // leak state on this path (acceptedAt set, no agent session ever
  // runs).
  const event = createResearchCommandEvent({
    processKey: "routine.research_dispatch",
    slug,
    sourceEvent: ctx.event,
  });
  const enqueued = await enqueueOrSkip(ctx, event);
  if (!enqueued) return;
  const now = Date.now();
  stampClusterDmFields(ctx.db, slug, { researchOfferAcceptedAt: now });
  // BROWSER_HISTORY_INTEGRATION_PLAN seventh-pass — clear ALL pending
  // rows for the slug. The seventh-pass poller inserts kind='offered'
  // (two-option flow); deleting only the 'research_assist' row would
  // leave the 'offered' row orphaned and silence the cluster for the
  // 14-day TTL. P3b-era rows (kind='research_assist' / 'wiki_summary')
  // are also cleared, matching the "acceptance closes the cycle"
  // semantic.
  deletePendingOffersForCluster(ctx.db, slug);
  await ctx.notify(
    `Accepted research dispatch for \`${slug}\`. I'll run a parallel research dive and DM a summary when it lands.`,
  );
}

async function handleWiki(
  ctx: BangCommandContext,
  slug: string,
): Promise<void> {
  const detail = getResearchClusterDetail(ctx.db, slug);
  if (!detail) {
    await ctx.notify(`No cluster \`${slug}\` found.`);
    return;
  }
  // Stamp ordering: enqueue first (same rationale as handleAccept).
  //
  // We deliberately do NOT stamp `wikiSummaryWrittenAt` here. That column
  // is the agent's "wiki note already exists" gate
  // (`routine.research_wiki_summary.md` step 3 — "If wikiSummaryWrittenAt
  // is present AND delta shows no new buckets since that timestamp,
  // reply skipped"). Pre-stamping it on acceptance made the agent skip
  // the very write the user just asked for; the actual "wiki note exists"
  // signal is stamped by the agent itself via /wiki-written after a
  // successful write.
  const event = createResearchCommandEvent({
    processKey: "routine.research_wiki_summary",
    slug,
    sourceEvent: ctx.event,
  });
  const enqueued = await enqueueOrSkip(ctx, event);
  if (!enqueued) return;
  // BROWSER_HISTORY_INTEGRATION_PLAN seventh-pass — clear ALL pending
  // rows for the slug (see handleAccept for the rationale; same reasoning
  // applies to the wiki path).
  deletePendingOffersForCluster(ctx.db, slug);
  // Clear `lastWikiOfferAt` so the rate-limit gate's decline_backoff
  // (which trips when BOTH options' lastXxxOfferAt are set AND neither
  // is accepted within 30d) does not falsely silence the cluster if
  // the wiki write fails or the agent skips the /wiki-written stamp.
  // Mirrors the API accept handler's wiki_summary branch — both entry
  // points must apply the same fix so natural-language and bang
  // acceptance behave identically. See `clearClusterOfferStamps` JSDoc.
  clearClusterOfferStamps(ctx.db, slug, { lastWikiOfferAt: true });
  await ctx.notify(
    `Queued wiki summary for \`${slug}\`. I'll write it to Obsidian (or Notion / local context, whichever you have) and DM the destination.`,
  );
}

async function handleDecline(
  ctx: BangCommandContext,
  slug: string,
): Promise<void> {
  const detail = getResearchClusterDetail(ctx.db, slug);
  if (!detail) {
    await ctx.notify(`No cluster \`${slug}\` found.`);
    return;
  }
  const now = Date.now();
  stampClusterDmFields(ctx.db, slug, {
    lastResearchOfferAt: now,
    lastWikiOfferAt: now,
  });
  deletePendingOffersForCluster(ctx.db, slug);
  await ctx.notify(
    `Got it — silencing offers for \`${slug}\` for 14 days. Cluster journal updates continue silently; the cluster will re-qualify after another 14 days of activity.`,
  );
}

async function handleMute(
  ctx: BangCommandContext,
  slug: string,
): Promise<void> {
  const updated = setResearchClusterStatus(ctx.db, slug, "muted");
  if (!updated) {
    await ctx.notify(`No cluster \`${slug}\` found.`);
    return;
  }
  deletePendingOffersForCluster(ctx.db, slug);
  await ctx.notify(
    `Muted \`${slug}\`. No more DM offers; \`!research unmute ${slug}\` to restore.`,
  );
}

async function handleUnmute(
  ctx: BangCommandContext,
  slug: string,
): Promise<void> {
  const updated = setResearchClusterStatus(ctx.db, slug, "active");
  if (!updated) {
    await ctx.notify(`No cluster \`${slug}\` found.`);
    return;
  }
  await ctx.notify(`Unmuted \`${slug}\`. Normal offer cadence restored.`);
}

async function handleConclude(
  ctx: BangCommandContext,
  slug: string,
): Promise<void> {
  const updated = setResearchClusterStatus(ctx.db, slug, "concluded");
  if (!updated) {
    await ctx.notify(`No cluster \`${slug}\` found.`);
    return;
  }
  deletePendingOffersForCluster(ctx.db, slug);
  await ctx.notify(
    `Concluded \`${slug}\`. The cluster journal at \`context/research/${slug}.md\` is preserved.`,
  );
}

async function handleRename(
  ctx: BangCommandContext,
  slug: string,
  newName: string,
): Promise<void> {
  const updated = renameResearchCluster(ctx.db, slug, newName);
  if (!updated) {
    await ctx.notify(`No cluster \`${slug}\` found.`);
    return;
  }
  await ctx.notify(`Renamed \`${slug}\` → ${newName}.`);
}

export const researchCommand: BangPrefixCommand = {
  prefix: "!research",
  title: "Research clusters",
  describe:
    "manage browser-history research clusters (list / show / accept / wiki / decline / mute / unmute / rename / conclude)",
  details: [
    "Subcommands:",
    "- `!research` — list active clusters",
    "- `!research <slug>` — show cluster detail",
    "- `!research accept <slug>` — agree to a research_assist offer",
    "- `!research wiki <slug>` — agree to a wiki summary offer",
    "- `!research decline <slug>` — silence offers for 14 days",
    "- `!research mute <slug>` — silence all offers (until unmute)",
    "- `!research unmute <slug>` — restore offers",
    "- `!research rename <slug> <new name>` — change display name",
    "- `!research conclude <slug>` — mark cluster concluded",
  ],
  parseArgs(rest) {
    return parseResearchArgs(rest);
  },
  async handler(ctx, rawArgs) {
    const args = rawArgs as ResearchArgs;
    switch (args.subcommand) {
      case "list":
        return handleList(ctx);
      case "show":
        return handleShow(ctx, args.slug);
      case "accept":
        return handleAccept(ctx, args.slug);
      case "wiki":
        return handleWiki(ctx, args.slug);
      case "decline":
        return handleDecline(ctx, args.slug);
      case "mute":
        return handleMute(ctx, args.slug);
      case "unmute":
        return handleUnmute(ctx, args.slug);
      case "rename":
        return handleRename(ctx, args.slug, args.payload);
      case "conclude":
        return handleConclude(ctx, args.slug);
    }
  },
};

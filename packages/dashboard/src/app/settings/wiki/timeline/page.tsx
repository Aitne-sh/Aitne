import { redirect } from "next/navigation";

/**
 * Canonical home of the wiki timeline is now `/wiki/timeline` (My Life
 * IA split, WIKI_BUILDER_DESIGN.md §6). This route exists to keep
 * old in-app links and external bookmarks working after the move.
 *
 * Permanent redirect on the server so the browser updates its history
 * entry — no client-side flicker.
 */
export default function LegacyWikiTimelineRedirect(): never {
  redirect("/wiki/timeline");
}

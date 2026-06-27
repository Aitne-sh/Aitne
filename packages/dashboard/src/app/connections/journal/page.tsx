import { redirect } from "next/navigation";

/**
 * Compatibility alias — journal rules are edited on the morning-routine
 * agent's Rulebook tab (AGENTS_HUB_REDESIGN_PLAN §4.2; the former
 * /settings/routines Journal tab was retired with that page).
 */
export default function ConnectionsJournalPage() {
  redirect("/agents/morning-routine?tab=rulebook");
}

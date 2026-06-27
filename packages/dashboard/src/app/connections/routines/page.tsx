import { redirect } from "next/navigation";

/**
 * Compatibility alias — routines are Agents now; rulebooks are edited on
 * each agent's Rulebook tab (AGENTS_HUB_REDESIGN_PLAN §4).
 */
export default function ConnectionsRoutinesPage() {
  redirect("/agents");
}

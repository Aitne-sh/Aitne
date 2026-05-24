import { redirect } from "next/navigation";

/**
 * Compatibility alias — the canonical editor lives at /settings/journal.
 */
export default function ConnectionsJournalPage() {
  redirect("/settings/journal");
}

import { redirect } from "next/navigation";

/**
 * Compatibility alias for B-007's original `/connections/journal` route
 * (design doc §9 / §12 Phase 4). The editor lives under the settings shell
 * at `/settings/journal`; the design-doc path remains valid and discoverable.
 */
export default function ConnectionsJournalPage() {
  redirect("/settings/journal");
}

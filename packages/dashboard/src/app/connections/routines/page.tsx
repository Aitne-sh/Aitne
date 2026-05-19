import { redirect } from "next/navigation";

/**
 * Compatibility alias for B-007's original `/connections/routines` route.
 * The editor now lives under the settings shell at `/settings/routines`,
 * but the design-doc path remains valid and discoverable.
 */
export default function ConnectionsRoutinesPage() {
  redirect("/settings/routines");
}

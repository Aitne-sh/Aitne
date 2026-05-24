import { redirect } from "next/navigation";

/**
 * Compatibility alias — the canonical editor lives at /settings/routines.
 */
export default function ConnectionsRoutinesPage() {
  redirect("/settings/routines");
}

import { redirect } from "next/navigation";

/**
 * Connections moved from Settings sub-page to top-level /connections.
 * This one-release redirect catches bookmarks; remove in the next release.
 */
export default function LegacyConnectionsPage() {
  redirect("/connections");
}

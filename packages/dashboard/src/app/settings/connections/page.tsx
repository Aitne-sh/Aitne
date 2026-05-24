import { redirect } from "next/navigation";

/**
 * Compatibility redirect — the canonical path is /connections.
 */
export default function LegacyConnectionsPage() {
  redirect("/connections");
}

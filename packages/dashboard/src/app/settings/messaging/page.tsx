import { redirect } from "next/navigation";

/**
 * Legacy route — middleware redirects to /settings/connections at runtime.
 * This file exists only so Next.js doesn't 404 if the middleware redirect
 * is somehow bypassed. The original MessagingPanel was retired during the
 * setup-wizard refactor.
 */
export default function MessagingSettingsPage() {
  redirect("/settings/connections");
}

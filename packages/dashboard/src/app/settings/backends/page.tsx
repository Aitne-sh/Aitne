import { redirect } from "next/navigation";

/**
 * Legacy route — middleware redirects to /settings/models at runtime.
 * This file exists only so Next.js doesn't 404 if the middleware redirect
 * is somehow bypassed. Superseded by the unified Models page.
 */
export default function BackendSettingsPage() {
  redirect("/settings/models");
}

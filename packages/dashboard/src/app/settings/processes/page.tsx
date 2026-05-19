import { redirect } from "next/navigation";

/**
 * Legacy route — middleware redirects to /settings/models at runtime.
 * This file exists only so Next.js doesn't 404 if the middleware redirect
 * is somehow bypassed. The original ProcessSettingsPage was superseded by
 * the unified Models page in Phase 1 (Settings Restructure).
 */
export default function ProcessSettingsPage() {
  redirect("/settings/models");
}

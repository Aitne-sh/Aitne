/**
 * Pure helpers for ManagementHistoryCard. Kept separate so render-free
 * assertions (kind labels, badge mapping, summary text) stay unit-
 * testable without mounting React or the Tanstack query client.
 *
 * Used by the card itself and by `management-history-card.logic.test.ts`.
 */

import type { Badge } from "@/components/ui/badge";

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

export const KIND_LABEL: Record<string, string> = {
  "management_task.created": "Created",
  "management_task.modified": "Modified",
  "management_task.deleted": "Stopped",
  "management_task.run_recorded": "Ran",
  "management_task.run_now": "Ran (on demand)",
  "management_task.app_renamed": "Renamed app",
  "sot_binding.updated": "SoT bindings updated",
};

export const KIND_BADGE: Record<string, BadgeVariant> = {
  "management_task.created": "green",
  "management_task.modified": "blue",
  "management_task.deleted": "red",
  "management_task.run_recorded": "gray",
  "management_task.run_now": "purple",
  "management_task.app_renamed": "amber",
  "sot_binding.updated": "blue",
};

/**
 * Compose the per-row summary line for a `management_task.*` /
 * `sot_binding.*` audit row. Returns `null` when the audit detail
 * doesn't carry enough to say anything useful — the card falls back to
 * just the badge + mt_id.
 */
export function renderSummary(
  kind: string,
  detail: Record<string, unknown> | null,
): string | null {
  if (!detail) return null;
  switch (kind) {
    case "management_task.created": {
      const app = typeof detail.app === "string" ? detail.app : null;
      const cadence =
        typeof detail.cadence === "string" ? (detail.cadence as string) : null;
      const outputPath =
        typeof detail.output_path === "string"
          ? (detail.output_path as string)
          : null;
      const parts: string[] = [];
      if (app) parts.push(app);
      if (cadence) parts.push(cadence);
      if (outputPath) parts.push(`→ ${outputPath}`);
      return parts.length ? parts.join(" · ") : null;
    }
    case "management_task.modified": {
      const changed = Array.isArray(detail.changed)
        ? (detail.changed as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      return changed.length ? `changed: ${changed.join(", ")}` : null;
    }
    case "management_task.deleted": {
      const original =
        detail.original_row && typeof detail.original_row === "object"
          ? (detail.original_row as Record<string, unknown>)
          : null;
      if (!original) return null;
      const intent = typeof original.intent === "string" ? original.intent : "";
      const app = typeof original.app === "string" ? original.app : "";
      return `${intent} (${app})`.trim();
    }
    case "management_task.run_now": {
      const reason =
        typeof detail.reason === "string" ? (detail.reason as string) : null;
      return reason ? `reason: ${reason}` : null;
    }
    case "management_task.run_recorded": {
      const last =
        typeof detail.last_result === "string"
          ? (detail.last_result as string)
          : null;
      return last;
    }
    case "management_task.app_renamed": {
      const from = typeof detail.from === "string" ? detail.from : "";
      const to = typeof detail.to === "string" ? detail.to : "";
      return `${from} → ${to}`;
    }
    case "sot_binding.updated": {
      const next = Array.isArray(detail.next)
        ? (detail.next as unknown[]).length
        : null;
      const prev = Array.isArray(detail.previous)
        ? (detail.previous as unknown[]).length
        : null;
      if (prev === null || next === null) return null;
      return `${prev} → ${next} bindings`;
    }
    default:
      return null;
  }
}

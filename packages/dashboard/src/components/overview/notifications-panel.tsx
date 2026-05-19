"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Alert as AlertBox } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { dismissAlert, useAlerts } from "@/lib/hooks/use-alerts";
import type { Alert, AlertSeverity } from "@/lib/api-types";

const VARIANT_BY_SEVERITY: Record<
  AlertSeverity,
  "error" | "warning" | "info"
> = {
  error: "error",
  warning: "warning",
  info: "info",
};

const ERROR_VISIBLE_LIMIT = 5;

/**
 * Pick the action-link label from the alert's `href`. The alert detector
 * decides where the issue is actually fixed; this helper just renders
 * the matching verb so `/connections/mail` doesn't read "Open settings".
 *
 * Match on path boundary (exact, `/`, `?`, `#`) so a hypothetical
 * `/settings-foo` route doesn't collide with `/settings`. Unknown
 * prefixes fall back to a generic "View details" rather than guessing.
 */
function isUnderRoute(href: string, route: string): boolean {
  if (href === route) return true;
  if (!href.startsWith(route)) return false;
  const next = href.charAt(route.length);
  return next === "/" || next === "?" || next === "#";
}

function getActionLabel(href: string): string {
  if (isUnderRoute(href, "/connections")) return "Open connection settings";
  if (isUnderRoute(href, "/settings")) return "Open settings";
  if (isUnderRoute(href, "/setup")) return "Open setup wizard";
  return "View details";
}

interface AlertRowProps {
  alert: Alert;
  onDismiss?: (alert: Alert) => void;
}

function AlertRow({ alert, onDismiss }: AlertRowProps) {
  return (
    <AlertBox variant={VARIANT_BY_SEVERITY[alert.severity]}>
      <div className="flex w-full items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-medium leading-snug">{alert.title}</p>
          {alert.description && (
            <p className="mt-0.5 text-[11px] leading-snug opacity-80">
              {alert.description}
            </p>
          )}
          {alert.href && (
            <p className="mt-1">
              <Link
                href={alert.href}
                className="text-[11px] font-medium underline underline-offset-2 hover:no-underline"
              >
                {getActionLabel(alert.href)}
              </Link>
            </p>
          )}
        </div>
        {alert.dismissable && onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDismiss(alert)}
            aria-label={
              alert.severity === "warning"
                ? "Snooze for 24 hours"
                : "Dismiss notification"
            }
            title={
              alert.severity === "warning"
                ? "Snooze for 24 hours"
                : "Dismiss"
            }
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </AlertBox>
  );
}

/**
 * Notifications Center on the Overview page.
 *
 * Aggregates `/api/health.alerts` (daemon-detected) with client-only
 * system alerts (daemon offline / frozen). Renders nothing when there
 * are no visible alerts. See docs/design/20-notifications-center.md.
 */
export function NotificationsPanel() {
  const { alerts } = useAlerts();
  return <NotificationsPanelBody alerts={alerts} onDismiss={dismissAlert} />;
}

/**
 * Pure-render body — no hooks, no React-query dependency. Exported for
 * render smoke tests so the layout decisions (errors before warnings,
 * "Show N more" gate) can be exercised without spinning up a
 * QueryClientProvider or fake daemon.
 */
export function NotificationsPanelBody({
  alerts,
  onDismiss,
}: {
  alerts: readonly Alert[];
  onDismiss?: (alert: Alert) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (alerts.length === 0) return null;

  // Show all errors unconditionally; collapse warnings + info into a
  // "Show N more" toggle past the visible limit so a noisy info-tier
  // build (e.g. fresh setup) doesn't push the rest of the page down.
  const errors = alerts.filter((a) => a.severity === "error");
  const nonErrors = alerts.filter((a) => a.severity !== "error");
  const visibleNonErrors = expanded
    ? nonErrors
    : nonErrors.slice(0, Math.max(0, ERROR_VISIBLE_LIMIT - errors.length));
  const hiddenCount = nonErrors.length - visibleNonErrors.length;

  return (
    <section
      aria-label="Notifications"
      className="space-y-2"
    >
      {errors.map((a) => (
        <AlertRow key={a.id} alert={a} />
      ))}
      {visibleNonErrors.map((a) => (
        <AlertRow key={a.id} alert={a} onDismiss={onDismiss} />
      ))}
      {hiddenCount > 0 && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-muted-foreground"
          >
            {expanded ? (
              <>
                <ChevronUp className="mr-1 h-3.5 w-3.5" />
                Show fewer
              </>
            ) : (
              <>
                <ChevronDown className="mr-1 h-3.5 w-3.5" />
                Show {hiddenCount} more
              </>
            )}
          </Button>
        </div>
      )}
    </section>
  );
}

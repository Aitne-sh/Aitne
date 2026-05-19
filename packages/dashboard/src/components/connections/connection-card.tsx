"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  IntegrationStatus as HealthIntegrationStatus,
  MessagingHealthStatus,
} from "@/lib/api-types";

// ── Status types ──

export type ConnectionStatus =
  | "connected"
  | "configured"
  | "connecting"
  | "needs-setup"
  | "error"
  | "disabled";

const STATUS_BADGE: Record<ConnectionStatus, { variant: "green" | "red" | "gray" | "amber"; label: string }> = {
  connected: { variant: "green", label: "Connected" },
  configured: { variant: "amber", label: "Configured" },
  connecting: { variant: "amber", label: "Connecting…" },
  "needs-setup": { variant: "gray", label: "Not Configured" },
  error: { variant: "red", label: "Error" },
  disabled: { variant: "gray", label: "Disabled" },
};

function cardTone(status: ConnectionStatus) {
  if (status === "connected") return "success" as const;
  if (status === "error") return "error" as const;
  return "default" as const;
}

// ── Status derivation helpers ──

/** Derive card status from the health API's integration status object. */
export function deriveIntegrationStatus(
  s: HealthIntegrationStatus | undefined,
): ConnectionStatus {
  if (!s) return "needs-setup";
  if (!s.configured) return "needs-setup";
  if (s.error) return "error";
  if (s.connected) return "connected";
  return "configured";
}

/** Derive card status from the health API's messaging status object. */
export function deriveMessagingStatus(
  s: MessagingHealthStatus | undefined,
): ConnectionStatus {
  if (!s) return "needs-setup";
  if (s.runtimeState === "not_configured") return "needs-setup";
  if (s.runtimeState === "connecting") return "connecting";
  if (s.runtimeState === "error") return "error";
  if (s.runtimeState === "ok") return "connected";
  return "configured";
}

/** Derive card status from a simple boolean config flag (e.g. GitHub). */
export function deriveConfiguredStatus(configured: boolean): ConnectionStatus {
  return configured ? "configured" : "needs-setup";
}

/** Build the standard metadata lines for a messaging channel card. */
export function messagingMetadata(status: MessagingHealthStatus | undefined) {
  if (!status) return undefined;
  return [
    { label: "Owner configured", value: status.ownerConfigured ? "yes" : "no" },
    { label: "Owner channel known", value: status.ownerChannelKnown ? "yes" : "no" },
    { label: "Reminder eligible", value: status.notificationEligible ? "yes" : "no" },
    { label: "Last inbound", value: status.lastInboundAt ?? "—" },
  ];
}

// ── ConnectionCard component ──

export interface ConnectionCardProps {
  name: string;
  icon: ReactNode;
  status: ConnectionStatus;
  /** Error message from health API. */
  error?: string | null;
  /** Key-value metadata lines shown below the header. */
  metadata?: Array<{ label: string; value: string }>;
  /** Expandable config/setup content. */
  children?: ReactNode;
  className?: string;
}

export function ConnectionCard({
  name,
  icon,
  status,
  error,
  metadata,
  children,
  className,
}: ConnectionCardProps) {
  const badge = STATUS_BADGE[status];

  return (
    <Card tone={cardTone(status)} className={cn("relative", className)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <h3 className="text-sm font-medium text-foreground">{name}</h3>
        </div>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      {/* Error from health API — suppressed during in-progress connecting state so
          transient auth/pairing messages don't render as red errors. */}
      {error && status !== "connecting" && (
        <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {/* Metadata */}
      {metadata && metadata.length > 0 && (
        <div className="mb-3 space-y-0.5">
          {metadata.map((m) => (
            <div key={m.label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{m.label}</span>
              <span className="text-foreground">{m.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Children */}
      {children}
    </Card>
  );
}

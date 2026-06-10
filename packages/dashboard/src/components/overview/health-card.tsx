"use client";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUptime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useSSE } from "@/providers/sse-provider";
import type { HealthResponse, IntegrationStatus } from "@/lib/api-types";

interface HealthCardProps {
  health: HealthResponse | undefined;
}

function StatusDot({ ok, pulse }: { ok: boolean; pulse?: boolean }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        ok ? "bg-success" : "bg-destructive",
        ok && pulse && "animate-pulse",
      )}
    />
  );
}

function IntegrationDot({ status }: { status: IntegrationStatus | undefined }) {
  if (!status || !status.configured) {
    return (
      <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/30" />
    );
  }
  return <StatusDot ok={status.connected} />;
}

function integrationLabel(status: IntegrationStatus | undefined): string {
  if (!status || !status.configured) return "Not Configured";
  return status.connected ? "Connected" : "Error";
}

function integrationColor(status: IntegrationStatus | undefined): string {
  if (!status || !status.configured) return "text-muted-foreground/70";
  return status.connected ? "text-success" : "text-destructive";
}

const INTEGRATION_LABELS: Record<string, string> = {
  google: "Google (Calendar / Gmail)",
  obsidian: "Obsidian",
  notion: "Notion",
};

export function HealthCard({ health }: HealthCardProps) {
  const { connected: liveUpdatesConnected } = useSSE();

  const coreItems = [
    { label: "Database", ok: health?.dbConnected ?? false },
    { label: "Context Files", ok: health?.contextFilesOk ?? false },
    { label: "Live Updates", ok: liveUpdatesConnected, pulse: true },
  ];

  const integrationKeys = ["google", "obsidian", "notion"] as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle>System Health</CardTitle>
      </CardHeader>
      <div className="space-y-3">
        {coreItems.map((item) => (
          <div key={item.label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{item.label}</span>
            <div className="flex items-center gap-2">
              <StatusDot ok={item.ok} pulse={item.pulse} />
              <span className={item.ok ? "text-success" : "text-destructive"}>
                {item.ok ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>
        ))}

        <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Integrations
          </p>
          {integrationKeys.map((key) => {
            const status = health?.integrations?.[key];
            return (
              <div key={key} className="flex items-center justify-between text-sm py-0.5">
                <span className="text-muted-foreground">{INTEGRATION_LABELS[key]}</span>
                <div className="flex items-center gap-2">
                  <IntegrationDot status={status} />
                  <span className={integrationColor(status)}>
                    {integrationLabel(status)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Runtime
          </p>
          <div className="grid grid-cols-3 gap-2">
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">{health?.activeSessions ?? 0}</p>
              <p className="text-[10px] text-muted-foreground">Active</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">{health?.todaySessions ?? 0}</p>
              <p className="text-[10px] text-muted-foreground">Today</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">{health?.eventBusSize ?? 0}</p>
              <p className="text-[10px] text-muted-foreground">Event Bus</p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Uptime</span>
          <span className="font-mono text-xs">{health ? formatUptime(health.uptime) : "—"}</span>
        </div>
      </div>
    </Card>
  );
}

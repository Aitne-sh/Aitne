"use client";

import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";

import { SlackCard } from "@/components/connections/slack-card";
import { TelegramCard } from "@/components/connections/telegram-card";
import { DiscordCard } from "@/components/connections/discord-card";
import { WhatsAppCard } from "@/components/connections/whatsapp-card";
import { DashboardCard } from "@/components/connections/dashboard-card";
import { DestinationSelector } from "@/components/connections/destination-selector";
import { ConnectionsSectionHeader } from "@/components/connections/section-header";

const CHANNEL_KEYS = ["slack", "telegram", "discord", "whatsapp", "dashboard"] as const;

const CHANNEL_LABEL: Record<(typeof CHANNEL_KEYS)[number], string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
  dashboard: "Dashboard",
};

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded bg-muted" />
              <div className="h-4 w-20 rounded bg-muted" />
            </div>
            <div className="h-5 w-24 rounded-full bg-muted" />
          </div>
          <div className="space-y-2">
            <div className="h-3 w-full max-w-xs rounded bg-muted" />
            <div className="h-3 w-full max-w-[200px] rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MessagingConnectionsPage() {
  const { data: config, isLoading: configLoading } = useConfig();
  const { data: health, isLoading: healthLoading } = useHealth();

  const loading = configLoading || healthLoading;
  const disconnected = !loading && (!config || !health);

  const messaging = health?.messaging ?? {};
  const healthy = CHANNEL_KEYS.filter(
    (k) => messaging[k]?.runtimeState === "ok",
  ).length;
  const needsAttention = CHANNEL_KEYS.filter(
    (k) => messaging[k]?.runtimeState === "error",
  ).map((k) => CHANNEL_LABEL[k]);
  const attention =
    needsAttention.length > 0
      ? `${needsAttention.join(", ")} ${needsAttention.length === 1 ? "needs" : "need"} attention`
      : null;

  return (
    <>
      <ConnectionsSectionHeader
        title="Messaging"
        description="Apps you use to talk with the agent. DMs and @-mentions only — group chats are out of scope."
        healthy={healthy}
        total={CHANNEL_KEYS.length}
        attention={attention}
      />

      {disconnected && (
        <p className="text-sm text-muted-foreground">
          Daemon not connected. Start the daemon to configure channels.
        </p>
      )}

      {loading ? <LoadingSkeleton /> : (
        <div className="space-y-4">
          <SlackCard />
          <TelegramCard />
          <DiscordCard />
          <WhatsAppCard />
          <DashboardCard />
        </div>
      )}

      {!loading && <DestinationSelector />}
    </>
  );
}

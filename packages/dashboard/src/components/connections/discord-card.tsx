"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { usePairingPoll } from "@/lib/hooks/use-pairing-poll";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { StepCard } from "@/components/shared/step-card";
import { Gamepad2 } from "lucide-react";
import type {
  DiscordBotInfoResponse,
  DiscordPairingStatusResponse,
  PhrasePairingStartResponse,
  MessagingHealthStatus,
} from "@/lib/api-types";
import {
  ConnectionCard,
  deriveMessagingStatus,
  messagingMetadata,
} from "./connection-card";

export function DiscordCard() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const queryClient = useQueryClient();
  const status: MessagingHealthStatus | undefined = health?.messaging?.discord;

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [botInfo, setBotInfo] = useState<DiscordBotInfoResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<PhrasePairingStartResponse | null>(null);

  const pairing = usePairingPoll<DiscordPairingStatusResponse>(
    "/messaging/discord/pairing-status",
    (d) => d.paired || !d.pairingActive,
  );

  if (pairing.status?.paired && phrase) setPhrase(null);
  if (pairing.status && !pairing.status.pairingActive && phrase) setPhrase(null);

  if (!config || !health) return null;

  const handleSave = async () => {
    setSaving(true); setError(null); setNotice(null);
    try {
      await api.put("/secrets/discord", { ...(draft ? { botToken: draft } : {}) });
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
      setNotice("Updated."); setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally { setSaving(false); }
  };

  const handleTest = async () => {
    setBusy("test"); setError(null);
    try {
      const candidate = draft || undefined;
      const info = await api.post<DiscordBotInfoResponse>(
        "/messaging/discord/test-token",
        candidate ? { token: candidate } : undefined,
      );
      setBotInfo(info);
      setNotice(`Token OK — bot: ${info.username}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Token test failed");
    } finally { setBusy(null); }
  };

  const handleStartPairing = async () => {
    setBusy("pair"); setError(null);
    try {
      const res = await api.post<PhrasePairingStartResponse>("/messaging/discord/start-pairing");
      setPhrase(res);
      pairing.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start pairing");
    } finally { setBusy(null); }
  };

  const handleCancelPairing = async () => {
    pairing.reset(); setPhrase(null);
    try { await api.post("/messaging/discord/cancel-pairing"); } catch { /* best-effort */ }
  };

  return (
    <ConnectionCard
      name="Discord"
      icon={<Gamepad2 className="h-4 w-4" />}
      status={deriveMessagingStatus(status)}
      error={status?.error}
      metadata={messagingMetadata(status)}
    >
      <div className="space-y-4 mt-2">
        {error && <Alert variant="error">{error}</Alert>}
        {notice && <Alert variant="success">{notice}</Alert>}

        {/* Step 1 */}
        <StepCard heading="Step 1 — Create the bot" spacing="sm">
          <p className="text-xs text-muted-foreground">
            Open the <a className="underline" href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a>,
            create an application, add a Bot, enable &quot;Message Content Intent&quot;, and copy the token.
          </p>
        </StepCard>

        {/* Step 2 — Token */}
        <StepCard heading="Step 2 — Paste token" spacing="md">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Bot token</label>
            <Input type="password" value={draft}
              placeholder={config.discordConfigured ? "Configured. Enter a new token to replace it." : "Discord bot token"}
              onChange={(e) => setDraft(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={saving} onClick={handleSave}>
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button size="sm" variant="outline" disabled={busy === "test"} onClick={handleTest}>
              {busy === "test" ? "Testing..." : "Test token"}
            </Button>
          </div>
          {botInfo && (
            <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
              ✓ Bot: <code className="font-mono">{botInfo.username}</code>
              {botInfo.avatarUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={botInfo.avatarUrl} alt="" width={16} height={16} className="rounded-full" />
              )}
            </p>
          )}
        </StepCard>

        {/* Step 3 — Pair */}
        <StepCard heading="Step 3 — Pair with magic phrase" spacing="sm">
          <p className="text-xs text-muted-foreground">
            Add the bot to a server, then click below to generate a one-time phrase.
            DM the bot with that phrase — only that DM captures your user ID.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline"
              disabled={!config.discordConfigured || busy === "pair"}
              title={config.discordConfigured ? undefined : "Save your token first"}
              onClick={handleStartPairing}>
              {busy === "pair" ? "Generating..." : "Generate pairing phrase"}
            </Button>
            {pairing.active && (
              <Button size="sm" variant="ghost" onClick={handleCancelPairing}>Cancel</Button>
            )}
          </div>
          {phrase && (
            <div className="rounded-md bg-muted p-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">Send this phrase to your bot in Discord:</p>
              <code className="font-mono text-base font-semibold tracking-wide">{phrase.phrase}</code>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Expires {new Date(phrase.expiresAt).toLocaleTimeString()} · punctuation and case are ignored.
              </p>
            </div>
          )}
          {pairing.status && (
            <p className="text-xs text-muted-foreground">
              {pairing.status.paired
                ? <>✓ Owner paired: <code className="font-mono">{pairing.status.ownerUserId}</code></>
                : pairing.active ? "Waiting for the phrase..." : null}
            </p>
          )}
        </StepCard>
      </div>
    </ConnectionCard>
  );
}

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
import { MessageCircle } from "lucide-react";
import type {
  TelegramBotInfoResponse,
  TelegramPairingStartResponse,
  TelegramPairingStatusResponse,
  MessagingHealthStatus,
} from "@/lib/api-types";
import {
  ConnectionCard,
  deriveMessagingStatus,
  messagingMetadata,
} from "./connection-card";

export function TelegramCard() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const queryClient = useQueryClient();
  const status: MessagingHealthStatus | undefined = health?.messaging?.telegram;

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [botInfo, setBotInfo] = useState<TelegramBotInfoResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pairData, setPairData] = useState<TelegramPairingStartResponse | null>(null);

  const pairing = usePairingPoll<TelegramPairingStatusResponse>(
    "/messaging/telegram/pairing-status",
    (d) => d.paired,
  );

  if (!config || !health) return null;

  const handleSave = async () => {
    setSaving(true); setError(null); setNotice(null);
    try {
      await api.put("/secrets/telegram", { ...(draft ? { botToken: draft } : {}) });
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
      const info = await api.post<TelegramBotInfoResponse>(
        "/messaging/telegram/test-token",
        candidate ? { token: candidate } : undefined,
      );
      setBotInfo(info);
      setNotice(`Token OK — bot: ${info.firstName ?? info.username ?? info.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Token test failed");
    } finally { setBusy(null); }
  };

  const handleStartPairing = async () => {
    setBusy("pair"); setError(null);
    try {
      const res = await api.post<TelegramPairingStartResponse>("/messaging/telegram/start-pairing");
      setPairData(res);
      pairing.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start pairing");
    } finally { setBusy(null); }
  };

  const handleCancelPairing = async () => {
    pairing.reset(); setPairData(null);
    try { await api.post("/messaging/telegram/cancel-pairing"); } catch { /* best-effort */ }
  };

  return (
    <ConnectionCard
      name="Telegram"
      icon={<MessageCircle className="h-4 w-4" />}
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
            Open <a className="underline" href="https://t.me/botfather" target="_blank" rel="noopener noreferrer">@BotFather</a>,
            send <code className="font-mono">/newbot</code>, give it a name and username,
            then copy the token.
          </p>
        </StepCard>

        {/* Step 2 — Token */}
        <StepCard heading="Step 2 — Paste token" spacing="md">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Bot token</label>
            <Input type="password" value={draft}
              placeholder={config.telegramConfigured ? "Configured. Enter a new token to replace it." : "123456:ABC-DEF…"}
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
            <p className="text-xs text-success">
              ✓ Bot: <code className="font-mono">@{botInfo.username ?? botInfo.id}</code>
            </p>
          )}
        </StepCard>

        {/* Step 3 — QR */}
        <StepCard heading="Step 3 — Pair with QR" spacing="sm">
          <p className="text-xs text-muted-foreground">
            Generate a QR code that opens your bot in Telegram and sends a one-shot pairing token.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline"
              disabled={!config.telegramConfigured || busy === "pair"}
              title={config.telegramConfigured ? undefined : "Save your token first"}
              onClick={handleStartPairing}>
              {busy === "pair" ? "Generating..." : "Pair with QR"}
            </Button>
            {pairData && (
              <Button size="sm" variant="ghost" onClick={handleCancelPairing}>Cancel</Button>
            )}
          </div>
          {pairData && (
            <div className="flex flex-col items-center gap-2 rounded-lg bg-muted p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pairData.qrDataUrl} alt="Telegram pairing QR" width={320} height={320} className="rounded bg-white p-2" />
              <p className="text-xs text-muted-foreground text-center">
                Scan with your phone — Telegram will open <code className="font-mono">@{pairData.botUsername}</code> and send the pairing token automatically.
              </p>
              <a className="text-xs underline" href={pairData.deepLink} target="_blank" rel="noopener noreferrer">
                Or open the link directly
              </a>
            </div>
          )}
          {pairing.status?.paired && (
            <p className="text-xs text-success">
              ✓ Paired with chat ID <code className="font-mono">{pairing.status.ownerChatId}</code>
            </p>
          )}
        </StepCard>
      </div>
    </ConnectionCard>
  );
}

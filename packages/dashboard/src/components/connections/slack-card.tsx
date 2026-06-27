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
import { Hash } from "lucide-react";
import type {
  SlackBotInfoResponse,
  SlackPairingStatusResponse,
  SlackManifestResponse,
  PhrasePairingStartResponse,
  MessagingHealthStatus,
} from "@/lib/api-types";
import {
  ConnectionCard,
  deriveMessagingStatus,
  messagingMetadata,
} from "./connection-card";

export function SlackCard() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const queryClient = useQueryClient();
  const status: MessagingHealthStatus | undefined = health?.messaging?.slack;

  const [draftBot, setDraftBot] = useState("");
  const [draftApp, setDraftApp] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manifest, setManifest] = useState<SlackManifestResponse | null>(null);
  const [botInfo, setBotInfo] = useState<SlackBotInfoResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<PhrasePairingStartResponse | null>(null);

  const pairing = usePairingPoll<SlackPairingStatusResponse>(
    "/messaging/slack/pairing-status",
    (d) => d.paired || !d.pairingActive,
  );

  // When pairing completes, clear the phrase display.
  if (pairing.status?.paired && phrase) setPhrase(null);
  if (pairing.status && !pairing.status.pairingActive && phrase) setPhrase(null);

  if (!config || !health) return null;

  const handleSave = async () => {
    setSaving(true); setError(null); setNotice(null);
    try {
      await api.put("/secrets/slack", {
        ...(draftBot ? { botToken: draftBot } : {}),
        ...(draftApp ? { appToken: draftApp } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
      setNotice("Updated."); setDraftBot(""); setDraftApp("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally { setSaving(false); }
  };

  const handleTest = async () => {
    setBusy("test"); setError(null);
    try {
      const candidate = draftBot || undefined;
      const info = await api.post<SlackBotInfoResponse>(
        "/messaging/slack/test-token",
        candidate ? { token: candidate } : undefined,
      );
      setBotInfo(info);
      setNotice(`Token OK — bot: ${info.botName ?? "(unknown)"}${info.team ? ` @ ${info.team}` : ""}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Token test failed");
    } finally { setBusy(null); }
  };

  const handleStartPairing = async () => {
    setBusy("pair"); setError(null);
    try {
      const res = await api.post<PhrasePairingStartResponse>("/messaging/slack/start-pairing");
      setPhrase(res);
      pairing.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start pairing");
    } finally { setBusy(null); }
  };

  const handleCancelPairing = async () => {
    pairing.reset(); setPhrase(null);
    try { await api.post("/messaging/slack/cancel-pairing"); } catch { /* best-effort */ }
  };

  return (
    <ConnectionCard
      name="Slack"
      icon={<Hash className="h-4 w-4" />}
      status={deriveMessagingStatus(status)}
      error={status?.error}
      metadata={messagingMetadata(status)}
    >
      <div className="space-y-4 mt-2">
        {error && <Alert variant="error">{error}</Alert>}
        {notice && <Alert variant="success">{notice}</Alert>}

        {/* Step 1 — Create the app */}
        <StepCard heading="Step 1 — Create the Slack app">
          <p className="mt-1 text-xs text-muted-foreground">
            We&apos;ll pre-fill the manifest with the right scopes and Socket Mode enabled.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy === "manifest"}
              onClick={async () => {
                setBusy("manifest"); setError(null);
                try {
                  const res = await api.get<SlackManifestResponse>("/messaging/slack/manifest");
                  setManifest(res);
                  window.open(res.createAppUrl, "_blank", "noopener");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Failed to load manifest");
                } finally { setBusy(null); }
              }}>
              {busy === "manifest" ? "Loading..." : "Open Slack app builder"}
            </Button>
            {manifest && (
              <Button size="sm" variant="ghost"
                onClick={() => { void navigator.clipboard?.writeText(manifest.manifestJson); setNotice("Manifest copied."); }}>
                Copy manifest JSON
              </Button>
            )}
          </div>
          {manifest && (
            <ol className="mt-3 list-inside list-decimal space-y-1 text-xs text-muted-foreground">
              {manifest.instructions.map((line) => (
                <li key={line}>{line.replace(/^\d+\.\s*/, "")}</li>
              ))}
            </ol>
          )}
        </StepCard>

        {/* Step 2 — Tokens */}
        <StepCard heading="Step 2 — Paste tokens" spacing="md">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Bot token</label>
            <Input type="password" value={draftBot}
              placeholder={config.slackConfigured ? "Configured. Enter a new token to replace it." : "xoxb-..."}
              onChange={(e) => setDraftBot(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">App token</label>
            <Input type="password" value={draftApp}
              placeholder={config.slackConfigured ? "Configured. Enter a new token to replace it." : "xapp-..."}
              onChange={(e) => setDraftApp(e.target.value)} />
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
              ✓ Bot: <code className="font-mono">{botInfo.botName}</code>
              {botInfo.team && <> · workspace: <code className="font-mono">{botInfo.team}</code></>}
              {botInfo.botUserId && <> · id: <code className="font-mono">{botInfo.botUserId}</code></>}
            </p>
          )}
        </StepCard>

        {/* Step 3 — Pair */}
        <StepCard heading="Step 3 — Pair with magic phrase" spacing="sm">
          <p className="text-xs text-muted-foreground">
            Click below to generate a one-time phrase. Send your bot a DM in Slack
            containing that exact phrase — only that DM will capture your user ID.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline"
              disabled={!config.slackConfigured || busy === "pair"}
              title={config.slackConfigured ? undefined : "Save your tokens first"}
              onClick={handleStartPairing}>
              {busy === "pair" ? "Generating..." : "Generate pairing phrase"}
            </Button>
            {pairing.active && (
              <Button size="sm" variant="ghost" onClick={handleCancelPairing}>Cancel</Button>
            )}
          </div>
          {phrase && (
            <div className="rounded-md bg-muted p-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">Send this phrase to your bot in Slack:</p>
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

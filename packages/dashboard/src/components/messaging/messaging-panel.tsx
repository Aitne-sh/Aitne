"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { api } from "@/lib/api-client";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PhoneInput } from "@/components/ui/phone-input";
import { DirectoryPickerField } from "@/components/directory-picker-field";
import { StepCard } from "@/components/shared/step-card";
import type {
  ConfigUpdateResponse,
  WhatsAppQrResponse,
  TelegramBotInfoResponse,
  TelegramPairingStartResponse,
  TelegramPairingStatusResponse,
  SlackBotInfoResponse,
  SlackPairingStatusResponse,
  SlackManifestResponse,
  DiscordBotInfoResponse,
  DiscordPairingStatusResponse,
  PhrasePairingStartResponse,
} from "@/lib/api-types";

const PLATFORM_LABELS: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
  dashboard: "Dashboard",
};

function RuntimeBadge({ state }: { state: "ok" | "error" | "not_configured" | "connecting" }) {
  if (state === "ok") return <Badge variant="green">ok</Badge>;
  if (state === "error") return <Badge variant="red">error</Badge>;
  if (state === "connecting") return <Badge variant="amber">connecting…</Badge>;
  return <Badge variant="gray">not configured</Badge>;
}

function StatLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function DestinationSelector({
  selected,
  available,
  onSave,
}: {
  selected: string[];
  available: string[];
  onSave: (platforms: string[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string[]>(selected);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(selected);
  }, [selected]);

  const toggle = (platform: string) => {
    setDraft((prev) =>
      prev.includes(platform)
        ? prev.filter((item) => item !== platform)
        : [...prev, platform],
    );
  };

  const hasChanges =
    draft.length !== selected.length
    || draft.some((item) => !selected.includes(item));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {available.map((platform) => (
          <Button
            key={platform}
            size="sm"
            variant={draft.includes(platform) ? "default" : "outline"}
            onClick={() => toggle(platform)}
            className="capitalize"
            disabled={saving}
          >
            {platform}
          </Button>
        ))}
        {available.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No eligible messaging app is configured yet.
          </span>
        )}
      </div>
      <p className="max-w-prose text-xs text-muted-foreground">
        Every selected destination receives the same reminder. Replies still go back to the app where the conversation happened, and one request can override the destination without changing this default.
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={!hasChanges || saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onSave(draft);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "Saving..." : "Save Reminder Destinations"}
      </Button>
    </div>
  );
}

export function MessagingPanel({
  showSetupCopy = false,
  showDestinationSelector = true,
}: {
  showSetupCopy?: boolean;
  showDestinationSelector?: boolean;
}) {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [whatsappQr, setWhatsappQr] = useState<WhatsAppQrResponse | null>(null);
  const [whatsappPairing, setWhatsappPairing] = useState(false);
  const whatsappPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop QR polling once the adapter reports OK or the panel unmounts.
  useEffect(() => {
    return () => {
      if (whatsappPollRef.current) {
        clearInterval(whatsappPollRef.current);
        whatsappPollRef.current = null;
      }
    };
  }, []);

  const stopWhatsappPolling = () => {
    if (whatsappPollRef.current) {
      clearInterval(whatsappPollRef.current);
      whatsappPollRef.current = null;
    }
    setWhatsappPairing(false);
  };

  const startWhatsappPolling = () => {
    if (whatsappPollRef.current) return;
    setWhatsappPairing(true);
    whatsappPollRef.current = setInterval(async () => {
      try {
        const next = await api.get<WhatsAppQrResponse>("/messaging/whatsapp/qr");
        setWhatsappQr(next);
        if (next.state === "ok") {
          stopWhatsappPolling();
          await queryClient.invalidateQueries({ queryKey: ["health"] });
        }
        if (next.state === "logged_out") {
          stopWhatsappPolling();
        }
      } catch {
        // Swallow transient poll errors — surface only if pair() itself fails.
      }
    }, 3000);
  };

  // ── Telegram pairing state ────────────────────────────────────────────
  // `tgBotInfo` is the result of `test-token` (getMe), shown to confirm
  // the user pasted the right token. `tgPair` is the active QR pairing
  // session. Polling continues until the daemon reports `paired=true`.
  const [tgBotInfo, setTgBotInfo] = useState<TelegramBotInfoResponse | null>(null);
  const [tgPair, setTgPair] = useState<TelegramPairingStartResponse | null>(null);
  const [tgStatus, setTgStatus] = useState<TelegramPairingStatusResponse | null>(null);
  const [tgBusy, setTgBusy] = useState<string | null>(null);
  const tgPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTgPolling = () => {
    if (tgPollRef.current) {
      clearInterval(tgPollRef.current);
      tgPollRef.current = null;
    }
  };

  const startTgPolling = () => {
    if (tgPollRef.current) return;
    tgPollRef.current = setInterval(async () => {
      try {
        const next = await api.get<TelegramPairingStatusResponse>(
          "/messaging/telegram/pairing-status",
        );
        setTgStatus(next);
        if (next.paired) {
          stopTgPolling();
          setTgPair(null);
          await queryClient.invalidateQueries({ queryKey: ["config"] });
          await queryClient.invalidateQueries({ queryKey: ["health"] });
        }
      } catch {
        // Transient — keep polling.
      }
    }, 2000);
  };

  // ── Slack pairing state ──────────────────────────────────────────────
  const [slackBotInfo, setSlackBotInfo] = useState<SlackBotInfoResponse | null>(null);
  const [slackManifest, setSlackManifest] = useState<SlackManifestResponse | null>(null);
  const [slackStatus, setSlackStatus] = useState<SlackPairingStatusResponse | null>(null);
  const [slackPhrase, setSlackPhrase] = useState<PhrasePairingStartResponse | null>(null);
  const [slackBusy, setSlackBusy] = useState<string | null>(null);
  // Mirror polling-active state in useState (not just the ref) so the UI
  // re-renders when polling starts/stops — useRef mutations don't trigger
  // re-renders.
  const [slackPolling, setSlackPolling] = useState(false);
  const slackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopSlackPolling = () => {
    if (slackPollRef.current) {
      clearInterval(slackPollRef.current);
      slackPollRef.current = null;
    }
    setSlackPolling(false);
  };

  const startSlackPolling = () => {
    if (slackPollRef.current) return;
    setSlackPolling(true);
    slackPollRef.current = setInterval(async () => {
      try {
        const next = await api.get<SlackPairingStatusResponse>(
          "/messaging/slack/pairing-status",
        );
        setSlackStatus(next);
        if (next.paired) {
          stopSlackPolling();
          setSlackPhrase(null);
          await queryClient.invalidateQueries({ queryKey: ["config"] });
          await queryClient.invalidateQueries({ queryKey: ["health"] });
        } else if (!next.pairingActive) {
          // Server-side TTL elapsed — stop polling so the UI doesn't churn forever.
          stopSlackPolling();
          setSlackPhrase(null);
        }
      } catch {
        // Transient.
      }
    }, 2000);
  };

  // ── Discord pairing state ────────────────────────────────────────────
  const [dcBotInfo, setDcBotInfo] = useState<DiscordBotInfoResponse | null>(null);
  const [dcStatus, setDcStatus] = useState<DiscordPairingStatusResponse | null>(null);
  const [dcPhrase, setDcPhrase] = useState<PhrasePairingStartResponse | null>(null);
  const [dcBusy, setDcBusy] = useState<string | null>(null);
  const [dcPolling, setDcPolling] = useState(false);
  const dcPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopDcPolling = () => {
    if (dcPollRef.current) {
      clearInterval(dcPollRef.current);
      dcPollRef.current = null;
    }
    setDcPolling(false);
  };

  const startDcPolling = () => {
    if (dcPollRef.current) return;
    setDcPolling(true);
    dcPollRef.current = setInterval(async () => {
      try {
        const next = await api.get<DiscordPairingStatusResponse>(
          "/messaging/discord/pairing-status",
        );
        setDcStatus(next);
        if (next.paired) {
          stopDcPolling();
          setDcPhrase(null);
          await queryClient.invalidateQueries({ queryKey: ["config"] });
          await queryClient.invalidateQueries({ queryKey: ["health"] });
        } else if (!next.pairingActive) {
          stopDcPolling();
          setDcPhrase(null);
        }
      } catch {
        // Transient.
      }
    }, 2000);
  };

  // Poll cleanup for all four pairing flows on unmount.
  useEffect(() => {
    return () => {
      stopTgPolling();
      stopSlackPolling();
      stopDcPolling();
    };
  }, []);

  const messaging = health?.messaging;
  const destinationOptions = Object.entries(messaging ?? {})
    .filter(
      ([platform, status]) =>
        platform !== "dashboard"
        && status.configured
        && status.ownerConfigured,
    )
    .map(([platform]) => platform);

  if (!config || !health) {
    return <div className="p-6 text-sm text-muted-foreground">Loading messaging status...</div>;
  }

  const saveUpdates = async (updates: Record<string, unknown>) => {
    setError(null);
    setNotice(null);
    const res = await api.patch<ConfigUpdateResponse>("/config", updates);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["config"] }),
      queryClient.invalidateQueries({ queryKey: ["health"] }),
    ]);
    if (res.requiresRestart.length > 0) {
      setNotice(`Updated. Restart daemon for: ${res.requiresRestart.join(", ")}`);
    } else {
      setNotice("Updated.");
    }
  };

  const saveSecret = async (path: string, payload: Record<string, unknown>) => {
    setError(null);
    setNotice(null);
    await api.put(path, payload);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["config"] }),
      queryClient.invalidateQueries({ queryKey: ["health"] }),
    ]);
    setNotice("Updated.");
  };

  const clearDraftKeys = (keys: string[]) => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const key of keys) {
        delete next[key];
      }
      return next;
    });
  };

  const renderTextField = (
    key: string,
    label: string,
    placeholder: string,
    type: "text" | "password" = "text",
  ) => (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Input
        type={type}
        value={drafts[key] ?? ""}
        placeholder={placeholder}
        onChange={(e) =>
          setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
        }
      />
    </div>
  );

  return (
    <div className="space-y-6">
      {showSetupCopy && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Messaging</CardTitle>
            <p className="text-sm text-muted-foreground">
              Set up the apps you want to use for private conversations, then choose which apps should receive reminders by default. Each platform has a short pairing flow — scan a QR code, paste a bot token, or install a pre-configured app manifest. The status badges below tell you at a glance whether a platform is paired and ready to both send and receive.
            </p>
            <div className="mt-2 text-xs text-muted-foreground">
              <p>
                <strong>Runtime badge:</strong> <em>ok</em> = connected and reachable, <em>error</em> = credentials present but failing (see error text), <em>not configured</em> = no credentials yet.
              </p>
              <p className="mt-1">
                <strong>Owner configured</strong> = an owner user ID has been saved. <strong>Owner channel known</strong> = the agent has seen at least one DM so it knows where to reply. <strong>Reminder eligible</strong> = this platform can be selected as a default notification destination.
              </p>
            </div>
          </CardHeader>
        </Card>
      )}

      {error && <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">{error}</div>}
      {notice && <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">{notice}</div>}

      {showDestinationSelector && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Default Reminder Destinations</CardTitle>
            <p className="text-sm text-muted-foreground">
              Which platforms the agent sends proactive reminders to when no specific destination is supplied. Pick one or more — each selected destination receives the same reminder. Only platforms that are connected and owner-configured show up here. You can still override the destination for a single reminder without changing this default.
            </p>
          </CardHeader>
          <div className="space-y-4">
            <DestinationSelector
              selected={config.defaultNotificationPlatforms}
              available={destinationOptions}
              onSave={(platforms) => saveUpdates({ defaultNotificationPlatforms: platforms })}
            />
          </div>
        </Card>
      )}

      {(["slack", "telegram", "discord", "whatsapp", "dashboard"] as const).map((platform) => {
        const status = messaging?.[platform];
        const label = PLATFORM_LABELS[platform];

        return (
          <Card key={platform}>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <CardTitle className="text-base">{label}</CardTitle>
                {status && <RuntimeBadge state={status.runtimeState} />}
              </div>
            </CardHeader>
            <div className="space-y-4">
              {status && (
                <>
                  <StatLine label="Owner configured" value={status.ownerConfigured ? "yes" : "no"} />
                  <StatLine label="Owner channel known" value={status.ownerChannelKnown ? "yes" : "no"} />
                  <StatLine label="Reminder eligible" value={status.notificationEligible ? "yes" : "no"} />
                  <StatLine label="Last inbound" value={status.lastInboundAt ?? "—"} />
                  {status.error && <p className="text-xs text-red-600 dark:text-red-400">{status.error}</p>}
                </>
              )}

              {platform === "slack" && (
                <>
                  <StepCard heading="Step 1 — Create the Slack app">
                    <p className="mt-1 text-xs text-muted-foreground">
                      We&apos;ll pre-fill the manifest with the right scopes and Socket Mode enabled.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={slackBusy === "manifest"}
                        onClick={async () => {
                          setSlackBusy("manifest");
                          setError(null);
                          try {
                            const res = await api.get<SlackManifestResponse>(
                              "/messaging/slack/manifest",
                            );
                            setSlackManifest(res);
                            window.open(res.createAppUrl, "_blank", "noopener");
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Failed to load Slack manifest");
                          } finally {
                            setSlackBusy(null);
                          }
                        }}
                      >
                        {slackBusy === "manifest" ? "Loading..." : "Open Slack app builder"}
                      </Button>
                      {slackManifest && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void navigator.clipboard?.writeText(slackManifest.manifestJson);
                            setNotice("Manifest copied to clipboard.");
                          }}
                        >
                          Copy manifest JSON
                        </Button>
                      )}
                    </div>
                    {slackManifest && (
                      <ol className="mt-3 list-inside list-decimal space-y-1 text-xs text-muted-foreground">
                        {slackManifest.instructions.map((line) => (
                          <li key={line}>{line.replace(/^\d+\.\s*/, "")}</li>
                        ))}
                      </ol>
                    )}
                  </StepCard>

                  <StepCard heading="Step 2 — Paste tokens" spacing="md">
                    {renderTextField("slackBotToken", "Bot token", config.slackConfigured ? "Configured. Enter a new token to replace it." : "xoxb-...", "password")}
                    {renderTextField("slackAppToken", "App token", config.slackConfigured ? "Configured. Enter a new token to replace it." : "xapp-...", "password")}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={savingKey === "slack"}
                        onClick={async () => {
                          setSavingKey("slack");
                          try {
                            await saveSecret("/secrets/slack", {
                              ...(drafts.slackBotToken ? { botToken: drafts.slackBotToken } : {}),
                              ...(drafts.slackAppToken ? { appToken: drafts.slackAppToken } : {}),
                            });
                            clearDraftKeys(["slackBotToken", "slackAppToken"]);
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Failed to update Slack config");
                          } finally {
                            setSavingKey(null);
                          }
                        }}
                      >
                        {savingKey === "slack" ? "Saving..." : "Save Slack Config"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={slackBusy === "test"}
                        onClick={async () => {
                          setSlackBusy("test");
                          setError(null);
                          try {
                            // Prefer the draft token (user just typed it,
                            // hasn't saved yet) so the user doesn't have
                            // to commit a token to .env before validating it.
                            const candidate = drafts.slackBotToken;
                            const info = await api.post<SlackBotInfoResponse>(
                              "/messaging/slack/test-token",
                              candidate ? { token: candidate } : undefined,
                            );
                            setSlackBotInfo(info);
                            setNotice(
                              `Slack token OK — bot: ${info.botName ?? "(unknown)"}${info.team ? ` @ ${info.team}` : ""}`,
                            );
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Slack token test failed");
                          } finally {
                            setSlackBusy(null);
                          }
                        }}
                      >
                        {slackBusy === "test" ? "Testing..." : "Test token"}
                      </Button>
                    </div>
                    {slackBotInfo && (
                      <p className="text-xs text-emerald-700 dark:text-emerald-300">
                        ✓ Bot connected: <code className="font-mono">{slackBotInfo.botName}</code>
                        {slackBotInfo.team && (
                          <> · workspace: <code className="font-mono">{slackBotInfo.team}</code></>
                        )}
                        {slackBotInfo.botUserId && (
                          <> · bot user id: <code className="font-mono">{slackBotInfo.botUserId}</code></>
                        )}
                      </p>
                    )}
                  </StepCard>

                  <StepCard heading="Step 3 — Pair with magic phrase" spacing="sm">
                    <p className="text-xs text-muted-foreground">
                      Click below to generate a one-time phrase. Send your bot a DM
                      in Slack containing that exact phrase — only that DM will
                      capture your user ID, so a stranger DMing the bot can&apos;t
                      hijack ownership.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!config.slackConfigured || slackBusy === "pair"}
                        title={config.slackConfigured ? undefined : "Save your Slack tokens first"}
                        onClick={async () => {
                          setSlackBusy("pair");
                          setError(null);
                          try {
                            const res = await api.post<PhrasePairingStartResponse>(
                              "/messaging/slack/start-pairing",
                            );
                            setSlackPhrase(res);
                            startSlackPolling();
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Failed to start Slack pairing");
                          } finally {
                            setSlackBusy(null);
                          }
                        }}
                      >
                        {slackBusy === "pair" ? "Generating..." : "Generate pairing phrase"}
                      </Button>
                      {slackPolling && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            stopSlackPolling();
                            setSlackPhrase(null);
                            try {
                              await api.post("/messaging/slack/cancel-pairing");
                            } catch {
                              // best-effort
                            }
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                    {slackPhrase && (
                      <div className="rounded-md bg-muted p-3 text-center">
                        <p className="text-xs text-muted-foreground mb-1">
                          Send this phrase to your bot in Slack:
                        </p>
                        <code className="font-mono text-base font-semibold tracking-wide">
                          {slackPhrase.phrase}
                        </code>
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          Expires {new Date(slackPhrase.expiresAt).toLocaleTimeString()} ·
                          punctuation and case are ignored.
                        </p>
                      </div>
                    )}
                    {slackStatus && (
                      <p className="text-xs text-muted-foreground">
                        {slackStatus.paired
                          ? <>✓ Owner paired: <code className="font-mono">{slackStatus.ownerUserId}</code></>
                          : slackStatus.pairingActive
                            ? "Waiting for the phrase..."
                            : "Pairing not active."}
                      </p>
                    )}
                  </StepCard>
                </>
              )}

              {platform === "telegram" && (
                <>
                  <StepCard heading="Step 1 — Create the bot" spacing="sm">
                    <p className="text-xs text-muted-foreground">
                      Open <a className="underline" href="https://t.me/botfather" target="_blank" rel="noopener noreferrer">@BotFather</a>,
                      send <code className="font-mono">/newbot</code>, give it a name and a username,
                      then copy the HTTP API token BotFather returns.
                    </p>
                  </StepCard>

                  <StepCard heading="Step 2 — Paste token" spacing="md">
                    {renderTextField("telegramBotToken", "Bot token", config.telegramConfigured ? "Configured. Enter a new token to replace it." : "123456:ABC-DEF…", "password")}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={savingKey === "telegram"}
                        onClick={async () => {
                          setSavingKey("telegram");
                          try {
                            await saveSecret("/secrets/telegram", {
                              ...(drafts.telegramBotToken ? { botToken: drafts.telegramBotToken } : {}),
                            });
                            clearDraftKeys(["telegramBotToken"]);
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Failed to update Telegram config");
                          } finally {
                            setSavingKey(null);
                          }
                        }}
                      >
                        {savingKey === "telegram" ? "Saving..." : "Save Telegram Config"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={tgBusy === "test"}
                        onClick={async () => {
                          setTgBusy("test");
                          setError(null);
                          try {
                            const candidate = drafts.telegramBotToken;
                            const info = await api.post<TelegramBotInfoResponse>(
                              "/messaging/telegram/test-token",
                              candidate ? { token: candidate } : undefined,
                            );
                            setTgBotInfo(info);
                            setNotice(
                              `Telegram token OK — bot: ${info.firstName ?? info.username ?? info.id}`,
                            );
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Telegram token test failed");
                          } finally {
                            setTgBusy(null);
                          }
                        }}
                      >
                        {tgBusy === "test" ? "Testing..." : "Test token"}
                      </Button>
                    </div>
                    {tgBotInfo && (
                      <p className="text-xs text-emerald-700 dark:text-emerald-300">
                        ✓ Bot: <code className="font-mono">@{tgBotInfo.username ?? tgBotInfo.id}</code>
                      </p>
                    )}
                  </StepCard>

                  <StepCard heading="Step 3 — Pair with QR" spacing="sm">
                    <p className="text-xs text-muted-foreground">
                      Generate a QR code that opens your bot in Telegram and sends a one-shot
                      pairing token. The daemon captures your chat ID automatically.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!config.telegramConfigured || tgBusy === "pair"}
                        title={config.telegramConfigured ? undefined : "Save your Telegram token first"}
                        onClick={async () => {
                          setTgBusy("pair");
                          setError(null);
                          try {
                            const res = await api.post<TelegramPairingStartResponse>(
                              "/messaging/telegram/start-pairing",
                            );
                            setTgPair(res);
                            startTgPolling();
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Failed to start Telegram pairing");
                          } finally {
                            setTgBusy(null);
                          }
                        }}
                      >
                        {tgBusy === "pair" ? "Generating..." : "Pair with QR"}
                      </Button>
                      {tgPair && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            stopTgPolling();
                            setTgPair(null);
                            try {
                              await api.post("/messaging/telegram/cancel-pairing");
                            } catch {
                              // best-effort
                            }
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                    {tgPair && (
                      <div className="flex flex-col items-center gap-2 rounded-lg bg-muted p-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={tgPair.qrDataUrl}
                          alt="Telegram pairing QR code"
                          width={320}
                          height={320}
                          className="rounded bg-white p-2"
                        />
                        <p className="text-xs text-muted-foreground text-center">
                          Scan with your phone — Telegram will open <code className="font-mono">@{tgPair.botUsername}</code>{" "}
                          and send the pairing token automatically.
                        </p>
                        <a
                          className="text-xs underline"
                          href={tgPair.deepLink}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Or open the link directly
                        </a>
                      </div>
                    )}
                    {tgStatus?.paired && (
                      <p className="text-xs text-emerald-700 dark:text-emerald-300">
                        ✓ Paired with chat ID <code className="font-mono">{tgStatus.ownerChatId}</code>
                      </p>
                    )}
                  </StepCard>
                </>
              )}

              {platform === "discord" && (
                <>
                  <StepCard heading="Step 1 — Create the bot" spacing="sm">
                    <p className="text-xs text-muted-foreground">
                      Open the{" "}
                      <a className="underline" href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">
                        Discord Developer Portal
                      </a>
                      , create a new application, add a Bot under &quot;Bot&quot;,
                      enable the &quot;Message Content Intent&quot;, and copy the token.
                    </p>
                  </StepCard>

                  <StepCard heading="Step 2 — Paste token" spacing="md">
                    {renderTextField("discordBotToken", "Bot token", config.discordConfigured ? "Configured. Enter a new token to replace it." : "Discord bot token", "password")}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={savingKey === "discord"}
                        onClick={async () => {
                          setSavingKey("discord");
                          try {
                            await saveSecret("/secrets/discord", {
                              ...(drafts.discordBotToken ? { botToken: drafts.discordBotToken } : {}),
                            });
                            clearDraftKeys(["discordBotToken"]);
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Failed to update Discord config");
                          } finally {
                            setSavingKey(null);
                          }
                        }}
                      >
                        {savingKey === "discord" ? "Saving..." : "Save Discord Config"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={dcBusy === "test"}
                        onClick={async () => {
                          setDcBusy("test");
                          setError(null);
                          try {
                            const candidate = drafts.discordBotToken;
                            const info = await api.post<DiscordBotInfoResponse>(
                              "/messaging/discord/test-token",
                              candidate ? { token: candidate } : undefined,
                            );
                            setDcBotInfo(info);
                            setNotice(`Discord token OK — bot: ${info.username}`);
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Discord token test failed");
                          } finally {
                            setDcBusy(null);
                          }
                        }}
                      >
                        {dcBusy === "test" ? "Testing..." : "Test token"}
                      </Button>
                    </div>
                    {dcBotInfo && (
                      <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                        ✓ Bot: <code className="font-mono">{dcBotInfo.username}</code>
                        {dcBotInfo.avatarUrl && (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={dcBotInfo.avatarUrl}
                            alt=""
                            width={16}
                            height={16}
                            className="rounded-full"
                          />
                        )}
                      </p>
                    )}
                  </StepCard>

                  <StepCard heading="Step 3 — Pair with magic phrase" spacing="sm">
                    <p className="text-xs text-muted-foreground">
                      Add the bot to a server you share with it, then click below
                      to generate a one-time phrase. DM the bot with that exact
                      phrase — only that DM captures your user ID, so randos
                      DMing the bot can&apos;t hijack ownership.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!config.discordConfigured || dcBusy === "pair"}
                        title={config.discordConfigured ? undefined : "Save your Discord token first"}
                        onClick={async () => {
                          setDcBusy("pair");
                          setError(null);
                          try {
                            const res = await api.post<PhrasePairingStartResponse>(
                              "/messaging/discord/start-pairing",
                            );
                            setDcPhrase(res);
                            startDcPolling();
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Failed to start Discord pairing");
                          } finally {
                            setDcBusy(null);
                          }
                        }}
                      >
                        {dcBusy === "pair" ? "Generating..." : "Generate pairing phrase"}
                      </Button>
                      {dcPolling && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            stopDcPolling();
                            setDcPhrase(null);
                            try {
                              await api.post("/messaging/discord/cancel-pairing");
                            } catch {
                              // best-effort
                            }
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                    {dcPhrase && (
                      <div className="rounded-md bg-muted p-3 text-center">
                        <p className="text-xs text-muted-foreground mb-1">
                          Send this phrase to your bot in Discord:
                        </p>
                        <code className="font-mono text-base font-semibold tracking-wide">
                          {dcPhrase.phrase}
                        </code>
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          Expires {new Date(dcPhrase.expiresAt).toLocaleTimeString()} ·
                          punctuation and case are ignored.
                        </p>
                      </div>
                    )}
                    {dcStatus && (
                      <p className="text-xs text-muted-foreground">
                        {dcStatus.paired
                          ? <>✓ Owner paired: <code className="font-mono">{dcStatus.ownerUserId}</code></>
                          : dcStatus.pairingActive
                            ? "Waiting for the phrase..."
                            : "Pairing not active."}
                      </p>
                    )}
                  </StepCard>
                </>
              )}

              {platform === "whatsapp" && (
                <>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={config.whatsappEnabled ? "default" : "outline"}
                      disabled={
                        savingKey === "whatsapp-enabled"
                        || (!config.whatsappEnabled
                          && !config.whatsappOwnerPhoneConfigured
                          && !drafts.whatsappOwnerPhone)
                      }
                      onClick={async () => {
                        setSavingKey("whatsapp-enabled");
                        try {
                          // If user typed a phone but hasn't saved it yet, persist it
                          // alongside the toggle so enabling can build the adapter.
                          await saveUpdates({
                            whatsappEnabled: !config.whatsappEnabled,
                            ...(drafts.whatsappOwnerPhone
                              ? { whatsappOwnerPhone: drafts.whatsappOwnerPhone }
                              : {}),
                            ...(drafts.whatsappAuthDir
                              ? { whatsappAuthDir: drafts.whatsappAuthDir }
                              : {}),
                          });
                          if (!config.whatsappEnabled) {
                            // Just transitioned OFF→ON: kick off pair flow now.
                            // No daemon restart needed — hot-reload handles it.
                            try {
                              const res = await api.post<WhatsAppQrResponse>(
                                "/messaging/whatsapp/pair",
                              );
                              setWhatsappQr(res);
                              startWhatsappPolling();
                            } catch (pairErr) {
                              setError(
                                pairErr instanceof Error
                                  ? pairErr.message
                                  : "Failed to start WhatsApp pairing",
                              );
                            }
                          } else {
                            // Just transitioned ON→OFF
                            stopWhatsappPolling();
                            setWhatsappQr(null);
                          }
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to toggle WhatsApp");
                        } finally {
                          setSavingKey(null);
                        }
                      }}
                    >
                      {config.whatsappEnabled ? "Disable WhatsApp" : "Enable WhatsApp"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {config.whatsappEnabled
                        ? "Adapter hot-reloads on save — no daemon restart needed."
                        : "Set the owner phone first, then click Enable to start pairing."}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <label
                      className="text-xs text-muted-foreground"
                      htmlFor="whatsapp-owner-phone"
                    >
                      Owner phone
                    </label>
                    <PhoneInput
                      id="whatsapp-owner-phone"
                      value={drafts.whatsappOwnerPhone ?? ""}
                      onChange={(next) =>
                        setDrafts((prev) => ({ ...prev, whatsappOwnerPhone: next }))
                      }
                      placeholder={
                        config.whatsappOwnerPhoneConfigured
                          ? "Configured — type to replace"
                          : "Subscriber number"
                      }
                      defaultCountryIso2="US"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      Auth dir
                    </label>
                    <DirectoryPickerField
                      value={drafts.whatsappAuthDir ?? ""}
                      onChange={(next) =>
                        setDrafts((prev) => ({
                          ...prev,
                          whatsappAuthDir: next,
                        }))
                      }
                      title="Choose WhatsApp auth directory"
                      placeholder={config.whatsappAuthDir || "~/.personal-agent/whatsapp/auth"}
                      defaultPath={config.whatsappAuthDir || undefined}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={savingKey === "whatsapp"}
                      onClick={async () => {
                        setSavingKey("whatsapp");
                        try {
                          await saveUpdates({
                            ...(drafts.whatsappOwnerPhone
                              ? { whatsappOwnerPhone: drafts.whatsappOwnerPhone }
                              : {}),
                            ...(drafts.whatsappAuthDir
                              ? { whatsappAuthDir: drafts.whatsappAuthDir }
                              : {}),
                          });
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to update WhatsApp config");
                        } finally {
                          setSavingKey(null);
                        }
                      }}
                    >
                      {savingKey === "whatsapp" ? "Saving..." : "Save WhatsApp Config"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!config.whatsappEnabled || whatsappPairing}
                      title={
                        config.whatsappEnabled
                          ? undefined
                          : "Enable WhatsApp first"
                      }
                      onClick={async () => {
                        try {
                          setError(null);
                          setWhatsappQr(null);
                          const res = await api.post<WhatsAppQrResponse>(
                            "/messaging/whatsapp/pair",
                          );
                          setWhatsappQr(res);
                          if (res.state !== "ok") {
                            startWhatsappPolling();
                          }
                          await queryClient.invalidateQueries({ queryKey: ["health"] });
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to request WhatsApp pairing");
                        }
                      }}
                    >
                      {whatsappPairing ? "Pairing..." : "Pair device"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!config.whatsappEnabled}
                      onClick={async () => {
                        try {
                          const res = await api.get<WhatsAppQrResponse>(
                            "/messaging/whatsapp/qr",
                          );
                          setWhatsappQr(res);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to fetch WhatsApp QR");
                        }
                      }}
                    >
                      Refresh QR
                    </Button>
                    {whatsappPairing && (
                      <Button size="sm" variant="ghost" onClick={stopWhatsappPolling}>
                        Stop polling
                      </Button>
                    )}
                  </div>
                  {whatsappQr && (
                    <>
                      <Separator />
                      <div className="space-y-3">
                        {whatsappQr.dataUrl ? (
                          <div className="flex flex-col items-center gap-2 rounded-lg bg-muted p-4">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={whatsappQr.dataUrl}
                              alt="WhatsApp pairing QR code"
                              width={320}
                              height={320}
                              className="rounded bg-white p-2"
                            />
                            <p className="text-xs text-muted-foreground">
                              Open WhatsApp → Settings → Linked Devices → Link a device,
                              and scan this code. It rotates every ~20s; the panel auto-refreshes.
                            </p>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {whatsappQr.state === "ok"
                              ? "WhatsApp is paired and connected."
                              : whatsappQr.state === "connecting"
                                ? "Connecting to WhatsApp..."
                                : whatsappQr.state === "awaiting_qr"
                                  ? "Generating QR code..."
                                  : whatsappQr.state === "logged_out"
                                    ? "Session logged out — click Pair device to start over."
                                    : "Waiting for QR code..."}
                          </p>
                        )}
                        {whatsappQr.error && (
                          <p className="text-xs text-red-600 dark:text-red-400">{whatsappQr.error}</p>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}

              {platform === "dashboard" && (
                <p className="text-xs text-muted-foreground">
                  The dashboard chat shares the same conversation as your other messaging apps. Routine reminders aren&apos;t delivered here by default — they go to the destinations you pick below.
                </p>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

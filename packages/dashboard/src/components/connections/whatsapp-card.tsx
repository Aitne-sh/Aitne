"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { usePairingPoll } from "@/lib/hooks/use-pairing-poll";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { DirectoryPickerField } from "@/components/directory-picker-field";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { PhoneInput } from "@/components/ui/phone-input";
import { Phone } from "lucide-react";
import type { WhatsAppQrResponse, ConfigUpdateResponse, MessagingHealthStatus } from "@/lib/api-types";
import {
  ConnectionCard,
  deriveMessagingStatus,
  messagingMetadata,
} from "./connection-card";

export function WhatsAppCard() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const queryClient = useQueryClient();
  const status: MessagingHealthStatus | undefined = health?.messaging?.whatsapp;

  const [draftPhone, setDraftPhone] = useState("");
  const [draftAuthDir, setDraftAuthDir] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const qrPoll = usePairingPoll<WhatsAppQrResponse>(
    "/messaging/whatsapp/qr",
    (d) => d.state === "ok" || d.state === "logged_out",
    3000,
  );

  if (!config || !health) return null;

  const saveUpdates = async (updates: Record<string, unknown>) => {
    setError(null); setNotice(null);
    const res = await api.patch<ConfigUpdateResponse>("/config", updates);
    await queryClient.invalidateQueries({ queryKey: ["config"] });
    await queryClient.invalidateQueries({ queryKey: ["health"] });
    if (res.requiresRestart.length > 0) {
      setNotice(`Updated. Restart daemon for: ${res.requiresRestart.join(", ")}`);
    } else {
      setNotice("Updated.");
    }
  };

  const handleToggle = async () => {
    setSaving("toggle");
    setError(null); setNotice(null);
    try {
      const wasEnabled = config.whatsappEnabled;
      // Save config first, but defer query invalidation until the adapter is
      // registered on the daemon side — otherwise the next /health refetch
      // can race ahead of POST /pair and briefly see whatsappEnabled=true
      // without a registered adapter, which MessageHub maps to "error".
      const patchRes = await api.patch<ConfigUpdateResponse>("/config", {
        whatsappEnabled: !wasEnabled,
        ...(draftPhone ? { whatsappOwnerPhone: draftPhone } : {}),
        ...(draftAuthDir ? { whatsappAuthDir: draftAuthDir } : {}),
      });
      if (!wasEnabled) {
        try {
          const pairRes = await api.post<WhatsAppQrResponse>("/messaging/whatsapp/pair");
          if (pairRes.state !== "ok") qrPoll.start();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to start pairing");
        }
      } else {
        qrPoll.reset();
      }
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
      if (patchRes.requiresRestart.length > 0) {
        setNotice(`Updated. Restart daemon for: ${patchRes.requiresRestart.join(", ")}`);
      } else {
        setNotice("Updated.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle WhatsApp");
    } finally { setSaving(null); }
  };

  const handleSaveConfig = async () => {
    setSaving("config");
    try {
      await saveUpdates({
        ...(draftPhone ? { whatsappOwnerPhone: draftPhone } : {}),
        ...(draftAuthDir ? { whatsappAuthDir: draftAuthDir } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally { setSaving(null); }
  };

  const handlePair = async () => {
    setError(null);
    try {
      const res = await api.post<WhatsAppQrResponse>("/messaging/whatsapp/pair");
      if (res.state !== "ok") qrPoll.start();
      await queryClient.invalidateQueries({ queryKey: ["health"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to request pairing");
    }
  };

  const handleRefreshQr = async () => {
    try {
      await api.get<WhatsAppQrResponse>("/messaging/whatsapp/qr");
      // Poll will pick up changes; just force a read
      qrPoll.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch QR");
    }
  };

  // Recovery path: when the user has unlinked the device from WhatsApp's
  // side, or the Baileys session is otherwise broken, the cached auth dir
  // prevents a fresh pair from succeeding. This wipes that state and kicks
  // off a brand-new pair flow.
  const handleReset = async () => {
    const confirmed = window.confirm(
      "Reset WhatsApp connection?\n\n" +
        "This wipes the cached pairing data so you can scan a fresh QR " +
        "from scratch. Use this if WhatsApp says the device is unlinked " +
        "or pairing keeps failing.",
    );
    if (!confirmed) return;
    setSaving("reset");
    setError(null); setNotice(null);
    try {
      const res = await api.post<WhatsAppQrResponse>("/messaging/whatsapp/reset");
      await queryClient.invalidateQueries({ queryKey: ["health"] });
      if (res.state === "ok") {
        setNotice("Reset complete. WhatsApp reconnected.");
        qrPoll.reset();
      } else if (res.state === "not_initialized") {
        setNotice(
          "Reset complete. Enable WhatsApp to start a fresh pairing flow.",
        );
        qrPoll.reset();
      } else {
        setNotice("Reset complete. Scan the new QR to pair the device.");
        qrPoll.start();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reset WhatsApp");
    } finally {
      setSaving(null);
    }
  };

  const qr = qrPoll.status;

  return (
    <ConnectionCard
      name="WhatsApp"
      icon={<Phone className="h-4 w-4" />}
      status={deriveMessagingStatus(status)}
      error={status?.error}
      metadata={messagingMetadata(status)}
    >
      <div className="space-y-4 mt-2">
        {error && <Alert variant="error">{error}</Alert>}
        {notice && <Alert variant="warning">{notice}</Alert>}

        {/* Enable/Disable */}
        <div className="flex items-center gap-2">
          <Button size="sm"
            variant={config.whatsappEnabled ? "default" : "outline"}
            disabled={saving === "toggle" || (!config.whatsappEnabled && !config.whatsappOwnerPhoneConfigured && !draftPhone)}
            onClick={handleToggle}>
            {config.whatsappEnabled ? "Disable WhatsApp" : "Enable WhatsApp"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {config.whatsappEnabled
              ? "Adapter hot-reloads on save — no daemon restart needed."
              : "Set the owner phone first, then click Enable to start pairing."}
          </span>
        </div>

        {/* Owner phone */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="whatsapp-owner-phone">Owner phone</label>
          <PhoneInput id="whatsapp-owner-phone" value={draftPhone} onChange={setDraftPhone}
            placeholder={config.whatsappOwnerPhoneConfigured ? "Configured — type to replace" : "Subscriber number"}
            defaultCountryIso2="US" />
        </div>

        {/* Auth dir */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Auth dir</label>
          <DirectoryPickerField
            value={draftAuthDir}
            onChange={setDraftAuthDir}
            title="Choose WhatsApp auth directory"
            placeholder={config.whatsappAuthDir || "~/.personal-agent/whatsapp/auth"}
            defaultPath={config.whatsappAuthDir || undefined}
          />
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={saving === "config"} onClick={handleSaveConfig}>
            {saving === "config" ? "Saving..." : "Save Config"}
          </Button>
          <Button size="sm" variant="outline"
            disabled={!config.whatsappEnabled || qrPoll.active}
            title={config.whatsappEnabled ? undefined : "Enable WhatsApp first"}
            onClick={handlePair}>
            {qrPoll.active ? "Pairing..." : "Pair device"}
          </Button>
          <Button size="sm" variant="outline" disabled={!config.whatsappEnabled} onClick={handleRefreshQr}>
            Refresh QR
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={saving === "reset"}
            title="Wipe cached pairing data and start over (use after unlinking from the phone)"
            onClick={handleReset}>
            {saving === "reset" ? "Resetting..." : "Reset connection"}
          </Button>
          {qrPoll.active && (
            <Button size="sm" variant="ghost" onClick={() => qrPoll.reset()}>Stop polling</Button>
          )}
        </div>

        {/* QR code */}
        {qr && (
          <>
            <Separator />
            <div className="space-y-3">
              {qr.dataUrl ? (
                <div className="flex flex-col items-center gap-2 rounded-lg bg-muted p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr.dataUrl} alt="WhatsApp pairing QR" width={320} height={320} className="rounded bg-white p-2" />
                  <p className="text-xs text-muted-foreground">
                    Open WhatsApp → Settings → Linked Devices → Link a device, and scan this code.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {qr.state === "ok" ? "WhatsApp is paired and connected."
                    : qr.state === "connecting" ? "Connecting to WhatsApp..."
                    : qr.state === "awaiting_qr" ? "Generating QR code..."
                    : qr.state === "logged_out" ? "Session logged out — click Pair device to start over."
                    : "Waiting for QR code..."}
                </p>
              )}
              {qr.error && <Alert variant="error">{qr.error}</Alert>}
            </div>
          </>
        )}
      </div>
    </ConnectionCard>
  );
}

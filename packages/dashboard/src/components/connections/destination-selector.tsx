"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConfigUpdateResponse } from "@/lib/api-types";

export function DestinationSelector() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const queryClient = useQueryClient();

  const available = Object.entries(health?.messaging ?? {})
    .filter(
      ([platform, status]) =>
        platform !== "dashboard"
        && status.configured
        && status.ownerConfigured,
    )
    .map(([platform]) => platform);

  const selected = config?.defaultNotificationPlatforms ?? [];

  const [draft, setDraft] = useState<string[]>(selected);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedKey = selected.join(",");
  useEffect(() => {
    setDraft(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable serialized key
  }, [selectedKey]);

  if (!config || !health) return null;

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

  const handleSave = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.patch<ConfigUpdateResponse>("/config", {
        defaultNotificationPlatforms: draft,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["config"] }),
        queryClient.invalidateQueries({ queryKey: ["health"] }),
      ]);
      if (res.requiresRestart.length > 0) {
        setNotice(`Updated. Restart daemon for: ${res.requiresRestart.join(", ")}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Default Reminder Destinations</CardTitle>
      </CardHeader>
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
          Every selected destination receives the same reminder. Replies still go
          back to the app where the conversation happened, and you can override
          the destination for a single request without changing this default.
        </p>
        {notice && <p className="text-xs text-warning">{notice}</p>}
        <Button
          size="sm"
          variant="outline"
          disabled={!hasChanges || saving}
          onClick={handleSave}
        >
          {saving ? "Saving..." : "Save Reminder Destinations"}
        </Button>
      </div>
    </Card>
  );
}

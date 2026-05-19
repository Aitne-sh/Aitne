"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock } from "lucide-react";
import type { EditableConfigKey } from "@aitne/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SaveFieldFn } from "@/lib/hooks/use-save-config";

const PRESETS = [
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "12h", minutes: 720 },
  { label: "24h", minutes: 1440 },
] as const;

const MIN_MINUTES = 1;

export function PollCadenceControl({
  label,
  value,
  configKey,
  onSave,
  caption,
}: {
  label: string;
  value: number;
  configKey: EditableConfigKey;
  onSave: SaveFieldFn;
  caption: string;
}) {
  const valueMinutes = Math.max(MIN_MINUTES, Math.round(value / 60));
  const presetMatch = PRESETS.find((preset) => preset.minutes === valueMinutes);

  const [pendingPreset, setPendingPreset] = useState<number | null>(
    presetMatch?.minutes ?? null,
  );
  const [customDraft, setCustomDraft] = useState("");
  const [customMode, setCustomMode] = useState(!presetMatch);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const nextMinutes = Math.max(MIN_MINUTES, Math.round(value / 60));
    const nextMatch = PRESETS.find((preset) => preset.minutes === nextMinutes);
    if (nextMatch) {
      setPendingPreset(nextMatch.minutes);
      setCustomMode(false);
      setCustomDraft("");
    } else {
      setCustomMode(true);
      setPendingPreset(null);
    }
  }, [value]);

  const selectValue = useMemo(() => {
    if (customMode) return "custom";
    return pendingPreset !== null ? String(pendingPreset) : "custom";
  }, [customMode, pendingPreset]);

  const dirty = useMemo(() => {
    if (customMode) {
      const draftNumber = Number(customDraft);
      if (!customDraft.trim() || !Number.isFinite(draftNumber)) return false;
      return draftNumber !== valueMinutes;
    }
    if (pendingPreset === null) return false;
    return pendingPreset !== valueMinutes;
  }, [customMode, customDraft, pendingPreset, valueMinutes]);

  const saveMinutes = async (minutes: number) => {
    const normalized = Math.floor(minutes);
    if (!Number.isFinite(normalized) || normalized < MIN_MINUTES) {
      setError(`Cadence must be at least ${MIN_MINUTES} minute.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(configKey, normalized * 60);
    } finally {
      setSaving(false);
    }
  };

  const onSaveClick = () => {
    if (customMode) {
      const draftNumber = Number(customDraft);
      if (!customDraft.trim() || !Number.isFinite(draftNumber)) {
        setError("Enter a value in minutes.");
        return;
      }
      void saveMinutes(draftNumber);
    } else if (pendingPreset !== null) {
      void saveMinutes(pendingPreset);
    }
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Clock className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectValue}
          disabled={saving}
          className="h-8 rounded border bg-background px-2 text-xs"
          onChange={(event) => {
            const next = event.target.value;
            setError(null);
            if (next === "custom") {
              setCustomMode(true);
              setPendingPreset(null);
              setCustomDraft("");
              return;
            }
            setCustomMode(false);
            setPendingPreset(Number(next));
          }}
        >
          {PRESETS.map((preset) => (
            <option key={preset.minutes} value={preset.minutes}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
        {customMode && (
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={MIN_MINUTES}
              step={1}
              value={customDraft}
              disabled={saving}
              placeholder="minutes"
              className="h-8 w-24 text-xs"
              onChange={(event) => {
                setCustomDraft(event.target.value);
                setError(null);
              }}
            />
            <span className="text-xs text-muted-foreground">min</span>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={saving || !dirty}
          onClick={onSaveClick}
        >
          Save
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {caption} Custom values are in minutes (minimum {MIN_MINUTES}). Saved
        changes take effect after the daemon restarts.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

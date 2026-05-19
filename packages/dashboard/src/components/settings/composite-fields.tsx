"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DirectoryPickerField } from "@/components/directory-picker-field";
import type { HealthResponse } from "@/lib/api-types";
import type { SaveFieldFn } from "@/lib/hooks/use-save-config";

function basenameFromPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? "";
}

export function PrimaryPlatformField({
  health,
  value,
  defaultValue,
  modified,
  onSave,
}: {
  health: HealthResponse | undefined;
  value: string;
  defaultValue?: string;
  modified?: boolean;
  onSave: SaveFieldFn;
}) {
  const available = Object.entries(health?.messaging ?? {})
    .filter(
      ([platform, status]) =>
        platform !== "dashboard" &&
        status.configured &&
        status.ownerConfigured,
    )
    .map(([platform]) => platform);

  const [draft, setDraft] = useState<string>(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const hasChanges = draft !== value;
  const currentUnavailable = value && !available.includes(value);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave("primaryPlatform", draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 py-2 border-b">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">
          Fallback Primary Platform
          {modified && (
            <span className="ml-2 text-xs text-amber-600">(unsaved)</span>
          )}
        </label>
        {defaultValue !== undefined && (
          <span className="text-xs text-muted-foreground">
            default: {defaultValue || "(empty)"}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {available.map((platform) => (
          <Button
            key={platform}
            variant={draft === platform ? "default" : "outline"}
            size="sm"
            disabled={saving}
            onClick={() => setDraft(platform)}
            className="capitalize"
          >
            {platform}
          </Button>
        ))}
        {currentUnavailable && (
          <Button
            variant={draft === value ? "default" : "outline"}
            size="sm"
            disabled={saving}
            onClick={() => setDraft(value)}
            className="capitalize opacity-60"
            title="Current value — not currently configured with an owner ID"
          >
            {value} (not configured)
          </Button>
        )}
        {available.length === 0 && !currentUnavailable && (
          <span className="text-xs text-muted-foreground">
            Configure a messaging app with an owner ID first.
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Last-resort destination used when no default reminder destination is
        selected and no per-request override is supplied. Only messaging
        apps with a configured owner ID appear here.
      </p>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasChanges || saving}
          onClick={handleSave}
        >
          {saving ? "Applying..." : "Apply"}
        </Button>
      </div>
    </div>
  );
}

export function ExternalObsidianVaultSettings({
  vaultPath,
  vaultName,
  onSave,
}: {
  vaultPath: string;
  vaultName: string;
  onSave: (updates: Record<string, string | null>) => Promise<void>;
}) {
  const [path, setPath] = useState(vaultPath);
  const [name, setName] = useState(vaultName);
  const [saving, setSaving] = useState<"save" | "clear" | null>(null);

  useEffect(() => {
    setPath(vaultPath);
  }, [vaultPath]);
  useEffect(() => {
    setName(vaultName);
  }, [vaultName]);

  const handleSave = async () => {
    setSaving("save");
    try {
      const trimmedPath = path.trim();
      const trimmedName =
        name.trim() || basenameFromPath(trimmedPath);
      await onSave({
        externalObsidianVaultPath: trimmedPath,
        externalObsidianVaultName: trimmedName,
      });
    } finally {
      setSaving(null);
    }
  };

  const configured = !!(vaultPath || vaultName);

  const handleClear = async () => {
    setSaving("clear");
    try {
      await onSave({
        externalObsidianVaultPath: null,
        externalObsidianVaultName: null,
      });
      setPath("");
      setName("");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground shrink-0 min-w-[80px]">
            Path
          </label>
          <DirectoryPickerField
            value={path}
            onChange={setPath}
            title="Choose external Obsidian vault directory"
            placeholder="Choose an external Obsidian vault folder"
            defaultPath={vaultPath || undefined}
            inputClassName="max-w-[480px]"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground shrink-0 min-w-[80px]">
            Vault Name
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="MyVault"
            className="max-w-[240px]"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Use Choose to pick a local folder. Absolute local paths still work,
          including cloud-synced locations
          such as iCloud Drive, Dropbox, OneDrive, or Google Drive. Use
          Clear to remove the integration; both fields are nulled together
          to avoid the &ldquo;path set without a name&rdquo; error state.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving !== null}>
          {saving === "save" ? "Saving..." : "Save External Vault Settings"}
        </Button>
        {configured && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleClear}
            disabled={saving !== null}
          >
            {saving === "clear" ? "Clearing..." : "Clear"}
          </Button>
        )}
      </div>

      {configured && (
        <div className="text-xs text-muted-foreground space-y-0.5 pt-1">
          <p>
            Current path:{" "}
            <code className="text-foreground">{vaultPath || "(not set)"}</code>
          </p>
          <p>
            Current vault name:{" "}
            <code className="text-foreground">{vaultName || "(not set)"}</code>
          </p>
        </div>
      )}
    </div>
  );
}

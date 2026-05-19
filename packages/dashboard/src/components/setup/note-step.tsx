"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FolderSymlink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DirectoryPickerField } from "@/components/directory-picker-field";
import { IntegrationCard } from "@/components/connections/integration-card";
import { api, ApiError } from "@/lib/api-client";
import { useConfig } from "@/lib/hooks/use-config";
import {
  DEFAULT_NOTE_STEP_FIELDS,
  buildNotePatchBody,
  canContinue,
  notePathIssueMessage,
  validateExternalVaultPathClient,
  type NotePathIssue,
} from "./note-step.logic";
import { WizardStepFrame } from "./wizard-step-frame";

/**
 * SETUP-FLOW-REDESIGN-PLAN §5.6 — Note step.
 *
 * Two sections side-by-side: Notion (existing IntegrationCard) and the
 * user's external Obsidian vault (new — `externalObsidianVaultPath` +
 * `externalObsidianWatch`). The Note Sources section in
 * `<dataDir>/integrations.md` re-renders as soon as the daemon's
 * `applyConfigUpdates` hook fires (see SETUP-FLOW-REDESIGN-PLAN §6.2).
 */

interface NoteStepProps {
  onNext: () => void;
  onBack?: () => void;
}

export function NoteStep({ onNext, onBack }: NoteStepProps) {
  const { data: config } = useConfig();
  const queryClient = useQueryClient();
  const [path, setPath] = useState<string>(
    DEFAULT_NOTE_STEP_FIELDS.externalObsidianVaultPath,
  );
  const [watch, setWatch] = useState<boolean>(
    DEFAULT_NOTE_STEP_FIELDS.externalObsidianWatch,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  // Hydrate once from server state. The daemon serialises
  // `externalObsidianWatch` as boolean (default true); a `null` /
  // missing value resolves to `true` so existing installs keep
  // watching by default.
  useEffect(() => {
    if (hydratedRef.current || !config) return;
    hydratedRef.current = true;
    if (
      typeof config.externalObsidianVaultPath === "string"
      && config.externalObsidianVaultPath.length > 0
    ) {
      setPath(config.externalObsidianVaultPath);
    }
    if (typeof config.externalObsidianWatch === "boolean") {
      setWatch(config.externalObsidianWatch);
    }
  }, [config]);

  const pathIssue: NotePathIssue | null = path.trim().length === 0
    ? null
    : validateExternalVaultPathClient({
        path,
        dataDir: config?.contextDir ?? "",
        primaryVaultPath: config?.primaryVaultPath ?? null,
      });

  const ready = canContinue({ pathIssue, saving });

  const handleSave = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(
        "/config",
        buildNotePatchBody({
          externalObsidianVaultPath: path,
          externalObsidianWatch: watch,
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      onNext();
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { message?: string } | null;
        setError(body?.message ?? err.message ?? "Failed to save Note settings");
      } else {
        setError(err instanceof Error ? err.message : "Failed to save Note settings");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <WizardStepFrame
      title="Notes"
      description="Where do you keep your own notes? Skip if neither applies."
      onNext={onNext}
      hideNav
    >
      <div className="w-full max-w-2xl mx-auto space-y-6">
        {/* Notion card — registry-driven; mode toggle + direct API key body. */}
        <IntegrationCard integrationKey="notion" />

        <div className="rounded-xl border border-border bg-card p-5 text-left space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Obsidian (your personal vault)
            </h3>
            <p className="text-xs text-muted-foreground">
              Separate from the agent&rsquo;s vault — point at the Obsidian
              vault where you keep your own notes. The agent reads from it
              and appends through its Obsidian skill.
            </p>
          </div>

          <DirectoryPickerField
            id="external-obsidian-vault-path"
            value={path}
            onChange={setPath}
            title="Choose your personal Obsidian vault"
            placeholder="Skip if you don't use Obsidian"
            disabled={saving}
          />
          {pathIssue && pathIssue !== "empty" && (
            <p className="text-xs text-destructive">
              {notePathIssueMessage(pathIssue)}
            </p>
          )}

          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={watch}
              onChange={(e) => setWatch(e.currentTarget.checked)}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            Watch this vault for changes
          </label>
          <p className="text-[11px] text-muted-foreground">
            Off keeps the vault readable through the Obsidian skill but
            stops the file-change observer — useful for very large vaults
            that emit noisy events.
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400 text-center">
            {error}
          </p>
        )}
      </div>

      <div className="flex justify-center gap-3 pt-4">
        {onBack && (
          <Button variant="ghost" onClick={onBack} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        )}
        <Button variant="ghost" onClick={onNext}>
          Skip
        </Button>
        <Button
          size="lg"
          onClick={handleSave}
          disabled={!ready}
          className="gap-2"
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <FolderSymlink className="h-4 w-4" />
              Continue
            </>
          )}
        </Button>
      </div>
    </WizardStepFrame>
  );
}

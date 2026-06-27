"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { useConfig, useConfigDefaults } from "@/lib/hooks/use-config";
import { useDirtyFields, useDiscardGeneration } from "@/lib/hooks/use-dirty-fields";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  ConfigSection,
  EditableField,
} from "@/components/settings/editors";
import { ManagementModeSection } from "@/components/settings/management-mode-section";
import { VaultHealthCard } from "@/components/connections/vault-health-card";
import {
  CHARACTER_MAX_LENGTH,
  CharacterEditor,
  isCharacterOverCap,
} from "@/components/settings/character-editor";
import { cn } from "@/lib/utils";
import type { SaveFieldFn } from "@/lib/hooks/use-save-config";

function CharacterSection({
  value,
  onSave,
}: {
  value: string;
  onSave: (key: "character", value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  // Close editing mode when the user clicks Discard in the save bar.
  const discardGen = useDiscardGeneration();
  const prevDiscardGen = useRef(discardGen);
  useEffect(() => {
    if (discardGen !== prevDiscardGen.current) {
      prevDiscardGen.current = discardGen;
      setEditing(false);
    }
  }, [discardGen]);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const overCap = isCharacterOverCap(draft);

  const handleDone = useCallback(async () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave("character", draft);
      setEditing(false);
    } catch {
      // parent handles
    } finally {
      setSaving(false);
    }
  }, [draft, value, onSave]);

  if (!editing) {
    return (
      <div className="space-y-2">
        {value ? (
          <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-xs text-foreground min-h-[60px]">
            {value}
          </pre>
        ) : (
          <p className="text-xs italic text-muted-foreground">
            (no character set — default behavior)
          </p>
        )}
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5 mr-1" />
          Edit
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <CharacterEditor value={draft} onChange={setDraft} disabled={saving} />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={handleDone}
          disabled={saving || overCap}
        >
          {saving ? "Applying..." : "Done"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(value);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

const LANGUAGE_OPTIONS: Array<{ tag: string; label: string }> = [
  { tag: "en", label: "English" },
  { tag: "ja", label: "Japanese" },
  { tag: "zh", label: "Chinese" },
  { tag: "es", label: "Español (Spanish)" },
  { tag: "fr", label: "Français (French)" },
  { tag: "de", label: "Deutsch (German)" },
  { tag: "pt", label: "Português (Portuguese)" },
  { tag: "ko", label: "한국어 (Korean)" },
  { tag: "__custom__", label: "Other (BCP-47 tag…)" },
];

const LANGUAGE_TAG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

function PrimaryLanguageEditor({
  value,
  modified,
  onSave,
}: {
  value: string;
  modified: boolean;
  onSave: SaveFieldFn;
}) {
  const isKnown = LANGUAGE_OPTIONS.some(
    (opt) => opt.tag === value && opt.tag !== "__custom__",
  );
  // `modeOverride` is non-null only when the user has clicked the Select away
  // from the value that would otherwise be inferred from `value`. Otherwise
  // the mode is derived from `value` on every render, which avoids the
  // set-state-in-effect anti-pattern and keeps the UI consistent when the
  // server value changes under us.
  const [modeOverride, setModeOverride] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState<string | null>(null);

  const derivedMode = isKnown ? value : "__custom__";
  const mode = modeOverride ?? derivedMode;
  const customTag = customDraft ?? (isKnown ? "" : value);

  const handleModeChange = (next: string) => {
    setModeOverride(next === derivedMode ? null : next);
    if (next === "__custom__") {
      setCustomDraft(isKnown ? "" : value);
    } else {
      setCustomDraft(null);
      if (next !== value) {
        void onSave("primaryLanguage", next);
      }
    }
  };

  const handleCustomBlur = () => {
    const trimmed = customTag.trim();
    if (trimmed && trimmed !== value && LANGUAGE_TAG_RE.test(trimmed)) {
      void onSave("primaryLanguage", trimmed);
      setModeOverride(null);
      setCustomDraft(null);
    }
  };

  const customInvalid =
    mode === "__custom__"
    && customTag.trim().length > 0
    && !LANGUAGE_TAG_RE.test(customTag.trim());

  return (
    <div
      className={cn(
        "py-1.5",
        modified && "border-l-2 border-primary pl-2 -ml-1 rounded",
      )}
      data-config-key="primaryLanguage"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground inline-flex items-center gap-1.5">
            Primary Language
            {modified && (
              <span className="text-[10px] font-medium text-primary">
                modified
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Used for user-facing prose: profile, daily journal, and
            weekly/monthly reviews. System files (agent journal, dossiers,
            context index) always stay in English.
          </p>
        </div>
        <Select value={mode} onValueChange={handleModeChange}>
          <SelectTrigger className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_OPTIONS.map((lang) => (
              <SelectItem key={lang.tag} value={lang.tag}>
                {lang.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {mode === "__custom__" && (
        <div className="flex flex-col gap-1 pt-2">
          <Input
            value={customTag}
            onChange={(e) => setCustomDraft(e.target.value)}
            onBlur={handleCustomBlur}
            placeholder="e.g. zh-Hans or pt-BR"
            className="max-w-[240px]"
          />
          {customInvalid && (
            <p className="text-xs text-destructive">
              Use a BCP-47 tag like <code>en-US</code> or <code>zh-Hans</code>.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Blur the field to save.
          </p>
        </div>
      )}
    </div>
  );
}

export default function ProfileSettingsPage() {
  const { data: config } = useConfig();
  const { df } = useConfigDefaults();
  const { deferSaveFor, dv, dirtyFields } = useDirtyFields();

  if (!config) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  const deferSave = deferSaveFor(config);

  return (
    <>
      <PageHeader
        title="Profile"
        description="Your agent’s identity and personality, plus the storage location for its personal data."
      />

      <ConfigSection title="Agent Identity">
        <EditableField
          label="Display Name"
          value={dv("agentDisplayName", config.agentDisplayName)}
          configKey="agentDisplayName"
          modified={dirtyFields.has("agentDisplayName")}
          defaultValue={df("agentDisplayName")}
          description="The name your agent signs off with. Shown in the dashboard header and prefixed to WhatsApp replies as `[name]` so you can tell its messages apart from human contacts."
          onSave={deferSave}
        />
      </ConfigSection>

      <ConfigSection title="Personality">
        <p className="pb-2 text-xs text-muted-foreground">
          How the agent should talk to you. Safety rules still take precedence.
          Capped at {CHARACTER_MAX_LENGTH} characters; leave empty for default
          behavior.
        </p>
        <CharacterSection
          value={dv("character", config.character) as string}
          onSave={deferSave}
        />
      </ConfigSection>

      <ConfigSection title="Language">
        <p className="pb-2 text-xs text-muted-foreground">
          Changes take effect the next time the agent writes a user-facing
          file. Existing files are not rewritten.
        </p>
        <PrimaryLanguageEditor
          value={dv("primaryLanguage", config.primaryLanguage) as string}
          modified={dirtyFields.has("primaryLanguage")}
          onSave={deferSave}
        />
      </ConfigSection>

      <ManagementModeSection />

      {/* Primary-vault health lives next to the control that relocates the
          vault (Notes IA rename 2026-06 — it used to sit on the
          Connections → Knowledge page, away from the migration dialog). */}
      <section id="vault-health" className="scroll-mt-4">
        <VaultHealthCard />
      </section>
    </>
  );
}

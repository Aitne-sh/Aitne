"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api-client";
import { useConfig } from "@/lib/hooks/use-config";
import { useQueryClient } from "@tanstack/react-query";
import {
  AGENT_DISPLAY_NAME_MAX_LENGTH,
  SUPPORTED_LANGUAGES,
  buildBasicsPatchBody,
  canContinue,
  hydrateLanguageSelection,
  isCustomLanguageInvalid,
  resolveLanguage,
} from "./basics-step.logic";
import { WizardStepFrame } from "./wizard-step-frame";

/**
 * SETUP-FLOW-REDESIGN-PLAN §5.1 — Basics step.
 *
 * Replaces Welcome + the language portion of the legacy Vault step.
 * Two atomic fields persisted on Continue via `PATCH /api/config`:
 *   - `agentDisplayName`
 *   - `primaryLanguage`
 */

interface BasicsStepProps {
  agentDisplayName: string;
  onAgentDisplayNameChange: (value: string) => void;
  onNext: () => void;
}

export function BasicsStep({
  agentDisplayName,
  onAgentDisplayNameChange,
  onNext,
}: BasicsStepProps) {
  const { data: config } = useConfig();
  const queryClient = useQueryClient();
  const [primaryLanguage, setPrimaryLanguage] = useState("en");
  const [customLanguage, setCustomLanguage] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  // Hydrate once from server state so back-nav restores the user's prior
  // pick. Subsequent config refetches (SSE) must not overwrite an edit
  // in progress — same pattern the legacy vault-step uses.
  useEffect(() => {
    if (hydratedRef.current || !config) return;
    hydratedRef.current = true;
    const hydrated = hydrateLanguageSelection(config.primaryLanguage);
    setPrimaryLanguage(hydrated.primary);
    setCustomLanguage(hydrated.custom);
    if (
      typeof config.agentDisplayName === "string"
      && config.agentDisplayName.length > 0
      && agentDisplayName.length === 0
    ) {
      onAgentDisplayNameChange(config.agentDisplayName);
    }
  }, [config, agentDisplayName, onAgentDisplayNameChange]);

  const resolvedLanguage = resolveLanguage(primaryLanguage, customLanguage);
  const customInvalid = isCustomLanguageInvalid(primaryLanguage, customLanguage);
  const ready = canContinue({ agentDisplayName, resolvedLanguage, saving });

  const handleContinue = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(
        "/config",
        buildBasicsPatchBody({ agentDisplayName, resolvedLanguage }),
      );
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      onNext();
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { message?: string } | null;
        setError(body?.message ?? err.message ?? "Failed to save basics");
      } else {
        setError(err instanceof Error ? err.message : "Failed to save basics");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <WizardStepFrame
      title="Basics"
      description="Pick what to call your agent and the language it should write in."
      onNext={onNext}
      hideNav
    >
      <div className="w-full max-w-sm mx-auto space-y-6 rounded-xl border border-border bg-card p-5 text-left">
        <div className="space-y-2">
          <label
            htmlFor="agent-name"
            className="text-sm font-medium text-foreground"
          >
            Agent name
          </label>
          <p className="text-xs text-muted-foreground">
            Used in the dashboard and chat. WhatsApp also prepends it as a
            label on every outbound message.
          </p>
          <Input
            id="agent-name"
            value={agentDisplayName}
            onChange={(e) => onAgentDisplayNameChange(e.target.value)}
            placeholder="Aitne"
            maxLength={AGENT_DISPLAY_NAME_MAX_LENGTH}
          />
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <label className="text-sm font-medium text-foreground">
            Primary language
          </label>
          <p className="text-xs text-muted-foreground">
            Used for prose the agent writes — knowledge files, DM replies,
            notes in Obsidian and Notion. Code, file paths, and template
            headers stay in English.
          </p>
          <Select value={primaryLanguage} onValueChange={setPrimaryLanguage}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LANGUAGES.map((lang) => (
                <SelectItem key={lang.tag} value={lang.tag}>
                  {lang.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {primaryLanguage === "__custom__" && (
            <Input
              value={customLanguage}
              onChange={(e) => setCustomLanguage(e.target.value)}
              placeholder="e.g. zh-Hans"
              className="mt-2"
            />
          )}
          {customInvalid && (
            <p className="text-xs text-destructive">
              Use a BCP-47 tag like <code>en-US</code> or <code>zh-Hans</code>.
            </p>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 text-center">
          {error}
        </p>
      )}

      <div className="flex justify-center gap-3 pt-4">
        <Button
          size="lg"
          onClick={handleContinue}
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
              Continue
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </WizardStepFrame>
  );
}

// Re-export for callers that still want the import surface.
export { ArrowLeft };

"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { validateUserAgentEdit } from "@/lib/agents/yaml-edit";
import {
  AGENT_TIER_OPTIONS,
  BUILTIN_OVERRIDE_FIELDS,
  buildBuiltinPatchBody,
  buildOverrideResetBody,
  extractOverrideValues,
  overriddenFieldKeys,
  validateOverrideValues,
  type OverrideFieldKey,
  type OverrideValues,
} from "@/lib/agents/builtin-override";
import { usePatchAgent, useSaveUserAgent } from "@/lib/hooks/use-agents";
import type { AgentDetailResponse, AgentDefinition } from "@/lib/agents/types";

/**
 * Agent editors (AGENT_DEFINITIONS_DESIGN.md §10.4).
 *
 * - User Agents: a YAML `agent.md` editor with live `agentDefinitionSchema`
 *   validation (the same schema the loader runs); Save is disabled until the
 *   document parses + validates. Save writes through the context-vault PUT
 *   chokepoint — the only legal definition write path.
 * - Built-in Agents: the YAML is read-only; only the override allow-list
 *   (tier / model / limits / on_error.notify_owner) is editable as a restricted
 *   form that emits a JSON-diff `PATCH /api/agents/:slug`.
 *
 * All parse / diff / validation logic lives in `@/lib/agents/*` (unit-tested);
 * these components are the form glue + mutation wiring.
 */

const EDITOR_TEXTAREA_CLASS =
  "min-h-[420px] w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring";

// ── User-Agent YAML editor ──────────────────────────────────────────────────

export interface UserAgentYamlEditorProps {
  initialContent: string;
  saving: boolean;
  saveError?: string | null;
  /** Called with the full document when Save is pressed (only when valid). */
  onSave: (content: string) => void;
  onCancel?: () => void;
  /** Optional note shown above the editor (e.g. the on-disk path). */
  footer?: React.ReactNode;
  /** Allow saving an unchanged document (e.g. the "+ New Agent" scaffold). */
  allowUnchanged?: boolean;
  /**
   * Existing slug for the edit case — enforces slug immutability (§3.3): a
   * changed slug would write to the old directory and the loader would reject
   * the mismatch. Omit for the create scaffold (slug is freely chosen there).
   */
  canonicalSlug?: string;
}

export function UserAgentYamlEditor({
  initialContent,
  saving,
  saveError,
  onSave,
  onCancel,
  footer,
  allowUnchanged = false,
  canonicalSlug,
}: UserAgentYamlEditorProps) {
  const [draft, setDraft] = useState(initialContent);
  const validation = useMemo(
    () => validateUserAgentEdit(draft, canonicalSlug),
    [draft, canonicalSlug],
  );
  const dirty = draft !== initialContent;
  const canSave = validation.ok && (dirty || allowUnchanged) && !saving;

  return (
    <div className="space-y-3">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        aria-label="Agent definition YAML"
        className={cn(EDITOR_TEXTAREA_CLASS, !validation.ok && "border-red-400/60")}
      />

      {!validation.ok && (
        <Alert variant="error">
          <p className="font-medium">Definition is not valid</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {validation.issues.map((issue, i) => (
              <li key={`${issue.path}-${i}`}>
                {issue.path ? <code className="font-mono">{issue.path}</code> : null}
                {issue.path ? ": " : null}
                {issue.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {validation.ok && dirty && (
        <Alert variant="success">Definition is valid — ready to save.</Alert>
      )}

      {saveError && <Alert variant="error">{saveError}</Alert>}

      {footer}

      <div className="flex items-center gap-2">
        <Button onClick={() => onSave(draft)} disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Built-in restricted override form ───────────────────────────────────────

function fieldDisplay(value: OverrideValues[OverrideFieldKey]): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isNaN(value) ? "" : String(value);
  return String(value);
}

export interface BuiltinOverrideFormProps {
  detail: AgentDetailResponse;
  definition: AgentDefinition;
  onSaved?: () => void;
}

export function BuiltinOverrideForm({ detail, definition, onSaved }: BuiltinOverrideFormProps) {
  const original = useMemo(() => extractOverrideValues(definition), [definition]);
  const [values, setValues] = useState<OverrideValues>(original);
  const patch = usePatchAgent();

  const overridden = useMemo(
    () => new Set(overriddenFieldKeys(detail.row.override_snapshot)),
    [detail.row.override_snapshot],
  );
  const errors = useMemo(() => validateOverrideValues(values), [values]);
  const { body, changedKeys } = useMemo(
    () => buildBuiltinPatchBody(original, values),
    [original, values],
  );
  const hasErrors = Object.keys(errors).length > 0;
  const canSave = changedKeys.length > 0 && !hasErrors && !patch.isPending;

  const setValue = (key: OverrideFieldKey, value: OverrideValues[OverrideFieldKey]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const save = () => {
    patch.mutate(
      { slug: detail.row.slug, body },
      { onSuccess: () => onSaved?.() },
    );
  };

  const resetField = (key: OverrideFieldKey) => {
    patch.mutate(
      { slug: detail.row.slug, body: buildOverrideResetBody([key]) },
      { onSuccess: () => onSaved?.() },
    );
  };

  return (
    <div className="space-y-4">
      <Alert variant="info">
        System Agent definitions are read-only. You can record tier / model / limit overrides
        below, but in v1 built-in routing is governed by <code>process_backend_config</code> — set a
        built-in&apos;s tier and model under <strong>Settings → Models</strong>. Overrides saved here
        are stored on the Agent but do not yet change how it runs.
      </Alert>

      <div className="space-y-4">
        {BUILTIN_OVERRIDE_FIELDS.map((field) => {
          const value = values[field.key];
          const err = errors[field.key];
          return (
            <div key={field.key} className="space-y-1">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium" htmlFor={`field-${field.key}`}>
                  {field.label}
                </label>
                {overridden.has(field.key) && (
                  <Badge variant="purple" className="text-[10px]">overridden</Badge>
                )}
                {overridden.has(field.key) && (
                  <button
                    type="button"
                    onClick={() => resetField(field.key)}
                    disabled={patch.isPending}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    Reset to default
                  </button>
                )}
              </div>

              {field.kind === "tier" && (
                <select
                  id={`field-${field.key}`}
                  value={value === null ? "" : String(value)}
                  onChange={(e) => setValue(field.key, e.target.value === "" ? null : e.target.value)}
                  className="h-8 w-48 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">(default)</option>
                  {AGENT_TIER_OPTIONS.map((tier) => (
                    <option key={tier} value={tier}>{tier}</option>
                  ))}
                </select>
              )}

              {field.kind === "model" && (
                <input
                  id={`field-${field.key}`}
                  type="text"
                  value={fieldDisplay(value)}
                  placeholder="(tier default)"
                  onChange={(e) =>
                    setValue(field.key, e.target.value.trim() === "" ? null : e.target.value)
                  }
                  className="h-8 w-72 rounded-md border border-border bg-background px-2 font-mono text-sm"
                />
              )}

              {(field.kind === "int" || field.kind === "number") && (
                <input
                  id={`field-${field.key}`}
                  type="number"
                  step={field.kind === "number" ? "0.01" : "1"}
                  value={fieldDisplay(value)}
                  onChange={(e) => {
                    const n = e.target.valueAsNumber;
                    setValue(field.key, n);
                  }}
                  className="h-8 w-40 rounded-md border border-border bg-background px-2 text-sm"
                />
              )}

              {field.kind === "boolean" && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    id={`field-${field.key}`}
                    type="checkbox"
                    checked={value === true}
                    onChange={(e) => setValue(field.key, e.target.checked)}
                  />
                  <span className="text-muted-foreground">{value === true ? "On" : "Off"}</span>
                </label>
              )}

              <p className="text-xs text-muted-foreground">{field.help}</p>
              {err && <p className="text-xs text-red-500">{err}</p>}
            </div>
          );
        })}
      </div>

      {patch.isError && (
        <Alert variant="error">{(patch.error as Error).message}</Alert>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={!canSave}>
          {patch.isPending ? "Saving…" : "Save overrides"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {changedKeys.length > 0 ? `${changedKeys.length} change(s) pending` : "No changes"}
        </span>
      </div>
    </div>
  );
}

// ── Definition-tab wrapper ───────────────────────────────────────────────────

export interface AgentEditorProps {
  detail: AgentDetailResponse;
  onClose?: () => void;
}

export function AgentEditor({ detail, onClose }: AgentEditorProps) {
  const save = useSaveUserAgent();

  if (detail.row.source === "builtin") {
    if (!detail.agent) {
      return (
        <Alert variant="error">
          This System Agent&apos;s definition failed to load, so it cannot be edited. Fix the
          shipped <code>agent.md</code> on disk.
        </Alert>
      );
    }
    return <BuiltinOverrideForm detail={detail} definition={detail.agent} onSaved={onClose} />;
  }

  // User Agent — full YAML editor through the context-vault write path.
  const initial = detail.definition_yaml ?? "";
  return (
    <UserAgentYamlEditor
      initialContent={initial}
      canonicalSlug={detail.row.slug}
      saving={save.isPending}
      saveError={save.isError ? (save.error as Error).message : null}
      onSave={(content) =>
        save.mutate(
          { slug: detail.row.slug, content },
          { onSuccess: () => onClose?.() },
        )
      }
      onCancel={onClose}
      footer={
        <p className="text-xs text-muted-foreground">
          Saved to <code className="font-mono">{detail.definition_path}</code> via the context-vault
          write path. The daemon reloads and refreshes this page automatically.
        </p>
      }
    />
  );
}

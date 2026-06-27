"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { RESTART_REQUIRED_KEY_TUPLE } from "@aitne/shared";
import type { EditableConfigKey } from "@aitne/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RestartRequiredBadge } from "@/components/settings/restart-required-badge";
import { DocsHelpInline } from "@/components/docs/docs-help-inline";
import { pickDirectoryFromDesktop } from "@/lib/directory-picker";
import { useDiscardGeneration } from "@/lib/hooks/use-dirty-fields";
import type { SaveFieldFn } from "@/lib/hooks/use-save-config";

const RESTART_SET = new Set<string>(RESTART_REQUIRED_KEY_TUPLE);

type ScalarValue = string | number | null;

function scalarToDraft(value: ScalarValue): string {
  return value === null ? "" : String(value);
}

export function EditableField({
  label,
  value,
  configKey,
  type = "text",
  suffix,
  description,
  min,
  max,
  nullable = false,
  emptyLabel = "Not set",
  modified,
  defaultValue,
  onSave,
}: {
  label: string;
  value: ScalarValue;
  configKey: EditableConfigKey;
  type?: "text" | "number";
  suffix?: string;
  description?: string;
  min?: number;
  max?: number;
  nullable?: boolean;
  emptyLabel?: string;
  /** True when the displayed value differs from the server value. */
  modified?: boolean;
  /** Schema default — when provided and value differs, a "reset" link is shown. */
  defaultValue?: ScalarValue;
  onSave: SaveFieldFn;
}) {
  const showRestart = RESTART_SET.has(configKey);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(scalarToDraft(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close editing mode when the user clicks Discard in the save bar.
  const discardGen = useDiscardGeneration();
  const prevDiscardGen = useRef(discardGen);
  useEffect(() => {
    if (discardGen !== prevDiscardGen.current) {
      prevDiscardGen.current = discardGen;
      setEditing(false);
      setError(null);
    }
  }, [discardGen]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(scalarToDraft(value));
  }, [value, editing]);

  const isDefault = defaultValue !== undefined && value === defaultValue;

  const handleReset = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (defaultValue === undefined) return;
    setSaving(true);
    try {
      await onSave(configKey, defaultValue);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    try {
      await onSave(configKey, null);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    const trimmedDraft = draft.trim();
    const val: ScalarValue = nullable && trimmedDraft === ""
      ? null
      : type === "number"
        ? Number(draft)
        : draft;
    if (val === value) {
      setEditing(false);
      return;
    }
    if (val !== null && type === "number" && (min !== undefined || max !== undefined)) {
      const n = val as number;
      if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
        setError(`Must be ${min ?? ""}–${max ?? ""}`);
        return;
      }
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(configKey, val);
      setEditing(false);
    } catch {
      // parent handles
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setDraft(scalarToDraft(value));
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="py-1.5" data-config-key={configKey}>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground shrink-0 min-w-[140px] inline-flex items-center gap-1.5">
            {label}
            {showRestart && <RestartRequiredBadge />}
          </span>
          <Input
            ref={inputRef}
            type={type}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            className="max-w-[240px]"
            disabled={saving}
            min={min}
            max={max}
          />
          {suffix && (
            <span className="text-xs text-muted-foreground">{suffix}</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleSave}
            disabled={saving}
            className="h-7 w-7 p-0"
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(scalarToDraft(value));
              setError(null);
              setEditing(false);
            }}
            className="h-7 w-7 p-0"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {error && (
          <p className="text-xs text-destructive mt-1 ml-[148px]">{error}</p>
        )}
        {description && !error && (
          <p className="text-xs text-muted-foreground mt-1 ml-[148px]">
            {description}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className={`py-1.5 group cursor-pointer rounded px-1 -mx-1 hover:bg-muted/50 transition-colors${modified ? " border-l-2 border-primary pl-2" : ""}`}
      data-config-key={configKey}
      onClick={() => setEditing(true)}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground inline-flex items-center gap-1.5">
          {label}
          {showRestart && <RestartRequiredBadge />}
        </span>
        <div className="flex items-center gap-1.5">
          {modified && (
            <span className="text-[10px] font-medium text-primary">
              modified
            </span>
          )}
          {defaultValue !== undefined && !isDefault && !modified && (
            <button
              type="button"
              onClick={handleReset}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              reset
            </button>
          )}
          {nullable && value !== null && !modified && (
            <button
              type="button"
              onClick={handleClear}
              title={`Clear — sets ${label} to ${emptyLabel}`}
              className="text-[10px] text-muted-foreground hover:text-destructive transition-colors inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100"
            >
              <Trash2 className="h-2.5 w-2.5" />
              clear
            </button>
          )}
          <span className="text-sm font-medium text-foreground">
            {value === null
              ? emptyLabel
              : suffix === "$"
                ? `$${value}`
                : suffix
                  ? `${value} ${suffix}`
                  : String(value)}
          </span>
          <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      )}
    </div>
  );
}

export function EditableBooleanField({
  label,
  value,
  configKey,
  description,
  modified,
  defaultValue,
  onSave,
}: {
  label: string;
  value: boolean;
  configKey: EditableConfigKey;
  description?: string;
  /** True when the displayed value differs from the server value. */
  modified?: boolean;
  /** Schema default — when provided and value differs, a "reset" link is shown. */
  defaultValue?: boolean;
  onSave: SaveFieldFn;
}) {
  const [saving, setSaving] = useState(false);
  const showRestart = RESTART_SET.has(configKey);
  const isDefault = defaultValue !== undefined && value === defaultValue;

  const handleToggle = async () => {
    setSaving(true);
    try {
      await onSave(configKey, !value);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (defaultValue === undefined) return;
    setSaving(true);
    try {
      await onSave(configKey, defaultValue);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`py-1.5 group${modified ? " border-l-2 border-primary pl-2 -ml-1 rounded" : ""}`} data-config-key={configKey}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground inline-flex items-center gap-1.5">
            {label}
            {showRestart && <RestartRequiredBadge />}
            {modified && (
              <span className="text-[10px] font-medium text-primary">
                modified
              </span>
            )}
            {defaultValue !== undefined && !isDefault && !modified && (
              <button
                type="button"
                onClick={handleReset}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100"
              >
                <RotateCcw className="h-2.5 w-2.5" />
                reset
              </button>
            )}
          </p>
          {description && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {description}
            </p>
          )}
        </div>
        <Button
          variant={value ? "default" : "outline"}
          size="sm"
          onClick={handleToggle}
          disabled={saving}
        >
          {value ? "Enabled" : "Disabled"}
        </Button>
      </div>
    </div>
  );
}

export function EditableArrayField({
  label,
  values,
  configKey,
  variant = "gray",
  placeholder = "Add item...",
  directoryPicker,
  modified,
  onSave,
}: {
  label: string;
  values: string[];
  configKey: EditableConfigKey;
  variant?: "red" | "green" | "gray";
  placeholder?: string;
  directoryPicker?: {
    title: string;
    buttonLabel?: string;
    defaultPath?: string;
  };
  /** True when the displayed values differ from the server values. */
  modified?: boolean;
  onSave: SaveFieldFn;
}) {
  const showRestart = RESTART_SET.has(configKey);
  const [newItem, setNewItem] = useState("");
  const [saving, setSaving] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const handleAdd = async () => {
    const trimmed = newItem.trim();
    if (!trimmed || values.includes(trimmed)) return;
    setSaving(true);
    setPickerError(null);
    try {
      await onSave(configKey, [...values, trimmed]);
      setNewItem("");
    } catch {
      // parent handles
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (item: string) => {
    setSaving(true);
    try {
      await onSave(
        configKey,
        values.filter((v) => v !== item),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleAdd();
  };

  const handlePickDirectory = async () => {
    if (!directoryPicker) return;
    setSaving(true);
    setPickerError(null);
    try {
      const selected = await pickDirectoryFromDesktop({
        title: directoryPicker.title,
        defaultPath: newItem.trim() || directoryPicker.defaultPath,
      });
      if (!selected) return;
      if (values.includes(selected)) {
        setNewItem(selected);
        setPickerError("That directory is already in the list.");
        return;
      }
      await onSave(configKey, [...values, selected]);
      setNewItem("");
    } catch (err) {
      setPickerError(
        err instanceof Error ? err.message : "Folder picker is unavailable.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`py-2${modified ? " border-l-2 border-primary pl-2 -ml-1 rounded" : ""}`} data-config-key={configKey}>
      <p className="text-sm text-muted-foreground mb-2 inline-flex items-center gap-1.5">
        {label}
        {showRestart && <RestartRequiredBadge />}
        {modified && (
          <span className="text-[10px] font-medium text-primary">
            modified
          </span>
        )}
      </p>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {values.map((v) => (
          <Badge key={v} variant={variant} className="gap-1 pr-1">
            {v}
            <button
              onClick={() => handleRemove(v)}
              disabled={saving}
              className="ml-0.5 rounded-sm hover:bg-black/10 dark:hover:bg-white/10 p-0.5 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {values.length === 0 && (
          <span className="text-xs text-muted-foreground italic">No items</span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="max-w-[320px]"
          disabled={saving}
        />
        {directoryPicker && (
          <Button
            size="sm"
            variant="outline"
            onClick={handlePickDirectory}
            disabled={saving}
          >
            <FolderOpen className="h-3.5 w-3.5 mr-1" />
            {directoryPicker.buttonLabel ?? "Choose"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={!newItem.trim() || saving}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>
      {pickerError && (
        <p className="mt-1 text-xs text-destructive">{pickerError}</p>
      )}
    </div>
  );
}

export function ConfigSection({
  title,
  children,
  helpDocId,
  helpAnchor,
}: {
  title: string;
  children: React.ReactNode;
  /**
   * When set, render a small `?` icon next to the section title that
   * opens the docs help slide-over scoped to this doc. Used to give
   * deep-link affordances on confusing settings groups without dragging
   * an icon onto every individual field (DOCS_QA_DESIGN.md §8.4 E6).
   */
  helpDocId?: string;
  helpAnchor?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <span>{title}</span>
          {helpDocId && (
            <DocsHelpInline
              docId={helpDocId}
              anchor={helpAnchor ?? null}
              label={title}
            />
          )}
        </CardTitle>
      </CardHeader>
      <div className="space-y-0.5 [&>p]:max-w-prose">{children}</div>
    </Card>
  );
}

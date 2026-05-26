"use client";

import { useMemo, useState } from "react";
import { FileText, Plus, Power, PowerOff, Repeat, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api-client";
import type { ContextFileResponse } from "@/lib/api-types";
import {
  ContextConflictError,
  useContextFile,
  useContextList,
  useDeleteContextFile,
  useUpdateContextFile,
} from "@/lib/hooks/use-context";
import { useConfig } from "@/lib/hooks/use-config";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { previewCronSchedule } from "@/lib/cron-preview";

/**
 * Per-cadence routine rulebooks the agent reads at task-flow assembly
 * time. This page edits them in-place via `/api/context/`. Custom routines
 * (user-defined cron schedules) can be created and deleted here; the
 * daemon's `CustomRoutineScheduler` reloads automatically after each write
 * via `onCustomRoutinesChanged`.
 */

type BuiltInStem = "_index" | "hourly" | "morning" | "evening" | "weekly" | "monthly";

const BUILT_IN_ROUTINES: { stem: BuiltInStem; label: string; cadence: string }[] = [
  { stem: "_index", label: "Overview", cadence: "navigation" },
  { stem: "hourly", label: "Hourly", cadence: "every hour" },
  { stem: "morning", label: "Morning", cadence: "04:00 daily" },
  { stem: "evening", label: "Evening", cadence: "18:00 daily" },
  { stem: "weekly", label: "Weekly", cadence: "Fri 18:00" },
  { stem: "monthly", label: "Monthly", cadence: "month end" },
];

const BUILT_IN_LABELS = new Map(BUILT_IN_ROUTINES.map((entry) => [entry.stem, entry]));

type Selection =
  | { kind: "builtin"; stem: string }
  | { kind: "custom"; slug: string };

function builtInPath(stem: string): string {
  return `routines/${stem}`;
}

function customPath(slug: string): string {
  return `policies/routines/custom/${slug}`;
}

function selectionPath(sel: Selection): string {
  return sel.kind === "builtin" ? builtInPath(sel.stem) : customPath(sel.slug);
}

function stripMdExtension(name: string): string {
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function readFrontmatterScalar(content: string, field: string): string | null {
  const openMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!openMatch) return null;
  const re = new RegExp(`^${field}\\s*:\\s*(.+?)\\s*$`, "m");
  const match = openMatch[1].match(re);
  if (!match) return null;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * Replace the value of an existing frontmatter scalar, or insert a new key
 * before the closing `---`. The written value is emitted unquoted — safe for
 * the fields we target here (`enabled: true|false`). Returns the original
 * content unchanged when no frontmatter block is present.
 */
function setFrontmatterScalar(
  content: string,
  field: string,
  value: string,
): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return content;
  const block = fmMatch[1];
  const keyRe = new RegExp(`^(${field})\\s*:\\s*.+?\\s*$`, "m");
  if (keyRe.test(block)) {
    const replaced = block.replace(keyRe, `${field}: ${value}`);
    return content.replace(fmMatch[0], `---\n${replaced}\n---`);
  }
  const withKey = `${block}\n${field}: ${value}`;
  return content.replace(fmMatch[0], `---\n${withKey}\n---`);
}

function formatPreviewRun(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function CronPreviewCard({
  cronExpression,
  timeZone,
  title = "Next runs",
}: {
  cronExpression: string | null;
  timeZone: string;
  title?: string;
}) {
  const preview = useMemo(() => {
    if (!cronExpression || cronExpression.trim().length === 0) {
      return { ok: false as const, error: "Add a `cron:` frontmatter field to preview the schedule." };
    }
    return previewCronSchedule(cronExpression, timeZone, { count: 3 });
  }, [cronExpression, timeZone]);

  return (
    <Card className="border-dashed p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <p className="pt-1 text-xs text-muted-foreground">
            Previewed in daemon timezone: <code>{timeZone}</code>
          </p>
        </div>
      </div>
      {preview.ok ? (
        <div className="pt-3 text-sm">
          {preview.nextRuns.map((run, index) => (
            <div key={`${run.toISOString()}-${index}`} className="font-mono text-xs text-foreground">
              {formatPreviewRun(run, timeZone)}
            </div>
          ))}
        </div>
      ) : (
        <p className="pt-3 text-xs text-muted-foreground">{preview.error}</p>
      )}
    </Card>
  );
}

export default function RoutinesSettingsPage() {
  const [selection, setSelection] = useState<Selection>({
    kind: "builtin",
    stem: "_index",
  });
  const [creatingOpen, setCreatingOpen] = useState(false);
  const config = useConfig();
  // Empty string falls through `??`, so guard with `||`. Fresh installs have
  // `config.timezone === ""` until setup completes; without this fallback,
  // `Intl.DateTimeFormat({ timeZone: "" })` throws and crashes the page.
  const timezone =
    (config.data?.timezone && config.data.timezone.length > 0
      ? config.data.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone)
    || "UTC";

  return (
    <>
      <PageHeader
        title="Routines"
        description="Per-cadence check rulebooks. Each file is injected into the task-flow prompt when its routine fires. Edits persist immediately; saving an enabled custom routine registers (or refreshes) its cron job."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
        <RoutineList
          selection={selection}
          onSelect={setSelection}
          onCreateClick={() => setCreatingOpen(true)}
        />
        <RoutineEditor
          selection={selection}
          timezone={timezone}
          onDeleted={() => setSelection({ kind: "builtin", stem: "_index" })}
        />
      </div>

      {creatingOpen && (
        <CreateCustomRoutineDialog
          open
          timeZone={timezone}
          onOpenChange={setCreatingOpen}
          onCreated={(slug) => {
            setSelection({ kind: "custom", slug });
            setCreatingOpen(false);
          }}
        />
      )}
    </>
  );
}

function RoutineList({
  selection,
  onSelect,
  onCreateClick,
}: {
  selection: Selection;
  onSelect: (s: Selection) => void;
  onCreateClick: () => void;
}) {
  const { data: list } = useContextList("routines");

  const customFiles = useMemo(() => {
    return (list?.files ?? [])
      .filter((file) => file.name.startsWith("custom/") && file.name.endsWith(".md"))
      .map((file) => ({
        slug: file.name.slice("custom/".length, -3),
        lastModified: file.lastModified,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }, [list?.files]);

  const builtInEntries = useMemo(() => {
    const extra = (list?.files ?? [])
      .filter((file) => !file.name.startsWith("custom/") && file.name.endsWith(".md"))
      .map((file) => stripMdExtension(file.name))
      .filter((stem) => !BUILT_IN_LABELS.has(stem as BuiltInStem))
      .sort((a, b) => a.localeCompare(b))
      .map((stem) => ({
        stem,
        label: stem,
        cadence: "additional",
      }));
    return [...BUILT_IN_ROUTINES, ...extra];
  }, [list?.files]);

  const isSelected = (item: Selection) =>
    selection.kind === item.kind
    && (selection.kind === "builtin"
      ? selection.stem === (item as { kind: "builtin"; stem: string }).stem
      : selection.slug === (item as { kind: "custom"; slug: string }).slug);

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Built-in
        </span>
      </div>
      <nav className="flex flex-col">
        {builtInEntries.map((routine) => {
          const entry: Selection = { kind: "builtin", stem: routine.stem };
          const isOverview = routine.stem === "_index";
          return (
            <button
              key={routine.stem}
              type="button"
              onClick={() => onSelect(entry)}
              className={cn(
                "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                isSelected(entry) && "bg-accent text-foreground",
              )}
            >
              <span className="flex items-center gap-2">
                {isOverview ? (
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                {routine.label}
              </span>
              <span className="text-xs text-muted-foreground">{routine.cadence}</span>
            </button>
          );
        })}
      </nav>

      <Separator className="my-3" />

      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Custom
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          onClick={onCreateClick}
        >
          <Plus className="h-3 w-3" />
          Add
        </Button>
      </div>

      {customFiles.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          No custom routines yet.
        </p>
      ) : (
        <nav className="flex flex-col">
          {customFiles.map(({ slug }) => (
            <CustomRoutineListItem
              key={slug}
              slug={slug}
              selected={isSelected({ kind: "custom", slug })}
              onSelect={() => onSelect({ kind: "custom", slug })}
            />
          ))}
        </nav>
      )}
    </Card>
  );
}

/**
 * Sidebar row for a custom routine. Reads the file's `enabled:` frontmatter
 * via the shared react-query cache so opening it in the editor later is
 * free. Renders a muted <PowerOff> icon + reduced-opacity label when the
 * routine is disabled so the user can see at-a-glance which custom
 * routines are inactive without opening each one.
 */
function CustomRoutineListItem({
  slug,
  selected,
  onSelect,
}: {
  slug: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const path = customPath(slug);
  const file = useContextFile(path);
  const enabledRaw = file.data
    ? readFrontmatterScalar(file.data.content, "enabled")
    : null;
  // Unknown state (loading / parse failure) is treated as enabled to avoid
  // a misleading "disabled" indicator while the file is still loading.
  const disabled = enabledRaw === "false";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
        selected && "bg-accent text-foreground",
        disabled && "opacity-60",
      )}
      title={disabled ? "Disabled — cron job not running" : undefined}
    >
      <span className="truncate font-mono text-xs">{slug}</span>
      {disabled && (
        <PowerOff className="ml-2 h-3 w-3 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function RoutineEditor({
  selection,
  timezone,
  onDeleted,
}: {
  selection: Selection;
  timezone: string;
  onDeleted: () => void;
}) {
  const path = selectionPath(selection);
  const file = useContextFile(path);

  if (file.isLoading) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Card>
    );
  }
  if (file.error || !file.data) {
    const status = (file.error as ApiError | undefined)?.status;
    if (status === 404) {
      return (
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">
            This routine file does not exist yet. Built-in routines are created
            by setup; custom routines are created via the Add button or by the
            agent on your request.
          </p>
        </Card>
      );
    }
    return (
      <Card className="p-4">
        <p className="text-sm text-destructive">
          Failed to load: {(file.error as Error | undefined)?.message ?? "unknown"}
        </p>
      </Card>
    );
  }

  return (
    <LoadedRoutineEditor
      key={path}
      path={path}
      selection={selection}
      timezone={timezone}
      editable={file.data.editable !== false}
      initialFile={file.data}
      onDeleted={onDeleted}
    />
  );
}

function LoadedRoutineEditor({
  path,
  selection,
  timezone,
  editable,
  initialFile,
  onDeleted,
}: {
  path: string;
  selection: Selection;
  timezone: string;
  editable: boolean;
  initialFile: ContextFileResponse;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState(initialFile.content);
  const [baseline, setBaseline] = useState({
    content: initialFile.content,
    mtime: initialFile.lastModified,
  });
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateContextFile();
  const del = useDeleteContextFile();
  const confirmDialog = useConfirm();

  const dirty = draft !== baseline.content;
  const cronExpression =
    selection.kind === "custom"
      ? readFrontmatterScalar(draft, "cron")
      : null;
  const enabledRaw =
    selection.kind === "custom"
      ? readFrontmatterScalar(draft, "enabled")
      : null;
  const enabledKnown = enabledRaw === "true" || enabledRaw === "false";
  const currentlyEnabled = enabledRaw === "true";

  const handleSave = async () => {
    setError(null);
    try {
      const res = await update.mutateAsync({
        path,
        content: draft,
        expectedMtime: baseline.mtime,
      });
      setBaseline({ content: draft, mtime: res.lastModified });
      setToast("Saved.");
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      if (err instanceof ContextConflictError) {
        setError(
          "Another writer changed this file. Refresh to see the latest version.",
        );
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError((err as Error).message);
      }
    }
  };

  const handleToggleEnabled = () => {
    if (selection.kind !== "custom" || !editable) return;
    const next = currentlyEnabled ? "false" : "true";
    setDraft(setFrontmatterScalar(draft, "enabled", next));
  };

  const handleDelete = async () => {
    if (selection.kind !== "custom") return;
    const ok = await confirmDialog({
      title: `Delete custom routine "${selection.slug}"?`,
      description:
        "This removes the file and unregisters its cron job. This cannot be undone from here; restore from the Knowledge page snapshots if needed.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await del.mutateAsync({ path });
      onDeleted();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : (err as Error).message,
      );
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardHeader className="flex flex-row items-center justify-between p-0 pb-0">
        <div>
          <CardTitle className="text-sm font-semibold">{path}.md</CardTitle>
          {selection.kind === "custom" ? (
            <p className="pt-1 text-xs text-muted-foreground">
              Frontmatter (<code>cron:</code>, <code>process_key</code>,{" "}
              <code>enabled</code>, <code>backend_tier</code>,{" "}
              <code>max_budget_usd</code>) and a <code>## Checks</code>{" "}
              section are required. The scheduler reloads on save.
            </p>
          ) : (
            <p className="pt-1 text-xs text-muted-foreground">
              All files under <code>policies/routines/</code>, including{" "}
              <code>_index.md</code>, are editable here.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {selection.kind === "custom" && enabledKnown && (
            <Button
              type="button"
              variant={currentlyEnabled ? "default" : "outline"}
              size="sm"
              className="gap-1"
              onClick={handleToggleEnabled}
              disabled={!editable}
              title={
                currentlyEnabled
                  ? "Disable this routine (stops the cron job on save)"
                  : "Enable this routine (registers the cron job on save)"
              }
            >
              {currentlyEnabled ? (
                <>
                  <Power className="h-3.5 w-3.5" />
                  Enabled
                </>
              ) : (
                <>
                  <PowerOff className="h-3.5 w-3.5" />
                  Disabled
                </>
              )}
            </Button>
          )}
          {selection.kind === "custom" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1 text-destructive hover:text-destructive"
              onClick={handleDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || !editable || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardHeader>

      {selection.kind === "custom" && (
        <CronPreviewCard cronExpression={cronExpression} timeZone={timezone} />
      )}

      <textarea
        value={draft ?? ""}
        onChange={(event) => setDraft(event.target.value)}
        disabled={!editable}
        spellCheck={false}
        className="min-h-[480px] w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
      />

      {toast && (
        <p className="text-xs text-muted-foreground">{toast}</p>
      )}
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </Card>
  );
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function buildInitialCustomRoutine(
  slug: string,
  cron: string,
  tier: "lite" | "medium" | "high",
  budget: number,
  description: string,
): string {
  const today = new Date().toISOString().slice(0, 10);
  return `---
type: rule
slug: ${slug}
cron: "${cron}"
process_key: routine.custom.${slug}
enabled: true
added_at: ${today}
added_by: user via dashboard
backend_tier: ${tier}
max_budget_usd: ${budget}
---
# ${slug}

${description.trim() || "Describe what this routine should do here."}

## Checks

### First check
- **Action**: describe the action to take each run.
`;
}

function CreateCustomRoutineDialog({
  open,
  timeZone,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  timeZone: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [cron, setCron] = useState("0 11 * * 2");
  const [tier, setTier] = useState<"lite" | "medium" | "high">("medium");
  const [budget, setBudget] = useState("0.05");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateContextFile();

  const preview = useMemo(
    () => previewCronSchedule(cron, timeZone, { count: 3 }),
    [cron, timeZone],
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!SLUG_PATTERN.test(slug) || slug.length > 64) {
      setError(
        "Slug must be lowercase kebab-case (a–z, 0–9, hyphen), 1–64 chars, and may not start or end with a hyphen.",
      );
      return;
    }
    if (!preview.ok) {
      setError(preview.error);
      return;
    }
    const budgetNum = Number(budget);
    if (!Number.isFinite(budgetNum) || budgetNum <= 0) {
      setError("Max budget must be a positive number in USD.");
      return;
    }
    const content = buildInitialCustomRoutine(slug, cron, tier, budgetNum, description);
    try {
      await update.mutateAsync({ path: customPath(slug), content });
      onCreated(slug);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New custom routine</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <FormField label="Slug">
            <Input
              value={slug}
              onChange={(event) => setSlug(event.target.value.trim())}
              placeholder="tuesday-notion-sync"
              autoFocus
            />
          </FormField>
          <FormField label="Cron expression (5 fields, daemon timezone)">
            <Input
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              placeholder="0 11 * * 2"
              className="font-mono"
            />
          </FormField>

          <CronPreviewCard
            cronExpression={cron}
            timeZone={timeZone}
            title="Cron preview"
          />

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Backend tier">
              <NativeSelect
                value={tier}
                onChange={(event) =>
                  setTier(event.target.value as "lite" | "medium" | "high")
                }
              >
                <option value="lite">lite (haiku)</option>
                <option value="medium">medium (sonnet)</option>
                <option value="high">high (opus)</option>
              </NativeSelect>
            </FormField>
            <FormField label="Max budget (USD)">
              <Input
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                placeholder="0.05"
              />
            </FormField>
          </div>
          <FormField label="Description (optional)">
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Weekly Tuesday check of the Notion planning DB…"
              className="min-h-[80px] resize-y rounded-md border border-input bg-background p-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
            />
          </FormField>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

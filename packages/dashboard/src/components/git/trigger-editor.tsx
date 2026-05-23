"use client";

import { useMemo, useState } from "react";
import { getBackendIds } from "@aitne/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  type RepositoryDTO,
  type RepositoryTriggerCreateInput,
  type RepositoryTriggerDTO,
  type TriggerBackend,
  type TriggerWorkdirMode,
  repositoryHasGithub,
  repositoryHasLocal,
  useCreateRepoTrigger,
  useUpdateRepoTrigger,
} from "@/lib/hooks/use-repositories";
import { useBackends } from "@/lib/hooks/use-backends";

const FIELD_LABEL =
  "text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

const GIT_EVENT_TYPES = [
  "git.push.detected",
  "git.push.force_pushed",
  "git.merge_to_default",
  "git.local_ahead.stale",
  "git.branch.created",
  "git.tag.created",
] as const;

const GITHUB_EVENT_TYPES = [
  "github.pull_request.opened",
  "github.pull_request.synchronize",
  "github.pull_request.review_requested",
  "github.pull_request.closed",
  "github.workflow_run.failed",
  "github.assigned",
  "github.security_alert",
  "github.notification",
] as const;

interface FilterEntry {
  id: string;
  key: string;
  value: string;
}

interface TriggerEditorProps {
  repo: RepositoryDTO;
  open: boolean;
  initial?: RepositoryTriggerDTO;
  onClose: () => void;
}

// Wrapper keeps the Sheet root mounted across open→closed so Radix can clear
// its body pointer-events lock. Inner content is gated by `open` so form state
// re-initializes each time the sheet is reopened.
export function TriggerEditor({ repo, open, initial, onClose }: TriggerEditorProps) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      {open && <TriggerEditorContent repo={repo} initial={initial} onClose={onClose} />}
    </Sheet>
  );
}

function TriggerEditorContent({
  repo,
  initial,
  onClose,
}: {
  repo: RepositoryDTO;
  initial?: RepositoryTriggerDTO;
  onClose: () => void;
}) {
  const create = useCreateRepoTrigger();
  const update = useUpdateRepoTrigger();
  const { data: backendsData } = useBackends();

  const validBackendIds = useMemo(
    () => new Set<TriggerBackend>(getBackendIds()),
    [],
  );

  const eventTypes = useMemo(() => {
    const out: string[] = [];
    if (repositoryHasLocal(repo)) out.push(...GIT_EVENT_TYPES);
    if (repositoryHasGithub(repo)) out.push(...GITHUB_EVENT_TYPES);
    return out;
  }, [repo]);

  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [eventType, setEventType] = useState(
    initial?.eventType ?? eventTypes[0] ?? "git.push.detected",
  );
  const [filters, setFilters] = useState<FilterEntry[]>(() =>
    initial
      ? Object.entries(initial.filters).map(([k, v], i) => ({
          id: `${i}`,
          key: k,
          value: typeof v === "string" || typeof v === "number" || typeof v === "boolean"
            ? String(v)
            : JSON.stringify(v),
        }))
      : [],
  );
  const [backend, setBackend] = useState<TriggerBackend>(
    initial?.backend ?? "claude",
  );
  const [model, setModel] = useState(initial?.model ?? "");
  const [workdirMode, setWorkdirMode] = useState<TriggerWorkdirMode>(
    initial?.workdirMode ?? (repositoryHasLocal(repo) ? "local-clone" : "temp"),
  );
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [instructionMd, setInstructionMd] = useState<string>(
    initial?.instructionMd ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  const localCloneDisabled = !repositoryHasLocal(repo);
  const instructionLabel =
    backend === "claude"
      ? "CLAUDE.md instruction"
      : backend === "codex" || backend === "opencode"
        ? "AGENTS.md instruction"
        : "GEMINI.md instruction";

  const backendModels = useMemo(() => {
    const list = backendsData?.backends ?? [];
    return list
      .filter((b) => validBackendIds.has(b.id as TriggerBackend))
      .filter((b) => b.id === backend)
      .flatMap((b) => b.models?.map((m) => m.modelId) ?? []);
  }, [backendsData, backend, validBackendIds]);

  const addFilter = () => {
    setFilters((prev) => [...prev, { id: crypto.randomUUID(), key: "", value: "" }]);
  };
  const updateFilter = (id: string, patch: Partial<FilterEntry>) => {
    setFilters((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };
  const removeFilter = (id: string) => {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  };

  type FiltersResult =
    | { ok: true; filters: Record<string, unknown> }
    | { ok: false; error: string };

  const buildFiltersJson = (): FiltersResult => {
    const out: Record<string, unknown> = {};
    for (const f of filters) {
      const k = f.key.trim();
      const v = f.value;
      if (!k) continue;
      if (k === "path_pattern") {
        // Allow comma-separated globs to populate the array form.
        const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0) continue;
        out[k] = parts.length === 1 ? parts[0] : parts;
        continue;
      }
      // Coerce booleans / numbers; otherwise keep string.
      if (v === "true") out[k] = true;
      else if (v === "false") out[k] = false;
      else if (v !== "" && !Number.isNaN(Number(v))) out[k] = Number(v);
      else out[k] = v;
    }
    return { ok: true, filters: out };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    if (!eventType) return setError("Pick an event type.");
    if (!model.trim()) return setError("Model is required.");
    if (!prompt.trim()) return setError("Prompt is required.");
    if (workdirMode === "temp" && !instructionMd.trim()) {
      return setError(`${instructionLabel} is required when workdir is Temp.`);
    }
    if (workdirMode === "local-clone" && localCloneDisabled) {
      return setError("This repository has no local clone.");
    }

    const filtersBuilt = buildFiltersJson();
    if (!filtersBuilt.ok) {
      setError(filtersBuilt.error);
      return;
    }

    const body: RepositoryTriggerCreateInput = {
      name: name.trim(),
      enabled,
      eventType,
      filters: filtersBuilt.filters,
      backend,
      model: model.trim(),
      workdirMode,
      prompt,
      instructionMd: workdirMode === "temp" ? instructionMd : null,
    };

    try {
      if (initial) {
        await update.mutateAsync({
          repositoryId: repo.id,
          triggerId: initial.id,
          body,
        });
      } else {
        await create.mutateAsync({ repositoryId: repo.id, body });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save trigger");
    }
  };

  return (
    <SheetContent className="overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{initial ? "Edit trigger" : "New trigger"}</SheetTitle>
        </SheetHeader>
        <form onSubmit={submit} className="mt-6 space-y-5">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Auto-review main pushes"
                autoFocus
              />
            </div>
            <label className="flex items-end gap-1.5 pb-1 text-xs">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enabled
            </label>
          </div>

          {/* Condition */}
          <fieldset className="space-y-3 rounded-md border bg-background/40 p-3">
            <legend className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Condition
            </legend>
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Event type</label>
              <select
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {eventTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Filters</label>
              <p className="text-[11px] text-muted-foreground">
                Flat key/value equality. Special key{" "}
                <span className="font-mono">path_pattern</span> takes a comma-
                separated glob list (e.g. <span className="font-mono">packages/**,docs/*.md</span>).
                All filters AND together; multiple globs OR within{" "}
                <span className="font-mono">path_pattern</span>.
              </p>
              <div className="space-y-1">
                {filters.map((f) => (
                  <div key={f.id} className="flex gap-1">
                    <Input
                      value={f.key}
                      onChange={(e) => updateFilter(f.id, { key: e.target.value })}
                      placeholder="branch / path_pattern / action / …"
                      className="flex-[1.2]"
                    />
                    <Input
                      value={f.value}
                      onChange={(e) => updateFilter(f.id, { value: e.target.value })}
                      placeholder="main"
                      className="flex-[2]"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeFilter(f.id)}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                <Button type="button" size="sm" variant="ghost" onClick={addFilter}>
                  + Add filter
                </Button>
              </div>
            </div>
          </fieldset>

          {/* Action */}
          <fieldset className="space-y-3 rounded-md border bg-background/40 p-3">
            <legend className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Action
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <label className={FIELD_LABEL}>Backend</label>
                <select
                  value={backend}
                  onChange={(e) => setBackend(e.target.value as TriggerBackend)}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                  <option value="gemini">gemini (deprecated)</option>
                  <option value="opencode" disabled>
                    opencode (coming soon)
                  </option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className={FIELD_LABEL}>Model</label>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  list={`models-${backend}`}
                  placeholder={
                    backend === "claude"
                      ? "claude-sonnet-4-6"
                      : backend === "codex"
                        ? "gpt-5.4-medium"
                        : backend === "opencode"
                          ? "anthropic/claude-sonnet-4-6"
                          : "gemini-2.0-flash"
                  }
                />
                <datalist id={`models-${backend}`}>
                  {backendModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Workdir</label>
              <div className="flex gap-2">
                <label
                  className={
                    "flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors " +
                    (workdirMode === "temp"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border")
                  }
                >
                  <input
                    type="radio"
                    name="workdir"
                    checked={workdirMode === "temp"}
                    onChange={() => setWorkdirMode("temp")}
                  />
                  Temp directory
                </label>
                <label
                  className={
                    "flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors " +
                    (workdirMode === "local-clone"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border") +
                    (localCloneDisabled ? " cursor-not-allowed opacity-50" : "")
                  }
                  title={
                    localCloneDisabled
                      ? "this repository has no local clone"
                      : undefined
                  }
                >
                  <input
                    type="radio"
                    name="workdir"
                    disabled={localCloneDisabled}
                    checked={workdirMode === "local-clone"}
                    onChange={() => setWorkdirMode("local-clone")}
                  />
                  Local clone
                </label>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="When this fires, do…"
              />
              <p className="text-[11px] text-muted-foreground">
                Free-form. The agent picks the right skills (DM, context write,
                git read-only, repo write).
              </p>
            </div>

            {workdirMode === "temp" && (
              <div className="space-y-1.5">
                <label className={FIELD_LABEL}>{instructionLabel}</label>
                <textarea
                  value={instructionMd}
                  onChange={(e) => setInstructionMd(e.target.value)}
                  rows={4}
                  className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Required when workdir is Temp — the body of the instruction file."
                />
              </div>
            )}
          </fieldset>

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50/50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={create.isPending || update.isPending}
            >
              {create.isPending || update.isPending
                ? "Saving…"
                : initial
                  ? "Save"
                  : "Create"}
            </Button>
          </div>
        </form>
      </SheetContent>
  );
}

"use client";

import { useMemo, useState } from "react";
import { RUNTIME_AVAILABLE_BACKEND_IDS } from "@aitne/shared";
import type { BackendId, BackendModel } from "@aitne/shared";
import {
  Check,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Save,
  Trash2,
  AlertTriangle,
  X,
} from "lucide-react";
import { ApiError } from "@/lib/api-client";
import type {
  BuiltInBangCommand,
  UserBangCommand,
  UserBangCommandUpsert,
} from "@/lib/api-types";
import { PageHeader } from "@/components/ui/page-header";
import {
  useCommands,
  useCreateCommand,
  useDeleteCommand,
  useUpdateCommand,
} from "@/lib/hooks/use-commands";
import { useBackends } from "@/lib/hooks/use-backends";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import {
  isUiPreviewOnlyBackend,
  UI_PREVIEW_ONLY_BADGE_SUFFIX,
} from "@/lib/backend-ui";
import { cn } from "@/lib/utils";

// User bang commands fire through the BackendRouter; the picker exposes only
// backends with a wired runtime core. BACKENDS tracks
// `RUNTIME_AVAILABLE_BACKEND_IDS`, so the list widens when a new backend
// joins that registry.
const BACKENDS: readonly BackendId[] = RUNTIME_AVAILABLE_BACKEND_IDS;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

interface Draft {
  id: number | null;
  name: string;
  description: string;
  prompt: string;
  backendId: BackendId;
  modelId: string;
  enabled: boolean;
  /**
   * Skill slugs to materialize for this command. `null` means "use the
   * default" (notify-only). The form maps the legacy NULL to a concrete
   * default array on edit so the user can see what they'd inherit.
   */
  enabledSkills: string[];
  /** Empty string = no override; the daemon stores it as NULL. */
  instructionMd: string;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  description: "",
  prompt: "",
  backendId: "claude",
  modelId: "claude-sonnet-4-6",
  enabled: true,
  enabledSkills: ["notify"],
  instructionMd: "",
};

function normalizeName(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith("!") ? trimmed.slice(1) : trimmed;
}

function commandForName(raw: string): string {
  return `!${normalizeName(raw)}`;
}

function modelLabel(model: BackendModel): string {
  return model.displayName ?? model.label ?? model.modelId;
}

function mutationErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : "Request failed";
}

export default function CommandsSettingsPage() {
  const commandsQuery = useCommands();
  const backendsQuery = useBackends();
  const createCommand = useCreateCommand();
  const updateCommand = useUpdateCommand();
  const deleteCommand = useDeleteCommand();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const modelsByBackend = useMemo(() => {
    const backendRows = backendsQuery.data?.backends ?? [];
    const map = new Map<BackendId, BackendModel[]>();
    for (const backend of backendRows) {
      map.set(
        backend.id,
        backend.models.filter((model) => model.available).sort((a, b) => {
          if (!!a.deprecated !== !!b.deprecated) return a.deprecated ? 1 : -1;
          return modelLabel(a).localeCompare(modelLabel(b));
        }),
      );
    }
    return map;
  }, [backendsQuery.data?.backends]);

  const reservedCommands = useMemo(
    () => new Set(commandsQuery.data?.builtInCommands.map((cmd) => cmd.command) ?? []),
    [commandsQuery.data?.builtInCommands],
  );
  const builtInConflicts = useMemo(
    () =>
      (commandsQuery.data?.userCommands ?? []).filter((command) =>
        reservedCommands.has(command.command),
      ),
    [commandsQuery.data?.userCommands, reservedCommands],
  );

  const defaultSkills = useMemo(
    () => commandsQuery.data?.constraints.defaultSkills ?? ["notify"],
    [commandsQuery.data?.constraints.defaultSkills],
  );
  const availableSkills = useMemo(
    () => commandsQuery.data?.constraints.availableSkills ?? [],
    [commandsQuery.data?.constraints.availableSkills],
  );
  const maxInstructionMdLength =
    commandsQuery.data?.constraints.maxInstructionMdLength ?? 32_000;

  const startCreate = () => {
    const firstBackend = backendsQuery.data?.defaultBackend ?? "claude";
    const firstModel =
      modelsByBackend.get(firstBackend)?.find((model) => model.available)?.modelId ??
      modelsByBackend.get(firstBackend)?.[0]?.modelId ??
      EMPTY_DRAFT.modelId;
    setDraft({
      ...EMPTY_DRAFT,
      backendId: firstBackend,
      modelId: firstModel,
      enabledSkills: [...defaultSkills],
    });
    setToast(null);
  };

  const startEdit = (command: UserBangCommand) => {
    setDraft({
      id: command.id,
      name: command.name,
      description: command.description,
      prompt: command.prompt,
      backendId: command.backendId,
      modelId: command.modelId,
      enabled: command.enabled,
      // Legacy NULL → expose the default selection so the user sees what
      // the row would actually run with, and any save persists that
      // explicit selection (no more silent NULL behaviour).
      enabledSkills: command.enabledSkills ?? [...defaultSkills],
      instructionMd: command.instructionMd ?? "",
    });
    setToast(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const trimmedInstruction = draft.instructionMd.trim();
    const body: UserBangCommandUpsert = {
      name: normalizeName(draft.name),
      description: draft.description.trim(),
      prompt: draft.prompt.trim(),
      backendId: draft.backendId,
      modelId: draft.modelId,
      enabled: draft.enabled,
      enabledSkills: draft.enabledSkills,
      instructionMd: trimmedInstruction.length === 0 ? null : trimmedInstruction,
    };
    try {
      if (draft.id) {
        await updateCommand.mutateAsync({ id: draft.id, body });
        setToast(`${commandForName(draft.name)} updated`);
      } else {
        await createCommand.mutateAsync(body);
        setToast(`${commandForName(draft.name)} created`);
      }
      setDraft(null);
    } catch (err) {
      setToast(mutationErrorMessage(err));
    }
  };

  const removeCommand = async (command: UserBangCommand) => {
    if (!window.confirm(`Delete ${command.command}?`)) return;
    try {
      await deleteCommand.mutateAsync(command.id);
      if (draft?.id === command.id) setDraft(null);
      setToast(`${command.command} deleted`);
    } catch (err) {
      setToast(mutationErrorMessage(err));
    }
  };

  const busy =
    createCommand.isPending || updateCommand.isPending || deleteCommand.isPending;

  if (commandsQuery.isLoading || backendsQuery.isLoading) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading commands…</p>
      </Card>
    );
  }

  if (commandsQuery.error || backendsQuery.error || !commandsQuery.data || !backendsQuery.data) {
    return (
      <Card tone="error" className="p-4">
        <p className="text-sm text-destructive">
          Failed to load command settings.
        </p>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title="Commands"
        description={
          <>
            Messaging shortcuts that begin with <code>!</code>. Built-in
            commands are system controls; custom commands run your saved prompt
            on the backend and model you choose.
          </>
        }
      />

      {toast && <Alert className="rounded-lg px-4 py-2.5 text-sm">{toast}</Alert>}

      {builtInConflicts.length > 0 && (
        <Alert
          variant="warning"
          icon={false}
          className="rounded-lg px-4 py-3 text-sm"
        >
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">
                Some custom commands now conflict with built-in commands.
              </p>
              <p className="mt-1 text-muted-foreground">
                Built-in commands take precedence at runtime. Rename the
                custom command to make it callable again.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {builtInConflicts.map((command) => (
                  <code
                    key={command.id}
                    className="rounded bg-background px-1.5 py-0.5 font-mono text-xs"
                  >
                    {command.command}
                  </code>
                ))}
              </div>
            </div>
          </div>
        </Alert>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Built-in</h2>
            <p className="text-sm text-muted-foreground">
              Read-only controls handled by the daemon without model cost.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {commandsQuery.data.builtInCommands.map((command) => (
            <BuiltInCommandCard key={command.command} command={command} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Custom</h2>
            <p className="text-sm text-muted-foreground">
              User-defined commands are validated against built-in and existing
              custom names.
            </p>
          </div>
          <Button onClick={startCreate} disabled={busy}>
            <Plus className="mr-2 h-4 w-4" />
            New Command
          </Button>
        </div>

        {draft && (
          <CommandForm
            draft={draft}
            builtInReserved={reservedCommands}
            userCommands={commandsQuery.data.userCommands}
            modelsByBackend={modelsByBackend}
            availableSkills={availableSkills}
            maxInstructionMdLength={maxInstructionMdLength}
            busy={busy}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={saveDraft}
          />
        )}

        {commandsQuery.data.userCommands.length === 0 ? (
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              No custom commands yet.
            </p>
          </Card>
        ) : (
          <div className="grid gap-3">
            {commandsQuery.data.userCommands.map((command) => (
              <UserCommandCard
                key={command.id}
                command={command}
                model={modelsByBackend
                  .get(command.backendId)
                  ?.find((m) => m.modelId === command.modelId)}
                hasBuiltInConflict={reservedCommands.has(command.command)}
                busy={busy}
                onEdit={() => startEdit(command)}
                onDelete={() => removeCommand(command)}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function BuiltInCommandCard({ command }: { command: BuiltInBangCommand }) {
  return (
    <Card className="p-4">
      <CardHeader className="mb-2 gap-3">
        <div className="min-w-0">
          <CardTitle className="text-base">{command.title}</CardTitle>
          <p className="pt-1 font-mono text-sm text-primary">{command.command}</p>
        </div>
        <Badge variant="gray">Built-in</Badge>
      </CardHeader>
      <p className="text-sm text-muted-foreground">{command.description}</p>
      {command.details.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {command.details.map((detail) => (
            <li key={detail} className="flex gap-2">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              <span>{detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function UserCommandCard({
  command,
  model,
  hasBuiltInConflict,
  busy,
  onEdit,
  onDelete,
}: {
  command: UserBangCommand;
  model: BackendModel | undefined;
  hasBuiltInConflict: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card tone={hasBuiltInConflict ? "warning" : "default"} className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-base font-semibold text-primary">
              {command.command}
            </h3>
            <Badge variant={command.enabled ? "green" : "gray"}>
              {command.enabled ? "Enabled" : "Disabled"}
            </Badge>
            {hasBuiltInConflict && (
              <Badge variant="amber">Name conflict</Badge>
            )}
            <Badge variant="blue">{command.backendId}</Badge>
          </div>
          <p className="mt-1 text-sm text-foreground">
            {command.description || "No description provided."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Model: {model ? modelLabel(model) : command.modelId}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button variant="destructive" size="sm" onClick={onDelete} disabled={busy}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>
      {hasBuiltInConflict && (
        <div className="mt-3 flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            A built-in command with this name now exists. Runtime dispatch will
            use the built-in command until this custom command is renamed.
          </span>
        </div>
      )}
      <div className="mt-3 max-h-28 overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
        <pre className="whitespace-pre-wrap font-sans">{command.prompt}</pre>
      </div>
    </Card>
  );
}

function CommandForm({
  draft,
  builtInReserved,
  userCommands,
  modelsByBackend,
  availableSkills,
  maxInstructionMdLength,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  builtInReserved: ReadonlySet<string>;
  userCommands: UserBangCommand[];
  modelsByBackend: ReadonlyMap<BackendId, BackendModel[]>;
  availableSkills: readonly string[];
  maxInstructionMdLength: number;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const normalizedName = normalizeName(draft.name);
  const normalizedCommand = commandForName(draft.name);
  const nameValid = NAME_PATTERN.test(normalizedName);
  const duplicateBuiltIn = builtInReserved.has(normalizedCommand);
  const duplicateUser = userCommands.some(
    (command) => command.command === normalizedCommand && command.id !== draft.id,
  );
  const models = modelsByBackend.get(draft.backendId) ?? [];
  const modelValid = models.some((model) => model.modelId === draft.modelId);
  const instructionTooLong = draft.instructionMd.length > maxInstructionMdLength;
  const canSave =
    nameValid &&
    !duplicateBuiltIn &&
    !duplicateUser &&
    draft.prompt.trim().length > 0 &&
    modelValid &&
    !instructionTooLong &&
    !busy;
  const toggleSkill = (slug: string) => {
    const has = draft.enabledSkills.includes(slug);
    onChange({
      ...draft,
      enabledSkills: has
        ? draft.enabledSkills.filter((s) => s !== slug)
        : [...draft.enabledSkills, slug],
    });
  };
  const backendInstructionFile =
    draft.backendId === "claude"
      ? "CLAUDE.md"
      : draft.backendId === "codex"
        ? "AGENTS.md"
        : "GEMINI.md";

  const nameHint = !draft.name.trim()
    ? "Enter the part after !."
    : !nameValid
      ? "Use lowercase letters, numbers, hyphens, or underscores."
      : duplicateBuiltIn
        ? "This is a built-in command."
        : duplicateUser
          ? "This custom command already exists."
          : `${normalizedCommand} is available.`;

  return (
    <Card className="p-4">
      <CardHeader className="mb-4">
        <CardTitle className="text-base">
          {draft.id ? `Edit ${normalizedCommand}` : "New Custom Command"}
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={onCancel} disabled={busy}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">Command</span>
          <div className="flex">
            <span className="inline-flex h-9 items-center rounded-l-md border border-r-0 border-input bg-muted px-3 font-mono text-sm text-muted-foreground">
              !
            </span>
            <Input
              value={draft.name.startsWith("!") ? draft.name.slice(1) : draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              className="rounded-l-none font-mono"
              placeholder="digest"
              disabled={busy}
            />
          </div>
          <p
            className={cn(
              "text-xs",
              nameValid && !duplicateBuiltIn && !duplicateUser
                ? "text-muted-foreground"
                : "text-destructive",
            )}
          >
            {nameHint}
          </p>
        </label>

        <label className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">Description</span>
          <Input
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            placeholder="Short label shown in settings and help"
            disabled={busy}
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">Backend</span>
          <Select
            value={draft.backendId}
            onValueChange={(value) => {
              const backendId = value as BackendId;
              const firstModel =
                modelsByBackend.get(backendId)?.find((model) => model.available)?.modelId ??
                modelsByBackend.get(backendId)?.[0]?.modelId ??
                "";
              onChange({ ...draft, backendId, modelId: firstModel });
            }}
            disabled={busy}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BACKENDS.map((backend) => {
                const previewOnly = isUiPreviewOnlyBackend(backend);
                return (
                  <SelectItem
                    key={backend}
                    value={backend}
                    disabled={previewOnly}
                  >
                    {backend}
                    {previewOnly ? UI_PREVIEW_ONLY_BADGE_SUFFIX : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </label>

        <label className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">Model</span>
          <Select
            value={draft.modelId}
            onValueChange={(modelId) => onChange({ ...draft, modelId })}
            disabled={busy || models.length === 0}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((model) => (
                <SelectItem key={model.modelId} value={model.modelId}>
                  {modelLabel(model)}
                  {model.deprecated ? " · legacy" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <label className="mt-4 block space-y-1.5">
        <span className="text-sm font-medium text-foreground">Instruction Prompt</span>
        <textarea
          value={draft.prompt}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
          rows={8}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="Describe exactly what the agent should do when this command is invoked."
          disabled={busy}
        />
      </label>

      <fieldset className="mt-4 space-y-2">
        <legend className="text-sm font-medium text-foreground">Skills</legend>
        <p className="text-xs text-muted-foreground">
          Skill modules are materialized into the working directory for this
          command. Leave only <code>notify</code> checked for a minimal
          DM-reply turn; add more if your prompt needs them.
        </p>
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
          {availableSkills.map((slug) => {
            const checked = draft.enabledSkills.includes(slug);
            return (
              <label
                key={slug}
                className="inline-flex items-start gap-2 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSkill(slug)}
                  disabled={busy}
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                />
                <span className="font-mono text-xs">{slug}</span>
              </label>
            );
          })}
        </div>
        {draft.enabledSkills.length === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No skills selected — the agent will run with only safety + your
            instructions. Reply quality may suffer without <code>notify</code>.
          </p>
        )}
      </fieldset>

      <label className="mt-4 block space-y-1.5">
        <span className="text-sm font-medium text-foreground">
          {backendInstructionFile} body (optional)
        </span>
        <p className="text-xs text-muted-foreground">
          Custom profile body written into the working directory&apos;s{" "}
          <code>{backendInstructionFile}</code> for this command. Leave blank
          to use the default conversational profile. The safety preamble and
          your character block are always emitted around it.
        </p>
        <textarea
          value={draft.instructionMd}
          onChange={(e) => onChange({ ...draft, instructionMd: e.target.value })}
          rows={8}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="Replace the default conversational persona for this command. e.g. 'You are a terse summariser…'"
          disabled={busy}
        />
        <p
          className={cn(
            "text-xs",
            instructionTooLong ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {draft.instructionMd.length.toLocaleString()} /{" "}
          {maxInstructionMdLength.toLocaleString()} characters
        </p>
      </label>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
            className="h-4 w-4 rounded border-input accent-primary"
            disabled={busy}
          />
          {draft.enabled ? (
            <Power className="h-4 w-4 text-success" />
          ) : (
            <PowerOff className="h-4 w-4 text-muted-foreground" />
          )}
          Enabled
        </label>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!canSave}>
            <Save className="mr-2 h-4 w-4" />
            Save Command
          </Button>
        </div>
      </div>
    </Card>
  );
}

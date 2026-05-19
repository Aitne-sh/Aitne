"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import {
  useSkills,
  useSkill,
  useCreateSkill,
  useUpdateSkill,
  useDeleteSkill,
  useUploadSkill,
} from "@/lib/hooks/use-skills";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn, formatAbsoluteTime } from "@/lib/utils";
import {
  FileCode,
  Lock,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { ApiError } from "@/lib/api-client";

type Mode = "view" | "edit" | "new";

export function SkillsContent() {
  const { data, isLoading } = useSkills();
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<{
    name: string;
    description: string;
    content: string;
    allowedTools: string;
  }>({
    name: "",
    description: "",
    content: "",
    allowedTools: "",
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: detail } = useSkill(mode === "view" || mode === "edit" ? selected : null);
  const createMut = useCreateSkill();
  const updateMut = useUpdateSkill();
  const deleteMut = useDeleteSkill();
  const uploadMut = useUploadSkill();

  useEffect(() => {
    if (mode === "view" && detail) {
      setDraft({
        name: detail.name,
        description: detail.description,
        content: detail.content,
        allowedTools: detail.allowedTools.join("\n"),
      });
    }
  }, [detail, mode]);

  const userSkills = useMemo(
    () => data?.skills.filter((s) => !s.builtin) ?? [],
    [data],
  );
  const builtinSkills = useMemo(
    () => data?.skills.filter((s) => s.builtin) ?? [],
    [data],
  );

  const selectedIsBuiltin = detail?.builtin ?? false;

  const extractError = (err: unknown): string => {
    const e = err as ApiError | Error;
    if (e && "body" in e && e.body) {
      const body = e.body as { error?: string; message?: string };
      return body.message || body.error || e.message;
    }
    return (e as Error).message || "Unknown error";
  };

  const handleSelect = (name: string) => {
    setSelected(name);
    setMode("view");
    setErrorMsg(null);
  };

  const handleNew = () => {
    setSelected(null);
    setMode("new");
    setDraft({
      name: "",
      description: "",
      content: "# My Skill\n\nUse when ...\n",
      allowedTools: "",
    });
    setErrorMsg(null);
  };

  const handleEdit = () => {
    if (!detail || detail.builtin) return;
    setMode("edit");
    setErrorMsg(null);
  };

  const handleCancel = () => {
    setMode("view");
    setErrorMsg(null);
    if (detail) {
      setDraft({
        name: detail.name,
        description: detail.description,
        content: detail.content,
        allowedTools: detail.allowedTools.join("\n"),
      });
    }
  };

  const parseAllowedTools = (text: string): string[] =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

  const handleSave = async () => {
    setErrorMsg(null);
    try {
      const allowedTools = parseAllowedTools(draft.allowedTools);
      if (mode === "new") {
        await createMut.mutateAsync({
          name: draft.name.trim(),
          description: draft.description.trim(),
          content: draft.content,
          allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
        });
        setSelected(draft.name.trim());
        setMode("view");
      } else if (mode === "edit" && selected) {
        await updateMut.mutateAsync({
          name: selected,
          description: draft.description.trim(),
          content: draft.content,
          allowedTools,
        });
        setMode("view");
      }
    } catch (err) {
      setErrorMsg(extractError(err));
    }
  };

  const confirm = useConfirm();

  const handleDelete = async () => {
    if (!selected || selectedIsBuiltin) return;
    const ok = await confirm({
      title: `Delete skill "${selected}"?`,
      description: "This cannot be undone.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setErrorMsg(null);
    try {
      await deleteMut.mutateAsync(selected);
      setSelected(null);
      setMode("view");
    } catch (err) {
      setErrorMsg(extractError(err));
    }
  };

  const handleUpload = async (file: File) => {
    setErrorMsg(null);
    try {
      const res = await uploadMut.mutateAsync({ file });
      setSelected(res.name);
      setMode("view");
    } catch (err) {
      setErrorMsg(extractError(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const canSave =
    mode === "new"
      ? draft.name.trim().length > 0 &&
        draft.description.trim().length > 0 &&
        draft.content.trim().length > 0
      : draft.description.trim().length > 0 && draft.content.trim().length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Left panel — skill list */}
        <div className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Skills</h2>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              title="Upload .md file"
            >
              <Upload className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleNew} title="New skill">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,text/markdown"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
            }}
          />
        </div>

        <ScrollArea className="flex-1">
          <div className="space-y-0.5 p-2">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              User ({userSkills.length})
            </div>
            {userSkills.length === 0 && !isLoading && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                No user skills yet — click + to create one.
              </p>
            )}
            {userSkills.map((s) => (
              <SkillListItem
                key={s.name}
                name={s.name}
                description={s.description}
                active={selected === s.name && mode !== "new"}
                onClick={() => handleSelect(s.name)}
              />
            ))}
            <Separator className="my-2" />
            <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Lock className="h-2.5 w-2.5" />
              Built-in ({builtinSkills.length})
            </div>
            {builtinSkills.map((s) => (
              <SkillListItem
                key={s.name}
                name={s.name}
                description={s.description}
                builtin
                active={selected === s.name && mode !== "new"}
                onClick={() => handleSelect(s.name)}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

        {/* Right panel — detail / editor */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {mode === "new" ? (
            <EditorPanel
              title="New skill"
              draft={draft}
              setDraft={setDraft}
              showName
              onCancel={() => {
                setMode("view");
                setSelected(null);
                setErrorMsg(null);
              }}
              onSave={handleSave}
              saving={createMut.isPending}
              canSave={canSave}
              errorMsg={errorMsg}
            />
          ) : selected && detail ? (
            mode === "edit" ? (
              <EditorPanel
                title={`Edit: ${detail.name}`}
                draft={draft}
                setDraft={setDraft}
                showName={false}
                onCancel={handleCancel}
                onSave={handleSave}
                saving={updateMut.isPending}
                canSave={canSave}
                errorMsg={errorMsg}
              />
            ) : (
              <ViewPanel
                detail={detail}
                onEdit={handleEdit}
                onDelete={handleDelete}
                deleting={deleteMut.isPending}
                errorMsg={errorMsg}
              />
            )
          ) : (
            <SkillsEmptyState />
          )}
        </div>
      </div>
    </div>
  );
}

function SkillListItem({
  name,
  description,
  active,
  builtin,
  onClick,
}: {
  name: string;
  description: string;
  active: boolean;
  builtin?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <div className="flex items-center gap-1.5">
        {builtin ? <Lock className="h-3 w-3 shrink-0" /> : <FileCode className="h-3 w-3 shrink-0" />}
        <span className="truncate text-xs font-medium">{name}</span>
      </div>
      {description && (
        <span className="line-clamp-2 pl-4 text-[10px] leading-tight opacity-70">
          {description}
        </span>
      )}
    </button>
  );
}

function SkillsEmptyState() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Select a skill or create a new one.
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return <Alert variant="error">{message}</Alert>;
}

function ViewPanel({
  detail,
  onEdit,
  onDelete,
  deleting,
  errorMsg,
}: {
  detail: {
    name: string;
    description: string;
    content: string;
    allowedTools: string[];
    builtin: boolean;
    updatedAt: string;
  };
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
  errorMsg: string | null;
}) {
  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-foreground">{detail.name}</h1>
            {detail.builtin ? (
              <Badge variant="gray">
                <Lock className="mr-1 h-2.5 w-2.5" /> built-in
              </Badge>
            ) : (
              <Badge variant="blue">user</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Updated {formatAbsoluteTime(detail.updatedAt)}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {!detail.builtin && (
            <>
              <Button variant="outline" size="sm" onClick={onEdit}>
                Edit
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={onDelete}
                disabled={deleting}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-4 p-6">
          {errorMsg && <ErrorBanner message={errorMsg} />}
          {detail.description && (
            <div>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Description
              </h3>
              <p className="text-sm text-foreground">{detail.description}</p>
            </div>
          )}
          {detail.allowedTools.length > 0 && (
            <div>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Allowed tools
              </h3>
              <div className="flex flex-wrap gap-1">
                {detail.allowedTools.map((tool) => (
                  <Badge key={tool} variant="gray" className="font-mono text-[10px]">
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <div>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              SKILL.md body
            </h3>
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs text-foreground">
              {detail.content}
            </pre>
          </div>
        </div>
      </ScrollArea>
    </>
  );
}

interface Draft {
  name: string;
  description: string;
  content: string;
  allowedTools: string;
}

function EditorPanel({
  title,
  draft,
  setDraft,
  showName,
  onCancel,
  onSave,
  saving,
  canSave,
  errorMsg,
}: {
  title: string;
  draft: Draft;
  setDraft: (d: Draft) => void;
  showName: boolean;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
  errorMsg: string | null;
}) {
  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-base font-semibold text-foreground">{title}</h1>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            <X className="h-3.5 w-3.5" /> Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={!canSave || saving}>
            <Save className="h-3.5 w-3.5" /> {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-4 p-6">
          {errorMsg && <ErrorBanner message={errorMsg} />}
          {showName && (
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Name (kebab-case)
              </label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="my-new-skill"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Lowercase letters, digits, and hyphens only. 1-64 characters.
              </p>
            </div>
          )}
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Description
            </label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="One-line description the agent reads to decide when to load this skill"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Allowed tools (optional)
            </label>
            <textarea
              value={draft.allowedTools}
              onChange={(e) => setDraft({ ...draft, allowedTools: e.target.value })}
              className="min-h-[80px] w-full rounded-md border border-input bg-background p-3 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={"One per line, e.g.\nBash(curl *)\nRead"}
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Tool matchers in Claude Code format. Leave blank to inherit the agent&apos;s defaults.
            </p>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              SKILL.md body
            </label>
            <textarea
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              className="min-h-[400px] w-full rounded-md border border-input bg-background p-3 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="# Skill body&#10;&#10;Markdown content here. Frontmatter is injected automatically."
            />
          </div>
        </div>
      </ScrollArea>
    </>
  );
}

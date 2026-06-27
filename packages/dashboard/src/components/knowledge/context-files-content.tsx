"use client";

import { useEffect, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type {
  ContextFileResponse,
  SnapshotRestoreResponse,
} from "@/lib/api-types";
import {
  ContextConflictError,
  useContextFile,
  useContextList,
  useUpdateContextFile,
  type ContextConflict,
} from "@/lib/hooks/use-context";
import { useSearch } from "@/lib/hooks/use-search";
import {
  buildContextTree,
  selectionPathFor,
  type ContextTreeNode,
} from "./context-files-tree.logic";
import { useSnapshots, useSnapshotContent } from "@/lib/hooks/use-snapshots";
import { useRegenerate } from "@/lib/hooks/use-regenerate";
import { RegenerateButton } from "@/components/regenerate-button";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { FileConflictBanner } from "@/components/shared/file-conflict-banner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn, formatAbsoluteTime, formatShortDateTime, formatRelativeTime } from "@/lib/utils";
import {
  Search,
  File,
  FolderOpen,
  ChevronRight,
  Clock,
  Pencil,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
// react-markdown + remark-gfm are heavy. We only need them when a file
// is actively previewed, so split the renderer into its own chunk.
const MarkdownPreviewSkeleton = () => (
  <div className="max-w-3xl space-y-2 py-2" aria-hidden="true">
    {Array.from({ length: 5 }).map((_, i) => (
      <div
        key={i}
        className="h-4 animate-pulse rounded bg-muted/30"
        style={{ width: `${65 + ((i * 11) % 30)}%` }}
      />
    ))}
  </div>
);
const RenderedMarkdown = dynamic(
  () => import("./rendered-markdown").then((m) => m.RenderedMarkdown),
  { ssr: false, loading: MarkdownPreviewSkeleton },
);

/** Safely render text with <mark> highlights — strips all other HTML tags */
function HighlightedSnippet({ html }: { html: string }) {
  const parts = html.split(/(<mark>|<\/mark>)/);
  let inMark = false;
  const elements: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "<mark>") { inMark = true; continue; }
    if (parts[i] === "</mark>") { inMark = false; continue; }
    const text = parts[i].replace(/<[^>]*>/g, "");
    if (!text) continue;
    elements.push(
      inMark ? <mark key={i} className="bg-warning/15 rounded-sm px-0.5">{text}</mark> : text,
    );
  }
  return <>{elements}</>;
}

// Order matches the user-visible nav order on the Knowledge page.
const TOP_FILES = [
  "_index",
  "identity/profile",
  "identity/_index",
  "today",
  "yesterday",
  "roadmap",
  "policies/management",
  "policies/mcp",
  "policies/journal-format",
  "policies/journal-export",
  "policies/redaction",
  "journal/agent",
  "context-index",
];
// CONTEXT_VAULT_REDESIGN_PLAN §3.1 — six authority classes. Each entry
// here is a leaf directory accepted by `/api/context/list/:dir` (see
// `read.ts:allowedDirs`). Wider classes (`identity/` for example) are
// surfaced as single nodes since the API's flat-list output covers the
// whole sub-tree; deeper trees (`journal/*`, `state/*`, `plans/*`,
// `knowledge/*`, `policies/*`) are listed as their leaf sub-dirs so each
// shows up as its own collapsible section in the sidebar.
const DIRS = [
  "identity",
  "state/inbox",
  "plans/projects",
  "journal/daily",
  "journal/weekly",
  "journal/monthly",
  "knowledge/repos",
  "knowledge/dossiers",
  "policies",
  "policies/routines",
  "policies/management-captures",
];
const REGENERABLE_FILES = new Set(["today", "roadmap"]);
const SENSITIVE_FILES: Record<string, { filename: string; description: string }> = {
  "policies/management": {
    filename: "policies/management.md",
    description:
      "defines the agent's behavioral contract. Edits here can change how the agent acts.",
  },
  "journal/agent": {
    filename: "journal/agent.md",
    description:
      "is the agent's internal reflection journal — append-only from the Weekly Review routine. Manual edits can remove the agent's own improvement history and break the append-only contract. Prefer leaving it alone unless you are deliberately pruning noise.",
  },
};

function displayPathLabel(path: string): string {
  return path.endsWith(".base") ? path : `${path}.md`;
}

function FileTreeSubDir({
  node,
  topDir,
  selectedPath,
  onSelect,
}: {
  node: ContextTreeNode & { kind: "dir" };
  topDir: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const fullDirPath = `${topDir}/${node.relPath}`;
  const containsSelected = selectedPath?.startsWith(`${fullDirPath}/`) ?? false;
  const [open, setOpen] = useState(containsSelected);
  // Track selectedPath itself (not just inside-vs-outside) so that
  // navigating between siblings inside the same folder also re-opens it
  // when the user had manually closed it. Without this, a manual close
  // would hide the currently-selected file from the tree.
  const [prevSelectedPath, setPrevSelectedPath] = useState(selectedPath);
  if (selectedPath !== prevSelectedPath) {
    setPrevSelectedPath(selectedPath);
    if (containsSelected) setOpen(true);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
        />
        <FolderOpen className="h-3.5 w-3.5" />
        {node.name}/
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 space-y-0.5">
          {node.children.map((child) =>
            child.kind === "dir" ? (
              <FileTreeSubDir
                key={child.relPath}
                node={child}
                topDir={topDir}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ) : (
              <FileTreeItem
                key={child.relPath}
                name={child.name}
                active={selectedPath === selectionPathFor(topDir, child.relPath)}
                onClick={() => onSelect(selectionPathFor(topDir, child.relPath))}
              />
            ),
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function FileTreeDir({
  dir,
  selectedPath,
  onSelect,
}: {
  dir: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const { data } = useContextList(dir);
  const containsSelected = selectedPath?.startsWith(`${dir}/`) ?? false;
  const [open, setOpen] = useState(containsSelected);
  const [prevSelectedPath, setPrevSelectedPath] = useState(selectedPath);
  if (selectedPath !== prevSelectedPath) {
    setPrevSelectedPath(selectedPath);
    if (containsSelected) setOpen(true);
  }

  const tree = useMemo(() => {
    // CONTEXT_VAULT_REDESIGN_PLAN §5 — every class root carries an
    // `_index.md` table-of-contents. Skip it from the per-class flat
    // listing since it's already surfaced under TOP_FILES (or rendered
    // as part of the navigation sidebar elsewhere).
    const dirsWithOwnIndex = new Set([
      "identity",
      "policies",
      "policies/routines",
      "policies/management-captures",
      "plans/projects",
      "knowledge/dossiers",
    ]);
    const files =
      data?.files.filter(
        (f) => !(dirsWithOwnIndex.has(dir) && f.name === "_index.md"),
      ) ?? [];
    return buildContextTree(files);
  }, [data?.files, dir]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        <FolderOpen className="h-3.5 w-3.5" />
        {dir}/
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 space-y-0.5">
          {tree.map((node) =>
            node.kind === "dir" ? (
              <FileTreeSubDir
                key={node.relPath}
                node={node}
                topDir={dir}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ) : (
              <FileTreeItem
                key={node.relPath}
                name={node.name}
                active={selectedPath === selectionPathFor(dir, node.relPath)}
                onClick={() => onSelect(selectionPathFor(dir, node.relPath))}
              />
            ),
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function FileTreeItem({ name, active, onClick }: {
  name: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        active ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <File className="h-3.5 w-3.5" />
      {name}
    </button>
  );
}

export interface ContextFilesHandle {
  isDirty: () => boolean;
  confirmDiscard: () => Promise<boolean>;
}

export const ContextFilesContent = forwardRef<ContextFilesHandle>(
  function ContextFilesContent(_props, ref) {
  // Honor `?path=<relative>` so deep-links (e.g. "Open overview.md" /
  // "Open today's journal" buttons on the git management section) land on
  // a specific file instead of the default `identity/profile`. The route
  // accepts paths without the `.md` extension; strip it defensively in
  // case a link carries one anyway.
  const searchParams = useSearchParams();
  const urlPath = (() => {
    const raw = searchParams?.get("path");
    return raw ? raw.replace(/\.(md|base)$/i, "") : null;
  })();
  const [selectedPath, setSelectedPath] = useState<string | null>(
    urlPath ?? "identity/profile",
  );
  // Re-sync when the URL path changes after mount (Next.js keeps the page
  // mounted across client-side navigations). Using the "set state during
  // render" pattern avoids the `react-hooks/set-state-in-effect` lint
  // and is the React-recommended way to reset derived state.
  const [prevUrlPath, setPrevUrlPath] = useState<string | null>(urlPath);
  if (urlPath !== prevUrlPath) {
    setPrevUrlPath(urlPath);
    if (urlPath) setSelectedPath(urlPath);
  }
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [snapshotId, setSnapshotId] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [baselineContent, setBaselineContent] = useState("");
  const [baselineMtime, setBaselineMtime] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ContextConflict | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: fileData } = useContextFile(selectedPath, { enabled: !isEditing });
  const { data: searchData } = useSearch(isSearching ? searchQuery : "");
  const { data: snapshotsData } = useSnapshots(selectedPath);
  const { data: snapshotContent } = useSnapshotContent(snapshotId);
  const { regenerate, target: regenTarget, status: regenStatus, error: regenError, dismiss } = useRegenerate();
  const updateFile = useUpdateContextFile();
  const queryClient = useQueryClient();

  const confirm = useConfirm();
  const isDirty = isEditing && draft !== baselineContent;

  // Expose isDirty + confirm discard to parent for tab-switch guarding
  useImperativeHandle(ref, () => ({
    isDirty: () => isDirty,
    confirmDiscard: async () => {
      if (!isDirty) return true;
      return confirm({
        title: "Discard unsaved changes?",
        description: "Your edits will be lost if you switch tabs.",
        confirmLabel: "Discard",
        variant: "destructive",
      });
    },
  }));

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.length >= 2) setIsSearching(true);
  };

  const clearSearch = () => {
    setIsSearching(false);
    setSearchQuery("");
  };

  const confirmDiscardIfDirty = async (): Promise<boolean> => {
    if (!isDirty) return true;
    return confirm({
      title: "Discard unsaved changes?",
      description: "Your edits will be lost.",
      confirmLabel: "Discard",
      variant: "destructive",
    });
  };

  const selectPath = async (path: string) => {
    if (!(await confirmDiscardIfDirty())) return;
    setSelectedPath(path);
    setSnapshotId(null);
    setIsEditing(false);
    setDraft("");
    setBaselineContent("");
    setBaselineMtime("");
    setSaveError(null);
    setConflict(null);
    clearSearch();
  };

  const startEditing = () => {
    if (!fileData) return;
    setDraft(fileData.content);
    setBaselineContent(fileData.content);
    setBaselineMtime(fileData.lastModified);
    setSaveError(null);
    setConflict(null);
    setIsEditing(true);
  };

  const cancelEditing = async () => {
    if (!(await confirmDiscardIfDirty())) return;
    setIsEditing(false);
    setSaveError(null);
    setConflict(null);
    setDraft("");
    setBaselineContent("");
    setBaselineMtime("");
  };

  const flashSaved = () => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2000);
  };

  const performSave = async (
    content: string,
    expectedMtime: string,
  ): Promise<boolean> => {
    if (!selectedPath) return false;
    setSaveError(null);
    try {
      await updateFile.mutateAsync({
        path: selectedPath,
        content,
        expectedMtime,
      });
      setIsEditing(false);
      setDraft("");
      setBaselineContent("");
      setBaselineMtime("");
      setConflict(null);
      flashSaved();
      return true;
    } catch (err) {
      if (err instanceof ContextConflictError) {
        setConflict(err.conflict);
        return false;
      }
      if (err instanceof ApiError) {
        const body = err.body as Record<string, unknown> | null;
        const detail = typeof body?.error === "string" ? body.error : null;
        setSaveError(
          detail === "forbidden"
            ? "This file is read-only — it's not in the daemon's write whitelist."
            : detail === "morning_routine_lock_held"
              ? "state/today.md is locked by the morning routine. Please try again shortly."
              : detail === "validation_error"
                ? "Content failed validation."
                : `Save failed: ${err.message}`,
        );
      } else {
        setSaveError(err instanceof Error ? err.message : "Save failed");
      }
      return false;
    }
  };

  const saveEdit = () => performSave(draft, baselineMtime);

  const overwriteWithMyEdits = async () => {
    if (!conflict) return;
    await performSave(draft, conflict.currentMtime);
  };

  const reloadFromConflict = () => {
    if (!conflict) return;
    setDraft(conflict.currentContent);
    setBaselineContent(conflict.currentContent);
    setBaselineMtime(conflict.currentMtime);
    setConflict(null);
    setSaveError(null);
  };

  const viewSnapshot = async (id: number) => {
    if (isEditing && !(await confirmDiscardIfDirty())) return;
    if (isEditing) {
      setIsEditing(false);
      setDraft("");
      setBaselineContent("");
      setBaselineMtime("");
      setSaveError(null);
      setConflict(null);
    }
    setSnapshotId(id);
  };

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (draft !== baselineContent && !updateFile.isPending) {
        void saveEdit();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      void cancelEditing();
    }
  };

  useEffect(() => {
    if (isEditing) textareaRef.current?.focus();
  }, [isEditing]);

  const viewingSnapshot = snapshotId !== null;
  const canEdit = !!selectedPath && !viewingSnapshot && fileData?.editable === true;
  const canRestoreSnapshot =
    !!selectedPath &&
    viewingSnapshot &&
    !!snapshotContent &&
    fileData?.editable === true;

  const displayContent = snapshotId && snapshotContent
    ? snapshotContent.content
    : fileData?.content;

  const restoreSnapshot = async () => {
    if (!selectedPath || !snapshotContent || snapshotId === null) return;
    const ok = await confirm({
      title: "Restore this snapshot?",
      description:
        `This will overwrite ${displayPathLabel(selectedPath)} with the snapshot from ${formatAbsoluteTime(snapshotContent.created_at)}. The current on-disk version will be backed up as a new snapshot first.`,
      confirmLabel: "Restore snapshot",
      variant: "destructive",
    });
    if (!ok) return;

    setSaveError(null);
    try {
      const res = await api.post<SnapshotRestoreResponse>(
        `/context/restore-snapshot/${snapshotId}`,
      );
      queryClient.setQueryData<ContextFileResponse>(["context", selectedPath], (prev) =>
        prev
          ? {
              ...prev,
              content: snapshotContent.content,
              lastModified: res.lastModified,
            }
          : {
              content: snapshotContent.content,
              lastModified: res.lastModified,
              editable: true,
            },
      );
      queryClient.invalidateQueries({ queryKey: ["snapshots", selectedPath] });
      setSnapshotId(null);
      setConflict(null);
      flashSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as Record<string, unknown> | null;
        const detail = typeof body?.error === "string" ? body.error : null;
        setSaveError(
          detail === "morning_routine_lock_held"
            ? "state/today.md is locked by the morning routine. Please try again shortly."
            : detail === "forbidden"
              ? "This snapshot cannot be restored because the file is not writable."
              : detail === "validation_error"
                ? "Snapshot restore was rejected because the stored content no longer passes validation."
                : `Restore failed: ${err.message}`,
        );
      } else {
        setSaveError(err instanceof Error ? err.message : "Restore failed");
      }
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Left panel — file tree */}
      <div className="flex w-64 shrink-0 flex-col border-r border-border min-h-0">
        <div className="border-b border-border p-4">
          <h2 className="text-sm font-semibold text-foreground">Context Files</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Have a file to bring in?{" "}
            <a href="/knowledge?tab=upload" className="underline">
              Upload
            </a>
          </p>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-0.5 p-2">
            {TOP_FILES.map((f) => (
              <FileTreeItem
                key={f}
                name={displayPathLabel(f)}
                active={selectedPath === f}
                onClick={() => selectPath(f)}
              />
            ))}
            <div className="my-2 h-px bg-border" />
            {DIRS.map((d) => (
              <FileTreeDir
                key={d}
                dir={d}
                selectedPath={selectedPath}
                onSelect={selectPath}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Right panel */}
      <div className="flex flex-1 flex-col">
        {/* Search bar */}
        <form onSubmit={handleSearch} className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); if (e.target.value.length < 2) setIsSearching(false); }}
            placeholder="Search actions and messages..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {isSearching && (
            <Button variant="ghost" size="sm" onClick={clearSearch}>
              Clear
            </Button>
          )}
        </form>

        {/* Content area */}
        <ScrollArea className="flex-1">
          {isSearching && searchData ? (
            <div className="space-y-4 p-4">
              <h3 className="text-sm font-semibold text-foreground">
                Search Results for &ldquo;{searchQuery}&rdquo;
              </h3>
              {searchData.actions.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-medium text-muted-foreground">Actions</h4>
                  {searchData.actions.map((a) => (
                    <div key={a.id} className="rounded-md border border-border p-2 mb-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="blue">{a.action_type}</Badge>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-xs font-mono tabular-nums text-muted-foreground">{formatShortDateTime(a.started_at)}</span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {formatAbsoluteTime(a.started_at)} ({formatRelativeTime(a.started_at)})
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="mt-1 text-sm"><HighlightedSnippet html={a.snippet} /></p>
                    </div>
                  ))}
                </div>
              )}
              {searchData.messages.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-medium text-muted-foreground">Messages</h4>
                  {searchData.messages.map((m) => (
                    <div key={m.id} className="rounded-md border border-border p-2 mb-2">
                      <div className="flex items-center gap-2">
                        <Badge variant={m.role === "user" ? "blue" : "gray"}>{m.role}</Badge>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-xs font-mono tabular-nums text-muted-foreground">{formatShortDateTime(m.timestamp)}</span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {formatAbsoluteTime(m.timestamp)} ({formatRelativeTime(m.timestamp)})
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="mt-1 text-sm"><HighlightedSnippet html={m.snippet} /></p>
                    </div>
                  ))}
                </div>
              )}
              {searchData.actions.length === 0 && searchData.messages.length === 0 && (
                <p className="text-sm text-muted-foreground">No results found</p>
              )}
            </div>
          ) : (
            <div className="p-4">
              {/* Metadata bar */}
              {selectedPath && fileData && (
                <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="font-mono">{displayPathLabel(selectedPath)}</span>
                  <span>
                    Last modified:{" "}
                    {formatAbsoluteTime(
                      isEditing ? baselineMtime : fileData.lastModified,
                    )}
                  </span>
                  {savedFlash && (
                    <span className="flex items-center gap-1 font-medium text-success">
                      <CheckCircle2 className="h-3 w-3" />
                      Saved
                    </span>
                  )}
                  {isDirty && !conflict && (
                    <Badge variant="gray" className="text-[10px]">
                      Unsaved
                    </Badge>
                  )}
                  {viewingSnapshot && (
                    <Button variant="ghost" size="sm" onClick={() => setSnapshotId(null)}>
                      Back to current
                    </Button>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {canRestoreSnapshot && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void restoreSnapshot()}
                        className="h-7 gap-1 text-xs"
                      >
                        <Clock className="h-3 w-3" />
                        Restore snapshot
                      </Button>
                    )}
                    {REGENERABLE_FILES.has(selectedPath) && !viewingSnapshot && !isEditing && (
                      <RegenerateButton
                        target={selectedPath as "today" | "roadmap"}
                        label="Regenerate"
                        currentTarget={regenTarget}
                        status={regenStatus}
                        error={regenError}
                        onRegenerate={regenerate}
                        onDismiss={dismiss}
                        className="text-xs"
                      />
                    )}
                    {canEdit && !isEditing && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={startEditing}
                        className="h-7 gap-1 text-xs"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </Button>
                    )}
                    {isEditing && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={cancelEditing}
                          disabled={updateFile.isPending}
                          className="h-7 text-xs"
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={saveEdit}
                          disabled={
                            updateFile.isPending ||
                            !isDirty ||
                            conflict !== null
                          }
                          className="h-7 text-xs"
                        >
                          {updateFile.isPending ? "Saving..." : "Save"}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Sensitive file warning */}
              {isEditing && selectedPath && SENSITIVE_FILES[selectedPath] && (
                <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>
                    This file (
                    <code className="font-mono">
                      {SENSITIVE_FILES[selectedPath].filename}
                    </code>
                    ) {SENSITIVE_FILES[selectedPath].description}
                  </span>
                </div>
              )}

              {saveError && (
                <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {saveError}
                </div>
              )}

              {conflict && (
                <FileConflictBanner
                  className="mb-3"
                  onReload={reloadFromConflict}
                  onOverwrite={overwriteWithMyEdits}
                  isPending={updateFile.isPending}
                  reloadLabel="Reload latest and re-edit"
                />
              )}

              {/* Content — markdown preview or editable textarea */}
              {isEditing ? (
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  spellCheck={false}
                  className="min-h-[60vh] w-full max-w-3xl resize-y rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              ) : displayContent ? (
                <RenderedMarkdown content={displayContent} />
              ) : (
                <p className="text-muted-foreground">Select a file to view</p>
              )}
            </div>
          )}
        </ScrollArea>

        {/* Snapshot history */}
        {selectedPath && snapshotsData && snapshotsData.snapshots.length > 0 && !isSearching && (
          <Collapsible>
            <CollapsibleTrigger className="flex w-full items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground hover:bg-accent">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Snapshots ({snapshotsData.snapshots.length})
              </span>
              <ChevronRight className="h-3 w-3" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="max-h-40 overflow-y-auto border-t border-border">
                {snapshotsData.snapshots.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => viewSnapshot(s.id)}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-1.5 text-xs hover:bg-accent",
                      snapshotId === s.id && "bg-primary/10",
                    )}
                  >
                    <span className="text-muted-foreground">{formatAbsoluteTime(s.created_at)}</span>
                    <Badge variant="gray">{s.trigger}</Badge>
                    {s.session_id && (
                      <span className="font-mono text-muted-foreground">{String(s.session_id).slice(0, 8)}</span>
                    )}
                  </button>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
});


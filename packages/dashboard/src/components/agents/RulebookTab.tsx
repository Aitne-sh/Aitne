"use client";

import { useEffect, useState } from "react";
import { BookOpenText } from "lucide-react";
import { ApiError } from "@/lib/api-client";
import type { ContextFileResponse } from "@/lib/api-types";
import {
  ContextConflictError,
  useContextFile,
  useUpdateContextFile,
} from "@/lib/hooks/use-context";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { FileConflictBanner } from "@/components/shared/file-conflict-banner";
import { formatAbsoluteTime } from "@/lib/utils";
import type { AgentPolicyFile } from "@/lib/agents/types";

/**
 * Rulebook tab of `/agents/[slug]` (AGENTS_HUB_REDESIGN_PLAN §4.2): one editor
 * card per vault policy file the Agent reads at prompt-assembly time. The
 * files stay in the context vault — loads/saves go through `/api/context/`
 * with `expectedMtime` optimistic concurrency, the same mechanics the former
 * /settings/routines editors used (the agent itself and Obsidian co-edit
 * these files, so the conflict flow matters).
 */
export function RulebookTab({
  agentName,
  files,
}: {
  agentName: string;
  files: AgentPolicyFile[];
}) {
  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <BookOpenText className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          These files are injected into <strong>{agentName}</strong>&apos;s prompt when it runs.
          They live in your context vault — the agent (and Obsidian, if your vault is one) can
          edit them too, so a conflict prompt may appear if the file changed under you.
        </span>
      </p>
      {files.map((file) => (
        <PolicyFileEditor key={file.path} file={file} />
      ))}
    </div>
  );
}

/** Context-API path for a declared policy file (the API takes no `.md`). */
function apiPath(file: AgentPolicyFile): string {
  return file.path.replace(/\.md$/, "");
}

function PolicyFileEditor({ file }: { file: AgentPolicyFile }) {
  const query = useContextFile(apiPath(file));

  if (query.isLoading) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading {file.path}…</p>
      </Card>
    );
  }

  if (query.error || !query.data) {
    const status = (query.error as ApiError | undefined)?.status;
    if (status === 404) {
      return (
        <Card className="p-4">
          <p className="text-sm font-semibold">{file.label}</p>
          <p className="pt-1 text-sm text-muted-foreground">
            <code>{file.path}</code> does not exist yet. It is created by the setup wizard or by
            a clean reinstall.
          </p>
        </Card>
      );
    }
    return (
      <Card className="p-4">
        <p className="text-sm text-destructive">
          Failed to load {file.path}:{" "}
          {(query.error as Error | undefined)?.message ?? "unknown error"}
        </p>
      </Card>
    );
  }

  return (
    <LoadedPolicyEditor
      key={file.path}
      file={file}
      initial={query.data}
      editable={query.data.editable !== false}
    />
  );
}

function LoadedPolicyEditor({
  file,
  initial,
  editable,
}: {
  file: AgentPolicyFile;
  initial: ContextFileResponse;
  editable: boolean;
}) {
  const [draft, setDraft] = useState(initial.content);
  const [baseline, setBaseline] = useState({
    content: initial.content,
    mtime: initial.lastModified,
  });
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ mtime: string; content: string } | null>(null);
  const update = useUpdateContextFile();

  const dirty = draft !== baseline.content;

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const performSave = async (expectedMtime: string) => {
    setError(null);
    try {
      const res = await update.mutateAsync({
        path: apiPath(file),
        content: draft,
        expectedMtime,
      });
      setBaseline({ content: draft, mtime: res.lastModified });
      setConflict(null);
      setToast("Saved — applies on the next run.");
      window.setTimeout(() => setToast(null), 2500);
    } catch (err) {
      if (err instanceof ContextConflictError) {
        setConflict({
          mtime: err.conflict.currentMtime,
          content: err.conflict.currentContent,
        });
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError((err as Error).message);
      }
    }
  };

  const handleSave = () => void performSave(baseline.mtime);
  const handleOverwrite = () => {
    if (conflict) void performSave(conflict.mtime);
  };
  const handleReloadLatest = () => {
    if (!conflict) return;
    setDraft(conflict.content);
    setBaseline({ content: conflict.content, mtime: conflict.mtime });
    setConflict(null);
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && editable && !update.isPending) handleSave();
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardHeader className="flex flex-row items-start justify-between gap-4 p-0 pb-0">
        <div className="flex-1">
          <CardTitle className="text-sm font-semibold">{file.label}</CardTitle>
          <p className="max-w-prose pt-1 text-xs text-muted-foreground">{file.description}</p>
          <p className="pt-1 text-[11px] text-muted-foreground">
            <code className="font-mono">{file.path}</code> · Last modified:{" "}
            {formatAbsoluteTime(baseline.mtime)}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!dirty || !editable || update.isPending || conflict !== null}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </CardHeader>

      {conflict && (
        <FileConflictBanner
          onReload={handleReloadLatest}
          onOverwrite={handleOverwrite}
          isPending={update.isPending}
        />
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={!editable}
        spellCheck={false}
        aria-label={`${file.label} content`}
        className="min-h-[360px] w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
      />

      {toast && <p className="text-xs text-muted-foreground">{toast}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Card>
  );
}

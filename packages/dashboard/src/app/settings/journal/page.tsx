"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api-client";
import type { ContextFileResponse } from "@/lib/api-types";
import {
  ContextConflictError,
  useContextFile,
  useUpdateContextFile,
} from "@/lib/hooks/use-context";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { FileConflictBanner } from "@/components/shared/file-conflict-banner";
import { formatAbsoluteTime } from "@/lib/utils";

/**
 * Co-edit the two natural-language rule files that drive the 04:00 daily
 * journal synthesis:
 *
 *  - `policies/journal-format.md` defines the format template (sections, voice,
 *    frontmatter). The morning routine reads it when writing
 *    `daily/YYYY-MM-DD.md`.
 *  - `policies/journal-export.md` defines inclusion / exclusion / redaction for
 *    the external export (if opted-in).
 *
 * Both files are user-editable prose. Saves go through `PUT /api/context/`
 * with optimistic concurrency via `expectedMtime`.
 */

type FileKind = "format" | "export";

interface JournalFile {
  key: FileKind;
  label: string;
  path: string;
  description: string;
}

const FILES: JournalFile[] = [
  {
    key: "format",
    label: "Journal Format",
    path: "policies/journal-format",
    description:
      "Controls how the agent writes daily/YYYY-MM-DD.md during the morning routine. Edit the sections, voice, or required frontmatter here — changes take effect on the next synthesis run.",
  },
  {
    key: "export",
    label: "Journal Export",
    path: "policies/journal-export",
    description:
      "Injected into the morning-routine prompt alongside Journal Format. Use this to pin redaction rules, excluded sections, or required inclusions the agent should honor on every synthesis run, regardless of whether an external export pipeline is configured.",
  },
];

export default function JournalSettingsPage() {
  const [tab, setTab] = useState<FileKind>("format");

  return (
    <>
      <PageHeader
        title="Journal"
        description="Rule files the morning routine reads when synthesizing the daily journal. Both Format and Export are injected into the morning-routine prompt — use Export to record redaction and inclusion rules the agent should follow on every synthesis run."
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as FileKind)}>
        <TabsList>
          {FILES.map((f) => (
            <TabsTrigger key={f.key} value={f.key}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {FILES.map((f) => (
          // `forceMount` keeps the inactive panel in the DOM (Radix hides it
          // via `hidden`). Without it the draft for the non-visible tab
          // would be lost silently on every switch.
          <TabsContent
            key={f.key}
            value={f.key}
            forceMount
            className="pt-3 data-[state=inactive]:hidden"
          >
            <JournalFileEditor file={f} />
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

function JournalFileEditor({ file }: { file: JournalFile }) {
  const query = useContextFile(file.path);

  if (query.isLoading) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Card>
    );
  }

  if (query.error || !query.data) {
    const status = (query.error as ApiError | undefined)?.status;
    if (status === 404) {
      return (
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">
            <code>{file.path}.md</code> does not exist yet. It is created by
            the setup wizard or by running a clean reinstall from Advanced →
            Danger Zone.
          </p>
        </Card>
      );
    }
    return (
      <Card className="p-4">
        <p className="text-sm text-destructive">
          Failed to load {file.path}.md:{" "}
          {(query.error as Error | undefined)?.message ?? "unknown error"}
        </p>
      </Card>
    );
  }

  return (
    <LoadedEditor
      key={file.path}
      file={file}
      initial={query.data}
      editable={query.data.editable !== false}
    />
  );
}

function LoadedEditor({
  file,
  initial,
  editable,
}: {
  file: JournalFile;
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
  const [conflict, setConflict] = useState<{ mtime: string; content: string } | null>(
    null,
  );
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
        path: file.path,
        content: draft,
        expectedMtime,
      });
      setBaseline({ content: draft, mtime: res.lastModified });
      setConflict(null);
      setToast("Saved.");
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

  const handleSave = () => performSave(baseline.mtime);
  const handleOverwrite = () => {
    if (!conflict) return;
    void performSave(conflict.mtime);
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
      if (dirty && editable && !update.isPending) void handleSave();
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardHeader className="flex flex-row items-start justify-between gap-4 p-0 pb-0">
        <div className="flex-1">
          <CardTitle className="text-sm font-semibold">
            {file.path}.md
          </CardTitle>
          <p className="pt-1 text-xs text-muted-foreground max-w-prose">
            {file.description}
          </p>
          <p className="pt-1 text-[11px] text-muted-foreground">
            Last modified: {formatAbsoluteTime(baseline.mtime)}
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
        className="min-h-[540px] w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
      />

      {toast && <p className="text-xs text-muted-foreground">{toast}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Card>
  );
}

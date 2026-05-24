"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, FileText, PowerOff, HelpCircle } from "lucide-react";
import { ApiError } from "@/lib/api-client";
import type { ContextFileResponse } from "@/lib/api-types";
import {
  ContextConflictError,
  useContextFile,
  useUpdateContextFile,
} from "@/lib/hooks/use-context";
import { useMcpServers } from "@/lib/hooks/use-mcp";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { FileConflictBanner } from "@/components/shared/file-conflict-banner";
import { formatAbsoluteTime } from "@/lib/utils";
import {
  scanMcpRulesForStaleReferences,
  type McpStaleRuleWarning,
} from "./mcp-stale-rule-warnings";

/**
 * B-003 Phase 3 — editor for `rules/mcp.md`.
 *
 * The file is the narrative policy the agent consults when deciding *when*
 * to call a given MCP tool. Schema lives in B-006; path + injector in B-007
 * Phase 1. B-003 only owns this editor surface.
 *
 * Writes go through PUT /api/context/rules/mcp via the shared
 * `useUpdateContextFile` hook (same optimistic-concurrency path the Journal
 * editor uses). When the agent writes to the file mid-edit, a 409 surfaces
 * the conflict so the user can reload or overwrite.
 */
const PATH = "rules/mcp";

export function McpRulesEditor() {
  const query = useContextFile(PATH);

  if (query.isLoading) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading rules/mcp.md…</p>
      </Card>
    );
  }

  if (query.error || !query.data) {
    const status = (query.error as ApiError | undefined)?.status;
    if (status === 404) {
      return <MissingRulesFile />;
    }
    return (
      <Card className="p-4">
        <p className="text-sm text-destructive">
          Failed to load rules/mcp.md:{" "}
          {(query.error as Error | undefined)?.message ?? "unknown error"}
        </p>
      </Card>
    );
  }

  return (
    <LoadedEditor
      initial={query.data}
      editable={query.data.editable !== false}
    />
  );
}

function MissingRulesFile() {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <FileText className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="space-y-1 text-sm">
          <p className="font-medium text-foreground">
            <code>rules/mcp.md</code> has not been created yet.
          </p>
          <p className="text-muted-foreground">
            Add your first rule by editing this file. It will be created on
            save and injected into every task-flow prompt while at least one
            MCP server is enabled. Until then the agent treats each tool on
            its own merits without a curated preference order.
          </p>
          <CreateEmptyRulesFile />
        </div>
      </div>
    </Card>
  );
}

function CreateEmptyRulesFile() {
  const update = useUpdateContextFile();
  const [error, setError] = useState<string | null>(null);
  const handleCreate = async () => {
    setError(null);
    try {
      await update.mutateAsync({
        path: PATH,
        content: DEFAULT_RULES_TEMPLATE,
      });
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : "Failed to create rules/mcp.md",
      );
    }
  };
  return (
    <div className="pt-2">
      <Button
        size="sm"
        variant="outline"
        onClick={handleCreate}
        disabled={update.isPending}
        className="h-7 text-xs"
      >
        {update.isPending ? "Creating…" : "Create rules/mcp.md"}
      </Button>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

const DEFAULT_RULES_TEMPLATE = `# MCP management rules

This file governs how the agent uses the configured MCP servers. Rules here
override general tool-selection heuristics. Edit in the dashboard or DM the
agent with "from now on, use …"; both writes land in this same file.

## Current preferences

- (Empty — add rules as you configure MCPs.)
`;

function LoadedEditor({
  initial,
  editable,
}: {
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
  const serversQuery = useMcpServers();

  const dirty = draft !== baseline.content;

  // Stale-rule detection runs against the draft (not the saved baseline)
  // so warnings update live as the user edits. A rule
  // that becomes stale only after save still shows up because `draft`
  // equals the baseline in that state.
  const staleWarnings = useMemo<McpStaleRuleWarning[]>(() => {
    const servers = serversQuery.data?.servers;
    if (!servers) return [];
    return scanMcpRulesForStaleReferences(draft, servers);
  }, [draft, serversQuery.data?.servers]);

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
        path: PATH,
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
            MCP management rules (<code>rules/mcp.md</code>)
          </CardTitle>
          <p className="pt-1 text-xs text-muted-foreground max-w-prose">
            Plain-prose rules the agent reads before every MCP-enabled task
            flow. Use this to prefer one server over another, to restrict
            destructive tools to explicit user approval, or to document
            per-server idioms. The agent also writes here when you DM it
            &ldquo;from now on, use X for Y&rdquo;.
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

      {staleWarnings.length > 0 && <StaleRuleBanner warnings={staleWarnings} />}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={!editable}
        spellCheck={false}
        className="min-h-[360px] w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
      />

      {toast && <p className="text-xs text-muted-foreground">{toast}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Card>
  );
}

/**
 * B-003 Phase 4 — inline warning surface for stale references in the rules
 * body. We never mutate the file on the user's behalf — disabled-server
 * references may be intentional (e.g. "the user will re-enable monday after
 * billing") and unknown-id references may be typos. Surface, don't silently
 * fix.
 */
function StaleRuleBanner({ warnings }: { warnings: McpStaleRuleWarning[] }) {
  const disabled = warnings.filter((w) => w.severity === "disabled");
  const unknown = warnings.filter((w) => w.severity === "unknown");
  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5" />
        Rules reference {warnings.length} server{warnings.length === 1 ? "" : "s"} that
        {warnings.length === 1 ? " is" : " are"} not currently active
      </div>
      {disabled.length > 0 && (
        <p className="mt-1 flex items-start gap-1.5 text-amber-900/90 dark:text-amber-100/90">
          <PowerOff className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            <span className="font-medium">Disabled:</span>{" "}
            {disabled.map((w) => (
              <code
                key={w.id}
                className="mx-0.5 rounded bg-amber-500/20 px-1 py-0.5"
              >
                {w.id}
              </code>
            ))}
            — the agent will ignore these rules while the servers stay disabled.
          </span>
        </p>
      )}
      {unknown.length > 0 && (
        <p className="mt-1 flex items-start gap-1.5 text-amber-900/90 dark:text-amber-100/90">
          <HelpCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            <span className="font-medium">Unknown:</span>{" "}
            {unknown.map((w) => (
              <code
                key={w.id}
                className="mx-0.5 rounded bg-amber-500/20 px-1 py-0.5"
              >
                {w.id}
              </code>
            ))}
            — no MCP server with this ID exists. Likely a typo or a server that
            was deleted.
          </span>
        </p>
      )}
    </div>
  );
}

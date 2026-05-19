"use client";

/**
 * Phase 5 (P5 §"User-defined triggers") — owner-facing editor for the
 * per-event task-flow override file at
 * `<dataDir>/task-flows/<key>.md`. The bundled body ships read-only on
 * the side; the owner edits the override on the right and saves to
 * `PUT /api/task-flows/<key>`. Resetting calls `DELETE` and lets the
 * dispatcher fall back to the bundled body.
 *
 * Scope: filtered to `git.*` and `github.*` keys here so the card
 * matches its host page (`/connections/repositories`). Other connections
 * pages can compose the same component with a different filter
 * predicate as they ship.
 */

import { useMemo, useState } from "react";
import { FilePen, RotateCcw, Save } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConnectionCard, deriveConfiguredStatus } from "./connection-card";
import {
  useDeleteTaskFlowOverride,
  useTaskFlowDetail,
  useTaskFlows,
  useUpsertTaskFlow,
} from "@/lib/hooks/use-task-flows";

const KEY_PREFIX_FILTERS = ["git.", "github."];

export function TaskFlowOverridesCard() {
  const list = useTaskFlows();
  const flows = useMemo(() => {
    const all = list.data?.flows ?? [];
    return all.filter((f) =>
      KEY_PREFIX_FILTERS.some((prefix) => f.key.startsWith(prefix)),
    );
  }, [list.data]);

  // `null` until the user (or the implicit "first key" default below)
  // picks a row. Derivation in render avoids cascading setState-in-effect.
  const [explicitKey, setExplicitKey] = useState<string | null>(null);
  const selectedKey =
    explicitKey ?? (flows.length > 0 ? flows[0].key : null);

  const detail = useTaskFlowDetail(selectedKey);
  const upsert = useUpsertTaskFlow();
  const removeOverride = useDeleteTaskFlowOverride();

  // Draft state keyed on the active row. When the user switches keys we
  // remount the editor via the `key` prop instead of poking state from
  // an effect, so React's setState-in-effect lint stays clean.
  const [draftByKey, setDraftByKey] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const draft = selectedKey
    ? (draftByKey[selectedKey]
      ?? detail.data?.override
      ?? detail.data?.bundled
      ?? "")
    : "";
  const setDraft = (next: string) => {
    if (!selectedKey) return;
    setDraftByKey((prev) => ({ ...prev, [selectedKey]: next }));
  };
  const draftDirty = selectedKey
    ? draftByKey[selectedKey] !== undefined
      && draftByKey[selectedKey] !== (detail.data?.override ?? "")
    : false;

  const overrideCount = flows.filter((f) => f.hasOverride).length;

  const onSave = async () => {
    if (!selectedKey) return;
    setError(null);
    try {
      await upsert.mutateAsync({ key: selectedKey, content: draft });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save override");
    }
  };

  const onResetToBundled = async () => {
    if (!selectedKey) return;
    setError(null);
    try {
      await removeOverride.mutateAsync(selectedKey);
      // Drop the local-only draft so the textarea re-derives from the
      // newly-bundled state on the next render.
      setDraftByKey((prev) => {
        const next = { ...prev };
        delete next[selectedKey];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset");
    }
  };

  return (
    <ConnectionCard
      name="Task Flow Overrides"
      icon={<FilePen className="h-4 w-4" />}
      status={deriveConfiguredStatus(overrideCount > 0)}
    >
      <div className="mt-2 space-y-3">
        <p className="text-xs text-muted-foreground">
          Override the prompt body the dispatcher uses for a Git/GitHub
          event. The bundled body stays read-only on the left; your
          edits land at <code className="rounded bg-muted px-1">~/.personal-agent/task-flows/&lt;key&gt;.md</code>
          {" "}and take effect on the next session. Resetting falls back to bundled.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedKey ?? ""}
            onChange={(e) => setExplicitKey(e.target.value || null)}
            className="h-9 min-w-[260px] rounded border bg-background px-2 text-sm"
            disabled={flows.length === 0}
          >
            {flows.length === 0 && <option value="">No git.* / github.* keys</option>}
            {flows.map((f) => (
              <option key={f.key} value={f.key}>
                {f.key}
                {f.hasOverride ? "  ★" : ""}
              </option>
            ))}
          </select>
          {detail.data?.hasOverride && <Badge variant="green">overridden</Badge>}
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Bundled (read-only)
            </p>
            <textarea
              value={detail.data?.bundled ?? ""}
              readOnly
              className="h-72 w-full resize-none rounded border bg-muted p-2 font-mono text-xs"
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Override (edit and save)
            </p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-72 w-full resize-none rounded border bg-background p-2 font-mono text-xs"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onSave}
            disabled={!selectedKey || upsert.isPending || !draftDirty}
          >
            <Save className="mr-1 h-3.5 w-3.5" />
            Save override
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onResetToBundled}
            disabled={
              !selectedKey
              || removeOverride.isPending
              || !detail.data?.hasOverride
            }
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            Reset to bundled
          </Button>
        </div>
      </div>
    </ConnectionCard>
  );
}

export default TaskFlowOverridesCard;

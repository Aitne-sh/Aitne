"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Undo2 } from "lucide-react";
import type { SotBinding } from "@aitne/shared";
import { ApiError } from "@/lib/api-client";
import {
  useReplaceSotBindings,
  useSotBindings,
} from "@/lib/hooks/use-sot-bindings";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import {
  WRITER_OPTIONS,
  emptyRow,
  nullableTrim,
  rowsEqual,
  rowsValid,
  type DraftBinding,
  type WriterValue,
} from "./sot-bindings-card.logic";

/**
 * Section A — Source-of-Truth bindings (docs/design/21-management-
 * registry-and-entities.md §10.6).
 *
 * The list uses replace-semantics: every save PUTs the full array. The
 * `category` column is free-form (not a Domain enum) per §9.5; the
 * `writer` is constrained to the three values the renderer understands.
 *
 * Validation runs server-side via Zod (`sotBindingsSchema`); we only
 * provide light client-side guards (non-empty category/sotApp) so the
 * Save button stays disabled until a row is at least minimally usable.
 */

function toString(value: string | null): string {
  return value ?? "";
}

export function SotBindingsCard() {
  const query = useSotBindings();
  const replace = useReplaceSotBindings();

  // Editor state — stays in sync with the server snapshot when the user
  // is not mid-edit. We track `baseline` separately so Save / Discard
  // can compare without re-fetching.
  const [draft, setDraft] = useState<DraftBinding[]>([]);
  const [baseline, setBaseline] = useState<DraftBinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (query.data && !replace.isPending) {
      const next = query.data.items;
      setDraft((prev) => (rowsEqual(prev, baseline) ? next : prev));
      setBaseline(next);
    }
    // We intentionally exclude `baseline` and `draft` to avoid an
    // infinite loop — the only relevant input is the fetched data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, replace.isPending]);

  const dirty = useMemo(() => !rowsEqual(draft, baseline), [draft, baseline]);
  const validation = useMemo(() => rowsValid(draft), [draft]);

  const updateRow = (index: number, patch: Partial<DraftBinding>) => {
    setDraft((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setError(null);
  };

  const removeRow = (index: number) => {
    setDraft((rows) => rows.filter((_, i) => i !== index));
    setError(null);
  };

  const addRow = () => {
    setDraft((rows) => [...rows, emptyRow()]);
    setError(null);
  };

  const handleSave = async () => {
    if (!validation.ok) {
      setError(validation.reason);
      return;
    }
    setError(null);
    try {
      const cleaned = draft.map((row) => ({
        category: row.category.trim(),
        sotApp: row.sotApp.trim(),
        mirrorPath: row.mirrorPath,
        policy: row.policy,
        writer: row.writer,
      }));
      const res = await replace.mutateAsync(cleaned);
      setBaseline(res.items);
      setDraft(res.items);
      setToast("Saved.");
      window.setTimeout(() => setToast(null), 2500);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "save failed";
      setError(message);
    }
  };

  const handleDiscard = () => {
    setDraft(baseline);
    setError(null);
  };

  return (
    <Card className="space-y-4">
      <CardHeader className="p-0">
        <div>
          <CardTitle className="text-base">A. Source-of-Truth bindings</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground max-w-prose">
            Where the canonical data lives for each category. Renders Section A
            of <code>rules/management.md</code>; injected into every agent
            session so reactive flows know what to read or write.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDiscard}
            disabled={!dirty || replace.isPending}
          >
            <Undo2 className="mr-1.5 h-3.5 w-3.5" />
            Discard
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || replace.isPending || !validation.ok}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {replace.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardHeader>

      <QueryResult
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error as Error | null}
        onRetry={() => query.refetch()}
        skeleton={<TableSkeleton rows={3} />}
      >
        <div className="space-y-2">
          {draft.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              No bindings yet. Add one to declare where a category&rsquo;s
              source of truth lives.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Category</th>
                    <th className="px-2 py-2 font-medium">SoT app</th>
                    <th className="px-2 py-2 font-medium">Mirror path</th>
                    <th className="px-2 py-2 font-medium">Policy</th>
                    <th className="px-2 py-2 font-medium">Writer</th>
                    <th className="w-10 px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {draft.map((row, i) => (
                    <tr key={i} className="border-b border-border/40 align-top">
                      <td className="px-1 py-1.5">
                        <Input
                          value={row.category}
                          onChange={(e) =>
                            updateRow(i, { category: e.target.value })
                          }
                          placeholder="tasks"
                          maxLength={64}
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <Input
                          value={row.sotApp}
                          onChange={(e) =>
                            updateRow(i, { sotApp: e.target.value })
                          }
                          placeholder="notion"
                          maxLength={64}
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <Input
                          value={toString(row.mirrorPath)}
                          onChange={(e) =>
                            updateRow(i, {
                              mirrorPath: nullableTrim(e.target.value),
                            })
                          }
                          placeholder="context/work/tasks-index.md"
                          maxLength={255}
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <Input
                          value={toString(row.policy)}
                          onChange={(e) =>
                            updateRow(i, {
                              policy: nullableTrim(e.target.value),
                            })
                          }
                          placeholder="—"
                          maxLength={200}
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <Select
                          value={row.writer}
                          onValueChange={(v) =>
                            updateRow(i, { writer: v as WriterValue })
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {WRITER_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-1 py-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove row ${i + 1}`}
                          onClick={() => removeRow(i)}
                          className="h-8 w-8"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            disabled={replace.isPending}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add binding
          </Button>
        </div>
      </QueryResult>

      {error && (
        <Alert variant="error" className="text-xs">
          {error}
        </Alert>
      )}
      {toast && <p className="text-xs text-muted-foreground">{toast}</p>}
    </Card>
  );
}

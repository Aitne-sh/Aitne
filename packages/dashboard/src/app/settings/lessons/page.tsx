"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api-client";
import type { ContextFileResponse, LessonStore } from "@/lib/api-types";
import { useConfig, useConfigDefaults } from "@/lib/hooks/use-config";
import { useDirtyFields } from "@/lib/hooks/use-dirty-fields";
import { useFeedbackLessons } from "@/lib/hooks/use-feedback-lessons";
import {
  ContextConflictError,
  useContextFile,
  useUpdateContextFile,
} from "@/lib/hooks/use-context";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  ConfigSection,
  EditableBooleanField,
  EditableField,
} from "@/components/settings/editors";
import { FileConflictBanner } from "@/components/shared/file-conflict-banner";
import { cn, formatAbsoluteTime } from "@/lib/utils";
import {
  capPercent,
  storeCapLevel,
  storeStatusLine,
  storeTitle,
  type CapLevel,
} from "./lessons.logic";

/**
 * Feedback Learning Loop — Lessons settings page (FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5).
 *
 * Two surfaces:
 *  - Tune the loop: master toggle, promotion threshold, per-scope byte caps,
 *    staleness horizon, and signal retention — deferred-save via the sticky
 *    save bar (PATCH /config).
 *  - View / edit the consolidated lesson stores: the global agent store plus
 *    every per-agent store, each with cap utilisation. Editing a store's raw
 *    markdown goes through PUT /api/context/<path> with optimistic concurrency,
 *    the same chokepoint the nightly consolidation writes through.
 */
export default function LessonsSettingsPage() {
  return (
    <>
      <PageHeader
        title="Lessons"
        badge={<Badge variant="amber">Preview</Badge>}
        description={
          <>
            The agent calibrates its own behaviour from your feedback: when you
            correct it, state a preference, or its weekly self-critique flags a
            pattern, the signal is captured, consolidated each night into a
            scoped &ldquo;lesson&rdquo;, and injected back into exactly the
            agents that can act on it. Global lessons steer notification
            discipline and operating style; a per-agent lesson is injected only
            into that one Agent&apos;s runs. Tune how aggressively lessons form
            and review or hand-edit the stores below.
          </>
        }
      />
      <FeedbackTuningCard />
      <LessonStoresCard />
    </>
  );
}

function FeedbackTuningCard() {
  const { data: config } = useConfig();
  const { df } = useConfigDefaults();
  const { deferSaveFor, dv, dirtyFields } = useDirtyFields();

  if (!config) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Card>
    );
  }

  const deferSave = deferSaveFor(config);
  const learningOn = dv("feedbackLearningEnabled", config.feedbackLearningEnabled);

  return (
    <ConfigSection title="Feedback learning">
      <EditableBooleanField
        label="Enable feedback learning"
        value={learningOn}
        configKey="feedbackLearningEnabled"
        description="Master switch. While off, no signals are consolidated and no lessons are injected — capture continues but nothing new takes effect."
        modified={dirtyFields.has("feedbackLearningEnabled")}
        defaultValue={df("feedbackLearningEnabled")}
        onSave={deferSave}
      />
      <EditableField
        label="Promotion threshold"
        value={dv("feedbackPromotionThreshold", config.feedbackPromotionThreshold)}
        configKey="feedbackPromotionThreshold"
        type="number"
        min={1}
        max={10}
        description="Weighted evidence a behavioral/self-critique signal must reach before it becomes an injectable lesson. An explicit owner directive promotes on the first occurrence regardless. Higher = slower to learn, fewer false lessons."
        modified={dirtyFields.has("feedbackPromotionThreshold")}
        defaultValue={df("feedbackPromotionThreshold")}
        onSave={deferSave}
      />
      <EditableField
        label="Global lessons byte cap"
        value={dv("feedbackLessonMaxBytesGlobal", config.feedbackLessonMaxBytesGlobal)}
        configKey="feedbackLessonMaxBytesGlobal"
        type="number"
        suffix="B"
        min={1024}
        max={32768}
        description="Hard size cap for policies/agent-lessons.md. Over cap, the lowest-signal lessons are evicted during consolidation."
        modified={dirtyFields.has("feedbackLessonMaxBytesGlobal")}
        defaultValue={df("feedbackLessonMaxBytesGlobal")}
        onSave={deferSave}
      />
      <EditableField
        label="Per-agent lessons byte cap"
        value={dv("feedbackLessonMaxBytesPerAgent", config.feedbackLessonMaxBytesPerAgent)}
        configKey="feedbackLessonMaxBytesPerAgent"
        type="number"
        suffix="B"
        min={512}
        max={16384}
        description="Hard size cap for each policies/agents/<slug>/lessons.md store."
        modified={dirtyFields.has("feedbackLessonMaxBytesPerAgent")}
        defaultValue={df("feedbackLessonMaxBytesPerAgent")}
        onSave={deferSave}
      />
      <EditableField
        label="Lesson staleness horizon"
        value={dv("feedbackLessonStaleDays", config.feedbackLessonStaleDays)}
        configKey="feedbackLessonStaleDays"
        type="number"
        suffix="days"
        min={7}
        max={365}
        description="A stale lesson demotes to provisional (reversible) at the next consolidation; a provisional lesson uncorroborated for twice this window is archived. Durable constraints never expire."
        modified={dirtyFields.has("feedbackLessonStaleDays")}
        defaultValue={df("feedbackLessonStaleDays")}
        onSave={deferSave}
      />
      <EditableField
        label="Confidence floor"
        value={dv("feedbackLessonConfidenceFloor", config.feedbackLessonConfidenceFloor)}
        configKey="feedbackLessonConfidenceFloor"
        type="number"
        min={0}
        max={1}
        description="Lessons whose time-decayed confidence (cf) falls below this floor stop being injected and, once stale, demote to provisional. 0 disables the filter."
        modified={dirtyFields.has("feedbackLessonConfidenceFloor")}
        defaultValue={df("feedbackLessonConfidenceFloor")}
        onSave={deferSave}
      />
      <EditableField
        label="Contradiction guard"
        value={dv("feedbackContradictionGuardCf", config.feedbackContradictionGuardCf)}
        configKey="feedbackContradictionGuardCf"
        type="number"
        min={0}
        max={1}
        description="A new candidate that contradicts an established lesson with confidence at or above this value is held provisional until it accumulates 1.5x the usual evidence. Explicit owner corrections always win immediately."
        modified={dirtyFields.has("feedbackContradictionGuardCf")}
        defaultValue={df("feedbackContradictionGuardCf")}
        onSave={deferSave}
      />
      <EditableBooleanField
        label="Outcome-aware consolidation"
        value={dv("feedbackOutcomeLearningEnabled", config.feedbackOutcomeLearningEnabled)}
        configKey="feedbackOutcomeLearningEnabled"
        description="Include the per-notification-type outcome rollup (replied / corrected / ignored, correction rate) in the nightly consolidation so lesson promotions can weigh real reactions."
        modified={dirtyFields.has("feedbackOutcomeLearningEnabled")}
        defaultValue={df("feedbackOutcomeLearningEnabled")}
        onSave={deferSave}
      />
      <EditableField
        label="Signal retention"
        value={dv("feedbackSignalRetentionDays", config.feedbackSignalRetentionDays)}
        configKey="feedbackSignalRetentionDays"
        type="number"
        suffix="days"
        min={30}
        max={365}
        description="How long consumed raw feedback signals are kept before the nightly retention sweep drops them. Unconsolidated signals are never swept."
        modified={dirtyFields.has("feedbackSignalRetentionDays")}
        defaultValue={df("feedbackSignalRetentionDays")}
        onSave={deferSave}
      />
    </ConfigSection>
  );
}

function LessonStoresCard() {
  const { data, isLoading, error } = useFeedbackLessons();
  const [openPath, setOpenPath] = useState<string | null>(null);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardHeader className="p-0">
        <CardTitle className="text-sm font-semibold">Lesson stores</CardTitle>
      </CardHeader>
      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading lesson stores…</p>
      )}
      {error && (
        <Alert variant="error">
          Failed to load lesson stores:{" "}
          {(error as Error)?.message ?? "unknown error"}
        </Alert>
      )}
      {data && (
        <>
          {!data.enabled && (
            <Alert variant="warning">
              Feedback learning is turned off — existing lessons are not being
              injected and no new ones are forming. Toggle it on above to resume.
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">
            {data.pendingSignals} signal{data.pendingSignals === 1 ? "" : "s"}{" "}
            awaiting the next nightly consolidation · promotion threshold{" "}
            {data.promotionThreshold}
          </p>
          <ul className="flex flex-col divide-y">
            {data.stores.map((s) => (
              <LessonStoreRow
                key={s.path}
                store={s}
                open={openPath === s.path}
                onToggle={() =>
                  setOpenPath((prev) => (prev === s.path ? null : s.path))
                }
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

const CAP_BAR_COLOR: Record<CapLevel, string> = {
  ok: "bg-primary",
  warn: "bg-warning",
  full: "bg-destructive",
};

function LessonStoreRow({
  store,
  open,
  onToggle,
}: {
  store: LessonStore;
  open: boolean;
  onToggle: () => void;
}) {
  const level = storeCapLevel(store);
  const bytePct = capPercent(store.bytes, store.capBytes);
  const entryPct = capPercent(store.entries, store.maxEntries);
  const barPct = Math.max(bytePct, entryPct);

  return (
    <li className="py-3 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{storeTitle(store.scope)}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {store.path}
          </p>
          <p className="pt-0.5 text-xs text-muted-foreground">
            {storeStatusLine(store)}
          </p>
          {store.exists && (
            <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-all", CAP_BAR_COLOR[level])}
                style={{ width: `${barPct}%` }}
              />
            </div>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant={open ? "secondary" : "outline"}
          disabled={!store.exists}
          onClick={onToggle}
        >
          {!store.exists ? "Empty" : open ? "Close" : "Edit"}
        </Button>
      </div>
      {open && store.exists && (
        <div className="pt-3">
          <LessonStoreEditor path={store.path} />
        </div>
      )}
    </li>
  );
}

function LessonStoreEditor({ path }: { path: string }) {
  const query = useContextFile(path);

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (query.error || !query.data) {
    return (
      <p className="text-sm text-destructive">
        Failed to load {path}:{" "}
        {(query.error as Error | undefined)?.message ?? "unknown error"}
      </p>
    );
  }
  return (
    <LoadedLessonEditor
      key={path}
      path={path}
      initial={query.data}
      editable={query.data.editable !== false}
    />
  );
}

function LoadedLessonEditor({
  path,
  initial,
  editable,
}: {
  path: string;
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
      const res = await update.mutateAsync({ path, content: draft, expectedMtime });
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
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Last modified: {formatAbsoluteTime(baseline.mtime)}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!dirty || !editable || update.isPending || conflict !== null}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
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
        className="min-h-[320px] w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="text-[11px] text-muted-foreground">
        Edits go through the same context write path the nightly consolidation
        uses. Keep the <code>## Lessons</code> bullets and their{" "}
        <code>&lt;!-- ev=… --&gt;</code> trailers intact so the consolidator can
        keep merging them.
      </p>
      {toast && <p className="text-xs text-muted-foreground">{toast}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

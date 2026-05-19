"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { DirectoryPickerField } from "@/components/directory-picker-field";
import { Alert } from "@/components/ui/alert";
import { ApiError, api } from "@/lib/api-client";
import {
  summariseProbe,
  type ProbeResult,
  type ProbeSummary,
} from "./vault-path-picker.logic";

/**
 * Wiki-specific path picker.
 *
 * Composes the project's standard `DirectoryPickerField` (which opens
 * the OS-native folder dialog through `/api/system/pick-directory`)
 * with a `/api/fs/probe` call that validates the chosen path against
 * the wiki-specific collision matrix:
 *   - overlaps with the primary vault, external Obsidian vault, or
 *     daemon dataDir → save-blocking error
 *   - not-yet-writable parent → warning ("will be created")
 *   - existing `.obsidian/` marker → info ("Obsidian vault detected")
 *   - existing 10_raw/20_wiki/90_meta layout → info ("you will be
 *     prompted to Adopt or Migrate after saving", per §7)
 *
 * The probe is modelled as `useQuery` (not a manual useEffect) so the
 * effect-only state-setting rule stays happy and consecutive renders
 * with the same path reuse the result. `onValidatedChange` is captured
 * through a ref so a caller that passes a fresh closure each render
 * does not retrigger the notify-effect — without that guard, the
 * effect deps shift every render and the parent's setState turns into
 * a loop. The notify-effect therefore only fires when the probe
 * settles or the chosen path actually changes.
 */
export function WikiVaultPathPicker({
  value,
  onChange,
  onValidatedChange,
  defaultPath,
  disabled,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  /**
   * Called after each probe completes. The settings page uses this to
   * disable the save button when `summary.canConfirm` is false.
   */
  onValidatedChange?: (path: string, summary: ProbeSummary) => void;
  defaultPath?: string;
  disabled?: boolean;
  id?: string;
}) {
  const trimmed = value.trim();
  const probeQuery = useQuery<ProbeResult, ApiError>({
    queryKey: ["fs-probe", trimmed],
    enabled: trimmed.length > 0,
    // Stale time is tight — the probe must re-run when the user picks
    // a different path, but consecutive renders with the same path
    // should reuse the result.
    staleTime: 30 * 1000,
    retry: false,
    queryFn: () =>
      api.get<ProbeResult>("/fs/probe", { params: { path: trimmed } }),
  });

  // Memoise the unified probe result so its identity is stable across
  // renders while the query data/error references don't change. The
  // probe route returns a structured 400 body for validation
  // rejections; we surface that body's message rather than the bare
  // ApiError text.
  const probe: ProbeResult | null = useMemo(() => {
    if (probeQuery.data) return probeQuery.data;
    if (probeQuery.error) {
      const body =
        typeof probeQuery.error.body === "object" && probeQuery.error.body !== null
          ? (probeQuery.error.body as Record<string, unknown>)
          : null;
      return {
        ok: false,
        path: trimmed,
        exists: false,
        isDir: false,
        writable: false,
        collision: null,
        collisionMessage: null,
        hasObsidianStructure: false,
        existingWiki: null,
        error: typeof body?.error === "string" ? body.error : "request_failed",
        message:
          typeof body?.message === "string"
            ? body.message
            : probeQuery.error.message,
      };
    }
    return null;
  }, [probeQuery.data, probeQuery.error, trimmed]);

  const summary: ProbeSummary = useMemo(() => summariseProbe(probe), [probe]);

  // Ref-captured callback. Avoids forcing every parent to wrap their
  // handler in `useCallback`; a fresh closure each parent render is
  // harmless because the notify-effect below does not depend on it.
  // The ref is updated in a no-deps effect (runs after every render)
  // so it always holds the latest closure by the time the notify-
  // effect — declared below — fires. Effect declaration order is
  // guaranteed in React, so the ref write completes before the
  // notify-effect runs.
  const onValidatedChangeRef = useRef(onValidatedChange);
  useEffect(() => {
    onValidatedChangeRef.current = onValidatedChange;
  });

  // Notify the parent only when the probe verdict actually changes.
  // Deps are query-data refs (React Query keeps them stable while
  // nothing changes) plus the primitive path string — no fresh
  // closures, no fresh object literals.
  useEffect(() => {
    const cb = onValidatedChangeRef.current;
    if (!cb) return;
    if (trimmed.length === 0) {
      cb("", summary);
      return;
    }
    // Wait until the query has settled before declaring a verdict.
    if (!probeQuery.isFetched && !probeQuery.isError) return;
    cb(trimmed, summary);
  }, [trimmed, summary, probeQuery.isFetched, probeQuery.isError]);

  const showSummary = trimmed.length > 0 && (probeQuery.isFetched || probeQuery.isError);
  const variantBySeverity: Record<NonNullable<typeof summary.severity>, "error" | "warning" | "info"> = {
    error: "error",
    warning: "warning",
    info: "info",
  };

  return (
    <div className="space-y-2">
      <DirectoryPickerField
        id={id}
        value={value}
        onChange={onChange}
        title="Choose external wiki vault"
        placeholder="/Users/you/Obsidian/Wiki"
        defaultPath={defaultPath}
        disabled={disabled}
      />
      {probeQuery.isFetching && (
        <p
          className="flex items-center gap-1 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Validating path…
        </p>
      )}
      {showSummary && summary.severity && (
        <Alert variant={variantBySeverity[summary.severity]}>
          <ul className="list-disc pl-4 space-y-0.5">
            {summary.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}

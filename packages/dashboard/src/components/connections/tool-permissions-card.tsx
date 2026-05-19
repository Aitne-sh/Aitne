"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Lock } from "lucide-react";
import type { BackendId, IntegrationKey } from "@aitne/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api-client";
import { usePatchIntegration } from "@/lib/hooks/use-integrations";
import type { IntegrationListItem } from "@/lib/api-types";
import { cn } from "@/lib/utils";
import {
  buildToolPermissionsView,
  parseRawDenyList,
  toggleCapabilityDeny,
  type ToolPermissionRow,
} from "./tool-permissions-card.logic";
import { SafetyFloorGuidance } from "./safety-floor-guidance";

interface Props {
  integrationKey: IntegrationKey;
  descriptor: IntegrationListItem;
  delegatedBackend: BackendId;
  /**
   * Current `IntegrationState.deniedTools`. Undefined → treated as empty.
   * The card never reads `descriptor.state.deniedTools` directly because
   * the parent (integration card) tracks the freshest state from
   * `useIntegrations()` and forwards it here.
   */
  deniedTools: readonly string[] | undefined;
  /**
   * Re-issued by the parent on Apply success so the card re-fetches /
   * re-renders with the persisted list. We rely on react-query to keep
   * the underlying state in sync; no internal optimistic update.
   */
  currentMode: "direct" | "delegated" | "disabled";
}

const SAVED_FLASH_MS = 1500;

/**
 * §7.7 Tool Permissions card. Optional capabilities at the top (the user's
 * actual control surface); required capabilities at the bottom in a
 * collapsible "What's required" reference. Each row exposes its underlying
 * tool names on demand via a chevron — keeping the default view scannable
 * even for integrations with 14+ capability rows.
 *
 * Apply sends a PATCH with mode + delegatedBackend + the new deniedTools
 * list. Server-side validation rejects unknown tools and any deny that
 * breaks a required capability; failures surface inline.
 */
export function ToolPermissionsCard({
  integrationKey,
  descriptor,
  delegatedBackend,
  deniedTools,
  currentMode,
}: Props) {
  const [draft, setDraft] = useState<readonly string[]>(deniedTools ?? []);
  const [draftDirty, setDraftDirty] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const patch = usePatchIntegration();

  // Reset the draft whenever the parent forwards a new server-side state
  // OR the active backend changes. Two scenarios this guards:
  //   (a) Apply success → server returns persisted list → we sync local.
  //   (b) Backend swap (claude → codex) → tool universe changes → we drop
  //       any in-flight edits because the targets they reference no
  //       longer match the active connector.
  // If the user has uncommitted edits AND the server state happens to
  // catch up to them (another tab applied the same change), clear the
  // dirty flag so the Apply/Revert buttons disappear gracefully.
  useEffect(() => {
    const incoming = [...(deniedTools ?? [])];
    setDraft((prevDraft) => {
      const sameSet = sameMembership(prevDraft, incoming);
      if (sameSet) {
        // Server caught up — clear dirty flag.
        setDraftDirty(false);
        return prevDraft;
      }
      if (!draftDirty) {
        // No local edits → adopt incoming.
        return incoming;
      }
      // Local edits in flight AND incoming differs → keep local draft.
      return prevDraft;
    });
    // Intentionally tracked: backend swap should reset the picker even
    // when deniedTools is unchanged (stale entries map to a different
    // tool universe). React-hooks/exhaustive-deps would also push us to
    // include `draftDirty`, but doing so causes a feedback loop because
    // we set it inside the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deniedTools, delegatedBackend]);

  // Reset all transient state on backend swap — the previous error or
  // saved flash refers to the previous backend's policy.
  useEffect(() => {
    setPatchError(null);
    setSavedFlash(false);
  }, [delegatedBackend]);

  const draftView = useMemo(
    () => buildToolPermissionsView(descriptor, delegatedBackend, draft),
    [descriptor, delegatedBackend, draft],
  );

  if (currentMode !== "delegated" || !draftView) {
    return null;
  }

  const optionalRows = draftView.rows.filter((r) => !r.required);
  const requiredRows = draftView.rows.filter((r) => r.required);

  const onToggle = (row: ToolPermissionRow) => {
    if (row.required) return;
    const next = toggleCapabilityDeny(draft, row, !row.denied);
    setDraft(next);
    setDraftDirty(true);
    setPatchError(null);
    setSavedFlash(false);
  };

  const onCleanupStale = () => {
    if (draftView.staleDeniedTools.length === 0) return;
    const stale = new Set(draftView.staleDeniedTools);
    const next = draft.filter((t) => !stale.has(t));
    setDraft(next);
    setDraftDirty(true);
    setPatchError(null);
    setSavedFlash(false);
  };

  const onRevert = () => {
    setDraft(deniedTools ?? []);
    setDraftDirty(false);
    setPatchError(null);
    setSavedFlash(false);
  };

  const onApply = async () => {
    setPatchError(null);
    setSavedFlash(false);
    try {
      await patch.mutateAsync({
        key: integrationKey,
        body: {
          mode: "delegated",
          delegatedBackend,
          deniedTools: [...draft],
        },
      });
      setDraftDirty(false);
      setSavedFlash(true);
      // Auto-clear the saved flash so the card returns to its idle look.
      window.setTimeout(() => setSavedFlash(false), SAVED_FLASH_MS);
    } catch (err) {
      setPatchError(formatError(err));
    }
  };

  // DELEGATED-MODE-V2-DESIGN.md §4.3.4 outcome (γ) — only Codex enforces
  // deniedTools at the prose level. Claude (SDK `disallowedTools`) and
  // Gemini (admin-policy TOML rule at priority 936, see
  // gemini-cli-core.ts:buildSessionDeniedToolRules) both block the call
  // before the agent sees the tool. Show the "limited enforcement" badge
  // for Codex only — flagging Gemini here was factually wrong and pushed
  // users to switch backends unnecessarily.
  const enforcementLabel = delegatedBackend === "codex" ? "codex" : null;
  const deniedCount = optionalRows.filter((r) => r.denied).length;

  return (
    <>
      {/* DELEGATED-MODE-V2-DESIGN.md §7.1 — safety guidance prose rendered
          ABOVE the deny-list editor, US-English, verbatim wording. */}
      <SafetyFloorGuidance
        integrationKey={integrationKey}
        delegatedBackend={delegatedBackend}
      />
      <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium">Tool permissions</h4>
          {deniedCount > 0 && (
            <Badge variant="amber" className="h-5 px-1.5 text-[10px]">
              {deniedCount} off
            </Badge>
          )}
        </div>
        {enforcementLabel && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="amber" className="cursor-help gap-1">
                  Limited enforcement ({enforcementLabel})
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs text-xs">
                  Codex doesn&apos;t expose a per-tool block at the binary
                  level. The agent reads a &quot;denied tools&quot; note in
                  its prompt and is asked to obey it — weaker than the
                  SDK-level block Claude and Gemini provide. Switch to a
                  Claude- or Gemini-backed delegation if you need hard
                  enforcement.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        Turn off connector tools the agent should never use for this
        integration. Required capabilities (search, read, …) can&apos;t be
        disabled — to drop them, switch the integration out of delegated
        mode.
      </p>

      {optionalRows.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">
          This connector has no optional capabilities to manage.
        </p>
      ) : (
        <div className="space-y-1">
          {optionalRows.map((row) => (
            <PermissionRow
              key={row.capability}
              row={row}
              onToggle={() => onToggle(row)}
            />
          ))}
        </div>
      )}

      {requiredRows.length > 0 && (
        <RequiredReference rows={requiredRows} />
      )}

      {draftView.staleDeniedTools.length > 0 && (
        <Alert variant="warning" className="mt-3">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <p className="text-xs font-medium">
                {draftView.staleDeniedTools.length} stale entr
                {draftView.staleDeniedTools.length === 1 ? "y" : "ies"} from
                a previous backend
              </p>
              <ul className="font-mono text-[11px]">
                {draftView.staleDeniedTools.map((t) => (
                  <li key={t} className="break-all">{t}</li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                {`These names don't match any tool in ${delegatedBackend}'s`}
                connector. The agent ignores them already; click Clean up
                to drop them from the saved list.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={onCleanupStale}
            >
              Clean up
            </Button>
          </div>
        </Alert>
      )}

      {patchError && (
        <Alert variant="error" className="mt-3 whitespace-pre-line">
          <p className="text-xs">{patchError}</p>
        </Alert>
      )}

      {(draftDirty || savedFlash) && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {savedFlash && !draftDirty && (
            <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
          {draftDirty && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={onRevert}
                disabled={patch.isPending}
              >
                Revert
              </Button>
              <Button
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => void onApply()}
                disabled={patch.isPending}
              >
                {patch.isPending ? "Applying…" : "Apply"}
              </Button>
            </>
          )}
        </div>
      )}

      {/* DELEGATED-MODE-V2-DESIGN.md §7.1 — raw deny-list editor.
          Plain-text array editor, one tool pattern per line. Operates over
          the same `draft` state as the capability checkboxes — last edit
          wins; the user can use either or both. Glob patterns flow through
          to the server (validated by §4.3.5 `validateDeniedTools`). */}
      <RawDenyListEditor
        draft={draft}
        onChange={(next) => {
          setDraft(next);
          setDraftDirty(true);
          setPatchError(null);
          setSavedFlash(false);
        }}
      />
    </Card>
    </>
  );
}

/**
 * §7.1 raw deny-list editor — plain-text textarea, one entry per line.
 * Surfaced as a collapsible "Advanced" section so the capability-checkbox
 * UI stays the primary affordance for typical use, and the textarea
 * stays available for users who want to apply globs (`delete_*`) or
 * reorder/inspect the saved list directly.
 *
 * The textarea is uncontrolled with respect to keystrokes (preserves
 * cursor position while editing) and only reseeds from `draft` when it
 * changes for non-typing reasons (capability toggle, server sync,
 * revert). The seed-vs-typed distinction is tracked via a ref so React's
 * controlled-input default does not collapse the cursor on every keystroke.
 */
function RawDenyListEditor({
  draft,
  onChange,
}: {
  draft: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>(draft.join("\n"));

  // Reseed the textarea whenever the draft array changes from a non-text
  // edit (capability toggle, parent-driven revert, server sync). We
  // detect "draft changed externally" by comparing the textarea's
  // canonical parse to the incoming draft membership; if they match the
  // user's typing already produced this draft and we leave the raw text
  // alone (preserves their formatting and cursor).
  useEffect(() => {
    const parsed = parseRawDenyList(text);
    const same =
      parsed.length === draft.length
      && parsed.every((p, i) => p === draft[i]);
    if (!same) {
      setText(draft.join("\n"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const handleTextChange = (next: string) => {
    setText(next);
    onChange(parseRawDenyList(next));
  };

  return (
    <div className="mt-4 border-t pt-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-1">
          <span className="font-medium">Advanced — raw deny list</span>
          <span className="text-[10px]">
            ({draft.length} {draft.length === 1 ? "entry" : "entries"})
          </span>
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            One tool pattern per line. Suffix glob support: <code className="font-mono">delete_*</code>{" "}
            matches every tool starting with <code className="font-mono">delete_</code>.
            The list is enforced uniformly across direct, cross-backend
            proxy, and same-backend native MCP paths.
          </p>
          <textarea
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            spellCheck={false}
            rows={Math.max(4, Math.min(12, text.split("\n").length + 1))}
            className="w-full rounded-md border border-input bg-background p-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder={"send_email\ndelete_emails\narchive_*"}
          />
        </div>
      )}
    </div>
  );
}

function PermissionRow({
  row,
  onToggle,
}: {
  row: ToolPermissionRow;
  onToggle: () => void;
}) {
  const [showTools, setShowTools] = useState(false);
  const checked = !row.denied;
  return (
    <div
      className={cn(
        "rounded-md border p-2 text-xs transition",
        checked ? "border-border" : "border-dashed border-border/70 bg-muted/20",
      )}
    >
      <div className="flex items-center gap-2">
        <input
          id={`perm-${row.capability}`}
          type="checkbox"
          className="cursor-pointer"
          checked={checked}
          onChange={onToggle}
        />
        <label
          htmlFor={`perm-${row.capability}`}
          className="flex-1 cursor-pointer"
        >
          <span className="font-medium text-foreground">{row.label}</span>
          {row.denied && (
            <Badge variant="amber" className="ml-2 h-4 px-1 text-[10px]">
              off
            </Badge>
          )}
        </label>
        {row.tools.length > 0 && (
          <button
            type="button"
            className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            onClick={() => setShowTools((v) => !v)}
            aria-expanded={showTools}
            aria-label={
              showTools
                ? `Hide tools for ${row.label}`
                : `Show tools for ${row.label}`
            }
          >
            {showTools ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {row.tools.length} tool{row.tools.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {showTools && row.tools.length > 0 && (
        <ul className="ml-6 mt-1 font-mono text-[10px] text-muted-foreground">
          {row.tools.map((t) => (
            <li key={t} className="break-all">
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Read-only reference list of required capabilities. Collapsed by default
 * to keep the toggle area scannable. The user can't act on these — they
 * exist purely so the user understands what coverage they're locking in
 * by staying in delegated mode.
 */
function RequiredReference({ rows }: { rows: ToolPermissionRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t pt-2">
      <button
        type="button"
        className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-1">
          <Lock className="h-3 w-3" /> Required capabilities ({rows.length})
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>
      {open && (
        <ul className="mt-2 space-y-1">
          {rows.map((row) => (
            <li
              key={row.capability}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <Check className="h-3 w-3 text-muted-foreground/70" />
              <span className="font-medium text-foreground">{row.label}</span>
              {row.tools.length > 0 && (
                <span className="font-mono text-[10px]">
                  · {row.tools.join(", ")}
                </span>
              )}
            </li>
          ))}
          <li className="pt-1 text-[10px] italic text-muted-foreground">
            To drop these, switch this integration out of delegated mode.
          </li>
        </ul>
      )}
    </div>
  );
}

function sameMembership(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const x of b) if (!set.has(x)) return false;
  return true;
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as
      | {
          error?: string;
          message?: string;
          tool?: string;
          capability?: string;
          remainingTools?: string[];
        }
      | undefined;
    if (body?.error === "unknown_tool") {
      return body.message ?? `Unknown tool: ${body.tool ?? "?"}`;
    }
    if (body?.error === "denial_breaks_required_capability") {
      const remaining = body.remainingTools?.join(", ") ?? "?";
      return (
        body.message
        ?? `Denying these tools breaks required capability '${body.capability ?? "?"}'. Keep at least one of: ${remaining}.`
      );
    }
    return body?.message ?? err.message;
  }
  return err instanceof Error ? err.message : "Unexpected error";
}

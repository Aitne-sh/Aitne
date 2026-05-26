"use client";

// Self-learning skill optimization settings page (Preview).
//
// The optimizer runs on the operator's chosen cadence (daily/weekly/monthly)
// and is gated by `skill_curation.config.enabled` (default OFF). When the
// toggle flips OFF, SkillsCompiler also stops injecting overlays into
// materialized sessions — this is the operator's only kill switch.
//
// Per design §6.1 there is no per-proposal review surface: every passing
// proposal applies silently, and the only roll-back path is the system-
// driven auto-revert in §5.3. The Recent runs list summarises applied /
// auto-reverted / smoke_failed counts as a read-only health signal.
//
// All writes hit `PATCH /api/settings/skill-curation`, which validates via
// the shared `SkillCurationConfigSchema` and re-derives the cron entry.

import { useEffect, useMemo, useState } from "react";
import { RUNTIME_AVAILABLE_BACKEND_IDS, type BackendId } from "@aitne/shared";
import {
  BACKEND_PROVIDER_SHORT,
  isUiPreviewOnlyBackend,
  UI_PREVIEW_ONLY_BADGE_SUFFIX,
} from "@/lib/backend-ui";
import { ApiError, api } from "@/lib/api-client";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";

type Cadence = "daily" | "weekly" | "monthly";
// Self-learning runs through the BackendRouter. Only backends with a wired
// runtime core can drive a curation pass — the shared
// `RUNTIME_AVAILABLE_BACKEND_IDS` constant gates the picker.
type Backend = (typeof RUNTIME_AVAILABLE_BACKEND_IDS)[number];

interface ConfigPayload {
  enabled: boolean;
  cadence: Cadence;
  backend: Backend;
  model: string;
  excluded_skills: string[];
}

interface RecentRun {
  id: string;
  started_at: number;
  finalized_at: number | null;
  cadence: string;
  backend: string;
  model: string;
  status: string;
  proposal_count: number;
  target_skills: unknown;
  is_manual?: boolean;
  /** Per-status counts. Keys correspond to ProposalStatus values. */
  counts?: Partial<Record<
    "applied" | "auto_reverted" | "smoke_failed" | "diff_caps" | "render_budget" | "conflict",
    number
  >>;
}

type RunCountKey = keyof NonNullable<RecentRun["counts"]>;

/** Display labels for the count chips on a recent-run row. Order is
 *  intentional: applied first (the success signal), then auto_reverted
 *  (the de-facto health metric per design §11), then failure causes. */
const RUN_STAT_LABELS: ReadonlyArray<{ key: RunCountKey; label: string; emphasise?: boolean }> = [
  { key: "applied", label: "applied" },
  { key: "auto_reverted", label: "auto-reverted", emphasise: true },
  { key: "smoke_failed", label: "smoke-failed" },
  { key: "diff_caps", label: "diff-caps" },
  { key: "render_budget", label: "render-budget" },
  { key: "conflict", label: "conflict" },
];

interface OrphanOverlay {
  slug: string;
  section_id: string;
  kind: string | null;
  applied_proposal_id: number | null;
  applied_at: number | null;
  reason: string;
  overlay_path: string;
}

interface SettingsResponse {
  config: ConfigPayload;
  eligible_skills: string[];
  recent_runs: RecentRun[];
  orphan_overlays: OrphanOverlay[];
}

const DEFAULT_MODEL_BY_BACKEND: Record<Backend, string> = {
  claude: "claude-sonnet-4-6",
  codex: "gpt-5.4",
  gemini: "gemini-2.5-flash",
  // docs/design/appendices/opencode-backend.md §6.1.1 — opencode model IDs are
  // `provider/model` composites; the registry's medium-tier default is
  // Anthropic's Sonnet through opencode's Anthropic provider.
  opencode: "anthropic/claude-sonnet-4-6",
};

// When the operator first turns the optimizer ON we auto-scope it to the
// skills where curation has the highest leverage: the daily surface
// (`today`), the routing/sectioning of explicit user-managed apps and
// projects (`management-policy`, `project-doc`), and the user-fact
// layout (`user-profile`). Lower-leverage skills get added to the
// exclusion list by default and the operator can adjust this in the
// Advanced section below.
const HIGH_IMPACT_SKILLS: ReadonlyArray<string> = [
  "today",
  "management-policy",
  "project-doc",
  "user-profile",
];

function applySmartDefaultExclusions(
  eligible: string[],
  current: string[],
): string[] {
  if (current.length > 0) return current;
  return eligible.filter((slug) => !HIGH_IMPACT_SKILLS.includes(slug));
}

export default function SelfLearningSettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<ConfigPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const runInFlight = useMemo(
    () => (data?.recent_runs ?? []).some((r) => r.status === "running"),
    [data],
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<SettingsResponse>("/settings/skill-curation");
      setData(res);
      setDraft(res.config);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    return JSON.stringify(data.config) !== JSON.stringify(draft);
  }, [data, draft]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setToast(null);
    try {
      await api.patch<{ config: ConfigPayload }>("/settings/skill-curation", draft);
      setToast("Saved");
      window.setTimeout(() => setToast(null), 2500);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function discardOrphan(slug: string, sectionId: string) {
    try {
      await api.post("/skill-curation/orphans/discard", { slug, section_id: sectionId });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  async function runNow() {
    setRunning(true);
    setError(null);
    setToast(null);
    try {
      await api.post("/skill-curation/runs/manual", {});
      setToast("Optimization started. The agent will run silently in the background.");
      window.setTimeout(() => setToast(null), 4000);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("A run is already in flight. Wait for it to complete.");
      } else {
        setError(err instanceof ApiError ? err.message : (err as Error).message);
      }
    } finally {
      setRunning(false);
    }
  }

  if (loading || !draft || !data) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title="Self-learning skill optimization"
        badge={<Badge variant="amber">Preview</Badge>}
        description={
          <>
            Lets the agent periodically refresh a bounded set of &ldquo;knowledge
            map&rdquo; sections inside its own skills — for example, the list of
            files under <code>identity/</code>, the section names inside{" "}
            <code>state/today.md</code>, or the routing table that decides where a
            fact gets written. When ON, the agent runs on the cadence below and
            silently applies every passing proposal; an auto-revert loop rolls
            back any change that introduces more drift. There is no review queue:
            toggling OFF stops new runs and immediately unhooks every applied
            overlay.
          </>
        }
      >
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The optimizer targets the highest-leverage skills first — the daily
          surface (<code>today</code>), the routing for explicit user-managed
          apps and projects (<code>management-policy</code>,{" "}
          <code>project-doc</code>), and the user-fact layout (
          <code>user-profile</code>). Fine-tune this cohort under
          <span className="font-medium"> Advanced &rarr; Per-skill
          exclusions</span> below.
        </p>
      </PageHeader>

      <Alert variant="info">
        <span className="text-sm font-medium">Recommended only after
        long-term operation.</span>{" "}
        <span className="text-sm text-muted-foreground">
          The optimizer learns from accumulated signals across runs,
          observations, and your daily activity. Enabling on a fresh
          install yields little benefit and can produce churn. Wait until
          the agent has been running for several weeks of regular use
          before turning this ON.
        </span>
      </Alert>

      {error && <Alert variant="error">{error}</Alert>}
      {toast && <Alert variant="success">{toast}</Alert>}

      <Card className="flex flex-col gap-3 p-4">
        <CardHeader className="p-0">
          <CardTitle className="text-sm font-semibold">Safety</CardTitle>
        </CardHeader>
        <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-1">
          <li>
            The optimizer runs in an isolated working directory with no Edit /
            Write tools and no access to your knowledge files. Its only
            mutation path is a typed JSON API enforced by Zod schemas.
          </li>
          <li>
            It can NEVER touch a skill&apos;s framework parts (API endpoints,
            allowed-tools, lock semantics). Only sections explicitly marked
            curatable are in scope, and safety-critical skills are excluded.
          </li>
          <li>
            Bad proposals are caught by an auto-revert loop: if the next run
            sees more drift after a change, the section rolls back
            automatically and freezes for two cycles.
          </li>
          <li>
            Toggling OFF below stops injecting every applied optimization
            immediately. Overlays stay on disk, so toggling back ON resumes
            them.
          </li>
        </ul>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <CardHeader className="p-0">
          <CardTitle className="text-sm font-semibold">Enabled</CardTitle>
        </CardHeader>
        <ToggleRow
          checked={draft.enabled}
          onChange={(v) => {
            if (v) {
              setDraft({
                ...draft,
                enabled: true,
                excluded_skills: applySmartDefaultExclusions(
                  data.eligible_skills,
                  draft.excluded_skills,
                ),
              });
            } else {
              setDraft({ ...draft, enabled: false });
            }
          }}
          hint="Default OFF. While off, no new runs are scheduled and applied overlays are not injected into sessions."
        />

        <Separator />

        <div>
          <p className="text-sm font-medium">Cadence</p>
          <RadioGroup
            value={draft.cadence}
            onChange={(v) => setDraft({ ...draft, cadence: v as Cadence })}
            options={[
              { value: "daily", label: "Daily", hint: "Tighter feedback, more cost" },
              { value: "weekly", label: "Weekly", hint: "Balanced default" },
              { value: "monthly", label: "Monthly", hint: "Minimal cost" },
            ]}
          />
        </div>

        <Separator />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <LabeledSelect
            label="Execution backend"
            value={draft.backend}
            onChange={(v) => {
              const next = v as Backend;
              setDraft({ ...draft, backend: next, model: DEFAULT_MODEL_BY_BACKEND[next] });
            }}
            options={RUNTIME_AVAILABLE_BACKEND_IDS.map((id) => {
              const backendId = id as BackendId;
              const previewOnly = isUiPreviewOnlyBackend(backendId);
              return {
                value: id,
                label:
                  BACKEND_PROVIDER_SHORT[backendId] +
                  (previewOnly ? UI_PREVIEW_ONLY_BADGE_SUFFIX : ""),
                disabled: previewOnly,
              };
            })}
          />
          <LabeledInput
            label="Model"
            value={draft.model}
            onChange={(v) => setDraft({ ...draft, model: v })}
            placeholder={DEFAULT_MODEL_BY_BACKEND[draft.backend]}
          />
        </div>

        <Separator />

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger
            className="group flex w-full items-center justify-between gap-2 text-left"
            aria-label="Toggle advanced settings"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Advanced</span>
              <span className="text-xs text-muted-foreground">
                Override the auto-selected cohort. {draft.excluded_skills.length} skill
                {draft.excluded_skills.length === 1 ? "" : "s"} excluded.
              </span>
            </div>
            <span
              aria-hidden
              className="text-xs text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
            >
              ▶
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <p className="text-sm font-medium">Per-skill exclusions</p>
            <p className="text-xs text-muted-foreground pb-2">
              Tick a skill to opt it OUT of self-learning. The cohort is built
              from skills that ship a <code>curation.json</code>. By default,
              skills outside the high-impact set ({HIGH_IMPACT_SKILLS.join(", ")})
              are excluded — uncheck to opt them back in.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
              {data.eligible_skills.map((slug) => {
                const checked = draft.excluded_skills.includes(slug);
                const isHighImpact = HIGH_IMPACT_SKILLS.includes(slug);
                return (
                  <label key={slug} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setDraft({
                          ...draft,
                          excluded_skills: checked
                            ? draft.excluded_skills.filter((s) => s !== slug)
                            : [...draft.excluded_skills, slug],
                        })
                      }
                      className="h-4 w-4 accent-primary"
                    />
                    <code className="text-xs">{slug}</code>
                    {isHighImpact && (
                      <Badge variant="green" className="text-[10px]">
                        recommended
                      </Badge>
                    )}
                  </label>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex items-center justify-end gap-2 pt-1">
          {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          <Button onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <CardHeader className="p-0 flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-semibold">Run optimization now</CardTitle>
            <p className="text-xs text-muted-foreground pt-1 max-w-md">
              Triggers a curation run immediately, skipping the cadence wait.
              The next scheduled run will fire one cadence interval after the
              manual click. Use this when you feel the agent&apos;s recall has
              drifted and want it to look at your knowledge layout again.
            </p>
          </div>
          <Button onClick={() => void runNow()} disabled={running || runInFlight || !draft.enabled}>
            {running ? "Starting…" : runInFlight ? "Run in flight" : "Run now"}
          </Button>
        </CardHeader>
        <Separator />
        <CardTitle className="text-sm font-semibold pt-1">Recent runs</CardTitle>
        {data.recent_runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No curation runs yet. Once enabled, the next scheduled cadence
            will populate this list.
          </p>
        ) : (
          <ul className="text-sm divide-y">
            {data.recent_runs.map((r) => (
              <li key={r.id} className="py-2 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs">
                    <code>{r.id}</code>{" "}
                    <span className="text-muted-foreground">·</span>{" "}
                    {new Date(r.started_at).toLocaleString()}{" "}
                    <span className="text-muted-foreground">·</span>{" "}
                    {r.cadence}/{r.backend}/{r.model}
                    {r.is_manual && (
                      <>
                        {" "}
                        <Badge variant="blue" className="ml-1 text-[10px]">manual</Badge>
                      </>
                    )}
                  </span>
                  <Badge variant={r.status === "finalized" ? "green" : "gray"}>
                    {r.status}
                  </Badge>
                </div>
                <RunCounts counts={r.counts ?? {}} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {data.orphan_overlays.length > 0 && (
        <Card className="flex flex-col gap-3 p-4 border-warning">
          <CardHeader className="p-0">
            <CardTitle className="text-sm font-semibold">
              Orphaned overlays ({data.orphan_overlays.length})
            </CardTitle>
          </CardHeader>
          <p className="text-xs text-muted-foreground">
            These overlays remained on disk after a framework update dropped
            their declaration from <code>curation.json</code>. They have no
            effect on rendered skills — the renderer falls back to seed or
            empty — but discarding them keeps disk and declarations in sync.
            Discard is always explicit; orphans are never auto-deleted.
          </p>
          <ul className="text-sm divide-y">
            {data.orphan_overlays.map((o) => (
              <li
                key={`${o.slug}:${o.section_id}`}
                className="py-2 flex items-center justify-between gap-2"
              >
                <span className="text-xs">
                  <code>{o.slug}</code> / <code>{o.section_id}</code>{" "}
                  <span className="text-muted-foreground">·</span>{" "}
                  {o.kind ?? "(unparseable)"}{" "}
                  <span className="text-muted-foreground">·</span> {o.reason}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void discardOrphan(o.slug, o.section_id)}
                >
                  Discard
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function ToggleRow({
  checked,
  onChange,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{checked ? "On" : "Off"}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch
        checked={checked}
        onChange={onChange}
        ariaLabel="Enable self-learning skill optimization"
      />
    </div>
  );
}

function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
        (checked ? "bg-primary" : "bg-input")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-background shadow-sm transition-transform " +
          (checked ? "translate-x-[22px]" : "translate-x-[2px]")
        }
      />
    </button>
  );
}

function RadioGroup({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; hint?: string }[];
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1">
      {options.map((o) => (
        <label
          key={o.value}
          className="flex items-start gap-2 cursor-pointer text-sm rounded-md border border-input p-2"
        >
          <input
            type="radio"
            name={`radio-${options[0].value}`}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="mt-1 h-4 w-4 accent-primary"
          />
          <span className="flex flex-col">
            <span className="font-medium">{o.label}</span>
            {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 px-3"
      />
    </label>
  );
}

function RunCounts({ counts }: { counts: NonNullable<RecentRun["counts"]> }) {
  // `applied` is always shown (even when zero — it's the success metric);
  // failure-cause chips render only when their count is non-zero so a
  // healthy run reads as "N applied" without visual noise.
  return (
    <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground pl-1">
      {RUN_STAT_LABELS.map(({ key, label, emphasise }) => {
        const value = counts[key] ?? 0;
        if (key !== "applied" && value === 0) return null;
        return (
          <span
            key={key}
            className={emphasise && value > 0 ? "text-amber-700 dark:text-amber-300" : undefined}
          >
            {value} {label}
          </span>
        );
      })}
    </div>
  );
}

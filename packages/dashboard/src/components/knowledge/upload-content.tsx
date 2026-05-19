"use client";

import { useMemo, useRef, useState } from "react";
import { Upload, FileText, Loader2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBackends } from "@/lib/hooks/use-backends";
import { useSetupStatus } from "@/lib/hooks/use-setup-status";
import { ApiError } from "@/lib/api-client";
import { getBackendShortLabel } from "@/lib/backend-ui";
import type { BackendId } from "@aitne/shared";

const SOURCES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "self-written", label: "Wrote it myself" },
  { value: "obsidian-export", label: "Exported from Obsidian" },
  { value: "notion-export", label: "Exported from Notion" },
  { value: "other", label: "Other" },
];

const ACCEPT = ".md,.markdown,.txt";
const MAX_BYTES = 64 * 1024;

const AUTO = "__auto__";
const SEP = "::";

interface ImportSuccess {
  traceId: string;
  filename: string;
  source: string;
}

export function KnowledgeUploadContent() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<string>("self-written");
  const [override, setOverride] = useState<string>(AUTO);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<ImportSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: backends } = useBackends();
  const { data: setupStatus } = useSetupStatus();
  const setupIncomplete = setupStatus?.needsSetup === true;

  // Only backends that are runnable RIGHT NOW: enabled, the CLI binary
  // is on PATH, auth is not in a blocked state, and at least one model
  // is available. Showing an unrunnable backend in the picker would
  // fail the import at execute time with a confusing error.
  const pickableBackends = useMemo(() => {
    return (backends?.backends ?? [])
      .filter((b) => b.enabled && b.cliInstalled && b.models.length > 0)
      .filter((b) => b.authStatus !== "expired" && b.authStatus !== "missing");
  }, [backends]);

  const noBackendsAvailable = pickableBackends.length === 0;

  const handleSubmit = async () => {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("source", source);
      if (override !== AUTO) {
        const sepIdx = override.indexOf(SEP);
        if (sepIdx > 0) {
          formData.append("requestedBackendId", override.slice(0, sepIdx) as BackendId);
          formData.append("requestedModelId", override.slice(sepIdx + SEP.length));
        }
      }

      const res = await fetch("/api/knowledge/import", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(res.status, body);
      }
      const data = (await res.json()) as { traceId: string };
      setSuccess({ traceId: data.traceId, filename: file.name, source });
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      if (e instanceof ApiError) {
        const detail = e.body as { message?: string; error?: string } | null;
        setError(detail?.message ?? detail?.error ?? `HTTP ${e.status}`);
      } else {
        setError(e instanceof Error ? e.message : "Upload failed.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setError(null);
    setSuccess(null);
    if (selected && selected.size > MAX_BYTES) {
      setError(
        `File is ${(selected.size / 1024).toFixed(1)} KB. Maximum is ${MAX_BYTES / 1024} KB — split the file and import in pieces.`,
      );
      setFile(null);
      e.target.value = "";
      return;
    }
    setFile(selected);
  };

  if (setupIncomplete) {
    return (
      <div className="max-w-2xl space-y-3">
        <h2 className="text-lg font-semibold">Import a file into Context Files</h2>
        <Alert variant="warning">
          Complete the initial setup wizard first. The{" "}
          <code className="rounded bg-muted px-1">user/*.md</code> files the import targets
          are seeded only after you finish setup —{" "}
          <a href="/setup" className="underline">
            open setup
          </a>
          .
        </Alert>
      </div>
    );
  }

  const formDisabled = submitting || noBackendsAvailable;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Import a file into Context Files</h2>
        <p className="text-sm text-muted-foreground">
          Bring a personal-info file you wrote elsewhere (an Obsidian export, a Notion
          export, a hand-written profile). The agent reads it once and folds its facts into
          the right <code className="rounded bg-muted px-1">user/*.md</code> Context Files —
          appending bullets verbatim, never overwriting, never paraphrasing.
        </p>

        <div className="rounded-md border bg-card p-3 text-sm">
          <p className="font-medium text-foreground">Recommended formats</p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            <li>
              <code className="rounded bg-muted px-1">.md</code> /{" "}
              <code className="rounded bg-muted px-1">.markdown</code> — Markdown.
              Preferred — bullets, headings, and front-matter all carry through.
            </li>
            <li>
              <code className="rounded bg-muted px-1">.txt</code> — plain text. Use when
              the source is unstructured prose.
            </li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            These are the file types every supported execution agent — Claude Code,
            Codex CLI, and Gemini CLI — reads natively, so the import runs the same way
            no matter which backend you pick. Other formats (PDF, DOCX, HTML) are not
            accepted: convert to Markdown or plain text first so the agent reads exactly
            the bytes you intend.
          </p>
        </div>

        <div className="rounded-md border bg-card p-3 text-sm">
          <p className="font-medium text-foreground">Where facts land</p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            <li>Identity (name, timezone, language, DOB) → flagged for your confirmation, not auto-written.</li>
            <li>Relationships (family, partners, close friends) → <code>user/people.md</code></li>
            <li>Work, employer, role, colleagues → <code>user/work.md</code></li>
            <li>Skills, expertise, languages spoken → <code>user/expertise.md</code></li>
            <li>Lifestyle, hobbies, preferences, health → <code>user/personal.md</code></li>
            <li>Goals, aspirations, current focus → <code>user/goals.md</code></li>
            <li>Anything else → <code>user/profile.md</code> under a Misc section.</li>
          </ul>
        </div>

        <div className="rounded-md border bg-card p-3 text-sm">
          <p className="font-medium text-foreground">Strict-fidelity guarantee</p>
          <p className="mt-1 text-muted-foreground">
            The session runs under a dedicated agent profile (
            <code className="rounded bg-muted px-1">profile-importer</code>) materialized
            into <code>CLAUDE.md</code> / <code>AGENTS.md</code> /{" "}
            <code>GEMINI.md</code> for the chosen backend. Its top-level rule:
          </p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            <li>Copy bullets <strong>verbatim</strong> — no paraphrase, no summary, no inference beyond the literal text.</li>
            <li>Existing bullets are never overwritten. Contradictions land in a <code>## Pending Conflicts</code> section for you to resolve.</li>
            <li>If a sentence is ambiguous, the agent skips it and notes the skip in its journal.</li>
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">
          Limits: max file size {MAX_BYTES / 1024} KB (split larger files and import in
          pieces — strict fidelity does not scale beyond this). Files that contain private
          keys, API tokens, or credentials are rejected at upload time and never written to
          disk inside the agent&rsquo;s vault.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium">File</label>
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={onFileChange}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={formDisabled}
            >
              <Upload className="mr-1.5 h-4 w-4" />
              Choose file
            </Button>
            {file && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Accepts <code className="rounded bg-muted px-1">.md</code>,{" "}
            <code className="rounded bg-muted px-1">.markdown</code>, or{" "}
            <code className="rounded bg-muted px-1">.txt</code>. Up to {MAX_BYTES / 1024} KB
            after UTF-8 encoding (Japanese / non-ASCII characters take 3 bytes each).
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Source</label>
          <Select value={source} onValueChange={setSource} disabled={submitting}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">
            Recorded in the journal entry the import session writes when it finishes.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Execution agent</label>
          <Select value={override} onValueChange={setOverride} disabled={submitting || noBackendsAvailable}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>Use default routing</SelectItem>
              {pickableBackends.map((b) => (
                <SelectGroup key={b.id}>
                  <SelectLabel>{getBackendShortLabel(b.id)}</SelectLabel>
                  {b.models.map((m) => (
                    <SelectItem key={`${b.id}${SEP}${m.modelId}`} value={`${b.id}${SEP}${m.modelId}`}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {noBackendsAvailable ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No authenticated backends — set one up under{" "}
              <a href="/connections/backends" className="underline">
                Connections → Backends
              </a>
              .
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Choose which backend runs this import. Only backends you&rsquo;ve
              authenticated and whose CLI binary is on PATH are listed. &ldquo;Use default
              routing&rdquo; falls back to the daemon&rsquo;s configured main backend.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button
            onClick={handleSubmit}
            disabled={!file || submitting || noBackendsAvailable}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Uploading…
              </>
            ) : (
              <>
                <Upload className="mr-1.5 h-4 w-4" />
                Import
              </>
            )}
          </Button>
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        {success && (
          <Alert variant="success">
            Import accepted — the agent is processing{" "}
            <strong>{success.filename}</strong>. Watch progress in{" "}
            <a
              href={`/activity?correlationId=${encodeURIComponent(success.traceId)}`}
              className="underline"
            >
              Activity (trace {success.traceId.slice(0, 8)})
            </a>{" "}
            and review the resulting bullets in{" "}
            <a href="/knowledge?tab=context-files" className="underline">
              Context Files
            </a>{" "}
            once the run finishes.
          </Alert>
        )}
      </div>
    </div>
  );
}

/**
 * Pure path helpers for the automation trace store.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.7.
 *
 * The trace store lives under `${PA_DATA_DIR}/automation-traces/`. Each
 * workflow run gets a subdirectory keyed by its UUID; the dashboard
 * serves trace + screenshot files via
 * `/api/browser-automation/traces/<workflowId>/<file>`. The file-system
 * side lives in `trace-store.ts` (I/O); this module owns the path
 * arithmetic, which is shared by the workflow runner, the API route's
 * static-file handler, and the daily cleanup cron.
 *
 * The two purposes of pulling these helpers out as pure functions:
 *
 *   1. **Directory-traversal defence.** The API route validates that
 *      the requested `<workflowId>/<file>` resolves inside the trace
 *      directory before opening the file. `resolveTraceFilePath`
 *      returns null on any pattern that would escape (`..`, absolute
 *      override, NUL byte, separator characters in the file segment).
 *
 *   2. **Coverage gate.** The schema + path layer is the safety-
 *      critical piece — wrong path validation here would let an agent
 *      read arbitrary disk. Putting it in a pure module lets the test
 *      suite enforce 100% coverage on exactly the surface that matters.
 */

import { isAbsolute, join, normalize, sep } from "node:path";

/** Subdirectory of `PA_DATA_DIR` where all trace assets live. */
export const AUTOMATION_TRACES_DIRNAME = "automation-traces";

/** UUID v4 / non-canonical format permissive — the runner generates via
 *  `crypto.randomUUID()` which returns the canonical hyphenated form. */
export const WORKFLOW_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Allowed filename pattern for a single asset under
 *  `automation-traces/<workflowId>/`. Lower-case letters, digits,
 *  hyphen, underscore, dot — no `/`, no `\`, no NUL, no leading dot
 *  (so `.env` or `..` cannot appear here). */
export const TRACE_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}\.(png|zip|json|jpg|jpeg|webp)$/i;

export interface TracePathInputs {
  paDataDir: string;
  workflowId: string;
}

/** Build the per-workflow directory: `<PA_DATA_DIR>/automation-traces/<wfid>`. */
export function workflowTraceDir(input: TracePathInputs): string {
  return join(input.paDataDir, AUTOMATION_TRACES_DIRNAME, input.workflowId);
}

/** Build the root trace directory: `<PA_DATA_DIR>/automation-traces`. */
export function tracesRootDir(paDataDir: string): string {
  return join(paDataDir, AUTOMATION_TRACES_DIRNAME);
}

/**
 * Resolve an API-served trace path (e.g.
 * `/api/browser-automation/traces/<wfid>/<file>`) to an on-disk
 * absolute path under `paDataDir`, OR return null when the inputs do
 * not pass validation.
 *
 * Null is returned for any of these failure modes:
 *   - `workflowId` does not match `WORKFLOW_ID_PATTERN` (defence against
 *     `../etc` style escapes inserted before the legitimate id)
 *   - `fileName` does not match `TRACE_FILE_PATTERN` (rejects empty,
 *     too-long, embedded-separator, NUL, dotfile, unknown-extension
 *     forms)
 *   - normalised join escapes `<PA_DATA_DIR>/<AUTOMATION_TRACES_DIRNAME>`
 *
 * The third check is belt-and-braces — the regex validation already
 * forbids `/` and `\\`, but a normalize() round-trip catches anything
 * we missed (e.g., an unrecognised Unicode path-separator equivalent).
 */
export function resolveTraceFilePath(
  paDataDir: string,
  workflowId: string,
  fileName: string,
): string | null {
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) return null;
  if (!TRACE_FILE_PATTERN.test(fileName)) return null;
  /* c8 ignore start -- defensive: TRACE_FILE_PATTERN's leading [a-z0-9] anchor rejects any filename that would survive `isAbsolute()` or carry a NUL byte, but both checks stay as a structural assert in case the regex is ever loosened */
  if (fileName.includes("\0")) return null;
  if (isAbsolute(fileName)) return null;
  /* c8 ignore stop */
  const baseDir = tracesRootDir(paDataDir);
  const candidate = normalize(join(baseDir, workflowId, fileName));
  // Either equal to baseDir + sep or starts with baseDir + sep. We use
  // `sep` rather than `/` so the check works on Windows where the
  // normaliser uses `\\`. The `endsWith(sep)` branch on the prefix
  // computation handles operator-supplied PA_DATA_DIRs that carry a
  // trailing separator; in practice the daemon strips it before
  // boot, so the false branch is the hot path. The `startsWith` guard
  // is defensive — every other path validation above already prevents
  // an escape, but the prefix check is the structural lock.
  const prefix =
    /* c8 ignore next -- defensive: PA_DATA_DIR is canonicalised at boot */
    baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  /* c8 ignore next -- defensive: regex pre-filter forbids the segment characters that could make `candidate` escape `baseDir` */
  if (!candidate.startsWith(prefix)) return null;
  return candidate;
}

/** Build the API-served path the workflow stores in its output
 *  schema's `screenshotPath` field. The runner uses this to publish
 *  the URL the dashboard will fetch. */
export function apiPathForTraceFile(
  workflowId: string,
  fileName: string,
): string {
  return `/api/browser-automation/traces/${workflowId}/${fileName}`;
}

/** Per-asset filename built from a label + a tag (timestamp or seq).
 *  Workflow code shouldn't construct filenames by hand — calling this
 *  ensures the result passes `TRACE_FILE_PATTERN`. */
export function makeScreenshotFileName(
  label: string,
  tagMs: number,
): string {
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const stable = safeLabel.length > 0 ? safeLabel : "screenshot";
  return `${tagMs}-${stable}.png`;
}

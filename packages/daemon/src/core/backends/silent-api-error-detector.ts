import type { Logger } from "pino";

/**
 * Silent-API-error detection.
 *
 * When an agent (Claude Code / Codex / Gemini) calls the daemon API via the
 * `pa-api` / `curl` wrappers in `daemon-api-cli.ts` and the daemon returns an
 * HTTP 4xx/5xx, the wrapper keeps exit code 0 (so the agent's tool run
 * "succeeds") and streams the response body verbatim to stdout. The agent can
 * then silently fall back to another tool (e.g. an MCP), and the daemon
 * operator loses all visibility into which of its APIs failed.
 *
 * To restore visibility, the wrappers emit a one-line stderr marker of the
 * form `PA_API_ERROR <json>` on any non-OK response. Each backend core feeds
 * its captured tool-output text (which includes the merged stderr) through
 * `extractSilentApiErrors` and logs whatever it finds via `logSilentApiErrors`.
 * The agent never sees the log; it only sees the marker in its own stderr —
 * which matches what a real operator would see if they ran curl themselves.
 */

export interface SilentApiError {
  method: string;
  path: string;
  status: number;
  bodyPreview: string;
}

const MARKER = "PA_API_ERROR ";

export function extractSilentApiErrors(text: string | null | undefined): SilentApiError[] {
  if (!text || !text.includes(MARKER)) return [];
  const errors: SilentApiError[] = [];
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(MARKER);
    if (idx < 0) continue;
    const payload = line.slice(idx + MARKER.length).trim();
    if (!payload.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (
      parsed
      && typeof parsed === "object"
      && typeof (parsed as SilentApiError).method === "string"
      && typeof (parsed as SilentApiError).path === "string"
      && typeof (parsed as SilentApiError).status === "number"
      && typeof (parsed as SilentApiError).bodyPreview === "string"
    ) {
      errors.push(parsed as SilentApiError);
    }
  }
  return errors;
}

export function logSilentApiErrors(
  log: Logger,
  errors: SilentApiError[],
  context: { backendId: string; sessionId?: string | null; eventType?: string },
): void {
  for (const err of errors) {
    log.warn(
      {
        backendId: context.backendId,
        sessionId: context.sessionId ?? null,
        eventType: context.eventType,
        method: err.method,
        path: err.path,
        status: err.status,
        bodyPreview: err.bodyPreview,
      },
      "Daemon API returned error to agent (silent API error)",
    );
  }
}

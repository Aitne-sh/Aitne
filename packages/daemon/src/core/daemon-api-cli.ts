import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export const SESSION_DAEMON_API_BIN_DIR = join(".pa", "bin");
export const SESSION_DAEMON_API_CLI_REL_PATH = join(
  SESSION_DAEMON_API_BIN_DIR,
  "pa-api",
);
export const SESSION_DAEMON_CURL_SHIM_REL_PATH = join(
  SESSION_DAEMON_API_BIN_DIR,
  "curl",
);
export const DAEMON_API_BASE_URL_ENV = "PA_DAEMON_API_BASE_URL";
export const DAEMON_API_READ_TOKEN_ENV = "PA_DAEMON_READ_TOKEN";
// DELEGATED-MODE-V2-DESIGN.md §4.2.3 — env-var pathway for the
// `x-session-backend` / `x-event-id` / `x-process-key` headers used by the
// delegated-mode endpoints. The CLI shims auto-inject these on requests
// to `/api/integrations/*/exec` and `/api/delegated/run` so skill prose
// can call plain curl without the agent having to compose env-var
// expansions inline (which Claude Code's classifier denies). Scoping to
// the delegated routes keeps the session identity from leaking onto
// unrelated endpoints. (The historical `/api/integrations/*/invoke` RPC
// route was retired 2026-05-01; the regex below intentionally no longer
// matches it so a future reactivation must explicitly reopen the path.)
export const DAEMON_API_SESSION_BACKEND_ENV = "PA_SESSION_BACKEND";
export const DAEMON_API_EVENT_ID_ENV = "PA_EVENT_ID";
export const DAEMON_API_PROCESS_KEY_ENV = "PA_PROCESS_KEY";
export const DAEMON_API_SESSION_ID_ENV = "PA_SESSION_ID";
// Event correlationId — distinct from PA_EVENT_ID (which carries the
// delegated-call parent attribution for /exec). PA_EVENT_CORRELATION_ID is the
// full Event.correlationId so the dispatcher can attribute /api/notify
// calls back to the in-flight scheduled.task / morning_routine / message.*
// run. Used to suppress the implicit "final assistant text → DM" forward
// when the agent already sent a user-facing notification through /api/notify.
export const DAEMON_API_EVENT_CORRELATION_ID_ENV = "PA_EVENT_CORRELATION_ID";

const DAEMON_API_CLI_SOURCE = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BASE_URL_ENV = "${DAEMON_API_BASE_URL_ENV}";
const READ_TOKEN_ENV = "${DAEMON_API_READ_TOKEN_ENV}";
const SESSION_BACKEND_ENV = "${DAEMON_API_SESSION_BACKEND_ENV}";
const EVENT_ID_ENV = "${DAEMON_API_EVENT_ID_ENV}";
const PROCESS_KEY_ENV = "${DAEMON_API_PROCESS_KEY_ENV}";
const SESSION_ID_ENV = "${DAEMON_API_SESSION_ID_ENV}";
const EVENT_CORRELATION_ID_ENV = "${DAEMON_API_EVENT_CORRELATION_ID_ENV}";
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const ALLOWED_HEADERS = new Set([
  "content-type",
  // The shim sets a sensible default Accept itself; honour an explicit one
  // too so a request-format hint the agent adds out of habit
  // (\`-H "Accept: application/json"\`) does not fail the whole call and
  // burn a retry turn.
  "accept",
  "x-lock-id",
  "x-session-id",
  // DELEGATED-MODE-V2-DESIGN.md §4.2.3 — delegated-mode pathway. The
  // agent does not type these directly; the env-var auto-injection below
  // sets them on outbound requests to /api/integrations/*/exec, the
  // RESERVED /invoke, and /api/delegated/run. Allowlisted here so a
  // skill body that does pass them explicitly still works.
  "x-session-backend",
  "x-event-id",
  "x-process-key",
  // Notify-dedup pathway — auto-injected on /api/notify calls below so the
  // dispatcher can attribute the call to the in-flight event run.
  "x-pa-event-correlation-id",
  "x-pa-session-id",
]);
// Delegated-mode routes that the env-var auto-injection scopes to. Covers
// /api/integrations/:key/exec (task mode, agent-facing) and
// /api/delegated/run (Phase 2 generic task mode). The retired
// /api/integrations/:key/invoke RPC route is intentionally NOT matched
// (retired 2026-05-01); a future reactivation must explicitly reopen the
// path. Note: the regex must mirror the matched real-world path shape;
// pa-api injects header auto-attribution only when the path matches.
const DELEGATED_ROUTE_PATTERN =
  /^\\/api\\/(?:integrations\\/[^/]+\\/exec|delegated\\/run)$/;
const NOTIFY_ROUTE_PATTERN = /^\\/api\\/notify$/;
// docs/design/appendices/morning-routine-optimization.md §"PATCH
// /api/agent-actions/self" — the endpoint authenticates via the
// dispatcher-injected x-pa-event-correlation-id + x-process-key
// headers. Scope the auto-injection to this exact path so the
// session identity does not leak onto unrelated endpoints.
const AGENT_ACTIONS_SELF_ROUTE_PATTERN = /^\\/api\\/agent-actions\\/self$/;

function usage(message) {
  if (message) {
    console.error(message);
    console.error("");
  }
  console.error("Usage: pa-api <METHOD> <PATH> [--json <body>] [--output <file>] [--header <Name=Value>]");
  console.error("");
  console.error("Examples:");
  console.error("  pa-api GET /api/context/today");
  console.error("  pa-api PATCH /api/context/today --json '{\\"section\\":\\"agent_log\\",\\"mode\\":\\"append\\",\\"content\\":\\"- 09:30 synced\\"}'");
  console.error("  pa-api POST /api/receipts/1/download --output receipt.pdf");
}

function fail(message, code = 2) {
  usage(message);
  process.exit(code);
}

function parseHeader(raw) {
  const eqIdx = raw.indexOf("=");
  if (eqIdx <= 0) {
    fail(\`Invalid --header value: \${raw}\`);
  }
  const name = raw.slice(0, eqIdx).trim();
  const value = raw.slice(eqIdx + 1);
  const lower = name.toLowerCase();
  if (!ALLOWED_HEADERS.has(lower)) {
    fail(\`Header not allowed: \${name}\`);
  }
  return { name, value };
}

function normalizePath(rawPath, baseUrl) {
  if (!rawPath.startsWith("/api/")) {
    fail("PATH must start with /api/.");
  }
  if (/\\s/.test(rawPath)) {
    fail("PATH must not contain whitespace.");
  }
  let url;
  try {
    url = new URL(rawPath, baseUrl);
  } catch {
    fail(\`Malformed PATH: \${rawPath}\`);
  }
  const base = new URL(baseUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) {
    fail("Only daemon /api/* paths are allowed.");
  }
  return url;
}

// Read all of stdin into a UTF-8 string. Lets \`--json @-\` accept a
// heredoc body so large / multi-line context updates can use the same
// shape the safety preamble already documents for the curl shim.
function readAllStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    usage();
    return;
  }

  const method = args.shift().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    fail(\`Unsupported method: \${method}\`);
  }

  const rawPath = args.shift();
  if (!rawPath) {
    fail("PATH is required.");
  }

  const baseUrl = process.env[BASE_URL_ENV];
  if (!baseUrl) {
    fail(\`\${BASE_URL_ENV} is not set.\`, 1);
  }

  const url = normalizePath(rawPath, baseUrl);
  const headers = new Headers();
  headers.set("accept", "application/json, text/plain, */*");
  headers.set("user-agent", "personal-agent/pa-api");

  const readToken = process.env[READ_TOKEN_ENV];
  if (readToken) {
    headers.set("x-read-token", readToken);
  }

  // DELEGATED-MODE-V2-DESIGN.md §4.2.3 — auto-inject session identity on
  // /api/integrations/*/exec (task mode) and /api/delegated/run. Mirrors
  // the curl shim's PA_TURN_TOKEN pattern: skill prose calls plain pa-api
  // / curl, the shim adds the header from env. Scoped to the delegated
  // routes so the identity does not leak onto unrelated endpoints.
  if (DELEGATED_ROUTE_PATTERN.test(url.pathname)) {
    const sessionBackend = process.env[SESSION_BACKEND_ENV];
    if (sessionBackend && !headers.has("x-session-backend")) {
      headers.set("x-session-backend", sessionBackend);
    }
    const eventId = process.env[EVENT_ID_ENV];
    if (eventId && !headers.has("x-event-id")) {
      headers.set("x-event-id", eventId);
    }
    const processKey = process.env[PROCESS_KEY_ENV];
    if (processKey && !headers.has("x-process-key")) {
      headers.set("x-process-key", processKey);
    }
  }

  // Notify-dedup — when an in-flight event is running an agent that calls
  // /api/notify, attach the correlationId so the dispatcher knows the
  // user-facing notification has already been sent and can suppress the
  // implicit "final assistant text → DM" forward in processResult.
  if (NOTIFY_ROUTE_PATTERN.test(url.pathname)) {
    const correlationId = process.env[EVENT_CORRELATION_ID_ENV];
    if (correlationId && !headers.has("x-pa-event-correlation-id")) {
      headers.set("x-pa-event-correlation-id", correlationId);
    }
    const sessionId = process.env[SESSION_ID_ENV];
    if (sessionId && !headers.has("x-pa-session-id")) {
      headers.set("x-pa-session-id", sessionId);
    }
  }

  // Agent-self-write pathway — PATCH /api/agent-actions/self resolves
  // the row via correlation_id + process_key. Skill prose calls plain
  // pa-api / curl; the shim attaches both headers from the
  // dispatcher-injected env vars.
  if (AGENT_ACTIONS_SELF_ROUTE_PATTERN.test(url.pathname)) {
    const correlationId = process.env[EVENT_CORRELATION_ID_ENV];
    if (correlationId && !headers.has("x-pa-event-correlation-id")) {
      headers.set("x-pa-event-correlation-id", correlationId);
    }
    const processKey = process.env[PROCESS_KEY_ENV];
    if (processKey && !headers.has("x-process-key")) {
      headers.set("x-process-key", processKey);
    }
  }

  let body = undefined;
  let outputPath = null;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") {
      if (body !== undefined) {
        fail("--json may only be provided once.");
      }
      const jsonBody = args.shift();
      if (jsonBody === undefined) {
        fail("--json requires a value.");
      }
      headers.set("content-type", "application/json");
      // Heredoc parity with the curl shim. \`--json @-\` reads stdin so
      // \`pa-api PATCH /api/context/today --json @- <<'JSON' ... JSON\` works
      // for large bodies. Bare \`@<path>\` is refused — file-read shape
      // matches the curl shim's deny rule.
      if (jsonBody === "@-") {
        body = await readAllStdin();
      } else if (jsonBody.length > 0 && jsonBody[0] === "@") {
        fail(\`--json \${jsonBody}: @<path> file-read syntax is not allowed; use \\\`--json @-\\\` with a heredoc instead.\`);
      } else {
        body = jsonBody;
      }
      continue;
    }

    if (arg === "--output") {
      if (outputPath !== null) {
        fail("--output may only be provided once.");
      }
      outputPath = args.shift();
      if (!outputPath) {
        fail("--output requires a file path.");
      }
      continue;
    }

    if (arg === "--header") {
      const rawHeader = args.shift();
      if (!rawHeader) {
        fail("--header requires NAME=VALUE.");
      }
      const parsed = parseHeader(rawHeader);
      headers.set(parsed.name, parsed.value);
      continue;
    }

    fail(\`Unknown option: \${arg}\`);
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
  });

  const data = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const bodyPreview = data.slice(0, 200).toString("utf-8");
    const marker = JSON.stringify({
      method,
      path: url.pathname + url.search,
      status: response.status,
      bodyPreview,
    });
    process.stderr.write(\`PA_API_ERROR \${marker}\\n\`);
  }
  if (outputPath !== null) {
    const fullPath = resolve(outputPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, data);
    return;
  }

  process.stdout.write(data);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(\`pa-api failed: \${message}\`);
  process.exit(1);
});
`;

const DAEMON_CURL_SHIM_SOURCE = `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const BASE_URL_ENV = "${DAEMON_API_BASE_URL_ENV}";
const READ_TOKEN_ENV = "${DAEMON_API_READ_TOKEN_ENV}";
const SESSION_BACKEND_ENV = "${DAEMON_API_SESSION_BACKEND_ENV}";
const EVENT_ID_ENV = "${DAEMON_API_EVENT_ID_ENV}";
const PROCESS_KEY_ENV = "${DAEMON_API_PROCESS_KEY_ENV}";
const SESSION_ID_ENV = "${DAEMON_API_SESSION_ID_ENV}";
const EVENT_CORRELATION_ID_ENV = "${DAEMON_API_EVENT_CORRELATION_ID_ENV}";
const ALLOWED_HEADERS = new Set([
  "content-type",
  // Honour an explicit Accept (the shim also sets a default) so the agent's
  // habitual \`-H "Accept: application/json"\` does not fail and trigger a retry.
  "accept",
  "x-lock-id",
  "x-session-id",
  "x-turn-token",
  "x-filename",
  "x-caption",
  // DELEGATED-MODE-V2-DESIGN.md §4.2.3 — delegated-mode pathway
  // (auto-injected on /exec and /api/delegated/run).
  "x-session-backend",
  "x-event-id",
  "x-process-key",
  // Notify-dedup pathway — auto-injected on /api/notify calls below.
  "x-pa-event-correlation-id",
  "x-pa-session-id",
]);
// Delegated-mode routes that the env-var auto-injection scopes to. Covers
// /api/integrations/:key/exec (task mode, agent-facing) and
// /api/delegated/run (Phase 2 generic task mode). The retired
// /api/integrations/:key/invoke RPC route is intentionally NOT matched
// (retired 2026-05-01); a future reactivation must explicitly reopen the
// path. Note: the regex must mirror the matched real-world path shape;
// pa-api injects header auto-attribution only when the path matches.
const DELEGATED_ROUTE_PATTERN =
  /^\\/api\\/(?:integrations\\/[^/]+\\/exec|delegated\\/run)$/;
const NOTIFY_ROUTE_PATTERN = /^\\/api\\/notify$/;
// docs/design/appendices/morning-routine-optimization.md §"PATCH
// /api/agent-actions/self" — the endpoint authenticates via the
// dispatcher-injected x-pa-event-correlation-id + x-process-key
// headers. Scope the auto-injection to this exact path so the
// session identity does not leak onto unrelated endpoints.
const AGENT_ACTIONS_SELF_ROUTE_PATTERN = /^\\/api\\/agent-actions\\/self$/;
const IGNORED_FLAGS = new Set(["-s", "--silent", "--show-error"]);

// MIME inference for plain-text / data formats that have no magic bytes.
// The daemon's ingest pipeline accepts a narrow set of declared text MIMEs
// as fallback when file-type detection is empty. An untyped Blob would send
// "application/octet-stream" and trip undetected_mime even for a .md file.
const TEXT_EXT_MIME = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".html": "text/html",
  ".htm": "text/html",
};
function inferMimeFromName(name) {
  const lower = name.toLowerCase();
  for (const ext of Object.keys(TEXT_EXT_MIME)) {
    if (lower.endsWith(ext)) return TEXT_EXT_MIME[ext];
  }
  return undefined;
}

function fail(message, code = 2) {
  console.error(\`curl wrapper error: \${message}\`);
  process.exit(code);
}

function parseHeader(raw) {
  const eqIdx = raw.indexOf(":");
  if (eqIdx <= 0) {
    fail(\`Invalid header: \${raw}\`);
  }
  const name = raw.slice(0, eqIdx).trim();
  const value = raw.slice(eqIdx + 1).trim();
  if (!ALLOWED_HEADERS.has(name.toLowerCase())) {
    fail(\`Header not allowed: \${name}\`);
  }
  return { name, value };
}

// Read all of stdin into a UTF-8 string. Used by the \`-d @-\` codepath
// to honour the safety preamble's documented heredoc shape:
// \`curl ... -d @- <<'JSON' ... JSON\`. Returns "" if stdin is closed
// (e.g. the agent typed \`-d @-\` without redirecting anything in).
function readAllStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

function normalizeUrl(rawUrl, baseUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(\`Malformed URL: \${rawUrl}\`);
  }
  const base = new URL(baseUrl);
  const allowedHosts = new Set(["localhost", "127.0.0.1"]);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const expectedPort = base.port || (base.protocol === "https:" ? "443" : "80");
  if (!allowedHosts.has(url.hostname) || port !== expectedPort) {
    fail("curl is restricted to the daemon loopback host and port.");
  }
  if (!url.pathname.startsWith("/api/")) {
    fail("curl is restricted to /api/* daemon routes.");
  }
  url.protocol = base.protocol;
  url.hostname = base.hostname;
  url.port = base.port;
  return url;
}

async function main() {
  const args = process.argv.slice(2);
  const baseUrl = process.env[BASE_URL_ENV];
  if (!baseUrl) {
    fail(\`\${BASE_URL_ENV} is not set.\`, 1);
  }

  let method = null;
  let url = null;
  let body = undefined;
  let outputPath = null;
  const formFields = [];
  const headers = new Headers();
  headers.set("accept", "application/json, text/plain, */*");
  headers.set("user-agent", "personal-agent/curl-wrapper");

  const readToken = process.env[READ_TOKEN_ENV];
  if (readToken) {
    headers.set("x-read-token", readToken);
  }

  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (IGNORED_FLAGS.has(arg)) {
      continue;
    }
    if (arg === "-X" || arg === "--request") {
      method = args[idx + 1]?.toUpperCase();
      idx += 1;
      continue;
    }
    if (arg === "-H" || arg === "--header") {
      const rawHeader = args[idx + 1];
      if (!rawHeader) {
        fail(\`\${arg} requires a value.\`);
      }
      const parsed = parseHeader(rawHeader);
      headers.set(parsed.name, parsed.value);
      idx += 1;
      continue;
    }
    if (
      arg === "-d"
      || arg === "--data"
      || arg === "--data-raw"
      || arg === "--data-binary"
    ) {
      const rawBody = args[idx + 1];
      if (rawBody === undefined) {
        fail(\`\${arg} requires a value.\`);
      }
      // \`-d @-\` is curl's stdin marker. The shared safety preamble
      // recommends heredoc bodies (\`-d @- <<'JSON' ... JSON\`) for
      // multi-line / large payloads. Honour that contract by actually
      // reading stdin when @- is requested. Bare \`@<path>\` forms are
      // file-read shapes — refuse outright (the security hook already
      // blocks them at the Bash layer, but defense-in-depth here means
      // the shim never reads from disk).
      if (rawBody === "@-") {
        body = await readAllStdin();
      } else if (rawBody.length > 0 && rawBody[0] === "@") {
        fail(\`\${arg} \${rawBody}: @<path> file-read syntax is not allowed; use \\\`-d @-\\\` with a heredoc instead.\`);
      } else {
        body = rawBody;
      }
      idx += 1;
      continue;
    }
    // Real curl 7.82+ \`--json <body>\` is shorthand for setting
    // Content-Type: application/json + Accept: application/json + sending
    // the body. The agent learns this shape from skill prose and from
    // pa-api (which has its own --json). Matching curl's behavior here
    // avoids the previous "Unsupported curl flag: --json" failure that
    // burned budget on every routine.morning_routine_today retry.
    if (arg === "--json") {
      const rawBody = args[idx + 1];
      if (rawBody === undefined) {
        fail("--json requires a value.");
      }
      if (rawBody === "@-") {
        body = await readAllStdin();
      } else if (rawBody.length > 0 && rawBody[0] === "@") {
        fail(\`--json \${rawBody}: @<path> file-read syntax is not allowed; use \\\`--json @-\\\` with a heredoc instead.\`);
      } else {
        body = rawBody;
      }
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      headers.set("accept", "application/json");
      idx += 1;
      continue;
    }
    // Real curl \`-I\` / \`--head\` issues a HEAD request. HEAD is in
    // ALLOWED_METHODS so this is safe; supporting the flag keeps the
    // agent's muscle memory working when it probes for existence.
    if (arg === "-I" || arg === "--head") {
      method = "HEAD";
      continue;
    }
    if (arg === "-o" || arg === "--output") {
      const filePath = args[idx + 1];
      if (!filePath) {
        fail(\`\${arg} requires a file path.\`);
      }
      outputPath = filePath;
      idx += 1;
      continue;
    }
    if (arg === "-F" || arg === "--form") {
      const rawForm = args[idx + 1];
      if (!rawForm) {
        fail(\`\${arg} requires a NAME=VALUE or NAME=@FILE value.\`);
      }
      formFields.push(rawForm);
      idx += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(\`Unsupported curl flag: \${arg}\`);
    }
    if (url !== null) {
      fail("Only one URL is supported.");
    }
    url = normalizeUrl(arg, baseUrl);
  }

  if (!url) {
    fail("A daemon API URL is required.");
  }

  let resolvedBody = body;
  if (formFields.length > 0) {
    const form = new FormData();
    for (const field of formFields) {
      const eqIdx = field.indexOf("=");
      if (eqIdx <= 0) fail(\`Invalid -F value: \${field}\`);
      const name = field.slice(0, eqIdx);
      const value = field.slice(eqIdx + 1);
      if (value.startsWith("@")) {
        const filePath = value.slice(1);
        const fileBytes = readFileSync(filePath);
        const filename = basename(filePath);
        const inferred = inferMimeFromName(filename);
        const blob = inferred
          ? new Blob([fileBytes], { type: inferred })
          : new Blob([fileBytes]);
        form.append(name, blob, filename);
      } else {
        form.append(name, value);
      }
    }
    resolvedBody = form;
  }
  const resolvedMethod = method ?? (body !== undefined || formFields.length > 0 ? "POST" : "GET");
  // Claude Code CLI's security classifier denies any Bash command that
  // expands an env var inline (\`-H "X-Turn-Token: \$PA_TURN_TOKEN"\`), so the
  // agent cannot attach the per-turn token itself. We inject it here instead,
  // scoped to the outbound-attachments route so the token never leaks onto
  // other endpoints.
  const turnToken = process.env.PA_TURN_TOKEN;
  if (
    turnToken
    && url.pathname === "/api/chat/outbound-attachments"
    && !headers.has("x-turn-token")
  ) {
    headers.set("x-turn-token", turnToken);
  }

  // DELEGATED-MODE-V2-DESIGN.md §4.2.3 — auto-inject session identity on
  // /api/integrations/*/exec (task mode) and /api/delegated/run. Same
  // pattern as the turn token above: skill prose calls plain curl, the
  // shim adds the header from env.
  if (DELEGATED_ROUTE_PATTERN.test(url.pathname)) {
    const sessionBackend = process.env[SESSION_BACKEND_ENV];
    if (sessionBackend && !headers.has("x-session-backend")) {
      headers.set("x-session-backend", sessionBackend);
    }
    const eventId = process.env[EVENT_ID_ENV];
    if (eventId && !headers.has("x-event-id")) {
      headers.set("x-event-id", eventId);
    }
    const processKey = process.env[PROCESS_KEY_ENV];
    if (processKey && !headers.has("x-process-key")) {
      headers.set("x-process-key", processKey);
    }
  }

  // Notify-dedup — see pa-api shim for rationale.
  if (NOTIFY_ROUTE_PATTERN.test(url.pathname)) {
    const correlationId = process.env[EVENT_CORRELATION_ID_ENV];
    if (correlationId && !headers.has("x-pa-event-correlation-id")) {
      headers.set("x-pa-event-correlation-id", correlationId);
    }
    const sessionId = process.env[SESSION_ID_ENV];
    if (sessionId && !headers.has("x-pa-session-id")) {
      headers.set("x-pa-session-id", sessionId);
    }
  }

  // Agent-self-write — see pa-api shim for rationale.
  if (AGENT_ACTIONS_SELF_ROUTE_PATTERN.test(url.pathname)) {
    const correlationId = process.env[EVENT_CORRELATION_ID_ENV];
    if (correlationId && !headers.has("x-pa-event-correlation-id")) {
      headers.set("x-pa-event-correlation-id", correlationId);
    }
    const processKey = process.env[PROCESS_KEY_ENV];
    if (processKey && !headers.has("x-process-key")) {
      headers.set("x-process-key", processKey);
    }
  }
  const response = await fetch(url, {
    method: resolvedMethod,
    headers,
    body: resolvedBody,
  });

  const data = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const bodyPreview = data.slice(0, 200).toString("utf-8");
    const marker = JSON.stringify({
      method: resolvedMethod,
      path: url.pathname + url.search,
      status: response.status,
      bodyPreview,
    });
    process.stderr.write(\`PA_API_ERROR \${marker}\\n\`);
  }
  if (outputPath !== null) {
    const fullPath = resolve(outputPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, data);
    return;
  }
  process.stdout.write(data);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(\`curl wrapper failed: \${message}\`);
  process.exit(1);
});
`;

export function ensureDaemonApiCli(sessionDir: string): string {
  const cliPath = join(sessionDir, SESSION_DAEMON_API_CLI_REL_PATH);
  const curlShimPath = join(sessionDir, SESSION_DAEMON_CURL_SHIM_REL_PATH);
  mkdirSync(dirname(cliPath), { recursive: true, mode: 0o700 });
  writeFileSync(cliPath, DAEMON_API_CLI_SOURCE, { encoding: "utf-8", mode: 0o700 });
  chmodSync(cliPath, 0o700);
  writeFileSync(curlShimPath, DAEMON_CURL_SHIM_SOURCE, { encoding: "utf-8", mode: 0o700 });
  chmodSync(curlShimPath, 0o700);
  // POSIX: the shebang + 0o700 makes the extensionless scripts executable and
  // PATH-resolvable. On Windows, CreateProcess/cmd only run files whose ext is
  // in PATHEXT, so an extensionless shebang file is never executed: a bare
  // `curl` would silently fall through to the real curl.exe (bypassing the
  // daemon-API auth/header injection and safety hooks) and `pa-api` would be
  // "command not found". Write sibling .cmd launchers so PATHEXT resolution
  // finds these and shadows the real curl.exe; cmd propagates node's errorlevel
  // as the exit code. (The chmod above is a harmless near-no-op on Windows.)
  /* c8 ignore start -- win32-only PATHEXT shim; the POSIX test runner never enters this branch */
  if (process.platform === "win32") {
    const binDir = join(sessionDir, SESSION_DAEMON_API_BIN_DIR);
    writeFileSync(join(binDir, "pa-api.cmd"), '@echo off\r\nnode "%~dp0pa-api" %*\r\n', {
      encoding: "utf-8",
    });
    writeFileSync(join(binDir, "curl.cmd"), '@echo off\r\nnode "%~dp0curl" %*\r\n', {
      encoding: "utf-8",
    });
  }
  /* c8 ignore stop */
  return cliPath;
}

/**
 * Identity-bearing env vars consumed by the CLI shims when a delegated
 * call targets /api/integrations/*\/exec (or /api/delegated/run).
 * Optional — when omitted, the shim just doesn't attach the corresponding
 * header. Callers pass `sessionBackend` unconditionally on agent backend
 * spawns; `eventId` / `processKey` flow in from the dispatcher so
 * `agent_actions` rows get parent attribution.
 *
 * DELEGATED-MODE-V2-DESIGN.md §4.2.3.
 */
export interface DaemonApiCliEnvOptions {
  readToken?: string;
  sessionBackend?: string;
  eventId?: string;
  processKey?: string;
  sessionId?: number | string;
  /** Event.correlationId for the in-flight dispatcher run. Auto-injected
   *  by the shims onto /api/notify calls so the dispatcher can suppress
   *  the implicit final-text DM forward when the agent already notified. */
  eventCorrelationId?: string;
}

export function buildDaemonApiCliEnv(
  sessionDir: string,
  apiPort: number,
  optionsOrReadToken?: string | DaemonApiCliEnvOptions,
): Record<string, string> {
  const options: DaemonApiCliEnvOptions =
    typeof optionsOrReadToken === "string"
      ? { readToken: optionsOrReadToken }
      : (optionsOrReadToken ?? {});

  const pathParts = [join(sessionDir, SESSION_DAEMON_API_BIN_DIR)];
  if (process.env.PATH && process.env.PATH.length > 0) {
    pathParts.push(process.env.PATH);
  }

  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    PATH: pathParts.join(delimiter),
    [DAEMON_API_BASE_URL_ENV]: `http://127.0.0.1:${apiPort}`,
  };

  if (options.readToken) {
    env[DAEMON_API_READ_TOKEN_ENV] = options.readToken;
  } else {
    delete env[DAEMON_API_READ_TOKEN_ENV];
  }

  if (options.sessionBackend) {
    env[DAEMON_API_SESSION_BACKEND_ENV] = options.sessionBackend;
  } else {
    delete env[DAEMON_API_SESSION_BACKEND_ENV];
  }

  if (options.eventId) {
    env[DAEMON_API_EVENT_ID_ENV] = options.eventId;
  } else {
    delete env[DAEMON_API_EVENT_ID_ENV];
  }

  if (options.processKey) {
    env[DAEMON_API_PROCESS_KEY_ENV] = options.processKey;
  } else {
    delete env[DAEMON_API_PROCESS_KEY_ENV];
  }

  if (options.sessionId !== undefined && String(options.sessionId).length > 0) {
    env[DAEMON_API_SESSION_ID_ENV] = String(options.sessionId);
  } else {
    delete env[DAEMON_API_SESSION_ID_ENV];
  }

  if (options.eventCorrelationId) {
    env[DAEMON_API_EVENT_CORRELATION_ID_ENV] = options.eventCorrelationId;
  } else {
    delete env[DAEMON_API_EVENT_CORRELATION_ID_ENV];
  }

  return env;
}

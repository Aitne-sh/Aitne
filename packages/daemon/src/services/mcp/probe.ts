import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { toSafeErrorMessage } from "../../logging.js";
import type { McpProbeResult, McpServer } from "./types.js";

const PROBE_TIMEOUT_MS = 10_000;
/**
 * MCP protocol version we send in `initialize`. The three official clients
 * (Claude, Codex, Gemini) all ship with `2024-11-05` or later negotiators,
 * so the probe advertising 2024-11-05 is the lowest-common-denominator that
 * still gets us `tools/list` support. Upstream spec:
 * https://modelcontextprotocol.io/specification/2024-11-05
 */
const MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * B-003 Phase 2 — MCP probe sandbox.
 *
 * Runs MCP `initialize` + `tools/list` against a server definition without
 * committing it to the session flow. Three transport shapes are supported:
 *
 * - **stdio**: spawn the command under a strict env allowlist in a
 *   per-probe cwd, 10 s timeout, kill the whole process tree on timeout.
 * - **http**: POST JSON-RPC with `Accept: application/json, text/event-stream`
 *   (Streamable HTTP). Redirects only accepted if same origin.
 * - **sse**: same as http for this probe — we never open the event stream
 *   here, we only issue the JSON-RPC exchange against the MCP endpoint.
 *
 * The probe intentionally hand-rolls the minimal JSON-RPC 2.0 exchange
 * rather than pulling in `@modelcontextprotocol/sdk` for Phase 2. This
 * keeps the dep surface stable; Phase 3 can adopt the SDK when we wire
 * actual tool calls and need the full client lifecycle.
 */

export interface McpProbeOptions {
  /** `PA_DATA_DIR` — the per-probe sandbox cwd lives under `<dataDir>/mcp`. */
  dataDir: string;
  /** Resolved secrets keyed by variable / header name. */
  secrets: Record<string, string>;
  /** Override for tests — default `PROBE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Clock injection for deterministic durationMs in tests. */
  now?: () => number;
}

export async function probeMcpServer(
  server: Pick<
    McpServer,
    "id" | "transport" | "command" | "args" | "cwd" | "url" | "envKeys" | "headerKeys"
  >,
  options: McpProbeOptions,
): Promise<McpProbeResult> {
  const now = options.now ?? Date.now;
  const start = now();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  try {
    const tools = await runProbe(server, options, timeoutMs);
    return {
      ok: true,
      toolCount: tools.length,
      tools,
      durationMs: Math.max(0, now() - start),
    };
  } catch (err) {
    return {
      ok: false,
      toolCount: 0,
      tools: [],
      error: toSafeErrorMessage(err),
      durationMs: Math.max(0, now() - start),
    };
  }
}

async function runProbe(
  server: Parameters<typeof probeMcpServer>[0],
  options: McpProbeOptions,
  timeoutMs: number,
): Promise<McpProbeResult["tools"]> {
  switch (server.transport) {
    case "stdio":
      return probeStdio(server, options, timeoutMs);
    case "http":
    case "sse":
      return probeHttp(server, options, timeoutMs);
    default:
      // Defensive fallback for rows hand-edited or produced by a future
      // migration that introduces a transport this probe doesn't yet know.
      throw new Error(
        `Unsupported transport: ${String((server as { transport: string }).transport)}`,
      );
  }
}

/* ------------------------------------------------------------------ *
 * stdio transport
 * ------------------------------------------------------------------ */

/**
 * Minimal env allowlist that lets common MCP server binaries (npx, uvx,
 * node, python) resolve. We intentionally do NOT inherit `process.env` —
 * the probe is an uncontrolled third party and should only see what we
 * hand it.
 */
const BASE_STDIO_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "NODE_PATH",
  "NVM_DIR",
] as const;

function buildStdioEnv(
  envKeys: readonly string[],
  secrets: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_STDIO_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const key of envKeys) {
    const v = secrets[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

async function probeStdio(
  server: Parameters<typeof probeMcpServer>[0],
  options: McpProbeOptions,
  timeoutMs: number,
): Promise<McpProbeResult["tools"]> {
  if (!server.command) {
    throw new Error("stdio probe requires server.command");
  }

  const probeId = `${server.id}-${randomUUID().slice(0, 8)}`;
  const sandboxCwd = join(options.dataDir, "mcp", server.id, "probe-sandbox", probeId);
  await mkdir(sandboxCwd, { recursive: true, mode: 0o700 });

  // `??` fallbacks: the McpServer shape materializes envKeys/headerKeys as
  // required arrays, but the DB row can carry `args` as null, so only that
  // path is genuinely observable from tests.
  const env = buildStdioEnv(server.envKeys, options.secrets);
  const child = spawn(server.command, server.args ?? [], {
    cwd: server.cwd ?? sandboxCwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    // POSIX: detached=true makes the child a process-group leader so the
    // killTree below can take down grandchildren via `kill -pid`. On
    // Windows there are no process groups; `taskkill /T` reads the
    // parent-pid chain instead, so the flag is unnecessary there and the
    // hidden-window helps avoid a flashing console for child binaries.
    detached: process.platform !== "win32",
    windowsHide: true,
    // MCP stdio commands are overwhelmingly npx/uvx/pnpm launchers, which
    // resolve to .cmd/.ps1 batch shims on Windows; those need a shell to
    // launch (shell:false spawn of a bare `npx` ENOENTs). POSIX keeps
    // shell:false — bare npx/node resolve via PATH+exec-bit there. Same
    // win32-gated pattern as scripts/run-node.mjs / bin/aitne.mjs spawns;
    // the taskkill /T parent-pid walk above reaps the added cmd.exe wrapper.
    shell: process.platform === "win32",
  });

  let settled = false;
  const stderrBuf: string[] = [];
  const killTree = () => {
    /* c8 ignore next — defensive; spawn always assigns pid, killed flips after
       our own kill() call. Kept so a mocked child in future tests can't escape. */
    if (child.pid == null || child.killed) return;
    /* c8 ignore start — Windows-only branch, untestable on POSIX CI. */
    if (process.platform === "win32") {
      // Windows has no process groups; `taskkill /T /F` walks the parent-pid
      // tree to terminate descendants the way `kill -pid` does on POSIX.
      try {
        execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          stdio: "pipe",
          windowsHide: true,
        });
        return;
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        return;
      }
    }
    /* c8 ignore stop */
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* c8 ignore start — race: process exits between pid check and signal. */
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      /* c8 ignore stop */
    }
  };

  return new Promise<McpProbeResult["tools"]>((resolve, reject) => {
    const finish = (fn: () => void) => {
      /* c8 ignore start — idempotence guard. The exit handler already checks
         `!settled` before calling finish, and timer/error handlers install
         once() listeners; the second branch only trips if a future refactor
         re-enters finish from an async tail. */
      if (settled) return;
      /* c8 ignore stop */
      settled = true;
      try {
        fn();
      } finally {
        killTree();
      }
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `probe timed out after ${timeoutMs}ms (stderr: ${truncate(stderrBuf.join(""), 400)})`,
          ),
        ),
      );
    }, timeoutMs);

    /* c8 ignore next 6 — surfaced only when spawn(2) itself fails after the
       child handle was returned (EMFILE / ENOMEM mid-fork). The "missing
       binary" test produces an exit-code path instead. */
    child.once("error", (err) => {
      finish(() => {
        clearTimeout(timer);
        reject(err);
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf.push(chunk.toString("utf8"));
    });

    readLines(child, (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      runner.handle(message);
    });

    const runner = createProbeRunner({
      send: (msg) => {
        child.stdin?.write(`${JSON.stringify(msg)}\n`);
      },
      onTools: (tools) => {
        finish(() => {
          clearTimeout(timer);
          resolve(tools);
        });
      },
      onError: (err) => {
        finish(() => {
          clearTimeout(timer);
          reject(err);
        });
      },
    });
    /* onError above is exercised via init-error + list-error stdio scenarios. */

    runner.start();

    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(() => {
          clearTimeout(timer);
          reject(
            new Error(
              `probe process exited before tools/list returned (code=${code}, signal=${signal}, stderr: ${truncate(stderrBuf.join(""), 400)})`,
            ),
          );
        });
      }
    });
  });
}

function readLines(
  child: ChildProcess,
  onLine: (line: string) => void,
): void {
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/* ------------------------------------------------------------------ *
 * http / sse transport
 * ------------------------------------------------------------------ */

async function probeHttp(
  server: Parameters<typeof probeMcpServer>[0],
  options: McpProbeOptions,
  timeoutMs: number,
): Promise<McpProbeResult["tools"]> {
  if (!server.url) {
    throw new Error("http probe requires server.url");
  }

  const origin = new URL(server.url).origin;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("probe timeout"), timeoutMs);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  for (const key of server.headerKeys) {
    const v = options.secrets[key];
    if (v !== undefined) headers[key] = v;
  }

  try {
    // Streamable HTTP transports accept one JSON-RPC message per POST and
    // return the reply either inline as JSON or as a single SSE event.
    const initReply = await httpRpc({
      url: server.url,
      origin,
      headers,
      body: buildInitRequest(),
      signal: ctrl.signal,
    });
    if ("error" in initReply && initReply.error) {
      throw new Error(`initialize failed: ${initReply.error.message}`);
    }

    // Per spec, clients SHOULD send `notifications/initialized` after init.
    // Some servers reject `tools/list` before they see it.
    await httpRpc({
      url: server.url,
      origin,
      headers,
      body: buildInitializedNotification(),
      signal: ctrl.signal,
      isNotification: true,
    }).catch(() => undefined); // notifications don't need a reply

    const listReply = await httpRpc({
      url: server.url,
      origin,
      headers,
      body: buildToolsListRequest(),
      signal: ctrl.signal,
    });
    if ("error" in listReply && listReply.error) {
      throw new Error(`tools/list failed: ${listReply.error.message}`);
    }
    return extractTools(listReply.result);
  } finally {
    clearTimeout(timer);
  }
}

async function httpRpc(params: {
  url: string;
  origin: string;
  headers: Record<string, string>;
  body: JsonRpcMessage;
  signal: AbortSignal;
  isNotification?: boolean;
}): Promise<JsonRpcResponse> {
  const res = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify(params.body),
    redirect: "manual",
    signal: params.signal,
  });

  if (res.status >= 300 && res.status < 400) {
    // Surface a same-origin redirect only; cross-origin bounces terminate
    // the probe so we don't ship headers to an untrusted host.
    const loc = res.headers.get("location");
    if (!loc) throw new Error(`redirect without Location header (status ${res.status})`);
    const target = new URL(loc, params.url);
    if (target.origin !== params.origin) {
      throw new Error(
        `refusing cross-origin redirect to ${target.origin} (from ${params.origin})`,
      );
    }
    return httpRpc({ ...params, url: target.toString() });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${truncate(body, 400)}`);
  }

  if (params.isNotification) {
    // Spec allows 202 with no body for notifications.
    return { jsonrpc: "2.0", id: null, result: null };
  }

  /* c8 ignore start — `res.headers.get` never returns null when the server
     includes a body; the `??` fallback placates TS's strict header typing. */
  const contentType = res.headers.get("content-type") ?? "";
  /* c8 ignore stop */
  if (contentType.includes("text/event-stream")) {
    return parseSseEvent(await res.text());
  }
  return (await res.json()) as JsonRpcResponse;
}

/** Pull the first `data:`-carried JSON-RPC payload out of an SSE body. */
function parseSseEvent(raw: string): JsonRpcResponse {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0) continue;
    try {
      return JSON.parse(payload) as JsonRpcResponse;
    } catch {
      // fall through
    }
  }
  throw new Error("SSE response did not include a JSON-RPC payload");
}

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0 helpers
 * ------------------------------------------------------------------ */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function buildInitRequest(): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "personal-agent-probe", version: "0.1.0" },
    },
  };
}

function buildInitializedNotification(): JsonRpcNotification {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}

function buildToolsListRequest(): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 2, method: "tools/list" };
}

function extractTools(result: unknown): McpProbeResult["tools"] {
  if (typeof result !== "object" || result == null) return [];
  const list = (result as { tools?: unknown }).tools;
  if (!Array.isArray(list)) return [];
  const out: McpProbeResult["tools"] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw == null) continue;
    const obj = raw as { name?: unknown; description?: unknown };
    if (typeof obj.name !== "string") continue;
    const entry: McpProbeResult["tools"][number] =
      typeof obj.description === "string"
        ? { name: obj.name, description: obj.description }
        : { name: obj.name };
    out.push(entry);
  }
  return out;
}

/** State machine for the two-step stdio handshake (init → initialized → tools/list). */
function createProbeRunner(io: {
  send: (msg: JsonRpcMessage) => void;
  onTools: (tools: McpProbeResult["tools"]) => void;
  onError: (err: Error) => void;
}) {
  let phase: "awaiting_init" | "awaiting_tools" | "done" = "awaiting_init";
  return {
    start() {
      io.send(buildInitRequest());
    },
    handle(message: JsonRpcMessage) {
      if (phase === "done") return;
      if (!("id" in message)) return; // ignore notifications
      const response = message as JsonRpcResponse;

      if (phase === "awaiting_init") {
        if (response.id !== 1) return;
        if (response.error) {
          phase = "done";
          io.onError(new Error(`initialize failed: ${response.error.message}`));
          return;
        }
        io.send(buildInitializedNotification());
        io.send(buildToolsListRequest());
        phase = "awaiting_tools";
        return;
      }

      if (phase === "awaiting_tools") {
        if (response.id !== 2) return;
        if (response.error) {
          phase = "done";
          io.onError(new Error(`tools/list failed: ${response.error.message}`));
          return;
        }
        phase = "done";
        /* extractTools never throws — it filters invalid shapes — but the
           try/catch stays so a future refactor that adds a throw still surfaces
           as a structured probe failure instead of a bare promise rejection. */
        try {
          io.onTools(extractTools(response.result));
          /* c8 ignore next 3 */
        } catch (err) {
          io.onError(err as Error);
        }
      }
    },
  };
}


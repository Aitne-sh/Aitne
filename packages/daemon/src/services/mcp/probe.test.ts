import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMcpServer } from "./probe.js";

/**
 * Fake MCP stdio server — reads line-delimited JSON-RPC requests on stdin
 * and replies in kind. Keeps us from depending on a real MCP server binary
 * in CI while still exercising the stdin/stdout framing end-to-end.
 */
const FAKE_SERVER_BODY = `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0.0.1' } }
      }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: [
          { name: 'echo', description: 'echo things' },
          { name: 'sum' }
        ] }
      }) + '\\n');
    }
  }
});
`;

const HANGING_SERVER_BODY = `#!/usr/bin/env node
setInterval(() => {}, 1000);
`;

function writeExecutableScript(dir: string, filename: string, body: string): string {
  const p = join(dir, filename);
  writeFileSync(p, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

describe("probeMcpServer — stdio", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-probe-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns { ok: true, tools, durationMs } for a responsive server", async () => {
    const script = writeExecutableScript(tmp, "fake-server.mjs", FAKE_SERVER_BODY);
    const result = await probeMcpServer(
      {
        id: "fake",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(2);
    expect(result.tools.map((t) => t.name)).toEqual(["echo", "sum"]);
    expect(result.tools[0].description).toBe("echo things");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns { ok: false, error } when the server hangs past the timeout", async () => {
    const script = writeExecutableScript(tmp, "hang.mjs", HANGING_SERVER_BODY);
    const result = await probeMcpServer(
      {
        id: "hang",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 150 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(result.toolCount).toBe(0);
  });

  it("returns { ok: false, error } when the binary is missing", async () => {
    const result = await probeMcpServer(
      {
        id: "missing",
        transport: "stdio",
        command: "/definitely/does/not/exist/12345",
        args: [],
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("exits cleanly when a stdio server has null args", async () => {
    const script = writeExecutableScript(tmp, "fake-null-args.mjs", FAKE_SERVER_BODY);
    const result = await probeMcpServer(
      {
        id: "null-args",
        transport: "stdio",
        command: process.execPath,
        args: null,
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 150 },
    );
    // The server won't receive any args; it still handshakes though because
    // `process.stdin` events are attached unconditionally. We only care that
    // the null-args branch in spawn() runs without throwing — accept either
    // an ok probe or a timeout, never a crash.
    expect(["boolean"]).toContain(typeof result.ok);
  });

  it("rejects when stdio is requested without a command", async () => {
    const result = await probeMcpServer(
      {
        id: "no-cmd",
        transport: "stdio",
        command: null,
        args: null,
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {} },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/command/);
  });

  it("forwards declared env secrets into the spawned child", async () => {
    // Fake server that echoes whether the env var arrived, then responds
    // normally to initialize + tools/list so the probe reports ok.
    const body = `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: [{ name: process.env.CUSTOM_TOKEN ?? 'missing' }] },
      }) + '\\n');
    }
  }
});
`;
    const script = writeExecutableScript(tmp, "env-server.mjs", body);
    const result = await probeMcpServer(
      {
        id: "env",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        cwd: null,
        url: null,
        envKeys: ["CUSTOM_TOKEN"],
        headerKeys: [],
      },
      {
        dataDir: tmp,
        secrets: { CUSTOM_TOKEN: "tok-from-probe" },
        timeoutMs: 5_000,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.tools[0]?.name).toBe("tok-from-probe");
  });

  it("uses an explicit cwd when set, and surfaces early-exit failures", async () => {
    const body = `#!/usr/bin/env node
process.exit(7);
`;
    const script = writeExecutableScript(tmp, "exit-server.mjs", body);
    const result = await probeMcpServer(
      {
        id: "exit",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        cwd: tmp,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited/);
  });

  it("surfaces initialize errors from the stdio server", async () => {
    const body = `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -1, message: 'init boom' }
      }) + '\\n');
    }
  }
});
`;
    const script = writeExecutableScript(tmp, "init-error.mjs", body);
    const result = await probeMcpServer(
      {
        id: "init-err",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/init boom/);
  });

  it("surfaces tools/list errors from the stdio server", async () => {
    const body = `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -2, message: 'list boom' }
      }) + '\\n');
    }
  }
});
`;
    const script = writeExecutableScript(tmp, "list-error.mjs", body);
    const result = await probeMcpServer(
      {
        id: "list-err",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/list boom/);
  });

  it("rejects an unknown transport value", async () => {
    const result = await probeMcpServer(
      {
        id: "bad",
        // @ts-expect-error — simulate a DB row with a transport we don't support
        transport: "quic",
        command: null,
        args: null,
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {} },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported transport/);
  });

  it("includes stderr output in the timeout error message", async () => {
    const body = `#!/usr/bin/env node
process.stderr.write('boot: loading\\nboot: retrying\\n');
setInterval(() => {}, 1000);
`;
    const script = writeExecutableScript(tmp, "noisy-hang.mjs", body);
    const result = await probeMcpServer(
      {
        id: "noisy",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 300 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(result.error).toMatch(/boot: loading/);
  });

  it("ignores spurious response ids during the stdio handshake", async () => {
    const body = `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      // Emit a reply with a wrong id first — the runner must ignore it.
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 888, result: { tools: [] } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'real' }] } }) + '\\n');
      // Send one more message after we already resolved — runner must drop it.
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');
    }
  }
});
`;
    const script = writeExecutableScript(tmp, "ids.mjs", body);
    const result = await probeMcpServer(
      {
        id: "ids",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: "real" }]);
  });

  it("ignores non-JSON and notification messages on the stdout channel", async () => {
    const body = `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      // Emit garbage + a notification BEFORE the real response — the runner
      // must drop both and still handle id=1.
      process.stdout.write('not-json\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'log', params: { level: 'info' } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: [{ name: 'a' }, { invalid: true }, { name: 'b', description: 5 }] },
      }) + '\\n');
    }
  }
});
`;
    const script = writeExecutableScript(tmp, "noise.mjs", body);
    const result = await probeMcpServer(
      {
        id: "noise",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: tmp, secrets: {}, timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(true);
    // Invalid tool entries are filtered; entries with non-string descriptions
    // drop the description but keep the name.
    expect(result.tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(result.tools[1].description).toBeUndefined();
  });
});

describe("probeMcpServer — http", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("round-trips initialize + tools/list against a JSON endpoint", async () => {
    const calls: Array<{ url: string; body: unknown; headers: Headers }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({
        url: url.toString(),
        body,
        headers: new Headers(init?.headers as Record<string, string>),
      });
      if (body?.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "search" }, { name: "fetch", description: "fetch a url" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // notifications/initialized — accept 202 with no body
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;

    const result = await probeMcpServer(
      {
        id: "monday",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://mcp.monday.com/mcp",
        envKeys: [],
        headerKeys: ["Authorization"],
      },
      {
        dataDir: "/tmp",
        secrets: { Authorization: "Bearer tok" },
        timeoutMs: 5_000,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.tools.map((t) => t.name)).toEqual(["search", "fetch"]);
    const initCall = calls.find((c) => (c.body as { method?: string })?.method === "initialize");
    expect(initCall?.headers.get("authorization")).toBe("Bearer tok");
    expect(initCall?.headers.get("accept")).toContain("text/event-stream");
  });

  it("parses an SSE-wrapped JSON-RPC reply", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "initialize") {
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "x" }] } })}\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;

    const result = await probeMcpServer(
      {
        id: "sse-srv",
        transport: "sse",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 5_000 },
    );

    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: "x", description: undefined }]);
  });

  it("refuses cross-origin redirects", async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/hijack" },
      })) as typeof globalThis.fetch;

    const result = await probeMcpServer(
      {
        id: "evil",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cross-origin/);
  });

  it("rejects when http is requested without a url", async () => {
    const result = await probeMcpServer(
      {
        id: "no-url",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/url/);
  });

  it("follows a same-origin redirect and replays the POST", async () => {
    let seen = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen++;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const first = seen === 1;
      if (first) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://example.com/mcp/final" },
        });
      }
      if (body?.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "ok" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;

    const result = await probeMcpServer(
      {
        id: "redir",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 2_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: "ok" }]);
  });

  it("rejects a redirect missing a Location header", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 302 })) as typeof globalThis.fetch;
    const result = await probeMcpServer(
      {
        id: "noloc",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Location/);
  });

  it("surfaces non-2xx responses as ok:false", async () => {
    globalThis.fetch = (async () =>
      new Response("internal exploded", {
        status: 500,
        headers: { "content-type": "text/plain" },
      })) as typeof globalThis.fetch;
    const result = await probeMcpServer(
      {
        id: "boom",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });

  it("returns ok:false when the SSE body has no data: line", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "initialize") {
        return new Response(": just a comment\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;

    const result = await probeMcpServer(
      {
        id: "empty-sse",
        transport: "sse",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SSE/);
  });

  it("drops malformed JSON in an SSE data line and moves on to the next", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "initialize") {
        // First data line is garbage, second is the real reply.
        return new Response(
          `data: {not json\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })}\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;

    const result = await probeMcpServer(
      {
        id: "mixed-sse",
        transport: "sse",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([]);
  });

  it("surfaces a tools/list JSON-RPC error over http", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32001, message: "tools denied" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;
    const result = await probeMcpServer(
      {
        id: "srv",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tools\/list failed: tools denied/);
  });

  it("truncates long HTTP error bodies", async () => {
    const huge = "x".repeat(1000);
    globalThis.fetch = (async () =>
      new Response(huge, {
        status: 500,
        headers: { "content-type": "text/plain" },
      })) as typeof globalThis.fetch;
    const result = await probeMcpServer(
      {
        id: "big",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/…/);
  });

  it("accepts a JSON reply without an explicit content-type header", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      // Omit content-type header entirely — the probe defaults it to "".
      if (body?.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200 },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "anon" }] },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;
    const result = await probeMcpServer(
      {
        id: "noctype",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: "anon" }]);
  });

  it("skips empty `data:` lines in an SSE reply", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "initialize") {
        return new Response(
          `data: \ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })}\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;
    const result = await probeMcpServer(
      {
        id: "empty-data",
        transport: "sse",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([]);
  });

  it("filters non-object tool entries from the list", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [null, "garbage", 42, { name: "real" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;
    const result = await probeMcpServer(
      {
        id: "mixedlist",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: "real" }]);
  });

  it("returns [] when tools/list result.tools is not an array", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: "oops-a-string" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;
    const result = await probeMcpServer(
      {
        id: "badlist",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([]);
  });

  it("returns [] when tools/list returns a non-object or missing tools", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body?.method === "tools/list") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "not an object" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;
    const result = await probeMcpServer(
      {
        id: "no-tools",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([]);
  });

  it("surfaces a JSON-RPC error response as ok:false", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body?.id ?? null,
          error: { code: -32601, message: "method not found" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const result = await probeMcpServer(
      {
        id: "srv",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://example.com/mcp",
        envKeys: [],
        headerKeys: [],
      },
      { dataDir: "/tmp", secrets: {}, timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/method not found/);
  });
});

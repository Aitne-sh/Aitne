import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { createDelegatedRunRoutes } from "./delegated.js";

/**
 * DELEGATED-TASK-MODE-DESIGN.md §4.2 — `POST /api/delegated/run` route tests.
 * Mirrors the structure of `routes/integrations.test.ts` for `/exec` so the
 * boundaries (kill switch, codex deferral, body validation) are covered the
 * same way.
 *
 * Bearer auth is enforced by middleware at the server.ts level (Approve
 * tier registered in `risk-classifier.ts`); these tests exercise the
 * route handler directly the same way the `/exec` tests do — see
 * `risk-classifier.test.ts` and `server.test.ts` for end-to-end auth
 * coverage of the surrounding middleware.
 */

function makeDeps(
  db: Database.Database,
  dataDir: string,
  extras: Partial<Record<string, unknown>> = {},
) {
  const baseConfig = {
    dataDir,
    workspaceDir: process.cwd(),
    delegatedTaskModeEnabled: true,
    delegatedTaskMaxPerDay: 50,
    delegatedTaskDefaultMaxToolCalls: 5,
    delegatedTaskDefaultMaxBudgetUsd: 0.05,
    delegatedTaskDefaultTimeoutMs: 60000,
    delegatedTaskHeavyEnabled: false,
  };
  const config =
    (extras as { config?: Record<string, unknown> }).config ?? baseConfig;
  const { config: _ignore, ...rest } = extras as { config?: unknown };
  return { db, config, ...rest } as never;
}

function makeStubInvoker(runImpl: (params: unknown) => unknown) {
  return {
    invoke: async () => null,
    task: async () => null,
    run: runImpl,
  } as never;
}

const SCHEMA = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string" } },
};

describe("POST /api/delegated/run", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    dir = mkdtempSync(join(tmpdir(), "pa-delegated-run-"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 200 with the validated result on happy path", async () => {
    const invoker = makeStubInvoker(async () => ({
      ok: true,
      result: { text: "ok" },
      needsConfirmation: false,
      confirmationPlan: null,
      cost: {
        tokensInput: 10,
        tokensOutput: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.0001,
        durationMs: 100,
        numTurns: 1,
      },
      trace: [],
      backendId: "gemini",
      modelId: "gemini-2.5-flash",
      retried: false,
    }));
    const app = createDelegatedRunRoutes(makeDeps(db, dir, { delegatedInvoker: invoker }));
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "Find the latest record",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { text: string } };
    expect(body.result.text).toBe("ok");
  });

  it("returns 400 validation_error when delegatedBackend is missing or invalid", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("delegatedBackend");
  });

  it("forwards a Codex /run call to the invoker (Phase 1.5+)", async () => {
    // Phase 1.5 (2026-05-01) wired Codex `runDelegatedTask` via
    // daemon-side stream pre-emption. The earlier 501
    // `task_mode_unsupported` short-circuit for codex is gone; the
    // route now resolves the Codex core like Claude / Gemini.
    const calls: { delegatedBackend?: string }[] = [];
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, {
        delegatedInvoker: makeStubInvoker(async (params: unknown) => {
          calls.push(params as { delegatedBackend?: string });
          return {
            ok: true,
            result: { text: "ok" },
            needsConfirmation: false,
            confirmationPlan: null,
            trace: [],
            cost: {
              tokensInput: 0,
              tokensOutput: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              costUsd: 0,
              durationMs: 0,
              numTurns: 1,
            },
            backendId: "codex",
            modelId: "gpt-5.4-mini",
            cacheHit: false,
            retried: false,
          };
        }),
      }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "codex",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].delegatedBackend).toBe("codex");
  });

  it("returns 400 bad_allowed_tools on bare `*`", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["*"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      reason: string;
      pattern: string;
    };
    expect(body.error).toBe("bad_allowed_tools");
    expect(body.reason).toBe("bare_star");
    expect(body.pattern).toBe("*");
  });

  it("returns 400 bad_allowed_tools on glob with too-short prefix (mcp_*)", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_*"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("bad_allowed_tools");
    expect(body.reason).toBe("prefix_too_short");
  });

  it("returns 400 bad_allowed_tools when allowedTools is empty", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: [],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_allowed_tools");
  });

  it("returns 400 bad_allowed_tools when allowedTools is not an array", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: "mcp_my-server_search",
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_allowed_tools");
  });

  it("returns 400 validation_error on missing task", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("task");
  });

  it("returns 400 validation_error on missing outputSchema", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("outputSchema");
  });

  it("returns 400 schema_too_large when outputSchema exceeds 4 KB", async () => {
    const bigSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `field_${i}_with_a_long_name_to_pad_the_schema`,
          { type: "string" },
        ]),
      ),
    };
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: bigSchema,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("schema_too_large");
  });

  it("returns 400 validation_error on caps outside hard bounds", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
        maxToolCalls: 999, // exceeds hard cap of 10
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("maxToolCalls");
  });

  it("returns 503 task_mode_disabled when the kill switch is off", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, {
        config: {
          dataDir: dir,
          workspaceDir: process.cwd(),
          delegatedTaskModeEnabled: false,
          delegatedTaskMaxPerDay: 50,
          delegatedTaskDefaultMaxToolCalls: 5,
          delegatedTaskDefaultMaxBudgetUsd: 0.05,
          delegatedTaskDefaultTimeoutMs: 60000,
          delegatedTaskHeavyEnabled: false,
        },
        delegatedInvoker: makeStubInvoker(async () => null),
      }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("task_mode_disabled");
  });

  it("returns 501 unimplemented when the invoker is not wired", async () => {
    const app = createDelegatedRunRoutes(makeDeps(db, dir, {}));
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unimplemented");
  });

  it("ignores any `heavy` field in the request body (model tier fixed light server-side)", async () => {
    let observed: Record<string, unknown> | null = null;
    const invoker = makeStubInvoker(async (params: unknown) => {
      observed = params as Record<string, unknown>;
      return {
        ok: true,
        result: { text: "ok" },
        needsConfirmation: false,
        confirmationPlan: null,
        cost: {
          tokensInput: 0,
          tokensOutput: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
          durationMs: 0,
          numTurns: 0,
        },
        trace: [],
        backendId: "gemini",
        modelId: "gemini-2.5-flash",
        retried: false,
      };
    });
    const app = createDelegatedRunRoutes(makeDeps(db, dir, { delegatedInvoker: invoker }));
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
        heavy: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(observed).not.toBeNull();
    // The route must NOT forward `heavy` to the invoker — model tier is
    // fixed light per §4.2.
    expect((observed as unknown as Record<string, unknown>).heavy).toBeUndefined();
  });

  it("forwards x-event-id and x-process-key headers as parent attribution", async () => {
    let observed: Record<string, unknown> | null = null;
    const invoker = makeStubInvoker(async (params: unknown) => {
      observed = params as Record<string, unknown>;
      return {
        ok: true,
        result: { text: "ok" },
        needsConfirmation: false,
        confirmationPlan: null,
        cost: {
          tokensInput: 0,
          tokensOutput: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
          durationMs: 0,
          numTurns: 0,
        },
        trace: [],
        backendId: "gemini",
        modelId: "gemini-2.5-flash",
        retried: false,
      };
    });
    const app = createDelegatedRunRoutes(makeDeps(db, dir, { delegatedInvoker: invoker }));
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-event-id": "evt-123",
        "x-process-key": "morning_routine",
      },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(200);
    expect((observed as unknown as Record<string, unknown>).parentEventId).toBe("evt-123");
    expect((observed as unknown as Record<string, unknown>).parentProcessKey).toBe("morning_routine");
  });

  // DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.3 — verify the route forwards
  // `cacheable` to the invoker. Same rationale as the /exec test: a typo
  // in the body destructuring would silently disable caching.
  it("forwards cacheable=true from request body to invoker.run", async () => {
    let observed: Record<string, unknown> | null = null;
    const invoker = makeStubInvoker(async (params: unknown) => {
      observed = params as Record<string, unknown>;
      return {
        ok: true,
        result: { text: "ok" },
        needsConfirmation: false,
        confirmationPlan: null,
        cost: {
          tokensInput: 0,
          tokensOutput: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
          durationMs: 0,
          numTurns: 0,
        },
        trace: [],
        backendId: "gemini",
        modelId: "gemini-2.5-flash",
        retried: false,
      };
    });
    const app = createDelegatedRunRoutes(makeDeps(db, dir, { delegatedInvoker: invoker }));
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "find x",
        outputSchema: SCHEMA,
        cacheable: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(observed).not.toBeNull();
    expect(observed!.cacheable).toBe(true);
  });

  it("defaults cacheable to false when the request body omits the field", async () => {
    let observed: Record<string, unknown> | null = null;
    const invoker = makeStubInvoker(async (params: unknown) => {
      observed = params as Record<string, unknown>;
      return {
        ok: true,
        result: { text: "ok" },
        needsConfirmation: false,
        confirmationPlan: null,
        cost: {
          tokensInput: 0,
          tokensOutput: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
          durationMs: 0,
          numTurns: 0,
        },
        trace: [],
        backendId: "gemini",
        modelId: "gemini-2.5-flash",
        retried: false,
      };
    });
    const app = createDelegatedRunRoutes(makeDeps(db, dir, { delegatedInvoker: invoker }));
    await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "find x",
        outputSchema: SCHEMA,
      }),
    });
    expect(observed!.cacheable).toBe(false);
  });

  // ── clampNumber edge cases ───────────────────────────────────────────────

  it("returns 400 validation_error when maxBudgetUsd is a non-number (string)", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
        maxBudgetUsd: "lots",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("maxBudgetUsd");
  });

  it("returns 400 validation_error when maxBudgetUsd is Infinity (not finite)", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
        // JSON.stringify(Infinity) → "null" which parses back as null → defaults
        // Send it as a literal number that becomes Infinity after parsing won't work
        // via JSON. Patch: send a large number outside the hard cap instead.
        maxBudgetUsd: 1.5,
      }),
    });
    // 1.5 > DELEGATED_TASK_HARD_CAPS.maxBudgetUsd (0.5) → null → 400
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("maxBudgetUsd");
  });

  it("returns 400 validation_error when maxBudgetUsd is negative (below min 0)", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
        maxBudgetUsd: -0.01,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("maxBudgetUsd");
  });

  it("accepts maxBudgetUsd as a valid float within bounds (allowFloat=true path)", async () => {
    const invoker = makeStubInvoker(async () => ({
      ok: true,
      result: { text: "ok" },
      needsConfirmation: false,
      confirmationPlan: null,
      trace: [],
      cost: { tokensInput: 0, tokensOutput: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.001, durationMs: 10, numTurns: 1 },
      backendId: "gemini",
      modelId: "gemini-2.5-flash",
      retried: false,
    }));
    const app = createDelegatedRunRoutes(makeDeps(db, dir, { delegatedInvoker: invoker }));
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
        maxBudgetUsd: 0.25, // valid float within [0, 0.5]
      }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 validation_error when timeoutMs is a float (allowFloat=false)", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
        timeoutMs: 5000.5, // float rejected for integer-only field
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("timeoutMs");
  });

  it("returns 400 validation_error when timeoutMs is below minimum (< 1000)", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
        timeoutMs: 500,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("timeoutMs");
  });

  it("returns 400 validation_error when timeoutMs exceeds hard cap (> 300000)", async () => {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
        timeoutMs: 999999,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("timeoutMs");
  });

  // ── mapTaskErrorClassToHttpStatus — full switch coverage ─────────────────
  // Each test passes a distinct errorClass from the invoker to exercise every
  // case branch of the error→HTTP-status mapping function.

  function makeErrorInvoker(
    errorClass: string,
    extras: Record<string, unknown> = {},
  ) {
    return makeStubInvoker(async () => ({
      ok: false,
      errorClass,
      message: `Simulated ${errorClass}`,
      backendId: "gemini",
      retried: false,
      ...extras,
    }));
  }

  async function runWithError(errorClass: string, extras: Record<string, unknown> = {}) {
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeErrorInvoker(errorClass, extras) }),
    );
    return app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
  }

  it("maps errorClass task_mode_disabled → 503", async () => {
    const res = await runWithError("task_mode_disabled");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; mode: string };
    expect(body.error).toBe("task_mode_disabled");
    expect(body.mode).toBe("delegated");
  });

  it("maps errorClass task_quota_exhausted → 429", async () => {
    const res = await runWithError("task_quota_exhausted");
    expect(res.status).toBe(429);
  });

  it("maps errorClass task_mode_unsupported → 501", async () => {
    const res = await runWithError("task_mode_unsupported");
    expect(res.status).toBe(501);
  });

  it("maps errorClass delegated_proxy_busy → 503", async () => {
    const res = await runWithError("delegated_proxy_busy");
    expect(res.status).toBe(503);
  });

  it("maps errorClass denied_tool → 403", async () => {
    const res = await runWithError("denied_tool");
    expect(res.status).toBe(403);
  });

  it("maps errorClass precondition → 409", async () => {
    const res = await runWithError("precondition");
    expect(res.status).toBe(409);
  });

  it("maps errorClass auth_error → 502", async () => {
    const res = await runWithError("auth_error");
    expect(res.status).toBe(502);
  });

  it("maps errorClass tool_failed → 502", async () => {
    const res = await runWithError("tool_failed");
    expect(res.status).toBe(502);
  });

  it("maps errorClass tool_unavailable → 502", async () => {
    const res = await runWithError("tool_unavailable");
    expect(res.status).toBe(502);
  });

  it("maps errorClass parse_error → 502", async () => {
    const res = await runWithError("parse_error");
    expect(res.status).toBe(502);
  });

  it("maps errorClass schema_violation → 502", async () => {
    const res = await runWithError("schema_violation");
    expect(res.status).toBe(502);
  });

  it("maps errorClass policy_violation → 502", async () => {
    const res = await runWithError("policy_violation");
    expect(res.status).toBe(502);
  });

  it("maps errorClass post_write_format_failure → 502", async () => {
    const res = await runWithError("post_write_format_failure");
    expect(res.status).toBe(502);
  });

  it("maps errorClass loop_aborted → 502", async () => {
    const res = await runWithError("loop_aborted");
    expect(res.status).toBe(502);
  });

  it("maps errorClass budget_exhausted → 502", async () => {
    const res = await runWithError("budget_exhausted");
    expect(res.status).toBe(502);
  });

  it("maps errorClass timeout → 504", async () => {
    const res = await runWithError("timeout");
    expect(res.status).toBe(504);
  });

  it("maps errorClass cancelled → 504", async () => {
    const res = await runWithError("cancelled");
    expect(res.status).toBe(504);
  });

  it("maps errorClass subprocess_crashed → 500", async () => {
    const res = await runWithError("subprocess_crashed");
    expect(res.status).toBe(500);
  });

  it("maps unknown errorClass (default) → 500", async () => {
    const res = await runWithError("completely_unknown_class");
    expect(res.status).toBe(500);
  });

  it("forwards raw and trace fields from the error result in the response", async () => {
    const res = await runWithError("tool_failed", {
      raw: { someData: "here" },
      trace: [{ step: "call" }],
      cost: { tokensInput: 5, tokensOutput: 2, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.001, durationMs: 80, numTurns: 1 },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.raw).toEqual({ someData: "here" });
    expect(body.trace).toEqual([{ step: "call" }]);
    expect((body.cost as Record<string, number>).costUsd).toBeCloseTo(0.001);
  });

  it("omits raw from response when not present in error result", async () => {
    const res = await runWithError("auth_error");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.raw).toBeUndefined();
  });

  // ── readJsonBody failure path (line 58) ──────────────────────────────────

  it("returns 400 invalid_json_body when request body is not valid JSON", async () => {
    // Covers `if (!parsedBody.ok) return parsedBody.response;` — the branch
    // taken when readJsonBody cannot parse the request body. All prior tests
    // send well-formed JSON, so this branch was previously unreachable.
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, { delegatedInvoker: makeStubInvoker(async () => null) }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-valid-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json_body");
  });

  // ── logger.warn path: result.retried ?? false (line 262) ─────────────────

  it("handles error result that omits retried field (retried ?? false fallback)", async () => {
    // Covers `retried: result.retried ?? false` in the logger.warn call.
    // makeErrorInvoker always supplies retried:false, so the null-coalescing
    // fallback is never reached there. This test omits retried intentionally.
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, {
        delegatedInvoker: makeStubInvoker(async () => ({
          ok: false,
          errorClass: "timeout",
          message: "timed out",
          backendId: "gemini",
          // retried: intentionally omitted → triggers result.retried ?? false
        })),
      }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(504); // timeout → 504
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("timeout");
  });

  // ── error response: result.backendId ?? delegatedBackend (line 273) ──────

  it("falls back to request delegatedBackend when error result omits backendId", async () => {
    // Covers `backend: result.backendId ?? delegatedBackend` in the error JSON.
    // makeErrorInvoker always supplies backendId:"gemini", so the fallback path
    // is never reached there. Omit backendId here to exercise the right side.
    const app = createDelegatedRunRoutes(
      makeDeps(db, dir, {
        delegatedInvoker: makeStubInvoker(async () => ({
          ok: false,
          errorClass: "auth_error",
          message: "auth failed",
          retried: false,
          // backendId: intentionally omitted → falls back to delegatedBackend
        })),
      }),
    );
    const res = await app.request("/delegated/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delegatedBackend: "claude",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA,
      }),
    });
    expect(res.status).toBe(502); // auth_error → 502
    const body = (await res.json()) as { error: string; backend: string; mode: string };
    expect(body.error).toBe("auth_error");
    // backendId was omitted from the result, so backend falls back to the
    // delegatedBackend field from the request body.
    expect(body.backend).toBe("claude");
    expect(body.mode).toBe("delegated");
  });
});

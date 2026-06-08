import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import { BACKEND_IDS, type BackendId } from "@aitne/shared";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import {
  deleteAllMcpSecrets,
  deleteMcpServer,
  disableAllMcpServers,
  DuplicateMcpServerError,
  getMcpServer,
  insertMcpServer,
  InvalidMcpServerError,
  listMcpServers,
  McpServerNotFoundError,
  resolveMcpSecrets,
  saveMcpProbeResult,
  setMcpServerEnabled,
  setMcpSecret,
  updateMcpServer,
} from "../../services/mcp/registry.js";
import {
  McpServerIdSchema,
  MCP_RISK_TIERS,
  MCP_TRANSPORTS,
  type McpServer,
} from "../../services/mcp/types.js";
import { probeMcpServer } from "../../services/mcp/probe.js";
import { listMcpToolCalls } from "../../services/mcp/tool-audit.js";
import { runLineCommand } from "../../core/backends/cli-utils.js";

const logger = createLogger("mcp-api");

/**
 * B-003 Phase 2 — MCP server CRUD + probe routes.
 *
 * | Method | Path                                | Risk     |
 * |--------|-------------------------------------|----------|
 * | GET    | /mcp/servers                        | read     |
 * | GET    | /mcp/servers/:id                    | read     |
 * | POST   | /mcp/servers                        | approve  |
 * | PATCH  | /mcp/servers/:id                    | approve  |
 * | DELETE | /mcp/servers/:id                    | approve  |
 * | POST   | /mcp/servers/:id/probe              | notify   |
 * | POST   | /mcp/servers/:id/enable             | approve  |
 * | POST   | /mcp/servers/:id/disable            | notify   |
 * | PUT    | /mcp/servers/:id/secrets/:keyName   | approve  |
 * | DELETE | /mcp/servers/:id/secrets/:keyName   | approve  |
 *
 * Writes are `approve` tier — an MCP server is effectively arbitrary code
 * with tool-level access to the agent, so every mutation goes through the
 * dashboard's authenticated proxy.
 */
export interface McpRouteDependencies {
  db: Database.Database;
  blobStore: EncryptedBlobStore;
  /** PA_DATA_DIR — used by the probe sandbox for per-probe cwd. */
  dataDir: string;
}

const BackendIdSchema = z.enum(BACKEND_IDS as unknown as [BackendId, ...BackendId[]]);

const CreateInputSchema = z.object({
  id: McpServerIdSchema,
  name: z.string().min(1).max(200),
  transport: z.enum(MCP_TRANSPORTS),
  command: z.string().min(1).nullable().optional(),
  args: z.array(z.string()).nullable().optional(),
  cwd: z.string().min(1).nullable().optional(),
  url: z.string().url().nullable().optional(),
  envKeys: z.array(z.string().min(1)).optional(),
  headerKeys: z.array(z.string().min(1)).optional(),
  backends: z.array(BackendIdSchema).min(1),
  enabled: z.boolean().optional(),
  riskTier: z.enum(MCP_RISK_TIERS).optional(),
  toolAllowlist: z.array(z.string().min(1)).nullable().optional(),
});

const PatchInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  transport: z.enum(MCP_TRANSPORTS).optional(),
  command: z.string().min(1).nullable().optional(),
  args: z.array(z.string()).nullable().optional(),
  cwd: z.string().min(1).nullable().optional(),
  url: z.string().url().nullable().optional(),
  envKeys: z.array(z.string().min(1)).optional(),
  headerKeys: z.array(z.string().min(1)).optional(),
  backends: z.array(BackendIdSchema).min(1).optional(),
  riskTier: z.enum(MCP_RISK_TIERS).optional(),
  toolAllowlist: z.array(z.string().min(1)).nullable().optional(),
});

const SecretInputSchema = z.object({
  value: z.string().min(1),
});

export function createMcpRoutes(deps: McpRouteDependencies): Hono {
  const app = new Hono();
  const { db, blobStore, dataDir } = deps;

  /** Serialize writes so a PATCH + DELETE racing on the same server don't
   *  both stream secret cleanup for the same blob names. */
  let writeLock: Promise<void> = Promise.resolve();
  function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = writeLock;
    let release: () => void;
    writeLock = new Promise<void>((r) => {
      release = r;
    });
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release!();
      }
    });
  }

  /** Internal redaction — never leak the stored value list back to callers;
   *  the dashboard shows existence but not contents. */
  async function withSecretPresence(server: McpServer): Promise<McpServer & {
    secretsPresent: Record<string, boolean>;
  }> {
    const keys = [...server.envKeys, ...server.headerKeys];
    const presence: Record<string, boolean> = {};
    await Promise.all(
      keys.map(async (k) => {
        presence[k] = (await resolveMcpSecrets(blobStore, server))[k] != null;
      }),
    );
    return { ...server, secretsPresent: presence };
  }

  // ── GET /mcp/servers ──
  app.get("/mcp/servers", async (c) => {
    const servers = listMcpServers(db);
    const enriched = await Promise.all(servers.map(withSecretPresence));
    return c.json({ servers: enriched });
  });

  // ── GET /mcp/servers/:id ──
  app.get("/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    const server = getMcpServer(db, id);
    if (!server) {
      return respondWithAgentError(c, 404, [
        composeIssue("mcp.not_found", { field: "id", received: id }),
      ]);
    }
    return c.json({ server: await withSecretPresence(server) });
  });

  // ── POST /mcp/servers ──
  app.post("/mcp/servers", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const validated = CreateInputSchema.safeParse(parsed.body);
    if (!validated.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("mcp.invalid_input", { field: "body", received: parsed.body })],
        { legacyFields: { issues: validated.error.issues } },
      );
    }
    return withWriteLock(async () => {
      try {
        const saved = insertMcpServer(db, validated.data);
        return c.json({ server: await withSecretPresence(saved) }, 201);
      } catch (err) {
        if (err instanceof DuplicateMcpServerError) {
          return respondWithAgentError(
            c,
            409,
            [composeIssue("mcp.duplicate", { field: "id", received: validated.data.id })],
            { legacyFields: { message: err.message } },
          );
        }
        if (err instanceof InvalidMcpServerError) {
          return respondWithAgentError(
            c,
            400,
            [
              composeIssue("mcp.invalid_input", {
                field: "body",
                received: err.message,
                expected: err.message,
              }),
            ],
            { legacyFields: { message: err.message } },
          );
        }
        logger.error({ err }, "insertMcpServer failed");
        return respondWithAgentError(c, 500, [
          composeIssue("mcp.internal_error", {
            field: "insert",
            received: toSafeErrorMessage(err),
          }),
        ]);
      }
    });
  });

  // ── PATCH /mcp/servers/:id ──
  app.patch("/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const validated = PatchInputSchema.safeParse(parsed.body);
    if (!validated.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("mcp.invalid_input", { field: "body", received: parsed.body })],
        { legacyFields: { issues: validated.error.issues } },
      );
    }
    return withWriteLock(async () => {
      try {
        const before = getMcpServer(db, id);
        if (!before) {
          return respondWithAgentError(c, 404, [
            composeIssue("mcp.not_found", { field: "id", received: id }),
          ]);
        }
        const updated = updateMcpServer(db, id, validated.data);

        // Prune secret blobs for keys that were removed from env_keys/header_keys.
        const beforeKeys = new Set([...before.envKeys, ...before.headerKeys]);
        const afterKeys = new Set([...updated.envKeys, ...updated.headerKeys]);
        const removed = [...beforeKeys].filter((k) => !afterKeys.has(k));
        if (removed.length > 0) {
          await deleteAllMcpSecrets(blobStore, id, removed);
        }

        return c.json({ server: await withSecretPresence(updated) });
      } catch (err) {
        /* c8 ignore start — TOCTOU race: row was present at the initial
           SELECT on line 185 but deleted before the UPDATE reached it. Under
           better-sqlite3's single-threaded writer this cannot happen within
           one Hono handler, so the branch exists for future schema-level
           triggers that might delete the row async. */
        if (err instanceof McpServerNotFoundError) {
          return respondWithAgentError(c, 404, [
            composeIssue("mcp.not_found", { field: "id", received: id }),
          ]);
        }
        /* c8 ignore stop */
        if (err instanceof InvalidMcpServerError) {
          return respondWithAgentError(
            c,
            400,
            [
              composeIssue("mcp.invalid_input", {
                field: "body",
                received: err.message,
                expected: err.message,
              }),
            ],
            { legacyFields: { message: err.message } },
          );
        }
        logger.error({ err, id }, "updateMcpServer failed");
        return respondWithAgentError(c, 500, [
          composeIssue("mcp.internal_error", {
            field: "update",
            received: toSafeErrorMessage(err),
          }),
        ]);
      }
    });
  });

  // ── DELETE /mcp/servers/:id ──
  app.delete("/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    return withWriteLock(async () => {
      const before = getMcpServer(db, id);
      if (!before) {
        return respondWithAgentError(c, 404, [
          composeIssue("mcp.not_found", { field: "id", received: id }),
        ]);
      }
      const keys = [...before.envKeys, ...before.headerKeys];
      const deleted = deleteMcpServer(db, id);
      /* c8 ignore start — TOCTOU race: row removed between the SELECT above
         and the DELETE statement. Cannot happen under a single better-sqlite3
         writer, so the branch is unreachable in tests but kept as defense. */
      if (!deleted) {
        return respondWithAgentError(c, 404, [
          composeIssue("mcp.not_found", { field: "id", received: id }),
        ]);
      }
      /* c8 ignore stop */
      if (keys.length > 0) {
        await deleteAllMcpSecrets(blobStore, id, keys);
      }
      return c.json({ status: "deleted", id });
    });
  });

  // ── POST /mcp/servers/:id/probe ──
  app.post("/mcp/servers/:id/probe", async (c) => {
    const id = c.req.param("id");
    const server = getMcpServer(db, id);
    if (!server) {
      return respondWithAgentError(c, 404, [
        composeIssue("mcp.not_found", { field: "id", received: id }),
      ]);
    }
    if (!server.enabled) {
      return respondWithAgentError(
        c,
        409,
        [
          composeIssue("mcp.server_disabled", {
            field: "enabled",
            received: false,
          }),
        ],
        {
          legacyFields: { message: "Enable the MCP server before probing it." },
        },
      );
    }

    const rawSecrets = await resolveMcpSecrets(blobStore, server);
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawSecrets)) {
      if (v != null) secrets[k] = v;
    }

    try {
      const result = await probeMcpServer(server, { dataDir, secrets });
      const saved = saveMcpProbeResult(db, id, result);
      return c.json({ result, server: await withSecretPresence(saved) });
    } catch (err) {
      logger.error({ err, id }, "probeMcpServer threw unexpectedly");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        500,
        [composeIssue("mcp.probe_failed", { field: "probe", received: message })],
        { legacyFields: { message } },
      );
    }
  });

  // ── POST /mcp/servers/:id/enable | /disable ──
  app.post("/mcp/servers/:id/enable", async (c) => {
    const id = c.req.param("id");
    return withWriteLock(async () => {
      let saved: McpServer;
      try {
        saved = setMcpServerEnabled(db, id, true);
      } catch (err) {
        if (err instanceof McpServerNotFoundError) {
          return respondWithAgentError(c, 404, [
            composeIssue("mcp.not_found", { field: "id", received: id }),
          ]);
        }
        throw err;
      }

      // Chain an immediate probe. Without this, a freshly-enabled server
      // has `lastProbeStatus = null` until the next auto-probe tick, and
      // `renderMcpSection` emits "_No probe results recorded_" — so the
      // agent sees the server's name but not any callable tools and
      // silently ignores it. Probe failures don't fail the enable call
      // itself: `probeMcpServer` maps transport errors to `{ok:false}`,
      // which we persist so the dashboard status dot flags the problem.
      const rawSecrets = await resolveMcpSecrets(blobStore, saved);
      const secrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawSecrets)) {
        if (v != null) secrets[k] = v;
      }
      try {
        const result = await probeMcpServer(saved, { dataDir, secrets });
        saved = saveMcpProbeResult(db, id, result);
      } catch (err) {
        logger.warn(
          { err, id },
          "probe chain after enable threw unexpectedly; leaving lastProbeStatus untouched",
        );
      }

      return c.json({ server: await withSecretPresence(saved) });
    });
  });

  app.post("/mcp/servers/:id/disable", async (c) => {
    const id = c.req.param("id");
    return withWriteLock(async () => {
      try {
        const saved = setMcpServerEnabled(db, id, false);
        return c.json({ server: await withSecretPresence(saved) });
      } catch (err) {
        if (err instanceof McpServerNotFoundError) {
          return respondWithAgentError(c, 404, [
            composeIssue("mcp.not_found", { field: "id", received: id }),
          ]);
        }
        throw err;
      }
    });
  });

  // ── POST /mcp/disable-all ──
  // B-003 Phase 3 kill switch. One-shot flip of every `enabled=1` row to
  // `enabled=0`. Intended for "cut the extensions first, debug later" when
  // an MCP-adjacent failure is observed — so Notify tier, not Approve.
  // The per-server enable flip stays Approve because that mutation *expands*
  // the agent's tool surface; this mutation *contracts* it.
  app.post("/mcp/disable-all", async (c) => {
    return withWriteLock(async () => {
      const disabled = disableAllMcpServers(db);
      logger.info({ disabled }, "MCP kill switch invoked");
      return c.json({ status: "disabled_all", disabled });
    });
  });

  // ── GET /mcp/servers/:id/activity ──
  // B-003 Phase 4.4 — per-server recent MCP tool call history.
  // Read-tier: no mutations; returns at most `limit` rows (default 20, cap 100).
  app.get("/mcp/servers/:id/activity", (c) => {
    const id = c.req.param("id");
    const server = getMcpServer(db, id);
    if (!server) {
      return respondWithAgentError(c, 404, [
        composeIssue("mcp.not_found", { field: "id", received: id }),
      ]);
    }
    const limitParam = Number(c.req.query("limit") ?? "20");
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), 100) : 20;
    const calls = listMcpToolCalls(db, id, limit);
    return c.json({ serverId: id, calls });
  });

  // ── PUT /mcp/servers/:id/secrets/:keyName ──
  // Body: { value: "..." }. Writes the per-server secret blob.
  app.put("/mcp/servers/:id/secrets/:keyName", async (c) => {
    const id = c.req.param("id");
    const keyName = c.req.param("keyName");
    const server = getMcpServer(db, id);
    if (!server) {
      return respondWithAgentError(c, 404, [
        composeIssue("mcp.not_found", { field: "id", received: id }),
      ]);
    }
    const keys = new Set([...server.envKeys, ...server.headerKeys]);
    if (!keys.has(keyName)) {
      return respondWithAgentError(
        c,
        400,
        [
          composeIssue("mcp.unknown_key", {
            field: "keyName",
            received: keyName,
            expected: `one of ${[...keys].join(", ")}`,
          }),
        ],
        {
          legacyFields: {
            message: `keyName must be declared in envKeys/headerKeys: ${keyName}`,
          },
        },
      );
    }
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const validated = SecretInputSchema.safeParse(parsed.body);
    if (!validated.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("mcp.invalid_input", { field: "body", received: parsed.body })],
        { legacyFields: { issues: validated.error.issues } },
      );
    }
    await setMcpSecret(blobStore, id, keyName, validated.data.value);
    return c.json({ status: "saved" });
  });

  // ── DELETE /mcp/servers/:id/secrets/:keyName ──
  app.delete("/mcp/servers/:id/secrets/:keyName", async (c) => {
    const id = c.req.param("id");
    const keyName = c.req.param("keyName");
    const server = getMcpServer(db, id);
    if (!server) {
      return respondWithAgentError(c, 404, [
        composeIssue("mcp.not_found", { field: "id", received: id }),
      ]);
    }
    // Validate keyName against the server's declared keys, mirroring the PUT
    // handler. Without this guard DELETE accepted any raw `keyName` from the
    // URL and removed the corresponding `mcp:<id>:<keyName>` blob — an
    // asymmetry that let a caller target blobs the server never declared.
    const keys = new Set([...server.envKeys, ...server.headerKeys]);
    if (!keys.has(keyName)) {
      return respondWithAgentError(
        c,
        400,
        [
          composeIssue("mcp.unknown_key", {
            field: "keyName",
            received: keyName,
            expected: `one of ${[...keys].join(", ")}`,
          }),
        ],
        {
          legacyFields: {
            message: `keyName must be declared in envKeys/headerKeys: ${keyName}`,
          },
        },
      );
    }
    await deleteAllMcpSecrets(blobStore, id, [keyName]);
    return c.json({ status: "deleted" });
  });

  // ── POST /mcp/gemini-install ──
  // One-button installer for the Gemini-side MCP servers required by
  // the integration registry's Gemini connector entries. The two kinds
  // map to the canonical commands documented in the setup guide:
  //   - "google-workspace": registers the Gmail / Calendar tools as
  //     `mcp_google-workspace_<tool>` (extension-shipped MCP server).
  //   - "notion": registers Notion's official hosted MCP under the
  //     literal server name `notion` so tools surface as
  //     `mcp_notion_<tool>`. The registry's Notion descriptor encodes
  //     this assumption — using a different server name will leave the
  //     probe reporting missing capabilities.
  //
  // Idempotent: if the target server / extension is already registered
  // (extension dir present, or settings.json already has `notion`
  // under mcpServers), the route short-circuits with `alreadyInstalled:
  // true` rather than spawning the install command. Avoids surfacing
  // confusing "extension already installed" / "server already exists"
  // stderr from a re-click.
  //
  // The endpoint shells out to the user's `gemini` binary; failures
  // (binary missing, OAuth required, network) are returned verbatim so
  // the dashboard can surface the exact stderr. No state is written to
  // the daemon — the gemini CLI updates its own ~/.gemini/* config.
  app.post("/mcp/gemini-install", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const validated = z
      .object({ kind: z.enum(["google-workspace", "notion"]) })
      .safeParse(parsed.body);
    if (!validated.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("mcp.invalid_input", { field: "body", received: parsed.body })],
        { legacyFields: { issues: validated.error.issues } },
      );
    }
    const { kind } = validated.data;
    const args = GEMINI_INSTALL_COMMANDS[kind];
    if (isGeminiInstallAlreadyApplied(kind, homedir())) {
      logger.info({ kind }, "gemini install short-circuited — already present");
      return c.json({
        ok: true,
        kind,
        command: ["gemini", ...args].join(" "),
        alreadyInstalled: true,
        stdout: "",
        stderr: "",
      });
    }
    try {
      // Route through runLineCommand, not a bare execFile("gemini"): on
      // Windows the npm-installed Gemini CLI is a `gemini.cmd` batch shim,
      // which a shell:false spawn of the bare name cannot resolve (no PATHEXT)
      // — so this dashboard install was 100% non-functional on Windows.
      // runLineCommand's resolveWin32Invocation resolves the name via PATHEXT
      // and launches the `.cmd` through an escaped cmd.exe wrapper (no
      // shell:true, no metachar re-parse). The args are a static const, so
      // there is no injection dimension regardless.
      const result = await runLineCommand({
        command: "gemini",
        args: [...args],
        cwd: homedir(),
        timeoutMs: 120_000,
      });
      const stdout = result.stdoutLines.join("\n");
      const stderr = result.stderrLines.join("\n");
      // Contract remap: execFile REJECTS on non-zero exit, but runLineCommand
      // RESOLVES with exitCode !== 0 (it rejects only on a spawn-level error).
      // Branch on exitCode/timedOut so an OAuth-required / version-mismatch
      // failure still maps to the 502 install_failed path instead of being
      // mis-reported as ok:true.
      if (result.timedOut || (result.exitCode ?? 0) !== 0) {
        const message = result.timedOut
          ? "gemini install command timed out after 120s"
          : stderr || stdout || `gemini exited with code ${result.exitCode}`;
        logger.warn(
          { kind, args, exitCode: result.exitCode, timedOut: result.timedOut },
          "gemini install command failed",
        );
        return respondWithAgentError(
          c,
          502,
          [composeIssue("mcp.install_failed", { field: "gemini", received: message })],
          {
            legacyFields: {
              ok: false,
              kind,
              command: ["gemini", ...args].join(" "),
              message,
              stdout,
              stderr,
              exitCode: result.exitCode,
            },
          },
        );
      }
      logger.info(
        { kind, args, stdoutLen: stdout.length },
        "gemini install command completed",
      );
      return c.json({
        ok: true,
        kind,
        command: ["gemini", ...args].join(" "),
        alreadyInstalled: false,
        stdout,
        stderr,
      });
    } catch (err) {
      // Spawn-level failure only: runLineCommand rejects via child.once("error")
      // with the raw spawn error (code:"ENOENT" when the bare/resolved name is
      // unresolvable). On Windows, resolveWin32Invocation returns null for an
      // unresolvable bare "gemini" so spawn still ENOENTs naturally — the 503
      // gemini_cli_not_found path is preserved.
      const message = toSafeErrorMessage(err);
      const e = err as { code?: number | string };
      logger.warn(
        { kind, args, code: e.code, message },
        "gemini install command spawn failed",
      );
      const code = e.code === "ENOENT" ? "mcp.gemini_cli_not_found" : "mcp.install_failed";
      const status = e.code === "ENOENT" ? 503 : 502;
      return respondWithAgentError(
        c,
        status,
        [composeIssue(code, { field: "gemini", received: message })],
        {
          legacyFields: {
            ok: false,
            kind,
            command: ["gemini", ...args].join(" "),
            message,
            stdout: "",
            stderr: "",
            exitCode: null,
          },
        },
      );
    }
  });

  return app;
}

/**
 * Pre-spawn idempotency check. Returns true when the target install is
 * already present on disk, so the route can short-circuit without
 * surfacing a noisy "already exists" error from the gemini CLI.
 *
 * - `google-workspace`: extension dir present under
 *   `<homeDir>/.gemini/extensions/google-workspace/` with the manifest
 *   file.
 * - `notion`: `<homeDir>/.gemini/settings.json` parses to an object
 *   that lists `notion` under `mcpServers`.
 *
 * Best-effort filesystem read; any error (missing file, permission,
 * malformed JSON, top-level array, mcpServers as array) returns false
 * so the install command runs and surfaces the real diagnostic.
 *
 * `homeDir` is injectable so unit tests can point at a tmpdir instead
 * of the real `~`. The route always passes `homedir()`.
 */
export function isGeminiInstallAlreadyApplied(
  kind: "google-workspace" | "notion",
  homeDir: string,
): boolean {
  if (kind === "google-workspace") {
    return existsSync(
      join(homeDir, ".gemini", "extensions", "google-workspace", "gemini-extension.json"),
    );
  }
  // notion
  const settingsPath = join(homeDir, ".gemini", "settings.json");
  if (!existsSync(settingsPath)) return false;
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
    return Object.prototype.hasOwnProperty.call(servers, "notion");
  } catch {
    return false;
  }
}

// Canonical install commands. Surfaces (URL + server name) are pinned
// to match the Gemini connector descriptors in
// `packages/shared/src/integrations.ts`. Changing the server name on
// the Notion side breaks the registry's `mcp_notion_` namespace
// assumption — keep them in lockstep or the probe will report missing
// capabilities.
const GEMINI_INSTALL_COMMANDS: Record<
  "google-workspace" | "notion",
  readonly string[]
> = {
  "google-workspace": [
    "extensions",
    "install",
    "https://github.com/gemini-cli-extensions/workspace",
  ],
  notion: [
    "mcp",
    "add",
    "-s",
    "user",
    "-t",
    "http",
    "notion",
    "https://mcp.notion.com/mcp",
  ],
};

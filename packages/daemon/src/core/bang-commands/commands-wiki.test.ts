import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageEvent } from "@aitne/shared";
import { EventPriority } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import { ensureDefaultWikiWorkspace } from "../wiki/workspaces.js";
import { __resetWikiCompileLockForTests } from "../wiki/compile-lock.js";
import { BangArgError, BangCommandRegistry } from "./registry.js";
import {
  askCommand,
  connectCommand,
  formatCompilePreview,
  compileCommand,
  lintCommand,
  parseConnectArgs,
  parseCompileArgs,
  traceCommand,
  ingestCommand,
  wikiStatusCommand,
} from "./commands-wiki.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..", "..", "..", "..", "..");

function makeEvent(content = "!ingest https://example.com"): MessageEvent {
  return {
    type: "message.received",
    source: "slack",
    priority: EventPriority.HIGH,
    timestamp: new Date(),
    data: {},
    correlationId: "corr-wiki",
    sender: "owner",
    channel: "D1",
    content,
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

function makeAudit(): IAuditLogger {
  return {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
  };
}

describe("wiki bang commands", () => {
  let db: Database.Database;
  let dataDir: string;
  let config: AgentConfig;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-wiki-cmd-"));
    db = new Database(":memory:");
    applySchema(db);
    config = {
      dataDir,
      workspaceDir: REPO_ROOT,
      primaryLanguage: "en",
    } as AgentConfig;
    ensureDefaultWikiWorkspace(db, config);
    // The wiki-compile lock is module-level in-memory state — reset
    // between tests so an `!compile` that acquires the lock in one test
    // doesn't poison the next test's acquire. The dispatcher's
    // `executeDefault` is what releases the lock in production; unit
    // tests never run the dispatcher path.
    __resetWikiCompileLockForTests();
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("queues one ingest event per !ingest URL", async () => {
    const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const args = ingestCommand.parseArgs?.(
      "https://Example.com/One https://two.test",
      {} as never,
    );
    await ingestCommand.handler(
      {
        event: makeEvent(),
        db,
        config,
        notify,
        audit: makeAudit(),
        registry: new BangCommandRegistry(),
        enqueueWikiEvent,
      },
      args,
    );

    expect(enqueueWikiEvent).toHaveBeenCalledTimes(2);
    expect(enqueueWikiEvent.mock.calls[0][0].type).toBe("wiki.ingest_url");
    expect(enqueueWikiEvent.mock.calls[0][0].data.workspace).toBe("default");
    expect(notify.mock.calls[0][0]).toContain("Queued 2 URLs");
  });

  it("queues compile and ask events", async () => {
    const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const baseCtx = {
      event: makeEvent("!compile"),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
      enqueueWikiEvent,
    };

    await compileCommand.handler(baseCtx, compileCommand.parseArgs?.("", baseCtx));
    await askCommand.handler(
      { ...baseCtx, event: makeEvent("!ask What changed?") },
      askCommand.parseArgs?.("What changed?", baseCtx),
    );

    expect(enqueueWikiEvent.mock.calls.map((call) => call[0].type)).toEqual([
      "wiki.compile",
      "wiki.ask",
    ]);
    expect(enqueueWikiEvent.mock.calls[1][0].data.question).toBe("What changed?");
  });

  // WIKI_BUILDER_DESIGN.md §3.5 / §14 Q4 — concurrent !compile invocations
  // must not both enqueue. The second invocation should see the
  // workspace-scoped compile lock held and reply with the
  // compile-in-progress DM instead of fanning out a duplicate event.
  it("rejects a second `!compile` while the first is still queued (incremental)", async () => {
    const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const baseCtx = {
      event: makeEvent("!compile"),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
      enqueueWikiEvent,
    };
    await compileCommand.handler(baseCtx, compileCommand.parseArgs?.("", baseCtx));
    expect(enqueueWikiEvent).toHaveBeenCalledTimes(1);
    // The dispatcher would normally release the lock when the wiki.compile
    // session lands; in this unit test no dispatcher runs, so the second
    // invocation sees the lock still held.
    await compileCommand.handler(baseCtx, compileCommand.parseArgs?.("", baseCtx));
    expect(enqueueWikiEvent).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls.at(-1)?.[0]).toContain("already running");
  });

  it("reports workspace status without enqueueing", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await wikiStatusCommand.handler({
      event: makeEvent("!wiki"),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(notify.mock.calls[0][0]).toContain("Workspace: `default`");
  });

  it("acknowledges parallel dispatch when workspace mode is parallel", async () => {
    const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const args = ingestCommand.parseArgs?.("https://a.test", {} as never);
    await ingestCommand.handler(
      {
        event: makeEvent(),
        db,
        config,
        notify,
        audit: makeAudit(),
        registry: new BangCommandRegistry(),
        enqueueWikiEvent,
      },
      args,
    );
    expect(notify.mock.calls[0][0]).toContain("in parallel");
  });

  it("acknowledges serial dispatch when workspace mode is serial", async () => {
    db.prepare(
      "UPDATE wiki_workspaces SET dispatch_mode = 'serial' WHERE name = 'default'",
    ).run();
    const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const args = ingestCommand.parseArgs?.("https://a.test https://b.test", {} as never);
    await ingestCommand.handler(
      {
        event: makeEvent(),
        db,
        config,
        notify,
        audit: makeAudit(),
        registry: new BangCommandRegistry(),
        enqueueWikiEvent,
      },
      args,
    );
    expect(notify.mock.calls[0][0]).toContain("serially");
  });

  it("parses `!compile full` and runs the autonomous path below threshold", async () => {
    const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
    const enqueueWikiApproval = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const workspace = ensureDefaultWikiWorkspace(db, config);
    // Empty raw layer → estimate is $0 → autonomous path.
    mkdirSync(join(workspace.root_path, "10_raw"), { recursive: true });

    const baseCtx = {
      event: makeEvent("!compile full"),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
      enqueueWikiEvent,
      enqueueWikiApproval,
    };
    const parsed = compileCommand.parseArgs?.("full", baseCtx);
    // Phase-5 prep: parseCompileArgs now returns `workspaceName` (null when
    // no `@<workspace>` token is supplied) so the dispatcher can route the
    // event to a non-default workspace once P5.C lands.
    expect(parsed).toEqual({ mode: "full", preview: false, workspaceName: null });
    await compileCommand.handler(baseCtx, parsed);

    expect(enqueueWikiEvent).toHaveBeenCalledTimes(1);
    expect(enqueueWikiEvent.mock.calls[0][0].data.mode).toBe("full");
    expect(enqueueWikiApproval).not.toHaveBeenCalled();
    expect(notify.mock.calls.at(-1)?.[0]).toContain("Below approval threshold");
  });

  it("escalates `!compile full` to approval queue when estimate exceeds threshold", async () => {
    const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
    const enqueueWikiApproval = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const workspace = ensureDefaultWikiWorkspace(db, config);
    // Lower the threshold so even an empty count's recomputed minimum
    // breaches; but we need raw files so the estimate is non-zero. Drop
    // the threshold to $0.0001 so any output trips it.
    db.prepare(
      "UPDATE wiki_workspaces SET full_compile_approval_threshold_usd = 0.0001 WHERE id = ?",
    ).run(workspace.id);
    mkdirSync(join(workspace.root_path, "10_raw"), { recursive: true });
    writeFileSync(join(workspace.root_path, "10_raw/a.md"), "stub");
    writeFileSync(join(workspace.root_path, "10_raw/b.md"), "stub");

    const baseCtx = {
      event: makeEvent("!compile full"),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
      enqueueWikiEvent,
      enqueueWikiApproval,
    };
    const parsed = compileCommand.parseArgs?.("full", baseCtx);
    await compileCommand.handler(baseCtx, parsed);

    expect(enqueueWikiApproval).toHaveBeenCalledTimes(1);
    const approvalArg = enqueueWikiApproval.mock.calls[0][0];
    expect(approvalArg.workspace).toBe("default");
    expect(approvalArg.processKey).toBe("wiki.compile");
    expect(approvalArg.estimate.exceedsThreshold).toBe(true);
    expect(enqueueWikiEvent).not.toHaveBeenCalled();
    expect(notify.mock.calls.at(-1)?.[0]).toContain("Sent for approval");
  });

  it("approval-path passes the git preview, not a post-commit outcome", async () => {
    // Regression guard: a previous draft ran `runGitPreCompile` (which
    // commits) before estimating, so the approval queue ended up holding
    // a `committed` outcome and the operator could decline AFTER the
    // commit landed in their git log. The fix routes the approval path
    // through `previewGitPreCompile`, which never mutates.
    const enqueueWikiApproval = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const workspace = ensureDefaultWikiWorkspace(db, config);
    // Drop threshold so any non-zero estimate exceeds it.
    db.prepare(
      "UPDATE wiki_workspaces SET full_compile_approval_threshold_usd = 0.0001 WHERE id = ?",
    ).run(workspace.id);
    mkdirSync(join(workspace.root_path, "10_raw"), { recursive: true });
    writeFileSync(join(workspace.root_path, "10_raw/a.md"), "stub");

    const baseCtx = {
      event: makeEvent("!compile full"),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
      enqueueWikiEvent: vi.fn().mockResolvedValue(undefined),
      enqueueWikiApproval,
    };
    await compileCommand.handler(
      baseCtx,
      compileCommand.parseArgs?.("full", baseCtx),
    );

    expect(enqueueWikiApproval).toHaveBeenCalledTimes(1);
    const passed = enqueueWikiApproval.mock.calls[0][0];
    // The internal-mode default workspace is the test setup; the preview
    // returns `skipped:internal_mode` rather than a `committed` outcome
    // because the design only runs the git snapshot on external git
    // vaults.
    expect(passed.gitOutcome.status).not.toBe("committed");
  });

  it("rejects an unknown ingest argument with a usage message", () => {
    expect(() =>
      compileCommand.parseArgs?.("partial", {} as never),
    ).toThrow(/Usage: `!compile/);
  });

  // C1 — `!compile` must forward `ctx.writeTracker` into `runGitPreCompile`
  // so the snapshot SHA is registered for `GitWatcher` attribution. A
  // dropped forward reopens the daemon-side self-trigger loop on wiki
  // pre-compile. Source-level guard rather than a full-runtime spy:
  // running the autonomous-compile path end-to-end here would require
  // an external git workspace + mock execFile chain that already lives
  // in `git-precompile.test.ts`.
  it("commands-wiki.ts forwards ctx.writeTracker into runGitPreCompile (C1)", () => {
    const src = readFileSync(
      new URL("./commands-wiki.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toMatch(
      /runGitPreCompile\s*\(\s*workspace\s*,\s*\{[\s\S]{0,200}writeTracker:\s*ctx\.writeTracker/,
    );
  });

  describe("parseCompileArgs", () => {
    it("parses bare command as incremental, preview off", () => {
      expect(parseCompileArgs("")).toEqual({
        mode: "incremental",
        preview: false,
        workspaceName: null,
      });
    });

    it("parses `full` as full-rebuild mode", () => {
      expect(parseCompileArgs("full")).toEqual({
        mode: "full",
        preview: false,
        workspaceName: null,
      });
    });

    it("recognises --preview as the dry-run flag", () => {
      expect(parseCompileArgs("--preview")).toEqual({
        mode: "incremental",
        preview: true,
        workspaceName: null,
      });
      expect(parseCompileArgs("full --preview")).toEqual({
        mode: "full",
        preview: true,
        workspaceName: null,
      });
    });

    it("accepts --dry-run as an alias for --preview", () => {
      expect(parseCompileArgs("--dry-run")).toEqual({
        mode: "incremental",
        preview: true,
        workspaceName: null,
      });
    });

    it("flag position is irrelevant", () => {
      expect(parseCompileArgs("--preview full")).toEqual({
        mode: "full",
        preview: true,
        workspaceName: null,
      });
    });

    it("rejects unknown arguments alongside a valid flag", () => {
      expect(() => parseCompileArgs("--preview bogus")).toThrow(/Usage: `!compile/);
    });
  });

  it("!compile --preview short-circuits to a touch-set DM without enqueueing", async () => {
    const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
    const enqueueWikiApproval = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    // Seed a raw note so the preview has at least one entry to render.
    const workspace = ensureDefaultWikiWorkspace(db, config);
    writeFileSync(join(workspace.root_path, "10_raw/seed.md"), "# Seed\n\nbody.\n");

    const parsed = compileCommand.parseArgs?.("--preview", {} as never);
    await compileCommand.handler(
      {
        event: makeEvent("!compile --preview"),
        db,
        config,
        notify,
        audit: makeAudit(),
        registry: new BangCommandRegistry(),
        enqueueWikiEvent,
        enqueueWikiApproval,
      },
      parsed,
    );
    expect(enqueueWikiEvent).not.toHaveBeenCalled();
    expect(enqueueWikiApproval).not.toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toContain("Compile preview");
    expect(notify.mock.calls[0][0]).toContain("seed.md");
  });

  describe("formatCompilePreview", () => {
    it("renders a multi-line summary with cost range and duration", () => {
      const out = formatCompilePreview({
        workspace: "default",
        mode: "full",
        added: ["20_wiki/a.md"],
        modified: ["20_wiki/b.md"],
        unchanged: [],
        estimate: {
          rawCount: 2,
          estimatedInputTokens: 3_000,
          unitCostUsdPerKToken: 0.003,
          optimisticUsd: 0.0045,
          expectedUsd: 0.009,
          pessimisticUsd: 0.018,
          thresholdUsd: 2,
          exceedsThreshold: false,
          method: "per-file-chars",
          perFile: [],
        },
        estimatedDurationSeconds: 90,
      });
      expect(out).toContain("Compile preview for `default` (full)");
      expect(out).toContain("1 added, 1 modified, 0 unchanged");
      expect(out).toContain("est. cost: $0.00–$0.02");
      expect(out).toContain("est. duration: 1m 30s");
      expect(out).toContain("Reply `!compile full`");
    });

    it("truncates long add/modify lists for mobile readability", () => {
      const many = Array.from({ length: 12 }, (_, i) => `20_wiki/f${i}.md`);
      const out = formatCompilePreview({
        workspace: "default",
        mode: "incremental",
        added: many,
        modified: [],
        unchanged: [],
        estimate: {
          rawCount: 12,
          estimatedInputTokens: 12_000,
          unitCostUsdPerKToken: 0.003,
          optimisticUsd: 0.018,
          expectedUsd: 0.036,
          pessimisticUsd: 0.072,
          thresholdUsd: 2,
          exceedsThreshold: false,
          method: "per-file-chars",
          perFile: [],
        },
        estimatedDurationSeconds: 5,
      });
      expect(out).toContain("(+4 more)");
    });
  });

  it("does not enqueue wiki backend events before the workspace is enabled", async () => {
    const disabledDb = new Database(":memory:");
    applySchema(disabledDb);
    const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    try {
      await askCommand.handler(
        {
          event: makeEvent("!ask What changed?"),
          db: disabledDb,
          config,
          notify,
          audit: makeAudit(),
          registry: new BangCommandRegistry(),
          enqueueWikiEvent,
        },
        askCommand.parseArgs?.("What changed?", {} as never),
      );
    } finally {
      disabledDb.close();
    }
    expect(enqueueWikiEvent).not.toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toContain("Wiki is not enabled");
  });

  // ── Phase 3 — operational triad ────────────────────────────────────

  describe("!lint", () => {
    it("rejects any trailing argument with a usage message", () => {
      expect(() => lintCommand.parseArgs?.("anything", {} as never)).toThrowError(
        BangArgError,
      );
    });

    it("accepts an empty rest string and returns an empty args object", () => {
      const parsed = lintCommand.parseArgs?.("", {} as never);
      // Phase-5 prep: every wiki bang now carries `workspaceName` so the
      // handler can target a non-default workspace once P5.C lands.
      expect(parsed).toEqual({ workspaceName: null });
    });

    it("enqueues a wiki.lint event for the active workspace", async () => {
      const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
      const notify = vi.fn().mockResolvedValue(undefined);
      const parsed = lintCommand.parseArgs?.("", {} as never);
      await lintCommand.handler(
        {
          event: makeEvent("!lint"),
          db,
          config,
          notify,
          audit: makeAudit(),
          registry: new BangCommandRegistry(),
          enqueueWikiEvent,
        },
        parsed,
      );

      expect(enqueueWikiEvent).toHaveBeenCalledTimes(1);
      const event = enqueueWikiEvent.mock.calls[0][0];
      expect(event.type).toBe("wiki.lint");
      expect(event.data.workspace).toBe("default");
      expect(notify.mock.calls[0][0]).toContain("Queued wiki lint");
      expect(notify.mock.calls[0][0]).toContain("90_meta/health");
    });

    it("replies with the disabled hint and does not enqueue when wiki is off", async () => {
      const disabledDb = new Database(":memory:");
      applySchema(disabledDb);
      const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
      const notify = vi.fn().mockResolvedValue(undefined);
      try {
        await lintCommand.handler(
          {
            event: makeEvent("!lint"),
            db: disabledDb,
            config,
            notify,
            audit: makeAudit(),
            registry: new BangCommandRegistry(),
            enqueueWikiEvent,
          },
          lintCommand.parseArgs?.("", {} as never),
        );
      } finally {
        disabledDb.close();
      }
      expect(enqueueWikiEvent).not.toHaveBeenCalled();
      expect(notify.mock.calls[0][0]).toContain("Wiki is not enabled");
    });
  });

  describe("!trace", () => {
    it("rejects an empty topic with a usage message", () => {
      expect(() => traceCommand.parseArgs?.("", {} as never)).toThrowError(
        BangArgError,
      );
      expect(() => traceCommand.parseArgs?.("   ", {} as never)).toThrowError(
        BangArgError,
      );
    });

    it("accepts a free-form topic verbatim (whitespace-trimmed)", () => {
      expect(traceCommand.parseArgs?.("  quantum computing  ", {} as never)).toEqual({
        topic: "quantum computing",
        workspaceName: null,
      });
    });

    it("enqueues a wiki.trace event carrying the topic", async () => {
      const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
      const notify = vi.fn().mockResolvedValue(undefined);
      const parsed = traceCommand.parseArgs?.("quantum computing", {} as never);
      await traceCommand.handler(
        {
          event: makeEvent("!trace quantum computing"),
          db,
          config,
          notify,
          audit: makeAudit(),
          registry: new BangCommandRegistry(),
          enqueueWikiEvent,
        },
        parsed,
      );
      expect(enqueueWikiEvent).toHaveBeenCalledTimes(1);
      const event = enqueueWikiEvent.mock.calls[0][0];
      expect(event.type).toBe("wiki.trace");
      expect(event.data.topic).toBe("quantum computing");
      expect(event.data.workspace).toBe("default");
      expect(notify.mock.calls[0][0]).toContain("quantum computing");
    });

    it("replies with the disabled hint when wiki is off", async () => {
      const disabledDb = new Database(":memory:");
      applySchema(disabledDb);
      const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
      const notify = vi.fn().mockResolvedValue(undefined);
      try {
        await traceCommand.handler(
          {
            event: makeEvent("!trace anything"),
            db: disabledDb,
            config,
            notify,
            audit: makeAudit(),
            registry: new BangCommandRegistry(),
            enqueueWikiEvent,
          },
          traceCommand.parseArgs?.("anything", {} as never),
        );
      } finally {
        disabledDb.close();
      }
      expect(enqueueWikiEvent).not.toHaveBeenCalled();
      expect(notify.mock.calls[0][0]).toContain("Wiki is not enabled");
    });
  });

  describe("!connect", () => {
    // parseConnectArgs is exported as a pure helper specifically so the
    // tokenisation rules can be pinned without a full handler harness.

    it("parses two whitespace-separated topics", () => {
      expect(parseConnectArgs("quantum gravity")).toEqual({
        topicA: "quantum",
        topicB: "gravity",
        workspaceName: null,
      });
    });

    it("parses two comma-separated topics, preserving multi-word phrases", () => {
      expect(parseConnectArgs("quantum computing, classical computing")).toEqual({
        topicA: "quantum computing",
        topicB: "classical computing",
        workspaceName: null,
      });
    });

    it("rejects a single topic with the usage message", () => {
      expect(() => parseConnectArgs("quantum")).toThrowError(BangArgError);
    });

    it("rejects three or more whitespace-separated topics", () => {
      expect(() => parseConnectArgs("quantum gravity ai")).toThrowError(
        BangArgError,
      );
    });

    it("rejects three or more comma-separated topics", () => {
      expect(() => parseConnectArgs("a, b, c")).toThrowError(BangArgError);
    });

    it("rejects empty / whitespace-only input", () => {
      expect(() => parseConnectArgs("")).toThrowError(BangArgError);
      expect(() => parseConnectArgs("   ")).toThrowError(BangArgError);
    });

    it("rejects a trailing comma that leaves only one non-empty side", () => {
      expect(() => parseConnectArgs("quantum,")).toThrowError(BangArgError);
      expect(() => parseConnectArgs(", quantum")).toThrowError(BangArgError);
    });

    it("enqueues a wiki.connect event carrying both topics", async () => {
      const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
      const notify = vi.fn().mockResolvedValue(undefined);
      const parsed = connectCommand.parseArgs?.(
        "quantum computing, classical computing",
        {} as never,
      );
      await connectCommand.handler(
        {
          event: makeEvent("!connect quantum computing, classical computing"),
          db,
          config,
          notify,
          audit: makeAudit(),
          registry: new BangCommandRegistry(),
          enqueueWikiEvent,
        },
        parsed,
      );
      expect(enqueueWikiEvent).toHaveBeenCalledTimes(1);
      const event = enqueueWikiEvent.mock.calls[0][0];
      expect(event.type).toBe("wiki.connect");
      expect(event.data.topic_a).toBe("quantum computing");
      expect(event.data.topic_b).toBe("classical computing");
      expect(event.data.workspace).toBe("default");
      expect(notify.mock.calls[0][0]).toContain("quantum computing");
      expect(notify.mock.calls[0][0]).toContain("classical computing");
    });

    it("replies with the disabled hint when wiki is off", async () => {
      const disabledDb = new Database(":memory:");
      applySchema(disabledDb);
      const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
      const notify = vi.fn().mockResolvedValue(undefined);
      try {
        await connectCommand.handler(
          {
            event: makeEvent("!connect a b"),
            db: disabledDb,
            config,
            notify,
            audit: makeAudit(),
            registry: new BangCommandRegistry(),
            enqueueWikiEvent,
          },
          connectCommand.parseArgs?.("a b", {} as never),
        );
      } finally {
        disabledDb.close();
      }
      expect(enqueueWikiEvent).not.toHaveBeenCalled();
      expect(notify.mock.calls[0][0]).toContain("Wiki is not enabled");
    });
  });

  // WIKI_BUILDER_DESIGN.md §P5.C — `@<workspace>` routing.
  describe("P5 multi-workspace routing", () => {
    function seedSecondWorkspace(name: string) {
      // Insert a second active workspace directly — the wizard path is
      // already covered in the API tests; here we just need a second row
      // so the command parser has something to resolve against.
      const root = mkdtempSync(join(tmpdir(), "pa-wiki-cmd-ws-"));
      db.prepare(
        `INSERT INTO wiki_workspaces (
           name, kind, root_path, language, dispatch_mode, concurrency_cap,
           dm_agent_write_enabled, bridge_enabled, bridge_measurement_only,
           bridge_min_confidence, full_compile_approval_threshold_usd,
           write_strategy, git_pre_compile_enabled, schema_version, active
         ) VALUES (?, 'internal', ?, 'en', 'parallel', 3, 0, 0, 1, 0.7, 2.0, 'fs', 1, 1, 1)`,
      ).run(name, root);
      return root;
    }

    it("splits @workspace token from !ingest arguments", async () => {
      const secondRoot = seedSecondWorkspace("research");
      try {
        const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
        const notify = vi.fn().mockResolvedValue(undefined);
        const args = ingestCommand.parseArgs?.(
          "@research https://example.com/x",
          {} as never,
        );
        await ingestCommand.handler(
          {
            event: makeEvent("!ingest @research https://example.com/x"),
            db,
            config,
            notify,
            audit: makeAudit(),
            registry: new BangCommandRegistry(),
            enqueueWikiEvent,
          },
          args,
        );
        expect(enqueueWikiEvent).toHaveBeenCalledTimes(1);
        expect(enqueueWikiEvent.mock.calls[0][0].data.workspace).toBe("research");
        expect(notify.mock.calls[0][0]).toContain("workspace `research`");
      } finally {
        rmSync(secondRoot, { recursive: true, force: true });
      }
    });

    it("falls back to the default workspace when no @token is given", async () => {
      seedSecondWorkspace("research");
      const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
      const notify = vi.fn().mockResolvedValue(undefined);
      const args = ingestCommand.parseArgs?.("https://example.com", {} as never);
      await ingestCommand.handler(
        {
          event: makeEvent(),
          db,
          config,
          notify,
          audit: makeAudit(),
          registry: new BangCommandRegistry(),
          enqueueWikiEvent,
        },
        args,
      );
      expect(enqueueWikiEvent.mock.calls[0][0].data.workspace).toBe("default");
    });

    it("rejects @<invalid> tokens at parse time", () => {
      // Leading hyphen + traversal-style names violate the strict
      // WORKSPACE_NAME_RE (must start with `[A-Za-z0-9]`).
      expect(() => ingestCommand.parseArgs?.("@-leading https://a.test", {} as never))
        .toThrow(BangArgError);
      expect(() => ingestCommand.parseArgs?.("@../escape https://a.test", {} as never))
        .toThrow(BangArgError);
    });

    it("surfaces a friendly DM when the @workspace does not exist", async () => {
      const enqueueWikiEvent = vi.fn().mockResolvedValue(undefined);
      const notify = vi.fn().mockResolvedValue(undefined);
      const args = ingestCommand.parseArgs?.(
        "@missing https://a.test",
        {} as never,
      );
      await ingestCommand.handler(
        {
          event: makeEvent("!ingest @missing https://a.test"),
          db,
          config,
          notify,
          audit: makeAudit(),
          registry: new BangCommandRegistry(),
          enqueueWikiEvent,
        },
        args,
      );
      expect(enqueueWikiEvent).not.toHaveBeenCalled();
      expect(notify.mock.calls[0][0]).toContain("Unknown wiki workspace `@missing`");
    });

    it("parseCompileArgs lifts @workspace + mode + preview", () => {
      const args = parseCompileArgs("@research full --preview");
      expect(args).toEqual({
        mode: "full",
        preview: true,
        workspaceName: "research",
      });
    });

    it("parseConnectArgs lifts @workspace + two topics", () => {
      const args = parseConnectArgs("@research quantum computing, classical computing");
      expect(args).toEqual({
        topicA: "quantum computing",
        topicB: "classical computing",
        workspaceName: "research",
      });
    });

    it("!wiki shows one-line-per-workspace when multiple are active", async () => {
      seedSecondWorkspace("research");
      const notify = vi.fn().mockResolvedValue(undefined);
      await wikiStatusCommand.handler({
        event: makeEvent("!wiki"),
        db,
        config,
        notify,
        audit: makeAudit(),
        registry: new BangCommandRegistry(),
      });
      const message = notify.mock.calls[0][0];
      expect(message).toContain("2 active wiki workspaces");
      expect(message).toContain("`default`");
      expect(message).toContain("`research`");
    });
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import { setUserPaused } from "../../db/runtime-state.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import {
  BangCommandRegistry,
  BangArgError,
  buildPausedNotice,
  buildUnknownCommandReply,
  createUserBangCommand,
  ensureSystemMarker,
  makeNotify,
  tryHandle,
} from "./index.js";
import type { BangCommand, BangCommandContext } from "./index.js";

function makeAudit(): IAuditLogger {
  return {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
    insertInProgressRow: vi.fn(() => -1),
  };
}

function makeDmEvent(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    type: "message.received",
    source: "slack",
    priority: 1 as MessageEvent["priority"],
    timestamp: new Date(),
    data: {},
    correlationId: "corr-1",
    sender: "owner",
    channel: "D1",
    content,
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
    ...overrides,
  };
}

const fakeConfig = { timezone: "UTC" } as AgentConfig;

describe("BangCommandRegistry", () => {
  it("registers and matches by exact, lowercased key", () => {
    const r = new BangCommandRegistry();
    const handler = vi.fn();
    r.register({ name: "!stop", describe: "x", handler });
    expect(r.match("!stop")?.name).toBe("!stop");
    expect(r.match("  !STOP  ")?.name).toBe("!stop");
    expect(r.match("!cost")).toBeUndefined();
    expect(r.list()).toHaveLength(1);
  });

  it("rejects non-lowercase names", () => {
    const r = new BangCommandRegistry();
    expect(() =>
      r.register({ name: "!Stop", describe: "x", handler: vi.fn() }),
    ).toThrowError(/lowercase/);
  });

  it("rejects names without leading bang", () => {
    const r = new BangCommandRegistry();
    expect(() =>
      r.register({ name: "stop", describe: "x", handler: vi.fn() }),
    ).toThrowError(/start with/);
  });

  it("matches exact commands before longest prefixes and preserves argument case", () => {
    const r = new BangCommandRegistry();
    r.register({ prefix: "!ingest", describe: "ingest", handler: async () => {} });
    r.register({ prefix: "!ingest deep", describe: "deep", handler: async () => {} });
    r.register({ name: "!ingest", describe: "status", handler: async () => {} });

    expect(r.resolve("!INGEST")?.kind).toBe("exact");
    expect(r.resolve("!ingest Deep HTTPS://Example.com/Case")?.commandName).toBe(
      "!ingest deep",
    );
    expect(r.resolve("!ingest Deep HTTPS://Example.com/Case")?.rest).toBe(
      "HTTPS://Example.com/Case",
    );
    expect(r.resolve("!ingestless https://example.com")).toBeUndefined();
  });
});

describe("ensureSystemMarker", () => {
  it("prepends marker when text does not lead with [SYSTEM", () => {
    expect(ensureSystemMarker("hello", "[SYSTEM · x]")).toBe(
      "[SYSTEM · x]\nhello",
    );
  });

  it("leaves text unchanged when already prefixed", () => {
    const text = "[SYSTEM · x]\nhello";
    expect(ensureSystemMarker(text, "[SYSTEM · y]")).toBe(text);
  });
});

describe("buildPausedNotice / buildUnknownCommandReply", () => {
  it("paused notice mentions the available commands", () => {
    const text = buildPausedNotice();
    expect(text).toMatch(/^\[SYSTEM · paused\]/);
    expect(text).toContain("!start to resume");
    expect(text).toContain("!cost");
    expect(text).toContain("!report");
  });

  it("unknown reply lists at most 6 known commands", () => {
    const cmds: BangCommand[] = Array.from({ length: 8 }, (_, i) => ({
      name: `!c${i}`,
      describe: `desc${i}`,
      handler: vi.fn(),
    }));
    const text = buildUnknownCommandReply(cmds);
    expect(text).toMatch(/^\[SYSTEM · unknown\]/);
    expect((text.match(/\n- /g) ?? []).length).toBe(6);
    expect(text).toContain("- !c0 — desc0");
    expect(text).not.toContain("- !c6 ");
  });
});

describe("makeNotify", () => {
  it("injects marker and forwards to send", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const notify = makeNotify(send, "[SYSTEM · x]");
    await notify("hello");
    expect(send).toHaveBeenCalledWith("[SYSTEM · x]\nhello");
  });

  it("respects pre-prefixed messages", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const notify = makeNotify(send, "[SYSTEM · x]");
    await notify("[SYSTEM · custom]\nhi");
    expect(send).toHaveBeenCalledWith("[SYSTEM · custom]\nhi");
  });

  it("truncates messages above the mobile budget", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const notify = makeNotify(send, "[SYSTEM · x]");
    const longBody = "z".repeat(2000);
    await notify(`[SYSTEM · x]\n${longBody}`);
    const arg = send.mock.calls[0]?.[0] as string;
    expect(arg.length).toBeLessThanOrEqual(1500);
    expect(arg.endsWith("… (truncated)")).toBe(true);
  });
});

describe("tryHandle decision tree", () => {
  let db: Database.Database;
  let audit: IAuditLogger;
  let registry: BangCommandRegistry;
  let stopHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    audit = makeAudit();
    registry = new BangCommandRegistry();
    stopHandler = vi.fn().mockResolvedValue(undefined);
    registry.register({
      name: "!stop",
      describe: "stop",
      // M2: `!stop` is the canonical pause-execution example — the
      // command that toggles pause must itself run while paused. The
      // production registration in `commands-stop-start.ts` also opts
      // in; the test mirrors that contract so the paused-branch tests
      // exercise the runsWhilePaused fast path instead of the
      // paused_blocked refusal.
      runsWhilePaused: true,
      handler: stopHandler,
    });
  });

  it("returns false for non-DM events", async () => {
    const send = vi.fn();
    const result = await tryHandle(registry, {
      event: makeDmEvent("!stop", { isDm: false, isMention: true }),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(audit.logBangCommand).not.toHaveBeenCalled();
  });

  it("returns false for docs-QA events", async () => {
    const send = vi.fn();
    const result = await tryHandle(registry, {
      event: makeDmEvent("!stop", {
        platform: "dashboard",
        intent: "docs_qa",
      }),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("matches a registered command and runs the handler", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry, {
      event: makeDmEvent("  !STOP  "),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(true);
    expect(stopHandler).toHaveBeenCalledTimes(1);
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "corr-1" }),
      expect.objectContaining({ command: "!stop", status: "ok" }),
    );
  });

  it("falls back with unknown reply for an unrecognised bang", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry, {
      event: makeDmEvent("!banana"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(true);
    expect(stopHandler).not.toHaveBeenCalled();
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      { command: "!banana", status: "unknown" },
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatch(/^\[SYSTEM · unknown\]/);
  });

  it("reports invalid prefix arguments without running the backend path", async () => {
    registry.register({
      prefix: "!ask",
      describe: "ask",
      parseArgs: () => {
        throw new BangArgError("Usage: !ask <question>");
      },
      handler: vi.fn(),
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry, {
      event: makeDmEvent("!ask"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(true);
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        command: "!ask",
        status: "invalid_args",
        message: "Usage: !ask <question>",
      }),
    );
    expect(send.mock.calls[0]?.[0]).toContain("Usage: !ask <question>");
  });

  it("includes enabled user commands in the unknown-command suggestions", async () => {
    // Pin the user-command branch of the unknown reply: when an
    // unrecognised bang is sent and there are user commands defined,
    // the suggestion list joins built-ins AND enabled user commands
    // so the user discovers their own custom shortcuts. Disabled
    // user commands must NOT appear in the suggestion list.
    const enabled = createUserBangCommand(db, {
      name: "digest",
      description: "Daily digest",
      prompt: "Summarize today.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: true,
    });
    createUserBangCommand(db, {
      name: "archived",
      description: "Old shortcut",
      prompt: "do nothing.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: false,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry, {
      event: makeDmEvent("!banana"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(true);
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      { command: "!banana", status: "unknown" },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const reply = String(send.mock.calls[0]?.[0]);
    // The enabled user command must be in the suggestion list.
    expect(reply).toContain(enabled.command);
    // The disabled user command must NOT leak into suggestions.
    expect(reply).not.toContain("!archived");
  });

  it("falls back to a derived describe string when the user command has no description", async () => {
    // Pin the `cmd.description || \`${backendId} · ${modelId}\``
    // ternary in the unknown-reply user-command map. With description
    // empty, the displayed describe must show the backend and model id
    // so the user has at least basic context for the shortcut.
    createUserBangCommand(db, {
      name: "raw",
      description: "",
      prompt: "Echo input.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: true,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    await tryHandle(registry, {
      event: makeDmEvent("!banana"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    const reply = String(send.mock.calls[0]?.[0]);
    expect(reply).toContain("!raw");
    expect(reply).toContain("claude · claude-sonnet-4-6");
  });

  it("runs a matching user command through the enqueue hook", async () => {
    const userCommand = createUserBangCommand(db, {
      name: "digest",
      description: "Daily digest",
      prompt: "Summarize today.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: true,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const enqueueUserBangCommand = vi.fn().mockResolvedValue(undefined);

    const result = await tryHandle(registry, {
      event: makeDmEvent("!digest"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
      enqueueUserBangCommand,
    });

    expect(result).toBe(true);
    expect(stopHandler).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(enqueueUserBangCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: userCommand.id, command: "!digest" }),
      expect.objectContaining({ content: "!digest" }),
    );
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        command: "!digest",
        status: "ok",
        kind: "user",
        userCommandId: userCommand.id,
      }),
    );
  });

  it("ignores synthetic user-command events so the expanded prompt reaches the agent path", async () => {
    const send = vi.fn();
    const result = await tryHandle(registry, {
      event: makeDmEvent("!digest", { source: "bang-command" }),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(audit.logBangCommand).not.toHaveBeenCalled();
  });

  it("non-bang DMs while not paused fall through to agent path", async () => {
    const send = vi.fn();
    const result = await tryHandle(registry, {
      event: makeDmEvent("hello"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(audit.logBangCommand).not.toHaveBeenCalled();
  });

  it("paused: non-bang DM is declined with paused notice", async () => {
    setUserPaused(db, {
      since: new Date().toISOString(),
      source: "!stop",
      byPlatform: "slack",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry, {
      event: makeDmEvent("hello there"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(true);
    expect(stopHandler).not.toHaveBeenCalled();
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      { command: "(non-command)", status: "paused_decline" },
    );
    expect(send.mock.calls[0]?.[0]).toMatch(/^\[SYSTEM · paused\]/);
  });

  it("paused: known bang still runs (read-only `!cost` semantics)", async () => {
    setUserPaused(db, {
      since: new Date().toISOString(),
      source: "!stop",
      byPlatform: "slack",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry, {
      event: makeDmEvent("!stop"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(true);
    expect(stopHandler).toHaveBeenCalledTimes(1);
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: "!stop", status: "ok" }),
    );
  });

  it("§7 spoof guard: multi-line message starting with !stop falls through (treated as agent input)", async () => {
    const send = vi.fn();
    const result = await tryHandle(registry, {
      event: makeDmEvent("!stop\nplease pause"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(false);
    expect(stopHandler).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(audit.logBangCommand).not.toHaveBeenCalled();
  });

  it("paused: unknown bang falls through to paused notice (NOT unknown help)", async () => {
    setUserPaused(db, {
      since: new Date().toISOString(),
      source: "!stop",
      byPlatform: "slack",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry, {
      event: makeDmEvent("!banana"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(true);
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      { command: "!banana", status: "paused_decline" },
    );
    expect(send.mock.calls[0]?.[0]).toMatch(/^\[SYSTEM · paused\]/);
  });

  it("paused: user command is declined with a command-specific notice (matches built-in LLM-command refusal shape)", async () => {
    // M2 (post-self-review): user bang commands are LLM dispatch by
    // construction, so they belong on the same refusal path as built-in
    // LLM commands (paused_blocked, command-named marker, "send !start
    // to resume" body). The pre-self-review behaviour fell through to
    // the generic paused notice, which made `!digest` (user) look like
    // an unknown command while `!compile` (built-in) got a specific
    // refusal — an unhelpful asymmetry.
    const userCmd = createUserBangCommand(db, {
      name: "digest",
      prompt: "Summarize today.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });
    setUserPaused(db, {
      since: new Date().toISOString(),
      source: "!stop",
      byPlatform: "slack",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const enqueueUserBangCommand = vi.fn().mockResolvedValue(undefined);

    const result = await tryHandle(registry, {
      event: makeDmEvent("!digest"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
      enqueueUserBangCommand,
    });

    expect(result).toBe(true);
    expect(enqueueUserBangCommand).not.toHaveBeenCalled();
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      {
        command: "!digest",
        status: "paused_blocked",
        kind: "user",
        userCommandId: userCmd.id,
      },
    );
    const reply = String(send.mock.calls[0]?.[0]);
    // Marker is the command name (consistent with built-in case),
    // body names the command and points at !start.
    expect(reply).toMatch(/^\[SYSTEM · !digest\]/);
    expect(reply).toContain("!digest");
    expect(reply).toContain("paused");
    expect(reply).toContain("!start");
  });

  // ── M2: paused + prefix-command + runsWhilePaused gate ──
  // Three regression tests pinning the new behaviour:
  //   1. Prefix commands opted-in to runsWhilePaused execute normally.
  //   2. Prefix commands NOT opted in are refused with a command-
  //      specific notice (so the user knows their command was
  //      recognised) — NOT the generic "Agent is paused" reply, which
  //      reads as if the command was unknown.
  //   3. Multi-line spoof guard still applies in the paused branch.

  it("paused + prefix command with runsWhilePaused: parses args and runs the handler", async () => {
    setUserPaused(db, {
      since: new Date().toISOString(),
      source: "!stop",
      byPlatform: "slack",
    });
    const parseArgs = vi.fn().mockReturnValue({ workspace: "x" });
    const prefixHandler = vi.fn().mockResolvedValue(undefined);
    registry.register({
      prefix: "!status",
      describe: "status",
      runsWhilePaused: true,
      parseArgs,
      handler: prefixHandler,
    });
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await tryHandle(registry, {
      event: makeDmEvent("!status verbose"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });

    expect(result).toBe(true);
    expect(parseArgs).toHaveBeenCalledWith("verbose", expect.anything());
    expect(prefixHandler).toHaveBeenCalledTimes(1);
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: "!status", status: "ok" }),
    );
  });

  it("paused + prefix command without runsWhilePaused: refused with command-specific notice", async () => {
    setUserPaused(db, {
      since: new Date().toISOString(),
      source: "!stop",
      byPlatform: "slack",
    });
    const compileHandler = vi.fn().mockResolvedValue(undefined);
    registry.register({
      prefix: "!compile",
      describe: "compile",
      // intentionally no runsWhilePaused → defaults to false
      handler: compileHandler,
    });
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await tryHandle(registry, {
      event: makeDmEvent("!compile @ws full"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });

    expect(result).toBe(true);
    expect(compileHandler).not.toHaveBeenCalled();
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: "!compile", status: "paused_blocked" }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const reply = String(send.mock.calls[0]?.[0]);
    // Marker is the command name (not "paused"), and the body names the
    // command — the user must know which input was understood.
    expect(reply).toMatch(/^\[SYSTEM · !compile\]/);
    expect(reply).toContain("!compile");
    expect(reply).toContain("paused");
    expect(reply).toContain("!start");
  });

  it("paused + multi-line bang: spoof guard falls through to paused notice (does NOT execute the handler)", async () => {
    setUserPaused(db, {
      since: new Date().toISOString(),
      source: "!stop",
      byPlatform: "slack",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry, {
      event: makeDmEvent("!start\nplease resume"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
    });
    expect(result).toBe(true);
    // The multi-line guard must not allow the bang command to run,
    // otherwise embedding `!start\n<extra prose>` could resume the
    // agent against the user's intent.
    expect(stopHandler).not.toHaveBeenCalled();
    expect(audit.logBangCommand).toHaveBeenCalledWith(
      expect.anything(),
      // Multi-line falls through to the unknown-bang-while-paused path
      // (not paused_blocked) — `resolve()` is bypassed by the guard.
      { command: expect.stringMatching(/^!start/), status: "paused_decline" },
    );
    expect(send.mock.calls[0]?.[0]).toMatch(/^\[SYSTEM · paused\]/);
  });

  it("forwards enqueueBrowserResearchEvent into the not-paused commandCtx", async () => {
    // BROWSER_HISTORY_INTEGRATION_PLAN P3 — regression for the wiring gap
    // where the paused branch passed the callback but the not-paused
    // branch (the production path; `!research` does not opt into
    // runsWhilePaused) dropped it. Symptom in prod was every
    // `!research accept|wiki` reply reading "Browser-history dispatch is
    // not wired" even when the dispatcher-message-handler had supplied
    // the callback at call time.
    const seen: { hasCallback: boolean } = { hasCallback: false };
    const registry2 = new BangCommandRegistry();
    registry2.register({
      prefix: "!probe-browser",
      describe: "probe",
      handler: async (ctx: BangCommandContext) => {
        seen.hasCallback = typeof ctx.enqueueBrowserResearchEvent === "function";
      },
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const callback = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry2, {
      event: makeDmEvent("!probe-browser arg"),
      db,
      config: fakeConfig,
      audit,
      rawSend: send,
      enqueueBrowserResearchEvent: callback,
    });
    expect(result).toBe(true);
    expect(seen.hasCallback).toBe(true);
  });
});

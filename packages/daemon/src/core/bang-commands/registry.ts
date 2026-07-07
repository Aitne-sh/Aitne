/**
 * Messaging bang-commands registry — short, exact-match owner controls
 * (`!stop`, `!start`, `!cost`, `!report`) intercepted in the dispatcher
 * before any agent backend is invoked.
 *
 * Spec: docs/design/backlog/messaging-bang-commands.md
 */
import type Database from "better-sqlite3";
import type { Event, MessageEvent } from "@aitne/shared";
import { RUNTIME_AVAILABLE_BACKEND_IDS, isDocsQAMessage } from "@aitne/shared";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { isUserPaused } from "../../db/runtime-state.js";
import {
  CUSTOM_BANG_COMMAND_SOURCE,
  getEnabledUserBangCommandByCommand,
  listUserBangCommands,
  type UserBangCommand,
} from "./user-commands.js";
import {
  ensureSystemMarker,
  buildSystemMarker,
  truncateForMobile,
} from "./format-utils.js";

export interface BangCommandContext {
  event: MessageEvent;
  db: Database.Database;
  config: AgentConfig;
  /**
   * Reply path for the command. Wraps `notificationMgr.send(text, event)` so
   * the reply lands back on the same platform/channel/thread (I-9). Injects
   * the `[SYSTEM · …]` marker if the handler-supplied text does not already
   * lead with one (I-10), and truncates to the mobile budget (I-11).
   */
  notify(text: string): Promise<void>;
  audit: IAuditLogger;
  /**
   * Optional commit-attribution tracker (C1). `!compile` forwards this
   * to `runGitPreCompile` so the snapshot SHA is registered before
   * `GitWatcher`'s next poll cycle observes it — closing the
   * daemon-side self-trigger loop in wiki pre-compile.
   *
   * Production callers (dispatcher-message-handler) ALWAYS supply one
   * — the optional shape here is purely so existing test fixtures that
   * never exercise `!compile` don't have to construct a tracker.
   * Forwarding into commands-wiki.ts goes through this field, and
   * `runGitPreCompile`'s `writeTracker` is itself optional, so
   * missing → no attribution mark (the pre-fix behaviour, still safe).
   */
  writeTracker?: AgentWriteTracker;
  registry: BangCommandRegistry;
  /**
   * Close the active DM session for this event's routing tuple. Returns
   * `{ closedId }` so the caller can distinguish "closed a session" from
   * "no active session existed" without coupling the command to the
   * session manager. Implementations record the inbound `!close` turn
   * before closing so the close action shows up in chat history.
   *
   * Optional so that bang-command unit tests can construct minimal
   * contexts; production wiring always supplies it.
   */
  closeActiveDmSession?: () => Promise<{ closedId: number | null }>;
  enqueueUserBangCommand?: (
    command: UserBangCommand,
    event: MessageEvent,
  ) => Promise<void>;
  enqueueWikiEvent?: (event: Event) => Promise<void>;
  /**
   * Per-task `!stop <id>` cancel hooks (BACKGROUND_TASK_RUNNER_DESIGN.md
   * Phase 4). Wired from the dispatcher's live runner instances, which
   * hold the in-memory worker handles the abort needs to reach. Optional
   * so bang-command unit fixtures (and lite installs without a runner)
   * can omit them — the `!stop` handler tells the owner the runner is
   * unavailable rather than silently dropping the request. Return `true`
   * when an abort/terminal-transition was issued, `false` when the task
   * was already gone.
   */
  cancelBackgroundTask?: (taskId: string, reason: string) => Promise<boolean>;
  cancelBrowserTask?: (taskId: string, reason: string) => Promise<boolean>;
  /**
   * Development-mode wiring for the `!repo` / `!approve` / `!exit` commands.
   * `getDevModeRunner` reaches the in-memory loop runner (approve / cancel /
   * arm-timeout); `beginDevMode` latches the dispatcher's singleton pointer so
   * subsequent DMs route into the interview. Optional so unit fixtures without
   * a dispatcher can omit them — the commands reply "dev mode unavailable"
   * rather than dropping the request. Must be forwarded in BOTH commandCtx
   * construction branches below (paused + not-paused) since all three commands
   * are `runsWhilePaused`.
   */
  getDevModeRunner?: () =>
    | import("../../services/dev-mode/dev-mode-runner.js").DevModeRunner
    | null;
  beginDevMode?: (
    state: import("../dev-mode/dev-mode-state.js").DevModeState,
  ) => void;
  /**
   * BROWSER_HISTORY_INTEGRATION_PLAN P3 — wire-through for the
   * `!research accept` / `!research wiki` paths. The bang handler
   * constructs an Event via `createResearchCommandEvent` and the
   * dispatcher-message-handler binds this callback to
   * `await this.eventBus.put(event)`. Optional so unit-test fixtures
   * without an EventBus can still exercise list / show / mute / rename.
   */
  enqueueBrowserResearchEvent?: (event: Event) => Promise<void>;
  /**
   * Approval handoff for `!compile full` when the cost estimate exceeds
   * the per-workspace threshold (WIKI_BUILDER_DESIGN.md §5.5). Inserts
   * an `agent_schedule` row with `task_type='approval'`; the dashboard
   * `/approvals` queue and DM approval bot consume from there. The
   * registry passes the cost estimate + git pre-compile outcome through
   * so the approval card can show the same numbers the bang DM did.
   */
  enqueueWikiApproval?: (input: {
    workspace: string;
    processKey: "wiki.compile";
    sourceEvent: MessageEvent;
    estimate: import("@aitne/shared").WikiCostEstimate;
    // Preview at enqueue time — the approval consumer re-runs
    // `runGitPreCompile` when the operator approves, so the snapshot
    // commit is taken right before the compile session starts (not at
    // approval-enqueue time). `GitPreCompileOutcome` is still accepted
    // for callers that already committed before reaching this seam.
    gitOutcome:
      | import("../wiki/git-precompile.js").GitPreCompilePreview
      | import("../wiki/git-precompile.js").GitPreCompileOutcome;
  }) => Promise<void>;
}

export interface BangCommand {
  /** Exact-match key, including any positional argument variant. */
  name: string;
  /** Human-facing title for dashboard/settings surfaces. */
  title?: string;
  /** Short description for the unknown-command help list. */
  describe: string;
  /** Longer dashboard-facing details. */
  details?: readonly string[];
  /**
   * When true, the command runs normally while the agent is paused
   * (`!stop` state). Reserve for commands that do not enqueue LLM work
   * — pure DB reads, audit lookups, and state toggles (`!start`,
   * `!cost`, `!report`, `!help`, `!close`, `!wiki` status). Commands
   * that dispatch an autonomous session (`!compile`, `!ingest`,
   * `!ask`, `!lint`, `!trace`, `!connect`) must leave this false so
   * the pause gate can block them with an informative reply.
   *
   * Defaults to false. The pause gate falls back to a generic "Agent
   * is paused" notice on any command that opts out.
   */
  runsWhilePaused?: boolean;
  handler: (ctx: BangCommandContext) => Promise<void>;
}

export class BangArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BangArgError";
  }
}

export interface BangPrefixCommand {
  /** Prefix key. Matches exact prefix or prefix followed by ASCII space. */
  prefix: string;
  /** Human-facing title for dashboard/settings surfaces. */
  title?: string;
  /** Short description for the unknown-command help list. */
  describe: string;
  /** Longer dashboard-facing details. */
  details?: readonly string[];
  /** See {@link BangCommand.runsWhilePaused}. Defaults to false. */
  runsWhilePaused?: boolean;
  parseArgs?: (rest: string, ctx: BangCommandContext) => unknown | Promise<unknown>;
  handler: (ctx: BangCommandContext, args: unknown) => Promise<void>;
}

export type RegisteredBangCommand = BangCommand | BangPrefixCommand;

export interface BangCommandMatch {
  command: RegisteredBangCommand;
  commandName: string;
  rest: string;
  kind: "exact" | "prefix";
}

export class BangCommandRegistry {
  private readonly byName = new Map<string, BangCommand>();
  private readonly prefixes: BangPrefixCommand[] = [];

  register(cmd: RegisteredBangCommand): void {
    const key = getBangCommandName(cmd);
    if (key !== key.toLowerCase()) {
      throw new Error(
        `BangCommand key must be lowercase: ${key}`,
      );
    }
    if (!key.startsWith("!")) {
      throw new Error(
        `BangCommand key must start with "!": ${key}`,
      );
    }
    // Hard-fail on duplicate registration. Silently overwriting hid
    // accidental double-registers (e.g. `!stop` defined in two
    // `commands-*.ts` files) behind a clean test pass; the failure only
    // surfaced in production as "the command I edited doesn't do anything"
    // because the loser's handler never ran. Throwing here surfaces the
    // collision the first time `createDefaultBangCommandRegistry()` is
    // built at boot.
    if ("name" in cmd) {
      if (this.byName.has(cmd.name)) {
        throw new Error(`BangCommand "${cmd.name}" is already registered`);
      }
      this.byName.set(cmd.name, cmd);
    } else {
      if (this.prefixes.some((existing) => existing.prefix === cmd.prefix)) {
        throw new Error(`BangCommand prefix "${cmd.prefix}" is already registered`);
      }
      this.prefixes.push(cmd);
      this.prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
    }
  }

  /** Stable, registration-ordered list of registered commands. */
  list(): RegisteredBangCommand[] {
    return [...this.byName.values(), ...this.prefixes];
  }

  match(text: string): BangCommand | undefined {
    return this.byName.get(normalizeBangCommandText(text));
  }

  resolve(text: string): BangCommandMatch | undefined {
    const compact = normalizeBangCommandRestText(text);
    const normalized = compact.toLowerCase();
    const exact = this.byName.get(normalized);
    if (exact) {
      return { command: exact, commandName: exact.name, rest: "", kind: "exact" };
    }
    for (const cmd of this.prefixes) {
      if (normalized === cmd.prefix) {
        return { command: cmd, commandName: cmd.prefix, rest: "", kind: "prefix" };
      }
      if (normalized.startsWith(`${cmd.prefix} `)) {
        return {
          command: cmd,
          commandName: cmd.prefix,
          rest: compact.slice(cmd.prefix.length + 1).trim(),
          kind: "prefix",
        };
      }
    }
    return undefined;
  }
}

export function normalizeBangCommandText(text: string): string {
  return normalizeBangCommandRestText(text).toLowerCase();
}

export function normalizeBangCommandRestText(text: string): string {
  // Map the fullwidth bang U+FF01 — produced by CJK input methods when the
  // user is in a wide-character mode — to ASCII U+0021 so the registry
  // resolves them identically. Without this a CJK-keyboard user types the
  // wide bang, the prefix check below misses, and the message lands in the
  // unknown-command path (or the pause notice while paused). The U+3000
  // ideographic space is also folded into the inner-whitespace collapse so
  // mixed-IME spacing like `!{U+3000}stop` survives too. Uses Unicode
  // escapes (not literal CJK chars) per the project's English-only source
  // policy in CLAUDE.md.
  return text
    .trim()
    .replace(/\uFF01/g, "!")
    .replace(/[ \t\f\v\u3000]+/g, " ");
}

export function getBangCommandName(cmd: RegisteredBangCommand): string {
  return "name" in cmd ? cmd.name : cmd.prefix;
}

/**
 * Reply text for the §5.1 paused-decline path. Used when the user types any
 * DM (bang or non-bang) while the agent is paused.
 */
export function buildPausedNotice(): string {
  return [
    buildSystemMarker("paused"),
    "Agent is paused — message not processed.",
    "",
    "Available commands:",
    "- !start to resume",
    `- !cost (or !cost ${RUNTIME_AVAILABLE_BACKEND_IDS.join(" / ")})`,
    "- !report",
  ].join("\n");
}

/**
 * Reply text for a recognised command that opts out of pause execution
 * (LLM-dispatching commands). Tells the user the command was understood
 * but is gated by the pause state, so the next action is `!start` — not
 * "you typed the wrong thing".
 */
export function buildPausedCommandUnavailableNotice(commandName: string): string {
  return [
    buildSystemMarker(commandName),
    `\`${commandName}\` is unavailable while the agent is paused.`,
    "",
    "Send !start to resume, then re-run the command.",
  ].join("\n");
}

/**
 * Reply for an unrecognised bang while NOT paused. Lists up to 6 known
 * commands so the user can recover without checking the docs.
 */
export function buildUnknownCommandReply(
  commands: RegisteredBangCommand[],
): string {
  const lines: string[] = [
    buildSystemMarker("unknown"),
    "Unknown command. Try one of:",
  ];
  for (const cmd of commands.slice(0, 6)) {
    lines.push(`- ${getBangCommandName(cmd)} — ${cmd.describe}`);
  }
  return lines.join("\n");
}

/**
 * Build a `notify` wrapper that owns marker injection + mobile truncation.
 * Pure factory so the dispatcher can construct contexts without creating a
 * fresh closure per registry method.
 */
export function makeNotify(
  rawSend: (text: string) => Promise<void>,
  fallbackMarker: string,
): (text: string) => Promise<void> {
  return async (text: string): Promise<void> => {
    const withMarker = ensureSystemMarker(text, fallbackMarker);
    await rawSend(truncateForMobile(withMarker));
  };
}

/**
 * Decision tree for incoming owner DMs. Runs at the very top of
 * `EventDispatcher.handleMessage` (§6.2). Returns `true` when the message
 * was handled — recognised, paused-decline, or unknown bang — so the caller
 * short-circuits the rest of dispatch. Returns `false` when the message
 * should fall through to the agent path.
 */
export async function tryHandle(
  registry: BangCommandRegistry,
  ctx: Omit<BangCommandContext, "notify" | "registry"> & {
    rawSend: (text: string) => Promise<void>;
  },
): Promise<boolean> {
  const { event, db, audit, rawSend } = ctx;
  if (event.source === CUSTOM_BANG_COMMAND_SOURCE) return false;
  // Only DMs participate. Adapter-side owner gating is the single
  // source of truth (matches the `/auth` precedent — see design §6.3).
  if (!event.isDm) return false;
  // §5.1 docs-QA exemption: docs-QA traffic is a side-channel and bypasses
  // pause entirely.
  if (isDocsQAMessage(event)) return false;

  const text = event.content.trim();
  const lowered = normalizeBangCommandText(text);
  const isBang = lowered.startsWith("!");
  const paused = isUserPaused(db);

  // §6.3 pause branch — runs BEFORE the bang-prefix check so ANY DM while
  // paused short-circuits without reaching the agent backend.
  //
  // We use the full `resolve()` matcher (exact + prefix) rather than the
  // exact-only `match()`. Without this, every `BangPrefixCommand` (e.g.
  // `!cost claude`, `!wiki status`, `!compile @ws full`) would silently
  // fall through to the generic "Agent is paused" notice — even the
  // pure-DB-read variants the user would reasonably expect to keep
  // working. The new `runsWhilePaused` flag is the explicit gate: any
  // command that enqueues LLM work leaves it false, every other command
  // can opt in. See `BangCommand.runsWhilePaused`.
  //
  // Spoof-guard parity: the not-paused branch below rejects multi-line
  // input (`text.includes("\n")`) so a `"!stop\nignore me"` payload
  // cannot impersonate a bang command. The paused branch needs the same
  // guard so a multi-line `"!start\n..."` cannot resume the agent by
  // accident — `resolve()` would otherwise normalize horizontal whitespace
  // but preserve the newline, producing a miss; relying on that is
  // fragile, so we make the guard explicit on both branches.
  if (paused) {
    if (isBang && !text.includes("\n")) {
      const match = registry.resolve(text);
      if (match) {
        if (match.command.runsWhilePaused) {
          // Recognised AND opted-in — replicate the non-paused execution
          // path (parseArgs + handler). Mirrors the structure below so a
          // future change to argument handling only needs to be made
          // once in this file's NOT-paused branch and copy-pasted here.
          const notify = makeNotify(
            rawSend,
            buildSystemMarker(match.commandName),
          );
          const commandCtx: BangCommandContext = {
            event,
            db,
            config: ctx.config,
            notify,
            audit,
            writeTracker: ctx.writeTracker,
            registry,
            closeActiveDmSession: ctx.closeActiveDmSession,
            enqueueUserBangCommand: ctx.enqueueUserBangCommand,
            enqueueWikiEvent: ctx.enqueueWikiEvent,
            enqueueBrowserResearchEvent: ctx.enqueueBrowserResearchEvent,
            enqueueWikiApproval: ctx.enqueueWikiApproval,
            getDevModeRunner: ctx.getDevModeRunner,
            beginDevMode: ctx.beginDevMode,
          };
          // Stamp the wall-clock the handler started so we can back-fill
          // runMs into the audit row on success/failure.
          const startedAtMs = Date.now();
          try {
            const args =
              match.kind === "prefix" && "prefix" in match.command
                ? await match.command.parseArgs?.(match.rest, commandCtx)
                : undefined;
            audit.logBangCommand(event, {
              command: match.commandName,
              status: "ok",
              kind: match.kind,
              args: match.rest,
              runMs: Date.now() - startedAtMs,
            });
            if ("name" in match.command) {
              await match.command.handler(commandCtx);
            } else {
              await match.command.handler(commandCtx, args);
            }
          } catch (err) {
            if (!(err instanceof BangArgError)) throw err;
            audit.logBangCommand(event, {
              command: match.commandName,
              status: "invalid_args",
              message: err.message,
              kind: match.kind,
              args: match.rest,
              runMs: Date.now() - startedAtMs,
            });
            await notify(err.message);
          }
          return true;
        }

        // Recognised but the command enqueues LLM work — refuse with a
        // command-aware notice so the user knows their input was
        // understood (and what to do next), instead of getting the
        // generic decline that reads as if the command was unknown.
        audit.logBangCommand(event, {
          command: match.commandName,
          status: "paused_blocked",
          kind: match.kind,
          args: match.rest,
        });
        const notify = makeNotify(
          rawSend,
          buildSystemMarker(match.commandName),
        );
        await notify(buildPausedCommandUnavailableNotice(match.commandName));
        return true;
      }

      // User-defined bang commands ARE LLM dispatch by construction
      // (`enqueueUserBangCommand` puts an event the dispatcher then
      // runs through `executeCustomBangCommand`). Mirror the built-in
      // LLM-command refusal so the user sees one consistent shape —
      // "command recognised; unavailable while paused; send !start to
      // resume" — regardless of whether the command came from the
      // built-in registry or `user_bang_commands`. Without this branch,
      // `!digest` (user) and `!compile` (built-in) would emit visibly
      // different refusal messages, with the user-defined case looking
      // like an unknown command.
      const userCommandPaused = getEnabledUserBangCommandByCommand(db, lowered);
      if (userCommandPaused) {
        audit.logBangCommand(event, {
          command: userCommandPaused.command,
          status: "paused_blocked",
          kind: "user",
          userCommandId: userCommandPaused.id,
        });
        const notify = makeNotify(
          rawSend,
          buildSystemMarker(userCommandPaused.command),
        );
        await notify(
          buildPausedCommandUnavailableNotice(userCommandPaused.command),
        );
        return true;
      }
      // Unknown bang while paused — falls through to the pause notice
      // (NOT the unknown-bang help). Rationale: §7 — the paused user's
      // mental model is "the system is quiet"; surfacing help would
      // surprise.
    }
    audit.logBangCommand(event, {
      command: isBang ? lowered : "(non-command)",
      status: "paused_decline",
    });
    const notify = makeNotify(rawSend, buildSystemMarker("paused"));
    await notify(buildPausedNotice());
    return true;
  }

  // Not paused: only bang-prefixed messages are intercepted.
  if (!isBang) return false;

  // §7 spoof guard: a multi-line message that happens to start with `!stop`
  // is "treated as agent input" — bang-command parsing is exact-match,
  // so anything spanning newlines never produces a registry hit and must
  // fall through to the agent path instead of emitting the unknown-bang
  // help. Mirrors the intent of "Avoids spoofing by users embedding
  // `!stop ...` inside larger prose".
  if (text.includes("\n")) return false;

  const match = registry.resolve(text);
  if (match) {
    const notify = makeNotify(rawSend, buildSystemMarker(match.commandName));
    const commandCtx: BangCommandContext = {
      event,
      db,
      config: ctx.config,
      notify,
      audit,
      writeTracker: ctx.writeTracker,
      registry,
      closeActiveDmSession: ctx.closeActiveDmSession,
      enqueueUserBangCommand: ctx.enqueueUserBangCommand,
      enqueueWikiEvent: ctx.enqueueWikiEvent,
      // BROWSER_HISTORY_INTEGRATION_PLAN P3 — `!research accept|wiki` rely
      // on this wire. The paused branch above forwards it too but never
      // executes the LLM-dispatching variant (`!research` isn't
      // `runsWhilePaused`); production runs land here, so omitting the
      // forward turned every accept/wiki bang into "dispatch not wired"
      // even when the dispatcher-message-handler caller had supplied it.
      enqueueBrowserResearchEvent: ctx.enqueueBrowserResearchEvent,
      enqueueWikiApproval: ctx.enqueueWikiApproval,
      getDevModeRunner: ctx.getDevModeRunner,
      beginDevMode: ctx.beginDevMode,
    };
    // Stamp wall-clock start so audit rows carry runMs.
    const startedAtMs = Date.now();
    try {
      const args =
        match.kind === "prefix" && "prefix" in match.command
          ? await match.command.parseArgs?.(match.rest, commandCtx)
          : undefined;
      audit.logBangCommand(event, {
        command: match.commandName,
        status: "ok",
        kind: match.kind,
        args: match.rest,
        runMs: Date.now() - startedAtMs,
      });
      if ("name" in match.command) {
        await match.command.handler(commandCtx);
      } else {
        await match.command.handler(commandCtx, args);
      }
    } catch (err) {
      if (!(err instanceof BangArgError)) throw err;
      audit.logBangCommand(event, {
        command: match.commandName,
        status: "invalid_args",
        message: err.message,
        kind: match.kind,
        args: match.rest,
        runMs: Date.now() - startedAtMs,
      });
      await notify(err.message);
    }
    return true;
  }

  const userCommand = getEnabledUserBangCommandByCommand(db, lowered);
  if (userCommand) {
    audit.logBangCommand(event, {
      command: userCommand.command,
      status: "ok",
      kind: "user",
      userCommandId: userCommand.id,
      backendId: userCommand.backendId,
      modelId: userCommand.modelId,
    });
    await ctx.enqueueUserBangCommand?.(userCommand, event);
    return true;
  }

  // Bang-prefixed but not registered — exact-match argument validation
  // (e.g. `!cost foo`) lands here.
  audit.logBangCommand(event, { command: lowered, status: "unknown" });
  const notify = makeNotify(rawSend, buildSystemMarker("unknown"));
  await notify(
    buildUnknownCommandReply([
      ...registry.list(),
      ...listUserBangCommands(db)
        .filter((cmd) => cmd.enabled)
        .map((cmd) => ({
          name: cmd.command,
          describe: cmd.description || `${cmd.backendId} · ${cmd.modelId}`,
          handler: async () => {},
        })),
    ]),
  );
  return true;
}

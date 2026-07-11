import type { Event } from "@aitne/shared";
import { wikiCompileModeSchema, type WikiCompileMode } from "@aitne/shared";
import type { BangCommand, BangCommandContext, BangPrefixCommand } from "./registry.js";
import { BangArgError } from "./registry.js";
import { extractHttpUrls } from "../../messaging/url-extract.js";
import { isWikiEnabled } from "../../db/wiki-store.js";
import {
  buildWikiWorkspaceStats,
  DEFAULT_WIKI_WORKSPACE_NAME,
  listActiveWikiWorkspaces,
  readDefaultWikiWorkspace,
  resolveWikiWorkspace,
  type WikiWorkspaceRow,
} from "../wiki/workspaces.js";
import { createWikiCommandEvent } from "../wiki/dispatcher.js";
import { dispatchWikiUrlBatch } from "../wiki/multi-url-dispatch.js";
import { estimateFullCompileCost } from "../wiki/cost-estimate.js";
import { buildCompilePreview } from "../wiki/compile-preview.js";
import {
  previewGitPreCompile,
  runGitPreCompile,
} from "../wiki/git-precompile.js";
import {
  releaseWikiCompileLock,
  tryAcquireWikiCompileLock,
  type WikiCompileLockHolder,
} from "../wiki/compile-lock.js";

/**
 * WIKI_BUILDER_DESIGN.md §P5.C — `@<workspace>` prefix lets the owner
 * target a non-default workspace from a DM:
 *
 *   `!ingest @research https://example.com`
 *   `!compile @ops full`
 *   `!ask @journal what did I conclude about X?`
 *
 * Pure parser — call from each command's `parseArgs`. Strips the
 * `@<name>` token from the head of the rest-string and returns it
 * paired with the trimmed remainder. When the rest does NOT start
 * with `@`, the workspace is `null` and the bang handler will fall
 * back to the active default.
 *
 * Workspace name shape matches the DB unique-name constraint
 * (`min 1 / max 64`); we accept the same `[A-Za-z0-9._-]` characters
 * the wizard generates and reject anything that smells like a path
 * traversal or shell injection.
 */
const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WorkspaceTokenSplit {
  workspaceName: string | null;
  rest: string;
}

export function splitWorkspaceToken(rest: string): WorkspaceTokenSplit {
  const trimmed = rest.trimStart();
  if (!trimmed.startsWith("@")) return { workspaceName: null, rest };
  const spaceIdx = trimmed.indexOf(" ");
  const token = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const name = token.slice(1);
  if (!WORKSPACE_NAME_RE.test(name)) {
    throw new BangArgError(
      "Invalid workspace name after `@`. Use letters, numbers, `.`, `_`, or `-` only.",
    );
  }
  return {
    workspaceName: name,
    rest: spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim(),
  };
}

interface IngestArgs {
  urls: string[];
  workspaceName: string | null;
}

interface AskArgs {
  question: string;
  workspaceName: string | null;
}

interface CompileArgs {
  mode: WikiCompileMode;
  preview: boolean;
  workspaceName: string | null;
}

// WIKI_BUILDER_DESIGN.md §P4.B — `!compile --preview` (alias `--dry-run`)
// produces the touch-set DM without enqueueing an agent session. Pure
// helper exported for `commands-wiki.test.ts`; the bang handler is a
// thin shim around it.
//
// §P5.C — accepts an optional leading `@<workspace>` token to target a
// non-default workspace. When absent, the bang handler resolves to the
// default workspace as before.
export function parseCompileArgs(rest: string): CompileArgs {
  const { workspaceName, rest: payload } = splitWorkspaceToken(rest);
  const tokens = payload.trim().split(/\s+/).filter(Boolean);
  let preview = false;
  const remainder: string[] = [];
  for (const tok of tokens) {
    if (tok === "--preview" || tok === "--dry-run") {
      preview = true;
      continue;
    }
    remainder.push(tok);
  }
  const candidate = remainder.length === 0 ? "incremental" : remainder.join(" ").toLowerCase();
  const parsed = wikiCompileModeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new BangArgError(
      "Usage: `!compile [@<workspace>]` (incremental), `!compile [@<workspace>] full` (full rebuild — approval-gated), or `!compile [@<workspace>] [full] --preview` (dry-run preview).",
    );
  }
  return { mode: parsed.data, preview, workspaceName };
}

interface TraceArgs {
  topic: string;
  workspaceName: string | null;
}

interface ConnectArgs {
  topicA: string;
  topicB: string;
  workspaceName: string | null;
}

async function enqueueOrNotify(
  ctx: BangCommandContext,
  event: Event,
): Promise<boolean> {
  if (!ctx.enqueueWikiEvent) {
    await ctx.notify("Wiki dispatch is not available in this daemon process.");
    return false;
  }
  await ctx.enqueueWikiEvent(event);
  return true;
}

/**
 * Resolve the workspace named by an `@<workspace>` token (or the
 * default when null). Surfaces friendly DMs when the wiki is disabled,
 * the named workspace is missing/archived, or the request was unnamed
 * and no default exists. Returns the row when usable, null otherwise.
 */
async function requireWikiWorkspace(
  ctx: BangCommandContext,
  workspaceName: string | null = null,
): Promise<WikiWorkspaceRow | null> {
  if (!isWikiEnabled(ctx.db)) {
    await ctx.notify("Wiki is not enabled. Open `/settings/wiki` and enable the internal wiki workspace first.");
    return null;
  }
  const workspace = resolveWikiWorkspace(ctx.db, workspaceName);
  if (workspace) return workspace;
  if (workspaceName) {
    const active = listActiveWikiWorkspaces(ctx.db);
    const names = active.map((row) => `\`${row.name}\``).join(", ");
    await ctx.notify(
      [
        `Unknown wiki workspace \`@${workspaceName}\`.`,
        active.length > 0 ? `Active workspaces: ${names}.` : `No active wiki workspaces.`,
      ].join("\n"),
    );
    return null;
  }
  await ctx.notify("Wiki workspace is enabled but no active workspace row could be resolved.");
  return null;
}

export const ingestCommand: BangPrefixCommand = {
  prefix: "!ingest",
  title: "Ingest URLs",
  describe: "ingest one or more URLs into the wiki's raw layer",
  parseArgs(rest) {
    try {
      const { workspaceName, rest: payload } = splitWorkspaceToken(rest);
      const { urls } = extractHttpUrls(payload);
      return { urls, workspaceName } satisfies IngestArgs;
    } catch (err) {
      if (err instanceof BangArgError) throw err;
      throw new BangArgError(
        err instanceof Error ? err.message : "Provide at least one URL.",
      );
    }
  },
  async handler(ctx, rawArgs) {
    const args = rawArgs as IngestArgs;
    const workspace = await requireWikiWorkspace(ctx, args.workspaceName);
    if (!workspace) return;
    if (!ctx.enqueueWikiEvent) {
      await ctx.notify("Wiki dispatch is not available in this daemon process.");
      return;
    }
    const result = await dispatchWikiUrlBatch({
      workspace: workspace.name,
      urls: args.urls,
      mode: workspace.dispatch_mode,
      concurrencyCap:
        workspace.dispatch_mode === "serial" ? 1 : workspace.concurrency_cap,
      sourceEvent: ctx.event,
      enqueue: ctx.enqueueWikiEvent,
    });
    const tail =
      result.mode === "serial"
        ? `serially (you will get a single consolidated reply when the batch finishes)`
        : `in parallel (each URL will reply on completion)`;
    await ctx.notify(
      `Queued ${result.queued} URL${result.queued === 1 ? "" : "s"} for wiki ingestion in workspace \`${workspace.name}\` ${tail}.`,
    );
  },
};

export const compileCommand: BangPrefixCommand = {
  prefix: "!compile",
  title: "Compile wiki",
  describe: "Compile raw notes into wiki notes",
  details: [
    "`!compile full` rebuilds every note; `--preview` is a dry-run.",
  ],
  parseArgs(rest) {
    return parseCompileArgs(rest);
  },
  async handler(ctx, rawArgs) {
    const args = rawArgs as CompileArgs;
    const workspace = await requireWikiWorkspace(ctx, args.workspaceName);
    if (!workspace) return;

    // §P4.B — `--preview` short-circuits to the dry-run summary regardless
    // of mode. No agent session is dispatched, no approval row is queued,
    // no git commit is made — the operator just gets the touch set + cost.
    if (args.preview) {
      const preview = buildCompilePreview({ workspace, mode: args.mode });
      await ctx.notify(formatCompilePreview(preview));
      return;
    }

    // WIKI_BUILDER_DESIGN.md §3.5 / §14 Q4 — second `!compile` mid-`!compile`
    // is rejected with the running session's correlation id. Queuing a
    // second compile would land on a vault state already reflecting the
    // queued user's intent (the in-flight run picked up the same raw
    // items), producing duplicate work. The lock is acquired here at
    // enqueue time; the dispatcher releases it in `executeDefault`'s
    // `finally` for `wiki.compile` events. The approval-tier path below
    // also acquires after the operator approves, not here, so a pending
    // approval doesn't block a different operator from running compile.
    if (args.mode === "incremental") {
      const lock = tryAcquireWikiCompileLock(workspace.name, ctx.event.correlationId);
      if (!lock.ok) {
        await ctx.notify(renderCompileInProgressDm(lock.holder, workspace.name));
        return;
      }
      let queued = false;
      try {
        queued = await enqueueOrNotify(
          ctx,
          createWikiCommandEvent({
            processKey: "wiki.compile",
            workspace: workspace.name,
            sourceEvent: ctx.event,
            data: { mode: "incremental" },
          }),
        );
      } catch (err) {
        // Any throw here (event bus full, notify failure) leaves the
        // dispatcher's `finally` unreached because no event ever
        // enqueued. Without this release, the lock TTL of 1h blocks all
        // subsequent compiles for the workspace.
        releaseWikiCompileLock(workspace.name);
        throw err;
      }
      if (queued) {
        await ctx.notify(
          `Queued incremental wiki compile for workspace \`${workspace.name}\`.`,
        );
      } else {
        // Enqueue path declined (no `enqueueWikiEvent` wired) — release
        // the lock immediately so the next attempt can proceed.
        releaseWikiCompileLock(workspace.name);
      }
      return;
    }

    // Full-rebuild path. §5.5 / §P2.E:
    //   1. Preview the git pre-compile gate (no mutation). A dirty tree
    //      is the cheapest reason to reject; we surface it before any
    //      cost work.
    //   2. Estimate cost (pure JS, no agent session).
    //   3. Decide:
    //      - Above threshold → escalate to Approve tier. **No commit yet**
    //        — if the operator never approves, the git log stays clean.
    //      - Below threshold → run the actual `runGitPreCompile` mutator,
    //        then enqueue the autonomous compile session.
    const gitPreview = await previewGitPreCompile(workspace);
    if (gitPreview.status === "refused") {
      const preview = gitPreview.dirtyPaths.slice(0, 5).map((p) => `\`${p}\``).join(", ");
      await ctx.notify(
        [
          `Cannot run \`!compile full\` — the external vault has uncommitted changes.`,
          `Please commit or stash first. Dirty paths: ${preview}${gitPreview.dirtyPaths.length > 5 ? ` (+${gitPreview.dirtyPaths.length - 5} more)` : ""}.`,
        ].join("\n"),
      );
      return;
    }

    const estimate = estimateFullCompileCost(workspace);
    const lines = [
      `Full compile estimate for \`${workspace.name}\`:`,
      `- raw notes: ${estimate.rawCount}`,
      `- est. input tokens: ${estimate.estimatedInputTokens.toLocaleString()}`,
      `- cost range: $${estimate.optimisticUsd.toFixed(2)} (optimistic) – $${estimate.pessimisticUsd.toFixed(2)} (pessimistic), expected $${estimate.expectedUsd.toFixed(2)}`,
      `- approval threshold: $${estimate.thresholdUsd.toFixed(2)}`,
    ];
    if (gitPreview.status === "clean_would_commit") {
      lines.push(`- pre-compile git snapshot: will commit before compile starts`);
    } else if (gitPreview.status === "skipped" && gitPreview.reason === "no_git_repo") {
      lines.push(`- pre-compile git snapshot: not taken (no git repo)`);
    } else if (gitPreview.status === "skipped" && gitPreview.reason === "disabled") {
      lines.push(`- pre-compile git snapshot: disabled by setting`);
    } else if (gitPreview.status === "skipped" && gitPreview.reason === "internal_mode") {
      lines.push(`- pre-compile git snapshot: not applicable (internal mode uses md_file_snapshots)`);
    }

    if (estimate.exceedsThreshold) {
      if (!ctx.enqueueWikiApproval) {
        await ctx.notify(
          [
            ...lines,
            "",
            "This estimate exceeds the approval threshold. Approve from the dashboard `/settings/wiki` → Approvals queue.",
            "(Approval handoff is not wired in this daemon process.)",
          ].join("\n"),
        );
        return;
      }
      // Pass the preview (not a real commit) — the approval consumer
      // re-runs `runGitPreCompile` when the operator approves so the
      // snapshot is taken right before the compile session starts. This
      // keeps the git log clean when the operator declines.
      await ctx.enqueueWikiApproval({
        workspace: workspace.name,
        processKey: "wiki.compile",
        sourceEvent: ctx.event,
        estimate,
        gitOutcome: gitPreview,
      });
      await ctx.notify(
        [
          ...lines,
          "",
          "Sent for approval. Open `/settings/wiki` → Approvals to confirm and the compile will start.",
        ].join("\n"),
      );
      return;
    }

    // Below threshold — we WILL run the autonomous compile. Acquire the
    // compile lock BEFORE committing the git snapshot so a racing
    // `!compile` does not slip past us and double-commit. If the lock is
    // already held, surface the in-progress holder and bail without
    // touching git.
    const lock = tryAcquireWikiCompileLock(workspace.name, ctx.event.correlationId);
    if (!lock.ok) {
      await ctx.notify(renderCompileInProgressDm(lock.holder, workspace.name));
      return;
    }
    // Forward the tracker so the snapshot SHA is registered with the
    // attribution map before GitWatcher's next poll cycle observes it
    // (C1) — closes the daemon-side self-trigger loop where the wiki
    // pre-compile commit would otherwise feed back as user activity.
    //
    // From here on we hold the compile lock; any throw before the event
    // is enqueued must release it (the dispatcher's `finally` won't fire
    // because no event ever reached the queue).
    let gitOutcome;
    try {
      gitOutcome = await runGitPreCompile(workspace, {
        writeTracker: ctx.writeTracker,
      });
    } catch (err) {
      releaseWikiCompileLock(workspace.name);
      throw err;
    }
    if (gitOutcome.status === "refused") {
      // Extremely narrow race: the tree turned dirty between preview and
      // commit (e.g. a parallel `!ingest` writing to `10_raw/`). Surface and
      // bail rather than silently committing whatever new mess landed.
      releaseWikiCompileLock(workspace.name);
      const preview = gitOutcome.dirtyPaths.slice(0, 5).map((p) => `\`${p}\``).join(", ");
      await ctx.notify(
        [
          `Pre-compile git commit aborted — the working tree turned dirty between estimate and commit.`,
          `Dirty paths: ${preview}${gitOutcome.dirtyPaths.length > 5 ? ` (+${gitOutcome.dirtyPaths.length - 5} more)` : ""}.`,
          `Please commit/stash and rerun \`!compile full\`.`,
        ].join("\n"),
      );
      return;
    }
    if (gitOutcome.status === "committed") {
      lines.push(`- pre-compile git commit: ${gitOutcome.commitSha.slice(0, 7)}`);
    }

    let queued = false;
    try {
      queued = await enqueueOrNotify(
        ctx,
        createWikiCommandEvent({
          processKey: "wiki.compile",
          workspace: workspace.name,
          sourceEvent: ctx.event,
          data: { mode: "full", estimate, git: gitOutcome },
        }),
      );
    } catch (err) {
      releaseWikiCompileLock(workspace.name);
      throw err;
    }
    if (queued) {
      await ctx.notify(
        [
          ...lines,
          "",
          "Below approval threshold — running autonomously.",
        ].join("\n"),
      );
    } else {
      // Enqueue declined — release the lock so the next attempt can run.
      releaseWikiCompileLock(workspace.name);
    }
  },
};

function renderCompileInProgressDm(holder: WikiCompileLockHolder, workspaceName: string): string {
  const minutesAgo = Math.max(0, Math.round((Date.now() - holder.startedAt.getTime()) / 60000));
  const ago = minutesAgo === 0 ? "just now" : `${minutesAgo}m ago`;
  const corr = holder.correlationId ? ` (correlation \`${holder.correlationId}\`)` : "";
  return [
    `A \`wiki.compile\` is already running for workspace \`${workspaceName}\` — started ${ago}${corr}.`,
    `Queueing a second compile would land on a vault state already reflecting the first run's intent. Wait for the in-flight session to finish and re-run \`!compile\` afterwards.`,
  ].join("\n");
}

export const askCommand: BangPrefixCommand = {
  prefix: "!ask",
  title: "Ask wiki",
  describe: "ask a question against the wiki",
  parseArgs(rest) {
    const { workspaceName, rest: payload } = splitWorkspaceToken(rest);
    const question = payload.trim();
    if (!question) {
      throw new BangArgError("Usage: `!ask [@<workspace>] <question>`.");
    }
    return { question, workspaceName } satisfies AskArgs;
  },
  async handler(ctx, rawArgs) {
    const args = rawArgs as AskArgs;
    const workspace = await requireWikiWorkspace(ctx, args.workspaceName);
    if (!workspace) return;
    const queued = await enqueueOrNotify(
      ctx,
      createWikiCommandEvent({
        processKey: "wiki.ask",
        workspace: workspace.name,
        sourceEvent: ctx.event,
        data: { question: args.question },
      }),
    );
    if (queued) {
      await ctx.notify(`Queued wiki answer for workspace \`${workspace.name}\`.`);
    }
  },
};

export const wikiStatusCommand: BangCommand = {
  name: "!wiki",
  title: "Wiki status",
  describe: "show wiki workspace status (one line per active workspace)",
  // Pure DB read — safe to run while the agent is paused so the user can
  // inspect workspace shape without resuming autonomous work.
  runsWhilePaused: true,
  async handler(ctx) {
    if (!isWikiEnabled(ctx.db)) {
      await ctx.notify("Wiki is not enabled. Open `/settings/wiki` to enable the internal workspace.");
      return;
    }
    const workspaces = listActiveWikiWorkspaces(ctx.db);
    if (workspaces.length === 0) {
      // Should not happen — isWikiEnabled said there is at least one
      // active row — but defend against a race that archived it.
      await ctx.notify("Wiki is enabled but no active workspace rows could be resolved.");
      return;
    }
    if (workspaces.length === 1) {
      const workspace = workspaces[0];
      const stats = buildWikiWorkspaceStats(workspace);
      await ctx.notify(
        [
          `Workspace: \`${workspace.name}\` (${workspace.kind})`,
          `Root: \`${workspace.root_path}\``,
          `Language: ${workspace.language}`,
          `Dispatch: ${workspace.dispatch_mode}, concurrency ${workspace.concurrency_cap}`,
          `Notes: ${stats.rawCount} raw, ${stats.wikiCount} wiki, ${stats.outputCount} outputs`,
        ].join("\n"),
      );
      return;
    }
    // Multi-workspace: condense each row to a single line so the DM
    // reply stays mobile-friendly. The owner can pivot to the dashboard
    // for detail or `!wiki @<name>` for a focused view in a follow-up.
    const defaultRow = readDefaultWikiWorkspace(ctx.db);
    const lines: string[] = [`${workspaces.length} active wiki workspaces:`];
    for (const workspace of workspaces) {
      const stats = buildWikiWorkspaceStats(workspace);
      const marker = defaultRow && defaultRow.id === workspace.id ? " (default)" : "";
      lines.push(
        `- \`${workspace.name}\`${marker} — ${stats.rawCount}r/${stats.wikiCount}w/${stats.outputCount}o (${workspace.kind})`,
      );
    }
    lines.push("");
    lines.push("Target a non-default workspace with `@<name>` (e.g. `!ask @research <question>`).");
    await ctx.notify(lines.join("\n"));
  },
};

export const wikiHelpCommand: BangCommand = {
  name: "!wiki help",
  title: "Wiki help",
  describe: "show wiki command help",
  // Static help text — no DB / LLM. Mirrors `!help` semantics.
  runsWhilePaused: true,
  async handler(ctx) {
    await ctx.notify(
      [
        "Wiki commands:",
        "- `!ingest [@<workspace>] <url> [url...]` queues URL ingestion.",
        "- `!compile [@<workspace>]` compiles pending raw notes incrementally; add `full` for a rebuild, `--preview` for a dry-run touch list.",
        "- `!ask [@<workspace>] <question>` answers from the wiki.",
        "- `!lint [@<workspace>]` audits the wiki and writes a dated health report.",
        "- `!trace [@<workspace>] <topic>` traces how an idea has evolved across the wiki.",
        "- `!connect [@<workspace>] <a> <b>` finds bridges between two domains.",
        `- \`!wiki\` shows the ${DEFAULT_WIKI_WORKSPACE_NAME} workspace status (or every active workspace if you run more than one).`,
        "",
        "All commands target the default workspace when `@<workspace>` is omitted.",
      ].join("\n"),
    );
  },
};

/**
 * WIKI_BUILDER_DESIGN.md Phase 3 — `!lint` runs the wiki health audit
 * (orphans, broken links, schema drift, taxonomy candidates) and writes
 * `90_meta/health/<YYYY-MM-DD>.md`. No arguments. Exposed as a
 * `BangPrefixCommand` rather than `BangCommand` so the surface can grow
 * later (e.g. `!lint --since=2026-01-01`) without re-registering; today
 * `parseArgs` rejects any trailing input.
 */
export const lintCommand: BangPrefixCommand = {
  prefix: "!lint",
  title: "Lint wiki",
  describe: "audit the wiki and write a dated health report",
  parseArgs(rest) {
    const { workspaceName, rest: payload } = splitWorkspaceToken(rest);
    if (payload.trim().length > 0) {
      throw new BangArgError("Usage: `!lint [@<workspace>]` (no other arguments).");
    }
    return { workspaceName };
  },
  async handler(ctx, rawArgs) {
    const args = rawArgs as { workspaceName: string | null };
    const workspace = await requireWikiWorkspace(ctx, args.workspaceName);
    if (!workspace) return;
    const queued = await enqueueOrNotify(
      ctx,
      createWikiCommandEvent({
        processKey: "wiki.lint",
        workspace: workspace.name,
        sourceEvent: ctx.event,
      }),
    );
    if (queued) {
      await ctx.notify(
        `Queued wiki lint for workspace \`${workspace.name}\`. The report will land at \`90_meta/health/<today>.md\` when complete.`,
      );
    }
  },
};

/**
 * WIKI_BUILDER_DESIGN.md Phase 3 — `!trace <topic>` reconstructs the
 * chronological evolution of `<topic>` across the wiki's layers and
 * writes one timeline output to
 * `30_outputs/<YYYY-MM-DD>-trace-<slug>.md`.
 *
 * The topic is free-form prose. The skill canonicalises the topic against
 * `90_meta/taxonomy.md` before deriving the output slug, so the bang
 * handler does not validate the topic shape beyond "non-empty after trim".
 */
export const traceCommand: BangPrefixCommand = {
  prefix: "!trace",
  title: "Trace wiki topic",
  describe: "reconstruct an idea's evolution across raw / wiki / outputs",
  parseArgs(rest) {
    const { workspaceName, rest: payload } = splitWorkspaceToken(rest);
    const topic = payload.trim();
    if (!topic) {
      throw new BangArgError("Usage: `!trace [@<workspace>] <topic>`.");
    }
    return { topic, workspaceName } satisfies TraceArgs;
  },
  async handler(ctx, rawArgs) {
    const args = rawArgs as TraceArgs;
    const workspace = await requireWikiWorkspace(ctx, args.workspaceName);
    if (!workspace) return;
    const queued = await enqueueOrNotify(
      ctx,
      createWikiCommandEvent({
        processKey: "wiki.trace",
        workspace: workspace.name,
        sourceEvent: ctx.event,
        data: { topic: args.topic },
      }),
    );
    if (queued) {
      await ctx.notify(
        `Queued wiki trace for \`${args.topic}\` in workspace \`${workspace.name}\`.`,
      );
    }
  },
};

/**
 * Pure helper exported for tests. Parses the rest-string for `!connect`
 * into exactly two topic arguments.
 *
 * Tokenisation rule (WIKI_BUILDER_DESIGN.md §P3.B): the args are
 * "whitespace- or comma-separated". A literal comma OR run of whitespace
 * is the separator. This means `!connect quantum gravity`,
 * `!connect quantum, gravity`, and `!connect "quantum, gravity"` (with
 * the comma being part of a topic) all need a deterministic answer; we
 * pick the simplest rule that matches the design verbatim and reject any
 * input that yields anything other than two non-empty topics. The owner
 * gets a clean usage message; they don't have to learn shell quoting.
 */
export function parseConnectArgs(rest: string): ConnectArgs {
  const { workspaceName, rest: payload } = splitWorkspaceToken(rest);
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new BangArgError("Usage: `!connect [@<workspace>] <a> <b>`.");
  }
  // Split on commas first (explicit boundary), then on whitespace. The
  // explicit comma path lets the operator use multi-word topics:
  // `!connect quantum computing, classical computing` becomes
  // ["quantum computing", "classical computing"].
  const parts = trimmed.includes(",")
    ? trimmed.split(",").map((p) => p.trim()).filter(Boolean)
    : trimmed.split(/\s+/u).filter(Boolean);
  if (parts.length !== 2) {
    throw new BangArgError(
      "Usage: `!connect [@<workspace>] <a> <b>` — exactly two topics, separated by a comma or whitespace.",
    );
  }
  return { topicA: parts[0], topicB: parts[1], workspaceName } satisfies ConnectArgs;
}

/**
 * WIKI_BUILDER_DESIGN.md Phase 3 — `!connect <a> <b>` bridges two
 * domains. Output lands at
 * `30_outputs/<YYYY-MM-DD>-connect-<slug-a>--<slug-b>.md`.
 *
 * Exactly two args required. See {@link parseConnectArgs}.
 */
export const connectCommand: BangPrefixCommand = {
  prefix: "!connect",
  title: "Connect wiki domains",
  describe: "bridge two domains in the wiki",
  parseArgs(rest) {
    return parseConnectArgs(rest);
  },
  async handler(ctx, rawArgs) {
    const args = rawArgs as ConnectArgs;
    const workspace = await requireWikiWorkspace(ctx, args.workspaceName);
    if (!workspace) return;
    const queued = await enqueueOrNotify(
      ctx,
      createWikiCommandEvent({
        processKey: "wiki.connect",
        workspace: workspace.name,
        sourceEvent: ctx.event,
        data: { topic_a: args.topicA, topic_b: args.topicB },
      }),
    );
    if (queued) {
      await ctx.notify(
        `Queued wiki connect between \`${args.topicA}\` and \`${args.topicB}\` in workspace \`${workspace.name}\`.`,
      );
    }
  },
};

/**
 * WIKI_BUILDER_DESIGN.md §P4.B — render a compile preview into the DM
 * reply shape. Truncates the added/modified/unchanged lists at 8 entries
 * so the mobile reply stays scrollable; the dashboard's
 * `/wiki/compile/preview` route surfaces the full lists. Exported for
 * tests.
 */
export function formatCompilePreview(preview: import("@aitne/shared").WikiCompilePreview): string {
  const lines: string[] = [];
  lines.push(`Compile preview for \`${preview.workspace}\` (${preview.mode}):`);
  lines.push(
    `- ${preview.added.length} added, ${preview.modified.length} modified, ${preview.unchanged.length} unchanged`,
  );
  if (preview.added.length > 0) {
    lines.push(`- add: ${preview.added.slice(0, 8).map((p) => `\`${p}\``).join(", ")}${preview.added.length > 8 ? ` (+${preview.added.length - 8} more)` : ""}`);
  }
  if (preview.modified.length > 0) {
    lines.push(`- modify: ${preview.modified.slice(0, 8).map((p) => `\`${p}\``).join(", ")}${preview.modified.length > 8 ? ` (+${preview.modified.length - 8} more)` : ""}`);
  }
  lines.push(
    `- est. cost: $${preview.estimate.optimisticUsd.toFixed(2)}–$${preview.estimate.pessimisticUsd.toFixed(2)} (expected $${preview.estimate.expectedUsd.toFixed(2)})`,
  );
  lines.push(
    `- est. duration: ${formatDuration(preview.estimatedDurationSeconds)}`,
  );
  lines.push(`No agent session ran. Reply \`!compile${preview.mode === "full" ? " full" : ""}\` to start the compile.`);
  return lines.join("\n");
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "< 1s";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

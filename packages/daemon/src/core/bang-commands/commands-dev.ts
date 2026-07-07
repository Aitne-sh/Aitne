/**
 * Development-mode bang commands — `!repo <name>` (enter dev mode + start the
 * contract interview), `!approve` (approve the drafted contract + start the
 * autonomous loop), and `!exit` (end the dev session).
 *
 * All three are `runsWhilePaused: true` — they are pure state transitions +
 * runner calls that enqueue no LLM work at command time (the interview turn is
 * dispatched later by the message-handler dev-mode branch). Dev mode is a
 * global singleton (D5): `!repo` refuses while another session is active.
 *
 * They reach the in-memory loop runner + the dispatcher's dev-mode latch via
 * the `getDevModeRunner` / `beginDevMode` context callbacks (threaded through
 * BOTH commandCtx branches in registry.ts).
 */

import { randomUUID } from "node:crypto";
import {
  listRepositories,
  resolveRepositoryIdentifier,
  type RepositoryDTO,
} from "../../db/repositories-store.js";
import {
  createDevSession,
  getActiveDevSession,
  markDevTerminal,
} from "../../db/dev-sessions-store.js";
import { isGitWorktree } from "../../services/dev-mode/dev-loop-docs.js";
import type {
  BangCommand,
  BangCommandContext,
  BangPrefixCommand,
} from "./registry.js";

/** Resolve `<name>` to a repository: try the id / `owner/repo` resolver first,
 *  then fall back to a slug / display-name match (case-insensitive). */
function resolveRepo(ctx: BangCommandContext, name: string): RepositoryDTO | null {
  const direct = resolveRepositoryIdentifier(ctx.db, name);
  if (direct) return direct;
  const lower = name.toLowerCase();
  const all = listRepositories(ctx.db, {});
  return (
    all.find((r) => r.slug.toLowerCase() === lower)
    ?? all.find((r) => (r.displayName ?? "").toLowerCase() === lower)
    ?? null
  );
}

export const repoCommand: BangPrefixCommand = {
  prefix: "!repo",
  title: "Dev mode",
  describe: "Dev mode in a repo",
  runsWhilePaused: true,
  parseArgs: (rest) => rest.trim(),
  handler: async (ctx, args) => {
    const name = typeof args === "string" ? args.trim() : "";
    if (name.length === 0) {
      await ctx.notify(
        "Usage: !repo <name> — the repository id, owner/repo, slug, or display name.",
      );
      return;
    }
    // Singleton guard (D5).
    const active = getActiveDevSession(ctx.db);
    if (active) {
      await ctx.notify(
        `Already in dev mode for ${active.slug ?? active.repositoryId}. Reply !exit to end it first.`,
      );
      return;
    }
    const repo = resolveRepo(ctx, name);
    if (!repo) {
      await ctx.notify(
        `No repository matches "${name}". Register it first, or check the name/slug.`,
      );
      return;
    }
    if (!repo.localPath) {
      await ctx.notify(
        `"${repo.slug}" has no local worktree registered — dev mode needs a local clone.`,
      );
      return;
    }
    if (!isGitWorktree(repo.localPath)) {
      await ctx.notify(
        `"${repo.slug}" (${repo.localPath}) isn't a git worktree. Run \`git init\` there first.`,
      );
      return;
    }

    const sessionId = randomUUID();
    const now = Date.now();
    createDevSession(ctx.db, {
      id: sessionId,
      repositoryId: repo.id,
      slug: repo.slug,
      originatingPlatform: ctx.event.platform,
      originatingChannel: `${ctx.event.platform}:${ctx.event.channel}`,
      createdAt: now,
    });
    ctx.beginDevMode?.({
      sessionId,
      repositoryId: repo.id,
      slug: repo.slug,
      enteredAt: now,
    });
    ctx.getDevModeRunner?.()?.armTimeout(sessionId);
    await ctx.notify(
      `Dev mode on for ${repo.slug}. Tell me what you want me to build — the goal, the concrete requirements, and how to verify success. `
        + "I'll survey the repo and draft a contract for your approval. Reply !exit anytime to stop.",
    );
  },
};

export const approveCommand: BangCommand = {
  name: "!approve",
  title: "Approve dev contract",
  describe: "Approve & start",
  runsWhilePaused: true,
  handler: async (ctx) => {
    const session = getActiveDevSession(ctx.db);
    if (!session) {
      await ctx.notify("No dev session is active. Start one with !repo <name>.");
      return;
    }
    if (session.state !== "awaiting_approval") {
      await ctx.notify(
        session.state === "interview"
          ? "The contract isn't ready yet — finish describing what you want, and I'll draft it for approval."
          : `Nothing to approve right now (the session is ${session.state}).`,
      );
      return;
    }
    const runner = ctx.getDevModeRunner?.();
    if (!runner) {
      await ctx.notify("Dev mode is unavailable right now (the loop runner isn't wired). Try again shortly.");
      return;
    }
    const result = runner.startFromApproval(session.id);
    await ctx.notify(
      result.ok
        ? `Approved — building on branch ${result.branch}. I'll report back when it finishes or needs a decision.`
        : `Couldn't start the loop: ${result.reason}. Reply !exit to end the session.`,
    );
  },
};

export const exitCommand: BangCommand = {
  name: "!exit",
  title: "Exit dev mode",
  describe: "End dev mode",
  runsWhilePaused: true,
  handler: async (ctx) => {
    const session = getActiveDevSession(ctx.db);
    if (!session) {
      await ctx.notify("No dev session is active.");
      return;
    }
    const runner = ctx.getDevModeRunner?.();
    if (runner) {
      await runner.cancel(session.id, "user_bang_exit");
    } else {
      // Runner not wired (boot race) — write the terminal directly; the
      // message-handler's stale-latch check drops the pointer on the next DM.
      markDevTerminal(ctx.db, {
        id: session.id,
        state: "exited",
        loopState: session.loopState,
        exitedAt: Date.now(),
      });
    }
    await ctx.notify(`Dev mode ended for ${session.slug ?? session.repositoryId}.`);
  },
};

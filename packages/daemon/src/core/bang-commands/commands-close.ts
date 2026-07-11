/**
 * `!close` — explicit DM session close. Replaces the bare-word
 * `end` / `close` / `done` matcher that used to intercept owner DMs at
 * `EventDispatcher.handleMessage` — that matcher would silently close
 * the conversation any time the user typed the word "done" on its own
 * (a frequent natural-English completion signal), with no way to
 * disambiguate from a genuine close intent.
 *
 * Behaviour:
 *   - With an active session for this DM tuple → records the `!close`
 *     turn, closes the session (workdir cleanup is handled by the
 *     session manager), and replies "Session closed."
 *   - Without an active session → no-op DB-side; reply is honest
 *     ("No active session to close.") rather than the old "Session
 *     closed." lie.
 *
 * Pause semantics:
 *   - `runsWhilePaused: true`. Closing a conversation is a state-only
 *     operation (no LLM call, no autonomous work), so the pause gate
 *     would only prevent the user from cleaning up state they own.
 */
import type { BangCommand } from "./registry.js";

export const closeCommand: BangCommand = {
  name: "!close",
  title: "Close session",
  describe: "End the DM session",
  details: [
    "Closes the active conversation session for this DM channel.",
    "Workdir is cleaned up; the next DM starts fresh with no carried context.",
    "No LLM call. Safe to use while the agent is paused.",
  ],
  runsWhilePaused: true,
  handler: async (ctx) => {
    if (!ctx.closeActiveDmSession) {
      await ctx.notify("Session close is not available in this daemon process.");
      return;
    }
    const result = await ctx.closeActiveDmSession();
    if (result.closedId === null) {
      await ctx.notify("No active session to close.");
      return;
    }
    await ctx.notify("Session closed.");
  },
};

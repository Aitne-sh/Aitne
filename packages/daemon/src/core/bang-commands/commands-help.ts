/**
 * `!help` — list every registered bang command (built-ins + enabled user
 * commands) with its short description so the owner can recover the surface
 * without checking the docs.
 *
 * v1 emitted help only on unknown bang (`buildUnknownCommandReply`). `!help`
 * promotes that affordance to an explicit, discoverable command and lifts
 * the 6-entry cap the unknown-bang path applies — the user is asking for
 * the full list, so we render everything and only truncate at the mobile
 * reply budget.
 *
 * Auto-reflection contract — both sides read live state on every call, so
 * any newly-registered built-in (via `registry.register(...)`) and any new
 * row in `user_bang_commands` show up on the next `!help` with no extra
 * wiring:
 *
 *   - built-ins  : ctx.registry.list()       // live Map iteration
 *   - user cmds  : listUserBangCommands(db)  // live SELECT each call
 *
 * Mobile-bubble layout — command name on its own line, description
 * indented two spaces on the next, blank line between entries. This keeps
 * each entry visually intact when chat-bubble wrap kicks in on a narrow
 * phone screen (a long description wraps under the indent, never under a
 * neighbouring command).
 */
import { getBangCommandName } from "./registry.js";
import type { BangCommand, RegisteredBangCommand } from "./registry.js";
import {
  listUserBangCommands,
  type UserBangCommand,
} from "./user-commands.js";
import { MOBILE_REPLY_BUDGET } from "./format-utils.js";

function renderEntry(name: string, describe: string): string[] {
  return [name, `  ${describe.trim()}`];
}

export function formatHelp(
  builtIns: RegisteredBangCommand[],
  userCommands: UserBangCommand[],
): string {
  const enabledUserCommands = userCommands
    .filter((cmd) => cmd.enabled)
    .sort((a, b) => a.command.localeCompare(b.command));
  const sortedBuiltIns = [...builtIns].sort((a, b) =>
    getBangCommandName(a).localeCompare(getBangCommandName(b)),
  );
  const totalCommands = sortedBuiltIns.length + enabledUserCommands.length;

  // P2-22: lead with the total count so the operator can detect at a
  // glance whether truncation hid entries. The full body still renders
  // below — `truncateForMobile` (via `makeNotify`) only cuts when the
  // assembled text exceeds MOBILE_REPLY_BUDGET, and the count line
  // survives because it precedes any truncation point.
  const lines: string[] = [
    "[SYSTEM · !help]",
    `${totalCommands} command${totalCommands === 1 ? "" : "s"} total`,
  ];

  if (sortedBuiltIns.length > 0) {
    lines.push("", "Built-in:");
    for (const cmd of sortedBuiltIns) {
      lines.push("", ...renderEntry(getBangCommandName(cmd), cmd.describe));
    }
  }

  if (enabledUserCommands.length > 0) {
    lines.push("", "Custom:");
    for (const cmd of enabledUserCommands) {
      const desc =
        cmd.description.trim().length > 0
          ? cmd.description.trim()
          : `${cmd.backendId} · ${cmd.modelId}`;
      lines.push("", ...renderEntry(cmd.command, desc));
    }
  }

  // P2-22: when we know the body will overflow the mobile budget, append
  // a dashboard-pointer footer BEFORE `truncateForMobile` snips the tail.
  // The generic `… (truncated)` marker doesn't tell the operator that the
  // dashboard has the rest; this footer does. `ensureSystemMarker` is a
  // no-op here because the body already starts with `[SYSTEM · !help]`,
  // so the exact-budget math below is safe — slicing to `BUDGET -
  // FOOTER.length` and appending FOOTER lands the result at exactly
  // MOBILE_REPLY_BUDGET, and `truncateForMobile` then short-circuits.
  const body = lines.join("\n");
  const FOOTER = "\n\nMore commands available — open the dashboard to browse the full list.";
  if (body.length + FOOTER.length > MOBILE_REPLY_BUDGET) {
    let room = MOBILE_REPLY_BUDGET - FOOTER.length;
    if (room <= 0) {
      // FOOTER alone would overflow — extremely unlikely (FOOTER ~75 chars
      // vs. 1500-char budget) but guard so we never slice with a negative
      // length. Drop to a truncated body without the dashboard hint and
      // let truncateForMobile handle it.
      return body;
    }
    // Avoid splitting a surrogate pair at the boundary, mirroring
    // truncateForMobile (P2-03).
    if (
      room > 0
      && body.charCodeAt(room - 1) >= 0xd800
      && body.charCodeAt(room - 1) <= 0xdbff
    ) {
      room -= 1;
    }
    return `${body.slice(0, room)}${FOOTER}`;
  }
  return body;
}

export const helpCommand: BangCommand = {
  name: "!help",
  title: "List commands",
  describe: "Show every registered command.",
  details: [
    "Lists built-in commands and any enabled user-defined commands.",
    "Disabled user commands are hidden.",
    "Output is truncated at the mobile reply budget if very long.",
  ],
  runsWhilePaused: true,
  handler: async (ctx) => {
    const builtIns = ctx.registry.list();
    const userCommands = listUserBangCommands(ctx.db);
    await ctx.notify(formatHelp(builtIns, userCommands));
  },
};

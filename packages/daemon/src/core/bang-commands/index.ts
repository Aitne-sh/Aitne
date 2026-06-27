/**
 * Public surface for the messaging bang-commands module.
 *
 * Spec: docs/design/backlog/messaging-bang-commands.md
 */
export {
  BangCommandRegistry,
  BangArgError,
  buildPausedNotice,
  buildUnknownCommandReply,
  getBangCommandName,
  makeNotify,
  normalizeBangCommandText,
  tryHandle,
} from "./registry.js";
export type {
  BangCommand,
  BangCommandContext,
  BangCommandMatch,
  BangPrefixCommand,
  RegisteredBangCommand,
} from "./registry.js";
export { stopCommand, startCommand } from "./commands-stop-start.js";
export { statusCommand, stopTaskCommand } from "./commands-task-control.js";
export { closeCommand } from "./commands-close.js";
export {
  costAllCommand,
  costBackendCommands,
  formatCostAll,
  formatCostFiltered,
} from "./commands-cost.js";
export { reportCommand, formatReport } from "./commands-report.js";
export { helpCommand, formatHelp } from "./commands-help.js";
export {
  askCommand,
  connectCommand,
  compileCommand,
  lintCommand,
  parseConnectArgs,
  traceCommand,
  ingestCommand,
  wikiHelpCommand,
  wikiStatusCommand,
} from "./commands-wiki.js";
export { researchCommand, parseResearchArgs } from "./commands-research.js";
export { checksCommand, formatChecks } from "./commands-checks.js";
export { revertTuningCommand } from "./commands-revert-tuning.js";
export {
  buildSystemMarker,
  ensureSystemMarker,
  formatLocalLong,
  formatLocalShort,
  formatMoney,
  MOBILE_REPLY_BUDGET,
  truncateForMobile,
} from "./format-utils.js";
export {
  CUSTOM_BANG_COMMAND_SOURCE,
  DEFAULT_USER_BANG_COMMAND_SKILLS,
  USER_BANG_COMMAND_NAME_PATTERN,
  buildUserBangCommandPrompt,
  createUserBangCommand,
  createUserBangCommandEvent,
  deleteUserBangCommand,
  getEnabledUserBangCommandByCommand,
  getUserBangCommandByCommand,
  getUserBangCommandById,
  listUserBangCommands,
  normalizeBangCommandName,
  parseEnabledSkills,
  resolveCommandSkillSlugs,
  serializeEnabledSkills,
  updateUserBangCommand,
} from "./user-commands.js";
export type {
  NormalizeBangCommandNameResult,
  UserBangCommand,
  UserBangCommandInput,
} from "./user-commands.js";

import { BangCommandRegistry } from "./registry.js";
import { startCommand, stopCommand } from "./commands-stop-start.js";
import { statusCommand, stopTaskCommand } from "./commands-task-control.js";
import { closeCommand } from "./commands-close.js";
import {
  costAllCommand,
  costBackendCommands,
} from "./commands-cost.js";
import { reportCommand } from "./commands-report.js";
import { helpCommand } from "./commands-help.js";
import {
  askCommand,
  connectCommand,
  compileCommand,
  lintCommand,
  traceCommand,
  ingestCommand,
  wikiHelpCommand,
  wikiStatusCommand,
} from "./commands-wiki.js";
import { researchCommand } from "./commands-research.js";
import { checksCommand } from "./commands-checks.js";
import { revertTuningCommand } from "./commands-revert-tuning.js";

/**
 * Build a registry preloaded with the v1 built-in commands. The registry
 * is mutable — callers can `.register(...)` more commands afterwards.
 */
export function createDefaultBangCommandRegistry(): BangCommandRegistry {
  const registry = new BangCommandRegistry();
  registry.register(stopCommand);
  registry.register(startCommand);
  // BACKGROUND_TASK_RUNNER_DESIGN.md Phase 4 — per-task control. `!status`
  // (exact) lists active detached tasks; `!stop <id>` (prefix) cancels one.
  // Bare `!stop` still resolves to the exact pause command above.
  registry.register(statusCommand);
  registry.register(stopTaskCommand);
  registry.register(closeCommand);
  registry.register(costAllCommand);
  for (const cmd of costBackendCommands) {
    registry.register(cmd);
  }
  registry.register(reportCommand);
  registry.register(helpCommand);
  registry.register(wikiStatusCommand);
  registry.register(wikiHelpCommand);
  registry.register(ingestCommand);
  registry.register(compileCommand);
  registry.register(askCommand);
  // WIKI_BUILDER_DESIGN.md Phase 3 — operational triad.
  registry.register(lintCommand);
  registry.register(traceCommand);
  registry.register(connectCommand);
  // BROWSER_HISTORY_INTEGRATION_PLAN P3 — `!research` family.
  registry.register(researchCommand);
  // BROWSER_HISTORY_INTEGRATION_PLAN P4b — `!checks` (F4 reload-memory
  // pull surface). Pure DB read on `browser_reload_signals`; the F4
  // weekly surfacing lives inside `routine.weekly_review` and uses
  // `/api/browser-history/reloads/weekly` instead.
  registry.register(checksCommand);
  // SELF_TUNING_REVIEW_CYCLE_DESIGN.md §3.4 Phase 3 — `!revert tuning`,
  // the owner-side undo for autonomously applied tuning changes.
  registry.register(revertTuningCommand);
  return registry;
}

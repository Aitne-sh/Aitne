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

/**
 * Build a registry preloaded with the v1 built-in commands. The registry
 * is mutable — callers can `.register(...)` more commands afterwards.
 */
export function createDefaultBangCommandRegistry(): BangCommandRegistry {
  const registry = new BangCommandRegistry();
  registry.register(stopCommand);
  registry.register(startCommand);
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
  return registry;
}

/**
 * `!revert tuning` — undo the most recent applied self-tuning config change
 * (SELF_TUNING_REVIEW_CYCLE_DESIGN.md §3.4, Phase 3).
 *
 * The owner-side escape hatch for the Autonomous-plus-DM actuation posture
 * (D1): every applied change DMs "Reply `!revert tuning` to undo", and this
 * command is that reply. It restores the ledger's `prev` value through the
 * same `applyConfigUpdates` chokepoint the actuator used, stamps
 * `reverted_at` (which puts the key into the 28-day re-proposal cool-down),
 * audits `self_tuning.reverted`, and records an explicit-correction
 * feedback signal so the lesson loop learns from the owner's override.
 *
 * `runsWhilePaused: true` — a pure DB/config write with no LLM dispatch,
 * and the owner may well have paused the agent *because* of a bad tuning
 * change; the undo must not be locked behind `!start`.
 */
import { BangArgError, type BangCommandContext, type BangPrefixCommand } from "./registry.js";
import { applyConfigUpdates } from "../../api/env-writer.js";
import { createSettingsStore } from "../../settings/settings-store.js";
import {
  findLatestRevertableEntry,
  listLedgerEntries,
  revertAppliedTuningChange,
} from "../feedback/tuning-actuator.js";

const USAGE =
  "Usage: `!revert tuning` — undo the most recent self-tuning config change.";

export const revertTuningCommand: BangPrefixCommand = {
  prefix: "!revert",
  title: "Revert self-tuning",
  describe: "undo the most recent self-tuning config change",
  details: [
    "Restores the previous value of the most recently applied self-tuning config change via the standard config chokepoint.",
    "The reverted key enters a 28-day re-proposal cool-down so the loop cannot immediately re-apply it.",
    "Pure DB/config write — works while the agent is paused.",
  ],
  runsWhilePaused: true,
  parseArgs: (rest: string) => {
    if (rest.toLowerCase() !== "tuning") {
      throw new BangArgError(USAGE);
    }
    return undefined;
  },
  handler: async (ctx: BangCommandContext): Promise<void> => {
    const entry = findLatestRevertableEntry(listLedgerEntries(ctx.db));
    if (!entry) {
      await ctx.notify(
        "No applied self-tuning change to revert. Applied changes show up in the daemon's per-change DM and the weekly review's tuning ledger.",
      );
      return;
    }
    const settingsStore = createSettingsStore(ctx.db);
    const result = await revertAppliedTuningChange(
      {
        db: ctx.db,
        applyUpdates: (updates) =>
          applyConfigUpdates(ctx.config, settingsStore, updates, { db: ctx.db }),
        feedbackLearningEnabled: ctx.config.feedbackLearningEnabled,
      },
      entry,
      {
        trigger: "bang_command",
        reason: "owner requested revert via !revert tuning",
        now: new Date(),
      },
    );
    if (!result.ok) {
      await ctx.notify(`Could not revert ${entry.key}: ${result.error}`);
      return;
    }
    await ctx.notify(
      `Reverted ${entry.key} ${String(entry.blob.proposed)} → ` +
        `${String(entry.blob.prev)} (rule ${entry.blob.rule}, applied ` +
        `${entry.blob.applied_at.slice(0, 10)}). The key is now in a ` +
        "28-day re-proposal cool-down.",
    );
  },
};

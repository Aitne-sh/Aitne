/**
 * Context-file write-path validators, extracted from the inline
 * implementation that used to live in `api/routes/context.ts`.
 *
 * Split per `docs/design/appendices/api-route-decomposition.md` §5.3
 * (PR 3) so the route file holds routing + permission gating only and
 * each validator gets its own dedicated unit-test file.
 *
 * Every export here is a pure function or shape type — no Hono, no
 * filesystem, no DB. The route handler composes them; consumers
 * (snapshot restore preflight, future migration tools) can also import
 * them directly without dragging in route-layer dependencies.
 */

export {
  normalizeSection,
  findSection,
  sumLength,
  getAvailableSections,
} from "./section.js";

export {
  SNAPSHOT_DEBOUNCE_MS,
  parseEntryTimestamp,
  clearEntriesBefore,
  trimBulletEntries,
} from "./snapshot-debounce.js";

export {
  validateBuiltInRoutineRulebook,
  explainCustomRoutineValidationError,
  extractRoutineFrontmatter,
  readRoutineFrontmatterScalar,
  validateBaseYamlSyntax,
} from "./routine-rulebook.js";

export {
  TODAY_REQUIRED_SECTIONS,
  TODAY_H1_RE,
  TODAY_DAY_TYPE_RE,
  isLegacyTodayContent,
  validateTodayContent,
  toTodayScheduleCandidate,
  type TodayScheduleCandidate,
  type AgentPlanScheduleCandidate,
} from "./today.js";

export {
  validateContextContent,
  prepareContextContentForWrite,
  type ResolvedContextTarget,
  type ContentWriteValidationOptions,
  type ContextContentValidationError,
} from "./prepare-write.js";

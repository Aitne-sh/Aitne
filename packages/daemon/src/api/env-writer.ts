/**
 * Utilities for `.env` persistence paths.
 *
 * Runtime settings live in SQLite; `.env` is reserved for bootstrap fields.
 */
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";
import {
  pickRuntimeSettings,
  validateExternalObsidianVaultPath,
  validatePrimaryVaultPath,
  type AgentConfig,
} from "../config.js";
import type { SettingsStore } from "../settings/settings-store.js";
import { createLogger } from "../logging.js";

const logger = createLogger("env-writer");

/**
 * SETUP-FLOW-REDESIGN-PLAN §6.2 — keys that, when patched via
 * `applyConfigUpdates`, must trigger a `<dataDir>/integrations.md`
 * re-render so the `Note Sources` section reflects the new value. The
 * section's content is derived from the integrations DB plus these
 * runtime-settings fields, so a write to either side has to flow through
 * the renderer.
 */
const NOTE_SOURCES_KEYS = new Set<string>([
  "externalObsidianVaultPath",
  "externalObsidianVaultName",
  "externalObsidianWatch",
]);
import { runtimeSettingsSchema } from "../settings/runtime-settings.js";
import { isNotificationDestinationPlatform } from "../messaging/constants.js";
import {
  APP_NAME,
  normalizeAgentDisplayName,
  validateAgentDisplayName,
  EDITABLE_RUNTIME_KEY_TUPLE,
  EDITABLE_BOOTSTRAP_KEY_TUPLE,
  RESTART_REQUIRED_KEY_TUPLE,
} from "@aitne/shared";
import type { EditableRuntimeKey, EditableBootstrapKey, RestartRequiredKey } from "@aitne/shared";

export function ensureEnvFilePermissions(envPath: string): void {
  try {
    chmodSync(envPath, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

const CONFIG_TO_ENV: Record<string, string> = {
  apiPort: "PA_API_PORT",
};

const EDITABLE_RUNTIME_KEYS = new Set<EditableRuntimeKey>(EDITABLE_RUNTIME_KEY_TUPLE);
const EDITABLE_BOOTSTRAP_KEYS = new Set<EditableBootstrapKey>(EDITABLE_BOOTSTRAP_KEY_TUPLE);
const RESTART_REQUIRED_KEYS = new Set<RestartRequiredKey>(RESTART_REQUIRED_KEY_TUPLE);

// Compile-time drift guard: if a key in the shared tuples doesn't exist on AgentConfig,
// TypeScript reports the invalid key name here.  Zero runtime cost — type aliases only.
type _AssertKeysOf<T extends keyof AgentConfig> = T;
type _CkRuntime = _AssertKeysOf<EditableRuntimeKey>;
type _CkBootstrap = _AssertKeysOf<EditableBootstrapKey>;
type _CkRestart = _AssertKeysOf<RestartRequiredKey>;

const SECRET_KEYS = new Set([
  "slackBotToken",
  "slackAppToken",
  "telegramBotToken",
  "discordBotToken",
  "notionApiKey",
  "githubToken",
  "githubWebhookSecret",
  "googleCredentialsJson",
  "googleTokenJson",
  "appleCalendarCredentials",
  "apiToken",
] as const);

function isEditableRuntimeKey(key: string): key is EditableRuntimeKey {
  return EDITABLE_RUNTIME_KEYS.has(key as EditableRuntimeKey);
}

function isEditableBootstrapKey(key: string): key is EditableBootstrapKey {
  return EDITABLE_BOOTSTRAP_KEYS.has(key as EditableBootstrapKey);
}

function isRestartRequiredKey(key: string): key is RestartRequiredKey {
  return RESTART_REQUIRED_KEYS.has(key as RestartRequiredKey);
}

const NUMERIC_RANGE: Record<string, { min: number; max: number; label: string }> = {
  dayBoundaryHour: { min: 0, max: 9, label: "0–9 (before 10:00)" },
  executeTimeoutMinutes: { min: 1, max: 1440, label: "1–1440 minutes" },
  activityScanActiveStartHour: { min: 0, max: 23, label: "0–23" },
  activityScanActiveEndHour: { min: 1, max: 24, label: "1–24" },
  // Any positive integer up to one day. Intervals that evenly divide 60
  // produce a tight cron; arbitrary intervals run a minute-tick cron with an
  // in-callback modulo gate anchored at activeStartHour. See
  // scheduler.ts:buildActivityScanCronExpr / shouldFireActivityScanTickAt.
  activityScanIntervalMinutes: { min: 1, max: 1440, label: "1–1440 minutes" },
  activityScanMinObservations: { min: 0, max: 1000, label: "0–1000" },
  // Twin of the runtimeSettingsSchema bound; cap 480 = the self-tuning R1
  // freshness ladder's top notch (SELF_TUNING_REVIEW_CYCLE_DESIGN.md D2).
  activityScanPrePassFreshnessMinutes: { min: 0, max: 480, label: "0–480 minutes" },
  gitPollIntervalSeconds: { min: 60, max: 86400, label: "60–86400 seconds" },
  githubPollIntervalSeconds: { min: 60, max: 86400, label: "60–86400 seconds" },
  // 0 disables the observer; 20160 min = 14 days which is already well past
  // useful cadence territory. The Zod schema enforces nonnegative int; this
  // adds an upper bound so a typo doesn't silently stall probes for months.
  mcpAutoProbeIntervalMinutes: { min: 0, max: 20160, label: "0–20160 minutes (0 disables)" },
};

const NUMERIC_ENUM: Record<string, { values: number[]; label: string }> = {};

const STRING_VALIDATORS: Record<string, (v: string) => string | null> = {
  timezone: (v) => {
    if (!v) return null;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: v });
      return null;
    } catch {
      return "Invalid IANA timezone (e.g., 'America/New_York', 'UTC')";
    }
  },
  whatsappOwnerPhone: (v) => {
    if (!v) return null;
    return /^\+\d{8,15}$/.test(v)
      ? null
      : "Expected E.164 format (e.g. +818012345678)";
  },
  agentDisplayName: (v) => validateAgentDisplayName(v),
};

const ARRAY_VALIDATORS: Record<string, (v: unknown[]) => string | null> = {
  defaultNotificationPlatforms: (v) => {
    const invalid = v.filter(
      (item): item is unknown =>
        typeof item !== "string" || !isNotificationDestinationPlatform(item),
    );
    if (invalid.length === 0) return null;
    return "Default notification destinations must be slack, telegram, discord, or whatsapp";
  },
  enabledMailProviders: (v) => {
    const allowed = new Set(["gmail", "outlook", "yahoo", "icloud"]);
    const invalid = v.filter(
      (item) => typeof item !== "string" || !allowed.has(item),
    );
    if (invalid.length > 0) {
      return "enabledMailProviders must contain only gmail, outlook, yahoo, or icloud";
    }
    if (new Set(v).size !== v.length) {
      return "enabledMailProviders must not contain duplicates";
    }
    return null;
  },
  githubRepos: (v) => {
    const invalid = v.filter(
      (item) =>
        typeof item !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item),
    );
    if (invalid.length > 0) {
      return "githubRepos must contain only owner/repo strings";
    }
    const normalized = v.map((item) =>
      typeof item === "string" ? item.toLowerCase() : String(item),
    );
    if (new Set(normalized).size !== v.length) {
      return "githubRepos must not contain duplicates";
    }
    return null;
  },
  gitWatchedRepos: (v) => {
    const seenPaths = new Set<string>();
    const seenSlugs = new Set<string>();
    for (const item of v) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return "gitWatchedRepos entries must be objects";
      }
      const repo = item as Record<string, unknown>;
      if (typeof repo.path !== "string" || repo.path.trim() === "") {
        return "gitWatchedRepos entries require a non-empty path";
      }
      const normalizedPath = expandHome(repo.path);
      if (seenPaths.has(normalizedPath)) {
        return "gitWatchedRepos must not contain duplicate paths";
      }
      seenPaths.add(normalizedPath);
      if (
        repo.slug !== undefined
        && (typeof repo.slug !== "string" || repo.slug.trim() === "")
      ) {
        return "gitWatchedRepos.slug must be a non-empty string when provided";
      }
      if (typeof repo.slug === "string") {
        const slugKey = repo.slug.toLowerCase();
        if (seenSlugs.has(slugKey)) {
          return "gitWatchedRepos must not contain duplicate slugs";
        }
        seenSlugs.add(slugKey);
      }
      if (
        repo.classification !== undefined
        && repo.classification !== "project"
        && repo.classification !== "repo-only"
      ) {
        return "gitWatchedRepos.classification must be project or repo-only";
      }
    }
    return null;
  },
};

function validateBootstrapValue(key: EditableBootstrapKey, value: unknown): string | null {
  switch (key) {
    case "apiPort":
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
        return "Value must be an integer between 1 and 65535";
      }
      return null;
    default: {
      // Compile-time exhaustiveness: adding a new EditableBootstrapKey
      // without a switch arm fails the type check here, preventing a
      // bootstrap field from silently bypassing validation.
      const _exhaustive: never = key;
      void _exhaustive;
      return `Validation not implemented for bootstrap key: ${String(key)}`;
    }
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

function expandHomePreservingRelative(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

export function serializeForEnv(value: unknown): string {
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    // JSON.stringify already escapes \r / \n inside strings, so the
    // serialized form is single-line and safe to write as one env value.
    return JSON.stringify(value);
  }
  // Strip CR/LF from scalar values before they reach `updateEnvFile`. A raw
  // newline in a string config value (e.g. a path or display name) would be
  // written verbatim as `KEY=foo\nBAR=...`, and the injected `BAR=...` line
  // would be parsed by dotenv as a separate variable on next load — silently
  // corrupting `.env`. No legitimate bootstrap value contains a newline.
  return String(value ?? "").replace(/[\r\n]+/g, " ");
}

export function getEnvFilePath(): string {
  return resolve(process.cwd(), ".env");
}

/**
 * Atomically rewrite `.env`. The original `writeFileSync(envPath, ...)` was
 * not atomic: it truncates to length 0 first, then writes. A crash, signal
 * (SIGTERM during shutdown), or transient EIO between truncation and write
 * leaves `.env` empty or partial — and since `.env` carries `PA_API_PORT`,
 * the daemon may then fail to start on the next launch (a brick-on-upgrade
 * scenario on a released product).
 *
 * Strategy mirrors `packages/daemon/src/core/atomic-write.ts`:
 *   1. Refuse to write through a symlink at the final path. The legacy
 *      `writeFileSync` would silently follow it; we surface the symlink
 *      as a clear error so the caller can investigate (the alternative —
 *      replacing the symlink with a regular file — silently breaks the
 *      user's intended indirection). Symlinked `.env` is uncommon; the
 *      explicit error is preferable to a silent behavior change.
 *   2. Open a sibling tempfile in the same directory with
 *      `O_CREAT | O_WRONLY | O_EXCL | O_NOFOLLOW` and mode 0o600 so the
 *      published file mode is correct from creation, no symlink can be
 *      raced into our temp path, and a pre-existing tempfile aborts the
 *      write rather than getting silently clobbered.
 *   3. Use a crypto-random 64-bit suffix on the tempfile name — pid +
 *      Date.now() is guessable by a local attacker and would let a
 *      pre-placed symlink survive.
 *   4. Write, fsync the bytes (so they're durable before rename), close,
 *      then atomic `renameSync` over the target.
 *   5. Best-effort cleanup of the tempfile on any failure path.
 */
function updateEnvFile(envPath: string, updates: Record<string, string>): void {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    content = `# === ${APP_NAME} Configuration ===\n`;
  }

  // Refuse to overwrite a symlink at the final path. The legacy
  // `writeFileSync` would follow the symlink and write to its target;
  // `renameSync` does NOT follow symlinks and would replace the symlink
  // itself. Surfacing this as an error keeps the behavior change from
  // happening silently for any user who intentionally symlinked `.env`.
  // ENOENT is expected when `.env` doesn't exist yet — fall through.
  try {
    const stat = lstatSync(envPath);
    if (stat.isSymbolicLink()) {
      throw Object.assign(
        new Error(
          `env-writer: refusing to overwrite symlinked .env at ${envPath}. ` +
            `Resolve the symlink to the actual file the daemon should manage.`,
        ),
        { code: "EENV_TARGET_SYMLINK" },
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EENV_TARGET_SYMLINK") throw err;
    /* c8 ignore start — non-ENOENT lstat errors (EACCES, EIO) are rare;
       the rethrow is defensive. */
    if (code !== "ENOENT") throw err;
    /* c8 ignore stop */
  }

  // `.env` files edited in a Windows editor use CRLF line endings. Splitting
  // on bare `\n` keeps a trailing `\r` on every untouched line — the rewrite
  // then mixes line endings (LF on the keys we just replaced, CRLF on the
  // rest). `\r?\n` accepts both conventions, and re-joining with `\n` leaves
  // the output uniformly LF regardless of the host platform.
  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set<string>();

  const newLines = lines.map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (match) {
      const envKey = match[1];
      if (envKey in updates) {
        updatedKeys.add(envKey);
        return `${envKey}=${updates[envKey]}`;
      }
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      newLines.push(`${key}=${value}`);
    }
  }

  const finalContent = newLines.join("\n");
  // 64 bits of entropy in the temp suffix so a local attacker can't
  // pre-place a symlink at our temp path even with O_NOFOLLOW (defense
  // in depth — O_NOFOLLOW alone would catch the symlink at open time).
  const tmpPath = `${envPath}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  // O_NOFOLLOW is undefined on Windows; this is already safe because a bitwise
  // OR coerces `undefined` to 0 (ToInt32(undefined) === 0) — macOS/Linux get
  // the symlink-refusal flag, Windows contributes nothing.
  const flags =
    fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_NOFOLLOW;

  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, flags, 0o600);
    const buf = Buffer.from(finalContent, "utf-8");
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    // fsync the file content before close so the bytes are durable
    // before the rename. Without this, a crash between rename and the
    // kernel's writeback could leave envPath pointing at an inode whose
    // blocks are still in page cache.
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, envPath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore — best-effort cleanup */
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore — tmp may not exist or rename already consumed it */
    }
    throw err;
  }

  try {
    // Defensive re-chmod after rename. `openSync(..., 0o600)` already
    // applied the mode at creation time, but the rename inherits the
    // tempfile's mode and we want belt-and-suspenders for platforms
    // where umask or filesystem ACLs might still surprise. Best-effort.
    ensureEnvFilePermissions(envPath);
  } catch {
    // Best-effort.
  }
}

export interface ConfigUpdateResult {
  updated: string[];
  requiresRestart: string[];
  errors: Record<string, string>;
}

export interface ApplyConfigUpdatesOptions {
  /**
   * SQLite handle. Required for the §6.2 Note Sources side-effect — when
   * `externalObsidianVaultPath` / `externalObsidianWatch` lands in the
   * patch, `applyConfigUpdates` re-renders `<dataDir>/integrations.md`
   * via `writeManagementMd(dataDir, readIntegrations(db), {...})` so the
   * section never drifts. Callers without a DB (test harnesses, the
   * boot-time owner-id pairing in `index.ts`) may omit this — Note
   * Sources keys never appear on those paths, so the regeneration is a
   * no-op anyway.
   */
  db?: Database.Database;
}

export async function applyConfigUpdates(
  config: AgentConfig,
  settingsStore: SettingsStore,
  updates: Record<string, unknown>,
  options: ApplyConfigUpdatesOptions = {},
): Promise<ConfigUpdateResult> {
  const result: ConfigUpdateResult = {
    updated: [],
    requiresRestart: [],
    errors: {},
  };

  const runtimeUpdates: Record<string, unknown> = {};
  const bootstrapConfigUpdates: Record<string, unknown> = {};
  const envUpdates: Record<string, string> = {};
  const currentRuntimeSettings = pickRuntimeSettings(config);

  const aliasedUpdates: Record<string, unknown> = { ...updates };

  // Management Mode Phase 2 — steer callers away from bypassing the
  // migration endpoint. `vaultMode` and `primaryVaultPath` both control
  // where the primary context directory lives; editing either via
  // PATCH /api/config without moving the files strands data in the old
  // location and breaks subsequent reads. Callers must go through
  // `POST /api/setup/migrate-context`, which runs the move + DB rewrite +
  // settings update atomically.
  //
  // `primaryVaultName` is just a display string — still allowed here.
  const MIGRATION_ONLY_KEYS = new Set(["vaultMode", "primaryVaultPath"]);

  for (const [key, value] of Object.entries(aliasedUpdates)) {
    if (MIGRATION_ONLY_KEYS.has(key)) {
      result.errors[key] =
        `Field "${key}" may only be changed via POST /api/setup/migrate-context (Management Mode Phase 2).`;
      continue;
    }

    const editable =
      isEditableRuntimeKey(key)
      || isEditableBootstrapKey(key);
    if (!editable) {
      if (SECRET_KEYS.has(key as never)) {
        result.errors[key] =
          "Secret fields have moved to PUT /api/secrets/* — please reload the dashboard.";
        continue;
      }
      result.errors[key] = `Field "${key}" is not editable via dashboard`;
      continue;
    }

    const currentValue = (config as Record<string, unknown>)[key];
    if (currentValue !== undefined && currentValue !== null) {
      const currentType = Array.isArray(currentValue) ? "array" : typeof currentValue;
      const newType = Array.isArray(value) ? "array" : typeof value;
      if (currentType !== newType && value !== null && value !== "") {
        result.errors[key] = `Type mismatch: expected ${currentType}, got ${newType}`;
        continue;
      }
    }

    const range = NUMERIC_RANGE[key];
    if (range && typeof value === "number") {
      if (value < range.min || value > range.max) {
        result.errors[key] = `Value must be ${range.label}`;
        continue;
      }
    }

    const numericEnum = NUMERIC_ENUM[key];
    if (numericEnum && typeof value === "number") {
      if (!numericEnum.values.includes(value)) {
        result.errors[key] = `Value ${numericEnum.label}`;
        continue;
      }
    }

    const stringValidator = STRING_VALIDATORS[key];
    if (stringValidator && typeof value === "string") {
      const error = stringValidator(value);
      if (error) {
        result.errors[key] = error;
        continue;
      }
    }

    const arrayValidator = ARRAY_VALIDATORS[key];
    if (arrayValidator && Array.isArray(value)) {
      const error = arrayValidator(value);
      if (error) {
        result.errors[key] = error;
        continue;
      }
    }

    let processedValue: unknown = value;
    if (key === "externalObsidianVaultPath" && typeof value === "string" && value) {
      const validation = validateExternalObsidianVaultPath(value, {
        dataDir: config.dataDir,
        primaryVaultPath: config.primaryVaultPath,
      });
      if (!validation.ok) {
        result.errors[key] = validation.message ?? "Invalid external Obsidian vault path";
        continue;
      }
      processedValue = expandHomePreservingRelative(value);
    }
    if (key === "primaryVaultPath" && typeof value === "string" && value) {
      const validation = validatePrimaryVaultPath(value, {
        dataDir: config.dataDir,
      });
      if (!validation.ok) {
        result.errors[key] = validation.message ?? "Invalid primary vault path";
        continue;
      }
      processedValue = expandHomePreservingRelative(value);
    }
    if (key === "whatsappAuthDir" && typeof value === "string" && value) {
      processedValue = expandHome(value);
    }
    if (key === "agentDisplayName" && typeof value === "string") {
      processedValue = normalizeAgentDisplayName(value);
    }
    // gitRepos / gitWatchedRepos / githubRepos were removed at the
    // unified-repositories cutover; their data lives in the
    // `repositories` DB table now (see
    // docs/design/appendices/unified-repositories.md). The PATCH path
    // intentionally cannot edit them — use POST /api/repositories instead.

    if (isEditableRuntimeKey(key)) {
      const candidateRuntimeState = {
        ...currentRuntimeSettings,
        ...runtimeUpdates,
        [key]: processedValue,
      };
      const validated = runtimeSettingsSchema.safeParse(candidateRuntimeState);
      if (!validated.success) {
        const matchingIssue = validated.error.issues.find(
          (issue) => issue.path[0] === key,
        );
        result.errors[key] = matchingIssue?.message ?? "Invalid value";
        continue;
      }
      runtimeUpdates[key] = validated.data[key];
    } else {
      const bootstrapError = validateBootstrapValue(key, processedValue);
      if (bootstrapError) {
        result.errors[key] = bootstrapError;
        continue;
      }
      bootstrapConfigUpdates[key] = processedValue;
      const envKey = CONFIG_TO_ENV[key];
      if (!envKey) {
        result.errors[key] = `Unknown config key: ${key}`;
        continue;
      }
      envUpdates[envKey] = serializeForEnv(processedValue);
    }

    result.updated.push(key);
    if (isRestartRequiredKey(key)) {
      result.requiresRestart.push(key);
    }
  }

  settingsStore.transaction(() => {
    if (Object.keys(runtimeUpdates).length > 0) {
      settingsStore.setMany(runtimeUpdates as Parameters<SettingsStore["setMany"]>[0]);
    }

    if (Object.keys(envUpdates).length > 0) {
      updateEnvFile(getEnvFilePath(), envUpdates);
    }
  });

  Object.assign(config, runtimeUpdates);
  Object.assign(config, bootstrapConfigUpdates);

  // SETUP-FLOW-REDESIGN-PLAN §6.2 — single chokepoint for Note Sources
  // regeneration. Centralizing it here means *any* future caller of
  // `applyConfigUpdates` carrying these keys gets a fresh render rather
  // than silently skipping. The dashboard PATCH /api/config handler used
  // to duplicate this hook inline; it now relies on this trigger.
  // Self-write suppression in `markSelfWrite` prevents the chokidar
  // feedback loop. Best-effort: failures log and move on so a transient
  // filesystem hiccup never strands the user's config write.
  if (options.db && result.updated.some((k) => NOTE_SOURCES_KEYS.has(k))) {
    try {
      const { writeManagementMd } = await import("../core/management-md.js");
      const { readIntegrations } = await import("../db/integrations-store.js");
      await writeManagementMd(
        config.dataDir,
        readIntegrations(options.db),
        {
          externalObsidianVaultPath: config.externalObsidianVaultPath,
          externalObsidianWatch: config.externalObsidianWatch,
        },
      );
    } catch (err) {
      logger.warn(
        { err },
        "writeManagementMd failed after Note Sources config change",
      );
    }
  }

  return result;
}

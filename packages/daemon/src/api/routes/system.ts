import { Hono } from "hono";
import type { ApiDependencies } from "../server.js";
import {
  factoryReset,
  purgeHistory,
  resetRuntimeConfig,
  wipeContextFiles,
} from "../../core/system-reset.js";
import { executeReinstall, planReinstall } from "../../core/reinstall.js";
import {
  getContextDir,
  loadDefaultRuntimeSettings,
  pickRuntimeSettings,
} from "../../config.js";
import { PlatformSecretStore } from "../../secrets/platform-secret-store.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import {
  clearDegradedMode,
  clearSetupCompleted,
} from "../../db/runtime-state.js";
import { pickDirectory } from "../directory-picker.js";
import { readJsonBody } from "../json-body.js";

const logger = createLogger("api:system");
const MAX_PICKER_TITLE_LENGTH = 120;
const MAX_PICKER_DEFAULT_PATH_LENGTH = 4096;

function resetContextDirs(config: ApiDependencies["config"]): string[] {
  return [
    // The configured/effective target. In Obsidian mode this is the primary
    // vault even if runtime settings are about to be reset.
    getContextDir(config),
    // The plain fallback can contain old setup markers from pre-migration or
    // degraded-mode runs; wipe it too so a reset really returns to setup.
    getContextDir({ dataDir: config.dataDir }),
  ];
}

function hasBlockingFactoryResetFailure(result: Awaited<ReturnType<typeof factoryReset>>): boolean {
  if (result.remainingTables.length > 0 || result.remainingSearchIndexes.length > 0) {
    return true;
  }
  const warningOnlySteps = new Set(["clear_secrets"]);
  return result.errors.some((error) => !warningOnlySteps.has(error.step));
}

export function createSystemRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;

  const applyRuntimeDefaults = (): void => {
    Object.assign(config, loadDefaultRuntimeSettings());
  };

  app.post("/system/reset-config", (c) => {
    const result = resetRuntimeConfig({
      db,
      dataDir: config.dataDir,
      applyDefaults: applyRuntimeDefaults,
    });
    return c.json({
      status: "reset",
      cleared: result.cleared,
      runtimeSettings: pickRuntimeSettings(config),
    });
  });

  app.post("/system/purge-history", (c) => {
    const result = purgeHistory({ db, dataDir: config.dataDir });
    return c.json({ status: "purged", ...result });
  });

  app.post("/system/wipe-context", (c) => {
    const result = wipeContextFiles({
      dataDir: config.dataDir,
      contextDirs: resetContextDirs(config),
    });
    if (result.errors.length > 0) {
      return c.json({ status: "wipe_failed", ...result }, 500);
    }
    clearSetupCompleted(db);
    clearDegradedMode(db);
    return c.json({ status: "wiped", ...result });
  });

  app.post("/system/pick-directory", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as {
      title?: unknown;
      defaultPath?: unknown;
    };

    if (body.title !== undefined && typeof body.title !== "string") {
      return c.json(
        {
          error: "invalid_request",
          message: "title must be a string when provided.",
        },
        400,
      );
    }
    if (
      typeof body.title === "string"
      && body.title.length > MAX_PICKER_TITLE_LENGTH
    ) {
      return c.json(
        {
          error: "invalid_request",
          message: `title must be ${MAX_PICKER_TITLE_LENGTH} characters or fewer.`,
        },
        400,
      );
    }
    if (
      body.defaultPath !== undefined
      && typeof body.defaultPath !== "string"
    ) {
      return c.json(
        {
          error: "invalid_request",
          message: "defaultPath must be a string when provided.",
        },
        400,
      );
    }
    if (
      typeof body.defaultPath === "string"
      && body.defaultPath.length > MAX_PICKER_DEFAULT_PATH_LENGTH
    ) {
      return c.json(
        {
          error: "invalid_request",
          message: `defaultPath must be ${MAX_PICKER_DEFAULT_PATH_LENGTH} characters or fewer.`,
        },
        400,
      );
    }

    const result = await pickDirectory({
      title: body.title,
      defaultPath: body.defaultPath,
    });
    return c.json(result);
  });

  // B-007 §7 — clean reinstall planner. Enumerates what would be removed
  // so the dashboard can surface a confirmation screen ("N files, M bytes,
  // K snapshot rows"). Side-effect free.
  app.get("/system/reinstall-context/plan", (c) => {
    const plan = planReinstall({ contextDir: getContextDir(config), db });
    return c.json({
      contextDir: plan.contextDir,
      fileCount: plan.filesToDelete.length,
      totalBytes: plan.totalBytes,
      snapshotRowCount: plan.snapshotRowCount,
      backupPath: plan.backupPath,
      ancillaryDirs: plan.ancillaryDirs,
    });
  });

  // B-007 §7 — executes the clean reinstall. Must only be reached after the
  // dashboard captures the "CLEAN" confirmation string (validated here
  // as well). Writes a tarball safety backup, wipes context/, and clears
  // md_file_snapshots. Other SQLite tables are preserved.
  app.post("/system/reinstall-context", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      confirm?: string;
    };
    if (body.confirm !== "CLEAN") {
      return c.json(
        {
          error: "confirmation_required",
          message: 'Submit { "confirm": "CLEAN" } to execute the reinstall.',
        },
        400,
      );
    }
    try {
      const result = await executeReinstall({
        contextDir: getContextDir(config),
        db,
      });
      logger.info({ result }, "Context directory reinstalled");
      return c.json({ status: "reinstalled", restartRequired: true, ...result });
    } catch (err) {
      logger.error({ err }, "Reinstall failed");
      return c.json(
        {
          error: "reinstall_failed",
          message: toSafeErrorMessage(err, "unknown"),
        },
        500,
      );
    }
  });

  app.post("/system/factory-reset", async (c) => {
    try {
      const result = await factoryReset({
        db,
        dataDir: config.dataDir,
        contextDirs: resetContextDirs(config),
        secretBroker: deps.secretBroker,
        // The keychain's internal master blob key lives under names that
        // aren't exposed through SecretBroker. A fresh PlatformSecretStore
        // talks to the same keychain, so this reaches the hidden name
        // without widening the broker's surface.
        secretStore: new PlatformSecretStore(),
        applyDefaults: applyRuntimeDefaults,
      });
      // Fan out a secret-changed signal so running adapters drop their
      // cached tokens immediately instead of waiting for the user to
      // restart. `restartRequired: true` still stands — observers and
      // keyed services only fully re-bootstrap on startup — but this
      // prevents an adapter from fighting with now-empty credentials.
      //
      // `handleSecretChange` dispatches per-scope, so iterate over every
      // known scope rather than passing a single fake "factory-reset" name
      // that falls through to the default/no-op branch. The list mirrors
      // every secret family in `SECRET_NAMES` that owns a live service /
      // adapter the daemon holds in memory; `apple_calendar` is included
      // so `services.appleCalendar` drops its iCloud-connected reference
      // when the credentials blob gets wiped (otherwise the slot would
      // stay populated until the operator restarts).
      const scopes = [
        "slack",
        "telegram",
        "discord",
        "notion",
        "github",
        "google",
        "apple_calendar",
      ];
      const adapterReloadErrors: Array<{ scope: string; message: string }> = [];
      for (const scope of scopes) {
        try {
          await deps.onSecretChanged?.(scope);
        } catch (err) {
          adapterReloadErrors.push({ scope, message: toSafeErrorMessage(err, "unknown") });
          logger.warn({ err, scope }, "Adapter reload failed during factory reset");
        }
      }
      const resetIncomplete = result.errors.length > 0 || result.remainingTables.length > 0 ||
        result.remainingSearchIndexes.length > 0;
      const resetBlocked = hasBlockingFactoryResetFailure(result);
      const detail = result.errors
        .slice(0, 3)
        .map((error) => `${error.step}: ${error.message}`)
        .join("; ");
      return c.json({
        status: resetIncomplete ? "reset_with_errors" : "reset",
        ...(resetIncomplete
          ? {
            error: "factory_reset_incomplete",
            message: detail
              ? `Factory reset completed with warnings: ${detail}`
              : "Factory reset completed with warnings.",
          }
          : {}),
        restartRequired: true,
        adapterReloadErrors,
        ...result,
      }, resetBlocked ? 500 : 200);
    } catch (err) {
      logger.error({ err }, "Factory reset failed");
      return c.json(
        { error: "factory_reset_failed", message: toSafeErrorMessage(err, "unknown") },
        500,
      );
    }
  });

  return app;
}

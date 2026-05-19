/**
 * Codex CLI's Azure OpenAI mode requires a `[model_providers.azure]`
 * block in `config.toml` — env vars alone cannot configure it. To honor
 * the env-mirror chokepoint without trampling the operator's personal
 * `~/.codex/` configuration, the daemon writes a managed config.toml to
 * `<PA_DATA_DIR>/codex-home/config.toml` and points `CODEX_HOME` at that
 * directory for spawned codex subprocesses.
 *
 * The user's `~/.codex/` is never touched.
 *
 * Lifecycle:
 *   - On startup / sync with an `azure-openai` config: ensure the dir
 *     exists, write/refresh config.toml (chmod 0600), set `CODEX_HOME`.
 *   - On clear / switch to direct openai: remove the file (best-effort)
 *     and unset `CODEX_HOME` so codex falls back to `~/.codex/`.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildCodexAzureConfigToml,
  type AzureOpenAiApiKeyConfig,
} from "@aitne/shared";
import { createLogger } from "../logging.js";

const logger = createLogger("codex-home-materializer");

/** Subdirectory under `PA_DATA_DIR` that holds the managed `config.toml`. */
const CODEX_HOME_SUBDIR = "codex-home";

/** Resolve the path the daemon manages for codex Azure config. */
export function resolveCodexHomePath(dataDir: string): string {
  return join(dataDir, CODEX_HOME_SUBDIR);
}

/**
 * Write `config.toml` to the managed `CODEX_HOME` directory and return
 * the directory path. Idempotent — safe to call on every sync.
 *
 * Sets file permissions to 0600 because the file embeds the
 * `AZURE_OPENAI_API_KEY` env-key reference (not the key itself, but the
 * config still expresses production routing — treat as sensitive).
 */
export function materializeCodexAzureConfig(
  dataDir: string,
  config: AzureOpenAiApiKeyConfig,
): string {
  const home = resolveCodexHomePath(dataDir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // mkdirSync's mode arg is ignored on existing dirs (POSIX semantics);
  // re-chmod to be safe across re-runs is unnecessary here because the
  // directory only contains daemon-managed files.
  const tomlPath = join(home, "config.toml");
  writeFileSync(tomlPath, buildCodexAzureConfigToml(config), {
    mode: 0o600,
  });
  logger.info(
    { path: tomlPath, deploymentName: config.deploymentName ?? null },
    "Materialized Codex Azure config.toml",
  );
  return home;
}

/**
 * Remove the managed `config.toml` file (and its parent dir if empty).
 * Best-effort: missing-file is fine, permission errors are logged but
 * not thrown.
 */
export function clearCodexAzureConfig(dataDir: string): void {
  const home = resolveCodexHomePath(dataDir);
  const tomlPath = join(home, "config.toml");
  try {
    rmSync(tomlPath, { force: true });
  } catch (err) {
    logger.warn({ err, path: tomlPath }, "Failed to remove config.toml");
    return;
  }
  // Try to remove the dir if it became empty. `rmSync` without
  // `recursive: true` throws on non-empty dirs — we swallow that case
  // because future iterations may drop other managed files (auth.json,
  // sessions/, etc.) into the same directory and we don't want to
  // delete them. Missing-dir also throws and is equally fine.
  try {
    rmSync(home, { recursive: false });
  } catch {
    // Non-empty or already-gone — both fine.
  }
}

/**
 * Sandbox-asset installer.
 *
 * The bundled `agent-assets/sandbox/macos/aitne-chromium.sb` template
 * contains two placeholders (`%binary_path%`, `%user_data_dir%`) that
 * must be substituted with absolute paths before `sandbox-exec` will
 * load the profile. Substitution is done once at install time and the
 * result is written to `<PA_DATA_DIR>/sandbox/aitne-chromium.sb`,
 * which `resolveSandboxPrimitive` then references through
 * `SandboxPrimitive.profilePath`.
 *
 * Idempotent: re-runs overwrite the installed file in-place so binary
 * upgrades (e.g. user reinstalls Chromium under a new path) propagate
 * the next time the bootstrap or supervisor runs.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandboxPrimitive } from "../types.js";
import { createLogger } from "../../../logging.js";

const logger = createLogger("managed-chromium-sandbox-install");

export interface SandboxInstallContext {
  /** Absolute path under PA_DATA_DIR where the installed profile lands. */
  paDataDir: string;
  /** Resolved Chromium binary path. */
  binaryPath: string;
  /** Resolved per-instance user data dir. */
  userDataDir: string;
}

const ASSET_ROOT_FROM_DIST = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "agent-assets",
  "sandbox",
);

/**
 * Install / refresh the macOS sandbox-exec profile. Returns the
 * absolute path of the rendered file so the caller can plug it into
 * `SandboxPrimitive.profilePath`. No-op on non-darwin platforms.
 */
export async function installSandboxExecProfile(
  ctx: SandboxInstallContext,
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("installSandboxExecProfile is darwin-only");
  }
  const templatePath = join(ASSET_ROOT_FROM_DIST, "macos", "aitne-chromium.sb");
  const template = await readFile(templatePath, "utf8");
  const rendered = template
    .replaceAll("%binary_path%", ctx.binaryPath)
    .replaceAll("%user_data_dir%", ctx.userDataDir);
  const outDir = join(ctx.paDataDir, "sandbox");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "aitne-chromium.sb");
  await writeFile(outPath, rendered, { mode: 0o600 });
  logger.info(
    { outPath },
    "installed sandbox-exec profile",
  );
  return outPath;
}

/**
 * Resolve the sandbox primitive into a launch-ready shape:
 *   - macOS: copy the .sb template with placeholders substituted and
 *     return a primitive whose `profilePath` references the rendered
 *     file under PA_DATA_DIR/sandbox/.
 *   - Linux / Windows / none: pass through unchanged (the launcher's
 *     argv builders consume the same shape they had on input).
 */
export async function materialiseSandboxPrimitive(
  raw: SandboxPrimitive,
  ctx: SandboxInstallContext,
): Promise<SandboxPrimitive> {
  if (raw.kind === "sandbox-exec") {
    const profilePath = await installSandboxExecProfile(ctx);
    return { kind: "sandbox-exec", profilePath };
  }
  return raw;
}

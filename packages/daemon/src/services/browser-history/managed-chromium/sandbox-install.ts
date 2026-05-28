/**
 * Sandbox-asset installer.
 *
 * The bundled `agent-assets/sandbox/macos/aitne-chromium.sb` template
 * contains four placeholders (`%binary_path%`, `%binary_bundle%`,
 * `%user_data_dir%`, `%ancestor_metadata_literals%`) that must be
 * substituted with install-time-resolved values before `sandbox-exec`
 * will load the profile. Substitution is done once at install time and
 * the result is written to `<PA_DATA_DIR>/sandbox/aitne-chromium.sb`,
 * which `resolveSandboxPrimitive` then references through
 * `SandboxPrimitive.profilePath`.
 *
 * Idempotent: re-runs overwrite the installed file in-place so binary
 * upgrades (e.g. user reinstalls Chromium under a new path, or a
 * Playwright bump moves chromium-NNNN to chromium-NNNN+1) propagate
 * the next time the bootstrap or supervisor runs.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandboxPrimitive } from "../types.js";
import { createLogger } from "../../../logging.js";
import { chromiumBundleRoot } from "../lifecycle/platform.js";

const logger = createLogger("managed-chromium-sandbox-install");

/**
 * Compute the chain of directory ancestors of an absolute path, from
 * the top-level component down to (but excluding) the path itself and
 * excluding `/`. For `/a/b/c` returns `["/a", "/a/b"]`. Used to emit
 * one `(literal ...)` per ancestor under `(allow file-read-metadata
 * ...)` so the sandboxed child can traverse to `%binary_bundle%` /
 * `%user_data_dir%` — required on macOS 26+ where `(subpath ...)` no
 * longer implicitly grants metadata on parents.
 */
export function pathAncestors(absolutePath: string): string[] {
  if (!absolutePath.startsWith("/")) {
    throw new Error(
      `pathAncestors expects an absolute POSIX path, got: ${absolutePath}`,
    );
  }
  const parts = absolutePath.split("/").filter((segment) => segment.length > 0);
  if (parts.length <= 1) return [];
  parts.pop();
  const out: string[] = [];
  let acc = "";
  for (const segment of parts) {
    acc = `${acc}/${segment}`;
    out.push(acc);
  }
  return out;
}

/**
 * Escape a path for embedding inside a sandbox profile double-quoted
 * `(literal "...")` form. macOS sandbox profile strings support
 * backslash-escaped `"` and `\`. POSIX paths almost never contain
 * either, but escape defensively so a Playwright cache dir with an
 * adversarial name cannot break out of the literal.
 */
export function escapeSandboxLiteral(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Render the `%ancestor_metadata_literals%` substitution block: the
 * deduped + sorted union of `pathAncestors(...)` across the supplied
 * paths, one indented `(literal "...")` per line. If the union is
 * empty (every input was at the filesystem root) we emit a single
 * `(literal "/")` so the `(allow file-read-metadata ...)` form stays
 * syntactically valid — granting metadata on `/` is redundant with
 * the existing `file-read*` rule, so this is a safe no-op.
 */
export function renderAncestorMetadataLiterals(
  paths: readonly string[],
  indent = "  ",
): string {
  const set = new Set<string>();
  for (const p of paths) {
    for (const a of pathAncestors(p)) set.add(a);
  }
  const sorted = [...set].sort();
  const lines = sorted.length === 0 ? ["/"] : sorted;
  return lines
    .map((p) => `${indent}(literal "${escapeSandboxLiteral(p)}")`)
    .join("\n");
}

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
  const bundle = chromiumBundleRoot(ctx.binaryPath);
  const ancestorLiterals = renderAncestorMetadataLiterals([
    bundle,
    ctx.userDataDir,
  ]);
  const rendered = template
    .replaceAll("%binary_path%", escapeSandboxLiteral(ctx.binaryPath))
    .replaceAll("%binary_bundle%", escapeSandboxLiteral(bundle))
    .replaceAll("%user_data_dir%", escapeSandboxLiteral(ctx.userDataDir))
    .replaceAll("%ancestor_metadata_literals%", ancestorLiterals);
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

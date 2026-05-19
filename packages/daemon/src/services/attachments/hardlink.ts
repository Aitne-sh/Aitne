import { linkSync, copyFileSync, existsSync, statSync } from "node:fs";
import { createLogger } from "../../logging.js";

const logger = createLogger("attachments-hardlink");

/** Per-(src-volume, dst-volume) pair log dedup — one warning per pair. */
const loggedEXDEVPairs = new Set<string>();

function deviceOf(path: string): number | null {
  try {
    return statSync(path).dev;
  } catch {
    return null;
  }
}

/**
 * Try `linkSync(src, dst)`; on EXDEV / ENOTSUP fall back to `copyFileSync`.
 * Idempotent: if `dst` already exists and points at the same inode as
 * `src`, this is a no-op; if `dst` exists with a different inode the
 * call is also a no-op (caller owns the destination — we only put the
 * file there once per turn per safe_filename). Log once per volume pair.
 */
export function hardLinkOrCopy(src: string, dst: string): void {
  if (existsSync(dst)) {
    try {
      const srcStat = statSync(src);
      const dstStat = statSync(dst);
      if (srcStat.ino === dstStat.ino && srcStat.dev === dstStat.dev) {
        return;
      }
    } catch {
      // fall through and accept the existing dst
    }
    return;
  }

  try {
    linkSync(src, dst);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "ENOTSUP" && code !== "EPERM") {
      throw err;
    }

    const pairKey = `${deviceOf(src) ?? "?"}->${deviceOf(dst) ?? "?"}`;
    if (!loggedEXDEVPairs.has(pairKey)) {
      loggedEXDEVPairs.add(pairKey);
      logger.info(
        { src, dst, code, pair: pairKey },
        "hard-link across volumes not supported — falling back to copy",
      );
    }
    copyFileSync(src, dst);
  }
}

/** Test-only reset hook. */
export function resetHardLinkLogCache(): void {
  loggedEXDEVPairs.clear();
}

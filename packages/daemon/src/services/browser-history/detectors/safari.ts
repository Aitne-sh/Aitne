import { access, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BrowserDetectionResult, HostProfile } from "../types.js";
import { createBrowserHistorySnapshot } from "../readers/snapshot.js";
import { assertSafariHistorySchema } from "../readers/safari-reader.js";

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectSafari(
  host: HostProfile,
  cacheRoot: string,
): Promise<BrowserDetectionResult> {
  if (host.os !== "darwin") {
    return { browser: "safari", status: "safari_not_applicable", profiles: [] };
  }

  const historyPath = join(homedir(), "Library/Safari/History.db");
  if (!existsSync(historyPath)) {
    return { browser: "safari", status: "not_installed", profiles: [] };
  }
  if (!(await canRead(historyPath))) {
    return { browser: "safari", status: "fda_required", profiles: [] };
  }

  try {
    const historyStat = await stat(historyPath);
    const snapshot = await createBrowserHistorySnapshot(historyPath, cacheRoot);
    try {
      assertSafariHistorySchema(snapshot.mainPath);
    } finally {
      await snapshot.cleanup();
    }
    return {
      browser: "safari",
      status: "available_no_sync",
      profiles: [
        {
          browser: "safari",
          profileName: "Default",
          userDataDir: join(homedir(), "Library/Safari"),
          historyPath,
          signedIn: false,
          canonical: true,
          lastHistoryMtimeMs: historyStat.mtimeMs,
        },
      ],
    };
  } catch (err) {
    return {
      browser: "safari",
      status: "error",
      profiles: [],
      error: err instanceof Error ? err.message : "Safari detection failed",
    };
  }
}

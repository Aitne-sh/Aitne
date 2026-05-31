import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BrowserHistoryDetectionStatus } from "@aitne/shared";
import type {
  BrowserDetectionResult,
  BrowserProfileCandidate,
  ChromiumBrowserKey,
  HostProfile,
} from "../types.js";
import { createBrowserHistorySnapshot } from "../readers/snapshot.js";
import { assertChromiumHistorySchema } from "../readers/chromium-reader.js";
import { freshestHistoryMtimeMs } from "../history-mtime.js";

interface LocalStateProfileInfo {
  user_name?: string;
  name?: string;
}

interface LocalStateShape {
  profile?: {
    info_cache?: Record<string, LocalStateProfileInfo>;
  };
  signin?: {
    allowed_username?: string;
    signed_in_to?: string;
  };
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readLocalState(path: string): Promise<LocalStateShape | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LocalStateShape;
  } catch {
    return null;
  }
}

function isSignedIn(
  localState: LocalStateShape | null,
  profileName: string,
): boolean {
  const profile = localState?.profile?.info_cache?.[profileName];
  return !!(
    profile?.user_name
    || localState?.signin?.allowed_username
    || localState?.signin?.signed_in_to
  );
}

async function enumerateProfileNames(
  root: string,
  localState: LocalStateShape | null,
): Promise<string[]> {
  const fromLocalState = Object.keys(localState?.profile?.info_cache ?? {});
  const names = new Set(fromLocalState);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name === "Default"
        || /^Profile \d+$/.test(entry.name)
        || existsSync(join(root, entry.name, "History"))
      ) {
        names.add(entry.name);
      }
    }
  } catch {
    // Caller handles the root-level access failure.
  }
  return [...names];
}

function detectStatusFromProfiles(
  profiles: BrowserProfileCandidate[],
  hadSchemaError: boolean,
): BrowserHistoryDetectionStatus {
  if (profiles.length === 0) return hadSchemaError ? "error" : "not_installed";
  if (profiles.some((profile) => profile.signedIn)) {
    const now = Date.now();
    const stale = profiles.every((profile) =>
      profile.lastHistoryMtimeMs !== null
      && now - profile.lastHistoryMtimeMs > 24 * 60 * 60 * 1000,
    );
    return stale ? "available_sync_broken" : "available";
  }
  return "available_no_sync";
}

async function validateHistory(
  historyPath: string,
  cacheRoot: string,
): Promise<boolean> {
  const snapshot = await createBrowserHistorySnapshot(historyPath, cacheRoot);
  try {
    assertChromiumHistorySchema(snapshot.mainPath);
    return true;
  } finally {
    await snapshot.cleanup();
  }
}

export async function detectChromiumBrowser(
  browser: ChromiumBrowserKey,
  host: HostProfile,
  cacheRoot: string,
): Promise<BrowserDetectionResult> {
  let sawPermissionDenied = false;
  let sawSchemaError = false;
  const profiles: BrowserProfileCandidate[] = [];

  for (const root of host.profileRootCandidatesFor(browser)) {
    if (!existsSync(root)) continue;
    if (!(await canRead(root))) {
      sawPermissionDenied = true;
      continue;
    }

    const localStatePath = join(root, "Local State");
    const localState = await readLocalState(localStatePath);
    const names = await enumerateProfileNames(root, localState);
    for (const profileName of names) {
      const historyPath = join(root, profileName, "History");
      if (!existsSync(historyPath)) continue;
      if (!(await canRead(historyPath))) {
        sawPermissionDenied = true;
        continue;
      }
      let historyStat;
      try {
        historyStat = await stat(historyPath);
      } catch {
        continue;
      }
      if (!historyStat.isFile() || historyStat.size === 0) continue;
      try {
        await validateHistory(historyPath, cacheRoot);
      } catch {
        sawSchemaError = true;
        continue;
      }
      profiles.push({
        browser,
        profileName,
        userDataDir: root,
        historyPath,
        localStatePath,
        signedIn: isSignedIn(localState, profileName),
        canonical: true,
        // Family-aware mtime — see history-mtime.ts. Stat'ing only
        // `History` misses WAL writes and rollback-journal transactions
        // and would mark actively-used profiles as `available_sync_broken`.
        lastHistoryMtimeMs: (await freshestHistoryMtimeMs(historyPath)) ?? historyStat.mtimeMs,
      });
    }
  }

  // Atlas stores real browsing under per-account `user-<id>__<uuid>`
  // profile dirs. The `Default` (and `Profile N`) dirs are vestigial stubs
  // created on first launch and abandoned the moment the user signs into
  // their ChatGPT account; the stub's `History` then freezes forever. The
  // generic enumeration above picks up BOTH the stub and the live account
  // profile (the latter via the `existsSync(History)` clause), so the
  // lifecycle supervisor ends up tracking the frozen stub too — emitting a
  // perpetual `browser_lifecycle.atlas` / `sync_unresponsive` failure every
  // tick because the stub's mtime never advances. Drop the stubs whenever a
  // live account profile is present so only real profiles are reported.
  if (browser === "atlas") {
    const accountProfiles = profiles.filter((profile) =>
      profile.profileName.startsWith("user-"),
    );
    if (accountProfiles.length > 0 && accountProfiles.length !== profiles.length) {
      profiles.splice(0, profiles.length, ...accountProfiles);
    }
  }

  if (profiles.length === 0 && browser === "atlas") {
    const atlasProfiles = await detectAtlasFallback(host, cacheRoot);
    profiles.push(...atlasProfiles);
  }

  if (profiles.length === 0 && sawPermissionDenied) {
    return { browser, status: "permission_denied", profiles };
  }

  return {
    browser,
    status: detectStatusFromProfiles(profiles, sawSchemaError),
    profiles,
    nonCanonicalLayout: profiles.some((profile) => !profile.canonical),
  };
}

async function detectAtlasFallback(
  host: HostProfile,
  cacheRoot: string,
): Promise<BrowserProfileCandidate[]> {
  const found: BrowserProfileCandidate[] = [];
  for (const root of host.profileRootCandidatesFor("atlas")) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("user-")) continue;
      const candidate = join(root, entry.name, "History");
      if (!existsSync(candidate)) continue;
      try {
        const historyStat = await stat(candidate);
        if (!historyStat.isFile() || historyStat.size === 0) continue;
        await validateHistory(candidate, cacheRoot);
        found.push({
          browser: "atlas",
          profileName: basename(dirname(candidate)),
          userDataDir: dirname(candidate),
          historyPath: candidate,
          signedIn: false,
          canonical: false,
          lastHistoryMtimeMs: (await freshestHistoryMtimeMs(candidate)) ?? historyStat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }
  return found;
}

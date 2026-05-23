import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBrowserProfileHealth } from "./health-check.js";
import type {
  BrowserProfileCandidate,
  HostProfile,
} from "../types.js";

function makeHost(overrides: Partial<HostProfile> = {}): HostProfile {
  return {
    os: "darwin",
    hasDisplay: true,
    sandboxPrimitive: { kind: "none" },
    browserBinaryFor: () => "/Applications/Chrome.app/Contents/MacOS/Chrome",
    profileRootFor: () => null,
    profileRootCandidatesFor: () => [],
    isProcessRunning: async () => false,
    terminate: async () => {},
    ...overrides,
  };
}

function makeProfile(
  historyPath: string,
  browser: BrowserProfileCandidate["browser"] = "chrome",
): BrowserProfileCandidate {
  return {
    browser,
    profileName: "Default",
    userDataDir: "/tmp/userdata",
    historyPath,
    signedIn: false,
    canonical: true,
    lastHistoryMtimeMs: null,
  };
}

describe("checkBrowserProfileHealth", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pa-bh-health-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns running=true when isProcessRunning resolves true", async () => {
    const history = join(root, "History");
    writeFileSync(history, "ignored");
    const host = makeHost({ isProcessRunning: async () => true });

    const result = await checkBrowserProfileHealth(host, makeProfile(history));

    expect(result.running).toBe(true);
    expect(result.historyMtimeMs).toBeGreaterThan(0);
    expect(result.stale).toBe(false);
  });

  it("returns running=false when isProcessRunning resolves false", async () => {
    const history = join(root, "History");
    writeFileSync(history, "ignored");
    const host = makeHost({ isProcessRunning: async () => false });

    const result = await checkBrowserProfileHealth(host, makeProfile(history));

    expect(result.running).toBe(false);
  });

  it("returns running=false when browserBinaryFor returns null (no binary)", async () => {
    const history = join(root, "History");
    writeFileSync(history, "ignored");
    const host = makeHost({
      browserBinaryFor: () => null,
      isProcessRunning: async () => true, // never reached
    });

    const result = await checkBrowserProfileHealth(host, makeProfile(history));

    expect(result.running).toBe(false);
  });

  it("yields historyMtimeMs=null and syncAgeSeconds=null when history file is missing", async () => {
    const host = makeHost();
    const missing = join(root, "does-not-exist");

    const result = await checkBrowserProfileHealth(host, makeProfile(missing));

    expect(result.historyMtimeMs).toBeNull();
    expect(result.syncAgeSeconds).toBeNull();
    expect(result.stale).toBe(false);
  });

  it("flags stale=true when syncAgeSeconds exceeds 24h", async () => {
    const history = join(root, "History");
    writeFileSync(history, "ignored");
    // Set mtime to 25h ago
    const oldSec = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    utimesSync(history, oldSec, oldSec);
    const host = makeHost();

    const result = await checkBrowserProfileHealth(host, makeProfile(history));

    expect(result.stale).toBe(true);
    expect(result.syncAgeSeconds).toBeGreaterThan(24 * 60 * 60);
  });

  it("clamps syncAgeSeconds to >= 0 when nowMs is earlier than mtime (clock skew)", async () => {
    const history = join(root, "History");
    writeFileSync(history, "ignored");
    const host = makeHost();

    // Pass a nowMs in the past, so (now - mtimeMs) is negative
    const result = await checkBrowserProfileHealth(host, makeProfile(history), 0);

    expect(result.syncAgeSeconds).toBe(0);
    expect(result.stale).toBe(false);
  });

  // SQLite-WAL mode (Chromium's default) routes writes through the
  // sibling `History-wal` file and only advances the main `History`
  // file's mtime on checkpoint — for low-activity profiles, that can
  // mean days. Stat'ing only `History` would mis-flag such a profile
  // as stale even though the user is actively browsing.
  it("uses History-wal mtime when newer than History", async () => {
    const history = join(root, "History");
    const wal = join(root, "History-wal");
    writeFileSync(history, "ignored");
    writeFileSync(wal, "ignored");
    // History 30h old, WAL 1h old
    const nowSec = Math.floor(Date.now() / 1000);
    utimesSync(history, nowSec - 30 * 60 * 60, nowSec - 30 * 60 * 60);
    utimesSync(wal, nowSec - 60 * 60, nowSec - 60 * 60);
    const host = makeHost();

    const result = await checkBrowserProfileHealth(host, makeProfile(history));

    expect(result.stale).toBe(false);
    expect(result.syncAgeSeconds).toBeLessThan(2 * 60 * 60);
  });

  // SQLite rollback-journal mode (used by some Chromium forks and
  // post-corruption fallbacks): a long-lived transaction keeps
  // `History-journal` present and recently touched while `History`
  // mtime is held fixed at the last commit. Journal presence + recent
  // mtime is the right freshness signal there.
  it("uses History-journal mtime when newer than History", async () => {
    const history = join(root, "History");
    const journal = join(root, "History-journal");
    writeFileSync(history, "ignored");
    writeFileSync(journal, "ignored");
    const nowSec = Math.floor(Date.now() / 1000);
    utimesSync(history, nowSec - 40 * 60 * 60, nowSec - 40 * 60 * 60);
    utimesSync(journal, nowSec - 30 * 60, nowSec - 30 * 60);
    const host = makeHost();

    const result = await checkBrowserProfileHealth(host, makeProfile(history));

    expect(result.stale).toBe(false);
    expect(result.syncAgeSeconds).toBeLessThan(60 * 60);
  });

  it("stays stale when History, History-wal, and History-journal are all > 24h old", async () => {
    const history = join(root, "History");
    const wal = join(root, "History-wal");
    const journal = join(root, "History-journal");
    writeFileSync(history, "ignored");
    writeFileSync(wal, "ignored");
    writeFileSync(journal, "ignored");
    const oldSec = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    utimesSync(history, oldSec, oldSec);
    utimesSync(wal, oldSec - 60 * 60, oldSec - 60 * 60);
    utimesSync(journal, oldSec - 30 * 60, oldSec - 30 * 60);
    const host = makeHost();

    const result = await checkBrowserProfileHealth(host, makeProfile(history));

    expect(result.stale).toBe(true);
  });

  it("picks the freshest mtime across History / History-wal / History-journal", async () => {
    const history = join(root, "History");
    const wal = join(root, "History-wal");
    const journal = join(root, "History-journal");
    writeFileSync(history, "ignored");
    writeFileSync(wal, "ignored");
    writeFileSync(journal, "ignored");
    const nowSec = Math.floor(Date.now() / 1000);
    utimesSync(history, nowSec - 10 * 60 * 60, nowSec - 10 * 60 * 60);
    utimesSync(wal, nowSec - 5 * 60 * 60, nowSec - 5 * 60 * 60);
    utimesSync(journal, nowSec - 2 * 60 * 60, nowSec - 2 * 60 * 60);
    const host = makeHost();

    const result = await checkBrowserProfileHealth(host, makeProfile(history));

    expect(result.syncAgeSeconds).toBeGreaterThanOrEqual(2 * 60 * 60 - 1);
    expect(result.syncAgeSeconds).toBeLessThan(2 * 60 * 60 + 60);
  });
});

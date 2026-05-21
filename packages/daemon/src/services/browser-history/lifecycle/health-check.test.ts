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
});

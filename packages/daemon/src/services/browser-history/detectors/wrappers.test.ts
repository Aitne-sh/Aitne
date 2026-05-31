import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { detectAtlas } from "./atlas.js";
import { detectChrome } from "./chrome.js";
import { detectComet } from "./comet.js";
import type { HostProfile } from "../types.js";

function makeHost(): HostProfile {
  return {
    os: "darwin",
    hasDisplay: true,
    sandboxPrimitive: { kind: "none" },
    browserBinaryFor: () => null,
    profileRootFor: () => null,
    profileRootCandidatesFor: () => [], // no profile roots → not_installed
    isProcessRunning: async () => false,
    terminate: async () => {},
  };
}

// Minimal schema-valid Chromium `History` DB — enough for
// assertChromiumHistorySchema (urls + visits tables with the required
// columns) to accept it during detection.
function writeChromiumHistory(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER);
    INSERT INTO urls (id, url, title) VALUES (1, 'https://example.com', 'Example');
    INSERT INTO visits (id, url, visit_time, transition) VALUES (1, 1, 13300000000000000, 0);
  `);
  db.close();
}

function hostWithRoot(root: string): HostProfile {
  return { ...makeHost(), profileRootCandidatesFor: () => [root] };
}

describe("chromium-detector wrappers", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "pa-bh-wrappers-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("detectAtlas delegates to detectChromiumBrowser with browser='atlas'", async () => {
    const result = await detectAtlas(makeHost(), cacheRoot);
    expect(result.browser).toBe("atlas");
    expect(result.status).toBe("not_installed");
  });

  it("detectChrome delegates with browser='chrome'", async () => {
    const result = await detectChrome(makeHost(), cacheRoot);
    expect(result.browser).toBe("chrome");
    expect(result.status).toBe("not_installed");
  });

  it("detectComet delegates with browser='comet'", async () => {
    const result = await detectComet(makeHost(), cacheRoot);
    expect(result.browser).toBe("comet");
    expect(result.status).toBe("not_installed");
  });

  // Regression: Atlas creates a `Default` stub on first launch and abandons
  // it once the user signs into their ChatGPT account, after which all
  // browsing lands in a `user-<id>__<uuid>` profile. The stub's History then
  // freezes forever and the lifecycle supervisor was emitting a perpetual
  // `browser_lifecycle.atlas` / `sync_unresponsive` failure every tick for it.
  it("detectAtlas drops the vestigial Default stub when a user- account profile exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bh-atlas-"));
    try {
      mkdirSync(join(root, "Default"));
      mkdirSync(join(root, "user-acct__uuid"));
      writeChromiumHistory(join(root, "Default", "History"));
      writeChromiumHistory(join(root, "user-acct__uuid", "History"));

      const result = await detectAtlas(hostWithRoot(root), cacheRoot);
      expect(result.profiles.map((profile) => profile.profileName)).toEqual([
        "user-acct__uuid",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detectAtlas keeps the Default profile when no user- account profile exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bh-atlas-"));
    try {
      mkdirSync(join(root, "Default"));
      writeChromiumHistory(join(root, "Default", "History"));

      const result = await detectAtlas(hostWithRoot(root), cacheRoot);
      expect(result.profiles.map((profile) => profile.profileName)).toEqual([
        "Default",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromiumBundleRoot,
  createHostProfile,
  darwinTahoeOrLater,
  singletonLockHasLiveOwner,
} from "./platform.js";

describe("singletonLockHasLiveOwner", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pa-bh-platform-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns true when SingletonLock points to a live PID", async () => {
    symlinkSync(`some-host-${process.pid}`, join(root, "SingletonLock"));
    expect(await singletonLockHasLiveOwner(root)).toBe(true);
  });

  it("returns false when SingletonLock points to a dead PID", async () => {
    // Pick a PID that cannot exist on this host. Linux + macOS both
    // allow PIDs up to ~4 million; 2^31 - 1 is well above any kernel
    // limit and `process.kill(pid, 0)` will ESRCH-throw.
    symlinkSync(`some-host-2147483646`, join(root, "SingletonLock"));
    expect(await singletonLockHasLiveOwner(root)).toBe(false);
  });

  it("returns false when SingletonLock target lacks a parseable PID", async () => {
    symlinkSync("garbage-no-suffix", join(root, "SingletonLock"));
    expect(await singletonLockHasLiveOwner(root)).toBe(false);
  });

  it("returns false when SingletonLock is a regular file, not a symlink", async () => {
    // Some Chromium variants write a regular file instead of a symlink.
    // `readlink` throws EINVAL on those; we should fall through.
    writeFileSync(join(root, "SingletonLock"), `some-host-${process.pid}`);
    expect(await singletonLockHasLiveOwner(root)).toBe(false);
  });

  it("returns false when SingletonLock does not exist", async () => {
    expect(await singletonLockHasLiveOwner(root)).toBe(false);
  });

  it("returns false when the user-data-dir itself does not exist", async () => {
    expect(await singletonLockHasLiveOwner(join(root, "missing"))).toBe(false);
  });
});

describe("chromiumBundleRoot", () => {
  // The function branches on `process.platform`; gate the macOS-specific
  // .app-walk assertions to darwin and assert the non-darwin dirname
  // fallback elsewhere. Both branches use only pure path arithmetic.
  if (process.platform === "darwin") {
    it("returns the nearest .app ancestor for a Playwright-cache binary", () => {
      const exe =
        "/Users/x/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
      expect(chromiumBundleRoot(exe)).toBe(
        "/Users/x/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app",
      );
    });

    it("returns the nearest .app ancestor for a system /Applications binary", () => {
      const exe = "/Applications/Chromium.app/Contents/MacOS/Chromium";
      expect(chromiumBundleRoot(exe)).toBe("/Applications/Chromium.app");
    });

    it("falls back to the parent dir on macOS when no .app ancestor exists", () => {
      // e.g. operator points us at a binary in /usr/local/bin/.
      const exe = "/usr/local/bin/chromium";
      expect(chromiumBundleRoot(exe)).toBe("/usr/local/bin");
    });
  } else {
    it("returns the parent dir on non-darwin platforms", () => {
      // Tested on the host's actual platform (linux/win32). The macOS
      // .app-walk branch is unreachable here and covered above.
      const exe = process.platform === "win32"
        ? "C:\\cache\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe"
        : "/home/x/.cache/ms-playwright/chromium-1223/chrome-linux/chrome";
      const expected = process.platform === "win32"
        ? "C:\\cache\\ms-playwright\\chromium-1223\\chrome-win64"
        : "/home/x/.cache/ms-playwright/chromium-1223/chrome-linux";
      expect(chromiumBundleRoot(exe)).toBe(expected);
    });
  }
});

describe("Comet profile-root candidates (regression)", () => {
  // Comet (Perplexity's Chromium fork) stored its user-data under the
  // wrong directory in the original metadata: one folder literally named
  // "Perplexity Comet". The real layout is vendorless "Comet" (macOS /
  // Linux) or "Perplexity\\Comet" (Windows vendor\\product). The old guess
  // matched nothing on disk, so detectChromiumBrowser reported Comet as
  // `not_installed`. These assertions are host-platform-gated like the
  // `chromiumBundleRoot` suite above.
  const candidates = createHostProfile().profileRootCandidatesFor("comet");

  it("never resolves the buggy single-folder 'Perplexity Comet' path", () => {
    for (const candidate of candidates) {
      expect(candidate).not.toMatch(/Perplexity Comet/);
    }
  });

  it("includes the correct vendorless Comet root for the host platform", () => {
    if (process.platform === "darwin") {
      expect(candidates).toContain(
        join(homedir(), "Library/Application Support/Comet"),
      );
    } else if (process.platform === "win32") {
      // %LOCALAPPDATA%\Comet\User Data and the vendor-prefixed variant.
      expect(candidates.some((c) => /[\\/]Comet[\\/]User Data$/.test(c))).toBe(true);
      expect(
        candidates.some((c) => /Perplexity[\\/]Comet[\\/]User Data$/.test(c)),
      ).toBe(true);
    } else {
      expect(candidates).toContain(join(homedir(), ".config/Comet"));
    }
  });
});

describe("darwinTahoeOrLater", () => {
  it("returns false on non-darwin platforms regardless of release string", () => {
    expect(darwinTahoeOrLater("linux", () => "6.5.0")).toBe(false);
    expect(darwinTahoeOrLater("win32", () => "26.0.0")).toBe(false);
    expect(darwinTahoeOrLater("freebsd", () => "99.9.9")).toBe(false);
  });

  it("returns false for darwin majors < 25 (macOS ≤ 15)", () => {
    expect(darwinTahoeOrLater("darwin", () => "22.6.0")).toBe(false); // macOS 13
    expect(darwinTahoeOrLater("darwin", () => "23.1.0")).toBe(false); // macOS 14
    expect(darwinTahoeOrLater("darwin", () => "24.0.0")).toBe(false); // macOS 15
  });

  it("returns true for darwin major 25 (macOS 26 Tahoe) and beyond", () => {
    expect(darwinTahoeOrLater("darwin", () => "25.0.0")).toBe(true);
    expect(darwinTahoeOrLater("darwin", () => "25.5.0")).toBe(true);
    expect(darwinTahoeOrLater("darwin", () => "26.1.0")).toBe(true);
    expect(darwinTahoeOrLater("darwin", () => "40.0.0")).toBe(true);
  });

  it("treats unparseable release strings as below the threshold", () => {
    expect(darwinTahoeOrLater("darwin", () => "")).toBe(false);
    expect(darwinTahoeOrLater("darwin", () => "garbage")).toBe(false);
  });
});

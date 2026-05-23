import { describe, expect, it } from "vitest";

import type { HostProfile } from "../types.js";
import {
  __testing,
  buildAuthBootstrapArgs,
  buildBootstrapArgs,
  buildInstanceSConfig,
  instanceSProfileDir,
} from "./supervisor-config.js";

function fakeHost(opts: {
  binary: string | null;
  sandboxKind?: HostProfile["sandboxPrimitive"]["kind"];
}): HostProfile {
  return {
    os: "darwin",
    hasDisplay: true,
    sandboxPrimitive: opts.sandboxKind === "sandbox-exec"
      ? { kind: "sandbox-exec", profilePath: "/PA/sandbox/profile.sb" }
      : { kind: opts.sandboxKind ?? "none" } as HostProfile["sandboxPrimitive"],
    browserBinaryFor: () => opts.binary,
    profileRootFor: () => null,
    profileRootCandidatesFor: () => [],
    isProcessRunning: async () => false,
    terminate: async () => {},
  };
}

describe("buildInstanceSConfig", () => {
  it("returns null when no Chromium binary is available", () => {
    const cfg = buildInstanceSConfig({
      host: fakeHost({ binary: null }),
      paDataDir: "/PA",
      sandbox: { kind: "none" },
    });
    expect(cfg).toBeNull();
  });

  it("packs the expected argv and per-instance user-data-dir", () => {
    const cfg = buildInstanceSConfig({
      host: fakeHost({ binary: "/Applications/Chromium.app/Contents/MacOS/Chromium" }),
      paDataDir: "/PA",
      sandbox: { kind: "sandbox-exec", profilePath: "/PA/sandbox/profile.sb" },
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.binaryPath).toContain("Chromium");
    expect(cfg?.userDataDir).toBe(instanceSProfileDir("/PA"));
    expect(cfg?.extraArgs).toContain("--remote-debugging-port=0");
    expect(cfg?.extraArgs).toContain("--headless=new");
    expect(cfg?.extraArgs).toContain(`--user-data-dir=${instanceSProfileDir("/PA")}`);
  });
});

describe("buildBootstrapArgs", () => {
  it("includes --app=<signInUrl> + reuses user data dir", () => {
    const argv = buildBootstrapArgs("/PA/chromium-sync", "https://example.com/signin");
    expect(argv).toContain("--user-data-dir=/PA/chromium-sync");
    expect(argv).toContain("--app=https://example.com/signin");
    expect(argv).not.toContain("--headless=new");
  });
});

describe("__testing.BOOTSTRAP_UI_FLAGS", () => {
  it("forbids CDP exposure on the bootstrap window", () => {
    expect(__testing.BOOTSTRAP_UI_FLAGS).toContain("--remote-debugging-port=0");
  });
});

describe("buildAuthBootstrapArgs", () => {
  it("opens the per-site sign-in URL in a chromeless UI window", () => {
    const argv = buildAuthBootstrapArgs({
      perSiteProfileDir: "/PA/chromium-automation-auth/amazon_jp",
      signInUrl: "https://www.amazon.co.jp/ap/signin",
      cdpPort: 54321,
    });
    expect(argv).toContain(
      "--user-data-dir=/PA/chromium-automation-auth/amazon_jp",
    );
    expect(argv).toContain("--app=https://www.amazon.co.jp/ap/signin");
    expect(argv).not.toContain("--headless=new");
  });

  it("overrides BOOTSTRAP_UI_FLAGS' --remote-debugging-port=0 with the caller's port", () => {
    const argv = buildAuthBootstrapArgs({
      perSiteProfileDir: "/PA/chromium-automation-auth/amazon_jp",
      signInUrl: "https://www.amazon.co.jp/ap/signin",
      cdpPort: 54321,
    });
    // Both entries appear; Chromium honours the last value, so the
    // assertion is positional rather than uniqueness.
    const disabledIdx = argv.indexOf("--remote-debugging-port=0");
    const enabledIdx = argv.indexOf("--remote-debugging-port=54321");
    expect(disabledIdx).toBeGreaterThanOrEqual(0);
    expect(enabledIdx).toBeGreaterThan(disabledIdx);
  });

  it("pins remote-debugging-address to loopback (defence-in-depth)", () => {
    const argv = buildAuthBootstrapArgs({
      perSiteProfileDir: "/PA/auth/amazon_jp",
      signInUrl: "https://amazon.co.jp/",
      cdpPort: 1,
    });
    expect(argv).toContain("--remote-debugging-address=127.0.0.1");
  });
});

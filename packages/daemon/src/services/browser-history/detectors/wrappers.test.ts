import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});

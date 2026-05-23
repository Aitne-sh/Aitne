import { describe, expect, it } from "vitest";

import {
  anonProfileDir,
  authProfileDir,
  buildInstanceAAnonArgs,
  buildInstanceAAuthArgs,
  INSTANCE_A_SHARED_FLAGS,
} from "./instance-a-config.js";

describe("instance-a-config", () => {
  describe("INSTANCE_A_SHARED_FLAGS", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(INSTANCE_A_SHARED_FLAGS)).toBe(true);
    });

    it("forces headless mode (no UI window)", () => {
      expect(INSTANCE_A_SHARED_FLAGS).toContain("--headless=new");
    });

    it("disables high-value attack surface", () => {
      expect(INSTANCE_A_SHARED_FLAGS).toContain("--disable-extensions");
      expect(INSTANCE_A_SHARED_FLAGS).toContain("--disable-plugins");
      expect(INSTANCE_A_SHARED_FLAGS).toContain("--disable-default-apps");
      expect(INSTANCE_A_SHARED_FLAGS).toContain("--disable-component-update");
      expect(INSTANCE_A_SHARED_FLAGS).toContain("--no-first-run");
      expect(INSTANCE_A_SHARED_FLAGS).toContain("--no-default-browser-check");
      expect(INSTANCE_A_SHARED_FLAGS).toContain("--no-experiments");
    });

    it("turns off the talkative feature set explicitly", () => {
      const features = INSTANCE_A_SHARED_FLAGS.find((f) =>
        f.startsWith("--disable-features="),
      );
      expect(features).toBeTruthy();
      expect(features).toContain("AutofillServerCommunication");
      expect(features).toContain("Translate");
      expect(features).toContain("MediaRouter");
    });

    it("pins remote-debugging-address to loopback (defence-in-depth)", () => {
      expect(INSTANCE_A_SHARED_FLAGS).toContain("--remote-debugging-address=127.0.0.1");
    });

    it("does NOT include --remote-debugging-port (per-workflow only)", () => {
      // The port is per-launch (kernel-assigned); SHARED_FLAGS must not pin it.
      for (const flag of INSTANCE_A_SHARED_FLAGS) {
        expect(flag.startsWith("--remote-debugging-port=")).toBe(false);
      }
    });
  });

  describe("anonProfileDir", () => {
    it("builds per-workflow profile dirs under chromium-automation-anon/", () => {
      const dir = anonProfileDir("/PA", "abc-123");
      expect(dir).toBe("/PA/chromium-automation-anon/abc-123");
    });
  });

  describe("buildInstanceAAnonArgs", () => {
    it("includes the shared flags + per-workflow CDP port + user-data-dir", () => {
      const args = buildInstanceAAnonArgs({
        paDataDir: "/PA",
        workflowId: "wfid",
        cdpPort: 54321,
      });
      expect(args).toContain("--headless=new");
      expect(args).toContain("--remote-debugging-port=54321");
      expect(args).toContain("--user-data-dir=/PA/chromium-automation-anon/wfid");
    });

    it("returns a frozen array (defence against runtime mutation)", () => {
      const args = buildInstanceAAnonArgs({
        paDataDir: "/PA",
        workflowId: "wfid",
        cdpPort: 1,
      });
      expect(Object.isFrozen(args)).toBe(true);
    });

    it("puts --user-data-dir last so sandbox writable-binding lines up", () => {
      const args = buildInstanceAAnonArgs({
        paDataDir: "/PA",
        workflowId: "wfid",
        cdpPort: 1,
      });
      expect(args[args.length - 1]).toBe(
        "--user-data-dir=/PA/chromium-automation-anon/wfid",
      );
    });
  });

  describe("authProfileDir", () => {
    it("builds per-site profile dirs under chromium-automation-auth/", () => {
      const dir = authProfileDir("/PA", "amazon_jp");
      expect(dir).toBe("/PA/chromium-automation-auth/amazon_jp");
    });

    it("rejects siteKeys that fail the naming-convention regex", () => {
      expect(() => authProfileDir("/PA", "../etc")).toThrowError(
        /violates naming convention/,
      );
      expect(() => authProfileDir("/PA", "Amazon")).toThrowError(
        /violates naming convention/,
      );
      expect(() => authProfileDir("/PA", "")).toThrowError(
        /violates naming convention/,
      );
      expect(() => authProfileDir("/PA", "amazon/jp")).toThrowError(
        /violates naming convention/,
      );
    });
  });

  describe("buildInstanceAAuthArgs", () => {
    it("includes the shared flags + per-launch CDP port + per-site user-data-dir", () => {
      const args = buildInstanceAAuthArgs({
        paDataDir: "/PA",
        siteKey: "amazon_jp",
        cdpPort: 54321,
      });
      expect(args).toContain("--headless=new");
      expect(args).toContain("--remote-debugging-port=54321");
      expect(args).toContain("--user-data-dir=/PA/chromium-automation-auth/amazon_jp");
    });

    it("returns a frozen array (defence against runtime mutation)", () => {
      const args = buildInstanceAAuthArgs({
        paDataDir: "/PA",
        siteKey: "amazon_jp",
        cdpPort: 1,
      });
      expect(Object.isFrozen(args)).toBe(true);
    });

    it("puts --user-data-dir last so sandbox writable-binding lines up", () => {
      const args = buildInstanceAAuthArgs({
        paDataDir: "/PA",
        siteKey: "amazon_jp",
        cdpPort: 1,
      });
      expect(args[args.length - 1]).toBe(
        "--user-data-dir=/PA/chromium-automation-auth/amazon_jp",
      );
    });

    it("rejects a bogus siteKey via authProfileDir", () => {
      expect(() =>
        buildInstanceAAuthArgs({
          paDataDir: "/PA",
          siteKey: "../etc",
          cdpPort: 1,
        }),
      ).toThrowError(/violates naming convention/);
    });
  });
});

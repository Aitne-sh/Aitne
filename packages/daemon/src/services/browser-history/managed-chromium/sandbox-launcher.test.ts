import { describe, expect, it } from "vitest";

import { __testing } from "./sandbox-launcher.js";

const { buildSandboxExecArgs, buildBwrapArgs, buildSystemdRunArgs } = __testing;

describe("buildSandboxExecArgs", () => {
  it("emits -f <profilePath> <binary> [...args]", () => {
    const argv = buildSandboxExecArgs("/PA/sandbox/profile.sb", {
      binary: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      args: ["--headless=new", "--user-data-dir=/PA/chromium-sync"],
    });
    expect(argv).toEqual([
      "-f",
      "/PA/sandbox/profile.sb",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "--headless=new",
      "--user-data-dir=/PA/chromium-sync",
    ]);
  });

  it("throws when profile path is empty", () => {
    expect(() =>
      buildSandboxExecArgs("", { binary: "/bin/false", args: [] }),
    ).toThrowError(/profile path is empty/);
  });
});

describe("buildBwrapArgs", () => {
  it("emits a deny-by-default argv with explicit binds and -- separator", () => {
    const argv = buildBwrapArgs({
      binary: "/usr/bin/chromium",
      args: ["--headless=new"],
      writableBindings: ["/home/u/.personal-agent/chromium-sync"],
      readableBindings: ["/usr/lib/chromium"],
    });
    // Spot-check core invariants.
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain("--new-session");
    expect(argv).toContain("--unshare-all");
    expect(argv).toContain("--share-net");
    // Writable / readable user bindings appear.
    expect(argv.join(" ")).toContain("--bind-try /home/u/.personal-agent/chromium-sync /home/u/.personal-agent/chromium-sync");
    expect(argv.join(" ")).toContain("--ro-bind-try /usr/lib/chromium /usr/lib/chromium");
    // -- separator precedes the binary.
    const sepIdx = argv.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    expect(argv[sepIdx + 1]).toBe("/usr/bin/chromium");
    expect(argv[sepIdx + 2]).toBe("--headless=new");
  });
});

describe("buildSystemdRunArgs", () => {
  it("emits --user --scope with hardening properties + -- separator", () => {
    const argv = buildSystemdRunArgs({
      binary: "/usr/bin/chromium",
      args: ["--headless=new"],
      writableBindings: ["/home/u/.personal-agent/chromium-sync"],
      readableBindings: ["/usr/lib/chromium"],
    });
    expect(argv).toContain("--user");
    expect(argv).toContain("--scope");
    expect(argv).toContain("--quiet");
    expect(argv).toContain("--collect");
    expect(argv).toContain("--property=ProtectSystem=strict");
    expect(argv).toContain("--property=NoNewPrivileges=true");
    expect(argv.find((a) => a.startsWith("--property=ReadWritePaths="))).toMatch(
      /chromium-sync/,
    );
    expect(argv.find((a) => a.startsWith("--property=ReadOnlyPaths="))).toMatch(
      /chromium/,
    );
    const sepIdx = argv.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    expect(argv[sepIdx + 1]).toBe("/usr/bin/chromium");
    expect(argv[sepIdx + 2]).toBe("--headless=new");
  });

  it("skips ReadWritePaths / ReadOnlyPaths when no bindings supplied", () => {
    const argv = buildSystemdRunArgs({
      binary: "/usr/bin/chromium",
      args: [],
    });
    expect(
      argv.find((a) => a.startsWith("--property=ReadWritePaths=")),
    ).toBeUndefined();
    expect(
      argv.find((a) => a.startsWith("--property=ReadOnlyPaths=")),
    ).toBeUndefined();
  });
});

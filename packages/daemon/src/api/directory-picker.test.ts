import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDirectoryPickerCommand,
  findExecutableOnPath,
  pickDirectory,
} from "./directory-picker.js";

describe("findExecutableOnPath", () => {
  let dir: string;
  let exePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "picker-find-"));
    exePath = join(dir, "real-bin");
    writeFileSync(exePath, "#!/bin/sh\nexit 0\n");
    chmodSync(exePath, 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("locates an executable on PATH", () => {
    const found = findExecutableOnPath(["real-bin"], { PATH: dir });
    expect(found).toBe(exePath);
  });

  it("returns null when nothing in PATH matches any candidate", () => {
    const found = findExecutableOnPath(
      ["completely-nonexistent-bin-xyz"],
      { PATH: dir },
    );
    expect(found).toBeNull();
  });

  it("falls back to process.env when env is omitted", () => {
    expect(findExecutableOnPath(["definitely-not-a-real-binary-zzz"])).toBeNull();
  });

  it("ignores empty PATH segments", () => {
    const found = findExecutableOnPath(["real-bin"], { PATH: `::${dir}::` });
    expect(found).toBe(exePath);
  });

  it("returns null when PATH is undefined", () => {
    const found = findExecutableOnPath(["real-bin"], {});
    expect(found).toBeNull();
  });

  it("returns null on win32 when the candidate already has an extension (no PATHEXT branch)", () => {
    // Forces the `process.platform === "win32" && !/\.[A-Za-z0-9]+$/.test(name)`
    // false side. We can only exercise the win32 conditional via a name
    // that already carries an extension, since we cannot fake
    // process.platform from this test.
    const found = findExecutableOnPath(["thing.bat"], { PATH: dir });
    expect(found).toBeNull();
  });
});

describe("buildDirectoryPickerCommand", () => {
  it("builds a macOS osascript folder picker without shell interpolation", () => {
    const command = buildDirectoryPickerCommand(
      { title: 'Choose "Vault"' },
      { platform: "darwin" },
    );

    expect("unavailable" in command).toBe(false);
    if ("unavailable" in command) return;
    expect(command.command).toBe("osascript");
    expect(command.args).toHaveLength(2);
    expect(command.args[1]).toContain('Choose \\"Vault\\"');
  });

  it("falls back to default title when title is empty / whitespace", () => {
    const command = buildDirectoryPickerCommand(
      { title: "   " },
      { platform: "darwin" },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.args[1]).toContain("Choose folder");
  });

  it("includes the default location when defaultPath exists", () => {
    const command = buildDirectoryPickerCommand(
      { title: "T", defaultPath: tmpdir() },
      { platform: "darwin" },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.args[1]).toContain("default location");
    expect(command.args[1]).toContain(tmpdir());
  });

  it("falls back to the parent directory when defaultPath does not exist", () => {
    const command = buildDirectoryPickerCommand(
      { defaultPath: join(tmpdir(), "nonexistent-child-xyz") },
      { platform: "darwin" },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.args[1]).toContain(tmpdir());
  });

  it("expands ~/ home prefix in defaultPath", () => {
    const command = buildDirectoryPickerCommand(
      { defaultPath: "~/" },
      { platform: "darwin" },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.args[1]).toContain("default location");
  });

  it("expands Windows-style home prefix in defaultPath", () => {
    const command = buildDirectoryPickerCommand(
      { defaultPath: "~\\" },
      { platform: "darwin" },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.args[1]).toContain("default location");
  });

  it("ignores empty / whitespace defaultPath", () => {
    const command = buildDirectoryPickerCommand(
      { defaultPath: "   " },
      { platform: "darwin" },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.args[1]).not.toContain("default location");
  });

  it("ignores defaultPath whose parent also does not exist", () => {
    const command = buildDirectoryPickerCommand(
      { defaultPath: "/this/path/has/no/parent/either/here" },
      { platform: "darwin" },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.args[1]).not.toContain("default location");
  });

  it("builds a Windows PowerShell folder picker", () => {
    const command = buildDirectoryPickerCommand(
      { title: "Choose user's\nvault" },
      {
        platform: "win32",
        findExecutable: (names) =>
          names.includes("powershell.exe") ? "C:\\Windows\\System32\\powershell.exe" : null,
      },
    );

    expect("unavailable" in command).toBe(false);
    if ("unavailable" in command) return;
    expect(command.command).toBe("powershell.exe");
    expect(command.args).toContain("-STA");
    expect(command.args.join(" ")).toContain("Choose user''s vault");
  });

  it("falls back to pwsh.exe when Windows PowerShell is missing", () => {
    const command = buildDirectoryPickerCommand(
      { title: "Choose folder" },
      {
        platform: "win32",
        findExecutable: (names) =>
          names.includes("pwsh.exe") ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null,
      },
    );

    expect("unavailable" in command).toBe(false);
    if ("unavailable" in command) return;
    expect(command.command).toBe("pwsh.exe");
    expect(command.method).toBe("powershell");
  });

  it("defaults to powershell.exe when neither shell is found on PATH", () => {
    // Surface a clear ENOENT at exec time (so the route returns
    // "unavailable") rather than silently using a non-existent pwsh.
    const command = buildDirectoryPickerCommand(
      { title: "Choose folder" },
      {
        platform: "win32",
        findExecutable: () => null,
      },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.command).toBe("powershell.exe");
  });

  it("includes SelectedPath on Windows when defaultPath exists", () => {
    const command = buildDirectoryPickerCommand(
      { defaultPath: tmpdir() },
      { platform: "win32" },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.args.join(" ")).toContain("SelectedPath");
  });

  it("uses zenity on Linux when available", () => {
    const command = buildDirectoryPickerCommand(
      { title: "Choose folder" },
      {
        platform: "linux",
        env: { DISPLAY: ":0" },
        findExecutable: (names) =>
          names.includes("zenity") ? "/usr/bin/zenity" : null,
      },
    );

    expect("unavailable" in command).toBe(false);
    if ("unavailable" in command) return;
    expect(command.command).toBe("/usr/bin/zenity");
    expect(command.method).toBe("zenity");
    expect(command.args).toContain("--directory");
  });

  it("accepts WAYLAND_DISPLAY in lieu of DISPLAY", () => {
    const command = buildDirectoryPickerCommand(
      {},
      {
        platform: "linux",
        env: { WAYLAND_DISPLAY: "wayland-0" },
        findExecutable: () => "/usr/bin/zenity",
      },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.method).toBe("zenity");
  });

  it("uses kdialog on Linux when zenity is missing", () => {
    const command = buildDirectoryPickerCommand(
      { defaultPath: tmpdir() },
      {
        platform: "linux",
        env: { DISPLAY: ":0" },
        findExecutable: (names) =>
          names.includes("kdialog") ? "/usr/bin/kdialog" : null,
      },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.method).toBe("kdialog");
    expect(command.args).toContain("--getexistingdirectory");
    expect(command.args).toContain(tmpdir());
  });

  it("uses yad on Linux when only yad is present", () => {
    const command = buildDirectoryPickerCommand(
      {},
      {
        platform: "linux",
        env: { DISPLAY: ":0" },
        findExecutable: (names) =>
          names.includes("yad") ? "/usr/bin/yad" : null,
      },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    expect(command.method).toBe("yad");
    expect(command.args).toContain("--file-selection");
  });

  it("falls back to home dir when no defaultPath", () => {
    const command = buildDirectoryPickerCommand(
      {},
      {
        platform: "linux",
        env: { DISPLAY: ":0" },
        findExecutable: () => "/usr/bin/zenity",
      },
    );
    if ("unavailable" in command) throw new Error("unexpected unavailable");
    const filename = command.args.find((a) => a.startsWith("--filename="));
    expect(filename).toBeDefined();
  });

  it("reports unavailable on Linux when no picker tool is installed", () => {
    const command = buildDirectoryPickerCommand(
      {},
      {
        platform: "linux",
        env: { DISPLAY: ":0" },
        findExecutable: () => null,
      },
    );
    expect("unavailable" in command).toBe(true);
    if (!("unavailable" in command)) return;
    expect(command.unavailable).toMatch(/zenity, kdialog, or yad/);
  });

  it("reports Linux picker unavailability without a graphical session", () => {
    const command = buildDirectoryPickerCommand(
      { title: "Choose folder" },
      { platform: "linux", env: {} },
    );

    expect(command).toEqual({
      unavailable:
        "No graphical desktop session is available for opening a folder picker.",
    });
  });

  it("defaults options.platform to process.platform when omitted (?? branch)", () => {
    // Omits both options.platform AND options.env so the function
    // falls through `?? process.platform` and `?? process.env` —
    // verifies the function still returns a command shape on the
    // test host's actual platform (any of darwin/win32/linux/etc).
    const command = buildDirectoryPickerCommand({ title: "anywhere" });
    expect("unavailable" in command || typeof (command as { command?: string }).command === "string").toBe(true);
  });

  it("defaults options.findExecutable to findExecutableOnPath on win32 (?? branch)", () => {
    // Omits findExecutable so the win32 path runs through
    // `?? findExecutableOnPath`. On a posix CI runner, the production
    // probe will not find `powershell.exe` and we fall through to the
    // hardcoded default — but the `?? findExecutableOnPath` left-side
    // unreachability is the only thing we are exercising here.
    const command = buildDirectoryPickerCommand(
      { title: "win-default" },
      { platform: "win32", env: { PATH: "" } },
    );
    expect("unavailable" in command).toBe(false);
    if ("unavailable" in command) return;
    expect(command.command).toBe("powershell.exe");
  });

  it("defaults options.findExecutable to findExecutableOnPath on linux (?? branch)", () => {
    // Linux path — omit findExecutable; production probe returns null
    // for every candidate on a clean env, and the function reports
    // unavailable. We are only asserting the `?? findExecutableOnPath`
    // fallback is exercised, not the resulting status.
    const command = buildDirectoryPickerCommand(
      { title: "linux-default" },
      { platform: "linux", env: { DISPLAY: ":0", PATH: "" } },
    );
    expect("unavailable" in command).toBe(true);
  });

  it("reports unavailable for unsupported platforms", () => {
    const command = buildDirectoryPickerCommand(
      {},
      { platform: "aix" },
    );
    expect("unavailable" in command).toBe(true);
    if (!("unavailable" in command)) return;
    expect(command.unavailable).toContain("aix");
  });
});

describe("pickDirectory (mocked runner)", () => {
  it("returns the selected path from command stdout", async () => {
    const result = await pickDirectory({
      platform: "linux",
      env: { DISPLAY: ":0" },
      findExecutable: () => "/usr/bin/zenity",
      runner: async () => ({
        code: 0,
        stdout: "/tmp/my-vault/\n",
        stderr: "",
        timedOut: false,
      }),
    });

    expect(result).toEqual({
      status: "selected",
      path: "/tmp/my-vault",
      method: "zenity",
    });
  });

  it("treats an empty successful result as cancellation", async () => {
    const result = await pickDirectory({
      platform: "win32",
      runner: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });

    expect(result.status).toBe("cancelled");
    expect(result.method).toBe("powershell");
  });

  it("returns the unavailable status without invoking the runner", async () => {
    let runnerCalls = 0;
    const result = await pickDirectory({
      platform: "linux",
      env: {},
      runner: async () => {
        runnerCalls += 1;
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect(result.status).toBe("unavailable");
    expect(runnerCalls).toBe(0);
  });

  it("reports ENOENT errors as unavailable with a friendly message", async () => {
    const err: NodeJS.ErrnoException = new Error("not found");
    err.code = "ENOENT";
    const result = await pickDirectory({
      platform: "darwin",
      runner: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: err,
      }),
    });
    expect(result.status).toBe("unavailable");
    expect(result.method).toBe("osascript");
    expect(result.message).toContain("osascript");
  });

  it("reports other spawn errors with the underlying message", async () => {
    const err: NodeJS.ErrnoException = new Error("permission denied");
    err.code = "EACCES";
    const result = await pickDirectory({
      platform: "darwin",
      runner: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: err,
      }),
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("permission denied");
  });

  it("reports timeouts as unavailable", async () => {
    const result = await pickDirectory({
      platform: "darwin",
      timeoutMs: 50,
      runner: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Folder picker timed out.");
  });

  it("treats osascript user-cancellation stderr as cancelled", async () => {
    const result = await pickDirectory({
      platform: "darwin",
      runner: async () => ({
        code: 1,
        stdout: "",
        stderr: "User canceled.",
        timedOut: false,
      }),
    });
    expect(result.status).toBe("cancelled");
    expect(result.method).toBe("osascript");
  });

  it("treats zenity exit-code-1 with empty stdout as cancellation", async () => {
    const result = await pickDirectory({
      platform: "linux",
      env: { DISPLAY: ":0" },
      findExecutable: () => "/usr/bin/zenity",
      runner: async () => ({
        code: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(result.status).toBe("cancelled");
    expect(result.method).toBe("zenity");
  });

  it("treats kdialog exit-code-1 with empty stdout as cancellation", async () => {
    const result = await pickDirectory({
      platform: "linux",
      env: { DISPLAY: ":0" },
      findExecutable: (names) =>
        names.includes("kdialog") ? "/usr/bin/kdialog" : null,
      runner: async () => ({
        code: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(result.status).toBe("cancelled");
    expect(result.method).toBe("kdialog");
  });

  it("treats yad exit-code-1 with empty stdout as cancellation", async () => {
    const result = await pickDirectory({
      platform: "linux",
      env: { DISPLAY: ":0" },
      findExecutable: (names) =>
        names.includes("yad") ? "/usr/bin/yad" : null,
      runner: async () => ({
        code: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(result.status).toBe("cancelled");
    expect(result.method).toBe("yad");
  });

  it("does not treat zenity exit-code-1 with stdout as cancellation", async () => {
    const result = await pickDirectory({
      platform: "linux",
      env: { DISPLAY: ":0" },
      findExecutable: () => "/usr/bin/zenity",
      runner: async () => ({
        code: 1,
        stdout: "/tmp/something",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toMatch(/Folder picker failed/);
  });

  it("reports non-zero exits with the stderr detail", async () => {
    const result = await pickDirectory({
      platform: "darwin",
      runner: async () => ({
        code: 2,
        stdout: "",
        stderr: "  syntax error  ",
        timedOut: false,
      }),
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Folder picker failed: syntax error");
  });

  it("falls back to exit code when stderr is empty", async () => {
    const result = await pickDirectory({
      platform: "darwin",
      runner: async () => ({
        code: 7,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(result.message).toBe("Folder picker failed: exit code 7");
  });

  it("treats whitespace-only stdout on success as cancellation", async () => {
    const result = await pickDirectory({
      platform: "darwin",
      runner: async () => ({
        code: 0,
        stdout: "   \n",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(result.status).toBe("cancelled");
  });

  it("strips trailing path separators except the root", async () => {
    const result = await pickDirectory({
      platform: "darwin",
      runner: async () => ({
        code: 0,
        stdout: "/Users/me/vault///\n",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(result).toEqual({
      status: "selected",
      path: "/Users/me/vault",
      method: "osascript",
    });
  });
});

describe("pickDirectory — runCommand integration (real subprocess)", () => {
  let scriptDir: string;

  beforeAll(() => {
    scriptDir = mkdtempSync(join(tmpdir(), "picker-script-"));
  });

  afterAll(() => {
    rmSync(scriptDir, { recursive: true, force: true });
  });

  it("invokes the real subprocess and parses its stdout (close path)", async () => {
    const fakePicker = join(scriptDir, "fake-picker");
    writeFileSync(
      fakePicker,
      "#!/bin/sh\nprintf '/tmp/from-real-subprocess\\n'\n",
    );
    chmodSync(fakePicker, 0o755);

    const result = await pickDirectory({
      platform: "linux",
      env: { DISPLAY: ":0", PATH: scriptDir },
      findExecutable: (names) => (names.includes("zenity") ? fakePicker : null),
    });

    expect(result.status).toBe("selected");
    expect(result.path).toBe("/tmp/from-real-subprocess");
    expect(result.method).toBe("zenity");
  });

  it("reports ENOENT when the spawned binary does not exist", async () => {
    const result = await pickDirectory({
      platform: "linux",
      env: { DISPLAY: ":0" },
      findExecutable: (names) =>
        names.includes("zenity")
          ? join(scriptDir, "absolutely-not-a-real-binary-here")
          : null,
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toMatch(/not available on this machine/);
  });

  it("reports timeout when the subprocess exceeds the deadline", async () => {
    const slowPicker = join(scriptDir, "slow-picker");
    writeFileSync(slowPicker, "#!/bin/sh\nsleep 5\n");
    chmodSync(slowPicker, 0o755);

    const result = await pickDirectory({
      platform: "linux",
      env: { DISPLAY: ":0", PATH: scriptDir },
      findExecutable: (names) => (names.includes("zenity") ? slowPicker : null),
      timeoutMs: 50,
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Folder picker timed out.");
  });
});

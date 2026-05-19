import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execWithStdinMock = vi.fn();

vi.mock("./exec-with-stdin.js", () => ({
  execWithStdin: execWithStdinMock,
}));

describe("WindowsDpapiSecretClient", () => {
  let tempDir: string;

  function makeTempDir(): string {
    tempDir = mkdtempSync(join(tmpdir(), "win-secret-test-"));
    return tempDir;
  }

  beforeEach(() => {
    vi.resetModules();
    execWithStdinMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("set() calls PowerShell with value on stdin and writes .dpapi file", async () => {
    const dir = makeTempDir();
    execWithStdinMock.mockResolvedValue({
      stdout: "01000000ENCRYPTED_HEX_DATA\n",
      stderr: "",
    });

    const { WindowsDpapiSecretClient } = await import("./secret-client-windows.js");
    const client = new WindowsDpapiSecretClient(dir);
    await client.set("apiToken", "my-secret-value");

    expect(execWithStdinMock).toHaveBeenCalledOnce();
    const [cmd, args, input, opts] = execWithStdinMock.mock.calls[0];
    expect(cmd).toBe("powershell.exe");
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", expect.any(String)]);
    expect(input).toBe("my-secret-value");
    expect(opts).toEqual({ timeout: 10_000 });

    const script: string = args[3];
    expect(script).toContain("ConvertTo-SecureString");
    expect(script).toContain("[System.Console]::In.ReadToEnd()");
    expect(script).not.toContain("TrimEnd");

    const filePath = join(dir, "apiToken.dpapi");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("01000000ENCRYPTED_HEX_DATA");
  });

  it("get() reads .dpapi file and decrypts via PowerShell", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "apiToken.dpapi"), "01000000ENCRYPTED_HEX_DATA", "utf-8");
    execWithStdinMock.mockResolvedValue({
      stdout: "decrypted-value\r\n",
      stderr: "",
    });

    const { WindowsDpapiSecretClient } = await import("./secret-client-windows.js");
    const client = new WindowsDpapiSecretClient(dir);
    const result = await client.get("apiToken");

    expect(result).toBe("decrypted-value");

    const [, , input] = execWithStdinMock.mock.calls[0];
    expect(input).toBe("01000000ENCRYPTED_HEX_DATA");

    const script: string = execWithStdinMock.mock.calls[0][1][3];
    expect(script).toContain("SecureStringToBSTR");
    expect(script).toContain("ZeroFreeBSTR");
  });

  it("get() returns null when .dpapi file does not exist", async () => {
    const dir = makeTempDir();

    const { WindowsDpapiSecretClient } = await import("./secret-client-windows.js");
    const client = new WindowsDpapiSecretClient(dir);
    const result = await client.get("nonexistent");

    expect(result).toBeNull();
    expect(execWithStdinMock).not.toHaveBeenCalled();
  });

  it("has() returns true when .dpapi file exists", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "slackBotToken.dpapi"), "encrypted", "utf-8");

    const { WindowsDpapiSecretClient } = await import("./secret-client-windows.js");
    const client = new WindowsDpapiSecretClient(dir);
    await expect(client.has("slackBotToken")).resolves.toBe(true);
  });

  it("has() returns false when .dpapi file is missing", async () => {
    const dir = makeTempDir();

    const { WindowsDpapiSecretClient } = await import("./secret-client-windows.js");
    const client = new WindowsDpapiSecretClient(dir);
    await expect(client.has("missing")).resolves.toBe(false);
  });

  it("delete() removes the .dpapi file", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "apiToken.dpapi");
    writeFileSync(filePath, "encrypted", "utf-8");

    const { WindowsDpapiSecretClient } = await import("./secret-client-windows.js");
    const client = new WindowsDpapiSecretClient(dir);
    await client.delete("apiToken");

    expect(existsSync(filePath)).toBe(false);
  });

  it("delete() is a no-op when file does not exist", async () => {
    const dir = makeTempDir();

    const { WindowsDpapiSecretClient } = await import("./secret-client-windows.js");
    const client = new WindowsDpapiSecretClient(dir);
    await expect(client.delete("nonexistent")).resolves.toBeUndefined();
  });

  it("rejects secret names with path separators", async () => {
    const dir = makeTempDir();

    const { WindowsDpapiSecretClient } = await import("./secret-client-windows.js");
    const client = new WindowsDpapiSecretClient(dir);
    await expect(client.get("../etc/passwd")).rejects.toThrow("Invalid secret name");
    await expect(client.set("foo\\bar", "val")).rejects.toThrow("Invalid secret name");
  });
});

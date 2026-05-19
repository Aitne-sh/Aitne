import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: Object.assign(
    (...args: Parameters<typeof execFileMock>) => execFileMock(...args),
    {
      [promisify.custom]: (
        file: string,
        args: string[],
        options: { encoding: string; timeout?: number },
      ) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(
            file,
            args,
            options,
            (error: Error | null, stdout = "", stderr = "") => {
              if (error) {
                reject(error);
                return;
              }
              resolve({ stdout, stderr });
            },
          );
        }),
    },
  ),
}));

describe("NativePersonalAgentKeychainClient", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("get() calls security find-generic-password -w and returns the value", async () => {
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        expect(file).toBe("security");
        expect(args).toContain("find-generic-password");
        expect(args).toContain("-w");
        expect(args).toContain("-s");
        expect(args).toContain("com.personal-agent.secret.apiToken");
        callback(null, "my-secret-value\n", "");
      },
    );

    const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
    const client = new NativePersonalAgentKeychainClient();
    await expect(client.get("apiToken")).resolves.toBe("my-secret-value");
  });

  it("get() returns null when item is not found", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        callback(Object.assign(new Error("not found"), { code: 44 }));
      },
    );

    const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
    const client = new NativePersonalAgentKeychainClient();
    await expect(client.get("apiToken")).resolves.toBeNull();
  });

  it("set() creates a new item with -T /usr/bin/security and no -U", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        calls.push({ file, args });
        // has() probe returns not-found so we exercise the create branch
        if (args.includes("find-generic-password")) {
          callback(Object.assign(new Error("not found"), { code: 44 }));
          return;
        }
        callback(null, "", "");
      },
    );

    const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
    const client = new NativePersonalAgentKeychainClient();
    await client.set("apiToken", "new-value");

    // Two calls: has() probe + create. No update step.
    expect(calls).toHaveLength(2);
    const addCall = calls[1]!;
    expect(addCall.args).toContain("add-generic-password");
    expect(addCall.args).not.toContain("-U");
    expect(addCall.args).not.toContain("-A");
    const tIdx = addCall.args.indexOf("-T");
    expect(tIdx).toBeGreaterThan(-1);
    expect(addCall.args[tIdx + 1]).toBe("/usr/bin/security");
    expect(addCall.args).toContain("-w");
    expect(addCall.args).toContain("new-value");
  });

  it("set() updates an existing item password-only (no -T) so macOS does not prompt for ACL", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        calls.push({ file, args });
        // has() probe reports existing item
        if (args.includes("find-generic-password")) {
          callback(null, "keychain entry\n", "");
          return;
        }
        callback(null, "", "");
      },
    );

    const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
    const client = new NativePersonalAgentKeychainClient();
    await client.set("apiToken", "refreshed-value");

    expect(calls).toHaveLength(2);
    const updateCall = calls[1]!;
    expect(updateCall.args).toContain("add-generic-password");
    expect(updateCall.args).toContain("-U");
    expect(updateCall.args).not.toContain("-T");
    expect(updateCall.args).toContain("-w");
    expect(updateCall.args).toContain("refreshed-value");
  });

  it("set() recovers from a has()/create race by falling through to update", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        calls.push({ file, args });
        if (args.includes("find-generic-password")) {
          callback(Object.assign(new Error("not found"), { code: 44 }));
          return;
        }
        if (!args.includes("-U")) {
          const err = Object.assign(
            new Error(
              "security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.",
            ),
            { code: 45 },
          );
          callback(err);
          return;
        }
        callback(null, "", "");
      },
    );

    const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
    const client = new NativePersonalAgentKeychainClient();
    await client.set("apiToken", "race-value");

    expect(calls).toHaveLength(3);
    expect(calls[2]!.args).toContain("-U");
    expect(calls[2]!.args).not.toContain("-T");
  });

  it("has() returns true when item exists", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        callback(null, "keychain entry\n", "");
      },
    );

    const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
    const client = new NativePersonalAgentKeychainClient();
    await expect(client.has("apiToken")).resolves.toBe(true);
  });

  it("has() returns false when item does not exist", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        callback(Object.assign(new Error("not found"), { code: 44 }));
      },
    );

    const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
    const client = new NativePersonalAgentKeychainClient();
    await expect(client.has("apiToken")).resolves.toBe(false);
  });

  it("delete() succeeds when item exists", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        callback(null, "", "");
      },
    );

    const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
    const client = new NativePersonalAgentKeychainClient();
    await expect(client.delete("apiToken")).resolves.toBeUndefined();
  });

  it("delete() ignores errors when item does not exist", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        callback(Object.assign(new Error("not found"), { code: 44 }));
      },
    );

    const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
    const client = new NativePersonalAgentKeychainClient();
    await expect(client.delete("apiToken")).resolves.toBeUndefined();
  });
});

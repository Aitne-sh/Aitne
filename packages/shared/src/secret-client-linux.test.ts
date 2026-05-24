import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const execWithStdinMock = vi.fn();

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
              if (error) reject(error);
              else resolve({ stdout, stderr });
            },
          );
        }),
    },
  ),
}));

vi.mock("./exec-with-stdin.js", () => ({
  execWithStdin: execWithStdinMock,
}));

describe("LinuxSecretClient", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    execWithStdinMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("get() calls secret-tool lookup with correct attributes", async () => {
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        expect(file).toBe("secret-tool");
        expect(args).toEqual([
          "lookup", "service", "personal-agent", "key", "apiToken",
        ]);
        callback(null, "my-secret\n", "");
      },
    );

    const { LinuxSecretClient } = await import("./secret-client-linux.js");
    const client = new LinuxSecretClient();
    await expect(client.get("apiToken")).resolves.toBe("my-secret");
  });

  it("get() returns null when secret-tool fails (not found)", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null) => void,
      ) => {
        callback(new Error("No matching secret found"));
      },
    );

    const { LinuxSecretClient } = await import("./secret-client-linux.js");
    const client = new LinuxSecretClient();
    await expect(client.get("nonexistent")).resolves.toBeNull();
  });

  it("get() preserves empty string values", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string) => void,
      ) => {
        callback(null, "");
      },
    );

    const { LinuxSecretClient } = await import("./secret-client-linux.js");
    const client = new LinuxSecretClient();
    await expect(client.get("empty")).resolves.toBe("");
  });

  it("set() calls execWithStdin with value on stdin", async () => {
    execWithStdinMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { LinuxSecretClient } = await import("./secret-client-linux.js");
    const client = new LinuxSecretClient();
    await client.set("slackBotToken", "xoxb-secret");

    expect(execWithStdinMock).toHaveBeenCalledOnce();
    const [cmd, args, input, opts] = execWithStdinMock.mock.calls[0];
    expect(cmd).toBe("secret-tool");
    expect(args).toEqual([
      "store", "--label", "PersonalAgent: slackBotToken",
      "service", "personal-agent", "key", "slackBotToken",
    ]);
    expect(input).toBe("xoxb-secret");
    expect(opts).toEqual({ timeout: 5_000 });
  });

  it("has() returns true when get() succeeds", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string) => void,
      ) => {
        callback(null, "value\n");
      },
    );

    const { LinuxSecretClient } = await import("./secret-client-linux.js");
    const client = new LinuxSecretClient();
    await expect(client.has("apiToken")).resolves.toBe(true);
  });

  it("has() returns false when get() returns null", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null) => void,
      ) => {
        callback(new Error("not found"));
      },
    );

    const { LinuxSecretClient } = await import("./secret-client-linux.js");
    const client = new LinuxSecretClient();
    await expect(client.has("missing")).resolves.toBe(false);
  });

  it("delete() calls secret-tool clear with correct attributes", async () => {
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null) => void,
      ) => {
        expect(file).toBe("secret-tool");
        expect(args).toEqual([
          "clear", "service", "personal-agent", "key", "apiToken",
        ]);
        callback(null);
      },
    );

    const { LinuxSecretClient } = await import("./secret-client-linux.js");
    const client = new LinuxSecretClient();
    await expect(client.delete("apiToken")).resolves.toBeUndefined();
  });

  it("delete() ignores errors (not found)", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null) => void,
      ) => {
        callback(new Error("not found"));
      },
    );

    const { LinuxSecretClient } = await import("./secret-client-linux.js");
    const client = new LinuxSecretClient();
    await expect(client.delete("missing")).resolves.toBeUndefined();
  });

  it("rejects secret names containing path separators on get/set/delete", async () => {
    const { LinuxSecretClient } = await import("./secret-client-linux.js");
    const client = new LinuxSecretClient();

    // Cast to any to bypass StoredSecretName type — validateName is the
    // last-line defence and must reject path separators regardless.
    await expect(client.get("foo/bar" as never)).rejects.toThrow(
      /Invalid secret name/,
    );
    await expect(client.set("foo\\bar" as never, "x")).rejects.toThrow(
      /Invalid secret name/,
    );
    await expect(client.delete("a/b" as never)).rejects.toThrow(
      /Invalid secret name/,
    );

    // None of those calls should have reached the underlying CLI.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execWithStdinMock).not.toHaveBeenCalled();
  });
});

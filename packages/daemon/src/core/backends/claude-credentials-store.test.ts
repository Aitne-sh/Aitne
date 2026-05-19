import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeKeychainPayload,
  getClaudeCredentialsFilePath,
  getClaudeKeychainAccounts,
  parseBundle,
  readClaudeCredentials,
  type ClaudeCredentialsTelemetry,
  type KeychainReadResult,
} from "./claude-credentials-store.js";

vi.mock("./cli-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./cli-utils.js")>("./cli-utils.js");
  return {
    ...actual,
    runLineCommand: vi.fn(),
  };
});

import { runLineCommand } from "./cli-utils.js";
const mockedRunLineCommand = vi.mocked(runLineCommand);

const CURRENT_BUNDLE = {
  claudeAiOauth: {
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: 1_700_000_000_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "pro",
    rateLimitTier: "default",
  },
};

function makeTelemetry(): Required<ClaudeCredentialsTelemetry> {
  return {
    recordSchemaParseFailure: vi.fn(),
    recordKeychainReadFailed: vi.fn(),
    recordCredentialsFileReadFailed: vi.fn(),
  };
}

describe("decodeKeychainPayload", () => {
  it("parses current raw-JSON format", () => {
    expect(decodeKeychainPayload(JSON.stringify(CURRENT_BUNDLE))).toEqual(
      CURRENT_BUNDLE,
    );
  });

  it("parses legacy hex-encoded format with leading control byte", () => {
    const legacy = `\x07${JSON.stringify(CURRENT_BUNDLE)}`;
    const hex = Buffer.from(legacy, "utf-8").toString("hex");
    expect(decodeKeychainPayload(hex)).toEqual(CURRENT_BUNDLE);
  });

  it("parses legacy hex-encoded format without leading byte", () => {
    const hex = Buffer.from(JSON.stringify(CURRENT_BUNDLE), "utf-8").toString("hex");
    expect(decodeKeychainPayload(hex)).toEqual(CURRENT_BUNDLE);
  });

  it("throws on empty payload", () => {
    expect(() => decodeKeychainPayload("   ")).toThrow(/Empty/);
  });

  it("throws on odd-length hex (not a real hex blob)", () => {
    expect(() => decodeKeychainPayload("abc")).toThrow(/Unexpected/);
  });

  it("throws on hex that does not contain a JSON object", () => {
    const hex = Buffer.from("not json", "utf-8").toString("hex");
    expect(() => decodeKeychainPayload(hex)).toThrow(/Unexpected/);
  });

  it("throws on garbage (neither JSON nor hex)", () => {
    expect(() => decodeKeychainPayload("ZZZ xyz")).toThrow(/Unexpected/);
  });

  it("extracts the first balanced object from legacy hex with trailing debris", () => {
    // Legacy keychain entries from older Claude Code versions are
    // observed in the wild with format:
    //   \x07 + JSON(claudeAiOauth) + "mcpOAuth" + JSON-fragment
    // The previous implementation used indexOf("{") + lastIndexOf("}"),
    // which swallowed the trailing fragment and failed to parse. The
    // new implementation walks braces with a depth counter and returns
    // just the claudeAiOauth object.
    const primary = JSON.stringify(CURRENT_BUNDLE);
    const debris = `mcpOAuth{"broken":"fragment"`;
    const legacy = `\x07${primary}${debris}`;
    const hex = Buffer.from(legacy, "utf-8").toString("hex");
    expect(decodeKeychainPayload(hex)).toEqual(CURRENT_BUNDLE);
  });

  it("handles JSON string values that contain unescaped braces", () => {
    // `}` inside a JSON string value must not terminate the scan early.
    const bundle = {
      claudeAiOauth: {
        accessToken: "at-with-}-brace",
        refreshToken: "rt-1",
        expiresAt: 1,
        scopes: ["scope"],
      },
    };
    const hex = Buffer.from(JSON.stringify(bundle), "utf-8").toString("hex");
    expect(decodeKeychainPayload(hex)).toEqual(bundle);
  });

  it("handles JSON string values that contain escaped quotes (escape flag path)", () => {
    // A string with an escaped quote: {"key": "value with \"escaped\" quotes"}
    // This exercises the `if (ch === "\\") { escape = true; continue; }` branch
    // and the subsequent `if (escape) { escape = false; continue; }` branch.
    const bundle = {
      claudeAiOauth: {
        accessToken: "token-with-\\\"escaped\\\"",
        refreshToken: "rt-1",
        expiresAt: 1,
        scopes: [],
      },
    };
    const hex = Buffer.from(JSON.stringify(bundle), "utf-8").toString("hex");
    expect(decodeKeychainPayload(hex)).toEqual(bundle);
  });

  it("returns null from extractFirstBalancedObject when opening brace has no closing brace", () => {
    // A hex payload that decodes to text with an unclosed brace, so
    // extractFirstBalancedObject returns null → throws Unexpected format error.
    const unclosed = "\x07{unclosed object — no closing brace";
    const hex = Buffer.from(unclosed, "utf-8").toString("hex");
    expect(() => decodeKeychainPayload(hex)).toThrow(/Unexpected/);
  });
});

describe("parseBundle", () => {
  it("returns the inner bundle on a valid root", () => {
    const parsed = parseBundle(CURRENT_BUNDLE);
    expect(parsed?.accessToken).toBe("at-1");
    expect(parsed?.refreshToken).toBe("rt-1");
    expect(parsed?.scopes).toEqual(["user:inference", "user:profile"]);
  });

  it("defaults scopes when absent", () => {
    const bundle = {
      claudeAiOauth: {
        accessToken: "at",
        refreshToken: null,
        expiresAt: null,
      },
    };
    expect(parseBundle(bundle)?.scopes).toEqual([]);
  });

  it("reports schema parse failure via telemetry and returns null", () => {
    const telemetry = makeTelemetry();
    const result = parseBundle({ claudeAiOauth: { accessToken: "" } }, telemetry);
    expect(result).toBeNull();
    expect(telemetry.recordSchemaParseFailure).toHaveBeenCalledTimes(1);
  });

  it("returns null without telemetry when hook is absent", () => {
    expect(parseBundle({})).toBeNull();
  });
});

describe("getClaudeKeychainAccounts", () => {
  it("returns username + legacy unknown for a real username", () => {
    expect(getClaudeKeychainAccounts("test-owner")).toEqual(["test-owner", "unknown"]);
  });

  it("returns only unknown for empty username", () => {
    expect(getClaudeKeychainAccounts("")).toEqual(["unknown"]);
  });

  it("returns only unknown when username is literally 'unknown'", () => {
    expect(getClaudeKeychainAccounts("unknown")).toEqual(["unknown"]);
  });
});

describe("getClaudeCredentialsFilePath", () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
  });

  it("honors CLAUDE_CONFIG_DIR when set", () => {
    process.env.CLAUDE_CONFIG_DIR = "/custom/claude";
    expect(getClaudeCredentialsFilePath()).toBe("/custom/claude/.credentials.json");
  });

  it("falls back to homedir when CLAUDE_CONFIG_DIR is unset", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const path = getClaudeCredentialsFilePath();
    expect(path.endsWith("/.claude/.credentials.json")).toBe(true);
  });
});

describe("readClaudeCredentials", () => {
  const validPayload: KeychainReadResult = {
    exitCode: 0,
    payload: JSON.stringify(CURRENT_BUNDLE),
  };

  it("reads from Keychain on macOS using the real username first", async () => {
    const accounts: string[] = [];
    const readKeychain = vi.fn(async (account: string) => {
      accounts.push(account);
      return account === "test-owner" ? validPayload : { exitCode: 44, payload: "" };
    });

    const bundle = await readClaudeCredentials({
      platform: "darwin",
      currentUsername: "test-owner",
      readKeychain,
      readPlaintext: () => {
        throw new Error("should not fall back");
      },
    });

    expect(bundle?.accessToken).toBe("at-1");
    expect(accounts).toEqual(["test-owner"]);
  });

  it("falls back to legacy 'unknown' account when real username has no entry", async () => {
    const readKeychain = vi.fn(async (account: string) =>
      account === "unknown" ? validPayload : { exitCode: 44, payload: "" },
    );

    const bundle = await readClaudeCredentials({
      platform: "darwin",
      currentUsername: "test-owner",
      readKeychain,
      readPlaintext: () => {
        throw new Error("should not fall back");
      },
    });

    expect(bundle?.accessToken).toBe("at-1");
    expect(readKeychain).toHaveBeenCalledTimes(2);
  });

  it("records keychain_read_failed on non-44 exit code and falls through", async () => {
    const telemetry = makeTelemetry();
    const readKeychain = vi.fn(async () => ({ exitCode: 2, payload: "" }));
    const readPlaintext = vi.fn(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const bundle = await readClaudeCredentials({
      platform: "darwin",
      currentUsername: "test-owner",
      readKeychain,
      readPlaintext,
      telemetry,
    });

    expect(bundle).toBeNull();
    expect(telemetry.recordKeychainReadFailed).toHaveBeenCalled();
    expect(telemetry.recordCredentialsFileReadFailed).not.toHaveBeenCalled();
  });

  it("treats empty payload as no entry without touching telemetry", async () => {
    const telemetry = makeTelemetry();
    const readKeychain = vi.fn(async () => ({ exitCode: 0, payload: "" }));
    const readPlaintext = vi.fn(() => {
      const err = new Error("enoent") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const bundle = await readClaudeCredentials({
      platform: "darwin",
      currentUsername: "test-owner",
      readKeychain,
      readPlaintext,
      telemetry,
    });

    expect(bundle).toBeNull();
    expect(telemetry.recordKeychainReadFailed).not.toHaveBeenCalled();
  });

  it("records keychain_read_failed (only) when keychain reader throws", async () => {
    const telemetry = makeTelemetry();
    const readKeychain = vi.fn(async () => {
      throw new Error("spawn failure");
    });
    const readPlaintext = vi.fn(() => {
      const err = new Error("enoent") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    await readClaudeCredentials({
      platform: "darwin",
      currentUsername: "test-owner",
      readKeychain,
      readPlaintext,
      telemetry,
    });

    expect(telemetry.recordKeychainReadFailed).toHaveBeenCalledWith(-1);
    expect(telemetry.recordSchemaParseFailure).not.toHaveBeenCalled();
  });

  it("records schema_parse_failed (only) when payload decoding fails", async () => {
    const telemetry = makeTelemetry();
    const readKeychain = vi.fn(async () => ({
      exitCode: 0,
      payload: "ZZZ not a real payload",
    }));
    const readPlaintext = vi.fn(() => {
      const err = new Error("enoent") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    await readClaudeCredentials({
      platform: "darwin",
      currentUsername: "test-owner",
      readKeychain,
      readPlaintext,
      telemetry,
    });

    expect(telemetry.recordKeychainReadFailed).not.toHaveBeenCalled();
    expect(telemetry.recordSchemaParseFailure).toHaveBeenCalled();
  });

  it("records schema_parse_failed with non-Error exception from decode", async () => {
    const telemetry = makeTelemetry();
    // Force decodeKeychainPayload to throw a non-Error value by stubbing
    // JSON.parse for this call — simulates an exotic exception source.
    const originalParse = JSON.parse;
    JSON.parse = vi.fn(() => {
      throw "exotic";
    }) as unknown as typeof JSON.parse;
    try {
      const readKeychain = vi.fn(async () => ({
        exitCode: 0,
        payload: "{}",
      }));
      await readClaudeCredentials({
        platform: "darwin",
        currentUsername: "test-owner",
        readKeychain,
        readPlaintext: () => {
          const err = new Error("enoent") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        },
        telemetry,
      });
      expect(telemetry.recordSchemaParseFailure).toHaveBeenCalledWith("exotic");
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("reads from plaintext file on Linux", async () => {
    const readPlaintext = vi.fn(() => JSON.stringify(CURRENT_BUNDLE));
    const bundle = await readClaudeCredentials({
      platform: "linux",
      currentUsername: "test-owner",
      credentialsFilePath: "/home/test/.claude/.credentials.json",
      readKeychain: async () => {
        throw new Error("should not use keychain on linux");
      },
      readPlaintext,
    });
    expect(bundle?.accessToken).toBe("at-1");
    expect(readPlaintext).toHaveBeenCalledWith("/home/test/.claude/.credentials.json");
  });

  it("returns null silently when plaintext file is missing (ENOENT)", async () => {
    const telemetry = makeTelemetry();
    const readPlaintext = vi.fn(() => {
      const err = new Error("enoent") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const bundle = await readClaudeCredentials({
      platform: "linux",
      credentialsFilePath: "/x",
      readPlaintext,
      telemetry,
    });

    expect(bundle).toBeNull();
    expect(telemetry.recordCredentialsFileReadFailed).not.toHaveBeenCalled();
  });

  it("records telemetry on non-ENOENT plaintext read failures", async () => {
    const telemetry = makeTelemetry();
    const readPlaintext = vi.fn(() => {
      const err = new Error("denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    await readClaudeCredentials({
      platform: "linux",
      credentialsFilePath: "/x",
      readPlaintext,
      telemetry,
    });

    expect(telemetry.recordCredentialsFileReadFailed).toHaveBeenCalledWith("EACCES");
  });

  it("records telemetry with string fallback when plaintext error has no code", async () => {
    const telemetry = makeTelemetry();
    const readPlaintext = vi.fn(() => {
      throw new Error("weird");
    });

    await readClaudeCredentials({
      platform: "linux",
      credentialsFilePath: "/x",
      readPlaintext,
      telemetry,
    });

    expect(telemetry.recordCredentialsFileReadFailed).toHaveBeenCalledWith("weird");
  });

  it("handles non-Error plaintext throws", async () => {
    const telemetry = makeTelemetry();
    const readPlaintext = vi.fn(() => {
      throw "boom";
    });

    await readClaudeCredentials({
      platform: "linux",
      credentialsFilePath: "/x",
      readPlaintext,
      telemetry,
    });

    expect(telemetry.recordCredentialsFileReadFailed).toHaveBeenCalledWith("boom");
  });

  it("returns null on malformed plaintext JSON and logs via schema telemetry", async () => {
    const telemetry = makeTelemetry();
    const readPlaintext = vi.fn(() => "{not-json");

    const bundle = await readClaudeCredentials({
      platform: "linux",
      credentialsFilePath: "/x",
      readPlaintext,
      telemetry,
    });

    expect(bundle).toBeNull();
    // JSON.parse failure is a format/schema issue — recorded under
    // schema_parse_failed, NOT credentials_file_read_failed.
    expect(telemetry.recordSchemaParseFailure).toHaveBeenCalled();
    expect(telemetry.recordCredentialsFileReadFailed).not.toHaveBeenCalled();
  });

  it("records schema_parse_failed with non-Error exception on malformed plaintext", async () => {
    const telemetry = makeTelemetry();
    const originalParse = JSON.parse;
    JSON.parse = vi.fn(() => {
      throw "plaintext-exotic";
    }) as unknown as typeof JSON.parse;
    try {
      await readClaudeCredentials({
        platform: "linux",
        credentialsFilePath: "/x",
        readPlaintext: () => "irrelevant",
        telemetry,
      });
      expect(telemetry.recordSchemaParseFailure).toHaveBeenCalledWith(
        "plaintext-exotic",
      );
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("does not export a write function (read-only store invariant)", async () => {
    const mod = await import("./claude-credentials-store.js");
    const exportNames = Object.keys(mod);
    expect(exportNames.some((n) => /write/i.test(n))).toBe(false);
  });
});

describe("readClaudeCredentials — default readers", () => {
  beforeEach(() => {
    mockedRunLineCommand.mockReset();
  });

  it("invokes the `security` subprocess on darwin by default", async () => {
    mockedRunLineCommand.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdoutLines: [JSON.stringify(CURRENT_BUNDLE)],
      stderrLines: [],
      timedOut: false,
    });

    const bundle = await readClaudeCredentials({
      platform: "darwin",
      currentUsername: "testuser",
    });
    expect(bundle?.accessToken).toBe("at-1");
    expect(mockedRunLineCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "security",
        args: expect.arrayContaining([
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-a",
          "testuser",
          "-w",
        ]),
        timeoutMs: 5_000,
      }),
    );
  });

  it("maps a null exitCode from runLineCommand to -1", async () => {
    mockedRunLineCommand.mockResolvedValue({
      exitCode: null,
      signal: "SIGTERM",
      stdoutLines: [],
      stderrLines: [],
      timedOut: true,
    });
    const telemetry = {
      recordSchemaParseFailure: vi.fn(),
      recordKeychainReadFailed: vi.fn(),
      recordCredentialsFileReadFailed: vi.fn(),
    };
    const bundle = await readClaudeCredentials({
      platform: "darwin",
      currentUsername: "testuser",
      telemetry,
      readPlaintext: () => {
        const err = new Error("enoent") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    });
    expect(bundle).toBeNull();
    expect(telemetry.recordKeychainReadFailed).toHaveBeenCalledWith(-1);
  });

  it("reads a real plaintext credentials file via the default reader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-cred-test-"));
    const filePath = join(dir, ".credentials.json");
    writeFileSync(filePath, JSON.stringify(CURRENT_BUNDLE));
    try {
      const bundle = await readClaudeCredentials({
        platform: "linux",
        credentialsFilePath: filePath,
      });
      expect(bundle?.accessToken).toBe("at-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  redactProxyErrorMessage,
  resolveDaemonApiToken,
} from "./daemon-api-token";

describe("resolveDaemonApiToken", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), "pa-dashboard-token-"));
    process.chdir(tempDir);
    writeFileSync(join(tempDir, ".env"), "PA_API_TOKEN=legacy-env-token\n");
  });

  afterEach(() => {
    const cwd = process.cwd();
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("prefers the explicit environment variable", async () => {
    await expect(resolveDaemonApiToken({
      env: { PA_API_TOKEN: "env-token" } as unknown as NodeJS.ProcessEnv,
      client: { get: async () => "keychain-token" },
    })).resolves.toBe("env-token");
  });

  it("falls back to Keychain and does not read .env files", async () => {
    await expect(resolveDaemonApiToken({
      env: {} as unknown as NodeJS.ProcessEnv,
      client: { get: async () => null },
    })).resolves.toBeNull();
  });
});

describe("redactProxyErrorMessage", () => {
  it("scrubs token-shaped values from proxy errors", () => {
    expect(
      redactProxyErrorMessage(
        "daemon rejected Bearer abcdefghijklmnopqrstuvwxyz123456 and QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5MDEyMzQ=",
      ),
    ).toBe("daemon rejected [REDACTED] and [REDACTED]");
  });
});

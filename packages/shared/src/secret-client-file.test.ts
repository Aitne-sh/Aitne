import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSecretClient, resolveMasterPassword } from "./secret-client-file.js";

describe("FileSecretClient", () => {
  let tempDir: string;

  function makeTempDir(): string {
    tempDir = mkdtempSync(join(tmpdir(), "secret-test-"));
    return tempDir;
  }

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips set/get/has/delete", async () => {
    const dir = makeTempDir();
    const client = await FileSecretClient.create("test-password", dir);

    await expect(client.has("apiToken")).resolves.toBe(false);
    await expect(client.get("apiToken")).resolves.toBeNull();

    await client.set("apiToken", "secret-value-123");
    await expect(client.has("apiToken")).resolves.toBe(true);
    await expect(client.get("apiToken")).resolves.toBe("secret-value-123");

    await client.delete("apiToken");
    await expect(client.has("apiToken")).resolves.toBe(false);
    await expect(client.get("apiToken")).resolves.toBeNull();
  });

  it("handles multiple secrets independently", async () => {
    const dir = makeTempDir();
    const client = await FileSecretClient.create("test-password", dir);

    await client.set("slackBotToken", "xoxb-abc");
    await client.set("apiToken", "tok-xyz");

    await expect(client.get("slackBotToken")).resolves.toBe("xoxb-abc");
    await expect(client.get("apiToken")).resolves.toBe("tok-xyz");

    await client.delete("slackBotToken");
    await expect(client.get("slackBotToken")).resolves.toBeNull();
    await expect(client.get("apiToken")).resolves.toBe("tok-xyz");
  });

  it("persists across instances with the same password", async () => {
    const dir = makeTempDir();
    const client1 = await FileSecretClient.create("consistent-pw", dir);
    await client1.set("mySecret", "hello");

    const client2 = await FileSecretClient.create("consistent-pw", dir);
    await expect(client2.get("mySecret")).resolves.toBe("hello");
  });

  it("throws on wrong master password", async () => {
    const dir = makeTempDir();
    await FileSecretClient.create("correct-password", dir);

    await expect(FileSecretClient.create("wrong-password", dir)).rejects.toThrow(
      "Master password mismatch",
    );
  });

  it("handles empty string values", async () => {
    const dir = makeTempDir();
    const client = await FileSecretClient.create("pw", dir);

    await client.set("empty", "");
    await expect(client.get("empty")).resolves.toBe("");
  });

  it("handles unicode values", async () => {
    const dir = makeTempDir();
    const client = await FileSecretClient.create("pw", dir);

    const unicodeValue = "unicode test \u00e9\u00e8\u00ea \ud83c\udf89";
    await client.set("unicode", unicodeValue);
    await expect(client.get("unicode")).resolves.toBe(unicodeValue);
  });

  it("handles special characters in values", async () => {
    const dir = makeTempDir();
    const client = await FileSecretClient.create("pw", dir);

    const specialValue = `{"key": "value with 'quotes' and \`backticks\` and $vars"}`;
    await client.set("special", specialValue);
    await expect(client.get("special")).resolves.toBe(specialValue);
  });

  it("rejects secret names with path separators", async () => {
    const dir = makeTempDir();
    const client = await FileSecretClient.create("pw", dir);

    await expect(client.get("../etc/passwd")).rejects.toThrow("Invalid secret name");
    await expect(client.set("foo/bar", "val")).rejects.toThrow("Invalid secret name");
  });

  it("throws on corrupted encrypted file (GCM auth failure)", async () => {
    const dir = makeTempDir();
    const client = await FileSecretClient.create("pw", dir);

    await client.set("tampered", "original");

    // Corrupt the ciphertext
    const filePath = join(dir, "tampered.enc");
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    content.ciphertext = "deadbeef" + content.ciphertext.slice(8);
    writeFileSync(filePath, JSON.stringify(content), "utf-8");

    await expect(client.get("tampered")).rejects.toThrow();
  });

  it("sets file permissions to 0o600 on written files", async () => {
    if (process.platform === "win32") return; // chmod is no-op on Windows

    const dir = makeTempDir();
    const client = await FileSecretClient.create("pw", dir);
    await client.set("permTest", "value");

    const encStat = statSync(join(dir, "permTest.enc"));
    // mode includes file type bits; mask to permission bits only
    expect(encStat.mode & 0o777).toBe(0o600);

    const hashStat = statSync(join(dir, ".master-hash"));
    expect(hashStat.mode & 0o777).toBe(0o600);
  });
});

describe("resolveMasterPassword", () => {
  const origEnv = process.env.PA_MASTER_PASSWORD;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.PA_MASTER_PASSWORD;
    else process.env.PA_MASTER_PASSWORD = origEnv;
  });

  it("returns env var when set", () => {
    process.env.PA_MASTER_PASSWORD = "from-env";
    expect(resolveMasterPassword()).toBe("from-env");
  });

  it("returns key file content when env var is unset", () => {
    delete process.env.PA_MASTER_PASSWORD;
    const dir = mkdtempSync(join(tmpdir(), "resolve-pw-"));
    const keyPath = join(dir, ".master-key");
    writeFileSync(keyPath, "from-file\n", { encoding: "utf-8", mode: 0o600 });

    expect(resolveMasterPassword(dir)).toBe("from-file");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when neither source is available", () => {
    delete process.env.PA_MASTER_PASSWORD;
    const dir = mkdtempSync(join(tmpdir(), "resolve-pw-"));

    expect(resolveMasterPassword(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("env var takes precedence over key file", () => {
    process.env.PA_MASTER_PASSWORD = "env-wins";
    const dir = mkdtempSync(join(tmpdir(), "resolve-pw-"));
    writeFileSync(join(dir, ".master-key"), "file-loses", { encoding: "utf-8", mode: 0o600 });

    expect(resolveMasterPassword(dir)).toBe("env-wins");
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when .master-key has overly permissive permissions", () => {
    delete process.env.PA_MASTER_PASSWORD;
    const dir = mkdtempSync(join(tmpdir(), "resolve-pw-"));
    const keyPath = join(dir, ".master-key");
    writeFileSync(keyPath, "secret", { encoding: "utf-8", mode: 0o644 });

    expect(() => resolveMasterPassword(dir)).toThrow(/permissions 0644.*expected 0600/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts .master-key with 0400 (read-only) permissions", () => {
    delete process.env.PA_MASTER_PASSWORD;
    const dir = mkdtempSync(join(tmpdir(), "resolve-pw-"));
    const keyPath = join(dir, ".master-key");
    writeFileSync(keyPath, "read-only-secret\n", { encoding: "utf-8", mode: 0o400 });

    expect(resolveMasterPassword(dir)).toBe("read-only-secret");
    // Restore write permission for cleanup
    chmodSync(keyPath, 0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});

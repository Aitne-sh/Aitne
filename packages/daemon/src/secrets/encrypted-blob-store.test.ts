import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEncryptedBlobStore } from "./encrypted-blob-store.js";
import type { SecretStore } from "./secret-store.js";
import type { StoredSecretName } from "./secret-names.js";

class MemorySecretStore implements SecretStore {
  private readonly values = new Map<StoredSecretName, string>();

  async has(name: StoredSecretName): Promise<boolean> {
    return this.values.has(name);
  }

  async get(name: StoredSecretName): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: StoredSecretName, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: StoredSecretName): Promise<void> {
    this.values.delete(name);
  }
}

describe("FileEncryptedBlobStore", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "pa-blob-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("round-trips encrypted UTF-8 payloads", async () => {
    const store = new FileEncryptedBlobStore(rootDir, new MemorySecretStore());

    await store.writeUtf8("google-token", JSON.stringify({ refresh_token: "secret" }));
    await expect(store.exists("google-token")).resolves.toBe(true);
    await expect(store.readUtf8("google-token")).resolves.toBe(
      JSON.stringify({ refresh_token: "secret" }),
    );
  });

  it("exists returns false for non-existent blobs", async () => {
    const store = new FileEncryptedBlobStore(rootDir, new MemorySecretStore());
    await expect(store.exists("no-such-blob")).resolves.toBe(false);
  });

  it("readUtf8 returns null for non-existent blobs (ENOENT)", async () => {
    const store = new FileEncryptedBlobStore(rootDir, new MemorySecretStore());
    await expect(store.readUtf8("missing-blob")).resolves.toBeNull();
  });

  it("remove deletes an existing blob", async () => {
    const store = new FileEncryptedBlobStore(rootDir, new MemorySecretStore());
    await store.writeUtf8("google-token", "data");
    await expect(store.exists("google-token")).resolves.toBe(true);

    await store.remove("google-token");
    await expect(store.exists("google-token")).resolves.toBe(false);
    await expect(store.readUtf8("google-token")).resolves.toBeNull();
  });

  it("remove is a no-op for non-existent blobs (force: true)", async () => {
    const store = new FileEncryptedBlobStore(rootDir, new MemorySecretStore());
    // Should not throw
    await expect(store.remove("nonexistent")).resolves.toBeUndefined();
  });

  it("rejects invalid blob names: empty string", () => {
    const store = new FileEncryptedBlobStore(rootDir, new MemorySecretStore());
    expect(store.writeUtf8("" as never, "data")).rejects.toThrow("Invalid blob name");
  });

  it("rejects invalid blob names: absolute path", () => {
    const store = new FileEncryptedBlobStore(rootDir, new MemorySecretStore());
    expect(store.writeUtf8("/etc/passwd" as never, "data")).rejects.toThrow("Invalid blob name");
  });

  it("rejects invalid blob names: path traversal", () => {
    const store = new FileEncryptedBlobStore(rootDir, new MemorySecretStore());
    expect(store.readUtf8("../secret" as never)).rejects.toThrow("Invalid blob name");
  });

  it("throws on corrupted ciphertext during decryption", async () => {
    const secretStore = new MemorySecretStore();
    const store = new FileEncryptedBlobStore(rootDir, secretStore);

    // Write a valid blob first (to create the master key)
    await store.writeUtf8("google-token", "valid data");

    // Now manually corrupt the blob file
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const corruptedEnvelope = JSON.stringify({
      version: 1,
      iv: Buffer.from("aaaaaaaaaaaa").toString("base64"),
      tag: Buffer.from("bbbbbbbbbbbbbbbb").toString("base64"),
      ciphertext: Buffer.from("corrupted").toString("base64"),
    });
    writeFileSync(join(rootDir, "google-token.enc"), corruptedEnvelope);

    await expect(store.readUtf8("google-token")).rejects.toThrow();
  });

  it("reuses existing master key across instances sharing the same secret store", async () => {
    const sharedSecretStore = new MemorySecretStore();
    const store1 = new FileEncryptedBlobStore(rootDir, sharedSecretStore);
    await store1.writeUtf8("google-token", "shared secret");

    // New instance with same secret store should be able to decrypt
    const store2 = new FileEncryptedBlobStore(rootDir, sharedSecretStore);
    await expect(store2.readUtf8("google-token")).resolves.toBe("shared secret");
  });
});

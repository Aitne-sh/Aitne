import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { BlobName } from "./types.js";
import type { SecretStore } from "./secret-store.js";

const BLOB_MASTER_KEY_NAME = "encryptedBlobMasterKey";
const KEY_BYTES = 32;
const IV_BYTES = 12;

interface BlobEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EncryptedBlobStore {
  exists(name: BlobName): Promise<boolean>;
  readUtf8(name: BlobName): Promise<string | null>;
  writeUtf8(name: BlobName, plaintext: string): Promise<void>;
  remove(name: BlobName): Promise<void>;
}

export class FileEncryptedBlobStore implements EncryptedBlobStore {
  constructor(
    private readonly rootDir: string,
    private readonly secretStore: SecretStore,
  ) {}

  async exists(name: BlobName): Promise<boolean> {
    try {
      await access(this.getBlobPath(name));
      return true;
    } catch {
      return false;
    }
  }

  async readUtf8(name: BlobName): Promise<string | null> {
    try {
      const raw = await readFile(this.getBlobPath(name), "utf8");
      const envelope = JSON.parse(raw) as BlobEnvelope;
      const key = await this.getOrCreateMasterKey();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeUtf8(name: BlobName, plaintext: string): Promise<void> {
    const key = await this.getOrCreateMasterKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const envelope: BlobEnvelope = {
      version: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };

    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await writeFile(
      this.getBlobPath(name),
      JSON.stringify(envelope),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async remove(name: BlobName): Promise<void> {
    await rm(this.getBlobPath(name), { force: true });
  }

  private async getOrCreateMasterKey(): Promise<Buffer> {
    const existing = await this.secretStore.get(BLOB_MASTER_KEY_NAME);
    if (existing) {
      return Buffer.from(existing, "base64");
    }

    const next = randomBytes(KEY_BYTES);
    await this.secretStore.set(BLOB_MASTER_KEY_NAME, next.toString("base64"));
    return next;
  }

  private getBlobPath(name: BlobName): string {
    if (!name || name.startsWith("/") || name.includes("..")) {
      throw new Error(`Invalid blob name: ${name}`);
    }
    return join(this.rootDir, `${name}.enc`);
  }
}

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PersonalAgentKeychainClient } from "./keychain-helper-client.js";

import type { ScryptOptions } from "node:crypto";

// promisify(scrypt) accepts (password, salt, keylen, options?) but TS only
// types the 3-arg overload. Cast to the correct signature.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const FILE_MODE = 0o600; // owner-only read/write
const SALT_LENGTH = 32; // 256 bits
const SCRYPT_COST = 16384; // N=2^14, balances speed vs. security for local use
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

/**
 * File format for each `.enc` file (JSON):
 * {
 *   "salt": "<hex>",        // per-secret scrypt salt
 *   "iv": "<hex>",          // per-encryption random IV
 *   "authTag": "<hex>",     // GCM authentication tag
 *   "ciphertext": "<hex>"   // encrypted secret value
 * }
 */
interface EncryptedFileContent {
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * Master password hash file format (JSON):
 * {
 *   "salt": "<hex>",
 *   "hash": "<hex>"    // scrypt(password, salt, 32)
 * }
 */
interface MasterHashFile {
  salt: string;
  hash: string;
}

/**
 * Encrypted file-based secret client.
 *
 * Used as the universal fallback when no native secret store is available
 * (headless Linux, WSL, or any unsupported platform).
 *
 * Each secret is stored in its own `.enc` file under `~/.personal-agent/secrets/`,
 * encrypted with AES-256-GCM. The encryption key is derived from a master
 * password using async scrypt with a per-secret random salt.
 *
 * Use the static `create()` factory to construct — it validates the master
 * password asynchronously before returning the instance.
 *
 * The master password is resolved by callers (typically the factory) from:
 *   1. `PA_MASTER_PASSWORD` environment variable
 *   2. `~/.personal-agent/secrets/.master-key` file (chmod 0600)
 *
 * On first use, the master password hash is stored in `.master-hash` for
 * validation on subsequent accesses.
 */
export class FileSecretClient implements PersonalAgentKeychainClient {
  private readonly secretsDir: string;
  private readonly masterPassword: string;

  /**
   * Create and initialize a FileSecretClient.
   * Validates the master password against the stored hash (or creates one).
   */
  static async create(masterPassword: string, secretsDir?: string): Promise<FileSecretClient> {
    const client = new FileSecretClient(masterPassword, secretsDir);
    await client.ensureMasterHash();
    return client;
  }

  /** @internal Use `FileSecretClient.create()` instead. */
  constructor(masterPassword: string, secretsDir?: string) {
    this.masterPassword = masterPassword;
    this.secretsDir = secretsDir ?? join(homedir(), ".personal-agent", "secrets");
    // Owner-only directory: it holds the encrypted secret blobs and the
    // `.master-hash` used to verify the master password. `mode` on mkdir is
    // ignored when the directory already exists (the common upgrade case),
    // so tighten existing dirs explicitly. Best-effort — the .enc/.master-hash
    // files are themselves 0600, and some filesystems don't support chmod.
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.secretsDir, 0o700);
    } catch {
      // perms hardening is best-effort; the per-file 0600 mode is the
      // primary confidentiality control.
    }
  }

  private filePath(secretName: string): string {
    if (/[/\\]/.test(secretName)) {
      throw new Error(`Invalid secret name: ${secretName}`);
    }
    return join(this.secretsDir, `${secretName}.enc`);
  }

  private masterHashPath(): string {
    return join(this.secretsDir, ".master-hash");
  }

  private async deriveKey(salt: Buffer): Promise<Buffer> {
    return await scryptAsync(this.masterPassword, salt, KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    });
  }

  /**
   * On first use, store a hash of the master password so we can detect
   * mismatches on subsequent accesses. If the hash file already exists,
   * validate against it and throw on mismatch.
   */
  private async ensureMasterHash(): Promise<void> {
    const hashPath = this.masterHashPath();
    if (existsSync(hashPath)) {
      const stored: MasterHashFile = JSON.parse(readFileSync(hashPath, "utf-8"));
      const salt = Buffer.from(stored.salt, "hex");
      const derived = await this.deriveKey(salt);
      const expected = Buffer.from(stored.hash, "hex");
      if (!timingSafeEqual(derived, expected)) {
        throw new Error(
          "Master password mismatch. The password does not match the one used to create the secret store.",
        );
      }
    } else {
      const salt = randomBytes(SALT_LENGTH);
      const hash = await this.deriveKey(salt);
      const content: MasterHashFile = {
        salt: salt.toString("hex"),
        hash: hash.toString("hex"),
      };
      writeFileSync(hashPath, JSON.stringify(content), { encoding: "utf-8", mode: FILE_MODE });
    }
  }

  async has(secretName: string): Promise<boolean> {
    return existsSync(this.filePath(secretName));
  }

  async get(secretName: string): Promise<string | null> {
    const path = this.filePath(secretName);
    if (!existsSync(path)) return null;

    const stored: EncryptedFileContent = JSON.parse(readFileSync(path, "utf-8"));
    const salt = Buffer.from(stored.salt, "hex");
    const iv = Buffer.from(stored.iv, "hex");
    const authTag = Buffer.from(stored.authTag, "hex");
    const ciphertext = Buffer.from(stored.ciphertext, "hex");

    const key = await this.deriveKey(salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf-8");
  }

  async set(secretName: string, value: string): Promise<void> {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = await this.deriveKey(salt);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const content: EncryptedFileContent = {
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      ciphertext: encrypted.toString("hex"),
    };
    writeFileSync(this.filePath(secretName), JSON.stringify(content), { encoding: "utf-8", mode: FILE_MODE });
  }

  async delete(secretName: string): Promise<void> {
    const path = this.filePath(secretName);
    if (existsSync(path)) unlinkSync(path);
  }
}

/**
 * Resolve master password from environment variable or key file.
 * Returns null if neither source provides a password.
 */
export function resolveMasterPassword(
  secretsDir?: string,
): string | null {
  // 1. Environment variable takes precedence
  if (process.env.PA_MASTER_PASSWORD) {
    return process.env.PA_MASTER_PASSWORD;
  }

  // 2. Key file fallback
  const dir = secretsDir ?? join(homedir(), ".personal-agent", "secrets");
  const keyFilePath = join(dir, ".master-key");
  if (existsSync(keyFilePath)) {
    // Validate permissions — .master-key must be owner-only (0600 or 0400).
    // Other modes risk exposing the master password to same-machine users.
    const mode = statSync(keyFilePath).mode & 0o777;
    if (mode !== 0o600 && mode !== 0o400) {
      throw new Error(
        `.master-key has permissions 0${mode.toString(8)}, expected 0600 or 0400. ` +
        `Fix with: chmod 600 ${keyFilePath}`,
      );
    }
    return readFileSync(keyFilePath, "utf-8").trim();
  }

  return null;
}

export type {
  InternalSecretName,
  ScopedSecretName,
  SecretName,
  StoredSecretName,
} from "./secret-names.js";

export type BlobName = string;

export interface SecretCacheEntry {
  value: string | null;
  expiresAt: number;
}

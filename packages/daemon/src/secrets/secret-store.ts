import type { StoredSecretName } from "./secret-names.js";

export interface SecretStore {
  has(name: StoredSecretName): Promise<boolean>;
  get(name: StoredSecretName): Promise<string | null>;
  set(name: StoredSecretName, value: string): Promise<void>;
  delete(name: StoredSecretName): Promise<void>;
}

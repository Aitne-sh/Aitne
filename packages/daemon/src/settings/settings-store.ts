import type Database from "better-sqlite3";
import {
  RUNTIME_SETTING_KEYS,
  isRuntimeSettingKey,
  runtimeSettingsSchema,
  type RuntimeSettingKey,
  type RuntimeSettings,
} from "./runtime-settings.js";

export interface SettingsStore {
  getAll(): Partial<RuntimeSettings>;
  get<K extends RuntimeSettingKey>(key: K): RuntimeSettings[K] | null;
  set<K extends RuntimeSettingKey>(key: K, value: RuntimeSettings[K]): void;
  setMany(updates: Partial<RuntimeSettings>): void;
  delete(key: RuntimeSettingKey): void;
  transaction<T>(fn: () => T): T;
}

class SqliteSettingsStore implements SettingsStore {
  constructor(private readonly db: Database.Database) {}

  getAll(): Partial<RuntimeSettings> {
    const rows = this.db.prepare(
      "SELECT key, value_json FROM settings",
    ).all() as Array<{ key: string; value_json: string }>;

    const rawValues: Partial<RuntimeSettings> = {};
    for (const row of rows) {
      if (!isRuntimeSettingKey(row.key)) {
        continue;
      }
      try {
        (rawValues as Record<string, unknown>)[row.key] = JSON.parse(row.value_json);
      } catch {
        continue;
      }
    }

    const defaults = runtimeSettingsSchema.parse({});
    const result: Partial<RuntimeSettings> = {};
    for (const key of RUNTIME_SETTING_KEYS) {
      if (!(key in rawValues)) {
        continue;
      }
      const candidate = runtimeSettingsSchema.safeParse({
        ...defaults,
        ...result,
        [key]: rawValues[key],
      });
      if (!candidate.success) {
        continue;
      }
      (result as Record<string, unknown>)[key] = candidate.data[key];
    }

    return result;
  }

  get<K extends RuntimeSettingKey>(key: K): RuntimeSettings[K] | null {
    const all = this.getAll();
    return all[key] ?? null;
  }

  set<K extends RuntimeSettingKey>(key: K, value: RuntimeSettings[K]): void {
    this.setMany({ [key]: value } as Partial<RuntimeSettings>);
  }

  setMany(updates: Partial<RuntimeSettings>): void {
    const keys = Object.keys(updates).filter(isRuntimeSettingKey);
    if (keys.length === 0) {
      return;
    }

    const validated = runtimeSettingsSchema.parse({
      ...runtimeSettingsSchema.parse({}),
      ...this.getAll(),
      ...updates,
    });
    const entries = keys.map((key) => [
      key,
      validated[key],
    ]) as Array<[RuntimeSettingKey, RuntimeSettings[RuntimeSettingKey]]>;

    const upsert = this.db.prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = CURRENT_TIMESTAMP
    `);

    const tx = this.db.transaction((items: Array<[RuntimeSettingKey, RuntimeSettings[RuntimeSettingKey]]>) => {
      for (const [key, value] of items) {
        upsert.run(key, JSON.stringify(value));
      }
    });

    tx(entries);
  }

  delete(key: RuntimeSettingKey): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

export function createSettingsStore(db: Database.Database): SettingsStore {
  return new SqliteSettingsStore(db);
}

export function getRuntimeSettingsDefaults(): RuntimeSettings {
  return runtimeSettingsSchema.parse({});
}

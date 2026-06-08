import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  B4_DEFAULT_DAILY_SPEND_CAP_MINOR,
  B4_DEFAULT_DAILY_TOKEN_CAP,
} from "../services/browser-history/managed-chromium/types.js";
import {
  deleteSiteB4Config,
  getB4Enabled,
  getSiteB4Config,
  listSiteB4Configs,
  setB4Enabled,
  upsertSiteB4Config,
  type UpsertB4SiteConfigInput,
} from "./browser-automation-b4-config-store.js";

let db: Database.Database;

function input(overrides: Partial<UpsertB4SiteConfigInput> = {}): UpsertB4SiteConfigInput {
  return {
    siteKey: "shop",
    enabled: true,
    currency: "USD",
    updatedAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
});

afterEach(() => {
  db.close();
});

describe("global B-4 master toggle", () => {
  it("defaults to false when the runtime_state row is absent", () => {
    expect(getB4Enabled(db)).toBe(false);
  });

  it("round-trips true and false", () => {
    setB4Enabled(db, true);
    expect(getB4Enabled(db)).toBe(true);
    setB4Enabled(db, false);
    expect(getB4Enabled(db)).toBe(false);
  });
});

describe("upsertSiteB4Config", () => {
  it("inserts a row, applying the default caps when omitted", () => {
    const row = upsertSiteB4Config(db, input());
    expect(row).toMatchObject({
      siteKey: "shop",
      enabled: true,
      currency: "USD",
      dailyTokenCap: B4_DEFAULT_DAILY_TOKEN_CAP,
      dailySpendCapMinor: B4_DEFAULT_DAILY_SPEND_CAP_MINOR,
      perTxCapMinorOverride: null,
      updatedAt: 1000,
    });
    expect(getSiteB4Config(db, "shop")).toEqual(row);
  });

  it("honours explicit caps and a per-tx override", () => {
    const row = upsertSiteB4Config(
      db,
      input({ dailyTokenCap: 3, dailySpendCapMinor: 5000, perTxCapMinorOverride: 2500 }),
    );
    expect(row).toMatchObject({
      dailyTokenCap: 3,
      dailySpendCapMinor: 5000,
      perTxCapMinorOverride: 2500,
    });
  });

  it("updates the existing row on conflicting site_key (ON CONFLICT)", () => {
    upsertSiteB4Config(db, input({ enabled: false, currency: "USD", updatedAt: 1000 }));
    const updated = upsertSiteB4Config(
      db,
      input({ enabled: true, currency: "EUR", dailyTokenCap: 7, updatedAt: 2000 }),
    );
    expect(updated).toMatchObject({ enabled: true, currency: "EUR", dailyTokenCap: 7, updatedAt: 2000 });
    expect(listSiteB4Configs(db)).toHaveLength(1);
  });
});

describe("getSiteB4Config / listSiteB4Configs", () => {
  it("returns null for an unknown site", () => {
    expect(getSiteB4Config(db, "nope")).toBeNull();
  });

  it("lists rows ordered by site_key", () => {
    upsertSiteB4Config(db, input({ siteKey: "zeta" }));
    upsertSiteB4Config(db, input({ siteKey: "alpha" }));
    expect(listSiteB4Configs(db).map((r) => r.siteKey)).toEqual(["alpha", "zeta"]);
  });
});

describe("deleteSiteB4Config", () => {
  it("deletes the row and reports the change count", () => {
    upsertSiteB4Config(db, input());
    expect(deleteSiteB4Config(db, "shop")).toBe(1);
    expect(getSiteB4Config(db, "shop")).toBeNull();
    // Second delete is a no-op.
    expect(deleteSiteB4Config(db, "shop")).toBe(0);
  });
});

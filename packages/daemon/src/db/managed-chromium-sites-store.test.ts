import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSiteBootstrap,
  clearSiteConnection,
  listSiteBootstrapKeys,
  listSiteConnectionKeys,
  readSiteBootstrap,
  readSiteConnection,
  siteBootstrapKey,
  siteConnectionKey,
  updateSiteConnection,
  writeSiteBootstrap,
  writeSiteConnection,
} from "./managed-chromium-sites-store.js";
import { applySchema } from "./schema.js";
import { writeRuntimeState } from "./runtime-state.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("managed-chromium-sites-store — key composition", () => {
  it("composes the persistent connection runtime_state key", () => {
    expect(siteConnectionKey("amazon_jp")).toBe(
      "managed_chromium.sites.amazon_jp",
    );
  });

  it("composes the bootstrap runtime_state key", () => {
    expect(siteBootstrapKey("amazon_jp")).toBe(
      "managed_chromium.site_bootstrap.amazon_jp",
    );
  });

  it("rejects siteKeys that fail the naming-convention regex", () => {
    expect(() => siteConnectionKey("../etc")).toThrowError(
      /violates naming convention/,
    );
    expect(() => siteBootstrapKey("Amazon")).toThrowError(
      /violates naming convention/,
    );
    expect(() => siteConnectionKey("")).toThrowError(
      /violates naming convention/,
    );
  });
});

describe("managed-chromium-sites-store — connection row CRUD", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns null when no row exists", () => {
    expect(readSiteConnection(db, "amazon_jp")).toBeNull();
  });

  it("round-trips a connection record", () => {
    writeSiteConnection(db, "amazon_jp", {
      schemaVersion: 1,
      connectedAt: 1_700_000_000_000,
      accountLabel: "Alice",
      lastWorkflowAt: null,
    });
    const out = readSiteConnection(db, "amazon_jp");
    expect(out).toEqual({
      schemaVersion: 1,
      connectedAt: 1_700_000_000_000,
      accountLabel: "Alice",
      lastWorkflowAt: null,
    });
  });

  it("returns null when the persisted row fails schema validation", () => {
    writeRuntimeState(db, siteConnectionKey("amazon_jp"), { garbage: true });
    expect(readSiteConnection(db, "amazon_jp")).toBeNull();
  });

  it("rejects writes whose shape fails the schema", () => {
    expect(() =>
      writeSiteConnection(db, "amazon_jp", {
        // @ts-expect-error — exercising the schema's runtime guard.
        schemaVersion: 2,
        connectedAt: 1,
        accountLabel: null,
        lastWorkflowAt: null,
      }),
    ).toThrowError();
  });

  it("clearSiteConnection removes the row", () => {
    writeSiteConnection(db, "amazon_jp", {
      schemaVersion: 1,
      connectedAt: 1,
      accountLabel: null,
      lastWorkflowAt: null,
    });
    clearSiteConnection(db, "amazon_jp");
    expect(readSiteConnection(db, "amazon_jp")).toBeNull();
  });

  it("updateSiteConnection mutates an existing row atomically", () => {
    writeSiteConnection(db, "amazon_jp", {
      schemaVersion: 1,
      connectedAt: 100,
      accountLabel: "Alice",
      lastWorkflowAt: null,
    });
    const after = updateSiteConnection(db, "amazon_jp", (draft) => {
      draft.lastWorkflowAt = 200;
    });
    expect(after?.lastWorkflowAt).toBe(200);
    expect(readSiteConnection(db, "amazon_jp")?.lastWorkflowAt).toBe(200);
  });

  it("updateSiteConnection accepts a returned replacement value", () => {
    writeSiteConnection(db, "amazon_jp", {
      schemaVersion: 1,
      connectedAt: 100,
      accountLabel: null,
      lastWorkflowAt: null,
    });
    const after = updateSiteConnection(db, "amazon_jp", (draft) => ({
      ...draft,
      accountLabel: "Bob",
    }));
    expect(after?.accountLabel).toBe("Bob");
  });

  it("updateSiteConnection returns null when no row exists", () => {
    expect(
      updateSiteConnection(db, "amazon_jp", (draft) => {
        draft.lastWorkflowAt = 1;
      }),
    ).toBeNull();
  });

  it("updateSiteConnection throws when the mutated shape fails the schema", () => {
    writeSiteConnection(db, "amazon_jp", {
      schemaVersion: 1,
      connectedAt: 100,
      accountLabel: null,
      lastWorkflowAt: null,
    });
    expect(() =>
      updateSiteConnection(db, "amazon_jp", (draft) => {
        (draft as unknown as { connectedAt: number }).connectedAt = -1;
      }),
    ).toThrowError();
  });
});

describe("managed-chromium-sites-store — bootstrap row CRUD", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns null when no row exists", () => {
    expect(readSiteBootstrap(db, "amazon_jp")).toBeNull();
  });

  it("round-trips a bootstrap record", () => {
    writeSiteBootstrap(db, "amazon_jp", {
      pid: 12345,
      deadlineAt: 1_700_000_000_000,
      reauth: false,
      cdpPort: 54321,
    });
    expect(readSiteBootstrap(db, "amazon_jp")).toEqual({
      pid: 12345,
      deadlineAt: 1_700_000_000_000,
      reauth: false,
      cdpPort: 54321,
    });
  });

  it("returns null when the persisted row fails schema validation", () => {
    writeRuntimeState(db, siteBootstrapKey("amazon_jp"), {
      pid: "not a number",
    });
    expect(readSiteBootstrap(db, "amazon_jp")).toBeNull();
  });

  it("rejects writes whose shape fails the schema", () => {
    expect(() =>
      writeSiteBootstrap(db, "amazon_jp", {
        pid: 0, // must be positive
        deadlineAt: 0,
        reauth: false,
        cdpPort: 1,
      }),
    ).toThrowError();
  });

  it("rejects writes with an out-of-range cdpPort", () => {
    expect(() =>
      writeSiteBootstrap(db, "amazon_jp", {
        pid: 1,
        deadlineAt: 1,
        reauth: false,
        cdpPort: 0,
      }),
    ).toThrowError();
    expect(() =>
      writeSiteBootstrap(db, "amazon_jp", {
        pid: 1,
        deadlineAt: 1,
        reauth: false,
        cdpPort: 70_000,
      }),
    ).toThrowError();
  });

  it("clearSiteBootstrap removes the row", () => {
    writeSiteBootstrap(db, "amazon_jp", {
      pid: 1,
      deadlineAt: 1,
      reauth: false,
      cdpPort: 1,
    });
    clearSiteBootstrap(db, "amazon_jp");
    expect(readSiteBootstrap(db, "amazon_jp")).toBeNull();
  });
});

describe("managed-chromium-sites-store — enumeration", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("enumerates connection rows in alphabetical order", () => {
    for (const k of ["netflix", "amazon_jp", "amazon_com"]) {
      writeSiteConnection(db, k, {
        schemaVersion: 1,
        connectedAt: 1,
        accountLabel: null,
        lastWorkflowAt: null,
      });
    }
    expect(listSiteConnectionKeys(db)).toEqual([
      "amazon_com",
      "amazon_jp",
      "netflix",
    ]);
  });

  it("enumerates bootstrap rows in alphabetical order", () => {
    for (const k of ["netflix", "amazon_jp"]) {
      writeSiteBootstrap(db, k, {
        pid: 1,
        deadlineAt: 1,
        reauth: false,
        cdpPort: 1,
      });
    }
    expect(listSiteBootstrapKeys(db)).toEqual(["amazon_jp", "netflix"]);
  });

  it("ignores composite keys whose tail doesn't pass the siteKey regex", () => {
    // Stale rows from prior bug or operator typo — must not surface
    // as siteKeys the reaper would then try to terminate.
    writeRuntimeState(db, "managed_chromium.sites.Bad-Key", {});
    writeRuntimeState(db, "managed_chromium.sites.../etc", {});
    expect(listSiteConnectionKeys(db)).toEqual([]);
  });

  it("returns an empty list when no rows exist", () => {
    expect(listSiteConnectionKeys(db)).toEqual([]);
    expect(listSiteBootstrapKeys(db)).toEqual([]);
  });

  it("listSiteConnectionKeys returns [] when the underlying table is unreachable", () => {
    // Drop runtime_state to force the prepared statement to throw —
    // exercises the catch branch the daemon's defence-in-depth path
    // relies on so a corrupt schema does not poison the reaper sweep.
    const broken = new Database(":memory:");
    expect(listSiteConnectionKeys(broken)).toEqual([]);
    broken.close();
  });

  it("listSiteBootstrapKeys returns [] when the underlying table is unreachable", () => {
    const broken = new Database(":memory:");
    expect(listSiteBootstrapKeys(broken)).toEqual([]);
    broken.close();
  });
});

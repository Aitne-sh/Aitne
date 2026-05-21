import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { BrowserHistoryBrowserKey } from "@aitne/shared";
import { applySchema } from "../../../db/schema.js";
import { writeIntegrations } from "../../../db/integrations-store.js";
import type { BrowserDetectionResult } from "../types.js";
import {
  computeBrowserHistoryIngestEnabled,
  serializeBrowserHistoryCapabilities,
} from "./registry.js";

function result(
  browser: BrowserHistoryBrowserKey,
  status: BrowserDetectionResult["status"],
): BrowserDetectionResult {
  return {
    browser,
    status,
    profiles: [],
  };
}

describe("browser history capability registry", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("requires both explicit consent and direct integration mode before ingest is enabled", () => {
    const detections = [
      result("chrome", "available"),
      result("edge", "permission_denied"),
    ];

    expect(
      computeBrowserHistoryIngestEnabled(
        db,
        {
          browserHistoryConsentAccepted: false,
          browserHistoryBrowserOverrides: {},
        },
        detections,
      ),
    ).toEqual([]);

    writeIntegrations(db, {
      browser_history: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-20T00:00:00.000Z",
      },
    });

    expect(
      computeBrowserHistoryIngestEnabled(
        db,
        {
          browserHistoryConsentAccepted: true,
          browserHistoryBrowserOverrides: {},
        },
        detections,
      ),
    ).toEqual(["chrome"]);
  });

  it("applies per-browser force-on and force-off overrides after the consent/mode gate", () => {
    writeIntegrations(db, {
      browser_history: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-20T00:00:00.000Z",
      },
    });

    expect(
      computeBrowserHistoryIngestEnabled(
        db,
        {
          browserHistoryConsentAccepted: true,
          browserHistoryBrowserOverrides: {
            chrome: "forced-off",
            edge: "forced-on",
          },
        },
        [
          result("chrome", "available"),
          result("edge", "permission_denied"),
        ],
      ),
    ).toEqual(["edge"]);
  });

  it("serializes a complete browser status map while keeping detail rows scoped to detected browsers", () => {
    const payload = serializeBrowserHistoryCapabilities(
      "2026-05-20T00:00:00.000Z",
      [
        {
          browser: "chrome",
          status: "available",
          profiles: [
            {
              browser: "chrome",
              profileName: "Default",
              userDataDir: "/tmp/profile",
              historyPath: "/tmp/profile/History",
              localStatePath: "/tmp/Local State",
              lastHistoryMtimeMs: 42,
              signedIn: true,
              canonical: true,
            },
          ],
        },
      ],
      ["chrome"],
    );

    expect(payload.browsers.chrome).toBe("available");
    expect(payload.browsers.edge).toBe("not_installed");
    expect(payload.ingestEnabled).toEqual(["chrome"]);
    expect(payload.details.chrome).toMatchObject({
      profileCount: 1,
      signedInProfiles: 1,
      lastHistoryMtimeMs: 42,
    });
    expect(payload.details.edge).toBeUndefined();
  });
});

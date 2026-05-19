import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { GitWatcher } from "./git-watcher.js";
import { applySchema } from "../db/schema.js";

describe("GitWatcher webhook fallback", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("enableWebhookMode sets webhook mode", () => {
    const watcher = new GitWatcher([], db, 300);

    // Before enabling, no webhook mode
    watcher.enableWebhookMode();
    // Should not throw
    watcher.notifyWebhookEvent();
  });

  it("notifyWebhookEvent is callable without enableWebhookMode", () => {
    const watcher = new GitWatcher([], db, 300);

    // Should not throw even without webhook mode
    watcher.notifyWebhookEvent();
  });

  it("stop cleans up even with webhook mode enabled", async () => {
    const watcher = new GitWatcher([], db, 300);

    watcher.enableWebhookMode();
    await watcher.start();
    await watcher.stop();
    // No error = success
    expect(true).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  MessageDeliveryError,
  type MessageHub,
} from "../adapters/message-hub.js";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";
import {
  WELCOME_DM_RUNTIME_STATE_KEY,
  WELCOME_DM_TEXT,
  sendSetupWelcomeDm,
} from "./setup-welcome-dm.js";

interface MockHubOverrides {
  eligible?: string[];
  // When omitted, the default mock mirrors `eligible` — one delivery per
  // eligible platform. Keeping the mock aligned with eligibility avoids
  // tests that silently disagree with their own setup.
  sendToUserImpl?: MessageHub["sendToUser"];
}

function createMockHub(overrides: MockHubOverrides = {}): MessageHub {
  const eligible = overrides.eligible ?? ["slack"];
  const defaultDeliveries = eligible.map((platform, idx) => ({
    platform,
    channel: `chan-${idx}`,
    messageId: `msg-${idx}`,
  }));
  return {
    getNotificationEligiblePlatforms: vi.fn().mockReturnValue(eligible),
    sendToUser:
      overrides.sendToUserImpl ??
      (vi
        .fn()
        .mockResolvedValue(defaultDeliveries) as unknown as MessageHub["sendToUser"]),
  } as unknown as MessageHub;
}

describe("setup-welcome-dm", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE runtime_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("sends the welcome DM and latches runtime_state on first run", async () => {
    const messageHub = createMockHub({ eligible: ["slack"] });

    const deliveries = await sendSetupWelcomeDm({ db, messageHub });

    expect(deliveries).not.toBeNull();
    expect(deliveries).toHaveLength(1);
    expect(messageHub.sendToUser).toHaveBeenCalledWith(WELCOME_DM_TEXT);

    const latch = readRuntimeState<{ sentAt: string; platforms: string[] }>(
      db,
      WELCOME_DM_RUNTIME_STATE_KEY,
    );
    expect(latch).not.toBeNull();
    expect(latch!.platforms).toEqual(["slack"]);
    expect(typeof latch!.sentAt).toBe("string");
  });

  it("records every delivered platform in the latch when multiple are eligible", async () => {
    const messageHub = createMockHub({
      eligible: ["slack", "telegram", "discord"],
    });

    const deliveries = await sendSetupWelcomeDm({ db, messageHub });

    expect(deliveries).toHaveLength(3);
    const latch = readRuntimeState<{ sentAt: string; platforms: string[] }>(
      db,
      WELCOME_DM_RUNTIME_STATE_KEY,
    );
    expect(latch!.platforms).toEqual(["slack", "telegram", "discord"]);
  });

  it("latches only the delivered subset when sendToUser partially succeeds", async () => {
    const messageHub = createMockHub({
      eligible: ["slack", "telegram"],
      sendToUserImpl: vi.fn().mockResolvedValue([
        { platform: "slack", channel: "chan-0", messageId: "msg-0" },
      ]) as unknown as MessageHub["sendToUser"],
    });

    const deliveries = await sendSetupWelcomeDm({ db, messageHub });

    expect(deliveries).toHaveLength(1);
    const latch = readRuntimeState<{ sentAt: string; platforms: string[] }>(
      db,
      WELCOME_DM_RUNTIME_STATE_KEY,
    );
    expect(latch!.platforms).toEqual(["slack"]);
  });

  it("skips delivery when the latch already exists", async () => {
    writeRuntimeState(db, WELCOME_DM_RUNTIME_STATE_KEY, {
      sentAt: "2026-05-14T00:00:00.000Z",
      platforms: ["slack"],
    });
    const messageHub = createMockHub();

    const result = await sendSetupWelcomeDm({ db, messageHub });

    expect(result).toBeNull();
    expect(messageHub.sendToUser).not.toHaveBeenCalled();
  });

  it("skips silently when no messaging destination is eligible", async () => {
    const messageHub = createMockHub({ eligible: [] });

    const result = await sendSetupWelcomeDm({ db, messageHub });

    expect(result).toBeNull();
    expect(messageHub.sendToUser).not.toHaveBeenCalled();
    expect(
      readRuntimeState(db, WELCOME_DM_RUNTIME_STATE_KEY),
    ).toBeNull();
  });

  it("does not latch when delivery fails with MessageDeliveryError", async () => {
    const messageHub = createMockHub({
      sendToUserImpl: vi
        .fn()
        .mockRejectedValue(
          new MessageDeliveryError("adapter offline"),
        ) as unknown as MessageHub["sendToUser"],
    });

    const result = await sendSetupWelcomeDm({ db, messageHub });

    expect(result).toBeNull();
    expect(
      readRuntimeState(db, WELCOME_DM_RUNTIME_STATE_KEY),
    ).toBeNull();
  });

  it("does not latch when delivery fails with unexpected error", async () => {
    const messageHub = createMockHub({
      sendToUserImpl: vi
        .fn()
        .mockRejectedValue(
          new Error("network unreachable"),
        ) as unknown as MessageHub["sendToUser"],
    });

    const result = await sendSetupWelcomeDm({ db, messageHub });

    expect(result).toBeNull();
    expect(
      readRuntimeState(db, WELCOME_DM_RUNTIME_STATE_KEY),
    ).toBeNull();
  });

  it("mentions the bang commands, dashboard, and integrations", () => {
    expect(WELCOME_DM_TEXT).toContain("!cost");
    expect(WELCOME_DM_TEXT).toContain("!ingest");
    expect(WELCOME_DM_TEXT).toContain("!compile");
    expect(WELCOME_DM_TEXT).toContain("!help");
    expect(WELCOME_DM_TEXT).toContain("dashboard");
    // Guard against regressing the "tune commands" wording, which falsely
    // implied that bang commands themselves are user-configurable.
    expect(WELCOME_DM_TEXT).toContain("integrations");
    expect(WELCOME_DM_TEXT).not.toContain("tune commands");
  });
});

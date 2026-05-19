/**
 * Peer tests for `./adapters.ts` (bootstrap factory).
 *
 * Scope: the factory's job is to wire the four messaging adapters into a
 * shared `AdapterState` holder. Building real Discord/Slack/Telegram/
 * WhatsApp adapters requires live websocket / Baileys / Telegram
 * client state that isn't worth standing up for a refactor smoke test,
 * so we exercise the pure paths:
 *
 *  - `whatsappQrResponseFromAdapter` projects an adapter+snapshot pair
 *    into the wire response shape. Pure → fully testable here.
 *  - `createAdapterReloaders` builds the closure record correctly and
 *    no-ops cleanly when the secret broker has no tokens. Detailed
 *    adapter-side behavior (websocket lifecycle, pairing, etc.) is
 *    covered by `discord.test.ts` / `slack-adapter.test.ts` etc.
 */

import { describe, it, expect } from "vitest";
import {
  createAdapterReloaders,
  whatsappQrResponseFromAdapter,
  type AdapterState,
} from "./adapters.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function makeFreshState(): AdapterState {
  return { discord: null, slack: null, telegram: null, whatsapp: null };
}

function makeStubMessageHub() {
  const setPlatformConfigured: Array<{ platform: string; configured: boolean }> = [];
  const setPlatformRuntimeStatus: Array<{ platform: string; payload: unknown }> = [];
  const registered: unknown[] = [];
  const unregistered: string[] = [];
  return {
    calls: {
      setPlatformConfigured,
      setPlatformRuntimeStatus,
      registered,
      unregistered,
    },
    hub: {
      setPlatformConfigured: (platform: string, configured: boolean) => {
        setPlatformConfigured.push({ platform, configured });
      },
      setPlatformRuntimeStatus: (platform: string, payload: unknown) => {
        setPlatformRuntimeStatus.push({ platform, payload });
      },
      register: (adapter: unknown) => {
        registered.push(adapter);
      },
      unregister: (platform: string) => {
        unregistered.push(platform);
      },
      getAdapter: () => null,
      sendToUser: async () => undefined,
    } as Any,
  };
}

function makeStubBroker(overrides: {
  discord?: string | null;
  slackBot?: string | null;
  slackApp?: string | null;
  telegram?: string | null;
} = {}) {
  return {
    getDiscordBotToken: async () => overrides.discord ?? null,
    getSlackBotToken: async () => overrides.slackBot ?? null,
    getSlackAppToken: async () => overrides.slackApp ?? null,
    getTelegramBotToken: async () => overrides.telegram ?? null,
  } as Any;
}

describe("whatsappQrResponseFromAdapter", () => {
  it("returns not_initialized state when adapter is null", () => {
    const response = whatsappQrResponseFromAdapter(null);
    expect(response).toEqual({
      dataUrl: null,
      payload: null,
      generatedAt: null,
      expiresAt: null,
      state: "not_initialized",
      error: "WhatsApp adapter not enabled",
    });
  });

  it("projects an adapter's current snapshot when no override is given", () => {
    const adapter = {
      getQrSnapshot: () => ({
        dataUrl: "data:image/png;base64,XYZ",
        payload: "qr-payload",
        generatedAt: 123,
        expiresAt: 456,
      }),
      getStatus: () => "awaiting_pair" as const,
      getStatusError: () => null,
    } as Any;
    const response = whatsappQrResponseFromAdapter(adapter);
    expect(response).toEqual({
      dataUrl: "data:image/png;base64,XYZ",
      payload: "qr-payload",
      generatedAt: 123,
      expiresAt: 456,
      state: "awaiting_pair",
      error: null,
    });
  });

  it("honors a null override (post-expiry case) instead of re-reading the adapter", () => {
    const adapter = {
      getQrSnapshot: () => ({
        dataUrl: "stale",
        payload: "stale",
        generatedAt: 0,
        expiresAt: 0,
      }),
      getStatus: () => "logged_out" as const,
      getStatusError: () => "expired",
    } as Any;
    const response = whatsappQrResponseFromAdapter(adapter, null);
    expect(response.dataUrl).toBeNull();
    expect(response.payload).toBeNull();
    expect(response.state).toBe("logged_out");
    expect(response.error).toBe("expired");
  });

  it("forwards error text from getStatusError", () => {
    const adapter = {
      getQrSnapshot: () => null,
      getStatus: () => "error" as const,
      getStatusError: () => "Connection lost",
    } as Any;
    const response = whatsappQrResponseFromAdapter(adapter);
    expect(response.error).toBe("Connection lost");
    expect(response.state).toBe("error");
  });
});

describe("createAdapterReloaders", () => {
  it("returns the documented closure record shape", () => {
    const { hub } = makeStubMessageHub();
    const broker = makeStubBroker();
    const state = makeFreshState();
    const reloaders = createAdapterReloaders({
      config: {} as Any,
      secretBroker: broker,
      messageHub: hub,
      eventBus: { put: () => undefined } as Any,
      attachmentStore: {} as Any,
      recordDetectedOwner: async () => undefined,
      onWhatsAppLoggedOut: async () => undefined,
      state,
    });
    expect(typeof reloaders.reloadDiscordAdapter).toBe("function");
    expect(typeof reloaders.reloadSlackAdapter).toBe("function");
    expect(typeof reloaders.reloadTelegramAdapter).toBe("function");
    expect(typeof reloaders.buildWhatsAppAdapter).toBe("function");
    expect(typeof reloaders.teardownWhatsAppAdapter).toBe("function");
    expect(typeof reloaders.enableWhatsAppAdapter).toBe("function");
  });

  it("reloadDiscordAdapter no-ops cleanly when no token is configured", async () => {
    const { hub, calls } = makeStubMessageHub();
    const broker = makeStubBroker();
    const state = makeFreshState();
    const { reloadDiscordAdapter } = createAdapterReloaders({
      config: {} as Any,
      secretBroker: broker,
      messageHub: hub,
      eventBus: { put: () => undefined } as Any,
      attachmentStore: {} as Any,
      recordDetectedOwner: async () => undefined,
      onWhatsAppLoggedOut: async () => undefined,
      state,
    });
    await reloadDiscordAdapter(false);
    expect(state.discord).toBeNull();
    expect(calls.setPlatformConfigured[0]).toEqual({
      platform: "discord",
      configured: false,
    });
    expect(calls.registered).toHaveLength(0);
  });

  it("reloadSlackAdapter no-ops when either token is missing", async () => {
    const { hub, calls } = makeStubMessageHub();
    const broker = makeStubBroker({ slackBot: "xoxb-only" });
    const state = makeFreshState();
    const { reloadSlackAdapter } = createAdapterReloaders({
      config: {} as Any,
      secretBroker: broker,
      messageHub: hub,
      eventBus: { put: () => undefined } as Any,
      attachmentStore: {} as Any,
      recordDetectedOwner: async () => undefined,
      onWhatsAppLoggedOut: async () => undefined,
      state,
    });
    await reloadSlackAdapter(false);
    expect(state.slack).toBeNull();
    expect(calls.setPlatformConfigured[0]).toEqual({
      platform: "slack",
      configured: false,
    });
  });

  it("reloadTelegramAdapter no-ops when no token is configured", async () => {
    const { hub, calls } = makeStubMessageHub();
    const broker = makeStubBroker();
    const state = makeFreshState();
    const { reloadTelegramAdapter } = createAdapterReloaders({
      config: {} as Any,
      secretBroker: broker,
      messageHub: hub,
      eventBus: { put: () => undefined } as Any,
      attachmentStore: {} as Any,
      recordDetectedOwner: async () => undefined,
      onWhatsAppLoggedOut: async () => undefined,
      state,
    });
    await reloadTelegramAdapter(false);
    expect(state.telegram).toBeNull();
    expect(calls.setPlatformConfigured[0]).toEqual({
      platform: "telegram",
      configured: false,
    });
  });

  it("buildWhatsAppAdapter throws when whatsappOwnerPhone is missing", () => {
    const { hub } = makeStubMessageHub();
    const broker = makeStubBroker();
    const state = makeFreshState();
    const { buildWhatsAppAdapter } = createAdapterReloaders({
      config: { whatsappOwnerPhone: undefined } as Any,
      secretBroker: broker,
      messageHub: hub,
      eventBus: { put: () => undefined } as Any,
      attachmentStore: {} as Any,
      recordDetectedOwner: async () => undefined,
      onWhatsAppLoggedOut: async () => undefined,
      state,
    });
    expect(() => buildWhatsAppAdapter()).toThrow(
      /PA_WHATSAPP_OWNER_PHONE/,
    );
  });

  it("teardownWhatsAppAdapter is a no-op when state.whatsapp is null", async () => {
    const { hub, calls } = makeStubMessageHub();
    const broker = makeStubBroker();
    const state = makeFreshState();
    const { teardownWhatsAppAdapter } = createAdapterReloaders({
      config: {} as Any,
      secretBroker: broker,
      messageHub: hub,
      eventBus: { put: () => undefined } as Any,
      attachmentStore: {} as Any,
      recordDetectedOwner: async () => undefined,
      onWhatsAppLoggedOut: async () => undefined,
      state,
    });
    await teardownWhatsAppAdapter();
    expect(calls.unregistered).toHaveLength(0);
  });
});

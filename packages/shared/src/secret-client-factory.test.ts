import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("createSecretClient", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns NativePersonalAgentKeychainClient on macOS (current platform)", async () => {
    // This test runs on our macOS dev machine — no mock needed
    if (process.platform !== "darwin") return;

    const { createSecretClient } = await import("./secret-client-factory.js");
    const client = await createSecretClient();
    expect(client.constructor.name).toBe("NativePersonalAgentKeychainClient");
  });

  it("returns WindowsDpapiSecretClient on win32", async () => {
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return { ...actual, platform: () => "win32" as NodeJS.Platform };
    });

    const { createSecretClient } = await import("./secret-client-factory.js");
    const client = await createSecretClient();
    expect(client.constructor.name).toBe("WindowsDpapiSecretClient");
  });

  it("falls back to FileSecretClient for unknown platform", async () => {
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return { ...actual, platform: () => "freebsd" as NodeJS.Platform };
    });

    // Mock FileSecretClient to avoid writing to the real filesystem.
    // FileSecretClient itself is thoroughly tested with temp dirs in
    // secret-client-file.test.ts — here we only verify the factory routing.
    const FakeFileClient = class FileSecretClient {
      async has() { return false; }
      async get() { return null; }
      async set() {}
      async delete() {}
    };
    vi.doMock("./secret-client-file.js", () => ({
      FileSecretClient: { create: async () => new FakeFileClient() },
      resolveMasterPassword: () => "fake-password",
    }));

    const { createSecretClient } = await import("./secret-client-factory.js");
    const client = await createSecretClient();
    expect(client.constructor.name).toBe("FileSecretClient");
  });

  it("throws when fallback has no master password", async () => {
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return { ...actual, platform: () => "freebsd" as NodeJS.Platform };
    });

    vi.doMock("./secret-client-file.js", () => ({
      FileSecretClient: { create: async () => ({}) },
      resolveMasterPassword: () => null,
    }));

    const { createSecretClient } = await import("./secret-client-factory.js");
    await expect(createSecretClient()).rejects.toThrow("No master password configured");
  });
});

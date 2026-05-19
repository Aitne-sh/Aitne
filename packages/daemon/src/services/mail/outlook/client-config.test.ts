import { describe, expect, it, vi } from "vitest";
import {
  authorityForTenant,
  buildLoopbackRedirectUri,
  loadOutlookClientConfig,
  OUTLOOK_AUTHORITY_BASE,
  OUTLOOK_CLIENT_CONFIG_BLOB,
  OUTLOOK_LOOPBACK_REDIRECT_HOST,
  OUTLOOK_SCOPES,
  OutlookClientConfigMissingError,
  parseOutlookClientConfig,
  saveOutlookClientConfig,
  serializeOutlookClientConfig,
} from "./client-config.js";
import type { EncryptedBlobStore } from "../../../secrets/encrypted-blob-store.js";

describe("OutlookClientConfigMissingError", () => {
  it("carries a stable code and a guiding message", () => {
    const err = new OutlookClientConfigMissingError();
    expect(err.code).toBe("outlook_client_config_missing");
    expect(err.name).toBe("OutlookClientConfigMissingError");
    expect(err.message).toMatch(/PUT/);
  });
});

describe("parseOutlookClientConfig", () => {
  it("parses a valid config", () => {
    expect(parseOutlookClientConfig(JSON.stringify({ clientId: "abc", tenant: "common" })))
      .toEqual({ clientId: "abc", tenant: "common" });
  });

  it("defaults tenant to 'common' when omitted", () => {
    expect(parseOutlookClientConfig(JSON.stringify({ clientId: "abc" })))
      .toEqual({ clientId: "abc", tenant: "common" });
  });

  it("defaults tenant to 'common' for empty-string tenant", () => {
    expect(parseOutlookClientConfig(JSON.stringify({ clientId: "abc", tenant: "" })))
      .toEqual({ clientId: "abc", tenant: "common" });
  });

  it("rejects missing clientId", () => {
    expect(() => parseOutlookClientConfig(JSON.stringify({ tenant: "common" })))
      .toThrow(/clientId/);
  });

  it("rejects empty-string clientId", () => {
    expect(() => parseOutlookClientConfig(JSON.stringify({ clientId: "" })))
      .toThrow(/clientId/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseOutlookClientConfig("not-json")).toThrow();
  });
});

describe("serializeOutlookClientConfig round-trip", () => {
  it("round-trips through parse", () => {
    const raw = serializeOutlookClientConfig({ clientId: "x", tenant: "myorg.onmicrosoft.com" });
    expect(parseOutlookClientConfig(raw)).toEqual({
      clientId: "x",
      tenant: "myorg.onmicrosoft.com",
    });
  });
});

describe("authorityForTenant", () => {
  it("composes the v2 authority URL", () => {
    expect(authorityForTenant("common")).toBe(`${OUTLOOK_AUTHORITY_BASE}/common`);
    expect(authorityForTenant("contoso")).toBe(`${OUTLOOK_AUTHORITY_BASE}/contoso`);
  });
});

describe("buildLoopbackRedirectUri", () => {
  it("uses 127.0.0.1 (not localhost — Azure distinguishes)", () => {
    const uri = buildLoopbackRedirectUri(54321);
    expect(uri).toBe("http://127.0.0.1:54321/callback");
    expect(uri).toContain(OUTLOOK_LOOPBACK_REDIRECT_HOST);
  });
});

describe("OUTLOOK_SCOPES", () => {
  it("contains the v1 mail scopes plus Calendars.ReadWrite (SETUP-FLOW-REDESIGN-PLAN §6.1)", () => {
    expect(OUTLOOK_SCOPES).toContain("offline_access");
    expect(OUTLOOK_SCOPES).toContain("User.Read");
    expect(OUTLOOK_SCOPES).toContain("Mail.ReadWrite");
    expect(OUTLOOK_SCOPES).toContain("Mail.Send");
    expect(OUTLOOK_SCOPES).toContain("Calendars.ReadWrite");
  });

  it("orders Calendars.ReadWrite at the tail so a v1 cache row's missing-scope diff is obvious", () => {
    expect(OUTLOOK_SCOPES[OUTLOOK_SCOPES.length - 1]).toBe("Calendars.ReadWrite");
  });

  it("does not include Calendars.Read (subsumed by Calendars.ReadWrite)", () => {
    expect(OUTLOOK_SCOPES).not.toContain("Calendars.Read");
  });

  it("declares exactly five scopes (regression guard against accidental additions)", () => {
    // Mirroring the Mail.ReadWrite/Mail.Read precedent: surface scope drift
    // as a test failure rather than a silent OAuth consent change.
    expect(OUTLOOK_SCOPES.length).toBe(5);
  });
});

describe("blob load/save helpers", () => {
  function makeStore(): EncryptedBlobStore & { storage: Map<string, string> } {
    const storage = new Map<string, string>();
    return {
      storage,
      async exists(name: string) {
        return storage.has(name);
      },
      async readUtf8(name: string) {
        return storage.get(name) ?? null;
      },
      async writeUtf8(name: string, plaintext: string) {
        storage.set(name, plaintext);
      },
      async remove(name: string) {
        storage.delete(name);
      },
    };
  }

  it("returns null when blob does not exist", async () => {
    const store = makeStore();
    expect(await loadOutlookClientConfig(store)).toBeNull();
  });

  it("round-trips via save/load", async () => {
    const store = makeStore();
    await saveOutlookClientConfig(store, { clientId: "abc", tenant: "common" });
    expect(store.storage.has(OUTLOOK_CLIENT_CONFIG_BLOB)).toBe(true);
    expect(await loadOutlookClientConfig(store)).toEqual({
      clientId: "abc",
      tenant: "common",
    });
  });

  it("uses the spec'd blob name", async () => {
    expect(OUTLOOK_CLIENT_CONFIG_BLOB).toBe("mail:outlook:client-config");
  });

  it("propagates blob-store errors via the read path", async () => {
    const failing: EncryptedBlobStore = {
      async exists() {
        return false;
      },
      async readUtf8() {
        throw new Error("disk fault");
      },
      async writeUtf8() {
        // unused
      },
      async remove() {
        // unused
      },
    };
    await expect(loadOutlookClientConfig(failing)).rejects.toThrow("disk fault");
  });

  it("save delegates to writeUtf8 with the canonical blob name", async () => {
    const writeUtf8 = vi.fn(async () => undefined);
    const store: EncryptedBlobStore = {
      async exists() {
        return false;
      },
      async readUtf8() {
        return null;
      },
      writeUtf8,
      async remove() {
        // unused
      },
    };
    await saveOutlookClientConfig(store, { clientId: "x", tenant: "common" });
    expect(writeUtf8).toHaveBeenCalledWith(
      OUTLOOK_CLIENT_CONFIG_BLOB,
      serializeOutlookClientConfig({ clientId: "x", tenant: "common" }),
    );
  });
});

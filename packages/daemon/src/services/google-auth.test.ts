import { describe, it, expect } from "vitest";
import {
  parseGoogleCredentialsJson,
  detectGoogleCredentialType,
  getGoogleOAuthClientConfig,
  mergeGoogleTokenPayload,
} from "./google-auth.js";

describe("parseGoogleCredentialsJson", () => {
  it("parses valid JSON into a credentials document", () => {
    const raw = JSON.stringify({ type: "service_account", client_email: "svc@example.com" });
    const result = parseGoogleCredentialsJson(raw);
    expect(result.type).toBe("service_account");
    expect(result.client_email).toBe("svc@example.com");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseGoogleCredentialsJson("{invalid")).toThrow();
  });
});

describe("detectGoogleCredentialType", () => {
  it("returns 'service_account' for service account credentials", () => {
    const raw = JSON.stringify({ type: "service_account" });
    expect(detectGoogleCredentialType(raw)).toBe("service_account");
  });

  it("returns 'oauth2' for installed credentials", () => {
    const raw = JSON.stringify({
      installed: { client_id: "id", client_secret: "secret" },
    });
    expect(detectGoogleCredentialType(raw)).toBe("oauth2");
  });

  it("returns 'oauth2' for web credentials", () => {
    const raw = JSON.stringify({
      web: { client_id: "id", client_secret: "secret" },
    });
    expect(detectGoogleCredentialType(raw)).toBe("oauth2");
  });

  it("returns null for null input", () => {
    expect(detectGoogleCredentialType(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectGoogleCredentialType("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(detectGoogleCredentialType("{not valid}")).toBeNull();
  });

  it("returns null for unknown format", () => {
    const raw = JSON.stringify({ something: "else" });
    expect(detectGoogleCredentialType(raw)).toBeNull();
  });
});

describe("getGoogleOAuthClientConfig", () => {
  it("returns installed config when present", () => {
    const cred = {
      installed: { client_id: "id1", client_secret: "s1", redirect_uris: ["http://localhost"] },
    };
    const config = getGoogleOAuthClientConfig(cred);
    expect(config).toEqual({
      client_id: "id1",
      client_secret: "s1",
      redirect_uris: ["http://localhost"],
    });
  });

  it("returns web config when present", () => {
    const cred = {
      web: { client_id: "id2", client_secret: "s2" },
    };
    const config = getGoogleOAuthClientConfig(cred);
    expect(config).toEqual({ client_id: "id2", client_secret: "s2" });
  });

  it("prefers installed over web when both present", () => {
    const cred = {
      installed: { client_id: "installed", client_secret: "s1" },
      web: { client_id: "web", client_secret: "s2" },
    };
    const config = getGoogleOAuthClientConfig(cred);
    expect(config?.client_id).toBe("installed");
  });

  it("returns null when neither installed nor web is present", () => {
    const cred = { type: "service_account" };
    expect(getGoogleOAuthClientConfig(cred)).toBeNull();
  });
});

describe("mergeGoogleTokenPayload", () => {
  it("merges new tokens into existing ones", () => {
    const existing = JSON.stringify({ access_token: "old_access", refresh_token: "rt_1" });
    const next = { access_token: "new_access" };
    const merged = JSON.parse(mergeGoogleTokenPayload(existing, next));
    expect(merged.access_token).toBe("new_access");
    expect(merged.refresh_token).toBe("rt_1");
  });

  it("preserves existing refresh_token when new one is undefined", () => {
    const existing = JSON.stringify({ refresh_token: "keep_me", access_token: "old" });
    const next = { access_token: "new" };
    const merged = JSON.parse(mergeGoogleTokenPayload(existing, next));
    expect(merged.refresh_token).toBe("keep_me");
  });

  it("preserves existing refresh_token when new one is null", () => {
    const existing = JSON.stringify({ refresh_token: "keep_me" });
    const next = { refresh_token: null, access_token: "new" };
    const merged = JSON.parse(mergeGoogleTokenPayload(existing, next));
    expect(merged.refresh_token).toBe("keep_me");
  });

  it("preserves existing refresh_token when new one is empty string", () => {
    const existing = JSON.stringify({ refresh_token: "keep_me" });
    const next = { refresh_token: "", access_token: "new" };
    const merged = JSON.parse(mergeGoogleTokenPayload(existing, next));
    expect(merged.refresh_token).toBe("keep_me");
  });

  it("overwrites refresh_token when new one has a value", () => {
    const existing = JSON.stringify({ refresh_token: "old_rt" });
    const next = { refresh_token: "new_rt", access_token: "new" };
    const merged = JSON.parse(mergeGoogleTokenPayload(existing, next));
    expect(merged.refresh_token).toBe("new_rt");
  });

  it("handles null existingRaw (fresh token)", () => {
    const next = { access_token: "first", refresh_token: "first_rt" };
    const merged = JSON.parse(mergeGoogleTokenPayload(null, next));
    expect(merged.access_token).toBe("first");
    expect(merged.refresh_token).toBe("first_rt");
  });

  it("handles empty existing (no refresh_token to preserve)", () => {
    const next = { access_token: "new" };
    const merged = JSON.parse(mergeGoogleTokenPayload(null, next));
    expect(merged.access_token).toBe("new");
    expect(merged.refresh_token).toBeUndefined();
  });
});

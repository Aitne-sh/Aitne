import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectReauthState,
  extractSignedInUser,
  mostRecentSyncLevelDbWrite,
} from "./reauth-detector.js";

function makeProfileDir(): string {
  return mkdtempSync(join(tmpdir(), "managed-chromium-test-"));
}

function writeLocalState(profileDir: string, contents: string): void {
  writeFileSync(join(profileDir, "Local State"), contents, { mode: 0o600 });
}

function writeHistory(profileDir: string, mtimeMs: number, body = "x"): void {
  const dir = join(profileDir, "Default");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "History");
  writeFileSync(path, body);
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

describe("extractSignedInUser", () => {
  it("returns null when no sign-in fields are present", () => {
    expect(extractSignedInUser({})).toBeNull();
    expect(extractSignedInUser({ signin: {} })).toBeNull();
  });

  it("reads signed_in_to as canonical", () => {
    expect(
      extractSignedInUser({ signin: { signed_in_to: "u@example.com" } }),
    ).toBe("u@example.com");
  });

  it("falls through to signed_in_username then allowed_username", () => {
    expect(
      extractSignedInUser({ signin: { signed_in_username: "x@example.com" } }),
    ).toBe("x@example.com");
    expect(
      extractSignedInUser({ signin: { allowed_username: "y@example.com" } }),
    ).toBe("y@example.com");
  });

  it("reads info_cache.user_name as last resort", () => {
    expect(
      extractSignedInUser({
        profile: { info_cache: { Default: { user_name: "z@example.com" } } },
      }),
    ).toBe("z@example.com");
  });

  it("ignores empty strings", () => {
    expect(extractSignedInUser({ signin: { signed_in_to: "  " } })).toBeNull();
  });
});

describe("detectReauthState", () => {
  it("returns signed_out when Local State is missing", async () => {
    const dir = makeProfileDir();
    try {
      const result = await detectReauthState({
        profileDir: dir,
        lastKnownSignedInUser: null,
        now: Date.now(),
      });
      expect(result.kind).toBe("signed_out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns corrupt_local_state when Local State is unparseable", async () => {
    const dir = makeProfileDir();
    try {
      writeLocalState(dir, "{not json");
      const result = await detectReauthState({
        profileDir: dir,
        lastKnownSignedInUser: null,
        now: Date.now(),
      });
      expect(result.kind).toBe("corrupt_local_state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns account_changed when the signed-in user changes", async () => {
    const dir = makeProfileDir();
    try {
      writeLocalState(
        dir,
        JSON.stringify({ signin: { signed_in_to: "new@example.com" } }),
      );
      const result = await detectReauthState({
        profileDir: dir,
        lastKnownSignedInUser: "old@example.com",
        now: Date.now(),
      });
      expect(result.kind).toBe("account_changed");
      expect(result.to).toBe("new@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns healthy when History mtime is fresh", async () => {
    const dir = makeProfileDir();
    try {
      const now = Date.now();
      writeLocalState(
        dir,
        JSON.stringify({ signin: { signed_in_to: "u@example.com" } }),
      );
      writeHistory(dir, now - 1000);
      const result = await detectReauthState({
        profileDir: dir,
        lastKnownSignedInUser: "u@example.com",
        now,
      });
      expect(result.kind).toBe("healthy");
      expect(result.observedUser).toBe("u@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns sync_silent when History is stale and no sync LevelDB present", async () => {
    const dir = makeProfileDir();
    try {
      const now = Date.now();
      writeLocalState(
        dir,
        JSON.stringify({ signin: { signed_in_to: "u@example.com" } }),
      );
      writeHistory(dir, now - 12 * 60 * 60 * 1000); // 12h ago
      const result = await detectReauthState({
        profileDir: dir,
        lastKnownSignedInUser: "u@example.com",
        now,
      });
      expect(result.kind).toBe("sync_silent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mostRecentSyncLevelDbWrite", () => {
  it("returns null when sync dir is missing", async () => {
    const dir = makeProfileDir();
    try {
      const m = await mostRecentSyncLevelDbWrite(dir);
      expect(m).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the max mtime across entries when present", async () => {
    const dir = makeProfileDir();
    try {
      const leveldb = join(dir, "Default", "Sync Data", "LevelDB");
      mkdirSync(leveldb, { recursive: true });
      const now = Math.floor(Date.now() / 1000);
      const f1 = join(leveldb, "MANIFEST-000001");
      const f2 = join(leveldb, "000002.log");
      writeFileSync(f1, "a");
      writeFileSync(f2, "b");
      utimesSync(f1, now - 1000, now - 1000);
      utimesSync(f2, now - 10, now - 10);
      const m = await mostRecentSyncLevelDbWrite(dir);
      expect(m).not.toBeNull();
      expect(Math.round((m ?? 0) / 1000)).toBe(now - 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "vitest";
import type { SecretStore } from "../../secrets/secret-store.js";
import { RunTokenManager } from "./run-token.js";

class FakeStore {
  private store = new Map<string, string>();
  async has(name: string): Promise<boolean> { return this.store.has(name); }
  async get(name: string): Promise<string | null> { return this.store.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.store.set(name, value); }
  async delete(name: string): Promise<void> { this.store.delete(name); }
}

const broker = (s: FakeStore = new FakeStore()) => s as unknown as SecretStore;

describe("RunTokenManager.mint / verify roundtrip", () => {
  it("mints a token that verifies", async () => {
    const m = new RunTokenManager(broker());
    const t = await m.mint("run-1");
    const r = await m.verify(t.raw, "run-1");
    expect(r.ok).toBe(true);
  });

  it("rejects wrong runId", async () => {
    const m = new RunTokenManager(broker());
    const t = await m.mint("run-1");
    const r = await m.verify(t.raw, "run-2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("run_id_mismatch");
  });

  it("rejects expired token", async () => {
    const m = new RunTokenManager(broker());
    const t = await m.mint("run-1", 1000);
    const r = await m.verify(t.raw, "run-1", 1000 + 31 * 60 * 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("expired");
  });

  it("rejects malformed input", async () => {
    const m = new RunTokenManager(broker());
    expect((await m.verify("nope", "run-1")).ok).toBe(false);
    expect((await m.verify("a.b", "run-1")).ok).toBe(false);
    expect((await m.verify(undefined, "run-1")).ok).toBe(false);
  });

  it("rejects bad signature", async () => {
    const m = new RunTokenManager(broker());
    const t = await m.mint("run-1");
    const tampered = t.raw.replace(/.{8}$/, "deadbeef");
    const r = await m.verify(tampered, "run-1");
    expect(r.ok).toBe(false);
  });

  it("rotateKey invalidates prior tokens", async () => {
    const fb = new FakeStore();
    const m = new RunTokenManager(broker(fb));
    const t = await m.mint("run-1");
    await m.rotateKey();
    const r = await m.verify(t.raw, "run-1");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed when expiresAt is non-numeric", async () => {
    // Hits the `Number.isFinite(expiresAt)` guard at line 83. The token
    // splits into 3 parts, but the middle component fails Number coercion.
    const m = new RunTokenManager(broker());
    const r = await m.verify("run-1.notanumber.aabbcc", "run-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("malformed");
  });

  it("rejects bad_signature when sig is empty hex (zero-length buffer)", async () => {
    // Hits the `ab.length === 0` branch in `constantTimeEquals` (line 100).
    // We craft a token with a valid runId, in-window expiry, and an empty
    // signature segment so Buffer.from(...).length === 0.
    const m = new RunTokenManager(broker());
    // Mint just to seed the HMAC key in the fake store (so verify uses
    // the same key path), then forge a token with empty sig.
    await m.mint("run-1", 1000);
    const future = 1000 + 10 * 60 * 1000;
    const forged = `run-1.${future}.`;
    const r = await m.verify(forged, "run-1", 1000);
    expect(r.ok).toBe(false);
    // Splitting on `.` on `"a.b."` yields ["a","b",""], length 3 — passes
    // the malformed gate, then fails at constantTimeEquals.
    if (!r.ok) expect(r.error).toBe("bad_signature");
  });
});

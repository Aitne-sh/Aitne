// P22 §3.4 — one-time HMAC-signed run tokens for the skill-curation
// optimizer.
//
// The token's only consumer is the `POST /api/skill-curation/proposals`
// chokepoint. It binds:
//   - runId
//   - issued-at  (ms since epoch)
//   - expiry     (issued-at + 30 min)
//
// `mintRunToken` lazily generates an HMAC key in the keychain and returns
// the signed `<runId>.<expiresAt>.<signature>` triple. `verifyRunToken`
// validates the signature, the runId match, and the expiry.
//
// Tokens are not stored anywhere — the chokepoint is stateless. A single
// runId is therefore not "single-use" in the strict sense; it's "single
// run" — the run lifecycle (workdir provision → finalize → teardown)
// invalidates the token by destroying its workdir, and the API re-checks
// `skill_curation_runs.status='running'` before accepting a proposal.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "../../secrets/secret-store.js";

// `InternalSecretName` lives outside the SecretBroker's typed accessors
// (which are scoped to user-visible secrets) — we go through SecretStore
// directly, the same as `encrypted-blob-store.ts` does for its master key.
const KEY_NAME = "skillCurationRunTokenKey" as const;

const TOKEN_TTL_MS = 30 * 60 * 1000;
const KEY_LENGTH = 32;

export interface RunToken {
  raw: string;
  runId: string;
  expiresAt: number;
}

export interface VerifiedRunToken {
  runId: string;
  expiresAt: number;
}

export type RunTokenError =
  | "missing_token"
  | "malformed"
  | "expired"
  | "bad_signature"
  | "run_id_mismatch";

export class RunTokenManager {
  constructor(private readonly secretStore: SecretStore) {}

  async ensureKey(): Promise<string> {
    const existing = await this.secretStore.get(KEY_NAME);
    if (existing) return existing;
    const fresh = randomBytes(KEY_LENGTH).toString("hex");
    await this.secretStore.set(KEY_NAME, fresh);
    return fresh;
  }

  /** Force-rotate the HMAC key. Useful after suspected compromise. */
  async rotateKey(): Promise<void> {
    const fresh = randomBytes(KEY_LENGTH).toString("hex");
    await this.secretStore.set(KEY_NAME, fresh);
  }

  async mint(runId: string, now: number = Date.now()): Promise<RunToken> {
    const key = await this.ensureKey();
    const expiresAt = now + TOKEN_TTL_MS;
    const sig = sign(key, `${runId}.${expiresAt}`);
    return { raw: `${runId}.${expiresAt}.${sig}`, runId, expiresAt };
  }

  async verify(
    raw: string | undefined | null,
    expectedRunId: string,
    now: number = Date.now(),
  ): Promise<{ ok: true; token: VerifiedRunToken } | { ok: false; error: RunTokenError }> {
    if (!raw) return { ok: false, error: "missing_token" };
    const parts = raw.split(".");
    if (parts.length !== 3) return { ok: false, error: "malformed" };
    const [runId, expiresAtStr, sig] = parts;
    const expiresAt = Number(expiresAtStr);
    if (!Number.isFinite(expiresAt)) return { ok: false, error: "malformed" };
    if (runId !== expectedRunId) return { ok: false, error: "run_id_mismatch" };
    if (expiresAt < now) return { ok: false, error: "expired" };
    const key = await this.ensureKey();
    const expected = sign(key, `${runId}.${expiresAt}`);
    if (!constantTimeEquals(sig, expected)) return { ok: false, error: "bad_signature" };
    return { ok: true, token: { runId, expiresAt } };
  }
}

function sign(key: string, body: string): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update(body).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

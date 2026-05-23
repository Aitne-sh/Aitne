import { describe, expect, it } from "vitest";

import {
  APPROVAL_TOKEN_BYTES,
  APPROVAL_TOKEN_REGEX,
  APPROVAL_TTL_MS,
  classifyApprovalValidation,
  computeApprovalExpiry,
  hashApprovalToken,
  isApprovalExpired,
  mintApprovalToken,
  tokenHashEquals,
  type ApprovalRowView,
} from "./approval-tokens.js";

describe("approval-tokens", () => {
  describe("constants", () => {
    it("APPROVAL_TTL_MS is 5 minutes", () => {
      expect(APPROVAL_TTL_MS).toBe(5 * 60 * 1000);
    });

    it("APPROVAL_TOKEN_BYTES is 16 (128 bits)", () => {
      expect(APPROVAL_TOKEN_BYTES).toBe(16);
    });

    it("APPROVAL_TOKEN_REGEX matches 32 lowercase hex chars", () => {
      expect(APPROVAL_TOKEN_REGEX.test("00112233445566778899aabbccddeeff")).toBe(
        true,
      );
      expect(APPROVAL_TOKEN_REGEX.test("0011223344556677")).toBe(false);
      expect(APPROVAL_TOKEN_REGEX.test("00112233445566778899AABBCCDDEEFF")).toBe(
        false,
      );
    });
  });

  describe("mintApprovalToken", () => {
    it("returns a 32-hex-char token", () => {
      const t = mintApprovalToken();
      expect(t).toMatch(/^[0-9a-f]{32}$/);
      expect(t.length).toBe(32);
    });

    it("produces distinct tokens on repeated calls", () => {
      const set = new Set<string>();
      for (let i = 0; i < 50; i++) set.add(mintApprovalToken());
      expect(set.size).toBe(50);
    });
  });

  describe("hashApprovalToken", () => {
    it("hashes deterministically", () => {
      const t = "00112233445566778899aabbccddeeff";
      expect(hashApprovalToken(t)).toBe(hashApprovalToken(t));
    });

    it("produces a 64-hex SHA-256 hash", () => {
      expect(hashApprovalToken("anything").length).toBe(64);
      expect(hashApprovalToken("anything")).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different hashes for different tokens", () => {
      const a = hashApprovalToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      const b = hashApprovalToken("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(a).not.toBe(b);
    });
  });

  describe("tokenHashEquals", () => {
    it("returns true for identical hex strings", () => {
      const h = hashApprovalToken("a token");
      expect(tokenHashEquals(h, h)).toBe(true);
    });

    it("returns false for different hashes", () => {
      const a = hashApprovalToken("x");
      const b = hashApprovalToken("y");
      expect(tokenHashEquals(a, b)).toBe(false);
    });

    it("returns false for non-string inputs", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(tokenHashEquals(null as any, "abc")).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(tokenHashEquals("abc", undefined as any)).toBe(false);
    });

    it("returns false for length mismatch", () => {
      expect(tokenHashEquals("aa", "aabb")).toBe(false);
    });

    it("returns false for non-hex input", () => {
      expect(tokenHashEquals("zz", "aa")).toBe(false);
    });
  });

  describe("computeApprovalExpiry", () => {
    it("returns nowMs + APPROVAL_TTL_MS", () => {
      expect(computeApprovalExpiry(1000)).toBe(1000 + APPROVAL_TTL_MS);
    });

    it("throws on negative input", () => {
      expect(() => computeApprovalExpiry(-1)).toThrow();
    });

    it("throws on non-finite input", () => {
      expect(() => computeApprovalExpiry(Number.NaN)).toThrow();
      expect(() => computeApprovalExpiry(Number.POSITIVE_INFINITY)).toThrow();
    });
  });

  describe("isApprovalExpired", () => {
    it("returns false for terminal rows regardless of expires_at", () => {
      expect(
        isApprovalExpired(
          { status: "consumed", expiresAt: 0 },
          Date.now(),
        ),
      ).toBe(false);
      expect(
        isApprovalExpired({ status: "denied", expiresAt: 0 }, Date.now()),
      ).toBe(false);
      expect(
        isApprovalExpired({ status: "expired", expiresAt: 0 }, Date.now()),
      ).toBe(false);
    });

    it("returns true for pending past expires_at", () => {
      expect(
        isApprovalExpired({ status: "pending", expiresAt: 100 }, 200),
      ).toBe(true);
    });

    it("returns false for pending before expires_at", () => {
      expect(
        isApprovalExpired({ status: "pending", expiresAt: 200 }, 100),
      ).toBe(false);
    });

    it("returns true for approved past expires_at (token never redeemed)", () => {
      expect(
        isApprovalExpired({ status: "approved", expiresAt: 100 }, 200),
      ).toBe(true);
    });
  });

  describe("classifyApprovalValidation", () => {
    const baseRow: ApprovalRowView = {
      id: "row-id",
      workflowName: "subscribeToNewsletter",
      paramsHash: "abcd1234",
      status: "approved",
      expiresAt: 1_000_000,
      tokenHash: hashApprovalToken("00112233445566778899aabbccddeeff"),
    };

    it("rejects malformed tokens before any DB lookup", () => {
      const r = classifyApprovalValidation({
        token: "too-short",
        expectedWorkflowName: baseRow.workflowName,
        expectedParamsHash: baseRow.paramsHash,
        row: baseRow,
        nowMs: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("token_shape_invalid");
    });

    it("returns row_not_found when no row resolved", () => {
      const r = classifyApprovalValidation({
        token: "00112233445566778899aabbccddeeff",
        expectedWorkflowName: baseRow.workflowName,
        expectedParamsHash: baseRow.paramsHash,
        row: null,
        nowMs: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("row_not_found");
    });

    it("returns wrong_status when the row is not approved", () => {
      const r = classifyApprovalValidation({
        token: "00112233445566778899aabbccddeeff",
        expectedWorkflowName: baseRow.workflowName,
        expectedParamsHash: baseRow.paramsHash,
        row: { ...baseRow, status: "consumed" },
        nowMs: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok && r.reason === "wrong_status") {
        expect(r.actualStatus).toBe("consumed");
      }
    });

    it("returns expired when nowMs > expires_at", () => {
      const r = classifyApprovalValidation({
        token: "00112233445566778899aabbccddeeff",
        expectedWorkflowName: baseRow.workflowName,
        expectedParamsHash: baseRow.paramsHash,
        row: baseRow,
        nowMs: baseRow.expiresAt + 1,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("expired");
    });

    it("returns workflow_mismatch when expected name differs", () => {
      const r = classifyApprovalValidation({
        token: "00112233445566778899aabbccddeeff",
        expectedWorkflowName: "differentWorkflow",
        expectedParamsHash: baseRow.paramsHash,
        row: baseRow,
        nowMs: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("workflow_mismatch");
    });

    it("returns params_mismatch when expected paramsHash differs", () => {
      const r = classifyApprovalValidation({
        token: "00112233445566778899aabbccddeeff",
        expectedWorkflowName: baseRow.workflowName,
        expectedParamsHash: "different",
        row: baseRow,
        nowMs: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("params_mismatch");
    });

    it("returns hash_mismatch when token_hash is missing on the row", () => {
      const r = classifyApprovalValidation({
        token: "00112233445566778899aabbccddeeff",
        expectedWorkflowName: baseRow.workflowName,
        expectedParamsHash: baseRow.paramsHash,
        row: { ...baseRow, tokenHash: null },
        nowMs: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("hash_mismatch");
    });

    it("returns hash_mismatch when the SHA-256 of the supplied token doesn't match", () => {
      const r = classifyApprovalValidation({
        token: "ffffffffffffffffffffffffffffffff",
        expectedWorkflowName: baseRow.workflowName,
        expectedParamsHash: baseRow.paramsHash,
        row: baseRow,
        nowMs: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("hash_mismatch");
    });

    it("returns ok on a valid token + row binding", () => {
      const r = classifyApprovalValidation({
        token: "00112233445566778899aabbccddeeff",
        expectedWorkflowName: baseRow.workflowName,
        expectedParamsHash: baseRow.paramsHash,
        row: baseRow,
        nowMs: 0,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.row).toBe(baseRow);
    });
  });
});

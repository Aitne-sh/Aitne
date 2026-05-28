/**
 * lite-final-confirm-tokens — pure-logic coverage.
 *
 * Targets §13 "final-confirm-handler.ts (new pure-logic helpers)" — Token
 * mint / single-use CAS / 5-min TTL / strict-cancel-on-non-token-reply
 * contract that mirrors the `purchase-handler` test shape. The CAS / DB
 * side is excluded from the coverage gate; the pure decision tree below
 * is the covered surface.
 */

import { describe, expect, it } from "vitest";

import {
  B4_TOKEN_REGEX,
  B4_TOKEN_TAIL_LENGTH,
  B4_TOKEN_TTL_MS,
} from "../managed-chromium/types.js";
import {
  classifyLiteFinalConfirmReply,
  computeLiteFinalConfirmExpiry,
  formatLiteFinalConfirmToken,
  hashReplyBody,
  isLiteFinalConfirmExpired,
  liteFinalConfirmTokenEquals,
  mintLiteFinalConfirmToken,
  mintLiteFinalConfirmTokenTail,
  parseLiteFinalConfirmToken,
  redactToken,
  type LiteFinalConfirmTokenRowView,
} from "./lite-final-confirm-tokens.js";

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function makeRow(
  overrides: Partial<LiteFinalConfirmTokenRowView> = {},
): LiteFinalConfirmTokenRowView {
  return {
    jti: "00000000-0000-4000-8000-000000000001",
    token: "!~ABCDEFGH",
    taskId: "task-1",
    status: "pending",
    issuedAt: 1000,
    expiresAt: 1000 + B4_TOKEN_TTL_MS,
    consumedAt: null,
    cancelledAt: null,
    deliveredChannels: ["slack:owner"],
    ...overrides,
  };
}

describe("mintLiteFinalConfirmTokenTail", () => {
  it("returns 8 base32 chars", () => {
    for (let i = 0; i < 64; i++) {
      const tail = mintLiteFinalConfirmTokenTail();
      expect(tail).toHaveLength(B4_TOKEN_TAIL_LENGTH);
      for (const ch of tail) {
        expect(ALPHA.includes(ch)).toBe(true);
      }
    }
  });
});

describe("formatLiteFinalConfirmToken", () => {
  it("prefixes with !~", () => {
    expect(formatLiteFinalConfirmToken("ABCDEFGH")).toBe("!~ABCDEFGH");
  });

  it("rejects wrong-length tail", () => {
    expect(() => formatLiteFinalConfirmToken("ABCDEFG")).toThrow(
      /exactly 8 chars/,
    );
  });

  it("rejects out-of-alphabet tail", () => {
    expect(() => formatLiteFinalConfirmToken("ABCDEF18")).toThrow(
      /base32/,
    );
  });
});

describe("mintLiteFinalConfirmToken", () => {
  it("emits a B4-shape token", () => {
    const tok = mintLiteFinalConfirmToken();
    expect(B4_TOKEN_REGEX.test(tok)).toBe(true);
  });
});

describe("computeLiteFinalConfirmExpiry", () => {
  it("adds the TTL", () => {
    expect(computeLiteFinalConfirmExpiry(1_000_000)).toBe(
      1_000_000 + B4_TOKEN_TTL_MS,
    );
  });

  it("rejects non-finite / negative input", () => {
    expect(() => computeLiteFinalConfirmExpiry(Number.NaN)).toThrow();
    expect(() => computeLiteFinalConfirmExpiry(-5)).toThrow();
  });
});

describe("parseLiteFinalConfirmToken", () => {
  it("returns trimmed token on match", () => {
    expect(parseLiteFinalConfirmToken("  !~ABCDEFGH ")).toBe("!~ABCDEFGH");
  });

  it("returns null on shape miss", () => {
    expect(parseLiteFinalConfirmToken("ABCDEFGH")).toBeNull();
    expect(parseLiteFinalConfirmToken("!~ABCDEFG1")).toBeNull();
    expect(parseLiteFinalConfirmToken("")).toBeNull();
  });

  it("returns null on non-string", () => {
    expect(parseLiteFinalConfirmToken(undefined as unknown as string)).toBeNull();
  });
});

describe("hashReplyBody", () => {
  it("is deterministic SHA-256 hex", () => {
    expect(hashReplyBody("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("liteFinalConfirmTokenEquals", () => {
  it("returns true for identical strings", () => {
    expect(liteFinalConfirmTokenEquals("!~ABCDEFGH", "!~ABCDEFGH")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(liteFinalConfirmTokenEquals("!~ABCDEFGH", "!~ABCDEFGI")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(liteFinalConfirmTokenEquals("!~AB", "!~ABCDEFGH")).toBe(false);
  });

  it("returns false for non-strings", () => {
    expect(
      liteFinalConfirmTokenEquals(undefined as unknown as string, "abc"),
    ).toBe(false);
  });
});

describe("redactToken", () => {
  it("preserves prefix + last 3", () => {
    expect(redactToken("!~ABCDEFGH")).toBe("!~****FGH");
  });

  it("returns sentinel for short strings", () => {
    expect(redactToken("abc")).toBe("<redacted>");
    expect(redactToken(undefined as unknown as string)).toBe("<redacted>");
  });
});

describe("classifyLiteFinalConfirmReply", () => {
  it("shape_invalid for non-token body", () => {
    expect(
      classifyLiteFinalConfirmReply({
        body: "hello",
        channelRef: "slack:owner",
        row: makeRow(),
        nowMs: 2000,
      }).kind,
    ).toBe("shape_invalid");
  });

  it("no_match when DB lookup returns null", () => {
    expect(
      classifyLiteFinalConfirmReply({
        body: "!~ABCDEFGH",
        channelRef: "slack:owner",
        row: null,
        nowMs: 2000,
      }).kind,
    ).toBe("no_match");
  });

  it("already_consumed when consumedAt is set", () => {
    const row = makeRow({ consumedAt: 1500 });
    expect(
      classifyLiteFinalConfirmReply({
        body: "!~ABCDEFGH",
        channelRef: "slack:owner",
        row,
        nowMs: 2000,
      }).kind,
    ).toBe("already_consumed");
  });

  it("already_cancelled when cancelledAt is set", () => {
    const row = makeRow({ cancelledAt: 1500 });
    expect(
      classifyLiteFinalConfirmReply({
        body: "!~ABCDEFGH",
        channelRef: "slack:owner",
        row,
        nowMs: 2000,
      }).kind,
    ).toBe("already_cancelled");
  });

  it("already_cancelled when status=cancelled even without ts", () => {
    const row = makeRow({ status: "cancelled" });
    expect(
      classifyLiteFinalConfirmReply({
        body: "!~ABCDEFGH",
        channelRef: "slack:owner",
        row,
        nowMs: 2000,
      }).kind,
    ).toBe("already_cancelled");
  });

  it("expired when nowMs > expiresAt", () => {
    const row = makeRow({ expiresAt: 1500 });
    expect(
      classifyLiteFinalConfirmReply({
        body: "!~ABCDEFGH",
        channelRef: "slack:owner",
        row,
        nowMs: 2000,
      }).kind,
    ).toBe("expired");
  });

  it("expired when status=expired", () => {
    const row = makeRow({ status: "expired" });
    expect(
      classifyLiteFinalConfirmReply({
        body: "!~ABCDEFGH",
        channelRef: "slack:owner",
        row,
        nowMs: 1100,
      }).kind,
    ).toBe("expired");
  });

  it("wrong_channel when channelRef is not in deliveredChannels", () => {
    expect(
      classifyLiteFinalConfirmReply({
        body: "!~ABCDEFGH",
        channelRef: "slack:other",
        row: makeRow(),
        nowMs: 1100,
      }).kind,
    ).toBe("wrong_channel");
  });

  it("consume on the happy path", () => {
    const result = classifyLiteFinalConfirmReply({
      body: "!~ABCDEFGH",
      channelRef: "slack:owner",
      row: makeRow(),
      nowMs: 1100,
    });
    expect(result.kind).toBe("consume");
    if (result.kind === "consume") {
      expect(result.row.jti).toBe("00000000-0000-4000-8000-000000000001");
    }
  });
});

describe("isLiteFinalConfirmExpired", () => {
  it("false for non-pending status", () => {
    expect(
      isLiteFinalConfirmExpired(
        { status: "confirmed", expiresAt: 0, consumedAt: 1, cancelledAt: null },
        100,
      ),
    ).toBe(false);
  });

  it("false when already consumed", () => {
    expect(
      isLiteFinalConfirmExpired(
        { status: "pending", expiresAt: 0, consumedAt: 5, cancelledAt: null },
        100,
      ),
    ).toBe(false);
  });

  it("false when already cancelled", () => {
    expect(
      isLiteFinalConfirmExpired(
        { status: "pending", expiresAt: 0, consumedAt: null, cancelledAt: 5 },
        100,
      ),
    ).toBe(false);
  });

  it("true when pending + expiry passed", () => {
    expect(
      isLiteFinalConfirmExpired(
        {
          status: "pending",
          expiresAt: 100,
          consumedAt: null,
          cancelledAt: null,
        },
        200,
      ),
    ).toBe(true);
  });

  it("false when pending + expiry in future", () => {
    expect(
      isLiteFinalConfirmExpired(
        {
          status: "pending",
          expiresAt: 200,
          consumedAt: null,
          cancelledAt: null,
        },
        100,
      ),
    ).toBe(false);
  });
});

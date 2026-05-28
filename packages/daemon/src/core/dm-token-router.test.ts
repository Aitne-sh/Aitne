import { describe, expect, it } from "vitest";

import {
  decideTokenReplyRoute,
  type TokenIssueRowView,
} from "./dm-token-router.js";

function view(issuedAt: number): TokenIssueRowView {
  return { issuedAt };
}

describe("decideTokenReplyRoute", () => {
  it("returns none when neither store matched", () => {
    expect(
      decideTokenReplyRoute({ purchaseRow: null, liteRow: null }),
    ).toEqual({ kind: "none" });
  });

  it("routes to purchase when only purchase matched", () => {
    expect(
      decideTokenReplyRoute({ purchaseRow: view(100), liteRow: null }),
    ).toEqual({ kind: "purchase" });
  });

  it("routes to lite_final_confirm when only lite matched", () => {
    expect(
      decideTokenReplyRoute({ purchaseRow: null, liteRow: view(100) }),
    ).toEqual({ kind: "lite_final_confirm" });
  });

  it("prefers purchase when both matched and purchase is older", () => {
    expect(
      decideTokenReplyRoute({ purchaseRow: view(100), liteRow: view(200) }),
    ).toEqual({ kind: "purchase" });
  });

  it("prefers lite_final_confirm when both matched and lite is older", () => {
    expect(
      decideTokenReplyRoute({ purchaseRow: view(300), liteRow: view(100) }),
    ).toEqual({ kind: "lite_final_confirm" });
  });

  it("breaks an exact-millisecond tie in favour of purchase (left-hand stable rule)", () => {
    expect(
      decideTokenReplyRoute({ purchaseRow: view(100), liteRow: view(100) }),
    ).toEqual({ kind: "purchase" });
  });
});

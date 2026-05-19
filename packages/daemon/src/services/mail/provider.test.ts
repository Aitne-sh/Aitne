import { describe, it, expect } from "vitest";
import { mailAccountBlobName, MailOperationNotSupportedError } from "./provider.js";

describe("mailAccountBlobName", () => {
  it.each([
    ["gmail", "gmail-abc", "mail:gmail:gmail-abc"],
    ["outlook", "outlook-7c3a", "mail:outlook:outlook-7c3a"],
    ["yahoo", "yahoo-xyz", "mail:yahoo:yahoo-xyz"],
    ["icloud", "icloud-1", "mail:icloud:icloud-1"],
  ] as const)("composes blob name for %s", (kind, accountId, expected) => {
    expect(mailAccountBlobName(kind, accountId)).toBe(expected);
  });
});

describe("MailOperationNotSupportedError", () => {
  it("constructs message without reason", () => {
    const err = new MailOperationNotSupportedError("gmail", "draft_mutation");
    expect(err.message).toBe("gmail: draft_mutation not supported");
    expect(err.name).toBe("MailOperationNotSupportedError");
    expect(err.httpStatus).toBe(501);
    expect(err.code).toBe("not_implemented");
  });

  it("constructs message with reason", () => {
    const err = new MailOperationNotSupportedError("yahoo", "mutation", "read-only account");
    expect(err.message).toBe("yahoo: mutation not supported — read-only account");
  });
});

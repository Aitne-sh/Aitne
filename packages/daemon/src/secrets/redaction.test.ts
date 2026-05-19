import { describe, it, expect } from "vitest";
import { redactString } from "./redaction.js";

describe("redaction re-export", () => {
  it("redacts known token patterns in strings", () => {
    expect(redactString("token xoxb-secret-value")).toContain("[REDACTED]");
    expect(redactString("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
    expect(redactString("X-Read-Token: 0qrNdOODwrYYkyaVNeTaVjWbNt4LqKx6")).toContain("[REDACTED]");
  });
});

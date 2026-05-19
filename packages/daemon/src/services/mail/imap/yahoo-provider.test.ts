import { describe, expect, it } from "vitest";
import { buildImapAccountSecret } from "./app-password.js";
import { YahooImapProvider } from "./yahoo-provider.js";
import type { MailAccount } from "../provider.js";

function makeAccount(): MailAccount {
  return {
    id: "yahoo-acct",
    kind: "yahoo",
    email: "owner@yahoo.example.com",
    authStatus: "healthy",
    idleEnabled: true,
    active: true,
    createdAt: "2026-04-16T12:00:00.000Z",
  };
}

describe("YahooImapProvider", () => {
  it("declares yahoo kind and carries account/secret wiring", () => {
    const provider = new YahooImapProvider({
      account: makeAccount(),
      secret: buildImapAccountSecret(
        "yahoo",
        "owner@yahoo.example.com",
        "secret",
      ),
    });
    expect(provider.kind).toBe("yahoo");
    expect(provider.account.email).toBe("owner@yahoo.example.com");
    expect(provider.getCapabilities()).toBeNull();
  });
});

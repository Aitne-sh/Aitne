import { describe, expect, it } from "vitest";
import { buildImapAccountSecret } from "./app-password.js";
import { ICloudImapProvider } from "./icloud-provider.js";
import type { MailAccount } from "../provider.js";

function makeAccount(): MailAccount {
  return {
    id: "icloud-acct",
    kind: "icloud",
    email: "owner@icloud.example.com",
    authStatus: "healthy",
    idleEnabled: true,
    active: true,
    createdAt: "2026-04-16T12:00:00.000Z",
  };
}

describe("ICloudImapProvider", () => {
  it("declares icloud kind and uses the iCloud app-password preset", () => {
    const secret = buildImapAccountSecret(
      "icloud",
      "owner@icloud.example.com",
      "secret",
    );
    // iCloud IMAP/SMTP presets per §6.2; the subclass should consume them
    // via the base class without overriding anything.
    expect(secret.imap.host).toBe("imap.mail.me.com");
    expect(secret.smtp.host).toBe("smtp.mail.me.com");
    expect(secret.folderHints.sent).toBe("Sent Messages");
    expect(secret.folderHints.trash).toBe("Deleted Messages");

    const provider = new ICloudImapProvider({
      account: makeAccount(),
      secret,
    });
    expect(provider.kind).toBe("icloud");
    expect(provider.account.kind).toBe("icloud");
  });
});

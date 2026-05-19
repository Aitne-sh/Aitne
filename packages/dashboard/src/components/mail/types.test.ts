import { describe, it, expect } from "vitest";
import { deriveCardStatus } from "./types";
import type { MailAccount } from "./types";

function acct(
  overrides: Partial<MailAccount> = {},
): MailAccount {
  return {
    id: "id-1",
    kind: "yahoo",
    email: "owner@example.com",
    authStatus: "healthy",
    idleEnabled: true,
    active: true,
    createdAt: "2026-04-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveCardStatus", () => {
  it("returns 'not-connected' when no accounts and no out-of-band setup pending", () => {
    expect(
      deriveCardStatus({ accounts: [], enabled: false }),
    ).toBe("not-connected");
  });

  it("returns 'needs-setup' when no accounts and provider awaits setup", () => {
    expect(
      deriveCardStatus({
        accounts: [],
        enabled: false,
        awaitingProviderSetup: true,
      }),
    ).toBe("needs-setup");
  });

  it("returns 'disabled' when accounts authenticated but kind not enabled", () => {
    expect(
      deriveCardStatus({ accounts: [acct()], enabled: false }),
    ).toBe("disabled");
  });

  it("returns 'enabled' when all accounts healthy and kind enabled", () => {
    expect(
      deriveCardStatus({
        accounts: [acct(), acct({ id: "id-2" })],
        enabled: true,
      }),
    ).toBe("enabled");
  });

  it("returns 'attention' when any account requires consent — even if disabled", () => {
    // Important: attention wins over disabled so the user can see and act.
    expect(
      deriveCardStatus({
        accounts: [
          acct(),
          acct({ id: "id-2", authStatus: "requires_consent" }),
        ],
        enabled: false,
      }),
    ).toBe("attention");
  });

  it("returns 'attention' when any account is degraded — even if enabled", () => {
    expect(
      deriveCardStatus({
        accounts: [acct({ authStatus: "degraded" })],
        enabled: true,
      }),
    ).toBe("attention");
  });

  it("'enabled' requires accounts.length > 0", () => {
    // accounts=[] + enabled=true does NOT mean enabled — there's nothing to
    // run. The toggle in the UI is independently disabled in this state.
    expect(
      deriveCardStatus({ accounts: [], enabled: true }),
    ).toBe("not-connected");
  });

  it("'awaitingProviderSetup' is ignored once accounts exist", () => {
    expect(
      deriveCardStatus({
        accounts: [acct()],
        enabled: true,
        awaitingProviderSetup: true,
      }),
    ).toBe("enabled");
  });
});

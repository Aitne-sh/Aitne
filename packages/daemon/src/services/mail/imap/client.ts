import { ImapFlow } from "imapflow";
import type { ImapAccountSecret } from "./app-password.js";
import { probeCapabilities, type ImapCapabilitySet } from "./capabilities.js";

const DEFAULT_MAX_IDLE_TIME_MS = 29 * 60 * 1000;

export function createImapFlowClient(
  secret: ImapAccountSecret,
  overrides: Record<string, unknown> = {},
): InstanceType<typeof ImapFlow> {
  return new ImapFlow({
    host: secret.imap.host,
    port: secret.imap.port,
    secure: secret.imap.secure,
    auth: {
      user: secret.email,
      pass: secret.appPassword,
      // No loginMethod: let ImapFlow negotiate the best mechanism the server
      // advertises. Yahoo Mail only supports LOGIN (not AUTH=PLAIN), so
      // forcing AUTH=PLAIN causes a transient connection failure.
    },
    disableAutoIdle: true,
    maxIdleTime: DEFAULT_MAX_IDLE_TIME_MS,
    // Enable QRESYNC so `expunge` events carry UIDs (not sequence numbers)
    // when the server advertises the extension. Safe on non-QRESYNC
    // servers — ImapFlow just doesn't ENABLE the extension and falls back.
    // This is what makes Phase 7's real-time VANISHED path work.
    qresync: true,
    ...overrides,
  });
}

/**
 * Smoke-tests IMAP credentials and returns the server's advertised
 * capabilities. ImapFlow populates `.capabilities` during the pre-auth
 * CAPABILITY exchange, so the result is available synchronously after
 * `connect()` resolves — before the server drops the connection under
 * `verifyOnly`. The returned set is persisted alongside the new account row
 * so Phase 7 readers see capability data from the first moment the account
 * exists, not only after the first real poll tick.
 */
export async function verifyImapAccountSecret(
  secret: ImapAccountSecret,
): Promise<ImapCapabilitySet> {
  const client = createImapFlowClient(secret, {
    verifyOnly: true,
    includeMailboxes: true,
    // Fail fast if the server stalls mid-auth. Without this, ImapFlow's
    // 5-minute default socket timeout fires on the orphaned connection long
    // after connect() has already thrown, crashing the daemon.
    socketTimeout: 15_000,
  });
  // Register an error listener BEFORE connect() so that any background
  // error event emitted by the orphaned socket (e.g. the socketTimeout
  // above) is silently swallowed instead of becoming an uncaught exception
  // that kills the daemon process.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (err) {
    // Force-close the socket immediately so the socketTimeout doesn't fire
    // at all on failed authentication attempts.
    client.close();
    throw err;
  }
  return probeCapabilities(
    (client as unknown as { capabilities?: unknown }).capabilities as
      | Iterable<string>
      | Map<string, unknown>
      | null
      | undefined,
  );
}

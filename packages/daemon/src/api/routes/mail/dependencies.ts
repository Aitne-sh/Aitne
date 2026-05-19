import type Database from "better-sqlite3";
import type { AgentConfig } from "../../../config.js";
import type { ServiceRegistry } from "../../../services/service-registry.js";
import type { SettingsStore } from "../../../settings/settings-store.js";
import type { AgentWriteTracker } from "../../../safety/agent-write-tracker.js";
import type { EncryptedBlobStore } from "../../../secrets/encrypted-blob-store.js";
import type { ImapAccountSecret } from "../../../services/mail/imap/app-password.js";
import type { verifyImapAccountSecret } from "../../../services/mail/imap/client.js";

export interface MailRouteDependencies {
  db: Database.Database;
  config: AgentConfig;
  services: ServiceRegistry;
  /**
   * Required to read/write the Outlook BYOA client config blob and to support
   * future provider blobs. Optional only because Phase 1 routes that don't
   * touch blobs would still work without it; Phase 2 routes return 503 when
   * absent.
   */
  blobStore?: EncryptedBlobStore;
  settingsStore?: SettingsStore;
  verifyImapAccountSecret?: (
    secret: ImapAccountSecret,
  ) => Promise<Awaited<ReturnType<typeof verifyImapAccountSecret>>>;
  /**
   * Shared write tracker — used by send/modify/trash routes so the unified
   * mail-poller suppresses messages the agent just touched (§3.2). Optional
   * for tests that construct mail routes in isolation.
   */
  writeTracker?: AgentWriteTracker;
  /**
   * Fired when the set of enabled mail providers or active accounts changes
   * (toggle, remove, re-consent). Optional; the daemon wires this to wake up
   * the unified poller so new accounts start being observed immediately
   * without waiting for the next scheduled tick.
   */
  onMailScopeChanged?: (reason: string) => void;
}

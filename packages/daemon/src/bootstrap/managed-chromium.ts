/**
 * Boot-time wiring for the managed Chromium supervisor.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.1.
 *
 * - Reads the persisted `enabled` flag from runtime_state.
 * - Resolves the host's sandbox primitive + Chromium binary.
 * - Registers `ManagedChromiumSupervisor` with the daemon's
 *   ObserverManager so it ticks alongside the other observers.
 *
 * Idempotent: if managed mode is disabled, this is a no-op. If enabled
 * but the binary or sandbox is unavailable, the supervisor still
 * registers (so the dashboard can surface the diagnostic) and writes
 * the appropriate state-machine value into runtime_state.
 */

import type Database from "better-sqlite3";

import type { AgentConfig } from "../config.js";
import { createLogger } from "../logging.js";
import type { MessageHub } from "../adapters/message-hub.js";
import type { ObserverManager } from "../observers/manager.js";
import {
  readManagedChromiumState,
  updateManagedChromiumState,
} from "../db/managed-chromium-state.js";
import { createHostProfile } from "../services/browser-history/lifecycle/platform.js";
import { ManagedChromiumSupervisor } from "../services/browser-history/managed-chromium/managed-chromium-supervisor.js";

const logger = createLogger("bootstrap-managed-chromium");

export interface ManagedChromiumBootDeps {
  db: Database.Database;
  config: AgentConfig;
  observerManager: ObserverManager;
  messageHub: MessageHub | null;
}

export async function maybeRegisterManagedChromium(
  deps: ManagedChromiumBootDeps,
): Promise<void> {
  const state = readManagedChromiumState(deps.db);
  if (!state.enabled) {
    logger.info("managed Chromium disabled; supervisor not registered");
    return;
  }
  const host = createHostProfile();
  // Pre-flight: re-evaluate infra readiness on every boot so the state
  // machine recovers from a prior `missing_binary` / `missing_sandbox`
  // automatically (e.g. operator installed Chromium / bwrap between
  // boots). Persisted `state` is allowed to advance freely between
  // diagnostic states; transitions out of `ready` / `needs_reauth` only
  // happen when the infra actually regressed.
  const hasBinary = host.browserBinaryFor("chromium") !== null;
  const hasSandbox = host.sandboxPrimitive.kind !== "none" || state.unsandboxedOptIn;
  updateManagedChromiumState(deps.db, (draft) => {
    if (!hasBinary) {
      draft.state = "missing_binary";
    } else if (!hasSandbox) {
      draft.state = "missing_sandbox";
    } else if (
      draft.state === "off"
      || draft.state === "disconnected"
      || draft.state === "missing_binary"
      || draft.state === "missing_sandbox"
    ) {
      // Infra is satisfied AND prior state was a diagnostic dead-end —
      // graduate to needs_setup so the dashboard prompts the user. If
      // the profile dir actually already contains a signed-in session,
      // the supervisor's first tick will resolve to `ready` via the
      // reauth-detector's healthy branch.
      draft.state = "needs_setup";
    }
  });

  const supervisor = new ManagedChromiumSupervisor({
    db: deps.db,
    paDataDir: deps.config.dataDir,
    host,
    messageHub: deps.messageHub,
  });
  deps.observerManager.register(supervisor);
  logger.info(
    {
      sandboxKind: host.sandboxPrimitive.kind,
      binaryFound: host.browserBinaryFor("chromium") !== null,
    },
    "managed Chromium supervisor registered",
  );
}

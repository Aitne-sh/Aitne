/**
 * CDP-layer network interception for Instance A workflows.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.2 / §8.6.
 *
 * Defence-in-depth ring 3 (innermost): the OS sandbox primitive is the
 * outer ring; Chromium's own renderer sandbox is ring 2; this Playwright
 * `context.route("**\/*")` handler is the per-workflow positive selector
 * + global negative selector.
 *
 * The handler runs on every outbound request originating from a page
 * that the workflow's Playwright context creates:
 *
 *   1. Global hostname / CIDR denylist (§8.6) — block immediately and
 *      record the blocked-request URL in the workflow's counter.
 *   2. Per-workflow allowlist (declared by the workflow's
 *      `allowlistRegex`) — `route.continue()` on match.
 *   3. Default — block. Deny-on-unknown.
 *
 * Each blocked request is counted per workflow so the supervisor (§9.4)
 * can pause the automation surface when blocked-counts spike.
 *
 * Excluded from the 100% coverage gate — calls into the Playwright
 * `BrowserContext.route` async path which the test suite cannot exercise
 * without booting a real Chromium. The pure decision logic in
 * `egress-denylist.ts` IS covered, which is the safety-critical bit.
 */

import { lookup as dnsLookup } from "node:dns/promises";

import { createLogger } from "../../../logging.js";
import {
  matchesHostnameDenylist,
  shouldDenyEgress,
} from "./egress-denylist.js";

const logger = createLogger("browser-automation-cdp-interception");

/** Per-workflow blocked-request counter. The runner reads this at
 *  cleanup time and persists the list into
 *  `browser_automation_workflows.blocked_requests`. */
export interface BlockedRequestRecorder {
  record(url: string, reason: "denylist" | "not_allowlisted"): void;
  list(): readonly string[];
}

export function makeBlockedRequestRecorder(): BlockedRequestRecorder {
  const items: string[] = [];
  return {
    record(url, reason): void {
      // Cap per-workflow to 200 entries — anything beyond that is a
      // run-away page and the supervisor's compromise-detection signal
      // (§9.4 "Blocked-request count >100 per workflow → abort") fires
      // off the counter, not the list itself.
      if (items.length >= 200) return;
      items.push(`${reason}:${url}`);
    },
    list(): readonly string[] {
      return items;
    },
  };
}

export interface CdpInterceptionOptions {
  workflowId: string;
  /** Per-workflow positive selector. */
  allowlistRegex: RegExp;
  /** Where to record blocked URLs for the audit row. */
  recorder: BlockedRequestRecorder;
  /** DNS resolver — injected so tests can stub. Production wires
   *  `dns.promises.lookup`. */
  resolveIps?: (hostname: string) => Promise<readonly string[]>;
}

/**
 * Install the per-request route handler on the given Playwright
 * `BrowserContext`. Returns a noop — `context.close()` will unwind the
 * handler so callers do not need to detach it.
 *
 * Typed against `unknown` so this file does not transitively pull
 * `playwright-core` types into modules that import it for the pure
 * helpers above; the structural cast happens at the route-install
 * boundary.
 */
export async function applyCDPInterception(
  context: unknown,
  opts: CdpInterceptionOptions,
): Promise<void> {
  const resolveIps =
    opts.resolveIps
    ?? (async (hostname: string) => {
      const addresses = await dnsLookup(hostname, { all: true });
      return addresses.map((a) => a.address);
    });

  await (context as {
    route: (
      url: string,
      handler: (route: PlaywrightRouteLike) => Promise<void> | void,
    ) => Promise<void>;
  }).route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      opts.recorder.record(url, "denylist");
      await route.abort("blockedbyclient");
      return;
    }

    // Fast-path hostname denylist BEFORE the async DNS leg — most
    // attacks we care about (payment processors, banking) hit by name.
    if (matchesHostnameDenylist(parsed.hostname)) {
      opts.recorder.record(url, "denylist");
      await route.abort("blockedbyclient");
      return;
    }

    const decision = await shouldDenyEgress(url, { resolveIps });
    if (decision.denied) {
      opts.recorder.record(url, "denylist");
      await route.abort("blockedbyclient");
      return;
    }

    if (opts.allowlistRegex.test(url)) {
      await route.continue();
      return;
    }

    opts.recorder.record(url, "not_allowlisted");
    await route.abort("blockedbyclient");
  });

  logger.debug(
    { workflowId: opts.workflowId },
    "CDP interception installed for workflow",
  );
}

interface PlaywrightRouteLike {
  request(): { url(): string };
  abort(errorCode: string): Promise<void>;
  continue(): Promise<void>;
}

import type { MiddlewareHandler } from "hono";
import type Database from "better-sqlite3";
import {
  INTEGRATION_DESCRIPTORS,
  type IntegrationDescriptor,
  type IntegrationKey,
} from "@aitne/shared";
import { readIntegrations } from "../db/integrations-store.js";

/**
 * Integration delegation framework — registry-driven 410 middleware (§4.5.2).
 *
 * For each request, resolves the URL path to its governing integration via
 * the registry's `apiRoutesTouched` field. The mode at the time of the
 * request determines the gate's verdict:
 *
 *   - `direct`    — pass through to the route handler.
 *   - `delegated` — 410 with `X-Integration-Mode: delegated`. Skill prose
 *                   directs the agent to native MCP (same-backend) or to
 *                   `POST /api/integrations/:key/exec` (cross-backend);
 *                   this 410 interdicts hallucinated calls to legacy paths.
 *   - `native`    — 410 with `X-Integration-Mode: native`
 *                   (INTEGRATION_NATIVE_MODE_DESIGN.md §3.1, §9.1, §9.2).
 *                   The agent reaches the connector exclusively via the
 *                   main backend's native MCP; the daemon does not proxy.
 *   - `disabled`  — 410 with `X-Integration-Mode: disabled`. The agent's
 *                   skill body / task-flow omit the integration entirely;
 *                   this 410 catches stray references in inherited prompts.
 *
 * Multi-provider routes (Gmail under `/api/mail/*`) are explicitly NOT
 * gated here — `gmail.apiRoutesTouched` is empty because prefix matching
 * would also block iCloud / Outlook / IMAP accounts. Those routes do
 * per-account 410s inside their handlers (DELEGATED-MODE-V2-DESIGN.md
 * §6.3).
 *
 * Resolution rule: the longest matching `apiRoutesTouched` prefix wins.
 * That keeps future surgical paths like `/api/calendar/admin` ahead of
 * a coarser `/api/calendar` if both ever coexist for different
 * integrations.
 */

export interface IntegrationRouteGateOptions {
  db: Database.Database;
  /**
   * Integration descriptors to consult, mostly so tests can inject a
   * narrow set without depending on the global registry. Defaults to the
   * production registry.
   */
  descriptors?: readonly IntegrationDescriptor[];
}

interface PrefixEntry {
  prefix: string;
  key: IntegrationKey;
}

function buildPrefixIndex(
  descriptors: readonly IntegrationDescriptor[],
): readonly PrefixEntry[] {
  const entries: PrefixEntry[] = [];
  for (const descriptor of descriptors) {
    for (const prefix of descriptor.apiRoutesTouched) {
      entries.push({ prefix, key: descriptor.key });
    }
  }
  // Longest prefix first — the matcher returns the first hit.
  return entries.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * Walk the prefix index and return the integration key whose
 * `apiRoutesTouched` covers `pathname`, or null if none. A prefix
 * matches when the path is exactly equal to it OR continues with `/`
 * (so `/api/calendar` matches `/api/calendar/events` but not
 * `/api/calendar-extras`).
 */
export function resolveIntegrationForPath(
  pathname: string,
  index: readonly PrefixEntry[],
): IntegrationKey | null {
  for (const { prefix, key } of index) {
    if (pathname === prefix) return key;
    if (pathname.startsWith(prefix + "/")) return key;
  }
  return null;
}

/**
 * Build the Hono middleware. Mount it after the auth middleware so
 * unauthenticated requests get 401 (current behavior) rather than a
 * 410 that leaks integration state. Mount it before any route handler
 * so the 410 short-circuits the work.
 */
export function createIntegrationRouteGate(
  opts: IntegrationRouteGateOptions,
): MiddlewareHandler {
  const descriptors =
    opts.descriptors ??
    Object.values(INTEGRATION_DESCRIPTORS) as readonly IntegrationDescriptor[];
  const index = buildPrefixIndex(descriptors);
  const db = opts.db;

  return async (c, next) => {
    if (index.length === 0) {
      await next();
      return;
    }
    const pathname = new URL(c.req.url).pathname;
    const key = resolveIntegrationForPath(pathname, index);
    if (!key) {
      await next();
      return;
    }
    const state = readIntegrations(db)[key];
    const descriptor = INTEGRATION_DESCRIPTORS[key];
    const displayName = descriptor.displayName;

    if (state.mode === "direct") {
      await next();
      return;
    }

    if (state.mode === "delegated") {
      // Zod guarantees delegatedBackend is set when mode === "delegated".
      const delegatedBackend = state.delegatedBackend;
      // User-managed connectors (Outlook today): there is no daemon-side
      // /exec proxy either, so the message must point the agent at the
      // user-installed MCP / connector on the chosen backend instead of
      // suggesting an /exec fallback. (The historical /invoke RPC was
      // retired 2026-05-01; /exec is the canonical descriptor-driven
      // chokepoint and the only one the daemon offers.)
      const message = descriptor.userManagedConnector
        ? `${displayName} is in delegated mode (delegated to ${delegatedBackend}). The user has registered an ${displayName} MCP / connector on the ${delegatedBackend} backend; use those tools directly. The daemon does not proxy this integration.`
        : `${displayName} is in delegated mode (delegated to ${delegatedBackend}). Same-backend sessions: use the connector's native MCP tools. Cross-backend sessions: call POST /api/integrations/${key}/exec. See the touched skill for the per-mode body.`;
      c.header("X-Integration-Mode", "delegated");
      return c.json(
        {
          error: "integration_delegated",
          integration: key,
          backend: delegatedBackend,
          mode: "delegated",
          // The route gate doesn't know which backend the *calling agent* is
          // running on, so the message can't say "your backend's tool" with
          // confidence — that's correct only in same-backend delegation. For
          // descriptor-driven integrations (Gmail / Calendar / Notion) both
          // same-backend and cross-backend paths exist and the message points
          // at both. For user-managed connectors there is no /exec
          // fallback — the user's MCP is the only access path.
          message,
        },
        410,
      );
    }

    // INTEGRATION_NATIVE_MODE_DESIGN.md §9.1 — native and disabled modes
    // both 410 every daemon path declared under `apiRoutesTouched`. Both
    // surface `X-Integration-Mode` so callers can branch without parsing
    // the body. The `/api/integrations/:key/probe` route is intentionally
    // NOT in `apiRoutesTouched` (it stays reachable in every mode — §9.3),
    // so the user can verify a flip is safe even from the gated state.
    if (state.mode === "native") {
      // Zod requires `nativeBackend` in native mode, so all the `?? …`
      // fallbacks below are defensive and unreachable from valid input.
      /* c8 ignore next */
      const nativeBackend = state.nativeBackend ?? null;
      // User-managed connectors (Outlook today): there is no daemon-shipped
      // `SKILL.native.<backend>.md` to point at — the user's own MCP /
      // skill harness on their main backend is the access path. The
      // message mirrors the delegated user-managed branch above.
      /* c8 ignore start — defensive nativeBackend fallbacks */
      const nativeMessage = descriptor.userManagedConnector
        ? `${displayName} is in native mode (bound to ${nativeBackend ?? "main backend"}). The user has registered an ${displayName} MCP / connector on the ${nativeBackend ?? "main"} backend; the agent uses those tools directly. The daemon does not poll and does not expose a proxy for this integration in native mode.`
        : `${displayName} is in native mode (bound to ${nativeBackend ?? "main backend"}). The agent reaches this integration via the backend's own native MCP tools (see the SKILL.native.${nativeBackend ?? "<backend>"}.md body). The daemon does not poll and does not expose a proxy for this integration in native mode.`;
      /* c8 ignore stop */
      c.header("X-Integration-Mode", "native");
      return c.json(
        {
          error: "integration_native",
          integration: key,
          backend: nativeBackend,
          mode: "native",
          message: nativeMessage,
        },
        410,
      );
    }

    // mode === "disabled" (the only remaining case — the switch above
    // covered direct/delegated/native explicitly).
    c.header("X-Integration-Mode", "disabled");
    return c.json(
      {
        error: "integration_disabled",
        integration: key,
        backend: null,
        mode: "disabled",
        message: `${displayName} is disabled. The agent's skill body and task-flow variant omit this integration; if you reached this gate the routing-table-actionable section may be stale. Set the mode to direct / delegated / native via PATCH /api/integrations/${key} to reach the daemon API.`,
      },
      410,
    );
  };
}

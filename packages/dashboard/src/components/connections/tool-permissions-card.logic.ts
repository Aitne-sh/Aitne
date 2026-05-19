import type { BackendId } from "@aitne/shared";
import type { IntegrationListItem } from "@/lib/api-types";
import { capabilityLabel } from "./integration-card.logic";

/**
 * §7.7 Tool Permissions card — pure derivations.
 *
 * One row per `optionalCapabilities` entry on the active backend's
 * connector. Required capabilities surface but are locked (denying them
 * would break delegated mode). Each row knows the underlying tool list so
 * the user can see what they're disabling. Stale entries — deniedTools
 * names that don't appear in any of the active backend's capabilityTools —
 * are surfaced separately so the user can clean them up.
 */

export interface ToolPermissionRow {
  /** Capability key (e.g. `"schema_admin"`). */
  capability: string;
  /** Human label rendered in the UI. */
  label: string;
  /** Tool names (unsuffixed) this capability resolves to via the descriptor. */
  tools: string[];
  /** True when the capability is in `requiredCapabilities` for the active backend. */
  required: boolean;
  /**
   * True when ALL tools in the capability are currently denied. For
   * required capabilities the denial is invalid (server returns 400) and
   * the row stays visually-toggled-off but locked.
   */
  denied: boolean;
}

export interface ToolPermissionsView {
  rows: ToolPermissionRow[];
  /**
   * Entries in `state.deniedTools` that don't match any tool name in the
   * active backend's `capabilityTools` — typically Claude-namespaced names
   * left over after the user swapped to Codex (or vice versa). Surfaced
   * with a one-click "Clean up" button so the user can reconcile.
   */
  staleDeniedTools: string[];
  /** True when the active backend offers no per-tool deny enforcement (Codex / Gemini). */
  softEnforcement: boolean;
}

/**
 * Build the view-model for an integration's Tool Permissions card given
 * the descriptor entry, the active backend, and the currently-stored
 * `deniedTools` list. Returns null when the integration is not delegated
 * (no backend → no per-tool list to render).
 */
export function buildToolPermissionsView(
  descriptor: IntegrationListItem,
  delegatedBackend: BackendId | null | undefined,
  deniedTools: readonly string[] | undefined,
): ToolPermissionsView | null {
  if (!delegatedBackend) return null;
  const connector = descriptor.backendConnectors[delegatedBackend];
  if (!connector) return null;

  const denySet = new Set(deniedTools ?? []);
  const required = new Set(connector.requiredCapabilities);

  // The dashboard renders one row per capability listed in
  // `optionalCapabilities`. Required capabilities are always present in
  // that list per the registry contract (every required cap is also
  // optional — the registry doesn't deduplicate); guard with a Set in
  // case a future descriptor breaks that.
  const seen = new Set<string>();
  const rows: ToolPermissionRow[] = [];
  for (const capability of connector.optionalCapabilities) {
    if (seen.has(capability)) continue;
    seen.add(capability);
    const tools = [...(connector.capabilityTools[capability] ?? [])];
    const denied = tools.length > 0 && tools.every((t) => denySet.has(t));
    rows.push({
      capability,
      label: capabilityLabel(capability),
      tools,
      required: required.has(capability),
      denied,
    });
  }

  // Required capabilities listed only in `requiredCapabilities` (not in
  // `optionalCapabilities`) still need a row so the user sees them as
  // locked. Defensive — current descriptors include them in both, but
  // the lock UI shouldn't disappear if a future descriptor narrows the
  // optional list.
  for (const capability of connector.requiredCapabilities) {
    if (seen.has(capability)) continue;
    seen.add(capability);
    const tools = [...(connector.capabilityTools[capability] ?? [])];
    rows.push({
      capability,
      label: capabilityLabel(capability),
      tools,
      required: true,
      denied: false,
    });
  }

  // Stale entries — deniedTools names that don't appear in any of the
  // active backend's capabilityTools. Typical case: backend swap from
  // Claude → Codex carries over `notion-create-database` (Claude name)
  // while Codex's name is `notion_create_database`.
  const knownTools = new Set<string>();
  for (const tools of Object.values(connector.capabilityTools)) {
    for (const t of tools) knownTools.add(t);
  }
  const staleDeniedTools = (deniedTools ?? []).filter(
    (t) => !knownTools.has(t),
  );

  return {
    rows,
    staleDeniedTools,
    softEnforcement: delegatedBackend !== "claude",
  };
}

/**
 * Compute the next `deniedTools` list when a capability row is toggled.
 * Toggling a capability adds or removes EVERY tool listed for it. Stale
 * entries from other backends are preserved across the toggle so a Claude
 * → Codex → Claude round-trip doesn't drop the user's prior intent.
 */
export function toggleCapabilityDeny(
  current: readonly string[],
  row: ToolPermissionRow,
  nextDenied: boolean,
): string[] {
  const next = new Set(current);
  if (nextDenied) {
    for (const t of row.tools) next.add(t);
  } else {
    for (const t of row.tools) next.delete(t);
  }
  return [...next];
}

/**
 * Parse the §7.1 raw deny-list editor's textarea content into the array
 * shape the API consumes. Lines are trimmed; empty lines are skipped.
 * Duplicates are deduplicated while preserving the user's chosen ordering
 * (first occurrence wins). Unknown patterns (typos, glob-style entries
 * the server-side validator may reject) flow through verbatim — the API
 * is the authority on validity, and surfacing its 400 in the UI is the
 * user's feedback signal.
 */
export function parseRawDenyList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

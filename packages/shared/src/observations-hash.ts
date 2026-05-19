import { createHash } from "node:crypto";

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §8.3 — server-side content hash util
 * shared between:
 *
 *   - `POST /api/observations` (native task-flow Step 0a persistence)
 *   - `delegated-sync-worker` (delegated-mode cadence writes)
 *   - direct-mode pollers (MailPoller, CalendarPoller, NotionPoller)
 *
 * Putting the hash on the daemon (rather than asking the LLM to compute
 * SHA-256 with bespoke normalisation) is what lets a `delegated → native`
 * flip dedup against observations written before the flip — same hash for
 * the same thread state across modes. The risk register §15 row
 * ("Agent computes its own contentHash diverging from worker's") is
 * closed by routing every writer through this util.
 *
 * Inputs are intentionally narrow:
 *   - `source`  — the observation source string (e.g. `"gmail"`,
 *                 `"google_calendar"`). Hashing it alongside the payload
 *                 prevents a collision between two integrations that
 *                 happen to surface the same opaque blob.
 *   - `payload` — any JSON-serialisable value. Stringified via
 *                 {@link canonicalStringify} so object key order does not
 *                 affect the hash.
 *
 * Returns a lowercase hex SHA-256 digest. Stable across processes and
 * platforms; depends only on Node's bundled crypto module.
 */
export function computeObservationHash(
  source: string,
  payload: unknown,
): string {
  const canonical = canonicalStringify(payload);
  return createHash("sha256")
    .update(source)
    .update("\0")
    .update(canonical)
    .digest("hex");
}

/**
 * Stable JSON stringify — sorts object keys at every depth so the hash
 * survives:
 *   - `JSON.parse(JSON.stringify(payload))` round-trips that reorder keys
 *     (Node 22 preserves insertion order, but the agent's payload may have
 *     been re-serialised by an intermediate);
 *   - object spread / property assignment in skills before the POST.
 *
 * Arrays preserve order — calendar event lists and mail thread lists have
 * a natural newest-first / chronological order that callers maintain.
 * `undefined` values mirror `JSON.stringify` semantics (dropped at object
 * boundaries; serialised as `null` inside arrays).
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    // Object.entries returns each key once, so the equality branch (a > b
    // → 0 fallthrough) is unreachable from here; keep the safety belt and
    // mark the dead branch for coverage.
    /* c8 ignore next */
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`)
    .join(",")}}`;
}

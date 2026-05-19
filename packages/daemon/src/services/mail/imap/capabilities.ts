/**
 * IMAP CAPABILITY probe results (Phase 4).
 *
 * The probe runs on each account's first live connect. The result is cached
 * on the provider instance and persisted via {@link MailAccountRegistry} so
 * Phase 7's deletion reconciliation job (§3.1.1) and bulk thread sync (§3.6)
 * can branch on what the server actually supports without reprobing.
 *
 * Phase 4 only *writes* this data; no Phase 4 code path reads it.
 */

export interface ImapCapabilitySet {
  /** RFC 7162 QRESYNC — fast reconnect + VANISHED responses. Used for deletion reconciliation (§3.1.1). */
  qresync: boolean;
  /** RFC 5256 THREAD=REFERENCES — server-side THREAD command. Opportunistic threading optimization (§3.6). */
  threadReferences: boolean;
  /** RFC 6154 SPECIAL-USE — LIST returns \Sent, \Drafts, \Trash, \Archive, \Junk attributes. Used for Sent-folder resolution (§3.1.2). */
  specialUse: boolean;
  /** RFC 4315 UIDPLUS — APPENDUID / COPYUID responses. Cleaner UID tracking on draft create and send-to-Sent. */
  uidplus: boolean;
  /** RFC 2177 IDLE — push notifications without repeated polls. */
  idle: boolean;
  /** RFC 6851 MOVE — single-command atomic move (vs COPY+STORE+EXPUNGE). */
  move: boolean;
  /** Raw capability names, sorted and upper-cased, useful for dashboard diagnostics. */
  all: string[];
}

export function probeCapabilities(
  raw: Iterable<string> | Map<string, unknown> | null | undefined,
): ImapCapabilitySet {
  const tokens = normalizeTokens(raw);
  const set = new Set(tokens);
  return {
    qresync: set.has("QRESYNC"),
    threadReferences: set.has("THREAD=REFERENCES"),
    specialUse: set.has("SPECIAL-USE"),
    uidplus: set.has("UIDPLUS"),
    idle: set.has("IDLE"),
    move: set.has("MOVE"),
    all: [...set].sort(),
  };
}

export function serializeCapabilities(caps: ImapCapabilitySet): string {
  return JSON.stringify(caps);
}

export function parseCapabilitiesJson(
  raw: string | null | undefined,
): ImapCapabilitySet | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const allField = record.all;
  if (!Array.isArray(allField)) return null;
  // Re-derive from the canonical `all` list. Serialize and parse always
  // round-trip together, so the booleans on disk match `all` by construction;
  // rebuilding here also tolerates older JSON shapes that may predate a
  // capability field (e.g. before `move` was added).
  return probeCapabilities(
    allField.filter((x): x is string => typeof x === "string"),
  );
}

function normalizeTokens(
  raw: Iterable<string> | Map<string, unknown> | null | undefined,
): string[] {
  if (!raw) return [];
  // ImapFlow exposes capabilities as Map<string, boolean | number>; other
  // callers may pass a plain array. Accept either shape and coerce to an
  // upper-cased deduplicated list.
  const out: string[] = [];
  if (raw instanceof Map) {
    for (const key of raw.keys()) {
      if (typeof key === "string" && key.length > 0) out.push(key.toUpperCase());
    }
    return out;
  }
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push(entry.toUpperCase());
    }
  }
  return out;
}

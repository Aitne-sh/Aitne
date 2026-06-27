import { createHash } from "node:crypto";
import { INTEGRATION_KEYS, type IntegrationKey } from "./integrations.js";

/**
 * Snapshot normalizers for `integration_snapshots` reconcile pipeline.
 *
 * Per INTEGRATION-DRIFT-DETECTION-PLAN.md §5.2: each integration ships a
 * pure normalizer that turns a raw upstream payload into the canonical
 * shape stored in `integration_snapshots.payload_json`, plus a stable
 * sha256 over a sorted JSON encoding of that shape used for diff
 * comparison. The normalizer is shared between the daemon (CalendarPoller,
 * DelegatedSyncWorker, reconcile route) and the LLM-driven activity scan
 * path so behaviour is identical regardless of who writes the snapshot.
 *
 * Phase 1 shipped the calendar normalizer; Phase 5 adds Gmail thread and
 * Notion page normalizers. The registry stays `Partial` so a future
 * integration can land its connector wiring before its normalizer (route
 * handlers continue returning a structured 400 in that gap).
 */

/**
 * Actor pre-mark a reconcile caller can attach per-item. Mirrors the
 * `observations.actor` column / `integration_snapshots.actor_hint` CHECK
 * constraint vocabulary so a hint flows straight through to either column
 * without translation. Reconcile still consults `integration_writes` as the
 * authoritative source — this is only the fallback.
 */
export type SnapshotActorHint = "user" | "agent" | "system" | "unknown";

/**
 * Default TTL for `integration_writes` entries, per integration.
 *
 * INTEGRATION-DRIFT-DETECTION-PLAN.md §17.11 requires `TTL ≥ slowest_cadence
 * × 1.5` so an agent-originated write at T0 cannot have its attribution
 * mark expire before the next reconcile sees it as a user write. Phase 7
 * (c) tightens these constants to cover the §8.3 default cadences with
 * margin:
 *
 *   - google_calendar: slowest cadence is the 24h-window default (60 min)
 *     → 60 × 1.5 = 90 min. The 10-min imminent cadence is irrelevant for
 *     TTL because an agent-originated event always lands inside the 24h
 *     window first; the slowest cadence governs the contract.
 *   - gmail: 30 min default → 45 min. The 15-min soft floor gives the
 *     same TTL margin if the operator presses cadence to its minimum.
 *   - notion: 60 min default → 90 min. Pre-Phase-7 this was 30 min, which
 *     left the agent's own page edits at risk of mis-attribution on the
 *     very next worker tick.
 *
 * Operators who push a cadence past the corresponding TTL via
 * `runtime_state.delegatedSync.intervals` opt into the pre-fix regime.
 * The DelegatedSyncWorker logs warn at start and surfaces the violation
 * via `getStatus().ttlContractViolations` so the breach is observable
 * rather than silent.
 */
export const INTEGRATION_WRITE_TTL_MS: Readonly<Record<IntegrationKey, number>> = {
  google_calendar: 90 * 60 * 1000,
  gmail: 45 * 60 * 1000,
  notion: 90 * 60 * 1000,
  // Git/GitHub do not currently participate in delegated drift snapshots,
  // but IntegrationKey is intentionally exhaustive. Keep a conservative
  // value so generic write-tracker callers never fall through to undefined.
  git: 90 * 60 * 1000,
  github: 90 * 60 * 1000,
  // SETUP-FLOW-REDESIGN-PLAN §6.1 — Outlook mail goes through the unified
  // mail poller, same cadence floor as Gmail. Outlook calendar has no
  // poller in v1 (`observersTouched: []`); the value is set defensively so
  // callers never see an undefined TTL if a snapshot path is ever wired
  // up.
  outlook_mail: 45 * 60 * 1000,
  outlook_calendar: 90 * 60 * 1000,
  // Browser history does not flow through the delegated-snapshot pipeline
  // (no MCP connector, no agent writes to attribute), but IntegrationKey is
  // exhaustive — keep a conservative TTL so generic write-tracker callers
  // never see undefined for this key.
  browser_history: 90 * 60 * 1000,
};

export interface IntegrationNormalizer<TRaw = unknown, TPayload = unknown> {
  /** Stable identifier within `(integration, window_key)`. */
  itemId(raw: TRaw): string;
  /** Canonical, fully-sorted payload stored in `payload_json`. */
  payload(raw: TRaw): TPayload;
  /** sha256 hex digest of a stable JSON encoding of the canonical payload. */
  hash(payload: TPayload): string;
  /** ISO-8601 start time, or `null` when the integration has no scheduled
   *  start (Gmail/Notion). Calendar uses this to feed the imminent-event
   *  scheduler index. */
  itemStart(raw: TRaw): string | null;
  /**
   * §5.1 sliding-window predicate. Returns true if the (already-normalized)
   * payload's time field falls within `[windowMin, windowMax)`. Reconcile
   * uses this to distinguish a prior row that simply slid out of the
   * window (silent prune, no observation emitted) from one that was truly
   * deleted upstream (observation emitted). The predicate is per-integration
   * because each integration's "time field" lives at a different path
   * (calendar.start, gmail.internalDate, notion.lastEditedTime).
   */
  inWindow(payload: TPayload, windowMin: string, windowMax: string): boolean;
}

// ── Calendar normalizer (Phase 1) ────────────────────────────────────────────

/**
 * Canonical calendar snapshot payload. Field order in the type does not
 * affect the hash — `stableStringify` sorts keys at every level — but the
 * order documents the intent: identity-shaping fields first, then mutable
 * detail. `htmlLink` is included because it lets the agent render a deep
 * link without re-fetching, but it is excluded from the hash (it is purely
 * derivable from the event id).
 */
export interface CalendarSnapshotPayload {
  summary: string | null;
  start: string | null;
  end: string | null;
  location: string | null;
  description: string | null;
  status: string | null;
  /** Sorted by email so attendee-order jitter does not flap the hash. */
  attendees: Array<{ email: string; responseStatus: string }>;
  /** Display-only, excluded from hash. */
  htmlLink: string | null;
}

interface RawCalendarEvent {
  id?: unknown;
  recurringEventId?: unknown;
  summary?: unknown;
  description?: unknown;
  location?: unknown;
  status?: unknown;
  htmlLink?: unknown;
  // Google Calendar API delivers start/end as `{date}` (all-day) or
  // `{dateTime, timeZone}`. We accept either.
  start?: { date?: unknown; dateTime?: unknown } | string | null;
  end?: { date?: unknown; dateTime?: unknown } | string | null;
  attendees?: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function extractTime(field: RawCalendarEvent["start"]): string | null {
  if (typeof field === "string") return field.length > 0 ? field : null;
  if (field == null) return null;
  if (typeof field !== "object") return null;
  const dateTime = asString((field as { dateTime?: unknown }).dateTime);
  if (dateTime !== null) return dateTime;
  return asString((field as { date?: unknown }).date);
}

function normalizeTimeForRange(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeAttendees(
  raw: unknown,
): Array<{ email: string; responseStatus: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ email: string; responseStatus: string }> = [];
  for (const a of raw) {
    if (a == null || typeof a !== "object") continue;
    const email = asString((a as { email?: unknown }).email);
    if (email === null) continue;
    const responseStatus
      = asString((a as { responseStatus?: unknown }).responseStatus)
      ?? "needsAction";
    out.push({ email, responseStatus });
  }
  // Sort by email so two responses with the same set produce the same
  // hash regardless of API ordering. Stable enough — duplicate-email
  // entries (Google occasionally yields these) preserve their relative
  // order via Array.prototype.sort's algorithmic stability.
  out.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return out;
}

/**
 * Recurring-event instance keys. Per §5.2 + §13: instance-level snapshots
 * keyed as `${seriesId}@${start}` keep instance edits visible even when
 * Google occasionally rewrites `recurringEventId`. A non-recurring event
 * has no `recurringEventId`, so we fall back to the raw id.
 */
function calendarItemId(raw: RawCalendarEvent): string {
  const id = asString(raw.id);
  if (id === null) {
    // Defensive — Google's API never omits id on a real event. Throw
    // with a recognisable error so the route handler returns a precise
    // 400 instead of silently storing an empty key.
    throw new Error("calendar event missing id");
  }
  const series = asString(raw.recurringEventId);
  if (series === null) return id;
  const start = extractTime(raw.start);
  return start === null ? id : `${series}@${start}`;
}

function calendarPayload(raw: RawCalendarEvent): CalendarSnapshotPayload {
  return {
    summary: asString(raw.summary),
    start: extractTime(raw.start),
    end: extractTime(raw.end),
    location: asString(raw.location),
    description: normalizeWhitespace(asString(raw.description)),
    status: asString(raw.status),
    attendees: normalizeAttendees(raw.attendees),
    htmlLink: asString(raw.htmlLink),
  };
}

/**
 * INTEGRATION-DRIFT-PHASE-7-PLAN.md §3.4 — collapse runs of whitespace and
 * convert non-breaking-space (U+00A0) to regular space before hashing the
 * calendar description. Google occasionally re-wraps long descriptions or
 * substitutes NBSP into the body; without normalization the hash flaps on
 * an unmodified event and surfaces as a phantom `modified` diff every
 * poll. Returns null for empty input so the canonical payload still
 * distinguishes "no description" from "all-whitespace description".
 */
function normalizeWhitespace(value: string | null): string | null {
  if (value === null) return null;
  const collapsed = value.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Hash discipline: serialize a stable, sorted JSON encoding of the fields
 * that semantically constitute the event. `htmlLink` is excluded — it is
 * derivable from the id, and Google occasionally rewrites the path
 * fragment. `updated`, `etag`, `iCalUID`, and snippet-like server-generated
 * fields are likewise excluded so the hash does not flap on every poll.
 */
function calendarHashableShape(p: CalendarSnapshotPayload): unknown {
  return {
    attendees: p.attendees,
    description: p.description,
    end: p.end,
    location: p.location,
    start: p.start,
    status: p.status,
    summary: p.summary,
  };
}

/**
 * Lexicographic-key JSON encoder. Drop-in replacement for JSON.stringify
 * that walks objects with a sorted key list at every level so two
 * structurally-equal payloads always serialize identically. Arrays
 * preserve order — the calendar normalizer pre-sorts attendees so
 * `[{email:"a"}, {email:"b"}]` and `[{email:"b"}, {email:"a"}]` are
 * distinct payloads pre-normalize but identical post-normalize.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${parts.join(",")}}`;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const calendarNormalizer: IntegrationNormalizer<
  RawCalendarEvent,
  CalendarSnapshotPayload
> = {
  itemId: calendarItemId,
  payload: calendarPayload,
  hash: (payload) => sha256Hex(stableStringify(calendarHashableShape(payload))),
  itemStart: (raw) => normalizeTimeForRange(extractTime(raw.start)),
  inWindow: (payload, windowMin, windowMax) => {
    const startMs = payload.start === null ? NaN : Date.parse(payload.start);
    const minMs = Date.parse(windowMin);
    const maxMs = Date.parse(windowMax);
    if (
      !Number.isFinite(startMs)
      || !Number.isFinite(minMs)
      || !Number.isFinite(maxMs)
    ) {
      return false;
    }
    return startMs >= minMs && startMs < maxMs;
  },
};

// ── Gmail thread normalizer (Phase 5) ────────────────────────────────────────

/**
 * Canonical Gmail thread snapshot payload. The shape is granularity-thread
 * (per §15.4): `messageIds` lets reconcile detect a new message landing in an
 * already-seen thread (length growth → hash differs → `modified` diff).
 *
 * `snippet` is intentionally display-only (excluded from the hash) — Gmail
 * regenerates snippets server-side and an unrelated rewrite would otherwise
 * flap the hash on every poll (§17.10). `from` is canonicalised to a
 * lowercase email-only string so the hash is stable across `"Name <email>"`
 * vs. `{ name, email }` connector representations and across capitalisation
 * jitter.
 */
export interface GmailSnapshotPayload {
  threadId: string;
  subject: string | null;
  /** Canonical lowercase email of the most recent sender. */
  from: string | null;
  /** Sorted ascending. */
  labelIds: string[];
  /** Sorted ascending. */
  messageIds: string[];
  /** ISO-8601 of the latest message's `internalDate`, when known. */
  lastMessageInternalDate: string | null;
  /** Display-only, excluded from the hash. */
  snippet: string | null;
}

interface RawGmailMessage {
  id?: unknown;
  threadId?: unknown;
  internalDate?: unknown; // Gmail returns ms-since-epoch as string OR number.
  labelIds?: unknown;
  snippet?: unknown;
  subject?: unknown; // some connectors flatten headers up to top level.
  from?: unknown;
  payload?: { headers?: unknown };
  headers?: unknown; // some connectors hoist headers to top level.
}

interface RawGmailThread extends RawGmailMessage {
  messages?: unknown;
  messageIds?: unknown;
  pageSize?: unknown; // discriminator-ish — ignored.
}

/**
 * Extract the email address from a connector "from" representation.
 * Accepts `"Name <a@b.com>"`, `"a@b.com"`, `{ email: "a@b.com" }`, and
 * `{ name, email }` shapes; returns `null` for anything else. Lowercased
 * so capitalisation jitter does not flap the hash.
 */
function gmailCanonicalFrom(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const angled = /<([^>]+)>/.exec(trimmed);
    const candidate = angled?.[1] ?? trimmed;
    return candidate.toLowerCase();
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const email = asString((raw as { email?: unknown }).email);
    if (email !== null) return email.toLowerCase();
  }
  return null;
}

/**
 * Walk a Gmail headers list. `headers` is sometimes hosted at
 * `payload.headers` (Google API native) and sometimes flattened at the
 * top level (Codex / Gemini search-result wrappers). Returns the first
 * matching header value (case-insensitive name match).
 */
function gmailHeader(
  headers: unknown,
  name: string,
): string | null {
  if (!Array.isArray(headers)) return null;
  for (const entry of headers) {
    if (entry == null || typeof entry !== "object") continue;
    const headerName = asString(
      (entry as { name?: unknown }).name,
    );
    if (headerName === null) continue;
    if (headerName.toLowerCase() !== name.toLowerCase()) continue;
    return asString((entry as { value?: unknown }).value);
  }
  return null;
}

function gmailMessageHeaders(message: RawGmailMessage): unknown {
  if (message.payload && typeof message.payload === "object") {
    const inner = (message.payload as { headers?: unknown }).headers;
    if (inner !== undefined) return inner;
  }
  return message.headers;
}

function gmailMessageId(message: RawGmailMessage): string | null {
  return asString(message.id);
}

function gmailMessageInternalDateMs(message: RawGmailMessage): number | null {
  const raw = message.internalDate;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function gmailMessageLabelIds(message: RawGmailMessage): string[] {
  if (!Array.isArray(message.labelIds)) return [];
  const out: string[] = [];
  for (const v of message.labelIds) {
    const s = asString(v);
    if (s !== null) out.push(s);
  }
  return out;
}

function gmailExtractMessages(raw: RawGmailThread): RawGmailMessage[] {
  if (Array.isArray(raw.messages)) {
    return raw.messages.filter(
      (m): m is RawGmailMessage =>
        m !== null && typeof m === "object" && !Array.isArray(m),
    );
  }
  return [];
}

function gmailItemId(raw: RawGmailThread): string {
  const threadId = asString(raw.threadId);
  if (threadId !== null) return threadId;
  // Some Gmail connectors only return `id` on a single-message search hit;
  // Gemini's `gmail.search` is the canonical example. The id IS the thread
  // id when no separate threadId surfaces.
  const id = asString(raw.id);
  if (id !== null) return id;
  // Fall back to the first message's threadId if a `messages: [...]` shape
  // was passed without a top-level threadId.
  const messages = gmailExtractMessages(raw);
  for (const m of messages) {
    const tid = asString(m.threadId);
    if (tid !== null) return tid;
    const mid = asString(m.id);
    if (mid !== null) return mid;
  }
  throw new Error("gmail thread missing threadId and id");
}

function gmailPayload(raw: RawGmailThread): GmailSnapshotPayload {
  const threadId = gmailItemId(raw);
  const messages = gmailExtractMessages(raw);

  // Gather subject / from / labelIds / messageIds / lastDate. Prefer the
  // latest message (highest internalDate); fall back to the top-level
  // fields when the connector returns a flattened search hit.
  let lastDateMs: number | null = null;
  let lastSubject: string | null = null;
  let lastFrom: string | null = null;
  const labelSet = new Set<string>();
  const messageIds: string[] = [];

  for (const m of messages) {
    const mid = gmailMessageId(m);
    if (mid !== null) messageIds.push(mid);
    for (const label of gmailMessageLabelIds(m)) labelSet.add(label);
    const dateMs = gmailMessageInternalDateMs(m);
    if (dateMs !== null && (lastDateMs === null || dateMs > lastDateMs)) {
      lastDateMs = dateMs;
      const headers = gmailMessageHeaders(m);
      lastSubject
        = asString(m.subject)
        ?? gmailHeader(headers, "Subject");
      lastFrom = gmailCanonicalFrom(m.from)
        ?? gmailCanonicalFrom(gmailHeader(headers, "From"));
    }
  }

  // Top-level fallback for flattened search hits (Codex / Gemini singletons).
  if (lastDateMs === null) {
    lastDateMs = gmailMessageInternalDateMs(raw);
  }
  if (lastSubject === null) {
    const topHeaders = gmailMessageHeaders(raw);
    lastSubject = asString(raw.subject) ?? gmailHeader(topHeaders, "Subject");
  }
  if (lastFrom === null) {
    const topHeaders = gmailMessageHeaders(raw);
    lastFrom = gmailCanonicalFrom(raw.from)
      ?? gmailCanonicalFrom(gmailHeader(topHeaders, "From"));
  }
  if (Array.isArray(raw.labelIds)) {
    for (const v of raw.labelIds) {
      const s = asString(v);
      if (s !== null) labelSet.add(s);
    }
  }
  if (messageIds.length === 0) {
    // Singleton search-hit shape. The thread's only known message id is the
    // top-level id; if absent (Gemini search returns only `{id, threadId}`)
    // we record an empty messageIds list — the next reconcile that fetches
    // the thread's full body will populate it and surface a `modified`
    // diff at that point.
    const topId = asString(raw.id);
    if (topId !== null && topId !== threadId) messageIds.push(topId);
  }
  // Singletons sometimes carry a top-level `messageIds` array (Codex search
  // hits flatten multiple message ids into the search row).
  if (Array.isArray(raw.messageIds)) {
    for (const v of raw.messageIds) {
      const s = asString(v);
      if (s !== null && !messageIds.includes(s)) messageIds.push(s);
    }
  }

  // Sort labelIds + messageIds so connector ordering jitter doesn't flap
  // the hash.
  const labelIds = [...labelSet].sort();
  messageIds.sort();

  return {
    threadId,
    subject: lastSubject,
    from: lastFrom,
    labelIds,
    messageIds,
    lastMessageInternalDate:
      lastDateMs === null ? null : new Date(lastDateMs).toISOString(),
    snippet: asString(raw.snippet),
  };
}

function gmailHashableShape(p: GmailSnapshotPayload): unknown {
  // §17.10 — snippet is excluded; subject/from/labelIds/messageIds/lastDate
  // is the semantic identity of the thread for diff purposes.
  return {
    from: p.from,
    labelIds: p.labelIds,
    lastMessageInternalDate: p.lastMessageInternalDate,
    messageIds: p.messageIds,
    subject: p.subject,
    threadId: p.threadId,
  };
}

const gmailNormalizer: IntegrationNormalizer<
  RawGmailThread,
  GmailSnapshotPayload
> = {
  itemId: gmailItemId,
  payload: gmailPayload,
  hash: (payload) => sha256Hex(stableStringify(gmailHashableShape(payload))),
  // Gmail threads have no scheduled start time — `null` keeps them out of
  // the imminent-event index that the calendar scheduler reads.
  itemStart: () => null,
  inWindow: (payload, windowMin, windowMax) => {
    const dateMs
      = payload.lastMessageInternalDate === null
        ? NaN
        : Date.parse(payload.lastMessageInternalDate);
    const minMs = Date.parse(windowMin);
    const maxMs = Date.parse(windowMax);
    // §5.1: a payload with no parseable date cannot be classified as
    // "still in window" — treat it as out-of-window so the prior row gets
    // pruned silently rather than falsely emitted as `deleted`. This also
    // matches how the calendar normalizer handles a null start.
    if (
      !Number.isFinite(dateMs)
      || !Number.isFinite(minMs)
      || !Number.isFinite(maxMs)
    ) {
      return false;
    }
    return dateMs >= minMs && dateMs < maxMs;
  },
};

// ── Notion page normalizer (Phase 5) ────────────────────────────────────────

/**
 * Canonical Notion page snapshot payload. Hash discipline (§17.9):
 *
 *   - `title`, `lastEditedTime`, `parentDatabase` — page identity.
 *   - `propertiesSummaryHash` — sha256 over a canonical projection of the
 *     page's properties. Property types Notion knows about have stable
 *     value-shape extractors below; unknown types fall through to a
 *     conservative "type-tag only" projection so a new property shape does
 *     not silently flap the hash forever — the `propertiesSummary` display
 *     string still reflects the values, just not the hash.
 *   - `relationsHash` — sha256 over sorted relation-target ids per relation
 *     property. Separated so a future framework upgrade can promote
 *     relation changes to a first-class diff cause without re-versioning
 *     the page hash.
 *
 * Notion bumps `last_edited_time` whenever any property or block changes,
 * so the conservative path (just `lastEditedTime` + `parentDatabase` +
 * `title`) catches every meaningful diff. The properties hash is what
 * lets the agent reason "what specifically changed" from the diff entry.
 */
export interface NotionSnapshotPayload {
  pageId: string;
  title: string | null;
  lastEditedTime: string | null;
  parentDatabase: string | null;
  url: string | null;
  inTrash: boolean;
  /** Display-only summary string (status / select / date highlights), excluded from the hash. */
  propertiesSummary: string | null;
  /** sha256 hex of `{ [propName]: canonical-value-shape }` (sorted keys). */
  propertiesSummaryHash: string;
  /** sha256 hex of `{ [propName]: sorted-relation-id-array }` (sorted keys). */
  relationsHash: string;
}

interface RawNotionPage {
  id?: unknown;
  url?: unknown;
  archived?: unknown;
  in_trash?: unknown;
  last_edited_time?: unknown;
  parent?: unknown;
  properties?: unknown;
}

interface RawNotionProperty {
  type?: unknown;
  [key: string]: unknown;
}

function notionItemId(raw: RawNotionPage): string {
  const id = asString(raw.id);
  if (id === null) {
    throw new Error("notion page missing id");
  }
  return id;
}

function notionParentDatabaseId(raw: RawNotionPage): string | null {
  const parent = raw.parent;
  if (parent == null || typeof parent !== "object") return null;
  const p = parent as Record<string, unknown>;
  // A page can be parented under a `database_id`, `data_source_id` (the
  // newer Notion data-source surface), `page_id`, or `workspace`. The
  // observation source pattern in NotionPoller keys by `databaseId`, so
  // we mirror that and return `database_id` first; data sources fall
  // back next; page-rooted and workspace-rooted return null and the
  // drift-effects layer falls through to `notion:lifecycle`.
  return (
    asString(p.database_id)
    ?? asString(p.data_source_id)
    ?? null
  );
}

function notionExtractTitle(raw: RawNotionPage): string | null {
  const props = raw.properties;
  if (props == null || typeof props !== "object") return null;
  for (const value of Object.values(props as Record<string, unknown>)) {
    if (value == null || typeof value !== "object") continue;
    const prop = value as RawNotionProperty;
    if (prop.type !== "title") continue;
    const titleArr = prop.title;
    if (!Array.isArray(titleArr)) continue;
    const parts: string[] = [];
    for (const seg of titleArr) {
      if (seg == null || typeof seg !== "object") continue;
      const text = asString((seg as { plain_text?: unknown }).plain_text);
      if (text !== null) parts.push(text);
    }
    if (parts.length > 0) return parts.join("");
  }
  return null;
}

/**
 * Per-property-type canonicalisation. Each entry returns a value that
 * `stableStringify` can hash deterministically. Unhandled types map to
 * `{ type }` so the hash captures presence/absence of the property without
 * a per-shape handler — adding richer extractors later is additive.
 *
 * `relation` is intentionally NOT handled here: relation ids feed
 * `relationsHash` via {@link notionRelationsShape} instead, so the page
 * hash stays focused on scalar property changes.
 */
function notionPropertyValueShape(prop: RawNotionProperty): unknown {
  const type = asString(prop.type);
  if (type === null) return null;
  switch (type) {
    case "title":
    case "rich_text": {
      const arr = prop[type];
      if (!Array.isArray(arr)) return { type };
      const parts: string[] = [];
      for (const seg of arr) {
        if (seg == null || typeof seg !== "object") continue;
        const text = asString((seg as { plain_text?: unknown }).plain_text);
        if (text !== null) parts.push(text);
      }
      return { type, value: parts.join("") };
    }
    case "status":
    case "select": {
      const inner = prop[type];
      if (inner == null || typeof inner !== "object") return { type, value: null };
      return { type, value: asString((inner as { name?: unknown }).name) };
    }
    case "multi_select": {
      const arr = prop.multi_select;
      if (!Array.isArray(arr)) return { type, value: [] };
      const names: string[] = [];
      for (const seg of arr) {
        if (seg == null || typeof seg !== "object") continue;
        const name = asString((seg as { name?: unknown }).name);
        if (name !== null) names.push(name);
      }
      names.sort();
      return { type, value: names };
    }
    case "date": {
      const inner = prop.date;
      if (inner == null || typeof inner !== "object") return { type, value: null };
      const d = inner as Record<string, unknown>;
      return {
        type,
        value: {
          start: asString(d.start),
          end: asString(d.end),
          time_zone: asString(d.time_zone),
        },
      };
    }
    case "checkbox": {
      const v = prop.checkbox;
      return { type, value: typeof v === "boolean" ? v : null };
    }
    case "number": {
      const v = prop.number;
      return { type, value: typeof v === "number" && Number.isFinite(v) ? v : null };
    }
    case "url":
    case "email":
    case "phone_number": {
      return { type, value: asString(prop[type]) };
    }
    case "people": {
      const arr = prop.people;
      if (!Array.isArray(arr)) return { type, value: [] };
      const ids: string[] = [];
      for (const seg of arr) {
        if (seg == null || typeof seg !== "object") continue;
        const id = asString((seg as { id?: unknown }).id);
        if (id !== null) ids.push(id);
      }
      ids.sort();
      return { type, value: ids };
    }
    case "files": {
      const arr = prop.files;
      if (!Array.isArray(arr)) return { type, value: [] };
      const refs: string[] = [];
      for (const seg of arr) {
        if (seg == null || typeof seg !== "object") continue;
        const name = asString((seg as { name?: unknown }).name);
        const file = (seg as { file?: { url?: unknown } }).file;
        const external = (seg as { external?: { url?: unknown } }).external;
        const url
          = (file && typeof file === "object" ? asString(file.url) : null)
          ?? (external && typeof external === "object" ? asString(external.url) : null)
          ?? name;
        if (url !== null) refs.push(url);
      }
      refs.sort();
      return { type, value: refs };
    }
    case "created_time":
    case "last_edited_time": {
      // Notion regenerates these on every edit — exclude from the hash so
      // the page does not "modify" itself for free on every fetch (the
      // lastEditedTime field on the page itself is the canonical signal).
      return { type };
    }
    default:
      // Unknown type — record the type tag only so a structurally identical
      // unknown property does not flap, and so adding a stable extractor
      // for it later is additive (the new shape will diverge from the
      // type-tag-only previous hash, surfaced as one `modified` per page,
      // then steady).
      return { type };
  }
}

function notionPropertiesShape(raw: RawNotionPage): Record<string, unknown> {
  const props = raw.properties;
  if (props == null || typeof props !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props as Record<string, unknown>)) {
    if (value == null || typeof value !== "object") continue;
    const prop = value as RawNotionProperty;
    if (prop.type === "relation") continue;
    out[name] = notionPropertyValueShape(prop);
  }
  return out;
}

function notionRelationsShape(raw: RawNotionPage): Record<string, string[]> {
  const props = raw.properties;
  if (props == null || typeof props !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(props as Record<string, unknown>)) {
    if (value == null || typeof value !== "object") continue;
    const prop = value as RawNotionProperty;
    if (prop.type !== "relation") continue;
    const arr = prop.relation;
    if (!Array.isArray(arr)) {
      out[name] = [];
      continue;
    }
    const ids: string[] = [];
    for (const seg of arr) {
      if (seg == null || typeof seg !== "object") continue;
      const id = asString((seg as { id?: unknown }).id);
      if (id !== null) ids.push(id);
    }
    ids.sort();
    out[name] = ids;
  }
  return out;
}

function notionPropertiesSummaryString(raw: RawNotionPage): string | null {
  const props = raw.properties;
  if (props == null || typeof props !== "object") return null;
  const parts: string[] = [];
  for (const [name, value] of Object.entries(props as Record<string, unknown>)) {
    if (value == null || typeof value !== "object") continue;
    const prop = value as RawNotionProperty;
    const type = asString(prop.type);
    if (type === "status" || type === "select") {
      const inner = prop[type];
      if (inner != null && typeof inner === "object") {
        const n = asString((inner as { name?: unknown }).name);
        if (n !== null) parts.push(`${name}: ${n}`);
      }
    } else if (type === "date") {
      const inner = prop.date;
      if (inner != null && typeof inner === "object") {
        const start = asString((inner as { start?: unknown }).start);
        if (start !== null) parts.push(`${name}: ${start}`);
      }
    }
  }
  return parts.length === 0 ? null : parts.join(" | ");
}

function notionPayload(raw: RawNotionPage): NotionSnapshotPayload {
  const propertiesShape = notionPropertiesShape(raw);
  const relationsShape = notionRelationsShape(raw);
  const propertiesSummaryHash = sha256Hex(stableStringify(propertiesShape));
  const relationsHash = sha256Hex(stableStringify(relationsShape));
  const inTrash = Boolean(raw.in_trash) || Boolean(raw.archived);
  return {
    pageId: notionItemId(raw),
    title: notionExtractTitle(raw),
    lastEditedTime: asString(raw.last_edited_time),
    parentDatabase: notionParentDatabaseId(raw),
    url: asString(raw.url),
    inTrash,
    propertiesSummary: notionPropertiesSummaryString(raw),
    propertiesSummaryHash,
    relationsHash,
  };
}

function notionHashableShape(p: NotionSnapshotPayload): unknown {
  // `propertiesSummary` is excluded — it's a display string derived from
  // the same data the propertiesSummaryHash already covers. `url` and
  // `inTrash` are also excluded: trash transitions show up via
  // `lastEditedTime` (Notion bumps it on archive) and `url` is derivable
  // from id; including either would flap on incidental rewrites.
  return {
    lastEditedTime: p.lastEditedTime,
    pageId: p.pageId,
    parentDatabase: p.parentDatabase,
    propertiesSummaryHash: p.propertiesSummaryHash,
    relationsHash: p.relationsHash,
    title: p.title,
  };
}

const notionNormalizer: IntegrationNormalizer<
  RawNotionPage,
  NotionSnapshotPayload
> = {
  itemId: notionItemId,
  payload: notionPayload,
  hash: (payload) => sha256Hex(stableStringify(notionHashableShape(payload))),
  itemStart: () => null,
  inWindow: (payload, windowMin, windowMax) => {
    const editedMs
      = payload.lastEditedTime === null
        ? NaN
        : Date.parse(payload.lastEditedTime);
    const minMs = Date.parse(windowMin);
    const maxMs = Date.parse(windowMax);
    if (
      !Number.isFinite(editedMs)
      || !Number.isFinite(minMs)
      || !Number.isFinite(maxMs)
    ) {
      return false;
    }
    return editedMs >= minMs && editedMs < maxMs;
  },
};

/**
 * Normalizer registry. Phase 5 ships gmail and notion alongside calendar.
 * Adding a future integration is one Record entry — the route handler
 * reads via `getSnapshotNormalizer(key)` and stays integration-key-driven.
 */
export const SNAPSHOT_NORMALIZERS: Readonly<
  Partial<Record<IntegrationKey, IntegrationNormalizer>>
> = {
  google_calendar: calendarNormalizer as IntegrationNormalizer,
  gmail: gmailNormalizer as IntegrationNormalizer,
  notion: notionNormalizer as IntegrationNormalizer,
};

/** True if the integration has a Phase-1 normalizer registered. Used by
 *  the reconcile route to fail fast with a precise error message before
 *  parsing items. */
export function hasSnapshotNormalizer(key: IntegrationKey): boolean {
  return key in SNAPSHOT_NORMALIZERS;
}

/** List the integrations currently registered with a normalizer. Drives
 *  the `supportedIntegrations` field in error responses so a caller sees
 *  the contract without grepping the source. */
export function listSnapshotNormalizers(): IntegrationKey[] {
  return INTEGRATION_KEYS.filter((k) => k in SNAPSHOT_NORMALIZERS);
}

/** Fetch the normalizer for an integration. Returns `undefined` for
 *  unsupported integrations so the caller can return a structured 400. */
export function getSnapshotNormalizer(
  key: IntegrationKey,
): IntegrationNormalizer | undefined {
  return SNAPSHOT_NORMALIZERS[key];
}

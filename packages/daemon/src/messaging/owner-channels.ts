import type Database from "better-sqlite3";

interface OwnerChannelRecord {
  platform: string;
  sender_id: string | null;
  channel_id: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  metadata: string | null;
}

export function upsertOwnerChannel(
  db: Database.Database,
  params: {
    platform: string;
    senderId?: string | null;
    channelId: string;
    metadata?: Record<string, unknown>;
    touchInbound?: boolean;
    touchOutbound?: boolean;
  },
): void {
  const {
    platform,
    senderId,
    channelId,
    metadata,
    touchInbound = false,
    touchOutbound = false,
  } = params;

  const metadataJson =
    metadata === undefined ? null : JSON.stringify(metadata);

  db.prepare(
    `INSERT INTO owner_channels (
       platform,
       sender_id,
       channel_id,
       last_inbound_at,
       last_outbound_at,
       metadata
     )
     VALUES (
       ?,
       ?,
       ?,
       CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
       CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
       COALESCE(?, '{}')
     )
     ON CONFLICT(platform) DO UPDATE SET
       sender_id = COALESCE(excluded.sender_id, owner_channels.sender_id),
       channel_id = excluded.channel_id,
       last_inbound_at = CASE
         WHEN ? THEN CURRENT_TIMESTAMP
         ELSE owner_channels.last_inbound_at
       END,
       last_outbound_at = CASE
         WHEN ? THEN CURRENT_TIMESTAMP
         ELSE owner_channels.last_outbound_at
       END,
       metadata = COALESCE(?, owner_channels.metadata)`,
  ).run(
    platform,
    senderId ?? null,
    channelId,
    touchInbound ? 1 : 0,
    touchOutbound ? 1 : 0,
    metadataJson,
    touchInbound ? 1 : 0,
    touchOutbound ? 1 : 0,
    metadataJson,
  );
}

export function getOwnerChannel(
  db: Database.Database,
  platform: string,
): OwnerChannelRecord | null {
  const row = db
    .prepare(
      `SELECT platform, sender_id, channel_id, last_inbound_at, last_outbound_at, metadata
       FROM owner_channels
       WHERE platform = ?`,
    )
    .get(platform) as OwnerChannelRecord | undefined;
  return row ?? null;
}

/**
 * Pick the "earliest-paired" platform from a set of currently-eligible
 * candidates. Used by the boot-time primary-platform auto-resolver to
 * honor the user's "first set up" intent when several messaging adapters
 * are configured at once (rare in practice but spelled out in the spec).
 *
 * Why `rowid`: `owner_channels.platform` is a TEXT primary key, so each
 * row carries an implicit autoincrementing `rowid` that captures
 * insertion order. The first row inserted per platform comes from the
 * first inbound owner DM (`upsertOwnerChannel` from
 * dispatcher-message-handler.ts), which is the cleanest signal of "this
 * platform completed setup and is usable". `ON CONFLICT(platform) DO
 * UPDATE` preserves the original rowid across re-pairs, so the ordering
 * stays stable.
 *
 * Behavior:
 *  - `eligible` empty → null (caller treats as no-fallback)
 *  - single eligible → return it
 *  - multiple eligible → return the earliest-paired one
 *  - multiple eligible but none have an `owner_channels` row (env-var
 *    owner-id setup without ever DM'ing the bot) → return `eligible[0]`,
 *    which preserves the canonical-order tie-break
 */
export function selectFirstPairedPlatform(
  db: Database.Database,
  eligible: readonly string[],
): string | null {
  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0]!;

  const eligibleSet = new Set(eligible);
  const rows = db
    .prepare("SELECT platform FROM owner_channels ORDER BY rowid ASC")
    .all() as Array<{ platform: string }>;
  for (const { platform } of rows) {
    if (eligibleSet.has(platform)) return platform;
  }
  return eligible[0]!;
}


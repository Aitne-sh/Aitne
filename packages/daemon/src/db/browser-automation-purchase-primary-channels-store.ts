/**
 * Browser Automation Purchase Primary Channels — Phase B-4 owner-DM
 * primary-channel selection.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.8 / §13 step 55.
 *
 * The B-4 dashboard surfaces every owner DM channel with a
 * `primary:boolean` flag. Only primary channels receive the
 * purchase-confirmation DM. At least one primary channel is required
 * for B-4 to be enabled (the dashboard enable flow checks via
 * `countPrimaryChannels()` before flipping the master toggle on).
 *
 * The (platform, channel_id) shape mirrors the `owner_channels` table's
 * primary key — by convention every primary entry here must also exist
 * in `owner_channels` (the dashboard enforces this; the store does not
 * cross-check on write to keep the SQL surface small).
 *
 * Excluded from the 100% coverage gate — prepared statements only.
 */

import type Database from "better-sqlite3";

export interface PrimaryChannelRow {
  platform: string;
  channelId: string;
  setAt: number;
}

interface PrimaryChannelDbRow {
  platform: string;
  channel_id: string;
  set_at: number;
}

function fromDbRow(row: PrimaryChannelDbRow): PrimaryChannelRow {
  return {
    platform: row.platform,
    channelId: row.channel_id,
    setAt: row.set_at,
  };
}

export interface SetPrimaryChannelInput {
  platform: string;
  channelId: string;
  setAt: number;
}

export function setPrimaryChannel(
  db: Database.Database,
  input: SetPrimaryChannelInput,
): PrimaryChannelRow {
  db.prepare(
    `INSERT OR REPLACE INTO browser_automation_purchase_primary_channels
       (platform, channel_id, set_at)
     VALUES (?, ?, ?)`,
  ).run(input.platform, input.channelId, input.setAt);
  return {
    platform: input.platform,
    channelId: input.channelId,
    setAt: input.setAt,
  };
}

export function clearPrimaryChannel(
  db: Database.Database,
  platform: string,
  channelId: string,
): number {
  const result = db
    .prepare(
      `DELETE FROM browser_automation_purchase_primary_channels
        WHERE platform = ? AND channel_id = ?`,
    )
    .run(platform, channelId);
  return result.changes;
}

export function listPrimaryChannels(
  db: Database.Database,
): PrimaryChannelRow[] {
  const rows = db
    .prepare<[], PrimaryChannelDbRow>(
      `SELECT platform, channel_id, set_at
         FROM browser_automation_purchase_primary_channels
        ORDER BY platform, channel_id`,
    )
    .all();
  return rows.map(fromDbRow);
}

export function countPrimaryChannels(db: Database.Database): number {
  const row = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c
         FROM browser_automation_purchase_primary_channels`,
    )
    .get();
  return row?.c ?? 0;
}

/** Canonical `<platform>:<channel_id>` formatter — used by every site
 *  that needs to compare channel refs (token delivery list, inbound
 *  channel match, dashboard surfaces). Centralised so the separator
 *  cannot drift across modules. */
export function channelRef(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

/** Reverse parse — supports the `<platform>:<channel_id>` format. The
 *  channel_id can contain colons (Slack thread refs do), so we split
 *  only on the first colon. Returns null on malformed input. */
export function parseChannelRef(
  ref: string,
): { platform: string; channelId: string } | null {
  if (typeof ref !== "string") return null;
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { platform: ref.slice(0, idx), channelId: ref.slice(idx + 1) };
}

/** True when the ref equals an existing primary row. */
export function isPrimaryChannelRef(
  db: Database.Database,
  ref: string,
): boolean {
  const parsed = parseChannelRef(ref);
  if (!parsed) return false;
  const row = db
    .prepare<[string, string], { c: number }>(
      `SELECT COUNT(*) AS c
         FROM browser_automation_purchase_primary_channels
        WHERE platform = ? AND channel_id = ?`,
    )
    .get(parsed.platform, parsed.channelId);
  return (row?.c ?? 0) > 0;
}

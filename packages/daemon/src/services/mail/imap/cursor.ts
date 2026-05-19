import type { PollCursor } from "../provider.js";

export interface ImapFolderCursorState {
  uidValidity: number;
  lastUid: number;
}

export interface ImapCursorPlan {
  mode: "bootstrap" | "resume" | "resync";
  lastSeenUid: number;
  previousUidValidity: number | null;
}

export function formatImapProviderMsgId(
  uidValidity: number,
  uid: number,
): string {
  return `${uidValidity}:${uid}`;
}

export function parseImapProviderMsgId(
  value: string,
): { uidValidity: number; uid: number } | null {
  const match = value.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  return {
    uidValidity: Number.parseInt(match[1]!, 10),
    uid: Number.parseInt(match[2]!, 10),
  };
}

export function getImapFolderCursor(
  cursor: PollCursor | null,
  folder: string,
): ImapFolderCursorState | null {
  if (!cursor || cursor.kind !== "imap") return null;
  return cursor.folders[folder] ?? null;
}

export function planImapFolderSync(
  cursor: PollCursor | null,
  folder: string,
  serverUidValidity: number,
): ImapCursorPlan {
  const existing = getImapFolderCursor(cursor, folder);
  if (!existing) {
    return {
      mode: "bootstrap",
      lastSeenUid: 0,
      previousUidValidity: null,
    };
  }
  if (existing.uidValidity !== serverUidValidity) {
    return {
      mode: "resync",
      lastSeenUid: 0,
      previousUidValidity: existing.uidValidity,
    };
  }
  return {
    mode: "resume",
    lastSeenUid: existing.lastUid,
    previousUidValidity: existing.uidValidity,
  };
}

export function advanceImapCursor(
  cursor: PollCursor | null,
  folder: string,
  uidValidity: number,
  lastUid: number,
): PollCursor {
  const folders =
    cursor?.kind === "imap"
      ? { ...cursor.folders }
      : {};
  folders[folder] = { uidValidity, lastUid };
  return { kind: "imap", folders };
}


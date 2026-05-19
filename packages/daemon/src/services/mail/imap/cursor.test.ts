import { describe, expect, it } from "vitest";
import {
  advanceImapCursor,
  formatImapProviderMsgId,
  getImapFolderCursor,
  parseImapProviderMsgId,
  planImapFolderSync,
} from "./cursor.js";

describe("formatImapProviderMsgId / parseImapProviderMsgId", () => {
  it("round-trips UIDVALIDITY:UID ids", () => {
    const value = formatImapProviderMsgId(123456, 42);
    expect(value).toBe("123456:42");
    expect(parseImapProviderMsgId(value)).toEqual({
      uidValidity: 123456,
      uid: 42,
    });
  });

  it("rejects malformed ids", () => {
    expect(parseImapProviderMsgId("bad")).toBeNull();
    expect(parseImapProviderMsgId("123:")).toBeNull();
    expect(parseImapProviderMsgId(":42")).toBeNull();
  });
});

describe("planImapFolderSync", () => {
  it("bootstraps when no cursor exists", () => {
    expect(planImapFolderSync(null, "INBOX", 100)).toEqual({
      mode: "bootstrap",
      lastSeenUid: 0,
      previousUidValidity: null,
    });
  });

  it("resumes when UIDVALIDITY matches", () => {
    const cursor = advanceImapCursor(null, "INBOX", 100, 55);
    expect(planImapFolderSync(cursor, "INBOX", 100)).toEqual({
      mode: "resume",
      lastSeenUid: 55,
      previousUidValidity: 100,
    });
  });

  it("forces resync when UIDVALIDITY changes", () => {
    const cursor = advanceImapCursor(null, "INBOX", 100, 55);
    expect(planImapFolderSync(cursor, "INBOX", 200)).toEqual({
      mode: "resync",
      lastSeenUid: 0,
      previousUidValidity: 100,
    });
  });
});

describe("advanceImapCursor", () => {
  it("stores per-folder state and preserves other folders", () => {
    const cursor1 = advanceImapCursor(null, "INBOX", 100, 5);
    const cursor2 = advanceImapCursor(cursor1, "Drafts", 200, 9);

    expect(getImapFolderCursor(cursor2, "INBOX")).toEqual({
      uidValidity: 100,
      lastUid: 5,
    });
    expect(getImapFolderCursor(cursor2, "Drafts")).toEqual({
      uidValidity: 200,
      lastUid: 9,
    });
  });
});

describe("getImapFolderCursor", () => {
  it("returns null when folder key does not exist in cursor", () => {
    const cursor = advanceImapCursor(null, "INBOX", 100, 5);
    expect(getImapFolderCursor(cursor, "NonExistent")).toBeNull();
  });
});


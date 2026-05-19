import { describe, expect, it } from "vitest";
import {
  deriveCanonicalFolder,
  resolveImapFolders,
  resolveSpecialUseFolder,
  type ImapListedFolder,
} from "./folder-resolver.js";

const FOLDERS: ImapListedFolder[] = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "Sent Messages", specialUse: "\\Sent" },
  { path: "Drafts", specialUse: "\\Drafts" },
  { path: "Deleted Messages", flags: ["\\Trash"] },
  { path: "Archive", specialUse: "\\Archive" },
];

describe("resolveSpecialUseFolder", () => {
  it("prefers SPECIAL-USE folders over fallback names", () => {
    expect(resolveSpecialUseFolder(FOLDERS, "sent", "Sent")).toBe(
      "Sent Messages",
    );
    expect(resolveSpecialUseFolder(FOLDERS, "trash", "Trash")).toBe(
      "Deleted Messages",
    );
  });

  it("falls back to the provided canonical name when no match exists", () => {
    expect(resolveSpecialUseFolder([], "archive", "Archive")).toBe("Archive");
  });

  it("returns path by name match when no specialUse match but folder path equals fallbackName", () => {
    // No specialUse match for "archive" role, but folder path matches fallbackName "Archive".
    const folders: ImapListedFolder[] = [
      { path: "Archive" }, // no specialUse
    ];
    expect(resolveSpecialUseFolder(folders, "archive", "Archive")).toBe("Archive");
  });
});

describe("deriveCanonicalFolder", () => {
  it("maps special-use folders to canonical names", () => {
    expect(deriveCanonicalFolder({ path: "INBOX", specialUse: "\\Inbox" })).toBe(
      "inbox",
    );
    expect(
      deriveCanonicalFolder({ path: "Deleted Messages", flags: ["\\Trash"] }),
    ).toBe("trash");
  });

  it("infers canonical folders from common folder names", () => {
    expect(deriveCanonicalFolder({ path: "Spam" })).toBe("spam");
    expect(deriveCanonicalFolder({ path: "Sent Items" })).toBe("sent");
    expect(deriveCanonicalFolder({ path: "Random" })).toBeUndefined();
  });

  it("infers inbox, drafts, and trash by folder path name", () => {
    expect(deriveCanonicalFolder({ path: "Inbox" })).toBe("inbox");
    expect(deriveCanonicalFolder({ path: "My Drafts" })).toBe("drafts");
    expect(deriveCanonicalFolder({ path: "Trash Can" })).toBe("trash");
    expect(deriveCanonicalFolder({ path: "Deleted Items" })).toBe("trash");
  });
});

describe("resolveImapFolders", () => {
  it("resolves the standard folder set", () => {
    expect(
      resolveImapFolders(FOLDERS, {
        sent: "Sent",
        drafts: "Drafts",
        trash: "Trash",
        archive: "Archive",
      }),
    ).toEqual({
      inbox: "INBOX",
      sent: "Sent Messages",
      drafts: "Drafts",
      trash: "Deleted Messages",
      archive: "Archive",
    });
  });

  it("resolves folders when specialUse is an array", () => {
    const foldersWithArraySpecialUse: ImapListedFolder[] = [
      { path: "INBOX", specialUse: ["\\Inbox"] },
      { path: "Sent", specialUse: ["\\Sent"] },
      { path: "Drafts", specialUse: ["\\Drafts"] },
      { path: "Trash", specialUse: ["\\Trash"] },
    ];
    const resolved = resolveImapFolders(foldersWithArraySpecialUse, {
      sent: "Sent",
      drafts: "Drafts",
      trash: "Trash",
      archive: "Archive",
    });
    expect(resolved.sent).toBe("Sent");
    expect(resolved.drafts).toBe("Drafts");
  });
});


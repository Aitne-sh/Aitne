import type { CanonicalFolder } from "../provider.js";

export type ImapFolderRole = CanonicalFolder | "archive";

export interface ImapListedFolder {
  path: string;
  name?: string;
  specialUse?: string | string[] | null;
  flags?: Iterable<string> | null;
}

export interface ResolvedImapFolders {
  inbox: string;
  sent: string;
  drafts: string;
  trash: string;
  archive: string;
}

const SPECIAL_USE_ROLE_MAP: Record<string, ImapFolderRole> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  trash: "trash",
  archive: "archive",
  junk: "spam",
  spam: "spam",
};

export function resolveSpecialUseFolder(
  folders: readonly ImapListedFolder[],
  role: ImapFolderRole,
  fallbackName: string,
): string {
  const bySpecialUse = folders.find((folder) =>
    normalizeFolderFlags(folder).some(
      (token) => SPECIAL_USE_ROLE_MAP[token] === role,
    ),
  );
  if (bySpecialUse) return bySpecialUse.path;

  const byName = folders.find(
    (folder) => folder.path.localeCompare(fallbackName, undefined, { sensitivity: "accent" }) === 0,
  );
  if (byName) return byName.path;

  return fallbackName;
}

export function deriveCanonicalFolder(
  folder: ImapListedFolder,
): CanonicalFolder | undefined {
  const roles = normalizeFolderFlags(folder)
    .map((token) => SPECIAL_USE_ROLE_MAP[token])
    .filter(
      (value): value is Exclude<ImapFolderRole, "archive"> =>
        value !== undefined && value !== "archive",
    );
  if (roles.length > 0) return roles[0];

  const lowered = folder.path.trim().toLowerCase();
  if (lowered === "inbox") return "inbox";
  if (lowered.includes("sent")) return "sent";
  if (lowered.includes("draft")) return "drafts";
  if (lowered.includes("trash") || lowered.includes("deleted")) return "trash";
  if (lowered.includes("spam") || lowered.includes("junk")) return "spam";
  return undefined;
}

export function resolveImapFolders(
  folders: readonly ImapListedFolder[],
  hints: {
    sent: string;
    drafts: string;
    trash: string;
    archive: string;
  },
): ResolvedImapFolders {
  return {
    inbox: resolveSpecialUseFolder(folders, "inbox", "INBOX"),
    sent: resolveSpecialUseFolder(folders, "sent", hints.sent),
    drafts: resolveSpecialUseFolder(folders, "drafts", hints.drafts),
    trash: resolveSpecialUseFolder(folders, "trash", hints.trash),
    archive: resolveSpecialUseFolder(folders, "archive", hints.archive),
  };
}

function normalizeFolderFlags(folder: ImapListedFolder): string[] {
  const specialUse = Array.isArray(folder.specialUse)
    ? folder.specialUse
    : folder.specialUse
      ? [folder.specialUse]
      : [];
  const flags = folder.flags ? Array.from(folder.flags) : [];
  return [...specialUse, ...flags]
    .map((value) => value.trim().replaceAll(/^\\+/g, "").toLowerCase())
    .filter((value) => value.length > 0);
}


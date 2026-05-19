import { z } from "zod";
import type { MailProviderKind } from "../provider.js";

export type ImapAppPasswordKind = Extract<MailProviderKind, "yahoo" | "icloud">;

export interface ImapEndpointConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTls?: boolean;
}

export interface ImapFolderHints {
  sent: string;
  drafts: string;
  trash: string;
  archive: string;
}

export interface ImapAccountSecret {
  kind: ImapAppPasswordKind;
  email: string;
  appPassword: string;
  imap: ImapEndpointConfig;
  smtp: ImapEndpointConfig;
  folderHints: ImapFolderHints;
}

const SECRET_SCHEMA = z.object({
  kind: z.enum(["yahoo", "icloud"]),
  email: z.string().email(),
  appPassword: z.string().min(1),
  imap: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    secure: z.boolean(),
    requireTls: z.boolean().optional(),
  }),
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    secure: z.boolean(),
    requireTls: z.boolean().optional(),
  }),
  folderHints: z.object({
    sent: z.string().min(1),
    drafts: z.string().min(1),
    trash: z.string().min(1),
    archive: z.string().min(1),
  }),
});

const PRESETS: Record<ImapAppPasswordKind, Omit<ImapAccountSecret, "email" | "appPassword">> = {
  yahoo: {
    kind: "yahoo",
    imap: {
      host: "imap.mail.yahoo.com",
      port: 993,
      secure: true,
    },
    smtp: {
      host: "smtp.mail.yahoo.com",
      port: 465,
      secure: true,
    },
    folderHints: {
      sent: "Sent",
      drafts: "Drafts",
      trash: "Trash",
      archive: "Archive",
    },
  },
  icloud: {
    kind: "icloud",
    imap: {
      host: "imap.mail.me.com",
      port: 993,
      secure: true,
    },
    smtp: {
      host: "smtp.mail.me.com",
      port: 587,
      secure: false,
      requireTls: true,
    },
    folderHints: {
      sent: "Sent Messages",
      drafts: "Drafts",
      trash: "Deleted Messages",
      archive: "Archive",
    },
  },
};

export function isImapAppPasswordKind(
  kind: MailProviderKind | string,
): kind is ImapAppPasswordKind {
  return kind === "yahoo" || kind === "icloud";
}

export function buildImapAccountSecret(
  kind: ImapAppPasswordKind,
  email: string,
  appPassword: string,
): ImapAccountSecret {
  const preset = PRESETS[kind];
  return {
    kind,
    email,
    appPassword,
    imap: { ...preset.imap },
    smtp: { ...preset.smtp },
    folderHints: { ...preset.folderHints },
  };
}

export function serializeImapAccountSecret(secret: ImapAccountSecret): string {
  return JSON.stringify(secret);
}

export function parseImapAccountSecret(raw: string): ImapAccountSecret {
  return SECRET_SCHEMA.parse(JSON.parse(raw));
}

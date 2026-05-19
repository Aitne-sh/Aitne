import { describe, expect, it } from "vitest";
import {
  buildImapAccountSecret,
  isImapAppPasswordKind,
  parseImapAccountSecret,
  serializeImapAccountSecret,
} from "./app-password.js";

describe("isImapAppPasswordKind", () => {
  it("returns true only for yahoo and icloud", () => {
    expect(isImapAppPasswordKind("yahoo")).toBe(true);
    expect(isImapAppPasswordKind("icloud")).toBe(true);
    expect(isImapAppPasswordKind("gmail")).toBe(false);
    expect(isImapAppPasswordKind("outlook")).toBe(false);
  });
});

describe("buildImapAccountSecret", () => {
  it("builds Yahoo endpoint presets", () => {
    expect(
      buildImapAccountSecret("yahoo", "owner@example.com", "app-pass"),
    ).toEqual({
      kind: "yahoo",
      email: "owner@example.com",
      appPassword: "app-pass",
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
    });
  });

  it("builds iCloud endpoint presets", () => {
    expect(
      buildImapAccountSecret("icloud", "owner@example.com", "app-pass"),
    ).toEqual({
      kind: "icloud",
      email: "owner@example.com",
      appPassword: "app-pass",
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
    });
  });
});

describe("parseImapAccountSecret", () => {
  it("round-trips serialized secrets", () => {
    const secret = buildImapAccountSecret(
      "icloud",
      "owner@example.com",
      "secret",
    );
    expect(parseImapAccountSecret(serializeImapAccountSecret(secret))).toEqual(
      secret,
    );
  });

  it("rejects malformed JSON payloads", () => {
    expect(() => parseImapAccountSecret('{"kind":"gmail"}')).toThrow();
  });
});


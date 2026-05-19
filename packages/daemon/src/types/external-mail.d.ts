// Minimal type shims for mail-related packages that don't ship type
// definitions (nodemailer + mailparser are CommonJS-only and have no built-in
// .d.ts files). Only the surface area actually consumed by the daemon is
// modeled here — install `@types/nodemailer` / `@types/mailparser` if a wider
// API surface ever needs typing.

declare module "nodemailer" {
  export interface SendMailOptions {
    from?: string;
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    raw?: string | Buffer;
    inReplyTo?: string;
    references?: string | string[];
    envelope?: { from?: string; to?: string | string[] };
    headers?: Record<string, string>;
    attachments?: Array<{
      filename?: string;
      content?: string | Buffer;
      contentType?: string;
      cid?: string;
    }>;
  }

  export interface SentMessageInfo {
    messageId?: string;
    accepted?: string[];
    rejected?: string[];
    response?: string;
    envelope?: { from?: string; to?: string[] };
  }

  export interface Transporter {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>;
    verify(): Promise<true>;
    close(): void;
  }

  export interface TransportOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: { user: string; pass: string } | { type: "OAuth2"; user: string; accessToken: string };
    tls?: { rejectUnauthorized?: boolean; servername?: string };
    pool?: boolean;
    requireTLS?: boolean;
    connectionTimeout?: number;
    greetingTimeout?: number;
    socketTimeout?: number;
  }

  const nodemailer: {
    createTransport(options: TransportOptions): Transporter;
  };
  export default nodemailer;
}

declare module "mailparser" {
  export interface ParsedMailAddress {
    address?: string;
    name?: string;
  }
  export interface AddressObject {
    value: ParsedMailAddress[];
    html?: string;
    text?: string;
  }
  export interface ParsedAttachment {
    filename?: string;
    contentType?: string;
    contentDisposition?: string;
    contentId?: string;
    cid?: string;
    size?: number;
    content?: Buffer;
    headers?: Map<string, string>;
  }
  export interface ParsedMail {
    headers?: Map<string, unknown>;
    from?: AddressObject;
    to?: AddressObject | AddressObject[];
    cc?: AddressObject | AddressObject[];
    bcc?: AddressObject | AddressObject[];
    subject?: string;
    date?: Date;
    messageId?: string;
    inReplyTo?: string;
    references?: string | string[];
    text?: string;
    html?: string | false;
    textAsHtml?: string;
    attachments: ParsedAttachment[];
  }
  export function simpleParser(source: Buffer | string): Promise<ParsedMail>;
}

declare module "nodemailer/lib/mail-composer/index.js" {
  const MailComposer: new (options: Record<string, unknown>) => {
    compile(): {
      build(callback: (error: Error | null, message: Buffer) => void): void;
    };
  };
  export default MailComposer;
}

import { ImapProviderBase } from "./imap-provider-base.js";

export class ICloudImapProvider extends ImapProviderBase {
  readonly kind = "icloud" as const;
}

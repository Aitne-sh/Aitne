import { ImapProviderBase } from "./imap-provider-base.js";

export class YahooImapProvider extends ImapProviderBase {
  readonly kind = "yahoo" as const;
}

import type { ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import type { EncryptedBlobStore } from "../../../secrets/encrypted-blob-store.js";
import { mailAccountBlobName } from "../provider.js";

/**
 * Persists MSAL's serialized token cache for one Outlook account into the
 * EncryptedBlobStore. We do NOT roll our own refresh-token handling — MSAL
 * does this when its cache is populated and `acquireTokenSilent()` is called.
 *
 * Blob layout: `mail:outlook:<accountId>` containing the JSON returned by
 * `cache.serialize()`. Per-account cache because each Microsoft account has
 * its own home tenant + claims state.
 */
export class EncryptedBlobCachePlugin implements ICachePlugin {
  private readonly blobName: string;

  constructor(
    private readonly blobStore: EncryptedBlobStore,
    accountId: string,
  ) {
    this.blobName = mailAccountBlobName("outlook", accountId);
  }

  async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
    const raw = await this.blobStore.readUtf8(this.blobName);
    if (raw) {
      context.tokenCache.deserialize(raw);
    }
  }

  async afterCacheAccess(context: TokenCacheContext): Promise<void> {
    if (context.cacheHasChanged) {
      await this.blobStore.writeUtf8(this.blobName, context.tokenCache.serialize());
    }
  }
}

import {
  PublicClientApplication,
  type Configuration,
  LogLevel,
} from "@azure/msal-node";
import { authorityForTenant, type OutlookClientConfig } from "./client-config.js";
import type { EncryptedBlobStore } from "../../../secrets/encrypted-blob-store.js";
import { EncryptedBlobCachePlugin } from "./msal-cache-plugin.js";
import { createLogger } from "../../../logging.js";

const logger = createLogger("outlook-msal");

/**
 * PCA used during the *bootstrap* OAuth flow. No cache plugin — the cache
 * lives in process memory until the caller serializes it post-success and
 * hands the payload to MailAccountRegistry.addAccount(secretPayload).
 *
 * This sidesteps the chicken-and-egg of "the cache plugin needs an accountId,
 * but the accountId only exists after addAccount has run." The runtime PCA
 * (see {@link createRuntimeMsalApp}) gets the cache plugin pointed at the
 * stable accountId-derived blob name.
 */
export function createBootstrapMsalApp(
  clientConfig: OutlookClientConfig,
): PublicClientApplication {
  const config: Configuration = {
    auth: {
      clientId: clientConfig.clientId,
      authority: authorityForTenant(clientConfig.tenant),
    },
    system: {
      loggerOptions: {
        loggerCallback: (level, message) => {
          if (level === LogLevel.Error) logger.error({ msal: message }, "msal error");
        },
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
      },
    },
  };
  return new PublicClientApplication(config);
}

/**
 * PCA used at runtime for an existing account. Cache plugin reads/writes the
 * per-account blob on every acquireTokenSilent — MSAL handles refresh.
 */
export function createRuntimeMsalApp(
  clientConfig: OutlookClientConfig,
  accountId: string,
  blobStore: EncryptedBlobStore,
): PublicClientApplication {
  const config: Configuration = {
    auth: {
      clientId: clientConfig.clientId,
      authority: authorityForTenant(clientConfig.tenant),
    },
    cache: {
      cachePlugin: new EncryptedBlobCachePlugin(blobStore, accountId),
    },
    system: {
      loggerOptions: {
        loggerCallback: (level, message) => {
          if (level === LogLevel.Error) {
            logger.error({ msal: message, accountId }, "msal error");
          }
        },
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
      },
    },
  };
  return new PublicClientApplication(config);
}

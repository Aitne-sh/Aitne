import type { AuthenticationResult, PublicClientApplication } from "@azure/msal-node";
import {
  OUTLOOK_SCOPES,
  type OutlookClientConfig,
} from "./client-config.js";
import { createBootstrapMsalApp } from "./msal-app-factory.js";

export interface DeviceCodePromptInfo {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  message: string;
}

export interface DeviceCodeOAuthDeps {
  clientConfig: OutlookClientConfig;
  /** Receives the polling-instructions payload so the dashboard can show user_code + verification_uri. */
  onPrompt: (info: DeviceCodePromptInfo) => void | Promise<void>;
  appFactory?: (config: OutlookClientConfig) => PublicClientApplication;
}

export interface DeviceCodeOAuthResult {
  authResult: AuthenticationResult;
  serializedCache: string;
  email: string;
}

/**
 * Device-code fallback (§6.1) for headless or browser-less environments.
 * MSAL handles polling internally — the caller just receives the prompt and
 * the eventual AuthenticationResult.
 */
export async function runDeviceCodeOAuth(
  deps: DeviceCodeOAuthDeps,
): Promise<DeviceCodeOAuthResult> {
  const appFactory = deps.appFactory ?? createBootstrapMsalApp;
  const app = appFactory(deps.clientConfig);

  const authResult = await app.acquireTokenByDeviceCode({
    scopes: [...OUTLOOK_SCOPES],
    deviceCodeCallback: (info) => {
      void deps.onPrompt({
        userCode: info.userCode,
        verificationUri: info.verificationUri,
        expiresIn: info.expiresIn,
        message: info.message,
      });
    },
  });

  if (!authResult || !authResult.account?.username) {
    throw new Error("device_code_no_account");
  }

  const serializedCache = app.getTokenCache().serialize();
  return {
    authResult,
    serializedCache,
    email: authResult.account.username,
  };
}

import type { PersonalAgentKeychainClient } from "@aitne/shared/keychain-helper-client";
import { redactSensitiveString } from "@aitne/shared";

let secretClientPromise: Promise<Pick<PersonalAgentKeychainClient, "get">> | null = null;

export interface ResolveDaemonApiTokenOptions {
  env?: NodeJS.ProcessEnv;
  client?: Pick<PersonalAgentKeychainClient, "get">;
}

export async function resolveDaemonApiToken(
  options: ResolveDaemonApiTokenOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  if (env.PA_API_TOKEN) {
    return env.PA_API_TOKEN;
  }

  const client = options.client ?? await getDefaultSecretClient();
  return await client.get("apiToken");
}

export function redactProxyErrorMessage(input: string): string {
  return redactSensitiveString(input);
}

async function getDefaultSecretClient(): Promise<Pick<PersonalAgentKeychainClient, "get">> {
  if (!secretClientPromise) {
    secretClientPromise = import("@aitne/shared/secret-client-factory").then(
      ({ createSecretClient }) => createSecretClient(),
    );
  }

  return await secretClientPromise;
}

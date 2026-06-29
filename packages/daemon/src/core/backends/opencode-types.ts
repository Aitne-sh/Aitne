/**
 * docs/design/appendices/opencode-backend.md §6.1.0 — local module augmentation + helper
 * types for the four undeclared surfaces that V3/V4/V9 confirmed exist
 * at runtime in opencode 1.14.50 but are missing from the SDK's
 * generated types.
 *
 * The `declare module "@opencode-ai/sdk"` block adds the three runtime
 * fields the SDK omits (format on the prompt body, structured on the
 * assistant message, total on the token block). The helper types below
 * widen the event union so we never compile against the SDK's
 * incomplete `EventSubscribeResponse`.
 */

declare module "@opencode-ai/sdk" {
  export interface SessionPromptBodyAugmented {
    format?: {
      type: "json_schema";
      schema: object;
      retryCount?: number;
    };
  }

  export interface AssistantMessageAugmented {
    structured?: unknown;
  }

  export interface AssistantTokensAugmented {
    total?: number;
  }
}

/**
 * V9-grounded event-input type. The SDK's generated
 * `EventSubscribeResponse` union is **incomplete** (server.heartbeat,
 * permission.asked emit but are not declared) and over-promises
 * (permission.replied, message.part.updated declared but never observed).
 * Defensive code therefore widens to a plain string-key dispatch.
 */
export type RawOpencodeEvent = {
  type: string;
  properties?: unknown;
};

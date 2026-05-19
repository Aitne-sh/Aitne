"use client";

import { Alert } from "@/components/ui/alert";

/**
 * Warning surfaced wherever the operator sees the per-backend API-key
 * panel (setup wizard's AI Backends step, /settings/models). Skipping
 * the API key falls the daemon back to the CLI's local subscription
 * auth, which providers explicitly discourage for programmatic use —
 * Anthropic in particular currently prohibits running the Agent SDK on a
 * Claude Pro / Max subscription. Provider policies change frequently, so
 * we surface the warning rather than silently relying on the fallback.
 */
export function SubscriptionAuthWarning() {
  return (
    <Alert variant="warning">
      <p className="font-semibold">
        API key recommended — subscription auth is not supported by all
        providers
      </p>
      <p className="mt-1 leading-relaxed">
        You can skip API key setup and the daemon will fall back to each
        backend&rsquo;s local CLI login (subscription auth). Most providers
        do not officially support running automated agents on a
        subscription plan; <strong>Anthropic currently prohibits</strong>{" "}
        using the Claude Agent SDK with a Claude Pro / Max subscription.
        Provider policies change often — to stay clear of the gray area,
        register a paid API key here.
      </p>
    </Alert>
  );
}

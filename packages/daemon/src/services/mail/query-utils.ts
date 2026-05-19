/**
 * Cross-provider query-translator helpers shared by IMAP and Outlook (Graph).
 *
 * Gmail's translator is intentionally not a consumer — Gmail accepts its own
 * native search syntax verbatim and does not need these helpers.
 */

/**
 * Parse a relative-day token like `"7d"` → `7`. Returns `null` when the
 * input does not match the `^\d+d$` shape so the caller can decide between a
 * silent skip and a `unsupported_token:<raw>` warning.
 */
export function parseDays(input: string): number | null {
  const match = input.match(/^(\d+)d$/);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

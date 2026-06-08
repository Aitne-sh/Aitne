export const SENSITIVE_KEY_PATTERN = /(token|secret|password|apikey|api_key|authorization|bearer|credentials|refresh_token|access_token)/i;

// Ordering matters. Provider-specific high-precision patterns run first so
// that a value like `1234567890:AAE…` gets fully redacted including the
// numeric ID half, instead of being only partially scrubbed by the generic
// `[A-Za-z0-9_-]{32,}` fallback at the bottom. Base64-with-padding still
// runs before the generic word-char rule because the latter would otherwise
// consume the alphabetic body and leave a trailing `=` visible.
const SECRET_VALUE_PATTERNS = [
  // ── Provider-specific structured tokens ────────────────────────────
  // Anthropic API keys (sk-ant-*).
  /\bsk-ant-[A-Za-z0-9\-_]+\b/g,
  // OpenAI-style sk-* keys (sk-, sk-proj-, sk-svcacct-).
  /\bsk-[A-Za-z0-9_\-]{30,}\b/g,
  // Stripe (sk_live_*, sk_test_*, pk_live_*, pk_test_*, rk_*, restricted keys).
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  // Google API keys: AIza prefix, 39 chars total.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Google OAuth refresh tokens: `1//0…` prefix is the documented Google
  // refresh-token format. Length varies but the prefix is distinctive enough
  // to match safely.
  /\b1\/\/0[A-Za-z0-9_-]{20,}\b/g,
  // Google OAuth access tokens: `ya29.` prefix. Short/medium variants slip
  // past the generic ≥40-char fallback below, and these routinely surface in
  // googleapis error / debug strings on the calendar/gmail refresh paths.
  // No trailing `\b` — the token can end in `.`/`-`/`_` where `\b` would not fire.
  /\bya29\.[A-Za-z0-9._-]{10,}/g,
  // Slack bot / app / user tokens.
  /\bxoxb-[A-Za-z0-9\-]+\b/g,
  /\bxapp-[A-Za-z0-9\-]+\b/g,
  /\bxoxp-[A-Za-z0-9\-]+\b/g,
  // GitHub PATs / OAuth / Server tokens (ghp_, gho_, ghu_, ghs_).
  /\bgh[pous]_[A-Za-z0-9]+\b/g,
  // Telegram bot tokens: `<8-12 digit bot id>:<35+ char hash>`. Without
  // this explicit rule the numeric ID half stayed in plaintext because the
  // 32+ char generic pattern only matches contiguous word chars and the
  // `:` separator breaks the match. Reason this prefix needs scrubbing:
  // it identifies the bot and combined with stale log diff can leak the
  // owner's deployment.
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  // Notion integration secrets — explicit prefix variants. Notion v1 uses
  // `secret_<43 chars>`; v2 introduced `ntn_<43 chars>`. Length-bound at
  // 20 to stay tolerant of future suffix changes.
  /\bsecret_[A-Za-z0-9]{20,}\b/g,
  /\bntn_[A-Za-z0-9]{20,}\b/g,
  // Discord bot tokens: three base64-url segments separated by dots,
  // first segment ≥24 chars (`M…`/`N…`/`O…`), middle 6 chars, last 27+.
  /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b/g,
  // AWS access key IDs (the matching secret access key is 40-char
  // base64-ish and is caught by the generic base64 rule below).
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  // JWTs — three base64url segments (`eyJ…`-prefixed first segment is
  // the standard JWT header marker). Catches Auth0, Supabase, and any
  // other JWT-issuing provider.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // ── Generic header patterns ──────────────────────────────────────
  /\bX-Read-Token:\s*[A-Za-z0-9_-]{20,}\b/gi,
  /\bBearer\s+[A-Za-z0-9_\-]{20,}\b/g,
  // URL basic-auth / connection-string credentials —
  // `scheme://user:password@host`. Redacts ONLY the password (between the
  // `://user:` userinfo and the `@`) so the scheme + user + host stay
  // legible in logs. Covers https/imap/smtp/postgres/etc. The username part
  // allows `@` (real IMAP/SMTP strings use an email as the username) but NOT
  // `/`, so the bounded variable-length lookbehind can't cross out of the
  // authority into a path. The password itself stops at the first `@`.
  /(?<=:\/\/[^/\s:]{0,256}:)[^/\s@]+(?=@)/g,
  // ── Generic high-entropy strings ─────────────────────────────────
  /\b[A-Fa-f0-9]{32,}\b/g,
  // Ordering matters: base64-with-padding must run BEFORE the generic
  // 32+ word-char pattern, otherwise the word-char match consumes the
  // alphabetic portion and leaves a trailing `=` visible.
  /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g,
  /\b[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
] as const;

// Short app passwords (e.g. Google's 16-char app passwords, IMAP-specific
// passwords) are deliberately NOT pattern-matched here. Their entropy is
// indistinguishable from ordinary 16-char identifiers (UUID fragments,
// short hashes, version strings) so a regex broad enough to catch them
// would produce too many false positives in logs.
//
// Mitigation strategy: rely on `SENSITIVE_KEY_PATTERN` in the
// field-name-based redactor (logging.ts `redactLogValue`), which scrubs
// the entire value when the key contains `password` / `secret` / etc.
// Code paths that log raw strings containing user-supplied passwords are
// audited separately — there should be none, and a static grep guard
// is acceptable as a follow-up if one ever lands.

export function redactSensitiveString(
  input: string,
  replacement = "[REDACTED]",
): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

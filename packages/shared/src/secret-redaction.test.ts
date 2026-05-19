import { describe, expect, it } from "vitest";
import { redactSensitiveString } from "./secret-redaction.js";

describe("secret-redaction", () => {
  it("redacts known token patterns in strings", () => {
    expect(redactSensitiveString("token xoxb-secret-value")).toContain("[REDACTED]");
    expect(
      redactSensitiveString("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"),
    ).toContain("[REDACTED]");
    expect(
      redactSensitiveString("X-Read-Token: 0qrNdOODwrYYkyaVNeTaVjWbNt4LqKx6"),
    ).toContain("[REDACTED]");
    expect(
      redactSensitiveString("base64 QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5MDEyMzQ="),
    ).toContain("[REDACTED]");
    expect(
      redactSensitiveString("base64url 0qrNdOODwrYYkyaVNeTaVjWbNt4LqKx6"),
    ).toContain("[REDACTED]");
  });

  it("redacts dedicated provider keys (Anthropic, OpenAI, Stripe, Google, Slack, GitHub)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["anthropic", "sk-ant-api03-" + "A".repeat(40)],
      ["openai-legacy", "sk-" + "B".repeat(45)],
      ["openai-project", "sk-proj-" + "C".repeat(45)],
      ["stripe-live", "sk_live_" + "D".repeat(24)],
      ["stripe-test", "pk_test_" + "E".repeat(24)],
      ["google-api", "AIza" + "F".repeat(35)],
      ["slack-bot", "xoxb-" + "G".repeat(20)],
      ["slack-user", "xoxp-" + "H".repeat(20)],
      ["github-pat", "ghp_" + "I".repeat(36)],
    ];
    for (const [label, secret] of cases) {
      const redacted = redactSensitiveString(`${label} ${secret}`);
      expect(redacted, `failed to redact ${label}`).not.toContain(secret);
      expect(redacted).toContain("[REDACTED]");
    }
  });

  it("redacts Telegram bot tokens including the numeric bot-id prefix", () => {
    // `<bot id>:<hash>` — the bot id alone identifies the deployment, so
    // a regex that only scrubs the hash half is insufficient.
    const token = "1234567890:AAEhBOweik6ad9r_DhKx5GhASq4eIwbU9rk";
    const redacted = redactSensitiveString(`telegram ${token}`);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain("1234567890:");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts Notion integration secrets explicitly (secret_*, ntn_*)", () => {
    const v1 = "secret_" + "A".repeat(43);
    const v2 = "ntn_" + "B".repeat(43);
    expect(redactSensitiveString(`notion ${v1}`)).not.toContain(v1);
    expect(redactSensitiveString(`notion ${v2}`)).not.toContain(v2);
  });

  it("redacts Discord bot tokens (three base64url segments)", () => {
    const token = "M" + "A".repeat(23) + "." + "B".repeat(6) + "." + "C".repeat(27);
    expect(redactSensitiveString(`discord ${token}`)).not.toContain(token);
  });

  it("redacts Google OAuth refresh tokens (1//0… prefix)", () => {
    const token = "1//0" + "G".repeat(40);
    expect(redactSensitiveString(`google ${token}`)).not.toContain(token);
  });

  it("redacts AWS access key IDs (AKIA / ASIA)", () => {
    const k1 = "AKIA" + "ABCDEFGHIJKLMNOP";
    const k2 = "ASIA" + "QRSTUVWXYZ012345";
    expect(redactSensitiveString(`aws ${k1}`)).not.toContain(k1);
    expect(redactSensitiveString(`aws ${k2}`)).not.toContain(k2);
  });

  it("redacts JWTs (eyJ… header-prefixed three-segment tokens)", () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9" +
      "." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0" +
      "." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSensitiveString(`auth ${token}`)).not.toContain(token);
  });

  describe("no false positives on common benign strings", () => {
    // Negative coverage — proves the broader patterns (Telegram numeric
    // prefix, generic 32+ word-char rule) do NOT scrub strings that
    // look like timestamps, versions, normal URLs, or short hashes.
    it("leaves ISO-8601 timestamps untouched", () => {
      const ts = "2026-05-12T10:30:45.123Z";
      expect(redactSensitiveString(`event at ${ts}`)).toContain(ts);
    });

    it("leaves Unix epoch timestamps untouched", () => {
      const ts = "1717891234";
      expect(redactSensitiveString(`epoch=${ts}`)).toContain(ts);
    });

    it("leaves semver versions and build identifiers untouched", () => {
      const v = "v1.2.3-rc.4+build.567";
      expect(redactSensitiveString(`version ${v}`)).toContain(v);
    });

    it("leaves short identifiers (UUIDs, git SHAs ≤ 7 chars) untouched", () => {
      // git short SHAs (7 chars) sit comfortably below the 32+ threshold.
      const sha = "abc1234";
      expect(redactSensitiveString(`commit ${sha}`)).toContain(sha);
    });

    it("leaves regular URLs without 32+ char path segments untouched", () => {
      const url = "https://example.com/path/to/resource?id=42";
      expect(redactSensitiveString(`see ${url}`)).toContain(url);
    });

    it("leaves <12 digit numbers : alphanumeric sequences shorter than 30 chars", () => {
      // Telegram regex requires \d{8,12}:[A-Za-z0-9_-]{30,}. A timestamp
      // followed by a short identifier MUST NOT trigger it.
      const benign = "1700123456:short-id-here";
      expect(redactSensitiveString(`log ${benign}`)).toContain(benign);
    });

    it("redacts the FULL 32-char generic high-entropy string with no leftover suffix", () => {
      // Sanity-check the ordering invariant: a 40+ char base64 with
      // padding must be redacted ENTIRELY (no trailing `=` leak).
      const padded = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5MDEyMzQ=";
      const out = redactSensitiveString(`secret ${padded}`);
      expect(out).not.toContain(padded);
      expect(out).not.toContain("=");
    });
  });
});

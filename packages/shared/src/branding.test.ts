import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_ROLE_DESCRIPTOR,
  APP_NAME,
  APP_TAGLINE,
  joinTaglineWithSentence,
  substituteBrandTokens,
} from "./branding.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

describe("branding", () => {
  it("APP_NAME is a non-empty string", () => {
    expect(typeof APP_NAME).toBe("string");
    expect(APP_NAME.length).toBeGreaterThan(0);
  });

  it("AGENT_ROLE_DESCRIPTOR is the LLM role anchor, decoupled from the brand", () => {
    // The role descriptor must remain a high-prior phrase from instruction-
    // tuning data ("personal agent" / "personal assistant"). Rebranding the
    // product must not weaken role activation.
    expect(AGENT_ROLE_DESCRIPTOR).toMatch(/personal (agent|assistant)/);
  });

  it("APP_TAGLINE is short and human-readable", () => {
    // Structural constraints only. The tagline is impact-focused, not role-
    // anchored — the role anchor lives in AGENT_ROLE_DESCRIPTOR, which is
    // what the LLM sees in <agent_identity>. Length cap protects against a
    // future "marketing copy" tagline that would blow out meta description
    // and welcome-step layout.
    expect(typeof APP_TAGLINE).toBe("string");
    expect(APP_TAGLINE.length).toBeGreaterThan(0);
    expect(APP_TAGLINE.length).toBeLessThan(60);
  });
});

describe("joinTaglineWithSentence", () => {
  // Defends against punctuation drift: a tagline that ends in a period
  // (e.g. APP_TAGLINE = "Always on. Always yours.") concatenated with a
  // following sentence would render as "yours.. Monitor..." without this
  // helper. The test pins both branches — period-terminated and bare —
  // so future tagline swaps cannot silently regress meta description or
  // markdown lead surfaces.

  it("appends a period when the tagline does not end in terminal punctuation", () => {
    expect(joinTaglineWithSentence("Bare tagline", "Monitor it.")).toBe(
      "Bare tagline. Monitor it.",
    );
  });

  it("does not append a period when the tagline already ends in one", () => {
    expect(
      joinTaglineWithSentence("Always on. Always yours.", "Monitor it."),
    ).toBe("Always on. Always yours. Monitor it.");
  });

  it("recognizes ! ? and … as terminal punctuation", () => {
    expect(joinTaglineWithSentence("Watch this!", "More.")).toBe("Watch this! More.");
    expect(joinTaglineWithSentence("Why not?", "More.")).toBe("Why not? More.");
    expect(joinTaglineWithSentence("And so on…", "More.")).toBe("And so on… More.");
  });

  it("trims trailing whitespace before checking punctuation", () => {
    expect(joinTaglineWithSentence("Yours.   ", "Monitor.")).toBe("Yours. Monitor.");
    expect(joinTaglineWithSentence("Yours   ", "Monitor.")).toBe("Yours. Monitor.");
  });

  it("substituteBrandTokens replaces {APP_NAME} with the product name", () => {
    expect(substituteBrandTokens("Hello {APP_NAME}!")).toBe(`Hello ${APP_NAME}!`);
  });

  it("substituteBrandTokens replaces every occurrence", () => {
    const out = substituteBrandTokens("{APP_NAME} talks to {APP_NAME} about {APP_NAME}");
    expect(out).toBe(`${APP_NAME} talks to ${APP_NAME} about ${APP_NAME}`);
  });

  it("substituteBrandTokens is idempotent", () => {
    const once = substituteBrandTokens("Welcome to {APP_NAME}");
    const twice = substituteBrandTokens(once);
    expect(twice).toBe(once);
  });

  it("substituteBrandTokens leaves unrelated tokens untouched", () => {
    // resolveTemplate handles `{event_data[X]}` and `{context}` later in the
    // pipeline — the brand substitutor must not eat them.
    const src = "Event: {event_data[type]} / Context: {context} / Brand: {APP_NAME}";
    expect(substituteBrandTokens(src)).toBe(
      `Event: {event_data[type]} / Context: {context} / Brand: ${APP_NAME}`,
    );
  });

  it("substituteBrandTokens does not match similar but distinct tokens", () => {
    expect(substituteBrandTokens("{APP_NAMES}")).toBe("{APP_NAMES}");
    expect(substituteBrandTokens("{appname}")).toBe("{appname}");
    expect(substituteBrandTokens("APP_NAME")).toBe("APP_NAME");
  });

  it("substituteBrandTokens passes through content without tokens", () => {
    expect(substituteBrandTokens("plain text")).toBe("plain text");
    expect(substituteBrandTokens("")).toBe("");
  });

  it("substituteBrandTokens treats $-escapes in APP_NAME as literal", () => {
    // Defense against `String.prototype.replace` interpreting `$&` / `$1`
    // in the replacement value. The current APP_NAME has no special chars,
    // but the test pins the property so a future rebrand to e.g. "$Brand"
    // can't silently corrupt every materialized prompt.
    const tricky = "before {APP_NAME} after $& $1";
    const out = substituteBrandTokens(tricky);
    expect(out).toBe(`before ${APP_NAME} after $& $1`);
  });
});

describe("brand-token end-to-end through agent-assets/", () => {
  // Empirical proof of the single-point-of-change contract: every markdown
  // file currently using `{APP_NAME}` must (a) actually contain the literal
  // token on disk and (b) resolve cleanly through substituteBrandTokens.
  // If a future PR adds a hardcoded "Aitne" in one of these files instead of
  // the token, this test catches the drift.
  const TOKEN_FILES = [
    "agent-assets/agent-profiles/docs-qa.md",
    "agent-assets/task-flows/dashboard.docs_qa.md",
    "agent-assets/task-flows/routine.monthly_review.md",
    "agent-assets/skills/docs-search/SKILL.md",
  ] as const;

  for (const rel of TOKEN_FILES) {
    it(`${rel} uses {APP_NAME} token, not a hardcoded brand`, () => {
      const raw = readFileSync(join(REPO_ROOT, rel), "utf-8");
      expect(raw, `${rel}: source must use {APP_NAME} token`).toContain(
        "{APP_NAME}",
      );
      const resolved = substituteBrandTokens(raw);
      expect(resolved, `${rel}: substitution must resolve all tokens`).not.toContain(
        "{APP_NAME}",
      );
      expect(resolved, `${rel}: substitution must inject APP_NAME`).toContain(
        APP_NAME,
      );
    });
  }
});

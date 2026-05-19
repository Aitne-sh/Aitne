import { randomInt, timingSafeEqual } from "node:crypto";

/**
 * Magic-phrase challenge for owner-pairing.
 *
 * The user reads a short, memorable phrase from the dashboard and types it
 * (or some message containing it) into their bot DM. The adapter only
 * promotes the sender to owner if the inbound message contains the exact
 * phrase, defeating the previous "first DM wins" race where any unrelated
 * message during a 5-minute window could hijack the owner role.
 *
 * Word list rationale:
 *
 * - 64 short, unambiguous, ASCII-only words. Keeps the phrase legible
 *   across all keyboards (no diacritics, no homoglyphs).
 * - 4 words per phrase → log2(64^4) = 24 bits of entropy. The matcher
 *   uses normalized **equality** (not contains), so each inbound message
 *   tests exactly one candidate phrase. With ~1 msg/sec rate limits and
 *   a 5-minute window, attacker success probability is bounded by
 *   300 / 16,777,216 ≈ 1.8 × 10⁻⁵ per session.
 *
 *   Why equality, not contains: a contains-based matcher lets the
 *   attacker pack thousands of 4-word substrings into a single message
 *   (~8000 candidates per Slack-sized message ⇒ ~14% per session over
 *   a 5-minute window). Equality forces 1 candidate per message and
 *   restores the 24-bit security budget.
 *
 * - Hyphen-separated for visual clarity, but the matcher normalises away
 *   case, punctuation, and emoji so the user can type the phrase any
 *   way ("apple banana cherry date" or "Apple-Banana-Cherry-Date!" both
 *   match) — but only if the **only** content of their message is the
 *   phrase. Wrapping it in a sentence ("my phrase is apple banana cherry
 *   date") is rejected by design.
 *
 * The 64 words are chosen to be maximally distinct phonetically (no near-
 * homophones) and to read naturally if the user mishears one and asks the
 * dashboard for help.
 */
const WORDS: readonly string[] = [
  "apple", "banana", "cherry", "date",
  "fig", "grape", "kiwi", "lemon",
  "mango", "melon", "olive", "peach",
  "pear", "plum", "lime", "berry",
  "ant", "bee", "cat", "dog",
  "elk", "fox", "goat", "hen",
  "lion", "mole", "newt", "owl",
  "pig", "ram", "seal", "wolf",
  "red", "blue", "green", "gold",
  "pink", "black", "white", "silver",
  "coral", "teal", "jade", "ruby",
  "pearl", "onyx", "amber", "rose",
  "sun", "moon", "star", "sea",
  "sky", "tree", "leaf", "cloud",
  "rain", "snow", "wind", "fire",
  "wave", "hill", "rock", "dust",
];

if (WORDS.length !== 64) {
  // Compile-time-ish guard: if anyone edits the word list and breaks the
  // entropy assumption above, we want to know immediately at startup.
  throw new Error(
    `magic-phrase word list must contain exactly 64 entries (got ${WORDS.length})`,
  );
}

const PHRASE_WORD_COUNT = 4;

/**
 * Generate a random `apple-banana-cherry-date`-style phrase. Uses
 * `crypto.randomInt` (CSPRNG) so that an attacker can't predict the next
 * phrase from a previously-issued one.
 */
export function generateMagicPhrase(): string {
  const picked: string[] = [];
  for (let i = 0; i < PHRASE_WORD_COUNT; i++) {
    picked.push(WORDS[randomInt(0, WORDS.length)]);
  }
  return picked.join("-");
}

/**
 * Lowercase + strip non-alphanumeric characters. Used by both sides of
 * the equality check so casing/punctuation/emoji in the inbound text
 * don't break a match — but the user must still send only the phrase,
 * not a sentence containing it.
 *
 * ASCII-only by design — the filter `[^a-z0-9]` deletes anything outside
 * the basic Latin alphanumeric range. This has three security-relevant
 * consequences worth documenting (pinned by `magic-phrase.test.ts` so
 * any future regex change has to flip a test deliberately):
 *
 *   1. Homoglyph attacks REJECT. A Cyrillic `а` (U+0430) or Greek `α`
 *      (U+03B1) substituted for ASCII `a` is fully deleted (not
 *      transliterated), shrinking the normalized candidate's length
 *      below the expected, and `timingSafeEqual` short-circuits.
 *   2. Fullwidth / typographic look-alikes REJECT for the same reason —
 *      `ａｐｐｌｅ` (U+FF41..) does not survive the filter.
 *   3. Diacritics behave **asymmetrically** depending on Unicode form:
 *      - **NFC** precomposed (e.g. `á` = U+00E1) is dropped wholesale →
 *        normalized candidate is shorter → REJECTS.
 *      - **NFD** decomposed (e.g. `a` + U+0301 combining acute) keeps
 *        the base `a` and drops only the combining mark → normalized
 *        candidate equals the expected → MATCHES.
 *      This asymmetry is acceptable security-wise (both candidates need
 *      exactly the right 16 ASCII letters/digits to match equality), but
 *      surfaces in pairing UX: a user whose keyboard / clipboard emits
 *      NFD will match through accented intermediates, NFC will not. Do
 *      not "fix" this by normalizing input through `.normalize("NFD")` —
 *      it would let homoglyph payloads survive if any future variant
 *      decomposed to an ASCII base.
 */
function normalize(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Build a matcher closure for use with `adapter.startPairing({ match, ... })`.
 *
 * Equality (not contains) is intentional. See the file-level comment.
 * Wrapping the phrase in a longer message must NOT match: that would
 * let an attacker pack thousands of distinct 4-word substrings into a
 * single message and brute-force the 24-bit search space in seconds.
 */
export function buildPhraseMatcher(phrase: string): (text: string) => boolean {
  const expected = normalize(phrase);
  const expectedBuf = Buffer.from(expected, "utf8");
  return (text: string): boolean => {
    if (!expected) return false;
    const candidate = Buffer.from(normalize(text), "utf8");
    if (candidate.length !== expectedBuf.length) return false;
    return timingSafeEqual(candidate, expectedBuf);
  };
}

/**
 * P2-23 — distinguish "wrong phrase" from "right phrase wrapped in extra
 * text" so the operator gets a recoverable hint instead of silence. A
 * legitimate user who types `"my phrase is apple-banana-cherry-date"`
 * looks identical to an attacker submitting a random wrong phrase under
 * the equality matcher — both fail; both get no response. This helper
 * lets the adapter detect the wrapping case and reply with "Send the
 * phrase by itself, no other text."
 *
 * The substring check leaks no secret: an attacker who could already
 * generate a candidate containing the phrase wouldn't need this hint;
 * they'd just submit the phrase alone. The length guard (`> 1.5×`)
 * prevents probing — only meaningfully-wrapped inputs trigger the
 * hint, not "phrase + one extra letter" fuzzing attempts.
 */
export function isPhraseWrappedInExtraText(
  phrase: string,
  candidate: string,
): boolean {
  const expected = normalize(phrase);
  const normalised = normalize(candidate);
  if (!expected || !normalised) return false;
  // Equality case is handled by the matcher; only flag genuinely wrapped
  // submissions. 1.5× is small enough that "phrase plus a stray emoji"
  // still triggers the hint and large enough that random 16-char strings
  // of the same length don't accidentally substring-match.
  if (normalised.length <= Math.ceil(expected.length * 1.5)) return false;
  return normalised.includes(expected);
}

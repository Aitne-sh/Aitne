/**
 * Adapter-side text helpers shared by Slack/Telegram/Discord/WhatsApp.
 *
 * Each platform caps outbound message length differently (Discord 2000,
 * Telegram 4096, WhatsApp ~4000) and several need to mint inbound
 * filenames from a MIME type when the platform omits a `file_name` field.
 * Consolidated here so a future fix lands in exactly one place.
 */

/**
 * Split `text` into chunks no longer than `maxLen` characters, preferring
 * to break at the last `\n` within the window. The newline delimiter is
 * consumed so the next chunk doesn't start with a stray `\n`. When no
 * newline exists in the window, splits at the hard `maxLen` boundary.
 *
 * UTF-16 surrogate safety: if the boundary would land between a high
 * surrogate (0xD800-0xDBFF) and its trailing low surrogate, we back off by
 * one code unit so the pair stays intact. Without this, emoji / non-BMP
 * code points adjacent to the boundary become lone surrogates, which
 * Slack/Telegram/Discord render as U+FFFD or reject outright. Emoji-heavy
 * agent replies (common in JP/zh interfaces) are the typical trigger.
 *
 * Code-fence safety: if the chosen split point lands inside an open
 * ```fenced code block``` we back off to a newline OUTSIDE the
 * fence so the first chunk is self-contained and the second chunk
 * doesn't start mid-language. Without this, Slack/Discord renders the
 * second chunk's text as a single broken syntax-highlight block until
 * the next fence marker. We only honour fence lines (a line starting
 * with three or more backticks); inline single-backtick spans render
 * fine across chunks and are intentionally ignored.
 */
export function splitOutboundText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    // Fence-aware backoff: if splitAt lands inside an open fenced code
    // block, walk back to the newline just before the unmatched opener
    // (the most recent fence line in the candidate chunk). If we can't
    // find one, fall through to the surrogate/maxLen path — at that point
    // either the entire chunk is inside a single huge code block (no safe
    // boundary exists) or fences are malformed (no point trying harder).
    if (isInsideOpenFence(remaining, splitAt)) {
      const safe = lastNewlineBeforeUnclosedFence(remaining, splitAt);
      if (safe > 0) splitAt = safe;
    }

    // Surrogate-pair backoff: only triggers when splitAt lands directly
    // after a high surrogate. Pure-ASCII inputs (the overwhelming common
    // case) hit the cheap charCodeAt range check and skip the branch.
    // We require `splitAt > 1` so the backoff still leaves at least one
    // code unit of forward progress — protects against an unrealistic
    // maxLen=1 with a surrogate-leading input infinite-looping on empty
    // chunks. Adapter limits are all ≥ 2000 so the guard never fires
    // in practice; it's just defensive.
    let backedOffFromSurrogate = false;
    if (
      splitAt > 1
      && isHighSurrogate(remaining.charCodeAt(splitAt - 1))
    ) {
      splitAt -= 1;
      backedOffFromSurrogate = true;
    }
    chunks.push(remaining.slice(0, splitAt));
    // Consume the delimiter only when splitAt landed on a real in-window
    // newline (not the maxLen boundary, not a surrogate backoff). The
    // backoff case must NOT consume because the byte at splitAt is the
    // high surrogate we just deferred — eating it would orphan its low
    // surrogate partner in the next chunk.
    const consumeDelimiter = !backedOffFromSurrogate && splitAt !== maxLen;
    remaining = remaining.slice(consumeDelimiter ? splitAt + 1 : splitAt);
  }
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Returns true iff the position `end` lies inside an unmatched fenced
 * code block opened earlier in `text`. Counts fence lines (a line
 * whose first non-whitespace token is ``` or longer) up to `end`; odd
 * count → currently open. Inline single-backtick spans don't qualify.
 */
function isInsideOpenFence(text: string, end: number): boolean {
  let count = 0;
  let i = 0;
  while (i < end) {
    if (isFenceLineStart(text, i)) {
      count += 1;
      const nl = text.indexOf("\n", i);
      if (nl === -1 || nl >= end) break;
      i = nl + 1;
    } else {
      const nl = text.indexOf("\n", i);
      if (nl === -1 || nl >= end) break;
      i = nl + 1;
    }
  }
  return count % 2 === 1;
}

/**
 * Walk back from `end` to find the newline just BEFORE the most recent
 * fence-line opener encountered in the chunk. That newline closes off a
 * complete pre-fence segment as the first chunk; the next iteration
 * picks up at the fence opener and starts the code block fresh in the
 * second chunk. Returns -1 when no such newline exists (caller falls
 * back to splitting inside the fence).
 */
function lastNewlineBeforeUnclosedFence(text: string, end: number): number {
  let lastFenceLineStart = -1;
  let i = 0;
  while (i < end) {
    if (isFenceLineStart(text, i)) {
      lastFenceLineStart = i;
    }
    const nl = text.indexOf("\n", i);
    if (nl === -1 || nl >= end) break;
    i = nl + 1;
  }
  if (lastFenceLineStart <= 0) return -1;
  // Split at the newline immediately before the opener so the opener
  // begins the next chunk. lastFenceLineStart is the first character of
  // the fence line; the preceding char is the newline.
  return lastFenceLineStart - 1;
}

function isFenceLineStart(text: string, pos: number): boolean {
  // Skip leading horizontal whitespace per CommonMark §4.5
  // (indented up to 3 spaces still opens a fence).
  let p = pos;
  let leading = 0;
  while (leading < 3 && text.charCodeAt(p) === 0x20) {
    p += 1;
    leading += 1;
  }
  // Need at least three consecutive backticks.
  return (
    text.charCodeAt(p) === 0x60
    && text.charCodeAt(p + 1) === 0x60
    && text.charCodeAt(p + 2) === 0x60
  );
}

/**
 * Map a MIME type (e.g. `audio/mpeg`, `image/jpeg;charset=utf-8`) to a
 * filename extension. `mpeg`/`quicktime`/`3gpp` are special-cased to the
 * conventional `mp3`/`mov`/`3gp` extensions; any other subtype is
 * lowercased and stripped of non-alphanumeric characters. Falls back to
 * `fallback` when the MIME is missing or yields an empty subtype.
 */
export function extensionFromMime(
  mimeType: string | null | undefined,
  fallback: string,
): string {
  const subtype = mimeType?.split(";")[0]?.split("/")[1]?.toLowerCase();
  if (!subtype) return fallback;
  if (subtype === "mpeg") return "mp3";
  if (subtype === "quicktime") return "mov";
  if (subtype === "3gpp") return "3gp";
  return subtype.replace(/[^a-z0-9]/g, "") || fallback;
}

/** `<base>.<ext>` where `<ext>` is derived via {@link extensionFromMime}. */
export function filenameForMime(
  base: string,
  mimeType: string | null | undefined,
  fallbackExt: string,
): string {
  return `${base}.${extensionFromMime(mimeType, fallbackExt)}`;
}

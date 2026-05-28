/**
 * Pure helpers for the `screenshot` tool —
 * BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.7.
 *
 * Two concerns:
 *
 *   1. Output envelope — PNG bytes must land at ≤ 1 MB after a
 *      JPEG re-encode fallback. The pure layer decides whether the
 *      original PNG fits (`shouldKeepPng`) and, if not, what the
 *      fallback JPEG quality should be.
 *   2. §14.7 hostname denylist check — when a screenshot was captured
 *      against a host that lives in `HOSTNAME_DENYLIST`, the runner
 *      MUST drop the file synchronously and emit a `pa_alert` because
 *      the CDP layer should already have blocked the navigation.
 *      `decideHostnameRetention` is the pure decision the runner reads
 *      before persisting the bytes.
 *
 * Pure — no FS, no DB, no clock, no Playwright. The I/O wrapper in
 * the tool body composes these helpers with the real screenshot
 * call.
 *
 * 100% coverage gate per §14.12 ("Screenshot auto-deletion").
 */

import { matchesHostnameDenylist } from "../egress-denylist.js";

/** §5 — PNG cap. ≤ 1 MB returned to the agent (multimodal cost
 *  bound). Larger captures fall back to JPEG via `chooseFallbackQuality`. */
export const SCREENSHOT_PNG_CAP_BYTES = 1 * 1024 * 1024;

/** Smallest JPEG quality we'll try. Below this the output is too
 *  lossy to use for confirm screenshots; the runner returns a
 *  truncated image with a clear `truncated:true` flag. */
export const SCREENSHOT_JPEG_MIN_QUALITY = 40;

/** Default JPEG quality if the PNG was over budget. */
export const SCREENSHOT_JPEG_DEFAULT_QUALITY = 75;

export type ScreenshotSizeDecision =
  | { kind: "keep_png" }
  | { kind: "fallback_jpeg"; quality: number }
  | { kind: "truncate"; reason: "still_too_large" };

/**
 * Decide what to do with a fresh capture's byte buffer. The runner
 * always tries PNG first; this helper picks the next step when the
 * PNG is over the 1 MB cap.
 *
 * `pngBytes` is the size of the original PNG in bytes. The function
 * does NOT touch the buffer itself — it returns the decision and
 * the runner does the actual re-encode.
 */
export function decideScreenshotSize(pngBytes: number): ScreenshotSizeDecision {
  if (!Number.isFinite(pngBytes) || pngBytes < 0) {
    return { kind: "truncate", reason: "still_too_large" };
  }
  if (pngBytes <= SCREENSHOT_PNG_CAP_BYTES) {
    return { kind: "keep_png" };
  }
  // Sliding quality — for very large screenshots a lower default
  // pays off; pages under 4 MB usually fit at quality 75, larger
  // pages drop to 60.
  const quality =
    pngBytes > 4 * 1024 * 1024 ? 60 : SCREENSHOT_JPEG_DEFAULT_QUALITY;
  return { kind: "fallback_jpeg", quality };
}

/** Second-pass decision: given JPEG-encoded bytes from the fallback,
 *  decide whether to ship them or step the quality down once more. */
export function decideJpegRetry(
  jpegBytes: number,
  previousQuality: number,
): ScreenshotSizeDecision {
  if (!Number.isFinite(jpegBytes) || jpegBytes < 0) {
    return { kind: "truncate", reason: "still_too_large" };
  }
  if (jpegBytes <= SCREENSHOT_PNG_CAP_BYTES) {
    return { kind: "fallback_jpeg", quality: previousQuality };
  }
  const next = previousQuality - 15;
  if (next < SCREENSHOT_JPEG_MIN_QUALITY) {
    return { kind: "truncate", reason: "still_too_large" };
  }
  return { kind: "fallback_jpeg", quality: next };
}

export type HostnameRetentionDecision =
  | { kind: "retain" }
  | { kind: "drop_and_alert"; deniedHostname: string };

/**
 * §14.7 — auto-delete screenshots whose hostname is on the *user-managed*
 * hostname denylist (the same `runtime-settings.browserTaskHostnameDenylist`
 * the CDP layer consults). A match here means the CDP layer should
 * already have blocked the navigation — the screenshot reaching the
 * trace store is a defence-in-depth gap; the runner deletes the file
 * synchronously, writes an
 * `agent_actions(action_type='browser_task_screenshot_dropped')` row,
 * and queues a `pa_alert`. With an empty user list (default), this
 * helper always retains.
 *
 * Tolerant of malformed URLs — non-string / unparseable values
 * retain (the upstream layers are responsible for shape validation;
 * this helper's job is the hostname check).
 */
export function decideHostnameRetention(
  pageUrl: string,
  hostnameDenylist?: ReadonlyArray<RegExp>,
): HostnameRetentionDecision {
  if (typeof pageUrl !== "string" || pageUrl.length === 0) {
    return { kind: "retain" };
  }
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return { kind: "retain" };
  }
  if (matchesHostnameDenylist(parsed.hostname, hostnameDenylist)) {
    return { kind: "drop_and_alert", deniedHostname: parsed.hostname };
  }
  return { kind: "retain" };
}

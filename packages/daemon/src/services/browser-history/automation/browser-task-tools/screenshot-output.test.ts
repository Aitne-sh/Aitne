/**
 * screenshot-output — §5 / §14.7 / §14.12 coverage.
 */

import { describe, expect, it } from "vitest";

import {
  decideHostnameRetention,
  decideJpegRetry,
  decideScreenshotSize,
  SCREENSHOT_JPEG_DEFAULT_QUALITY,
  SCREENSHOT_PNG_CAP_BYTES,
} from "./screenshot-output.js";

describe("decideScreenshotSize", () => {
  it("keeps PNGs at or under the cap", () => {
    expect(decideScreenshotSize(100).kind).toBe("keep_png");
    expect(decideScreenshotSize(SCREENSHOT_PNG_CAP_BYTES).kind).toBe("keep_png");
  });

  it("falls back to JPEG at the default quality for PNGs just over the cap", () => {
    const out = decideScreenshotSize(SCREENSHOT_PNG_CAP_BYTES + 1);
    expect(out.kind).toBe("fallback_jpeg");
    if (out.kind === "fallback_jpeg") {
      expect(out.quality).toBe(SCREENSHOT_JPEG_DEFAULT_QUALITY);
    }
  });

  it("drops to quality 60 for very large PNGs (> 4 MB)", () => {
    const out = decideScreenshotSize(5 * 1024 * 1024);
    if (out.kind === "fallback_jpeg") expect(out.quality).toBe(60);
  });

  it("treats NaN / negative defensively as truncate", () => {
    expect(decideScreenshotSize(NaN).kind).toBe("truncate");
    expect(decideScreenshotSize(-1).kind).toBe("truncate");
  });
});

describe("decideJpegRetry", () => {
  it("returns fallback at the same quality when JPEG already fits", () => {
    const out = decideJpegRetry(500_000, 75);
    expect(out.kind).toBe("fallback_jpeg");
    if (out.kind === "fallback_jpeg") expect(out.quality).toBe(75);
  });

  it("drops quality by 15 when still too large", () => {
    const out = decideJpegRetry(SCREENSHOT_PNG_CAP_BYTES + 1, 75);
    if (out.kind === "fallback_jpeg") expect(out.quality).toBe(60);
  });

  it("truncates when quality would go below the min", () => {
    // From quality 40, next step is 25 < min 40 → truncate.
    const out = decideJpegRetry(SCREENSHOT_PNG_CAP_BYTES + 1, 40);
    expect(out.kind).toBe("truncate");
  });

  it("handles bogus byte counts defensively", () => {
    expect(decideJpegRetry(NaN, 75).kind).toBe("truncate");
    expect(decideJpegRetry(-1, 75).kind).toBe("truncate");
  });
});

describe("decideHostnameRetention", () => {
  it("retains by default when no user-managed denylist is supplied", () => {
    // The framework no longer hardcodes brand entries; with an empty
    // user list, every screenshot retains.
    expect(decideHostnameRetention("https://www.example.com/page").kind).toBe("retain");
    expect(decideHostnameRetention("https://payments.stripe.com/checkout").kind).toBe("retain");
    expect(decideHostnameRetention("https://www.chase.com/personal/banking").kind).toBe("retain");
  });

  it("drops + alerts when the user-managed list explicitly covers the host", async () => {
    const { compileUserHostnameDenylist } = await import("../egress-denylist.js");
    const list = compileUserHostnameDenylist(["stripe.com", "chase.com"]);
    const r1 = decideHostnameRetention("https://payments.stripe.com/checkout", list);
    expect(r1.kind).toBe("drop_and_alert");
    if (r1.kind === "drop_and_alert") {
      expect(r1.deniedHostname).toBe("payments.stripe.com");
    }
    const r2 = decideHostnameRetention("https://www.chase.com/personal/banking", list);
    expect(r2.kind).toBe("drop_and_alert");
  });

  it("retains hosts outside the supplied list", async () => {
    const { compileUserHostnameDenylist } = await import("../egress-denylist.js");
    const list = compileUserHostnameDenylist(["chase.com"]);
    expect(decideHostnameRetention("https://www.example.com/page", list).kind).toBe("retain");
  });

  it("retains malformed URLs (upstream layers validate shape)", () => {
    expect(decideHostnameRetention("not a url").kind).toBe("retain");
    expect(decideHostnameRetention("").kind).toBe("retain");
  });

  it("retains non-string inputs defensively", () => {
    expect(
      decideHostnameRetention(null as unknown as string).kind,
    ).toBe("retain");
  });
});

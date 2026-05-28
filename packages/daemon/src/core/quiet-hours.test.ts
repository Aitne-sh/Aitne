import { describe, it, expect } from "vitest";

import { isInQuietHoursAt, nextQuietHoursEndMs } from "./quiet-hours.js";

const TZ = "UTC";

/** Build a UTC Date at the given `HH:MM` so the timezone-resolved hour
 *  matches the literal in the test. Avoids the host machine's local
 *  timezone leaking into expectations. */
function utcAt(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map((v) => Number.parseInt(v, 10));
  // Anchor on 2026-05-26 because the plan's clock is well-defined and
  // any future code-generation step would burn-fix this in place.
  return new Date(Date.UTC(2026, 4, 26, h, m, 0, 0));
}

describe("isInQuietHoursAt", () => {
  it("same-day window — inside is true, edges are half-open", () => {
    const win = { start: "09:00", end: "17:00", timezone: TZ };
    expect(isInQuietHoursAt(utcAt("09:00"), win)).toBe(true); // start inclusive
    expect(isInQuietHoursAt(utcAt("16:59"), win)).toBe(true);
    expect(isInQuietHoursAt(utcAt("17:00"), win)).toBe(false); // end exclusive
    expect(isInQuietHoursAt(utcAt("08:59"), win)).toBe(false);
    expect(isInQuietHoursAt(utcAt("00:00"), win)).toBe(false);
  });

  it("overnight window — wraps past midnight", () => {
    const win = { start: "22:00", end: "08:00", timezone: TZ };
    expect(isInQuietHoursAt(utcAt("22:00"), win)).toBe(true);
    expect(isInQuietHoursAt(utcAt("23:59"), win)).toBe(true);
    expect(isInQuietHoursAt(utcAt("00:00"), win)).toBe(true);
    expect(isInQuietHoursAt(utcAt("07:59"), win)).toBe(true);
    expect(isInQuietHoursAt(utcAt("08:00"), win)).toBe(false);
    expect(isInQuietHoursAt(utcAt("12:00"), win)).toBe(false);
    expect(isInQuietHoursAt(utcAt("21:59"), win)).toBe(false);
  });

  it("start === end disables quiet hours regardless of probe time", () => {
    // Notification-manager tests already exercise this shape with
    // `00:00/00:00`. Pinning here so a future overzealous tightening
    // (e.g. "treat equal start/end as 24h quiet") can't ship silently.
    const win = { start: "00:00", end: "00:00", timezone: TZ };
    expect(isInQuietHoursAt(utcAt("00:00"), win)).toBe(false);
    expect(isInQuietHoursAt(utcAt("06:00"), win)).toBe(false);
    expect(isInQuietHoursAt(utcAt("23:59"), win)).toBe(false);
  });

  it("malformed HH:MM strings degrade to 0 (quiet hours effectively disabled)", () => {
    const win = { start: "abc:def", end: "xx:yy", timezone: TZ };
    // start=0, end=0 -> disabled.
    expect(isInQuietHoursAt(utcAt("00:00"), win)).toBe(false);
    expect(isInQuietHoursAt(utcAt("12:00"), win)).toBe(false);
  });

  it("HH valid but MM malformed degrades to 0 (mixed-parse fallback)", () => {
    // `"22:nope"` parses as h=22, m=NaN — exercises the
    // `!Number.isFinite(m)` second-operand path that the
    // `"abc:def"` test short-circuits past.
    const win = { start: "22:nope", end: "08:nope", timezone: TZ };
    expect(isInQuietHoursAt(utcAt("12:00"), win)).toBe(false);
  });

  it("HH-only strings (no colon) degrade gracefully via the ?? '0' fallback", () => {
    // `split(":")` on "22" returns `["22"]` — `mStr` is undefined and
    // hits the `?? "0"` fallback so the predicate treats it as the
    // top of the hour rather than crashing.
    const win = { start: "22", end: "08", timezone: TZ };
    expect(isInQuietHoursAt(utcAt("23:00"), win)).toBe(true);
    expect(isInQuietHoursAt(utcAt("12:00"), win)).toBe(false);
  });

  it("undefined timezone falls back to the host's resolved timezone", () => {
    // The `|| undefined` ladder is the load-bearing fallback. We
    // probe both same-day branches with the resolved (host) timezone
    // — the test only asserts the call doesn't throw, since the host
    // tz is environment-dependent.
    const win = { start: "00:00", end: "00:00" }; // timezone omitted
    expect(isInQuietHoursAt(new Date(), win)).toBe(false);
  });
});

describe("nextQuietHoursEndMs", () => {
  it("returns null when probe is outside quiet hours", () => {
    const win = { start: "22:00", end: "08:00", timezone: TZ };
    expect(nextQuietHoursEndMs(utcAt("12:00"), win)).toBeNull();
  });

  it("same-day window — returns the exact end boundary", () => {
    const win = { start: "09:00", end: "17:00", timezone: TZ };
    const result = nextQuietHoursEndMs(utcAt("12:00"), win);
    expect(result).not.toBeNull();
    expect(result).toBe(utcAt("17:00").getTime());
  });

  it("overnight window from late evening — returns next-morning end", () => {
    const win = { start: "22:00", end: "08:00", timezone: TZ };
    const probe = utcAt("23:00");
    const result = nextQuietHoursEndMs(probe, win);
    expect(result).not.toBeNull();
    // Next 08:00 is +9h from probe.
    const expected = probe.getTime() + 9 * 60 * 60 * 1000;
    expect(result).toBe(expected);
  });

  it("overnight window from early-morning side — returns same-day end", () => {
    const win = { start: "22:00", end: "08:00", timezone: TZ };
    const probe = utcAt("03:00");
    const result = nextQuietHoursEndMs(probe, win);
    expect(result).not.toBeNull();
    // Next 08:00 is +5h from probe.
    const expected = probe.getTime() + 5 * 60 * 60 * 1000;
    expect(result).toBe(expected);
  });
});

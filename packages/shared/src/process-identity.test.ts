import { describe, it, expect } from "vitest";
// The launcher mirror (plain ESM, cannot import @aitne/shared — it runs before
// the TypeScript build). It has no TS twin; this test lives here only so the
// vitest `include: packages/*/src/**/*.test.ts` glob runs it. See
// process-lifecycle-2 in CROSS_PLATFORM_REAUDIT_2026-06.md and the identical
// ports.mjs precedent (ports.test.ts).
// Typed via the sibling scripts/lib/process-identity.d.mts (the ports.d.mts
// precedent), so this peer test typechecks the plain-ESM launcher module under
// strict. It is the drift guard: if the .mjs and its .d.mts diverge, this fails.
import {
  serializePidMeta,
  parsePidMeta,
  parseLinuxStat,
  readProcessStartToken,
  classifyPid,
} from "../../../scripts/lib/process-identity.mjs";

describe("serializePidMeta / parsePidMeta", () => {
  it("round-trips pid + token", () => {
    const meta = parsePidMeta(serializePidMeta({ pid: 4321, startToken: "tok-A" }));
    expect(meta).toEqual({ pid: 4321, startToken: "tok-A" });
  });

  it("keeps line 1 a bare PID so an older aitne (line-1 parse) still reads it", () => {
    const out = serializePidMeta({ pid: 4321, startToken: "tok-A" });
    expect(out.split("\n")[0]).toBe("4321");
    expect(Number.parseInt(out.trim().split("\n")[0], 10)).toBe(4321);
  });

  it("omits an absent or empty token", () => {
    expect(serializePidMeta({ pid: 7 })).toBe("7\n");
    expect(serializePidMeta({ pid: 7, startToken: "" })).toBe("7\n");
    expect(serializePidMeta({ pid: 7, startToken: "t" })).toBe("7\nstart=t\n");
  });

  it("sanitizes embedded newlines in the token so the trailer can't break parse order", () => {
    const meta = parsePidMeta(serializePidMeta({ pid: 1, startToken: "a\nb\r\nc" }));
    expect(meta).toEqual({ pid: 1, startToken: "a b c" });
  });

  it("parses a legacy single-line pidfile (no token)", () => {
    expect(parsePidMeta("9999\n")).toEqual({ pid: 9999, startToken: null });
    expect(parsePidMeta("9999")).toEqual({ pid: 9999, startToken: null });
  });

  it("returns null when line 1 is not a finite integer", () => {
    expect(parsePidMeta("not-a-pid\nstart=x")).toBeNull();
    expect(parsePidMeta("")).toBeNull();
    // @ts-expect-error — defensive non-string guard
    expect(parsePidMeta(null)).toBeNull();
  });

  it("ignores malformed trailer lines and unknown keys (forward-compatible)", () => {
    expect(parsePidMeta("12\nnokeyvalue\nstart=t\nport=8322\nfuture=x")).toEqual({
      pid: 12,
      startToken: "t",
    });
  });
});

describe("parseLinuxStat (field 22)", () => {
  it("extracts starttime from a normal /proc/<pid>/stat line", () => {
    // After the last ')' the tail begins at field 3; field 22 is index 19,
    // so 19 filler tokens (fields 3..21) precede the starttime.
    const tail = Array.from({ length: 19 }, (_, i) => String(i + 100)).join(" ");
    expect(parseLinuxStat(`4321 (node) ${tail} 987654 rest more`)).toBe("987654");
  });

  it("survives a comm containing spaces and a literal ')'", () => {
    const tail = Array.from({ length: 19 }, (_, i) => String(i + 100)).join(" ");
    expect(parseLinuxStat(`4321 (weird ) name) ${tail} 555 trailing`)).toBe("555");
  });

  it("returns null when field 22 is missing or non-numeric, or there is no ')'", () => {
    expect(parseLinuxStat("4321 (node) S 1 2 3")).toBeNull();
    expect(parseLinuxStat("no-paren-here")).toBeNull();
    // @ts-expect-error — defensive non-string guard
    expect(parseLinuxStat(123)).toBeNull();
  });
});

describe("classifyPid", () => {
  const alive = () => true;
  const dead = () => false;

  it("stale when the process is dead", () => {
    expect(classifyPid({ pid: 1, startToken: "t" }, { isAlive: dead, readToken: () => "t" })).toBe("stale");
  });

  it("running-unverified for a legacy file with no recorded token", () => {
    expect(classifyPid({ pid: 1, startToken: null }, { isAlive: alive, readToken: () => "t" })).toBe(
      "running-unverified",
    );
  });

  it("running-ours when the live token matches the recorded token", () => {
    expect(classifyPid({ pid: 1, startToken: "t" }, { isAlive: alive, readToken: () => "t" })).toBe(
      "running-ours",
    );
  });

  it("stale when the live token differs (recycled PID — the bug)", () => {
    expect(classifyPid({ pid: 1, startToken: "old" }, { isAlive: alive, readToken: () => "new" })).toBe(
      "stale",
    );
  });

  it("running-unverified when the OS start-time read fails (null)", () => {
    expect(classifyPid({ pid: 1, startToken: "t" }, { isAlive: alive, readToken: () => null })).toBe(
      "running-unverified",
    );
  });

  it("stale on null/empty meta", () => {
    expect(classifyPid(null, { isAlive: alive, readToken: () => "t" })).toBe("stale");
    expect(classifyPid({ pid: null }, { isAlive: alive, readToken: () => "t" })).toBe("stale");
  });
});

describe("readProcessStartToken", () => {
  it("returns null for a non-finite pid without touching the OS", () => {
    expect(readProcessStartToken(undefined)).toBeNull();
    expect(readProcessStartToken(Number.NaN)).toBeNull();
  });

  it("returns null for an unrecognized platform", () => {
    expect(readProcessStartToken(1, { platform: "sunos" })).toBeNull();
  });

  it("linux: parses field 22 from an injected /proc/<pid>/stat read", () => {
    const tail = Array.from({ length: 19 }, () => "0").join(" ");
    const readFileSync = () => `42 (node) ${tail} 778899 x`;
    expect(readProcessStartToken(42, { platform: "linux", readFileSync })).toBe("778899");
  });

  it("linux: returns null when the /proc read throws (dead pid)", () => {
    const readFileSync = () => {
      throw new Error("ENOENT");
    };
    expect(readProcessStartToken(42, { platform: "linux", readFileSync })).toBeNull();
  });

  it("darwin: trims and collapses the injected `ps -o lstart=` output", () => {
    const execFileSync = () => "Sun Jun  7 13:17:40 2026\n";
    expect(readProcessStartToken(42, { platform: "darwin", execFileSync })).toBe(
      "Sun Jun  7 13:17:40 2026",
    );
  });

  it("darwin: returns null when ps yields empty output", () => {
    expect(readProcessStartToken(42, { platform: "darwin", execFileSync: () => "  \n" })).toBeNull();
  });

  it("returns a stable, non-empty token for the current process on the host OS", () => {
    // Host-validated path (this CI/dev box is darwin or linux). A given process
    // incarnation must yield the same token on repeated reads — the property
    // identity reconciliation relies on.
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const a = readProcessStartToken(process.pid);
    const b = readProcessStartToken(process.pid);
    expect(typeof a).toBe("string");
    expect((a ?? "").length).toBeGreaterThan(0);
    expect(b).toBe(a);
  });
});

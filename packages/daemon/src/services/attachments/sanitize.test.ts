import { describe, expect, it } from "vitest";
import {
  deriveSafeFilename,
  isAllowedMime,
  normalizeMimeType,
  requiresDownloadDisposition,
} from "./sanitize.js";

describe("deriveSafeFilename", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("preserves a clean ascii filename", () => {
    expect(deriveSafeFilename("report.pdf", id)).toBe("report.pdf");
  });

  it("collapses path separators to underscores", () => {
    expect(deriveSafeFilename("/etc/passwd", id)).toBe("_etc_passwd");
    expect(deriveSafeFilename("sub\\path\\file.png", id)).toBe("sub_path_file.png");
  });

  it("strips `..` traversal segments (no raw dots remain)", () => {
    const out = deriveSafeFilename("../../secret.txt", id);
    expect(out.includes("..")).toBe(false);
    expect(out.endsWith("secret.txt")).toBe(true);
  });

  it("replaces control + non-allowed chars with underscore", () => {
    expect(deriveSafeFilename("hello\x00world.md", id)).toBe("helloworld.md");
    expect(deriveSafeFilename("na\u00efve.txt", id)).toBe("na_ve.txt");
  });

  it("falls back to `attachment-<id>.bin` when empty after sanitization", () => {
    expect(deriveSafeFilename("", id)).toBe(`attachment-${id}.bin`);
  });

  it("falls back to `.bin` when sanitization collapses to a single `_`", () => {
    // "/" → slash-replacement → "_" — safeBody matches the explicit
    // `_` fallback branch, distinct from the empty-string fallback.
    expect(deriveSafeFilename("/", id)).toBe(`attachment-${id}.bin`);
  });

  it("falls back to `.bin` when sanitization collapses to a single `.`", () => {
    // Single dot survives the dot-collapsing rules (leading-dot regex
    // requires a trailing char), triggering the `safeBody === "."` branch.
    expect(deriveSafeFilename(".", id)).toBe(`attachment-${id}.bin`);
  });

  it("tolerates null / undefined originals (defensive nullish branch)", () => {
    // Callers pass strings, but busboy can hand us `undefined` for
    // filename — the `?? ""` coalescing keeps the pipeline safe.
    expect(deriveSafeFilename(null as unknown as string, id)).toBe(`attachment-${id}.bin`);
    expect(deriveSafeFilename(undefined as unknown as string, id)).toBe(`attachment-${id}.bin`);
  });

  it("sanitizes all-punctuation names to a safe body (no traversal risk)", () => {
    // `!!!.pdf` is fully non-allowlisted; the exact replacement char
    // doesn't matter as long as the result is a plain filename.
    const out = deriveSafeFilename("!!!.pdf", id);
    expect(out).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("truncates to 255 bytes from the tail (keeps extension)", () => {
    const longName = "a".repeat(300) + ".txt";
    const safe = deriveSafeFilename(longName, id);
    expect(safe.length).toBeLessThanOrEqual(255);
    expect(safe.endsWith(".txt")).toBe(true);
  });
});

describe("isAllowedMime", () => {
  it("accepts common image MIMEs", () => {
    expect(isAllowedMime("image/png")).toBe(true);
    expect(isAllowedMime("image/jpeg")).toBe(true);
    expect(isAllowedMime("image/svg+xml")).toBe(true);
  });

  it("accepts PDF, Office, and text MIMEs", () => {
    expect(isAllowedMime("application/pdf")).toBe(true);
    expect(isAllowedMime("text/plain")).toBe(true);
    expect(isAllowedMime("application/json")).toBe(true);
  });

  it("accepts common audio/video MIMEs", () => {
    expect(isAllowedMime("audio/mpeg")).toBe(true);
    expect(isAllowedMime("audio/ogg")).toBe(true);
    expect(isAllowedMime("audio/webm")).toBe(true);
    expect(isAllowedMime("video/mp4")).toBe(true);
    expect(isAllowedMime("video/quicktime")).toBe(true);
    expect(isAllowedMime("application/ogg")).toBe(true);
  });

  it("rejects executables and archives", () => {
    expect(isAllowedMime("application/x-msdownload")).toBe(false);
    expect(isAllowedMime("application/zip")).toBe(false);
    expect(isAllowedMime("application/x-tar")).toBe(false);
  });

  it("is case-insensitive on the MIME tag", () => {
    expect(isAllowedMime("Image/PNG")).toBe(true);
  });

  it("accepts allowed MIME tags with parameters", () => {
    expect(isAllowedMime("audio/ogg; codecs=opus")).toBe(true);
    expect(isAllowedMime("text/plain; charset=utf-8")).toBe(true);
    expect(isAllowedMime("application/zip; charset=binary")).toBe(false);
  });
});

describe("normalizeMimeType", () => {
  it("lowercases and strips MIME parameters", () => {
    expect(normalizeMimeType("Audio/OGG; codecs=opus")).toBe("audio/ogg");
    expect(normalizeMimeType(" text/plain ; charset=utf-8")).toBe("text/plain");
    expect(normalizeMimeType(null)).toBeNull();
  });
});

describe("requiresDownloadDisposition", () => {
  it("allows inline display for images and PDFs", () => {
    expect(requiresDownloadDisposition("image/png")).toBe(false);
    expect(requiresDownloadDisposition("image/jpeg")).toBe(false);
    expect(requiresDownloadDisposition("application/pdf")).toBe(false);
    expect(requiresDownloadDisposition("application/pdf; version=1.7")).toBe(false);
  });

  it("forces download for SVG even though it is image/*", () => {
    expect(requiresDownloadDisposition("image/svg+xml")).toBe(true);
  });

  it("forces download for everything else (DOCX, CSV, ...)", () => {
    expect(
      requiresDownloadDisposition(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
    expect(requiresDownloadDisposition("text/csv")).toBe(true);
  });

  it("forces download when the MIME header is empty / unparseable", () => {
    // normalizeMimeType returns null for an empty/whitespace string,
    // exercising the `?? ""` fallback. An unknown MIME must default to
    // the safer download disposition.
    expect(requiresDownloadDisposition("")).toBe(true);
    expect(requiresDownloadDisposition("   ")).toBe(true);
  });
});

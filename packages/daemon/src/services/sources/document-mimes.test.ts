import { describe, expect, it } from "vitest";
import { AUTO_CAPTURE_MIME_TYPES, isAutoCaptureMime } from "./document-mimes.js";
import { isAllowedMime } from "../attachments/sanitize.js";

describe("document-mimes", () => {
  it("accepts every listed document MIME", () => {
    for (const mime of AUTO_CAPTURE_MIME_TYPES) {
      expect(isAutoCaptureMime(mime)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isAutoCaptureMime("Application/PDF")).toBe(true);
  });

  it("rejects images, media, and text formats", () => {
    for (const mime of [
      "image/png",
      "image/jpeg",
      "audio/ogg",
      "video/mp4",
      "text/plain",
      "text/csv",
      "text/markdown",
      "application/json",
      "application/octet-stream",
      "",
    ]) {
      expect(isAutoCaptureMime(mime)).toBe(false);
    }
  });

  it("every auto-capture MIME is on the sanitize allowlist (capture runs after MIME verification)", () => {
    for (const mime of AUTO_CAPTURE_MIME_TYPES) {
      expect(isAllowedMime(mime)).toBe(true);
    }
  });
});

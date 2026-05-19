import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { APP_NAME } from "@aitne/shared";
import { probeApiKeyServerSide } from "./api-key-probe.js";

const EXPECTED_USER_AGENT = `${APP_NAME.toLowerCase().replace(/\s+/g, "-")}-daemon/1.0`;

// ---------------------------------------------------------------------------
// Mock fetch at the global level
// ---------------------------------------------------------------------------

const mockFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper to create a mock Response
// ---------------------------------------------------------------------------

function mockResponse(status: number, body = "{}"): Response {
  return new Response(body, {
    status,
    statusText: status === 200 ? "OK" : `HTTP ${status}`,
  });
}

// ---------------------------------------------------------------------------
// probeApiKeyServerSide
// ---------------------------------------------------------------------------

describe("probeApiKeyServerSide", () => {
  // ── Anthropic ───────────────────────────────────────────────────

  describe("anthropic", () => {
    it("returns ok on 200", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, '{"data":[]}'));
      const result = await probeApiKeyServerSide("anthropic", "sk-ant-api03-test");

      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(/^Server-verified at \d{2}:\d{2} UTC$/);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/models");
      expect((init as RequestInit).headers).toMatchObject({
        "x-api-key": "sk-ant-api03-test",
        "anthropic-version": "2023-06-01",
        "User-Agent": EXPECTED_USER_AGENT,
      });
    });

    it("returns not-ok on 401", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(401));
      const result = await probeApiKeyServerSide("anthropic", "sk-ant-api03-bad");

      expect(result.ok).toBe(false);
      expect(result.detail).toContain("API key rejected by Anthropic");
      expect(result.detail).toContain("401");
    });

    it("returns not-ok on 403", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(403));
      const result = await probeApiKeyServerSide("anthropic", "sk-ant-api03-bad");

      expect(result.ok).toBe(false);
      expect(result.detail).toContain("403");
    });

    it("throws on unexpected HTTP status (e.g. 429 rate-limit)", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(429));
      await expect(
        probeApiKeyServerSide("anthropic", "sk-ant-api03-test"),
      ).rejects.toThrow("Anthropic probe returned unexpected HTTP 429");
    });

    it("throws on network error", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(
        probeApiKeyServerSide("anthropic", "sk-ant-api03-test"),
      ).rejects.toThrow("fetch failed");
    });
  });

  // ── OpenAI ──────────────────────────────────────────────────────

  describe("openai", () => {
    it("returns ok on 200", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, '{"data":[]}'));
      const result = await probeApiKeyServerSide("openai", "sk-proj-test123");

      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(/^Server-verified at \d{2}:\d{2} UTC$/);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/models");
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer sk-proj-test123",
        "User-Agent": EXPECTED_USER_AGENT,
      });
    });

    it("returns not-ok on 401", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(401));
      const result = await probeApiKeyServerSide("openai", "sk-proj-bad");

      expect(result.ok).toBe(false);
      expect(result.detail).toContain("OpenAI");
      expect(result.detail).toContain("401");
    });

    it("throws on 500 server error", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(500));
      await expect(
        probeApiKeyServerSide("openai", "sk-proj-test"),
      ).rejects.toThrow("unexpected HTTP 500");
    });
  });

  // ── Google ──────────────────────────────────────────────────────

  describe("google", () => {
    const GOOGLE_KEY = "AIzaSyTestKey12345678901234567890123";

    it("returns ok on 200", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, '{"models":[]}'));
      const result = await probeApiKeyServerSide("google", GOOGLE_KEY);

      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(/^Server-verified at \d{2}:\d{2} UTC$/);

      const [url, init] = mockFetch.mock.calls[0];
      // Google puts the key in the query string
      expect(url).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${GOOGLE_KEY}`,
      );
      expect((init as RequestInit).headers).toMatchObject({
        "User-Agent": EXPECTED_USER_AGENT,
      });
      // Key should NOT be in headers (only in query string)
      expect((init as RequestInit).headers).not.toHaveProperty("x-api-key");
      expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
    });

    it("returns not-ok on 403 (invalid key)", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(403));
      const result = await probeApiKeyServerSide("google", GOOGLE_KEY);

      expect(result.ok).toBe(false);
      expect(result.detail).toContain("Google AI");
      expect(result.detail).toContain("403");
    });

    it("throws on timeout", async () => {
      mockFetch.mockRejectedValueOnce(
        new DOMException("The operation was aborted", "AbortError"),
      );
      await expect(
        probeApiKeyServerSide("google", GOOGLE_KEY),
      ).rejects.toThrow("aborted");
    });
  });

  // ── Cross-cutting ───────────────────────────────────────────────

  describe("cross-cutting", () => {
    it("uses AbortSignal.timeout for 5 second timeout", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200));
      await probeApiKeyServerSide("anthropic", "sk-ant-api03-test");

      const [, init] = mockFetch.mock.calls[0];
      // AbortSignal.timeout returns an AbortSignal — we can't inspect
      // the exact timeout but we CAN verify a signal was provided.
      expect((init as RequestInit).signal).toBeDefined();
    });

    it("API key does NOT leak into returned detail on success", async () => {
      const secretKey = "sk-ant-api03-SECRETVALUE123456789012345678901234567";
      mockFetch.mockResolvedValueOnce(mockResponse(200));
      const result = await probeApiKeyServerSide("anthropic", secretKey);

      expect(result.detail).not.toContain(secretKey);
      expect(result.detail).not.toContain("SECRETVALUE");
    });

    it("API key does NOT leak into returned detail on failure", async () => {
      const secretKey = "sk-ant-api03-SECRETVALUE123456789012345678901234567";
      mockFetch.mockResolvedValueOnce(mockResponse(401));
      const result = await probeApiKeyServerSide("anthropic", secretKey);

      expect(result.detail).not.toContain(secretKey);
      expect(result.detail).not.toContain("SECRETVALUE");
    });

    it("API key does NOT leak into thrown error message", async () => {
      const secretKey = "sk-ant-api03-SECRETVALUE123456789012345678901234567";
      mockFetch.mockResolvedValueOnce(mockResponse(429));

      try {
        await probeApiKeyServerSide("anthropic", secretKey);
      } catch (err) {
        expect((err as Error).message).not.toContain(secretKey);
        expect((err as Error).message).not.toContain("SECRETVALUE");
      }
    });

    it("Google API key does NOT leak in thrown error's serialized form (query string in cause)", async () => {
      const googleKey = "AIzaSySecretKeyValue678901234567890123";
      // Simulate a network error where Node fetch includes URL in cause
      const originalError = new TypeError("fetch failed");
      (originalError as any).cause = new Error(
        `connect to https://generativelanguage.googleapis.com/v1beta/models?key=${googleKey} failed`,
      );
      mockFetch.mockRejectedValueOnce(originalError);

      try {
        await probeApiKeyServerSide("google", googleKey);
        expect.unreachable("should have thrown");
      } catch (err) {
        const serialized = JSON.stringify(err);
        expect(serialized).not.toContain(googleKey);
        expect((err as Error).message).not.toContain(googleKey);
        expect((err as any).cause).toBeUndefined();
      }
    });

    it("Google API key does NOT leak when err.message itself contains the URL (V1)", async () => {
      const googleKey = "AIzaSySecretKeyValue678901234567890123";
      // Some fetch implementations embed the full URL in the message
      const originalError = new TypeError(
        `Failed to fetch https://generativelanguage.googleapis.com/v1beta/models?key=${googleKey}`,
      );
      mockFetch.mockRejectedValueOnce(originalError);

      try {
        await probeApiKeyServerSide("google", googleKey);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain(googleKey);
        expect((err as Error).message).toContain("[REDACTED]");
      }
    });

    it("Anthropic API key does NOT leak when err.message contains the key (V1 header variant)", async () => {
      const anthropicKey = "sk-ant-api03-SUPERSECRETVALUE1234567890123456789";
      // Hypothetical fetch implementation that includes headers in error
      const originalError = new TypeError(
        `Request to https://api.anthropic.com/v1/models failed with x-api-key: ${anthropicKey}`,
      );
      mockFetch.mockRejectedValueOnce(originalError);

      try {
        await probeApiKeyServerSide("anthropic", anthropicKey);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain(anthropicKey);
        expect((err as Error).message).toContain("[REDACTED]");
      }
    });

    it("uses 'unknown network error' when thrown value is not an Error instance", async () => {
      mockFetch.mockRejectedValueOnce("string error");

      await expect(
        probeApiKeyServerSide("anthropic", "sk-ant-api03-test"),
      ).rejects.toThrow("Anthropic probe failed: unknown network error");
    });
  });
});

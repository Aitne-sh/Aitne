import { describe, it, expect } from "vitest";
import { classifyVisit } from "./classifier.js";

function input(scheme: string, host: string, path: string) {
  return { scheme, host, path };
}

describe("classifyVisit", () => {
  it("classifies chrome:// scheme as app-config", () => {
    expect(classifyVisit(input("chrome:", "settings", "/passwords"))).toBe(
      "app-config",
    );
  });

  it("classifies about: scheme as app-config", () => {
    expect(classifyVisit(input("about:", "preferences", "/"))).toBe(
      "app-config",
    );
  });

  it("classifies file:// as localhost", () => {
    expect(classifyVisit(input("file:", "", "/Users/example/notes.md"))).toBe(
      "localhost",
    );
  });

  it("classifies 127.0.0.1 as localhost", () => {
    expect(classifyVisit(input("https:", "127.0.0.1", "/api"))).toBe(
      "localhost",
    );
  });

  it("classifies banking domains via sensitive-hosts", () => {
    expect(classifyVisit(input("https:", "chase.com", "/accounts"))).toBe(
      "banking",
    );
  });

  it("classifies health portals", () => {
    expect(classifyVisit(input("https:", "mychart.com", "/login"))).toBe(
      "health",
    );
  });

  it("classifies adult domains regardless of path", () => {
    expect(classifyVisit(input("https:", "pornhub.com", "/anything"))).toBe(
      "adult",
    );
  });

  it("classifies AWS console as cloud-console", () => {
    expect(
      classifyVisit(input("https:", "console.aws.amazon.com", "/")),
    ).toBe("cloud-console");
  });

  it("classifies /settings paths on normal hosts as app-config", () => {
    expect(classifyVisit(input("https:", "claude.ai", "/settings/usage"))).toBe(
      "app-config",
    );
  });

  it("classifies arxiv.org as research", () => {
    expect(classifyVisit(input("https:", "arxiv.org", "/abs/2402.06196"))).toBe(
      "research",
    );
  });

  it("classifies en.wikipedia.org as research", () => {
    expect(
      classifyVisit(
        input("https:", "en.wikipedia.org", "/wiki/Quantum_mechanics"),
      ),
    ).toBe("research");
  });

  it("classifies github.com repos as dev", () => {
    expect(
      classifyVisit(input("https:", "github.com", "/anthropics/cookbook")),
    ).toBe("dev");
  });

  it("classifies amazon.com as shopping", () => {
    expect(classifyVisit(input("https:", "amazon.com", "/dp/B08XYZ123"))).toBe(
      "shopping",
    );
  });

  it("classifies amazon.co.jp as shopping", () => {
    expect(
      classifyVisit(input("https:", "amazon.co.jp", "/dp/B08XYZ123")),
    ).toBe("shopping");
  });

  it("classifies x.com as social", () => {
    expect(classifyVisit(input("https:", "x.com", "/home"))).toBe("social");
  });

  it("classifies youtube.com as entertainment", () => {
    expect(
      classifyVisit(input("https:", "youtube.com", "/watch?v=abc")),
    ).toBe("entertainment");
  });

  it("falls back to other for unrecognised hosts", () => {
    expect(
      classifyVisit(input("https:", "example.invalid", "/anything")),
    ).toBe("other");
  });

  it("classifies cnn.com as news (covers NEWS_DOMAINS branch)", () => {
    expect(classifyVisit(input("https:", "cnn.com", "/2026/05/world"))).toBe("news");
  });

  it("returns other when path is exactly '/' (pathHasSegment empty-segments branch)", () => {
    // No segments → pathHasSegment returns false → falls through to other.
    expect(classifyVisit(input("https:", "example.invalid", "/"))).toBe("other");
  });

  it("treats missing scheme/path as empty strings (|| '' and || '/' branches)", () => {
    // Casts ensure the `input.scheme || ""` / `input.path || "/"` ternaries fire.
    expect(
      classifyVisit({ scheme: undefined, host: "example.invalid", path: undefined } as unknown as {
        scheme: string;
        host: string;
        path: string;
      }),
    ).toBe("other");
  });

  it("does NOT treat /research/api-keys-paper as app-config (segment-match, not substring)", () => {
    // The classifier's app-config segment list is matched as full
    // segments, not substrings — so paths that merely contain a
    // keyword as part of a longer word (`api-keys-paper`) do not
    // trigger app-config. The §5.F1.meaningful filter handles `/api`
    // as a separate prefix rule; see meaningful-filter.test.ts.
    expect(
      classifyVisit(input("https:", "example.com", "/research/api-keys-paper")),
    ).toBe("other");
  });
});

import { describe, it, expect } from "vitest";
import { summarizeVisits } from "./summarizer.js";
import type { ChromiumVisitRow } from "../readers/chromium-reader.js";

function rawRow(overrides: Partial<ChromiumVisitRow> = {}): ChromiumVisitRow {
  return {
    visitId: 1,
    url: "https://en.wikipedia.org/wiki/Quantum_mechanics",
    title: "Quantum mechanics",
    visitTimeMs: 1_700_000_000_000,
    transition: 0,
    rootTaskId: 100,
    foregroundSec: 120,
    durationSinceLastVisitSec: 30,
    httpStatus: 200,
    searchTerm: null,
    ...overrides,
  };
}

describe("summarizeVisits", () => {
  it("emits a meaningful row for a Wikipedia long-read", () => {
    const result = summarizeVisits({
      browser: "chrome",
      profile: "Default",
      rows: [rawRow()],
    });
    expect(result.visits).toHaveLength(1);
    expect(result.visits[0].category).toBe("research");
    expect(result.visits[0].meaningful).toBe(1);
    expect(result.visits[0].domain).toBe("en.wikipedia.org");
  });

  it("emits a non-meaningful row for claude.ai/settings", () => {
    const result = summarizeVisits({
      browser: "chrome",
      profile: "Default",
      rows: [
        rawRow({
          url: "https://claude.ai/settings/usage",
          title: "Usage settings",
        }),
      ],
    });
    expect(result.visits).toHaveLength(1);
    expect(result.visits[0].meaningful).toBe(0);
    expect(result.visits[0].category).toBe("app-config");
  });

  it("drops adult-categorised visits before insert", () => {
    const result = summarizeVisits({
      browser: "chrome",
      profile: "Default",
      rows: [
        rawRow({
          url: "https://pornhub.com/something",
          title: "ignore",
        }),
      ],
    });
    expect(result.visits).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });

  it("strips orderId from URL hash input", () => {
    const a = summarizeVisits({
      browser: "chrome",
      profile: "Default",
      rows: [
        rawRow({
          url: "https://amazon.com/gp/orders?orderId=ABC-123",
        }),
      ],
    });
    const b = summarizeVisits({
      browser: "chrome",
      profile: "Default",
      rows: [
        rawRow({
          url: "https://amazon.com/gp/orders?orderId=XYZ-999",
        }),
      ],
    });
    expect(a.visits[0].urlHash).toBe(b.visits[0].urlHash);
  });

  it("extracts amazon ASIN for /dp/ paths", () => {
    const result = summarizeVisits({
      browser: "chrome",
      profile: "Default",
      rows: [
        rawRow({
          url: "https://amazon.co.jp/dp/B08XYZ1234",
          title: "Product",
        }),
      ],
    });
    expect(result.visits[0].amazonAsin).toBe("B08XYZ1234");
    expect(result.visits[0].amazonLocale).toBe("co.jp");
    expect(result.visits[0].category).toBe("shopping");
  });

  it("tracks highestTimestampMs across rows", () => {
    const result = summarizeVisits({
      browser: "chrome",
      profile: "Default",
      rows: [
        rawRow({ visitTimeMs: 1_000 }),
        rawRow({ visitTimeMs: 5_000 }),
        rawRow({ visitTimeMs: 3_000 }),
      ],
    });
    expect(result.highestTimestampMs).toBe(5_000);
  });

  it("emits reload increments for reload-transition rows", () => {
    const result = summarizeVisits({
      browser: "chrome",
      profile: "Default",
      rows: [
        rawRow({
          url: "https://claude.ai/usage",
          transition: 8,
        }),
        rawRow({
          url: "https://claude.ai/usage",
          transition: 8,
        }),
      ],
    });
    expect(result.reloadIncrements).toHaveLength(1);
    expect(result.reloadIncrements[0].count).toBe(2);
    expect(result.reloadIncrements[0].urlPattern).toBe("claude.ai/usage");
  });

  it("redacts banking host: keeps domain, drops title and search", () => {
    const result = summarizeVisits({
      browser: "chrome",
      profile: "Default",
      rows: [
        rawRow({
          url: "https://chase.com/secure/balance",
          title: "Balance: $1,234",
          searchTerm: "balance",
        }),
      ],
    });
    expect(result.visits[0].title).toBeNull();
    expect(result.visits[0].searchQuery).toBeNull();
    expect(result.visits[0].domain).toBe("chase.com");
  });
});

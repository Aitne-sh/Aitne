import { describe, it, expect } from "vitest";
import type { MailMessage, MailMessageSummary } from "./mail/provider.js";
import {
  classifyMailMessage,
  extractMailTravel,
  formatMailAddress,
  processMailBatch,
  toClassifierInput,
} from "./mail-classifier.js";

function baseSummary(
  overrides: Partial<MailMessageSummary> = {},
): MailMessageSummary {
  return {
    accountId: "acc-1",
    providerMsgId: "m-1",
    rfc822MsgId: null,
    threadId: null,
    folder: "INBOX",
    receivedAtUtc: "2026-04-12T10:00:00Z",
    subject: "Hello",
    from: { email: "alice@example.com", name: "Alice" },
    to: [{ email: "owner@example.com" }],
    snippet: "Hi there",
    isRead: false,
    flags: [],
    hasAttachment: false,
    ...overrides,
  };
}

describe("formatMailAddress", () => {
  it("renders Name <addr> when name present", () => {
    expect(formatMailAddress({ email: "a@b.com", name: "Alice" })).toBe(
      "Alice <a@b.com>",
    );
  });

  it("renders bare email when name absent", () => {
    expect(formatMailAddress({ email: "a@b.com" })).toBe("a@b.com");
  });

  it("returns null for missing address", () => {
    expect(formatMailAddress(null)).toBeNull();
    expect(formatMailAddress(undefined)).toBeNull();
    expect(formatMailAddress({ email: "" })).toBeNull();
  });
});

describe("toClassifierInput", () => {
  it("maps summary fields 1:1 into EmailInput", () => {
    const input = toClassifierInput(
      baseSummary({
        providerMsgId: "graph-abc",
        subject: "Subj",
        snippet: "Snip",
      }),
    );
    expect(input).toEqual({
      messageId: "graph-abc",
      from: "Alice <alice@example.com>",
      subject: "Subj",
      snippet: "Snip",
      date: "2026-04-12T10:00:00Z",
      body: null,
    });
  });

  it("coerces null snippet to empty string (classifier invariant)", () => {
    const input = toClassifierInput(baseSummary({ snippet: null }));
    expect(input.snippet).toBe("");
  });

  it("threads the optional body through", () => {
    const input = toClassifierInput(baseSummary(), "full body text");
    expect(input.body).toBe("full body text");
  });
});

describe("classifyMailMessage", () => {
  it("classifies travel-domain messages as travel", () => {
    const result = classifyMailMessage(
      baseSummary({
        from: { email: "noreply@jetblue.com", name: "JetBlue" },
        subject: "Booking confirmation",
        snippet: "Your flight to Osaka",
      }),
    );
    expect(result.category).toBe("travel");
    expect(result.senderDomain).toBe("jetblue.com");
  });

  it("returns unknown for arbitrary senders", () => {
    const result = classifyMailMessage(baseSummary());
    expect(result.category).toBe("unknown");
  });
});

describe("extractMailTravel", () => {
  it("extracts travel details from a full MailMessage", () => {
    const message: MailMessage = {
      ...baseSummary({
        from: { email: "noreply@jetblue.com", name: "JetBlue" },
        subject: "Flight booking confirmation",
      }),
      body: {
        text: "Booking reference: ABCD12. Total: $350.00.",
      },
      attachments: [],
    };
    const travel = extractMailTravel(message);
    expect(travel).not.toBeNull();
    expect(travel?.provider).toBe("JetBlue");
    expect(travel?.type).toBe("flight");
  });

  it("returns null for non-travel mail", () => {
    const message: MailMessage = {
      ...baseSummary(),
      body: { text: "Just a note" },
      attachments: [],
    };
    expect(extractMailTravel(message)).toBeNull();
  });

  it("handles empty body (neither text nor html)", () => {
    const message: MailMessage = {
      ...baseSummary(),
      body: {},
      attachments: [],
    };
    expect(extractMailTravel(message)).toBeNull();
  });

  it("strips script/style and decodes entities in html fallback", () => {
    const message: MailMessage = {
      ...baseSummary({
        from: { email: "noreply@jetblue.com", name: "JetBlue" },
        subject: "Your flight itinerary",
      }),
      body: {
        html:
          "<style>.x{color:red}</style>" +
          "<script>alert(1)</script>" +
          "<p>Booking code ABCD12.&nbsp;&amp;&lt;Total&gt; &#8212; $500.00</p>",
      },
      attachments: [],
    };
    const travel = extractMailTravel(message);
    expect(travel?.provider).toBe("JetBlue");
    // Currency extracted from the stripped text.
    expect(travel?.amount).toBe(50000);
    expect(travel?.currency).toBe("USD");
  });

  it("falls back to html body when text missing", () => {
    const message: MailMessage = {
      ...baseSummary({
        from: { email: "noreply@jetblue.com", name: "JetBlue" },
        subject: "Your flight itinerary",
      }),
      body: { html: "<p>Booking code XYZ12. $100.00</p>" },
      attachments: [],
    };
    const travel = extractMailTravel(message);
    expect(travel?.provider).toBe("JetBlue");
  });
});

describe("processMailBatch", () => {
  it("aggregates a mixed batch into bucketed output", () => {
    const result = processMailBatch([
      baseSummary({
        providerMsgId: "m-1",
        from: { email: "noreply@jetblue.com", name: "JetBlue" },
        subject: "Flight booking confirmation",
      }),
      baseSummary({
        providerMsgId: "m-2",
        from: { email: "notify@kindle.amazon.com", name: "Kindle" },
        subject: "Your Kindle notebook",
      }),
      baseSummary({ providerMsgId: "m-3" }),
    ]);
    expect(result.travelBookings).toHaveLength(1);
    expect(result.kindleNotebooks).toHaveLength(1);
    expect(result.unknown).toHaveLength(1);
  });
});

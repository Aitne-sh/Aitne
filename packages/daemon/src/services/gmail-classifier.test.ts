import { describe, it, expect } from "vitest";
import {
  classifyEmail,
  extractAmountWithCurrency,
  extractSenderDomain,
  extractTravel,
  processEmailBatch,
  type EmailInput,
} from "./gmail-classifier.js";

describe("extractSenderDomain", () => {
  it("extracts the domain from angle-bracket format", () => {
    expect(extractSenderDomain("JetBlue <noreply@jetblue.com>")).toBe("jetblue.com");
  });

  it("normalizes domain case", () => {
    expect(extractSenderDomain("Airbnb <noreply@Airbnb.Com>")).toBe("airbnb.com");
  });

  it("returns null for invalid input", () => {
    expect(extractSenderDomain(null)).toBeNull();
    expect(extractSenderDomain("not-an-email")).toBeNull();
  });
});

describe("classifyEmail", () => {
  const base: EmailInput = {
    messageId: "msg-1",
    from: null,
    subject: null,
    snippet: "",
    date: "2026-04-12T10:00:00Z",
    body: null,
  };

  it("classifies travel bookings from supported domains", () => {
    const result = classifyEmail({
      ...base,
      from: "JetBlue <noreply@jetblue.com>",
      subject: "Booking confirmation",
      snippet: "Your flight to Osaka",
    });
    expect(result.category).toBe("travel");
  });

  it("returns unknown for travel-domain emails without booking signals", () => {
    const result = classifyEmail({
      ...base,
      from: "JetBlue <noreply@jetblue.com>",
      subject: "JetBlue Newsletter",
      snippet: "Check out our latest destinations",
    });
    expect(result.category).toBe("unknown");
  });

  it("returns unknown for unrelated non-travel emails", () => {
    const result = classifyEmail({
      ...base,
      from: "Newsletter <news@example.com>",
      subject: "Weekly roundup",
      snippet: "Top stories from this week",
    });
    expect(result.category).toBe("unknown");
  });
});

describe("extractAmountWithCurrency", () => {
  it("extracts USD as cents", () => {
    expect(extractAmountWithCurrency("Flight total $249.99")).toEqual({
      amount: 24999,
      currency: "USD",
    });
  });

  it("skips zero amounts", () => {
    expect(extractAmountWithCurrency("discount $0.00, balance $9.80")).toEqual({
      amount: 980,
      currency: "USD",
    });
  });
});

describe("extractTravel", () => {
  it("extracts a flight booking", () => {
    const email: EmailInput = {
      messageId: "travel-flight",
      from: "JetBlue <noreply@jetblue.com>",
      subject: "Booking confirmation",
      snippet: "Confirmation number: ABC123 Total $350.00",
      date: "2026-04-12",
      body: null,
    };

    const result = extractTravel(email, classifyEmail(email));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("flight");
    expect(result?.provider).toBe("JetBlue");
    expect(result?.confirmationNumber).toBe("ABC123");
    expect(result?.amount).toBe(35000);
  });

  it("extracts a hotel booking", () => {
    const email: EmailInput = {
      messageId: "travel-hotel",
      from: "Booking.com <noreply@booking.com>",
      subject: "Reservation confirmed",
      snippet: "Booking reference: XYZ789 Hotel Example $120.00",
      date: "2026-04-12",
      body: null,
    };

    const result = extractTravel(email, classifyEmail(email));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("hotel");
    expect(result?.provider).toBe("Booking.com");
    expect(result?.confirmationNumber).toBe("XYZ789");
    expect(result?.amount).toBe(12000);
  });

  it("returns null for non-travel emails", () => {
    const email: EmailInput = {
      messageId: "other",
      from: "friend@example.com",
      subject: "Hello",
      snippet: "Lunch tomorrow?",
      date: "2026-04-12",
      body: null,
    };

    expect(extractTravel(email, classifyEmail(email))).toBeNull();
  });
});

describe("processEmailBatch", () => {
  it("separates travel bookings from unknown emails", () => {
    const emails: EmailInput[] = [
      {
        messageId: "travel-1",
        from: "JetBlue <noreply@jetblue.com>",
        subject: "Booking confirmation",
        snippet: "Flight to New York confirmation number ABC123 $350.00",
        date: "2026-04-12",
        body: null,
      },
      {
        messageId: "travel-2",
        from: "Booking.com <noreply@booking.com>",
        subject: "Reservation confirmed",
        snippet: "Your stay at Hotel Example, check-in May 15",
        date: "2026-04-12",
        body: null,
      },
      {
        messageId: "unknown-1",
        from: "Newsletter <news@example.com>",
        subject: "Weekly roundup",
        snippet: "Top stories from this week",
        date: "2026-04-12",
        body: null,
      },
    ];

    const result = processEmailBatch(emails);

    expect(result.travelBookings).toHaveLength(2);
    expect(result.travelBookings[0].extraction.provider).toBe("JetBlue");
    expect(result.travelBookings[1].extraction.provider).toBe("Booking.com");
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0].messageId).toBe("unknown-1");
    expect(result.kindleNotebooks).toHaveLength(0);
    expect(result.parseFailures).toHaveLength(0);
  });

  it("routes Kindle Notebook Export emails to the kindleNotebooks bucket", () => {
    const emails: EmailInput[] = [
      {
        messageId: "kindle-1",
        from: "Kindle <do-not-reply@kindle.amazon.com>",
        subject: "Your Kindle Notebook from Thinking, Fast and Slow",
        snippet: "Notes and highlights from your book",
        date: "2026-04-14",
        body: null,
      },
      {
        messageId: "amazon-other-1",
        from: "Amazon <orders@amazon.com>",
        subject: "Your order has shipped",
        snippet: "Tracking information inside",
        date: "2026-04-14",
        body: null,
      },
    ];

    const result = processEmailBatch(emails);
    expect(result.kindleNotebooks).toHaveLength(1);
    expect(result.kindleNotebooks[0].messageId).toBe("kindle-1");
    expect(result.unknown.map((u) => u.messageId)).toEqual(["amazon-other-1"]);
  });

  it("handles an empty batch", () => {
    const result = processEmailBatch([]);
    expect(result.travelBookings).toHaveLength(0);
    expect(result.kindleNotebooks).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
    expect(result.parseFailures).toHaveLength(0);
  });
});

describe("Kindle Notebook classification", () => {
  const base: EmailInput = {
    messageId: "k1",
    from: null,
    subject: null,
    snippet: "",
    date: "2026-04-14T10:00:00Z",
    body: null,
  };

  it("classifies Amazon kindle-notebook senders with matching subject", () => {
    const result = classifyEmail({
      ...base,
      from: "Kindle <do-not-reply@kindle.amazon.com>",
      subject: "Your Kindle Notebook from Deep Work",
    });
    expect(result.category).toBe("kindle_notebook");
  });

  it("does not misclassify unrelated Amazon mail", () => {
    const result = classifyEmail({
      ...base,
      from: "Amazon <orders@amazon.com>",
      subject: "Your order has shipped",
    });
    expect(result.category).toBe("unknown");
  });

  it("does not misclassify non-Amazon senders using similar subjects", () => {
    const result = classifyEmail({
      ...base,
      from: "Blog <news@example.com>",
      subject: "My Kindle notebook workflow",
    });
    expect(result.category).toBe("unknown");
  });
});

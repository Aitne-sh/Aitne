import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import {
  insertReceipt,
  insertTravelBooking,
  processClassifiedMailBatch,
  recordParseFailure,
  emptyIngestionStats,
  type AttachmentLike,
  type MailIngestionSource,
} from "./mail-ingestion.js";
import type { TravelExtraction, ClassifiedEmail } from "./gmail-classifier.js";
import { pino } from "pino";

const logger = pino({ level: "silent" });

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

const source: MailIngestionSource = {
  parseFailureKeyPrefix: "test:",
  accountId: "acc-1",
};

const travelExtraction: TravelExtraction = {
  type: "flight",
  provider: "United",
  destination: "San Francisco",
  startDate: "2026-04-17",
  endDate: "2026-04-18",
  confirmationNumber: "ABC123",
  amount: 500,
  currency: "USD",
};

const classifiedEmail: ClassifiedEmail = {
  messageId: "msg-1",
  category: "travel",
  sender: "booking@united.com",
  senderDomain: "united.com",
  subject: "Booking Confirmation",
  date: "2026-04-17",
};

const attachment: AttachmentLike = {
  attachmentId: "att-1",
  filename: "itinerary.pdf",
  mimeType: "application/pdf",
  size: 12345,
};

describe("emptyIngestionStats", () => {
  it("returns zeroed stats", () => {
    expect(emptyIngestionStats()).toEqual({
      travelBookingsInserted: 0,
      receiptsDetected: 0,
      kindleNotebooks: 0,
      kindleBooksCreated: 0,
      kindleHighlightsInserted: 0,
      parseFailures: 0,
    });
  });
});

describe("insertTravelBooking", () => {
  it("inserts a booking and returns true", () => {
    const db = makeDb();
    expect(insertTravelBooking(db, "test:msg-1", travelExtraction)).toBe(true);
    db.close();
  });

  it("returns false when a UNIQUE constraint error is thrown", () => {
    const uniqueErr = new Error("UNIQUE constraint failed: travel_bookings.provider_msg_id");
    const mockDb = {
      prepare: () => ({ run: () => { throw uniqueErr; } }),
    } as unknown as Database.Database;
    expect(insertTravelBooking(mockDb, "msg-1", travelExtraction)).toBe(false);
  });

  it("re-throws non-unique-constraint errors", () => {
    const fatalErr = new Error("disk full");
    const mockDb = {
      prepare: () => ({ run: () => { throw fatalErr; } }),
    } as unknown as Database.Database;
    expect(() => insertTravelBooking(mockDb, "msg-1", travelExtraction)).toThrow(fatalErr);
  });
});

describe("insertReceipt", () => {
  it("inserts a receipt and returns true", () => {
    const db = makeDb();
    expect(insertReceipt(db, "test:msg-1", attachment, "travel", "acc-1")).toBe(true);
    db.close();
  });

  it("returns false on duplicate (account_id, provider_msg_id, attachment_id)", () => {
    const db = makeDb();
    insertReceipt(db, "test:msg-1", attachment, "travel", "acc-1");
    expect(insertReceipt(db, "test:msg-1", attachment, "travel", "acc-1")).toBe(false);
    db.close();
  });

  it("re-throws non-unique-constraint errors", () => {
    const fatalErr = new Error("disk full");
    const mockDb = {
      prepare: () => ({
        run: () => { throw fatalErr; },
      }),
    } as unknown as Database.Database;
    expect(() => insertReceipt(mockDb, "msg-1", attachment, "travel", null)).toThrow(fatalErr);
  });
});

describe("recordParseFailure", () => {
  it("inserts a parse failure and returns true", () => {
    const db = makeDb();
    expect(
      recordParseFailure(db, {
        uniqueKey: "test:msg-1",
        sender: "spammer@example.com",
        subject: "Unrecognized email",
        snippet: "...",
        errorReason: "unrecognized_sender",
      }),
    ).toBe(true);
    db.close();
  });

  it("returns false when a UNIQUE constraint error is thrown", () => {
    const uniqueErr = new Error("UNIQUE constraint failed: parse_failures.provider_msg_id");
    const mockDb = {
      prepare: () => ({ run: () => { throw uniqueErr; } }),
    } as unknown as Database.Database;
    expect(
      recordParseFailure(mockDb, {
        uniqueKey: "msg-1",
        sender: null,
        subject: null,
        snippet: "",
        errorReason: "test",
      }),
    ).toBe(false);
  });

  it("re-throws non-unique-constraint errors", () => {
    const fatalErr = new Error("disk full");
    const mockDb = {
      prepare: () => ({ run: () => { throw fatalErr; } }),
    } as unknown as Database.Database;
    expect(() =>
      recordParseFailure(mockDb, {
        uniqueKey: "msg-1",
        sender: null,
        subject: null,
        snippet: "",
        errorReason: "test",
      }),
    ).toThrow(fatalErr);
  });
});

describe("processClassifiedMailBatch", () => {
  it("processes a travel booking batch", async () => {
    const db = makeDb();
    const batch = {
      travelBookings: [{ email: classifiedEmail, extraction: travelExtraction }],
      kindleNotebooks: [],
      unknown: [],
      parseFailures: [],
    };
    const stats = await processClassifiedMailBatch({
      db,
      logger,
      source,
      batch,
      fetchHtml: async () => null,
    });
    expect(stats.travelBookingsInserted).toBe(1);
    db.close();
  });

  it("counts receipt attachments from fetchAttachments", async () => {
    const db = makeDb();
    const batch = {
      travelBookings: [{ email: classifiedEmail, extraction: travelExtraction }],
      kindleNotebooks: [],
      unknown: [],
      parseFailures: [],
    };
    const stats = await processClassifiedMailBatch({
      db,
      logger,
      source,
      batch,
      fetchHtml: async () => null,
      fetchAttachments: async () => [attachment],
    });
    expect(stats.receiptsDetected).toBe(1);
    db.close();
  });

  it("logs warning and returns 0 detected when fetchAttachments throws", async () => {
    const db = makeDb();
    const warnSpy = vi.spyOn(logger, "warn");
    const batch = {
      travelBookings: [{ email: classifiedEmail, extraction: travelExtraction }],
      kindleNotebooks: [],
      unknown: [],
      parseFailures: [],
    };
    const stats = await processClassifiedMailBatch({
      db,
      logger,
      source,
      batch,
      fetchHtml: async () => null,
      fetchAttachments: async () => { throw new Error("network error"); },
    });
    expect(stats.receiptsDetected).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to scan attachments for receipts",
    );
    db.close();
  });

  it("records kindle notebook parse failure when fetchHtml throws an Error", async () => {
    const db = makeDb();
    const warnSpy = vi.spyOn(logger, "warn");
    const kindleEmail: ClassifiedEmail = {
      messageId: "kindle-msg-1",
      category: "kindle_notebook",
      sender: "kindle@amazon.com",
      senderDomain: "amazon.com",
      subject: "Your Kindle Notes",
      date: "2026-04-17",
    };
    const batch = {
      travelBookings: [],
      kindleNotebooks: [kindleEmail],
      unknown: [],
      parseFailures: [],
    };
    const stats = await processClassifiedMailBatch({
      db,
      logger,
      source,
      batch,
      fetchHtml: async () => { throw new Error("fetch error"); },
    });
    expect(stats.parseFailures).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to ingest Kindle notebook email",
    );
    db.close();
  });

  it("records kindle notebook parse failure when fetchHtml throws a non-Error value", async () => {
    const db = makeDb();
    const kindleEmail: ClassifiedEmail = {
      messageId: "kindle-msg-2",
      category: "kindle_notebook",
      sender: "kindle@amazon.com",
      senderDomain: "amazon.com",
      subject: "Your Kindle Notes",
      date: "2026-04-17",
    };
    const batch = {
      travelBookings: [],
      kindleNotebooks: [kindleEmail],
      unknown: [],
      parseFailures: [],
    };
    // Throwing a non-Error value covers the String(err) branch in the error message
    const stats = await processClassifiedMailBatch({
      db,
      logger,
      source,
      batch,
      fetchHtml: async () => { throw "non-error string"; },
    });
    expect(stats.parseFailures).toBe(1);
    db.close();
  });

  it("records parse failures from batch", async () => {
    const db = makeDb();
    const batch = {
      travelBookings: [],
      kindleNotebooks: [],
      unknown: [],
      parseFailures: [
        {
          messageId: "msg-fail",
          sender: "x@example.com",
          subject: "Unmatched",
          snippet: "...",
          errorReason: "travel_extraction_failed",
        },
      ],
    };
    const stats = await processClassifiedMailBatch({
      db,
      logger,
      source,
      batch,
      fetchHtml: async () => null,
    });
    expect(stats.parseFailures).toBe(1);
    db.close();
  });
});

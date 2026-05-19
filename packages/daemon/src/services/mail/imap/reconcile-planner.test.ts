import { describe, it, expect } from "vitest";
import { planImapReconcile } from "./reconcile-planner.js";

describe("planImapReconcile", () => {
  it("returns empty plan when local and server agree", () => {
    const plan = planImapReconcile({
      serverUidValidity: 100,
      serverUids: [1, 2, 3],
      localMessages: [
        { providerMsgId: "100:1", receivedAtUtc: "2026-04-10" },
        { providerMsgId: "100:2", receivedAtUtc: "2026-04-11" },
        { providerMsgId: "100:3", receivedAtUtc: "2026-04-12" },
      ],
      minUidWalked: 0,
    });
    expect(plan).toEqual({ missingIds: [], skippedIds: [] });
  });

  it("flags local rows missing from server as missingIds", () => {
    const plan = planImapReconcile({
      serverUidValidity: 100,
      serverUids: [1, 3],
      localMessages: [
        { providerMsgId: "100:1", receivedAtUtc: "2026-04-10" },
        { providerMsgId: "100:2", receivedAtUtc: "2026-04-11" },
        { providerMsgId: "100:3", receivedAtUtc: "2026-04-12" },
      ],
      minUidWalked: 0,
    });
    expect(plan.missingIds).toEqual(["100:2"]);
    expect(plan.skippedIds).toEqual([]);
  });

  it("skips rows with unparseable ids", () => {
    const plan = planImapReconcile({
      serverUidValidity: 100,
      serverUids: [1],
      localMessages: [
        { providerMsgId: "not-an-imap-id", receivedAtUtc: "2026-04-10" },
        { providerMsgId: "100:1", receivedAtUtc: "2026-04-11" },
      ],
      minUidWalked: 0,
    });
    expect(plan.missingIds).toEqual([]);
    expect(plan.skippedIds).toEqual(["not-an-imap-id"]);
  });

  it("skips rows belonging to a prior UIDVALIDITY epoch", () => {
    const plan = planImapReconcile({
      serverUidValidity: 200,
      serverUids: [5],
      localMessages: [
        { providerMsgId: "100:5", receivedAtUtc: "2026-04-10" },
        { providerMsgId: "200:5", receivedAtUtc: "2026-04-12" },
      ],
      minUidWalked: 0,
    });
    expect(plan.missingIds).toEqual([]);
    expect(plan.skippedIds).toEqual(["100:5"]);
  });

  it("skips rows below the walked UID window", () => {
    const plan = planImapReconcile({
      serverUidValidity: 100,
      serverUids: [10, 11, 12],
      localMessages: [
        { providerMsgId: "100:1", receivedAtUtc: "2026-04-01" },
        { providerMsgId: "100:10", receivedAtUtc: "2026-04-10" },
        { providerMsgId: "100:11", receivedAtUtc: "2026-04-11" },
      ],
      minUidWalked: 10,
    });
    expect(plan.missingIds).toEqual([]);
    expect(plan.skippedIds).toEqual(["100:1"]);
  });

  it("rejects non-integer and non-positive server UIDs", () => {
    const plan = planImapReconcile({
      serverUidValidity: 100,
      serverUids: [0, -1, 1.5, 2, Number.NaN],
      localMessages: [
        { providerMsgId: "100:1", receivedAtUtc: "2026-04-10" },
        { providerMsgId: "100:2", receivedAtUtc: "2026-04-11" },
      ],
      minUidWalked: 0,
    });
    // 1 not present (0/−1/1.5/NaN filtered out); 2 present
    expect(plan.missingIds).toEqual(["100:1"]);
  });

  it("accepts any iterable for serverUids", () => {
    const plan = planImapReconcile({
      serverUidValidity: 100,
      serverUids: new Set([1, 2]),
      localMessages: [
        { providerMsgId: "100:1", receivedAtUtc: "2026-04-10" },
        { providerMsgId: "100:3", receivedAtUtc: "2026-04-12" },
      ],
      minUidWalked: 0,
    });
    expect(plan.missingIds).toEqual(["100:3"]);
  });

  it("tolerates empty server listing — everything in window is missing", () => {
    const plan = planImapReconcile({
      serverUidValidity: 100,
      serverUids: [],
      localMessages: [
        { providerMsgId: "100:1", receivedAtUtc: "2026-04-10" },
        { providerMsgId: "100:2", receivedAtUtc: "2026-04-11" },
      ],
      minUidWalked: 0,
    });
    expect(plan.missingIds).toEqual(["100:1", "100:2"]);
  });
});

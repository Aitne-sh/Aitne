import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  CLARIFICATION_TTL_MS,
  createClarification,
  expireClarification,
  getClarification,
  listClarificationsForTask,
  listUndeliveredClarifications,
  listOverdueClarifications,
  markClarificationDelivered,
  resolveClarification,
  type CreateClarificationInput,
} from "./browser-task-clarifications-store.js";

let db: Database.Database;

function seedTask(id: string): void {
  db.prepare(
    `INSERT INTO browser_task
       (id, description, state, require_final_confirm, blocked_requests_count,
        extract_chars_total, created_at)
     VALUES (?, 'd', 'awaiting_user', 1, 0, 0, 1)`,
  ).run(id);
}

function input(overrides: Partial<CreateClarificationInput> = {}): CreateClarificationInput {
  return {
    id: "cl-1",
    taskId: "task-1",
    question: "Which size?",
    contextSummary: "two options on screen",
    screenshotKey: "task-1/ask.png",
    askedAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  seedTask("task-1");
});

afterEach(() => {
  db.close();
});

describe("createClarification", () => {
  it("computes the deadline as askedAt + TTL and starts unresolved", () => {
    const row = createClarification(db, input());
    expect(row).toMatchObject({
      id: "cl-1",
      taskId: "task-1",
      question: "Which size?",
      contextSummary: "two options on screen",
      askedAt: 1000,
      deadlineAt: 1000 + CLARIFICATION_TTL_MS,
      deliveredAt: null,
      answer: null,
      answeredAt: null,
      resolved: false,
    });
    expect(getClarification(db, "cl-1")).toEqual(row);
  });

  it("returns null from getClarification for an unknown id", () => {
    expect(getClarification(db, "nope")).toBeNull();
  });
});

describe("delivery recovery helpers", () => {
  it("lists unresolved awaiting_user clarifications until delivered_at is set", () => {
    const row = createClarification(db, input());
    expect(listUndeliveredClarifications(db, 1500).map((r) => r.id)).toEqual([
      row.id,
    ]);
    const marked = markClarificationDelivered(db, row.id, 1600);
    expect(marked?.deliveredAt).toBe(1600);
    expect(listUndeliveredClarifications(db, 1700)).toEqual([]);
  });

  it("does not list expired or resolved clarifications", () => {
    createClarification(db, input({ id: "expired", askedAt: 0 }));
    createClarification(db, input({ id: "resolved", askedAt: 1000 }));
    resolveClarification(db, {
      id: "resolved",
      answer: "large",
      answeredAt: 1500,
    });
    expect(
      listUndeliveredClarifications(db, CLARIFICATION_TTL_MS + 1).map(
        (r) => r.id,
      ),
    ).toEqual([]);
  });
});

describe("listClarificationsForTask", () => {
  it("orders by asked_at ASC and is scoped per task", () => {
    seedTask("task-2");
    createClarification(db, input({ id: "b", askedAt: 2000 }));
    createClarification(db, input({ id: "a", askedAt: 1000 }));
    createClarification(db, input({ id: "z", taskId: "task-2", askedAt: 500 }));
    expect(listClarificationsForTask(db, "task-1").map((r) => r.id)).toEqual(["a", "b"]);
    expect(listClarificationsForTask(db, "task-2").map((r) => r.id)).toEqual(["z"]);
  });
});

describe("resolveClarification (CAS)", () => {
  it("resolves with the user's answer when within the deadline", () => {
    createClarification(db, input());
    const res = resolveClarification(db, { id: "cl-1", answer: "Large", answeredAt: 1500 });
    expect(res.ok).toBe(true);
    expect(res.row).toMatchObject({ answer: "Large", answeredAt: 1500, resolved: true });
  });

  it("reports not_found for an unknown id", () => {
    expect(resolveClarification(db, { id: "ghost", answer: "x", answeredAt: 1 })).toEqual({
      ok: false,
      row: null,
      reason: "not_found",
    });
  });

  it("reports already_resolved on a second resolve", () => {
    createClarification(db, input());
    resolveClarification(db, { id: "cl-1", answer: "Large", answeredAt: 1500 });
    const res = resolveClarification(db, { id: "cl-1", answer: "Small", answeredAt: 1600 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("already_resolved");
    // The original answer is preserved.
    expect(getClarification(db, "cl-1")!.answer).toBe("Large");
  });

  it("reports expired when answeredAt is past the deadline", () => {
    createClarification(db, input({ askedAt: 1000 }));
    const res = resolveClarification(db, {
      id: "cl-1",
      answer: "Large",
      answeredAt: 1000 + CLARIFICATION_TTL_MS + 1,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("expired");
    expect(getClarification(db, "cl-1")!.resolved).toBe(false);
  });
});

describe("listOverdueClarifications", () => {
  it("returns only unresolved rows past their deadline, ordered by deadline ASC", () => {
    createClarification(db, input({ id: "early", askedAt: 0 })); // deadline = TTL
    createClarification(db, input({ id: "late", askedAt: 1000 })); // deadline = 1000+TTL
    createClarification(db, input({ id: "future", askedAt: 10 * CLARIFICATION_TTL_MS }));
    // Resolve `early` so it is excluded despite being overdue.
    const resolvedRow = createClarification(db, input({ id: "resolved", askedAt: 0 }));
    resolveClarification(db, { id: resolvedRow.id, answer: "x", answeredAt: 1 });

    const now = 5 * CLARIFICATION_TTL_MS;
    expect(listOverdueClarifications(db, now).map((r) => r.id)).toEqual(["early", "late"]);
  });
});

describe("expireClarification", () => {
  it("marks an unresolved row resolved with answered_at but no answer", () => {
    createClarification(db, input());
    const row = expireClarification(db, "cl-1", 9000);
    expect(row).toMatchObject({ resolved: true, answeredAt: 9000, answer: null });
  });

  it("returns null when the row is already resolved or missing", () => {
    createClarification(db, input());
    resolveClarification(db, { id: "cl-1", answer: "x", answeredAt: 1500 });
    expect(expireClarification(db, "cl-1", 9000)).toBeNull();
    expect(expireClarification(db, "ghost", 9000)).toBeNull();
  });
});

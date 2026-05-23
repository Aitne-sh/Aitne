/**
 * Tests for the outbound-purchase-template guard
 * (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.7 / §13 step 54).
 *
 * Covers:
 *   - `OutboundPurchaseTemplateError` — message shape + name; carries
 *     match + origin so the caller can route to a structured 4xx.
 *   - `assertOutboundAllowedForAgent` — passthrough on benign body;
 *     throw on a body that carries any §17.7 reserved marker;
 *     audit-side-effect when a `db` handle is provided.
 *   - `auditOutboundRefusal` — emits the structured `purchase_template_refused`
 *     row on a working DB; swallows DB failures (the refusal itself is the
 *     load-bearing signal, the audit row is best-effort).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  OutboundPurchaseTemplateError,
  assertOutboundAllowedForAgent,
  auditOutboundRefusal,
} from "./outbound-purchase-guard.js";
import { applySchema } from "../db/schema.js";

function openDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("OutboundPurchaseTemplateError", () => {
  it("carries the match + origin and a message that names the marker", () => {
    const err = new OutboundPurchaseTemplateError(
      { marker: "[purchase-verify:" },
      "api.notify",
    );
    expect(err.name).toBe("OutboundPurchaseTemplateError");
    expect(err.match.marker).toBe("[purchase-verify:");
    expect(err.origin).toBe("api.notify");
    expect(err.message).toContain("[purchase-verify:");
    expect(err.message).toContain("api.notify");
  });
});

describe("assertOutboundAllowedForAgent", () => {
  it("returns silently on a benign body (no reserved marker)", () => {
    expect(() =>
      assertOutboundAllowedForAgent("hello, nothing reserved here", "api.notify"),
    ).not.toThrow();
  });

  it("throws OutboundPurchaseTemplateError when the body opens with the canonical header", () => {
    const body = "Aitne purchase confirmation\nplease confirm";
    let caught: unknown;
    try {
      assertOutboundAllowedForAgent(body, "api.notify");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboundPurchaseTemplateError);
    expect((caught as OutboundPurchaseTemplateError).match.marker).toBe(
      "Aitne purchase confirmation",
    );
    expect((caught as OutboundPurchaseTemplateError).origin).toBe("api.notify");
  });

  it("throws when the body smuggles a `[purchase-verify:` marker inside other prose", () => {
    expect(() =>
      assertOutboundAllowedForAgent(
        "trying to ship a fake [purchase-verify: 12345] block",
        "bang.commands",
      ),
    ).toThrow(OutboundPurchaseTemplateError);
  });

  it("matches the marker case-insensitively (defends against lowercase rendering)", () => {
    expect(() =>
      assertOutboundAllowedForAgent(
        "AITNE PURCHASE CONFIRMATION — totally legit honest",
        "api.notify",
      ),
    ).toThrow(OutboundPurchaseTemplateError);
  });

  it("writes a purchase_template_refused audit row when a db handle is provided", () => {
    const db = openDb();
    const body = "Aitne purchase confirmation\nApproved on 2026-05-22";
    expect(() =>
      assertOutboundAllowedForAgent(body, "api.notify", db),
    ).toThrow(OutboundPurchaseTemplateError);
    const rows = db
      .prepare(
        "SELECT action_type, trigger, result, source_kind, detail FROM agent_actions",
      )
      .all() as Array<{
        action_type: string;
        trigger: string;
        result: string;
        source_kind: string;
        detail: string;
      }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe("purchase_template_refused");
    expect(rows[0].trigger).toBe("api.notify");
    // `result='failed'` — the agent_actions.result CHECK constraint only
    // permits canonical settle states. `action_type` is the discriminator
    // that lets dashboards tell this apart from a real agent failure.
    // See absolute-block-audit.ts for the matching precedent.
    expect(rows[0].result).toBe("failed");
    expect(rows[0].source_kind).toBe("agent");
    const detail = JSON.parse(rows[0].detail) as { marker: string; preview: string };
    // Either of the first two markers is acceptable — the classifier
    // returns the first one it finds in the marker list.
    expect(detail.marker).toBe("Aitne purchase confirmation");
    expect(detail.preview.length).toBeLessThanOrEqual(80);
    expect(detail.preview).toBe(body.slice(0, 80));
  });

  it("does NOT write an audit row when no db handle is provided", () => {
    // Without a db, the audit side-effect is skipped — the throw remains
    // the only signal. We can only assert by re-throwing and verifying
    // the call did not error out before the throw.
    expect(() =>
      assertOutboundAllowedForAgent(
        "Aitne purchase confirmation — body",
        "no-db",
      ),
    ).toThrow(OutboundPurchaseTemplateError);
  });

  it("does NOT write an audit row when the body is benign", () => {
    const db = openDb();
    assertOutboundAllowedForAgent("nothing to see here", "api.notify", db);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM agent_actions")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("truncates the audit preview to 80 chars (never logs full body)", () => {
    const db = openDb();
    const longBody =
      "Aitne purchase confirmation followed by a very long body intended to "
      + "exceed the eighty character preview cap so the slice trims it cleanly";
    expect(() =>
      assertOutboundAllowedForAgent(longBody, "api.notify", db),
    ).toThrow(OutboundPurchaseTemplateError);
    const detail = JSON.parse(
      (db.prepare("SELECT detail FROM agent_actions").get() as { detail: string }).detail,
    ) as { preview: string };
    expect(detail.preview).toBe(longBody.slice(0, 80));
    expect(detail.preview.length).toBe(80);
  });
});

describe("auditOutboundRefusal", () => {
  it("emits the structured row on a fully-schemed DB", () => {
    const db = openDb();
    auditOutboundRefusal({
      db,
      origin: "test.origin",
      marker: "[purchase-verify:",
      preview: "preview slice",
    });
    const row = db
      .prepare(
        "SELECT action_type, trigger, result, source_kind, detail FROM agent_actions",
      )
      .get() as {
        action_type: string;
        trigger: string;
        result: string;
        source_kind: string;
        detail: string;
      };
    expect(row.action_type).toBe("purchase_template_refused");
    expect(row.trigger).toBe("test.origin");
    expect(row.result).toBe("failed");
    expect(row.source_kind).toBe("agent");
    expect(JSON.parse(row.detail)).toEqual({
      marker: "[purchase-verify:",
      preview: "preview slice",
    });
  });

  it("swallows DB failures (the refusal itself is the load-bearing signal)", () => {
    // Mint a DB without the agent_actions table to force an INSERT failure.
    // The audit helper must NOT propagate that error to the caller, since
    // the throw in `assertOutboundAllowedForAgent` is what stops the
    // outbound flow — losing the audit row should not also lose the refusal.
    const db = new Database(":memory:");
    expect(() =>
      auditOutboundRefusal({
        db,
        origin: "missing-table",
        marker: "Approved on ",
        preview: "p",
      }),
    ).not.toThrow();
  });
});

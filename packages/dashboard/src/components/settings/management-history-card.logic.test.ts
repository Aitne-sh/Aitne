import { describe, expect, it } from "vitest";
import {
  KIND_BADGE,
  KIND_LABEL,
  renderSummary,
} from "./management-history-card.logic";

describe("KIND_LABEL / KIND_BADGE", () => {
  it("covers every documented audit-row kind", () => {
    const expected = [
      "management_task.created",
      "management_task.modified",
      "management_task.deleted",
      "management_task.run_recorded",
      "management_task.run_now",
      "management_task.app_renamed",
      "sot_binding.updated",
    ];
    for (const kind of expected) {
      expect(KIND_LABEL[kind]).toBeTypeOf("string");
      expect(KIND_BADGE[kind]).toBeTypeOf("string");
    }
  });
});

describe("renderSummary", () => {
  it("returns null when detail is missing", () => {
    expect(renderSummary("management_task.created", null)).toBeNull();
  });

  it("composes the create summary from app/cadence/output_path", () => {
    expect(
      renderSummary("management_task.created", {
        app: "Zoom",
        cadence: "daily 10:00",
        output_path: "work/meetings/",
      }),
    ).toBe("Zoom · daily 10:00 · → work/meetings/");
  });

  it("returns null when create detail has no usable fields", () => {
    expect(renderSummary("management_task.created", {})).toBeNull();
  });

  it("formats modified rows as `changed: …`", () => {
    expect(
      renderSummary("management_task.modified", {
        changed: ["intent", "cadence"],
      }),
    ).toBe("changed: intent, cadence");
  });

  it("filters non-string entries from the modified `changed` array", () => {
    expect(
      renderSummary("management_task.modified", {
        // The route emits string keys, but tests guard against drift.
        changed: ["intent", 42, null, "cadence"],
      }),
    ).toBe("changed: intent, cadence");
  });

  it("renders the deleted row's intent + app from `original_row`", () => {
    expect(
      renderSummary("management_task.deleted", {
        original_row: { intent: "fetch recordings", app: "Zoom" },
      }),
    ).toBe("fetch recordings (Zoom)");
  });

  it("returns null when the deleted detail has no original_row", () => {
    expect(renderSummary("management_task.deleted", {})).toBeNull();
  });

  it("renders run_now reason", () => {
    expect(
      renderSummary("management_task.run_now", { reason: "dashboard" }),
    ).toBe("reason: dashboard");
    expect(renderSummary("management_task.run_now", {})).toBeNull();
  });

  it("renders run_recorded last_result verbatim", () => {
    expect(
      renderSummary("management_task.run_recorded", {
        last_result: "ok (3 new)",
      }),
    ).toBe("ok (3 new)");
  });

  it("renders app_renamed as `from → to`", () => {
    expect(
      renderSummary("management_task.app_renamed", {
        from: "Zoom",
        to: "Zoom Workplace",
      }),
    ).toBe("Zoom → Zoom Workplace");
  });

  it("renders sot_binding count delta", () => {
    expect(
      renderSummary("sot_binding.updated", {
        previous: [{}, {}],
        next: [{}, {}, {}],
      }),
    ).toBe("2 → 3 bindings");
  });

  it("returns null for unknown kinds (regression: no thrown TypeError)", () => {
    expect(renderSummary("unknown.kind", { foo: "bar" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { docIdForEventType } from "./event-type-doc-map";

describe("event-type-doc-map", () => {
  it("maps every key in EVENT_TYPE_COLORS to a doc", async () => {
    // The colour map is the canonical list of action types that the
    // dashboard already renders distinctly; if any of them lose their
    // doc link, the operator-facing affordance regresses silently.
    const { EVENT_TYPE_COLORS } = await import("@/lib/constants");
    for (const eventType of Object.keys(EVENT_TYPE_COLORS)) {
      expect(
        docIdForEventType(eventType),
        `expected docs link for ${eventType}`,
      ).not.toBeNull();
    }
  });

  it("collapses every morning_routine variant onto one doc", () => {
    expect(docIdForEventType("routine.morning_routine")).toBe(
      "features/routines/morning-routine",
    );
    // morning-routine-optimization.md Phase 5 split keys.
    expect(docIdForEventType("routine.morning_routine_today")).toBe(
      "features/routines/morning-routine",
    );
    expect(docIdForEventType("routine.morning_routine_journal")).toBe(
      "features/routines/morning-routine",
    );
    // Phase 7 (2026-05-16) retired the heavy-tier
    // `routine.morning_routine_initial`, but the doc map retains the
    // defensive entry so historical agent_actions rows still resolve.
    expect(docIdForEventType("routine.morning_routine_initial")).toBe(
      "features/routines/morning-routine",
    );
  });

  it("resolves routine.custom.<slug> via prefix rule", () => {
    expect(docIdForEventType("routine.custom.gym-tracker")).toBe(
      "features/routines/custom-routines",
    );
    expect(docIdForEventType("routine.custom.x")).toBe(
      "features/routines/custom-routines",
    );
  });

  it("collapses setup.* family onto the wizard walkthrough", () => {
    expect(docIdForEventType("setup.initial")).toBe("guides/setup-wizard");
    expect(docIdForEventType("setup.update")).toBe("guides/setup-wizard");
  });

  it("collapses calendar.* and git.* families", () => {
    expect(docIdForEventType("calendar.change")).toBe(
      "features/integrations/calendar",
    );
    expect(docIdForEventType("calendar.event_added")).toBe(
      "features/integrations/calendar",
    );
    expect(docIdForEventType("git.push")).toBe("features/integrations/git");
    expect(docIdForEventType("git.new_commit")).toBe(
      "features/integrations/git",
    );
  });

  it("returns null for unmapped event types so the UI hides the link", () => {
    // Real action_types emitted by the daemon that intentionally have no
    // operator-facing doc — verified by audit/absolute-block-audit/
    // delegated-backend-invoker writes. The intent is "hide the link, not
    // 404 the operator", and this assertion documents that intent.
    expect(docIdForEventType("attachment.upload.outbound")).toBeNull();
    expect(docIdForEventType("attachment.upload.inbound")).toBeNull();
    expect(docIdForEventType("delegated_proxy.invoke")).toBeNull();
    expect(docIdForEventType("delegated_task.exec")).toBeNull();
    expect(docIdForEventType("blocked_absolute")).toBeNull();
    expect(docIdForEventType("qa_invalid_citation")).toBeNull();
    expect(docIdForEventType("totally.unknown")).toBeNull();
  });

  it("does not link ProcessKey-only strings that never reach action_type", () => {
    // `agent_actions.action_type` stores `event.type`, never the
    // ProcessKey resolved later in routing. DM / mention / dashboard-chat
    // events all emit `event.type === "message.received"`, so the
    // ProcessKey strings must NOT be in the EXACT table — having them
    // would silently misclassify any future event accidentally tagged
    // with one of these strings. If a future audit path persists the
    // ProcessKey instead, drop this guard along with that change.
    expect(docIdForEventType("message.dm")).toBeNull();
    expect(docIdForEventType("message.mention")).toBeNull();
    expect(docIdForEventType("dashboard.chat")).toBeNull();
  });

  it("falls back to prefix when there is no exact entry", () => {
    // No real exact-vs-prefix collision exists today (the EXACT keys
    // and the PREFIX namespaces are disjoint by construction), so this
    // test instead pins the prefix-only path. If a future EXACT entry
    // overlaps a prefix family, add a dedicated precedence assertion
    // alongside this one.
    expect(docIdForEventType("calendar.event_added")).toBe(
      "features/integrations/calendar",
    );
    expect(docIdForEventType("git.push")).toBe("features/integrations/git");
  });
});

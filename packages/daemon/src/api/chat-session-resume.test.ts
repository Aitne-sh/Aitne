import { describe, expect, it } from "vitest";
import { resolveDashboardResumeSession } from "./chat-session-resume";

describe("resolveDashboardResumeSession", () => {
  it("keeps a valid requested session", () => {
    expect(
      resolveDashboardResumeSession({
        requestedSessionId: 10,
        requestedSessionIsActive: true,
        activeDashboardSessionId: 20,
      }),
    ).toEqual({
      sessionId: 10,
      valid: true,
      source: "requested",
    });
  });

  it("falls back to the active dashboard session when the requested session is stale", () => {
    expect(
      resolveDashboardResumeSession({
        requestedSessionId: 10,
        requestedSessionIsActive: false,
        activeDashboardSessionId: 20,
      }),
    ).toEqual({
      sessionId: 20,
      valid: true,
      source: "active",
    });
  });

  it("returns none when neither requested nor active sessions are available", () => {
    expect(
      resolveDashboardResumeSession({
        requestedSessionId: 10,
        requestedSessionIsActive: false,
        activeDashboardSessionId: null,
      }),
    ).toEqual({
      source: "none",
    });
  });
});

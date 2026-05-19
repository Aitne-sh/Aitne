export interface ResolveDashboardResumeParams {
  requestedSessionId?: number;
  requestedSessionIsActive?: boolean;
  activeDashboardSessionId?: number | null;
}

export interface ResolvedDashboardResume {
  sessionId?: number;
  valid?: true;
  source: "requested" | "active" | "none";
}

export function resolveDashboardResumeSession({
  requestedSessionId,
  requestedSessionIsActive,
  activeDashboardSessionId,
}: ResolveDashboardResumeParams): ResolvedDashboardResume {
  if (
    typeof requestedSessionId === "number"
    && requestedSessionId > 0
    && requestedSessionIsActive === true
  ) {
    return {
      sessionId: requestedSessionId,
      valid: true,
      source: "requested",
    };
  }

  if (
    typeof activeDashboardSessionId === "number"
    && activeDashboardSessionId > 0
  ) {
    return {
      sessionId: activeDashboardSessionId,
      valid: true,
      source: "active",
    };
  }

  return { source: "none" };
}

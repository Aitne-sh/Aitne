import { describe, it, expect } from "vitest";
import { DASHBOARD_ROUTES, dashboardRouteHref } from "./dashboard-routes";

describe("dashboardRouteHref", () => {
  it("accepts a known top-level route", () => {
    expect(dashboardRouteHref("/settings/models")).toBe("/settings/models");
  });

  it("preserves a query string verbatim", () => {
    expect(dashboardRouteHref("/knowledge?tab=upload")).toBe(
      "/knowledge?tab=upload",
    );
    expect(dashboardRouteHref("/setup?mode=update")).toBe("/setup?mode=update");
  });

  it("preserves a hash fragment", () => {
    expect(dashboardRouteHref("/settings/models#advisor")).toBe(
      "/settings/models#advisor",
    );
  });

  it("rejects API endpoints", () => {
    expect(dashboardRouteHref("/api/setup/mode")).toBeNull();
    expect(dashboardRouteHref("/api/health")).toBeNull();
  });

  it("rejects placeholder paths", () => {
    expect(dashboardRouteHref("/connections/...")).toBeNull();
    expect(dashboardRouteHref("/api/integrations/:key")).toBeNull();
  });

  it("rejects unknown routes", () => {
    expect(dashboardRouteHref("/nope")).toBeNull();
    expect(dashboardRouteHref("/settings/nope")).toBeNull();
  });

  it("rejects paths with whitespace", () => {
    expect(dashboardRouteHref("/settings models")).toBeNull();
  });

  it("rejects non-path inputs", () => {
    expect(dashboardRouteHref("")).toBeNull();
    expect(dashboardRouteHref("settings/models")).toBeNull();
    expect(dashboardRouteHref("https://example.com")).toBeNull();
    expect(dashboardRouteHref("// double slash")).toBeNull();
  });

  it("DASHBOARD_ROUTES covers every path used by PAGE_DOC_MAP", () => {
    // Imports kept inline so the helper file has no dependency on the map
    // (the map happens to import the helper too once this lands, and a
    // top-level import here would create a cycle).
    const pagePaths = [
      "/",
      "/chat",
      "/activity",
      "/conversations",
      "/schedule",
      "/knowledge",
      "/reading",
      "/tasks",
      "/analytics",
      "/connections",
      "/connections/calendar",
      "/connections/repositories",
      "/connections/journal",
      "/connections/knowledge",
      "/connections/mail",
      "/connections/mcp",
      "/connections/messaging",
      "/connections/routines",
      "/connections/tasks",
      "/settings",
      "/settings/commands",
      "/settings/connections",
      "/settings/schedule",
      "/settings/routines",
      "/settings/journal",
      "/settings/models",
      "/settings/advanced",
      "/setup",
    ];
    for (const p of pagePaths) {
      expect(DASHBOARD_ROUTES.has(p)).toBe(true);
    }
  });
});

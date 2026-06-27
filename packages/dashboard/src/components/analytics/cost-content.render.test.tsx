import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CostContent, DelegatedProxyAsymmetryFootnote } from "./cost-content";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CostResponse } from "@/lib/api-types";

const mocks = vi.hoisted(() => ({
  useCost: vi.fn(),
  useMetrics: vi.fn(),
  refetch: vi.fn(),
  invokeHandlers: false,
  buttonClickCount: 0,
}));

vi.mock("next/dynamic", () => ({
  default: (
    loader: () => Promise<unknown>,
    options?: { loading?: () => React.ReactElement },
  ) => {
    void loader();
    return function DynamicChartMock(props: { data?: unknown[] }) {
      const Loading = options?.loading;
      return (
        <div data-chart="mock" data-count={props.data?.length ?? 0}>
          {Loading ? <Loading /> : null}
        </div>
      );
    };
  },
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  const ActualButton = actual.Button;
  return {
    ...actual,
    Button: (props: React.ComponentProps<typeof ActualButton>) => {
      if (mocks.invokeHandlers && typeof props.onClick === "function") {
        mocks.buttonClickCount += 1;
        props.onClick({} as React.MouseEvent<HTMLButtonElement>);
      }
      return <ActualButton {...props} />;
    },
  };
});

vi.mock("@/components/shared/query-result", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/shared/query-result")>();
  const ActualQueryResult = actual.QueryResult;
  return {
    ...actual,
    QueryResult: (props: React.ComponentProps<typeof ActualQueryResult>) => {
      if (mocks.invokeHandlers) {
        props.onRetry?.();
      }
      return <ActualQueryResult {...props} />;
    },
  };
});

vi.mock("@/components/cost/cost-trend-chart", () => ({
  CostTrendChart: () => null,
}));
vi.mock("@/components/cost/model-breakdown-chart", () => ({
  ModelBreakdownChart: () => null,
}));
vi.mock("@/components/cost/event-type-chart", () => ({
  EventTypeChart: () => null,
}));
vi.mock("@/components/cost/backend-cost-chart", () => ({
  BackendCostChart: () => null,
}));

vi.mock("@/lib/hooks/use-cost", () => ({
  useCost: mocks.useCost,
}));

vi.mock("@/lib/hooks/use-metrics", () => ({
  useMetrics: mocks.useMetrics,
}));

function costResponse(overrides: Partial<CostResponse> = {}): CostResponse {
  return {
    period: "daily",
    today: { costUsd: 1.2, sessions: 3 },
    byPeriod: [{ period: "2026-06-12", total_cost: 1.2, session_count: 3, total_input_tokens: 100, total_output_tokens: 20 }],
    byModel: [{ model: "claude-haiku-4-5", total_cost: 1.2, session_count: 3 }],
    byEventType: [{ event_type: "routine.activity_scan", total_cost: 1.2, session_count: 3 }],
    byBackend: [
      { backend: "claude", total_cost: 0.8, session_count: 2 },
      { backend: "codex", total_cost: 0.4, session_count: 1 },
    ],
    byBackendPeriod: [
      { period: "2026-06-12", backend: "claude", total_cost: 0.8, session_count: 2 },
      { period: "2026-06-12", backend: "codex", total_cost: 0.4, session_count: 1 },
    ],
    todayBreakdown: {
      topActions: [],
      byEventType: [],
      byTrigger: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      failed: { costUsd: 0, sessions: 0 },
    },
    ...overrides,
  };
}

function renderCostContent(): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <CostContent />
    </TooltipProvider>,
  );
}

describe("CostContent — static render", () => {
  beforeEach(() => {
    mocks.refetch.mockReset();
    mocks.useCost.mockReset();
    mocks.useMetrics.mockReset();
    mocks.invokeHandlers = false;
    mocks.buttonClickCount = 0;
  });

  it("renders populated summaries, spend drivers, charts, and backend totals", () => {
    mocks.useCost.mockReturnValue({
      data: costResponse(),
      isLoading: false,
      isError: false,
      error: null,
      refetch: mocks.refetch,
    });
    mocks.useMetrics.mockReturnValue({
      data: { cost: { last7dUsd: 2.5, last30dUsd: 6.75 } },
    });

    const html = renderCostContent();

    expect(html).toContain("Today");
    expect(html).toContain("$1.20");
    expect(html).toContain("3 sessions");
    expect(html).toContain("$2.50");
    expect(html).toContain("$6.75");
    expect(html).toContain("Most Expensive Runs Today");
    expect(html).toContain("Cost Trend");
    expect(html).toContain("Model Breakdown");
    expect(html).toContain("By Event Type");
    expect(html).toContain("Backend Cost Trend");
    expect(html).toContain("Backend Totals");
    expect(html).toContain("66.7% of selected window");
    expect(html).toContain("Avg $0.40");
  });

  it("renders zero-state summaries and the error branch without cost data", () => {
    mocks.useCost.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("cost unavailable"),
      refetch: mocks.refetch,
    });
    mocks.useMetrics.mockReturnValue({ data: undefined });

    const html = renderCostContent();

    expect(html).toContain("$0.00");
    expect(html).toContain("0 sessions");
    expect(html).toContain("Failed to load data");
    expect(html).toContain("cost unavailable");
    expect(html).not.toContain("Most Expensive Runs Today");
  });

  it("renders no-spend backend copy when selected-window totals are zero", () => {
    mocks.useCost.mockReturnValue({
      data: costResponse({
        today: { costUsd: 0, sessions: 0 },
        byPeriod: [],
        byModel: [],
        byEventType: [],
        byBackend: [],
        byBackendPeriod: [],
      }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: mocks.refetch,
    });
    mocks.useMetrics.mockReturnValue({ data: undefined });

    const html = renderCostContent();

    expect(html).toContain("No spend in selected window");
    expect(html).toContain("Avg $0.00");
  });

  it("renders skeleton cards while the first cost request is loading", () => {
    mocks.useCost.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: mocks.refetch,
    });
    mocks.useMetrics.mockReturnValue({ data: undefined });

    const html = renderCostContent();

    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Cost Trend");
  });

  it("wires period buttons and retry handler callbacks", () => {
    mocks.invokeHandlers = true;
    mocks.useCost.mockReturnValue({
      data: costResponse(),
      isLoading: false,
      isError: false,
      error: null,
      refetch: mocks.refetch,
    });
    mocks.useMetrics.mockReturnValue({ data: undefined });

    renderCostContent();

    expect(mocks.buttonClickCount).toBeGreaterThanOrEqual(3);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * DELEGATED-MODE-V2-DESIGN.md §7.2 — verbatim US-English contract
 * (Decision Log #11). The footnote sets user expectations that
 * same-backend native MCP traffic does not appear in delegated-proxy
 * telemetry; rewording would mislead users into reading "no rows" as
 * "no usage." Asserting load-bearing phrases keeps the contract from
 * drifting silently.
 */
describe("DelegatedProxyAsymmetryFootnote — §7.2 literal-copy contract", () => {
  it("includes the 'cross-backend' qualifier and the 'skip the proxy' clause", () => {
    const html = renderToStaticMarkup(<DelegatedProxyAsymmetryFootnote />);
    expect(html).toContain("cross-backend");
    expect(html).toContain("delegated-proxy telemetry");
    expect(html).toContain("skip the proxy");
    expect(html).toContain("parent session");
    expect(html).toContain("Per-tool cost isn");
  });

  it("uses Codex as the worked example so a Codex DM × Codex Gmail user recognizes their own setup", () => {
    const html = renderToStaticMarkup(<DelegatedProxyAsymmetryFootnote />);
    expect(html).toContain("Codex DM");
    expect(html).toContain("Codex");
  });
});

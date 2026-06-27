import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TodayDrivers } from "./today-drivers";
import type { EventRow, TodayBreakdown } from "@/lib/api-types";

const handlerMocks = vi.hoisted(() => ({
  invokeHandlers: false,
  rowClickCount: 0,
  closeCount: 0,
}));

vi.mock("@/components/logs/event-row", () => ({
  EventRow: ({
    event,
    onClick,
  }: {
    event: EventRow;
    onClick: () => void;
  }) => {
    if (handlerMocks.invokeHandlers) {
      handlerMocks.rowClickCount += 1;
      onClick();
    }
    return (
      <tr>
        <td>{event.action_type}</td>
        <td>{event.trigger}</td>
        <td>{`$${(event.cost_usd ?? 0).toFixed(2)}`}</td>
      </tr>
    );
  },
}));

vi.mock("@/components/logs/event-detail-sheet", () => ({
  EventDetailSheet: ({ onClose }: { event: EventRow | null; onClose: () => void }) => {
    if (handlerMocks.invokeHandlers) {
      handlerMocks.closeCount += 1;
      onClose();
    }
    return <div data-testid="event-detail-sheet" />;
  },
}));

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

function makeAction(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    event_id: "evt-1",
    action_type: "routine.fetch_window",
    trigger: "autonomous",
    model_used: "claude-haiku-4-5",
    model_usage_json: null,
    cost_usd: 0.8,
    tokens_input: 100,
    tokens_output: 50,
    cache_creation_tokens: 2000,
    cache_read_tokens: 40000,
    duration_ms: 32000,
    num_turns: 4,
    result: "success",
    detail: null,
    started_at: "2026-06-12 01:00:00",
    completed_at: "2026-06-12 01:00:32",
    error: null,
    ...overrides,
  };
}

const BREAKDOWN: TodayBreakdown = {
  topActions: [
    makeAction(),
    makeAction({ id: 2, action_type: "message.dm", trigger: "reactive", cost_usd: 0.3 }),
  ],
  byEventType: [
    { event_type: "routine.fetch_window", total_cost: 0.8, session_count: 1 },
    { event_type: "message.dm", total_cost: 0.3, session_count: 1 },
  ],
  byTrigger: [
    { trigger: "autonomous", total_cost: 0.8, session_count: 1 },
    { trigger: "reactive", total_cost: 0.3, session_count: 1 },
  ],
  tokens: { input: 300, output: 150, cacheRead: 48000, cacheCreation: 3000 },
  failed: { costUsd: 0.1, sessions: 1 },
};

const EMPTY_BREAKDOWN: TodayBreakdown = {
  topActions: [],
  byEventType: [],
  byTrigger: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  failed: { costUsd: 0, sessions: 0 },
};

describe("TodayDrivers — static-markup smoke", () => {
  beforeEach(() => {
    handlerMocks.invokeHandlers = false;
    handlerMocks.rowClickCount = 0;
    handlerMocks.closeCount = 0;
  });

  it("renders the runs table, process shares, and glance stats from a populated day", () => {
    const html = render(
      <TodayDrivers breakdown={BREAKDOWN} todayCostUsd={1.1} todaySessions={2} />,
    );
    expect(html).toContain("Most Expensive Runs Today");
    // Runs table reuses EventRow — process name and cost render per row.
    expect(html).toContain("routine.fetch_window");
    expect(html).toContain("$0.80");
    // Process panel shows share-of-today.
    expect(html).toContain("By Process Today");
    expect(html).toContain("73% of today");
    // Glance stats: cache hit rate 48000/(300+3000+48000) ≈ 94%,
    // autonomous share 0.8/1.1 ≈ 73%, failed spend styled as destructive.
    expect(html).toContain("Today at a Glance");
    expect(html).toContain("94%");
    expect(html).toContain("text-destructive");
    expect(html).toContain("1 failed run");
  });

  it("renders plural run labels for multi-run process and failure rows", () => {
    const html = render(
      <TodayDrivers
        breakdown={{
          ...BREAKDOWN,
          byEventType: [
            { event_type: "routine.fetch_window", total_cost: 0.8, session_count: 2 },
          ],
          failed: { costUsd: 0.2, sessions: 2 },
        }}
        todayCostUsd={1.0}
        todaySessions={3}
      />,
    );
    expect(html).toContain("2 runs");
    expect(html).toContain("2 failed runs");
  });

  it("renders empty states instead of an empty table when nothing ran yet", () => {
    const html = render(
      <TodayDrivers breakdown={EMPTY_BREAKDOWN} todayCostUsd={0} todaySessions={0} />,
    );
    expect(html).toContain("No spend recorded today yet.");
    expect(html).not.toContain("<table");
    // Unavailable ratios render as em dashes, not 0% or NaN.
    expect(html).toContain("—");
    expect(html).not.toContain("NaN");
  });

  it("wires row open and detail close handlers", () => {
    handlerMocks.invokeHandlers = true;
    render(
      <TodayDrivers breakdown={BREAKDOWN} todayCostUsd={1.1} todaySessions={2} />,
    );
    expect(handlerMocks.rowClickCount).toBe(BREAKDOWN.topActions.length);
    expect(handlerMocks.closeCount).toBe(1);
  });
});

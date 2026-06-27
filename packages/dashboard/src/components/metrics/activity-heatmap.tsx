"use client";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { MetricsHeatmapDay } from "@/lib/api-types";

interface ActivityHeatmapProps {
  data: MetricsHeatmapDay[];
}

/** Build a 7-row × N-col grid covering the last 12 weeks */
function buildGrid(data: MetricsHeatmapDay[]) {
  const countMap = new Map(data.map((d) => [d.date, d.count]));
  const today = new Date();
  // Start from 83 days ago (12 weeks = 84 days including today)
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 83);
  // Align to Monday
  const startDow = startDate.getDay();
  const mondayOffset = startDow === 0 ? -6 : 1 - startDow;
  startDate.setDate(startDate.getDate() + mondayOffset);

  const days: Array<{ date: string; count: number; dow: number; week: number }> = [];
  const cursor = new Date(startDate);
  let week = 0;
  let prevWeekNum = -1;

  while (cursor <= today) {
    const isoDate = cursor.toISOString().slice(0, 10);
    const dow = cursor.getDay() === 0 ? 6 : cursor.getDay() - 1; // Mon=0..Sun=6
    const weekNum = Math.floor(
      (cursor.getTime() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
    if (weekNum !== prevWeekNum) {
      week = weekNum;
      prevWeekNum = weekNum;
    }
    days.push({ date: isoDate, count: countMap.get(isoDate) ?? 0, dow, week });
    cursor.setDate(cursor.getDate() + 1);
  }

  const numWeeks = week + 1;
  return { days, numWeeks };
}

function cellColor(count: number, max: number): string {
  if (count === 0) return "bg-muted/40";
  const ratio = count / max;
  if (ratio <= 0.25) return "bg-success/25";
  if (ratio <= 0.5) return "bg-success/50";
  if (ratio <= 0.75) return "bg-success/75";
  return "bg-success";
}

const DOW_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

export function ActivityHeatmap({ data }: ActivityHeatmapProps) {
  const { days, numWeeks } = buildGrid(data);
  const maxCount = Math.max(...days.map((d) => d.count), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <span className="text-xs text-muted-foreground">
          Last 12 weeks · fixed range (does not follow period selector)
        </span>
      </CardHeader>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {/* Day-of-week labels */}
        <div className="flex flex-col gap-[3px] pt-0">
          {DOW_LABELS.map((label, i) => (
            <div
              key={i}
              className="flex h-[13px] w-6 items-center text-[10px] text-muted-foreground"
            >
              {label}
            </div>
          ))}
        </div>
        {/* Heatmap grid */}
        <div
          className="grid gap-[3px]"
          style={{
            gridTemplateColumns: `repeat(${numWeeks}, 13px)`,
            gridTemplateRows: "repeat(7, 13px)",
            gridAutoFlow: "column",
          }}
        >
          {days.map((day) => (
            <Tooltip key={day.date} delayDuration={0}>
              <TooltipTrigger asChild>
                <div
                  className={`h-[13px] w-[13px] rounded-[2px] ${cellColor(day.count, maxCount)}`}
                />
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                <span className="font-medium">{day.count}</span> execution{day.count !== 1 ? "s" : ""} on {day.date}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
      {/* Legend */}
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span>Less</span>
        <div className="h-[10px] w-[10px] rounded-[2px] bg-muted/40" />
        <div className="h-[10px] w-[10px] rounded-[2px] bg-success/25" />
        <div className="h-[10px] w-[10px] rounded-[2px] bg-success/50" />
        <div className="h-[10px] w-[10px] rounded-[2px] bg-success/75" />
        <div className="h-[10px] w-[10px] rounded-[2px] bg-success" />
        <span>More</span>
      </div>
    </Card>
  );
}

"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface EventFiltersProps {
  type: string;
  onTypeChange: (v: string) => void;
  result: string;
  onResultChange: (v: string) => void;
  dateRange: string;
  onDateRangeChange: (v: string) => void;
  live: boolean;
  onLiveToggle: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}

const EVENT_TYPES = [
  "all",
  "message.received",
  "routine.morning_routine",
  "routine.evening_review",
  "scheduled.task",
  "schedule.approaching",
];

const RESULTS = ["all", "success", "failed", "partial", "skipped"];
const DATE_RANGES = [
  { label: "Today", value: "today" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
];

export function EventFilters(props: EventFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Filters */}
      <Select value={props.type} onValueChange={props.onTypeChange}>
        <SelectTrigger className="w-48">
          <SelectValue placeholder="Event Type" />
        </SelectTrigger>
        <SelectContent>
          {EVENT_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t === "all" ? "All Types" : t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={props.result} onValueChange={props.onResultChange}>
        <SelectTrigger className="w-32">
          <SelectValue placeholder="Result" />
        </SelectTrigger>
        <SelectContent>
          {RESULTS.map((r) => (
            <SelectItem key={r} value={r}>
              {r === "all" ? "All Results" : r}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Separator orientation="vertical" className="h-6" />

      {/* Time range */}
      <div className="flex gap-1">
        {DATE_RANGES.map((d) => (
          <Button
            key={d.value}
            variant={props.dateRange === d.value ? "default" : "outline"}
            size="sm"
            onClick={() => props.onDateRangeChange(d.value)}
          >
            {d.label}
          </Button>
        ))}
      </div>

      <Separator orientation="vertical" className="h-6" />

      {/* Mode */}
      <button
        onClick={props.onLiveToggle}
        className={cn(
          "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
          props.live
            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : "bg-muted text-muted-foreground",
        )}
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            props.live ? "bg-emerald-500 animate-pulse" : "bg-gray-400",
          )}
        />
        Live
      </button>

      <Button
        variant="outline"
        size="sm"
        onClick={props.onRefresh}
        disabled={props.isRefreshing}
        aria-label="Refresh events"
        title="Refresh events"
      >
        <RefreshCw
          className={cn("h-3.5 w-3.5", props.isRefreshing && "animate-spin")}
        />
        <span className="ml-1.5">Refresh</span>
      </Button>
    </div>
  );
}

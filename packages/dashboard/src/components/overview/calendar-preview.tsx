"use client";

import { CalendarDays, Bot } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useCalendarEvents } from "@/lib/hooks/use-calendar";
import { useHealth } from "@/lib/hooks/use-health";
import { useRegenerate } from "@/lib/hooks/use-regenerate";
import { RegenerateButton } from "@/components/regenerate-button";
import { format } from "date-fns";
import { parseUtcDate } from "@/lib/utils";

export function CalendarPreview() {
  const { data } = useCalendarEvents();
  const { data: health } = useHealth();
  const { regenerate, target, status, error, dismiss } = useRegenerate();
  const events = data?.events ?? [];

  const calendarDelegated =
    health?.integrationModes?.google_calendar?.mode === "delegated";

  if (calendarDelegated) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Today&apos;s Calendar</CardTitle>
        </CardHeader>
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <Bot className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Calendar is delegated to the agent&apos;s backend connector — ask the
            agent directly for today&apos;s schedule. The daemon doesn&apos;t poll
            events while in delegated mode.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between w-full">
          <CardTitle>Today&apos;s Calendar</CardTitle>
          <RegenerateButton
            target="today"
            label="Refresh"
            currentTarget={target}
            status={status}
            error={error}
            onRegenerate={regenerate}
            onDismiss={dismiss}
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
          />
        </div>
      </CardHeader>
      <div className="space-y-2">
        {events.length === 0 && (
          <p className="text-sm text-muted-foreground">No events today</p>
        )}
        {events.map((event) => (
          <div key={event.id} className="flex items-start gap-3 text-sm">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {event.allDay
                ? "All day"
                : `${format(parseUtcDate(event.start), "HH:mm")}–${format(parseUtcDate(event.end), "HH:mm")}`}
            </span>
            <span className="text-foreground">{event.summary}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

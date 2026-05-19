"use client";

import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GoogleCard } from "@/components/connections/google-card";
import { IntegrationCard } from "@/components/connections/integration-card";
import { useHealth } from "@/lib/hooks/use-health";
import { WizardStepFrame } from "./wizard-step-frame";

/**
 * SETUP-FLOW-REDESIGN-PLAN §5.5 — Calendar wizard step.
 *
 * Renders the registry-driven `IntegrationCard` for Google Calendar and
 * Outlook Calendar back-to-back. Mode toggles + per-mode disclosures
 * (OAuth, calendar-id picker) are owned by `IntegrationCard`; this
 * component is just the page chrome, the cards, and the nav buttons.
 *
 * Skip is first-class: Calendar is optional input. Continue advances
 * unconditionally — soft-warning state is surfaced inside each card.
 *
 * When Google Calendar is in direct mode the wizard renders the same
 * `GoogleCard` used on `/connections/calendar` so OAuth completes
 * inside the wizard rather than navigating the user out.
 */
interface CalendarStepProps {
  onNext: () => void;
  onBack?: () => void;
}

export function CalendarStep({ onNext, onBack }: CalendarStepProps) {
  const health = useHealth();
  const calendarMode =
    health.data?.integrationModes?.google_calendar?.mode ?? "disabled";
  const showGoogleAuth = calendarMode === "direct";

  return (
    <WizardStepFrame
      title="Calendar"
      description="Connect the calendars the agent should track. Skip if you don't use one."
      onNext={onNext}
      onBack={onBack}
      skipLabel="Skip"
      nextLabel="Continue"
    >
      <div className="w-full max-w-2xl mx-auto space-y-4">
        <IntegrationCard integrationKey="google_calendar" />
        {showGoogleAuth && <GoogleCard />}
        <IntegrationCard integrationKey="outlook_calendar" />
        <p className="text-xs text-muted-foreground text-center">
          Outlook Calendar reuses the OAuth grant from Outlook Mail —
          connecting Mail first means no second consent screen here. Apple
          Calendar can be added later from Connections → Calendar.
        </p>
      </div>
    </WizardStepFrame>
  );
}

// Re-export for symmetry with other step files.
export { ArrowRight, Button };

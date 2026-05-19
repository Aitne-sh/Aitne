"use client";

import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";

interface WizardStepFrameProps {
  /** Step heading. */
  title: string;
  /** Short description shown below the heading. */
  description?: string;
  /** The settings component(s) rendered inside the frame. */
  children: ReactNode;
  /** Called when the user advances to the next step. */
  onNext: () => void;
  /** Called when the user goes back to the previous step. Omit to hide the back button. */
  onBack?: () => void;
  /** Label for the skip button. Omit to hide skip entirely. */
  skipLabel?: string;
  /** Label for the next button. Defaults to "Next". */
  nextLabel?: string;
  /** Disable the next button (e.g. while a required action hasn't completed). */
  nextDisabled?: boolean;
  /** Hide both navigation buttons (for steps that manage their own flow). */
  hideNav?: boolean;
  /** Override the default max-w-lg container width (e.g. "max-w-3xl"). */
  maxWidth?: string;
}

/**
 * Consistent wizard chrome for setup steps that wrap settings components.
 *
 * Provides: centred title + description, content slot, skip / next buttons.
 * The progress stepper is owned by the parent page — not duplicated here.
 */
export function WizardStepFrame({
  title,
  description,
  children,
  onNext,
  onBack,
  skipLabel = "Set Up Later",
  nextLabel = "Next",
  nextDisabled = false,
  hideNav = false,
  maxWidth,
}: WizardStepFrameProps) {
  return (
    <div className={`mx-auto ${maxWidth ?? "max-w-lg"} space-y-6 py-8`}>
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      {children}

      {!hideNav && (
        <div className="flex justify-between pt-4">
          <div className="flex gap-2">
            {onBack ? (
              <Button
                variant="ghost"
                onClick={onBack}
                className="gap-2 text-muted-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
            ) : null}
            {skipLabel ? (
              <Button
                variant="ghost"
                onClick={onNext}
                className="gap-2 text-muted-foreground"
              >
                <SkipForward className="h-4 w-4" />
                {skipLabel}
              </Button>
            ) : null}
            {!onBack && !skipLabel ? <div /> : null}
          </div>
          <Button
            onClick={onNext}
            className="gap-2"
            disabled={nextDisabled}
          >
            {nextLabel}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

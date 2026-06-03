"use client";

import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { buildStopWarningView } from "@/lib/agents/stop-warning";
import type { StopWarning } from "@/lib/agents/types";

/**
 * Stop-warning confirmation modal (AGENT_DEFINITIONS_DESIGN.md §10.3). Renders
 * ONLY the strings carried in the Agent's `stop_warning` payload — the
 * consequences are never hardcoded. `buildStopWarningView` (unit-tested) shapes
 * the payload and decides the tone; this component is a dumb renderer.
 *
 * Confirm posts `PATCH /api/agents/<slug> { enabled:false, ack_warning:true }`
 * (the caller wires `onConfirm`). When the payload is absent (a user Agent with
 * no declared warning) it falls back to a generic confirm.
 */
export interface StopWarningModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  warning: StopWarning | null;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
}

export function StopWarningModal({
  open,
  onOpenChange,
  agentName,
  warning,
  onConfirm,
  pending = false,
  error = null,
}: StopWarningModalProps) {
  const view = buildStopWarningView(warning);
  const alertVariant = view?.tone === "warning" ? "warning" : "error";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Stop {agentName}?
          </DialogTitle>
          <DialogDescription>
            This will stop the Agent from firing on its schedule. You can re-enable it at any time.
          </DialogDescription>
        </DialogHeader>

        {view ? (
          <div className="space-y-3 text-sm">
            <Alert variant={alertVariant}>
              <p className="font-medium">
                {view.levelLabel}: stopping this Agent will halt:
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {view.servicesLost.map((service) => (
                  <li key={service}>{service}</li>
                ))}
              </ul>
            </Alert>

            {view.dependentAgents.length > 0 && (
              <div className="text-muted-foreground">
                <p className="font-medium text-foreground">
                  Dependent Agents may produce incomplete output:
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {view.dependentAgents.map((dep) => (
                    <li key={dep}>{dep}</li>
                  ))}
                </ul>
              </div>
            )}

            {view.reactivationHint && (
              <p className="text-xs text-muted-foreground">{view.reactivationHint}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Are you sure you want to stop <span className="font-medium text-foreground">{agentName}</span>?
          </p>
        )}

        {error && (
          <Alert variant="error" className="mt-1">
            {error}
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? "Stopping…" : "Yes, stop"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

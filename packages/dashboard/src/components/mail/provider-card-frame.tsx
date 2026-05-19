"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Alert } from "@/components/ui/alert";
import type { CardStatus } from "./types";
import { STATUS_BADGE } from "./types";

export interface ProviderCardFrameProps {
  name: string;
  description: ReactNode;
  status: CardStatus;
  /** Connect / setup section (inputs + auth buttons). */
  setupSection: ReactNode;
  /** List of authenticated accounts; empty fragment if none. */
  accountsSection?: ReactNode;
  /**
   * Per-provider Enable toggle. Disabled (with tooltip) until at least one
   * account is authenticated. Passing `disabledReason` shows a hint below.
   */
  enableToggle: {
    enabled: boolean;
    disabled: boolean;
    disabledReason?: string;
    busy?: boolean;
    onChange: (next: boolean) => void | Promise<void>;
    explainer?: ReactNode;
  };
}

export function ProviderCardFrame(props: ProviderCardFrameProps) {
  const badge = STATUS_BADGE[props.status];
  const cardTone =
    props.status === "attention"
      ? "warning"
      : props.status === "enabled"
        ? "success"
        : "default";

  return (
    <Card tone={cardTone}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
          <h3 className="text-base font-semibold text-foreground truncate">
            {props.name}
          </h3>
        </div>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{props.description}</p>

      <div className="mt-3 space-y-3">{props.setupSection}</div>

      {props.accountsSection && (
        <>
          <Separator className="my-4" />
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Authenticated accounts
          </h4>
          <div className="space-y-2">{props.accountsSection}</div>
        </>
      )}

      <Separator className="my-4" />
      <EnableToggleRow toggle={props.enableToggle} />
    </Card>
  );
}

function EnableToggleRow({
  toggle,
}: {
  toggle: ProviderCardFrameProps["enableToggle"];
}) {
  const [error, setError] = useState<string | null>(null);

  const onChange = async (next: boolean) => {
    setError(null);
    try {
      await toggle.onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    }
  };

  return (
    <div>
      <label
        className={
          "flex items-center gap-2 text-sm select-none " +
          (toggle.disabled || toggle.busy
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer")
        }
        title={toggle.disabled ? toggle.disabledReason : undefined}
      >
        <input
          type="checkbox"
          checked={toggle.enabled}
          disabled={toggle.disabled || toggle.busy}
          onChange={(e) => void onChange(e.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        <span className="font-medium text-foreground">
          Enable for the agent
        </span>
        {toggle.busy && (
          <span className="text-xs text-muted-foreground">saving…</span>
        )}
      </label>
      {toggle.disabled && toggle.disabledReason && (
        <p className="mt-1 ml-6 text-xs text-muted-foreground">
          {toggle.disabledReason}
        </p>
      )}
      {!toggle.disabled && toggle.explainer && (
        <p className="mt-1 ml-6 text-xs text-muted-foreground">
          {toggle.explainer}
        </p>
      )}
      {error && (
        <Alert variant="error" className="mt-2">
          {error}
        </Alert>
      )}
    </div>
  );
}

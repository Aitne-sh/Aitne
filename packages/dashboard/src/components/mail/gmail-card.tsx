"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { AccountRow } from "./account-row";
import { ProviderCardFrame } from "./provider-card-frame";
import { deriveCardStatus } from "./types";
import type { MailAccount, MailProviderKind } from "./types";
import { toggleProviderEnabled, useInvalidateMail } from "./use-mail-data";

interface GmailCardProps {
  accounts: MailAccount[];
  enabledKinds: MailProviderKind[];
  /** Account id to scroll into view (from /connections/mail#<id>). */
  focusAccountId?: string | null;
  /**
   * When true, suppress the cross-page "Open Google connection" link in the
   * empty / connected setup helpers. The setup wizard renders the
   * `GoogleCard` directly below this card so OAuth happens in-place; the
   * link would otherwise navigate the user out of an incomplete wizard.
   */
  hideExternalGoogleLink?: boolean;
}

export function GmailCard({
  accounts,
  enabledKinds,
  focusAccountId,
  hideExternalGoogleLink = false,
}: GmailCardProps) {
  const invalidate = useInvalidateMail();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const enabled = enabledKinds.includes("gmail");
  const status = deriveCardStatus({ accounts, enabled });

  const setEnabled = async (next: boolean) => {
    // Disabling Gmail is special: it gates the unified mail-poller for every
    // Gmail account, which in turn drives the receipts / travel / Kindle
    // classifiers. Confirm so a "just turning this off for a moment" click
    // doesn't silently shut down half the agent's classifier surface.
    if (!next) {
      const ok = await confirm({
        title: "Disable Gmail for the agent?",
        description:
          "This stops the unified mail poller from observing Gmail — receipts, travel bookings, and Kindle highlights will not be classified until you re-enable Gmail. Tokens stay in the keychain and the integration resumes the moment you flip the switch back on.",
        confirmLabel: "Disable Gmail",
        variant: "destructive",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await toggleProviderEnabled(enabledKinds, "gmail", next);
      invalidate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProviderCardFrame
      name="Gmail / Google Workspace"
      description={
        <>
          Authenticated through your existing Google connection (it is shared
          with Calendar). Manage Google OAuth on the Connections page.
        </>
      }
      status={status}
      setupSection={
        accounts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-3 text-xs">
            <p className="text-foreground font-medium mb-1">
              No Gmail account connected yet.
            </p>
            <p className="text-muted-foreground mb-2">
              {hideExternalGoogleLink
                ? "Switch the Mode above to Direct and complete the Google connection step on this page — the daemon detects your Gmail address from the OAuth response and registers it here."
                : "Authenticate Google in Connections — the daemon detects your Gmail address from the OAuth response and registers it here."}
            </p>
            {!hideExternalGoogleLink && (
              <Link href="/connections/calendar#google">
                <Button size="sm" variant="outline" className="h-7 text-xs px-3">
                  Open Google connection
                  <ExternalLink className="ml-1 h-3 w-3" />
                </Button>
              </Link>
            )}
          </div>
        ) : hideExternalGoogleLink ? (
          // In setup mode the GoogleCard is rendered directly below this card
          // (and only when Gmail mode === direct). Pointing at "the panel
          // below" would lie when the mode is delegated/disabled. The
          // GoogleCard itself carries its own re-auth / re-scope affordances
          // when shown, so no extra pointer is needed here.
          null
        ) : (
          <p className="text-xs text-muted-foreground">
            Re-authentication, scope changes, or revoking access live on the{" "}
            <Link
              href="/connections/calendar#google"
              className="underline underline-offset-2"
            >
              Google connection card
            </Link>
            .
          </p>
        )
      }
      accountsSection={
        accounts.length > 0
          ? accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                highlight={focusAccountId === a.id}
                hideActive
                hideHealth
                isLastOfKind={accounts.length === 1}
                onAfterRemove={async () => {
                  if (accounts.length === 1 && enabled) {
                    await toggleProviderEnabled(enabledKinds, "gmail", false);
                  }
                }}
              />
            ))
          : undefined
      }
      enableToggle={{
        enabled,
        disabled: accounts.length === 0,
        disabledReason:
          accounts.length === 0
            ? "Connect a Google account first."
            : undefined,
        busy,
        onChange: setEnabled,
        explainer:
          "When enabled, the legacy Gmail poller observes your inbox and the agent can read, draft, and send messages.",
      }}
    />
  );
}

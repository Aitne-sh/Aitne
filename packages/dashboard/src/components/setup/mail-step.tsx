"use client";

import { GmailCard } from "@/components/mail/gmail-card";
import { OutlookCard } from "@/components/mail/outlook-card";
import { ImapCard } from "@/components/mail/imap-card";
import { GoogleCard } from "@/components/connections/google-card";
import { IntegrationCard } from "@/components/connections/integration-card";
import { useHealth } from "@/lib/hooks/use-health";
import {
  useMailAccounts,
  useMailProviders,
} from "@/components/mail/use-mail-data";
import type { MailAccount, MailProviderKind } from "@/components/mail/types";
import { WizardStepFrame } from "./wizard-step-frame";

/**
 * SETUP-FLOW-REDESIGN-PLAN §5.4 — Mail step.
 *
 * Each provider stacks the registry-driven `IntegrationCard` (mode
 * toggle + delegated/native backend picker) on top of the auth card
 * (GmailCard / OutlookCard) so the wizard exposes the same decisions
 * as `/connections/mail`. Outlook's descriptor declares the full mode
 * tuple (`direct` / `delegated` / `native` / `disabled`) with
 * `userManagedConnector: true`, so the IntegrationCard renders a
 * "register an Outlook MCP on the chosen backend" notice for both
 * delegated and native — INTEGRATION_NATIVE_MODE_DESIGN.md §5.3
 * IMAP has no delegated/native path (no
 * integration key in the registry); the IMAP cards stay auth-only.
 *
 * Direct-mode Gmail needs a Google OAuth credential. The wizard
 * embeds the same `GoogleCard` used on `/connections/calendar` here
 * so the user can complete OAuth without navigating out of an
 * incomplete wizard. The card is suppressed when Gmail is not in
 * direct mode (no credentials needed for delegated / native / disabled).
 */
interface MailStepProps {
  onNext: () => void;
  onBack?: () => void;
}

export function MailStep({ onNext, onBack }: MailStepProps) {
  const accountsQuery = useMailAccounts();
  const providersQuery = useMailProviders();
  const health = useHealth();

  const accounts = accountsQuery.data?.accounts ?? [];
  const enabledKinds = providersQuery.data?.enabledKinds ?? [];
  const grouped = groupByKind(accounts);

  // Only show the GoogleCard when Gmail's mode requires OAuth (direct).
  // In delegated mode, auth lives in the backend's connector store, not
  // the daemon keychain; in disabled mode there is no auth to configure.
  const gmailMode = health.data?.integrationModes?.gmail?.mode ?? "disabled";
  const showGoogleAuth = gmailMode === "direct";

  return (
    <WizardStepFrame
      title="Mail"
      description="Connect the mail accounts the agent should watch. Skip what you don't use — accounts can be added or removed later from Connections → Mail."
      onNext={onNext}
      onBack={onBack}
      skipLabel="Skip"
      maxWidth="max-w-2xl"
    >
      <IntegrationCard
        integrationKey="gmail"
        gmailAccountCount={grouped.gmail.length}
      />
      <GmailCard
        accounts={grouped.gmail}
        enabledKinds={enabledKinds}
        hideExternalGoogleLink
      />
      {showGoogleAuth && <GoogleCard />}
      <IntegrationCard integrationKey="outlook_mail" />
      <OutlookCard accounts={grouped.outlook} enabledKinds={enabledKinds} />
      <ImapCard
        kind="yahoo"
        accounts={grouped.yahoo}
        enabledKinds={enabledKinds}
      />
      <ImapCard
        kind="icloud"
        accounts={grouped.icloud}
        enabledKinds={enabledKinds}
      />
    </WizardStepFrame>
  );
}

function groupByKind(
  accounts: MailAccount[],
): Record<MailProviderKind, MailAccount[]> {
  const out: Record<MailProviderKind, MailAccount[]> = {
    gmail: [],
    outlook: [],
    yahoo: [],
    icloud: [],
  };
  for (const a of accounts) out[a.kind].push(a);
  return out;
}

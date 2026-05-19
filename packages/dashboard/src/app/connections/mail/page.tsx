"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { GmailCard } from "@/components/mail/gmail-card";
import { OutlookCard } from "@/components/mail/outlook-card";
import { ImapCard } from "@/components/mail/imap-card";
import {
  useMailAccounts,
  useMailProviders,
} from "@/components/mail/use-mail-data";
import type { MailAccount, MailProviderKind } from "@/components/mail/types";
import { ConnectionsSectionHeader } from "@/components/connections/section-header";
import { IntegrationCard } from "@/components/connections/integration-card";
import { ProcessModelCard } from "@/components/connections/process-model-card";

export default function MailConnectionsPage() {
  const accountsQuery = useMailAccounts();
  const providersQuery = useMailProviders();
  const focusAccountId = useAccountIdFromHash();

  const accounts = accountsQuery.data?.accounts ?? [];
  const enabledKinds = providersQuery.data?.enabledKinds ?? [];

  const grouped = groupByKind(accounts);

  const loading = accountsQuery.isLoading || providersQuery.isLoading;
  const loadError = accountsQuery.error ?? providersQuery.error;

  const healthyAccountCount = accounts.filter(
    (a) => a.active && enabledKinds.includes(a.kind),
  ).length;

  return (
    <>
      <ConnectionsSectionHeader
        title="Mail"
        description="Connect each mail provider in two steps: authenticate, then flip the provider's enable switch. Once enabled, the per-account Active toggle lets you mute a single mailbox without disabling the whole provider."
        healthy={healthyAccountCount}
        total={accounts.length}
      />

      {loadError && (
        <Alert variant="error">
          Couldn&apos;t load mail data:{" "}
          {loadError instanceof Error ? loadError.message : "unknown error"}
        </Alert>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          <IntegrationCard
            integrationKey="gmail"
            gmailAccountCount={grouped.gmail.length}
          />
          <ProcessModelCard
            processKey="gmail_classify"
            title="Gmail Classification Model"
            description="Classifies each incoming Gmail message and decides how the agent should respond. Light-tier (Haiku 4.5 / gpt-5.4-mini) handles this well at low cost."
          />
          <GmailCard
            accounts={grouped.gmail}
            enabledKinds={enabledKinds}
            focusAccountId={focusAccountId}
          />
          {/* SETUP-FLOW-REDESIGN-PLAN §6.1 — Outlook gains a registry-
              driven IntegrationCard alongside the existing OutlookCard
              auth UI. The descriptor's `supportedModes: ["direct",
              "disabled"]` means the Delegated radio is suppressed
              automatically. */}
          <IntegrationCard integrationKey="outlook_mail" />
          <OutlookCard
            accounts={grouped.outlook}
            enabledKinds={enabledKinds}
            focusAccountId={focusAccountId}
          />
          <ImapCard
            kind="yahoo"
            accounts={grouped.yahoo}
            enabledKinds={enabledKinds}
            focusAccountId={focusAccountId}
          />
          <ImapCard
            kind="icloud"
            accounts={grouped.icloud}
            enabledKinds={enabledKinds}
            focusAccountId={focusAccountId}
          />
        </div>
      )}
    </>
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

/** Read `#accountId` from the URL — the re-consent DM deep-links here. */
function useAccountIdFromHash(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const pickup = () => {
      const h = window.location.hash.replace(/^#/, "");
      setId(h.length > 0 ? h : null);
    };
    pickup();
    window.addEventListener("hashchange", pickup);
    return () => window.removeEventListener("hashchange", pickup);
  }, []);
  return id;
}

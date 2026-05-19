"use client";

import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { APP_NAME } from "@aitne/shared";
import { api } from "@/lib/api-client";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccountRow } from "./account-row";
import { ProviderCardFrame } from "./provider-card-frame";
import { deriveCardStatus } from "./types";
import type { MailAccount, MailProviderKind } from "./types";
import { toggleProviderEnabled, useInvalidateMail } from "./use-mail-data";

type ImapKind = "yahoo" | "icloud";

interface ProviderCopy {
  name: string;
  description: string;
  setupUrl: string;
  setupLabel: string;
  passwordLabel: string;
  defaultDomain: string;
  /** Per-provider numbered instructions for generating an app password.
   *  Rendered as an <ol>; each entry is one list item. */
  passwordSteps: ReactNode[];
  /** Short one-liner shown beside the password field. */
  passwordHint: string;
  /** 2FA / prerequisite note shown above the numbered steps. */
  prerequisite: string;
}

const COPY: Record<ImapKind, ProviderCopy> = {
  yahoo: {
    name: "Yahoo Mail",
    description:
      "App-password login over IMAP/SMTP. Generate the password in Yahoo Account Security, paste it once, and the daemon stores it in the OS keychain.",
    setupUrl: "https://login.yahoo.com/account/security",
    setupLabel: "Yahoo Account Security",
    passwordLabel: "Yahoo app password",
    defaultDomain: "yahoo.com",
    prerequisite:
      "Yahoo requires two-step verification on the account before it lets you create app passwords. If you haven't enabled it yet, turn it on first from the same Account Security page.",
    passwordSteps: [
      <>
        Open the{" "}
        <strong>Yahoo Account Security</strong> page and sign in with the
        Yahoo account you want to connect.
      </>,
      <>
        Scroll to <strong>Other ways to sign in</strong> and click{" "}
        <strong>Generate and manage app passwords</strong>. (If the link is
        missing, enable two-step verification first.)
      </>,
      <>
        In the <em>App name</em> field type <code>{APP_NAME}</code> (any
        name works; this is just a label Yahoo shows in your account), then
        click <strong>Generate password</strong>.
      </>,
      <>
        Yahoo shows a 16-character password with spaces. Copy it exactly as
        shown — <strong>do not type it by hand</strong>. Spaces are part of
        the password.
      </>,
      <>Paste it into the password field below, then click Authenticate.</>,
    ],
    passwordHint:
      "16 characters from Yahoo, spaces included. Do not retype — paste.",
  },
  icloud: {
    name: "iCloud Mail",
    description:
      "App-specific-password login over IMAP/SMTP. Create the password in Apple Account → Sign-In and Security, paste it once, and the daemon stores it in the OS keychain.",
    setupUrl: "https://account.apple.com",
    setupLabel: "Apple Account",
    passwordLabel: "Apple app-specific password",
    defaultDomain: "icloud.com",
    prerequisite:
      "Apple only allows app-specific passwords on Apple IDs that have two-factor authentication turned on. If your Apple ID doesn't have 2FA yet, enable it first at appleid.apple.com.",
    passwordSteps: [
      <>
        Open <strong>Apple Account</strong> and sign in with the Apple ID
        whose iCloud mailbox you want to connect.
      </>,
      <>
        In the left sidebar click <strong>Sign-In and Security</strong>, then
        click <strong>App-Specific Passwords</strong>.
      </>,
      <>
        Click <strong>+ Generate an app-specific password</strong>. Apple may
        ask you to re-enter your Apple ID password.
      </>,
      <>
        In the label field type <code>{APP_NAME}</code> (any name works),
        then click <strong>Create</strong>.
      </>,
      <>
        Apple shows a 19-character password in the form{" "}
        <code>xxxx-xxxx-xxxx-xxxx</code>. Copy it exactly —{" "}
        <strong>the dashes are required</strong>.
      </>,
      <>Paste it into the password field below, then click Authenticate.</>,
    ],
    passwordHint:
      "Format: xxxx-xxxx-xxxx-xxxx. Dashes are required — paste, don't retype.",
  },
};

interface ImapCardProps {
  kind: ImapKind;
  accounts: MailAccount[];
  enabledKinds: MailProviderKind[];
  focusAccountId?: string | null;
}

export function ImapCard({ kind, accounts, enabledKinds, focusAccountId }: ImapCardProps) {
  const invalidate = useInvalidateMail();
  const copy = COPY[kind];
  const enabled = enabledKinds.includes(kind);

  const status = deriveCardStatus({ accounts, enabled });

  const [localPart, setLocalPart] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  const setEnabled = async (next: boolean) => {
    setToggleBusy(true);
    try {
      await toggleProviderEnabled(enabledKinds, kind, next);
      invalidate();
    } finally {
      setToggleBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post("/config/mail/app-password", {
        kind,
        email: `${localPart.trim()}@${copy.defaultDomain}`,
        appPassword: appPassword.trim(),
        label: label.trim() || undefined,
      });
      setNotice(
        `${copy.name} authenticated. Toggle the switch below to start using it.`,
      );
      setLocalPart("");
      setAppPassword("");
      setLabel("");
      invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect");
    } finally {
      setBusy(false);
    }
  };

  const setupSection = (
    <>
      <div className="rounded-md border border-dashed border-border p-3 text-xs space-y-2">
        <p className="text-foreground font-medium">
          Step 1: Generate an app password
        </p>
        <p className="text-muted-foreground">
          {copy.prerequisite}{" "}
          <a
            href={copy.setupUrl}
            target="_blank"
            rel="noreferrer"
            className="underline inline-flex items-center gap-0.5"
          >
            Open {copy.setupLabel} <ExternalLink className="h-3 w-3" />
          </a>
          .
        </p>
        <ol className="list-decimal list-outside pl-4 space-y-1 text-muted-foreground">
          {copy.passwordSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>

      <div className="rounded-md border border-border p-3 space-y-2">
        <p className="text-xs font-semibold text-foreground">
          Step 2: Authenticate the account
        </p>
        <div>
          <label
            className="block text-xs text-muted-foreground mb-1"
            htmlFor={`${kind}-email`}
          >
            Account email
          </label>
          <div className="flex items-center">
            <Input
              id={`${kind}-email`}
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              placeholder="username"
              className="h-8 text-xs rounded-r-none"
            />
            <span className="inline-flex h-8 items-center rounded-r-md border border-l-0 border-input bg-muted px-3 text-xs text-muted-foreground select-none">
              @{copy.defaultDomain}
            </span>
          </div>
        </div>
        <div>
          <label
            className="block text-xs text-muted-foreground mb-1"
            htmlFor={`${kind}-app-password`}
          >
            {copy.passwordLabel}
          </label>
          <Input
            id={`${kind}-app-password`}
            type="password"
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            placeholder="paste generated password"
            className="h-8 text-xs"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {copy.passwordHint}
          </p>
        </div>
        <div>
          <label
            className="block text-xs text-muted-foreground mb-1"
            htmlFor={`${kind}-label`}
          >
            Label (optional)
          </label>
          <Input
            id={`${kind}-label`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="personal, family, …"
            className="h-8 text-xs"
          />
        </div>
        <Button
          size="sm"
          onClick={() => void connect()}
          disabled={
            busy ||
            localPart.trim().length === 0 ||
            appPassword.trim().length === 0
          }
          className="h-7 text-xs px-3"
        >
          {busy ? "Authenticating…" : "Authenticate"}
        </Button>
      </div>

      {notice && <Alert variant="success">{notice}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}
    </>
  );

  return (
    <ProviderCardFrame
      name={copy.name}
      description={copy.description}
      status={status}
      setupSection={setupSection}
      accountsSection={
        accounts.length > 0
          ? accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                highlight={focusAccountId === a.id}
                isLastOfKind={accounts.length === 1}
                onAfterRemove={async () => {
                  if (accounts.length === 1 && enabled) {
                    await toggleProviderEnabled(enabledKinds, kind, false);
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
            ? `Authenticate a ${copy.name} account first.`
            : undefined,
        busy: toggleBusy,
        onChange: setEnabled,
        explainer: `When enabled, the agent observes your ${copy.name} inbox via IMAP IDLE and can read, draft, and send messages.`,
      }}
    />
  );
}

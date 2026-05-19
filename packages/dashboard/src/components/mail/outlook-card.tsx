"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { APP_NAME } from "@aitne/shared";
import { api } from "@/lib/api-client";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { AccountRow } from "./account-row";
import { ProviderCardFrame } from "./provider-card-frame";
import { deriveCardStatus } from "./types";
import type { MailAccount, MailProviderKind } from "./types";
import { toggleProviderEnabled, useInvalidateMail } from "./use-mail-data";

interface ClientConfigResponse {
  configured: boolean;
  clientId?: string;
  tenant?: string;
}

interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  message: string;
}

interface OutlookCardProps {
  accounts: MailAccount[];
  enabledKinds: MailProviderKind[];
  focusAccountId?: string | null;
}

export function OutlookCard({ accounts, enabledKinds, focusAccountId }: OutlookCardProps) {
  const invalidate = useInvalidateMail();
  const confirm = useConfirm();
  const enabled = enabledKinds.includes("outlook");

  const clientConfigQuery = useQuery({
    queryKey: ["outlook-client-config"],
    queryFn: () =>
      api.get<ClientConfigResponse>("/config/mail/outlook/client-config"),
    staleTime: 30_000,
  });
  const configured = clientConfigQuery.data?.configured === true;

  const status = deriveCardStatus({
    accounts,
    enabled,
    awaitingProviderSetup: !configured,
  });

  const [byoaForm, setByoaForm] = useState(false);
  const [clientId, setClientId] = useState("");
  const [tenant, setTenant] = useState("common");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devicePrompt, setDevicePrompt] = useState<DevicePrompt | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  const setEnabled = async (next: boolean) => {
    setToggleBusy(true);
    try {
      await toggleProviderEnabled(enabledKinds, "outlook", next);
      invalidate();
    } finally {
      setToggleBusy(false);
    }
  };

  const saveByoa = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put("/config/mail/outlook/client-config", {
        clientId: clientId.trim(),
        tenant: tenant.trim() || "common",
      });
      await clientConfigQuery.refetch();
      setByoaForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save client config");
    } finally {
      setBusy(false);
    }
  };

  const resetByoa = async () => {
    const ok = await confirm({
      title: "Reset Azure app registration?",
      description:
        "Existing Outlook accounts keep working until their tokens expire. You'll need to re-enter the client ID before adding new accounts.",
      confirmLabel: "Reset",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete("/config/mail/outlook/client-config");
      await clientConfigQuery.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reset");
    } finally {
      setBusy(false);
    }
  };

  const connectLoopback = async () => {
    const proceed = await confirm({
      title: "Open Microsoft sign-in?",
      description:
        "The daemon will open your browser to sign in to Microsoft. macOS or Windows may show a one-time firewall prompt — accept it so the loopback callback can complete.",
      confirmLabel: "Continue",
    });
    if (!proceed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post("/mail/accounts", {
        kind: "outlook",
        label: label.trim() || undefined,
      });
      setNotice("Outlook account authenticated. Toggle the switch below to start using it.");
      setLabel("");
      invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "OAuth failed");
    } finally {
      setBusy(false);
    }
  };

  const connectDeviceCode = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setDevicePrompt(null);
    try {
      const response = await fetch("/api/mail/accounts/device-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "outlook",
          label: label.trim() || undefined,
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const raw of events) {
          const lines = raw.split("\n");
          let eventName = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!eventName) continue;
          if (eventName === "prompt") {
            setDevicePrompt(JSON.parse(data) as DevicePrompt);
          } else if (eventName === "completed") {
            setNotice("Outlook account authenticated. Toggle the switch below to start using it.");
            setDevicePrompt(null);
            setLabel("");
            invalidate();
          } else if (eventName === "failed") {
            const parsed = JSON.parse(data) as { message?: string };
            throw new Error(parsed.message ?? "device-code failed");
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Device-code OAuth failed");
      setDevicePrompt(null);
    } finally {
      setBusy(false);
    }
  };

  const setupSection = (
    <>
      {/* Step 1 — Azure app registration */}
      <Step
        index={1}
        title="Register an Azure app (one-time)"
        completed={configured}
      >
        {!configured && !byoaForm && (
          <div className="space-y-3 text-xs">
            <p className="text-muted-foreground">
              One-time setup: you&apos;ll tell Microsoft that the {APP_NAME}
              daemon on your computer is allowed to read and send mail on your
              behalf. Follow every sub-step — two of them are easy to miss and
              will make sign-in fail with <code>server_error</code> later.
            </p>
            <ol className="list-decimal list-outside pl-4 space-y-2 text-muted-foreground">
              <li>
                Open the{" "}
                <a
                  href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                  target="_blank"
                  rel="noreferrer"
                  className="underline inline-flex items-center gap-0.5"
                >
                  Azure portal — App registrations{" "}
                  <ExternalLink className="h-3 w-3" />
                </a>
                . Sign in with the Microsoft account you want the agent to use.
              </li>
              <li>
                Click <strong>+ New registration</strong> at the top of the page.
              </li>
              <li>
                Fill in the form:
                <ul className="list-disc list-outside pl-4 mt-1 space-y-1">
                  <li>
                    <strong>Name</strong>: anything, e.g. <code>{APP_NAME}</code>.
                  </li>
                  <li>
                    <strong>Supported account types</strong>: pick{" "}
                    <em>
                      Accounts in any organizational directory (Any Microsoft
                      Entra ID tenant – Multitenant) and personal Microsoft
                      accounts (e.g. Skype, Xbox)
                    </em>
                    .
                  </li>
                  <li>
                    <strong>Redirect URI</strong>: in the left-hand dropdown
                    choose <code>Public client/native (mobile &amp; desktop)</code>{" "}
                    <strong>— not</strong> <code>Web</code>. Then type{" "}
                    <code>http://127.0.0.1/callback</code> in the box on the
                    right.
                  </li>
                </ul>
                <p className="mt-1 rounded-md border border-amber-400/60 bg-amber-400/10 px-2 py-1 text-amber-700 dark:text-amber-300">
                  ⚠ Trap #1: if you leave <code>Web</code> selected, Microsoft
                  will later return <code>Authorization failed: server_error</code>.
                  Use the Public client/native option.
                </p>
              </li>
              <li>
                Click <strong>Register</strong> at the bottom of the form.
              </li>
              <li>
                You&apos;ll land on the <em>Overview</em> page. Copy the value
                labelled <strong>Application (client) ID</strong> — you&apos;ll
                paste it into the form below in a moment.
              </li>
              <li>
                In the left sidebar click <strong>Authentication</strong>. Scroll
                to the very bottom, find <em>Advanced settings</em> →{" "}
                <strong>Allow public client flows</strong>, flip the toggle to{" "}
                <strong>Yes</strong>, then click <strong>Save</strong> at the
                top of the page.
                <p className="mt-1 rounded-md border border-amber-400/60 bg-amber-400/10 px-2 py-1 text-amber-700 dark:text-amber-300">
                  ⚠ Trap #2: this toggle is off by default. Without it sign-in
                  also fails with <code>server_error</code>.
                </p>
              </li>
              <li>
                In the left sidebar click <strong>API permissions</strong> →{" "}
                <strong>+ Add a permission</strong> →{" "}
                <strong>Microsoft Graph</strong> →{" "}
                <strong>Delegated permissions</strong>. Use the search box to
                find and tick each of:
                <ul className="list-disc list-outside pl-4 mt-1">
                  <li>
                    <code>offline_access</code>
                  </li>
                  <li>
                    <code>User.Read</code>
                  </li>
                  <li>
                    <code>Mail.ReadWrite</code>
                  </li>
                  <li>
                    <code>Mail.Send</code>
                  </li>
                </ul>
                Then click <strong>Add permissions</strong> at the bottom.
              </li>
              <li>
                (Work/school tenant only) If your org requires admin consent
                for these scopes, click <strong>Grant admin consent</strong>.
                Personal Microsoft accounts don&apos;t need this step.
              </li>
              <li>
                Come back here and click <strong>I have a client ID</strong>.
                Paste the Application (client) ID you copied in step 5; leave
                Tenant as <code>common</code> unless your admin told you
                otherwise.
              </li>
            </ol>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setByoaForm(true)}
              className="h-7 text-xs px-3"
            >
              I have a client ID
            </Button>
          </div>
        )}

        {byoaForm && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div>
              <label
                className="block text-xs text-muted-foreground mb-1"
                htmlFor="outlook-client-id"
              >
                Application (client) ID
              </label>
              <Input
                id="outlook-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                className="h-8 text-xs"
              />
            </div>
            <div>
              <label
                className="block text-xs text-muted-foreground mb-1"
                htmlFor="outlook-tenant"
              >
                Tenant (default <code>common</code>)
              </label>
              <Input
                id="outlook-tenant"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                placeholder="common / organizations / <tenant-guid>"
                className="h-8 text-xs"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void saveByoa()}
                disabled={busy || clientId.trim().length === 0}
                className="h-7 text-xs px-3"
              >
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setByoaForm(false)}
                disabled={busy}
                className="h-7 text-xs px-3"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {configured && !byoaForm && (
          <div className="text-xs text-muted-foreground">
            Application ID:{" "}
            <code className="font-mono">{clientConfigQuery.data?.clientId}</code>{" "}
            (tenant <code>{clientConfigQuery.data?.tenant}</code>).{" "}
            <button
              type="button"
              className="underline"
              onClick={() => void resetByoa()}
              disabled={busy}
            >
              reset
            </button>
          </div>
        )}
      </Step>

      {/* Step 2 — Connect an account */}
      <Step
        index={2}
        title="Authenticate an Outlook account"
        disabled={!configured}
      >
        {!configured ? (
          <p className="text-xs text-muted-foreground">
            Save the client ID first.
          </p>
        ) : (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div>
              <label
                className="block text-xs text-muted-foreground mb-1"
                htmlFor="outlook-label"
              >
                Label (optional)
              </label>
              <Input
                id="outlook-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="work, personal, …"
                className="h-8 text-xs"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => void connectLoopback()}
                disabled={busy}
                className="h-7 text-xs px-3"
              >
                {busy ? "Waiting for consent…" : "Authenticate (browser)"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void connectDeviceCode()}
                disabled={busy}
                className="h-7 text-xs px-3"
                title="Use if the daemon runs headless (SSH / WSL)"
              >
                Authenticate (device code)
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The browser flow may trigger a one-time macOS / Windows firewall
              prompt — accept it so the loopback callback can complete.
            </p>
          </div>
        )}
      </Step>

      {devicePrompt && (
        <Alert variant="warning">
          <div className="text-xs">
            Visit{" "}
            <a
              href={devicePrompt.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {devicePrompt.verificationUri}
            </a>{" "}
            and enter code{" "}
            <code className="font-mono">{devicePrompt.userCode}</code>. Expires
            in {Math.round(devicePrompt.expiresIn / 60)} min.
          </div>
        </Alert>
      )}
      {notice && <Alert variant="success">{notice}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}
    </>
  );

  return (
    <ProviderCardFrame
      name="Outlook / Microsoft 365"
      description={
        <>
          One-time Azure app registration, then connect as many Outlook /
          outlook.com / Microsoft 365 accounts as you need.
        </>
      }
      status={status}
      setupSection={setupSection}
      accountsSection={
        accounts.length > 0
          ? accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                highlight={focusAccountId === a.id}
                onReauthenticate={() => void connectLoopback()}
                isLastOfKind={accounts.length === 1}
                onAfterRemove={async () => {
                  if (accounts.length === 1 && enabled) {
                    await toggleProviderEnabled(enabledKinds, "outlook", false);
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
            ? "Authenticate an Outlook account first."
            : undefined,
        busy: toggleBusy,
        onChange: setEnabled,
        explainer:
          "When enabled, the agent observes your Outlook inbox via Microsoft Graph and can read, draft, and send messages.",
      }}
    />
  );
}

function Step({
  index,
  title,
  completed = false,
  disabled = false,
  children,
}: {
  index: number;
  title: string;
  completed?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "rounded-md border border-dashed p-3 " +
        (disabled
          ? "border-border opacity-50"
          : completed
            ? "border-emerald-300 dark:border-emerald-800"
            : "border-border")
      }
    >
      <p className="text-xs font-semibold text-foreground mb-2">
        Step {index}: {title}
        {completed && (
          <span className="ml-2 text-emerald-600 dark:text-emerald-400">✓</span>
        )}
      </p>
      {children}
    </div>
  );
}

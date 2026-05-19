"use client";

import { useCallback, useEffect, useState } from "react";
import { Calendar, ExternalLink } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

interface CalendarEntry {
  id: string;
  summary: string;
  description: string | null;
  primary: boolean;
}

interface StatusResponse {
  configured: boolean;
  available: boolean;
}

interface ConnectResponse {
  status: "connected";
  email: string;
  calendars: CalendarEntry[];
}

/**
 * Connection card for Apple Calendar (iCloud CalDAV). Mirrors the
 * iCloud Mail card's copy so users follow the same Apple ID app-specific
 * password flow they already know from Mail.
 *
 * The form posts to `POST /api/apple-calendar/credentials`, which validates
 * by attempting a CalDAV principal discovery against iCloud. On success the
 * daemon stores the credentials in the OS keychain and re-inits the
 * AppleCalendarService.
 */
export function AppleCalendarCard() {
  const confirm = useConfirm();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [calendars, setCalendars] = useState<CalendarEntry[]>([]);
  const [calendarsError, setCalendarsError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<StatusResponse>("/apple-calendar/status");
      setStatus(next);
      if (next.available) {
        try {
          const list = await api.get<{ calendars: CalendarEntry[] }>(
            "/apple-calendar/calendars",
          );
          setCalendars(list.calendars);
          setCalendarsError(null);
        } catch (e) {
          // Surface the failure inline so the user sees an actionable
          // message instead of a quietly empty list under a "Connected"
          // badge — that combination previously looked like the account
          // was healthy but had no calendars at all.
          setCalendars([]);
          setCalendarsError(
            e instanceof Error ? e.message : "Failed to load calendars",
          );
        }
      } else {
        setCalendars([]);
        setCalendarsError(null);
      }
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<ConnectResponse>(
        "/apple-calendar/credentials",
        {
          email: email.trim(),
          appPassword: appPassword.trim(),
        },
      );
      setNotice(
        `Connected as ${res.email}. ${res.calendars.length} calendar${
          res.calendars.length === 1 ? "" : "s"
        } discovered.`,
      );
      setEmail("");
      setAppPassword("");
      await refresh();
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Failed to connect";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: "Disconnect Apple Calendar?",
      description:
        "The app-specific password will be removed from the OS keychain. The agent will no longer be able to read or write your iCloud calendar until you reconnect.",
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.delete("/apple-calendar/credentials");
      setNotice("Apple Calendar disconnected.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setBusy(false);
    }
  };

  const setPrimary = async (calendarUrl: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ calendars: CalendarEntry[] }>(
        "/apple-calendar/default-calendar",
        { calendarUrl },
      );
      setCalendars(res.calendars);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set primary");
    } finally {
      setBusy(false);
    }
  };

  const tone =
    status?.available
      ? "success"
      : status?.configured
        ? "warning"
        : "default";

  const badgeText = status?.available
    ? "Connected"
    : status?.configured
      ? "Auth issue"
      : "Not connected";

  const badgeVariant = status?.available
    ? "green"
    : status?.configured
      ? "amber"
      : "gray";

  return (
    <Card tone={tone}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
          <h3 className="text-base font-semibold text-foreground truncate">
            Apple Calendar (iCloud)
          </h3>
        </div>
        <Badge variant={badgeVariant}>
          {badgeText}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Read and write events on your iCloud calendar over CalDAV. The
        daemon authenticates with an Apple ID app-specific password —
        the same kind used by iCloud Mail — and stores it in the OS
        keychain.
      </p>

      <Separator className="my-4" />

      {!status?.available && (
        <div className="space-y-3">
          <div className="rounded-md border border-dashed border-border p-3 text-xs space-y-2">
            <p className="text-foreground font-medium">
              Step 1: Generate an app-specific password
            </p>
            <p className="text-muted-foreground">
              Apple only allows app-specific passwords on Apple IDs that have
              two-factor authentication turned on.{" "}
              <a
                href="https://account.apple.com"
                target="_blank"
                rel="noreferrer"
                className="underline inline-flex items-center gap-0.5"
              >
                Open Apple Account <ExternalLink className="h-3 w-3" />
              </a>
              , then go to <strong>Sign-In and Security</strong> →{" "}
              <strong>App-Specific Passwords</strong> →{" "}
              <strong>Generate an app-specific password</strong>.
            </p>
            <p className="text-muted-foreground">
              Apple shows a 19-character password in the form{" "}
              <code>xxxx-xxxx-xxxx-xxxx</code>. Copy it exactly — the dashes
              are required.
            </p>
          </div>

          <div className="rounded-md border border-border p-3 space-y-2">
            <p className="text-xs font-semibold text-foreground">
              Step 2: Authenticate
            </p>
            <div>
              <label
                className="block text-xs text-muted-foreground mb-1"
                htmlFor="apple-cal-email"
              >
                Apple ID email
              </label>
              <Input
                id="apple-cal-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@icloud.com"
                className="h-8 text-xs"
                autoComplete="username"
              />
            </div>
            <div>
              <label
                className="block text-xs text-muted-foreground mb-1"
                htmlFor="apple-cal-password"
              >
                App-specific password
              </label>
              <Input
                id="apple-cal-password"
                type="password"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                placeholder="xxxx-xxxx-xxxx-xxxx"
                className="h-8 text-xs"
                autoComplete="current-password"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Format: xxxx-xxxx-xxxx-xxxx. Dashes are required — paste,
                don&apos;t retype.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => void connect()}
              disabled={busy || email.trim().length === 0 || appPassword.trim().length === 0}
              className="h-7 text-xs px-3"
            >
              {busy ? "Authenticating…" : "Authenticate"}
            </Button>
          </div>
        </div>
      )}

      {status?.available && calendars.length === 0 && (
        <div className="space-y-2">
          <Alert variant="warning">
            {calendarsError
              ? `Could not load the calendar list — ${calendarsError}. Try refreshing the page; if the error persists, disconnect and re-authenticate.`
              : "Connected, but no calendars are visible. iCloud may still be syncing — refresh in a moment."}
          </Alert>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void disconnect()}
            disabled={busy}
            className="h-7 text-xs px-3 text-destructive"
          >
            Disconnect
          </Button>
        </div>
      )}

      {status?.available && calendars.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">Calendars</p>
          <ul className="rounded-md border border-border divide-y divide-border">
            {calendars.map((cal) => (
              <li
                key={cal.id}
                className="flex items-center justify-between px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{cal.summary}</div>
                  {cal.description && (
                    <div className="text-muted-foreground truncate">
                      {cal.description}
                    </div>
                  )}
                </div>
                {cal.primary ? (
                  <Badge variant="green">Primary</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[11px] px-2"
                    disabled={busy}
                    onClick={() => void setPrimary(cal.id)}
                  >
                    Set primary
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void disconnect()}
            disabled={busy}
            className="h-7 text-xs px-3 text-destructive"
          >
            Disconnect
          </Button>
        </div>
      )}

      {notice && <Alert variant="success" className="mt-3">{notice}</Alert>}
      {error && <Alert variant="error" className="mt-3">{error}</Alert>}
    </Card>
  );
}

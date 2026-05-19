"use client";

/**
 * Phase 5 (P5 §"Multi-account remotes") — manage named credentials the
 * Git/GitHub observers attach to per-repo polls. Two auth modes:
 *
 *   • `gh-cli-profile` — reuse an existing `gh auth login` profile by
 *     login name. The daemon resolves the token via
 *     `gh auth token --user <ghProfile>` at call time, so token rotation
 *     and SSO refresh continue to flow through `gh`.
 *   • `pat-keychain` — paste a Personal Access Token. The daemon stores
 *     it in the OS keychain at `git.account.<alias>` and never persists
 *     it to disk.
 *
 * Direct mode only (see git-lifecycle-and-triggers.md Decision 4 §3) —
 * Delegated mode currently uses the default `gh` profile inside the
 * spawned backend session. That caveat is surfaced inline.
 */

import { useState } from "react";
import { KeyRound, Plus, ShieldCheck, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConnectionCard, deriveConfiguredStatus } from "./connection-card";
import {
  useDeleteGitAccount,
  useGitAccounts,
  useProbeGitAccount,
  useUpsertGitAccount,
} from "@/lib/hooks/use-git-accounts";
import type {
  GitAccountConfig,
  GitAccountsListEntry,
} from "@/lib/api-types";

const ALIAS_PATTERN = /^[a-z0-9._-]+$/;

interface FormState {
  alias: string;
  type: GitAccountConfig["type"];
  authMode: GitAccountConfig["authMode"];
  ghProfile: string;
  host: string;
  token: string;
}

const EMPTY_FORM: FormState = {
  alias: "",
  type: "github",
  authMode: "gh-cli-profile",
  ghProfile: "",
  host: "github.com",
  token: "",
};

export function GitAccountsCard() {
  const list = useGitAccounts();
  const upsert = useUpsertGitAccount();
  const remove = useDeleteGitAccount();
  const probe = useProbeGitAccount();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [probeMessages, setProbeMessages] = useState<Record<string, string>>({});

  const accounts = list.data?.accounts ?? [];

  const submit = async () => {
    setError(null);
    if (!ALIAS_PATTERN.test(form.alias)) {
      setError("Alias must use lowercase letters, digits, dot, dash, or underscore.");
      return;
    }
    if (form.authMode === "gh-cli-profile" && !form.ghProfile.trim()) {
      setError("gh-cli-profile mode requires a gh login name.");
      return;
    }
    if (form.authMode === "pat-keychain" && !form.token.trim()) {
      setError("PAT mode requires a token on first save.");
      return;
    }
    try {
      await upsert.mutateAsync({
        alias: form.alias,
        payload: {
          type: form.type,
          authMode: form.authMode,
          host: form.host || "github.com",
          ...(form.authMode === "gh-cli-profile"
            ? { ghProfile: form.ghProfile }
            : {}),
          ...(form.token ? { token: form.token } : {}),
        },
      });
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save account.");
    }
  };

  const onProbe = async (alias: string) => {
    setProbeMessages((prev) => ({ ...prev, [alias]: "Probing…" }));
    try {
      const result = await probe.mutateAsync(alias);
      const message = result.ok
        ? `OK — authenticated as ${result.login}`
        : `Probe failed: ${result.reason ?? "unknown"}`;
      setProbeMessages((prev) => ({ ...prev, [alias]: message }));
    } catch (err) {
      setProbeMessages((prev) => ({
        ...prev,
        [alias]: err instanceof Error ? err.message : "Probe failed",
      }));
    }
  };

  return (
    <ConnectionCard
      name="Git Accounts"
      icon={<KeyRound className="h-4 w-4" />}
      status={deriveConfiguredStatus(accounts.length > 0)}
    >
      <div className="mt-2 space-y-3">
        <p className="text-xs text-muted-foreground">
          Named credentials attached to watched repositories via{" "}
          <code className="rounded bg-muted px-1">accountAlias</code>. Direct
          mode injects the resolved token per poll; Delegated mode currently
          uses the default <code>gh</code> profile.
        </p>

        {error && <Alert variant="error">{error}</Alert>}

        <div className="space-y-2">
          {accounts.length === 0 && (
            <p className="text-xs italic text-muted-foreground">
              No accounts configured. Add one below.
            </p>
          )}
          {accounts.map((entry) => (
            <AccountRow
              key={entry.alias}
              entry={entry}
              onDelete={() => remove.mutate(entry.alias)}
              onProbe={() => onProbe(entry.alias)}
              probeMessage={probeMessages[entry.alias]}
              busy={remove.isPending || probe.isPending}
            />
          ))}
        </div>

        <div className="space-y-2 rounded border bg-background p-3">
          <p className="text-xs font-medium">Add account</p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={form.alias}
              onChange={(e) => setForm((f) => ({ ...f, alias: e.target.value }))}
              placeholder="alias (e.g. work-github)"
              className="max-w-[200px]"
            />
            <select
              value={form.authMode}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  authMode: e.target.value as FormState["authMode"],
                }))
              }
              className="h-9 rounded border bg-background px-2 text-sm"
            >
              <option value="gh-cli-profile">gh CLI profile</option>
              <option value="pat-keychain">Personal Access Token</option>
            </select>
            <Input
              value={form.host}
              onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
              placeholder="github.com"
              className="max-w-[180px]"
            />
            {form.authMode === "gh-cli-profile" ? (
              <Input
                value={form.ghProfile}
                onChange={(e) =>
                  setForm((f) => ({ ...f, ghProfile: e.target.value }))
                }
                placeholder="gh login name (e.g. alice)"
                className="max-w-[220px]"
              />
            ) : (
              <Input
                type="password"
                value={form.token}
                onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                placeholder="ghp_… (PAT — never persisted to disk)"
                className="max-w-[280px]"
              />
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={submit}
              disabled={upsert.isPending || !form.alias.trim()}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Save
            </Button>
          </div>
        </div>
      </div>
    </ConnectionCard>
  );
}

function AccountRow({
  entry,
  onDelete,
  onProbe,
  probeMessage,
  busy,
}: {
  entry: GitAccountsListEntry;
  onDelete: () => void;
  onProbe: () => void;
  probeMessage?: string;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border bg-background p-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm font-medium">{entry.alias}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="gray">{entry.host}</Badge>
          <Badge variant={entry.authMode === "pat-keychain" ? "green" : "gray"}>
            {entry.authMode}
          </Badge>
          {entry.ghProfile && (
            <Badge variant="gray">user: {entry.ghProfile}</Badge>
          )}
          {entry.tokenStored === true && <Badge variant="green">token stored</Badge>}
          {entry.tokenStored === false && (
            <Badge variant="red">no token</Badge>
          )}
        </div>
        {probeMessage && (
          <p className="mt-1 text-xs text-muted-foreground">{probeMessage}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onProbe} disabled={busy}>
          <ShieldCheck className="mr-1 h-3.5 w-3.5" />
          Probe
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy} className="h-8 w-8 p-0">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default GitAccountsCard;

"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api-client";

interface ConfigPayload {
  browserTaskHostnameDenylist?: readonly string[];
}

interface ConfigUpdateResponse {
  applied?: Record<string, unknown>;
}

/**
 * User-curated hostname exclusion list for the browser-task surface.
 *
 * As of the 2026-05-27 open-navigation revision (BROWSER_TASK_REDESIGN_PLAN.md)
 * the framework no longer ships any hardcoded brand denylist — domain-level
 * deny is fully owner-managed. Empty by default; entries here block the
 * browser-task sub-agent from navigating to the named hosts (and any
 * subdomain). Network-infrastructure protection (RFC1918 / loopback /
 * cloud-metadata at the IP layer) and payment-path URL blocking stay
 * hardcoded inside the daemon and are NOT editable here.
 */
export function BrowserTaskHostnameDenylistCard({
  onToast,
}: {
  onToast?: (variant: "success" | "error", message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.get<ConfigPayload>("/config"),
    staleTime: 30_000,
  });

  const persisted = (config?.browserTaskHostnameDenylist ?? []).join("\n");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const initialised = !isLoading && config !== undefined;
  const current = draft ?? persisted;
  const dirty = draft !== null && draft !== persisted;

  function parse(value: string): string[] {
    return Array.from(
      new Set(
        value
          .split(/[\s,]+/)
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),
    );
  }

  async function save() {
    if (!dirty) return;
    setSaving(true);
    try {
      await api.patch<ConfigUpdateResponse>("/config", {
        browserTaskHostnameDenylist: parse(current),
      });
      queryClient.invalidateQueries({ queryKey: ["config"] });
      setDraft(null);
      onToast?.("success", "Browser-task denylist saved");
    } catch (err) {
      onToast?.(
        "error",
        `Failed to save denylist: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      setSaving(false);
    }
  }

  function revert() {
    setDraft(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Browser-task hostname exclusions</CardTitle>
      </CardHeader>
      <div className="space-y-3 px-6 pb-6">
        <p className="text-sm text-muted-foreground">
          Browser-task runs with open navigation by default. Add hostnames here
          to block the sub-agent from visiting them — one entry per line. A bare
          hostname (<code>paypal.com</code>) blocks the host and any subdomain
          (<code>checkout.paypal.com</code>); a wildcard form (<code>*.example.com</code>)
          is accepted as syntactic sugar for the same. Empty by default.
        </p>
        <p className="text-xs text-muted-foreground">
          The list is independent of the network-layer protection inside the
          daemon (RFC1918, loopback, cloud-metadata <code>169.254.169.254</code>),
          which stays on regardless. URL-pattern blocking of checkout / commit-
          money flows (<code>payment-path-blocker</code>) is also always on.
        </p>
        <textarea
          className="font-mono min-h-32 w-full rounded-md border bg-background p-3 text-xs"
          value={current}
          placeholder={"paypal.com\nchase.com\n*.example.com"}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => setDraft(event.target.value)}
          disabled={!initialised || saving}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
          {dirty && (
            <Button
              size="sm"
              variant="outline"
              onClick={revert}
              disabled={saving}
            >
              Revert
            </Button>
          )}
          {!initialised && (
            <span className="text-xs text-muted-foreground">Loading…</span>
          )}
        </div>
      </div>
    </Card>
  );
}

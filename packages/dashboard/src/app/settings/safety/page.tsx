"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useConfig } from "@/lib/hooks/use-config";
import { useSaveConfig } from "@/lib/hooks/use-save-config";
import { useDirtyFields } from "@/lib/hooks/use-dirty-fields";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Separator } from "@/components/ui/separator";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { EditableArrayField } from "@/components/settings/editors";
import { SettingsToast } from "@/components/settings/settings-navigation";

/**
 * Safety — tool-policy guardrails, split out of the former monolithic
 * /settings/advanced page (DASHBOARD_UI_REFRESH_DESIGN.md follow-up #1) so
 * the three authority levels (Safety / Infrastructure / Danger Zone) each
 * get their own page. /settings/advanced 302-redirects here.
 */
export default function SafetySettingsPage() {
  const { data: config } = useConfig();
  // toast + showToast for non-config actions (reset safety)
  const { toast, showToast } = useSaveConfig();
  // deferSave / dv for the standard fields
  const { deferSaveFor, dv, dirtyFields, clearDirtyKeys } = useDirtyFields();
  const queryClient = useQueryClient();
  const confirmDialog = useConfirm();
  const [resetting, setResetting] = useState(false);

  const handleResetSafety = async () => {
    const ok = await confirmDialog({
      title: "Reset disallowed tools to defaults?",
      description:
        "This will restore the default safety tool list, replacing any customizations.",
      confirmLabel: "Reset",
      variant: "destructive",
    });
    if (!ok) return;
    setResetting(true);
    try {
      await api.post("/config/reset-safety");
      queryClient.invalidateQueries({ queryKey: ["config"] });
      // Clear any dirty entries for the reset keys so they don't overwrite
      // the fresh defaults when the user clicks Save in the save bar.
      clearDirtyKeys(["disallowedTools", "allowedToolsOverride"]);
      showToast("success", "Safety tools reset to defaults");
    } finally {
      setResetting(false);
    }
  };

  if (!config) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  const deferSave = deferSaveFor(config);

  return (
    <>
      <PageHeader
        title="Safety"
        description="Tool-policy guardrails applied to every backend. The per-backend Safe / Allow execution mode lives in Models & Cost."
      />

      {/* Toast for immediate-save actions (reset safety) */}
      <SettingsToast toast={toast} />

      <Card>
        <CardHeader>
          <CardTitle>Safety — Tool Policy</CardTitle>
        </CardHeader>
        <div className="space-y-3 [&>p]:max-w-prose">
          <p className="text-xs text-muted-foreground">
            Guardrails applied to every backend&rsquo;s tool calls, enforced
            before each call runs. Entries are either a plain tool name
            (<code>Write</code>, <code>WebFetch</code>) or a tool name with an
            argument pattern in parentheses (<code>Bash(rm -rf *)</code>) to
            match only specific invocations.{" "}
            <strong>Disallowed wins over allowed</strong> — any match in the
            disallowed list blocks the call even if the allowed override would
            otherwise permit it. The per-backend Safe / Allow toggle lives in{" "}
            <strong>Models &amp; Cost → Execution Mode</strong>.
          </p>
          <EditableArrayField
            label="Disallowed Tools"
            values={dv("disallowedTools", config.disallowedTools)}
            configKey="disallowedTools"
            variant="red"
            placeholder="e.g. Bash(rm -rf *)"
            modified={dirtyFields.has("disallowedTools")}
            onSave={deferSave}
          />
          <p className="text-xs text-muted-foreground -mt-1">
            Tools the agent is forbidden from calling. The defaults block
            destructive shell commands and dangerous file operations. Use Reset
            to Defaults below to restore them after experimenting.
          </p>

          <Separator />

          <EditableArrayField
            label="Allowed Tools Override"
            values={dv("allowedToolsOverride", config.allowedTools)}
            configKey="allowedToolsOverride"
            variant="green"
            placeholder="e.g. Bash(git push)"
            modified={dirtyFields.has("allowedToolsOverride")}
            onSave={deferSave}
          />
          <p className="text-xs text-muted-foreground -mt-1">
            Narrow exceptions to the disallowed list. Use this to permit a
            specific safe invocation of an otherwise-blocked tool — for
            example, allow <code>Bash(git push)</code> while keeping arbitrary{" "}
            <code>Bash</code> blocked.
          </p>

          <Separator />
          <Button
            variant="outline"
            size="sm"
            onClick={handleResetSafety}
            disabled={resetting}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            {resetting ? "Resetting..." : "Reset to Defaults"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Restores the built-in disallowed-tool list and{" "}
            <strong>clears the allowed override list</strong>, replacing any
            customizations in both. Use this when your safety config has
            drifted and you want a clean slate.
          </p>
        </div>
      </Card>
    </>
  );
}

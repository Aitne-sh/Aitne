"use client";

import { useState } from "react";
import { CheckCircle2, Download, Sparkles, Terminal, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  useGeminiInstall,
  type GeminiInstallKind,
  type GeminiInstallResult,
} from "@/lib/hooks/use-mcp";

/**
 * One-button installer for Gemini-side MCP servers required by the
 * delegated Gmail / Calendar / Notion connectors. Shells out to the
 * user's `gemini` binary via the daemon — surfaces the subprocess
 * stdout / stderr verbatim so OAuth-required prompts and version
 * mismatches stay visible.
 *
 * The Notion install copy explicitly carries the namespace caveat: the
 * registry assumes the server is registered under the literal name
 * `notion`, and the daemon's probe can only verify presence — not that
 * the actual MCP server's tool names match the registry's
 * `notion-search` / `notion-fetch` / etc. assumption. If the
 * runtime-discovered tools diverge, the agent will hit `wrong_tool` on
 * first invocation; the card surfaces this as a footnote so the user
 * doesn't troubleshoot blind.
 */
export function GeminiDelegationSetupCard() {
  return (
    <div className="rounded-xl border border-border p-5 space-y-4">
      <div className="flex items-start gap-3">
        <Sparkles className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Gemini delegation setup
          </h3>
          <p className="text-xs text-muted-foreground">
            One-click install for the Gemini-side MCP servers the
            delegated Gmail / Calendar / Notion connectors depend on.
            The dashboard runs the install via your local `gemini` binary;
            you may need to complete a Google OAuth flow in a browser tab
            on first use.
          </p>
        </div>
      </div>
      <InstallRow
        kind="google-workspace"
        title="google-workspace extension"
        subtitle="Gmail + Calendar tools (mcp_google-workspace_gmail.* / calendar.*)"
        commandPreview="gemini extensions install https://github.com/gemini-cli-extensions/workspace"
      />
      <InstallRow
        kind="notion"
        title="Notion MCP server"
        subtitle={
          "Hosted Notion MCP at https://mcp.notion.com/mcp registered as " +
          "`notion` (mcp_notion_*)."
        }
        commandPreview="gemini mcp add -s user -t http notion https://mcp.notion.com/mcp"
        footnote={
          "Tool-name assumption: the registry expects this server to expose " +
          "`notion-search`, `notion-fetch`, `notion-create-pages`, etc. The " +
          "presence-only probe cannot verify the actual tool names — if the " +
          "Notion MCP uses different ones, delegated calls will fail at " +
          "runtime with `wrong_tool`. Re-probe from the Connections page after " +
          "install to surface the gap. " +
          "Idempotency caveat: this button checks only the server name, not " +
          "the URL — if you already have a different MCP registered as " +
          "`notion`, run `gemini mcp remove notion` first or this install " +
          "will no-op."
        }
      />
    </div>
  );
}

interface InstallRowProps {
  kind: GeminiInstallKind;
  title: string;
  subtitle: string;
  commandPreview: string;
  footnote?: string;
}

function InstallRow({
  kind,
  title,
  subtitle,
  commandPreview,
  footnote,
}: InstallRowProps) {
  const install = useGeminiInstall();
  const [lastResult, setLastResult] = useState<GeminiInstallResult | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const onInstall = async () => {
    setLastResult(null);
    setLastError(null);
    try {
      const result = await install.mutateAsync(kind);
      setLastResult(result);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <p className="text-xs font-medium text-foreground">{title}</p>
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs shrink-0"
          onClick={onInstall}
          disabled={install.isPending}
        >
          <Download className="h-3 w-3 mr-1" />
          {install.isPending ? "Installing…" : "Install"}
        </Button>
      </div>
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
        <Terminal className="h-3 w-3 shrink-0" />
        <span className="truncate">{commandPreview}</span>
      </div>
      {footnote && (
        <p className="text-[10px] leading-relaxed text-muted-foreground italic">
          {footnote}
        </p>
      )}
      {lastResult && lastResult.ok && (
        <Alert variant="success" className="text-xs py-2">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0 flex-1">
              <p className="font-medium">
                {lastResult.alreadyInstalled
                  ? "Already installed — no changes made"
                  : "Install succeeded"}
              </p>
              {lastResult.stdout && (
                <pre className="text-[10px] whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                  {lastResult.stdout}
                </pre>
              )}
            </div>
          </div>
        </Alert>
      )}
      {lastResult && !lastResult.ok && (
        <Alert variant="error" className="text-xs py-2">
          <div className="flex items-start gap-2">
            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0 flex-1">
              <p className="font-medium">
                {lastResult.error === "gemini_cli_not_found"
                  ? "gemini CLI not found on PATH"
                  : `Install failed${
                      typeof lastResult.exitCode === "number"
                        ? ` (exit ${lastResult.exitCode})`
                        : ""
                    }`}
              </p>
              {lastResult.message && (
                <p className="text-[10px]">{lastResult.message}</p>
              )}
              {lastResult.stderr && (
                <pre className="text-[10px] whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                  {lastResult.stderr}
                </pre>
              )}
            </div>
          </div>
        </Alert>
      )}
      {lastError && (
        <Alert variant="error" className="text-xs py-2">
          <div className="flex items-start gap-2">
            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <p>{lastError}</p>
          </div>
        </Alert>
      )}
    </div>
  );
}

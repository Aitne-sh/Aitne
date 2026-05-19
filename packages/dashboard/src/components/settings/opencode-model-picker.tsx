"use client";

import { Check, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert } from "@/components/ui/alert";
import {
  useOpencodeLiveModels,
  useRefreshOpencodeLiveModels,
  type LiveOpencodeModel,
  type LiveOpencodeProviderGroup,
} from "@/lib/hooks/use-opencode-live-models";
import { cn } from "@/lib/utils";

interface OpencodeModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  /** When set, the picker initially focuses models matching this tier
   *  (but the user can still pick from any tier). */
  preferredTier?: "lite" | "medium" | "high";
  /** Placeholder text shown in the trigger button when value is empty. */
  placeholder?: string;
}

/**
 * Provider-grouped, search-filterable picker over the live opencode model
 * catalogue. Trigger is a button showing the current composite (e.g.
 * `openrouter/anthropic/claude-haiku-4.5`); clicking opens a modal with
 * substring search across model id / name / family and per-provider
 * sections (collapsed by default when more than 5 providers exist; flat
 * otherwise).
 *
 * The selected composite is the full `<providerID>/<modelID>` string,
 * which is what `process_backend_config.main_model` stores.
 */
export function OpencodeModelPicker({
  value,
  onChange,
  disabled,
  preferredTier,
  placeholder = "Select model",
}: OpencodeModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<"all" | "lite" | "medium" | "high">(
    preferredTier ?? "all",
  );
  const [onlyFree, setOnlyFree] = useState(false);
  const [onlyToolcall, setOnlyToolcall] = useState(true);

  const { data, isLoading, error } = useOpencodeLiveModels(open);
  const refresh = useRefreshOpencodeLiveModels();

  const filtered = useMemo<LiveOpencodeProviderGroup[]>(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.providers
      .map((provider) => ({
        ...provider,
        models: provider.models.filter((m) => {
          if (onlyFree && !m.isFree) return false;
          if (onlyToolcall && !m.supportsToolUse) return false;
          if (tierFilter !== "all" && m.tier !== tierFilter) return false;
          if (!q) return true;
          return (
            m.modelId.toLowerCase().includes(q)
            || m.shortId.toLowerCase().includes(q)
            || m.name.toLowerCase().includes(q)
            || m.family.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((p) => p.models.length > 0);
  }, [data, query, tierFilter, onlyFree, onlyToolcall]);

  const totalShown = filtered.reduce((s, p) => s + p.models.length, 0);
  const totalModels = data?.providers.reduce((s, p) => s + p.models.length, 0) ?? 0;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="w-full justify-start truncate font-mono text-xs"
      >
        {value || (
          <span className="text-muted-foreground italic">{placeholder}</span>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogTitle>OpenCode model</DialogTitle>
          <DialogDescription>
            Live catalogue from <code>client.config.providers()</code> —
            every model your opencode server can route to. Selecting writes
            the full <code>provider/model</code> composite.
          </DialogDescription>

          <div className="mt-3 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Search by id, name, or family (e.g. gpt-oss, haiku, qwen)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              title="Re-enumerate after opencode auth changes"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")}
              />
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <FilterChip
              active={tierFilter === "all"}
              onClick={() => setTierFilter("all")}
              label="All tiers"
            />
            {(["lite", "medium", "high"] as const).map((t) => (
              <FilterChip
                key={t}
                active={tierFilter === t}
                onClick={() => setTierFilter(t)}
                label={t}
              />
            ))}
            <div className="mx-1 h-4 w-px bg-border" />
            <FilterChip
              active={onlyToolcall}
              onClick={() => setOnlyToolcall((v) => !v)}
              label="tool-use only"
            />
            <FilterChip
              active={onlyFree}
              onClick={() => setOnlyFree((v) => !v)}
              label="free only"
            />
            <span className="ml-auto text-muted-foreground">
              {totalShown}/{totalModels} models
            </span>
          </div>

          {isLoading && (
            <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
          )}
          {error && (
            <Alert variant="warning" className="mt-3 text-xs">
              Failed to enumerate models: {error instanceof Error ? error.message : "unknown error"}.
              Confirm the daemon is running and the opencode server has at least one provider configured.
            </Alert>
          )}

          {data && (
            <ScrollArea className="mt-3 h-[420px] rounded-md border border-border">
              {filtered.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No models match these filters.
                </div>
              )}
              {filtered.map((provider) => (
                <div key={provider.id}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-muted/95 px-3 py-1.5 backdrop-blur">
                    <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
                      {provider.name}
                    </span>
                    <Badge variant="gray" className="text-[10px]">
                      {provider.source}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {provider.models.length}
                    </span>
                  </div>
                  {provider.models.map((m) => (
                    <ModelRow
                      key={m.modelId}
                      model={m}
                      selected={m.modelId === value}
                      onSelect={() => {
                        onChange(m.modelId);
                        setOpen(false);
                      }}
                    />
                  ))}
                </div>
              ))}
            </ScrollArea>
          )}

          {data && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {data.cached ? "Cached" : "Fresh"} as of {new Date(data.fetchedAt).toLocaleTimeString()}.
              Add providers via <code>opencode auth login</code>, then click Refresh.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
}

function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: LiveOpencodeModel;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 border-b border-border/40 px-3 py-2 text-left transition-colors hover:bg-muted/50",
        selected && "bg-accent/40",
      )}
    >
      <Check
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          selected ? "text-foreground" : "text-transparent",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {model.name}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {model.modelId}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {model.isFree && (
          <Badge variant="green" className="text-[10px]">
            free
          </Badge>
        )}
        {!model.supportsToolUse && (
          <Badge variant="gray" className="text-[10px] text-muted-foreground">
            no tools
          </Badge>
        )}
        <Badge variant="gray" className="text-[10px]">
          {model.tier}
        </Badge>
        {!model.isFree && model.usdPer1kIn !== null && (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            ${model.usdPer1kIn.toFixed(4)}/${model.usdPer1kOut?.toFixed(4) ?? "?"}
          </span>
        )}
      </div>
    </button>
  );
}

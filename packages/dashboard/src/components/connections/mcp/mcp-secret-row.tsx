"use client";

import { useState } from "react";
import { CheckCircle2, Eye, EyeOff, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  useDeleteMcpSecret,
  useSetMcpSecret,
} from "@/lib/hooks/use-mcp";

export interface McpSecretRowProps {
  serverId: string;
  keyName: string;
  present: boolean;
}

/**
 * One row per declared envKey / headerKey. The stored value itself is never
 * returned from the API — we only get a boolean presence flag. Saving a new
 * value replaces the previous one atomically.
 */
export function McpSecretRow({ serverId, keyName, present }: McpSecretRowProps) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setMutation = useSetMcpSecret();
  const deleteMutation = useDeleteMcpSecret();

  const handleSave = async () => {
    if (!value) return;
    setError(null);
    try {
      await setMutation.mutateAsync({ id: serverId, keyName, value });
      setValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  };

  const handleDelete = async () => {
    setError(null);
    try {
      await deleteMutation.mutateAsync({ id: serverId, keyName });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <code className="font-mono text-foreground min-w-[100px]">{keyName}</code>
      <div className="relative flex-1">
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
          }}
          placeholder={present ? "(stored — enter to replace)" : "enter value"}
          className="h-7 text-xs pr-8 font-mono"
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={show ? "Hide value" : "Show value"}
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs px-2 shrink-0"
        onClick={handleSave}
        disabled={setMutation.isPending || !value}
      >
        {setMutation.isPending ? "…" : "Save"}
      </Button>
      {present && (
        <>
          <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="text-muted-foreground hover:text-destructive shrink-0"
            aria-label="Delete stored secret"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      {error && (
        <span className="text-destructive text-[11px]">{error}</span>
      )}
    </div>
  );
}

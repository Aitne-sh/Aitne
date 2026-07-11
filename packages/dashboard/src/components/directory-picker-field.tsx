"use client";

import { useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pickDirectoryFromDesktop } from "@/lib/directory-picker";
import { cn } from "@/lib/utils";

export function DirectoryPickerField({
  id,
  value,
  onChange,
  onCommit,
  title,
  placeholder = "Choose a folder...",
  defaultPath,
  disabled = false,
  className,
  inputClassName,
  buttonLabel = "Choose",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  title: string;
  placeholder?: string;
  defaultPath?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  buttonLabel?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const handlePick = async () => {
    setPicking(true);
    setPickerError(null);
    try {
      const selected = await pickDirectoryFromDesktop({
        title,
        defaultPath: value.trim() || defaultPath,
      });
      if (selected) {
        onChange(selected);
        onCommit?.(selected);
      }
    } catch (err) {
      setPickerError(
        err instanceof Error ? err.message : "Folder picker is unavailable.",
      );
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setPickerError(null);
          }}
          onBlur={(e) => onCommit?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit?.(e.currentTarget.value);
          }}
          placeholder={placeholder}
          className={cn("font-mono text-sm", inputClassName)}
          disabled={disabled || picking}
        />
        <Button
          type="button"
          variant="outline"
          onClick={handlePick}
          disabled={disabled || picking}
          className="shrink-0 gap-2"
        >
          {picking ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FolderOpen className="h-4 w-4" />
          )}
          {picking ? "Opening..." : buttonLabel}
        </Button>
      </div>
      {pickerError && (
        <p className="text-xs text-destructive">{pickerError}</p>
      )}
    </div>
  );
}

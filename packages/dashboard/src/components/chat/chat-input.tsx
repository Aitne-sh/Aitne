"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { ArrowUp, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAttachments } from "@/lib/hooks/use-attachments";
import type { ChatAttachment } from "@/lib/hooks/use-chat";

interface ChatInputProps {
  onSend: (content: string, attachments: ChatAttachment[]) => void;
  disabled: boolean;
  disabledMessage?: string;
  placeholder?: string;
  /** Override the outer wrapper classes. Pass `border-t-0` when the parent
   *  supplies its own top divider (e.g. the chat page wraps the picker and
   *  the input in a shared border-t block). */
  className?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ChatInput({
  onSend,
  disabled,
  disabledMessage,
  placeholder,
  className,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const {
    pending,
    ready,
    uploading,
    addFiles,
    remove,
    clear,
    error,
  } = useAttachments();

  const canSend =
    !disabled
    && !uploading
    && (value.trim().length > 0 || ready.length > 0);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    onSend(value.trim(), ready);
    setValue("");
    clear();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [canSend, clear, onSend, ready, value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  const handleFilesPicked = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    addFiles(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const files = e.dataTransfer.files;
    if (files.length > 0) addFiles(files);
  };

  // Paste-image handler — Ctrl+V of a screenshot uploads as an attachment.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onPaste = (ev: ClipboardEvent) => {
      if (disabled) return;
      const items = ev.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        ev.preventDefault();
        addFiles(files);
      }
    };
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  }, [addFiles, disabled]);

  return (
    <div
      className={cn(
        "border-t border-border bg-background px-4 pt-3 pb-4",
        isDragging && "bg-primary/5",
        className,
      )}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {disabled && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{disabledMessage ?? "Agent is generating a response — please wait"}</span>
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((item) => (
            <div
              key={item.clientId}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1 text-xs",
                item.status === "error"
                  ? "border-destructive/40 bg-destructive/5 text-destructive"
                  : "border-border bg-muted/40",
              )}
            >
              <Paperclip className="h-3 w-3 flex-shrink-0" />
              <span className="max-w-[160px] truncate" title={item.file.name}>
                {item.file.name}
              </span>
              <span className="text-muted-foreground">{formatSize(item.sizeBytes)}</span>
              {item.status === "uploading" && (
                <span className="text-muted-foreground">{item.progress}%</span>
              )}
              {item.status === "error" && item.error && (
                <span className="text-muted-foreground/80" title={item.error}>
                  failed
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(item.clientId)}
                className="ml-1 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${item.file.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-2 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFilesPicked(e.target.files);
            // Reset so selecting the same file twice still fires onChange.
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          aria-label="Attach files"
          title="Attach files"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={placeholder ?? (disabled ? "Waiting for response…" : "Message the agent...")}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!canSend}
        >
          {disabled || uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { FileText, Paperclip, FileImage, FileSpreadsheet, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatAttachment } from "@/lib/hooks/use-chat";

const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentIcon({ mimeType, className }: { mimeType: string; className: string }) {
  if (mimeType.startsWith("image/")) return <FileImage className={className} />;
  if (mimeType === "application/pdf") return <FileText className={className} />;
  if (
    mimeType.includes("spreadsheet")
    || mimeType === "text/csv"
    || mimeType.includes("excel")
  ) return <FileSpreadsheet className={className} />;
  return <Paperclip className={className} />;
}

function InlineImage({ id, alt }: { id: string; alt: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Fetch via the authenticated dashboard proxy (Bearer attached in the
    // Next.js [...path] route). Using a blob URL avoids leaking the token
    // into `<img src>` referrers.
    let cancelled = false;
    let currentUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(`/api/chat/attachments/${id}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setBlobUrl(currentUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [id]);

  if (failed) return null;
  if (!blobUrl) {
    return (
      <div className="flex h-32 w-full max-w-xs items-center justify-center rounded-md border border-border bg-muted/20 text-xs text-muted-foreground">
        loading…
      </div>
    );
  }
  return (
    // Using <img> intentionally — the blob URL is produced after an
    // authenticated fetch, which next/image cannot replicate without
    // a custom loader that forwards Bearer auth to the daemon.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={blobUrl}
      alt={alt}
      className="max-h-64 max-w-full rounded-md border border-border"
    />
  );
}

interface AttachmentChipProps {
  attachment: ChatAttachment;
  isOwn: boolean;
}

function AttachmentChip({ attachment, isOwn }: AttachmentChipProps) {
  const href = `/api/chat/attachments/${attachment.id}`;
  const isImage = attachment.mimeType.startsWith("image/") && attachment.mimeType !== "image/svg+xml";
  const shouldInline = isImage && attachment.sizeBytes < INLINE_IMAGE_MAX_BYTES;

  return (
    <div className="space-y-1">
      {shouldInline && (
        <InlineImage id={attachment.id} alt={attachment.originalFilename} />
      )}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs hover:bg-muted/40",
          isOwn
            ? "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground"
            : "border-border bg-muted/30 text-foreground",
        )}
        title={attachment.caption ?? attachment.originalFilename}
      >
        <AttachmentIcon mimeType={attachment.mimeType} className="h-3 w-3 flex-shrink-0" />
        <span className="max-w-[160px] truncate">{attachment.originalFilename}</span>
        <span className="text-muted-foreground">{formatSize(attachment.sizeBytes)}</span>
        <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-60" />
      </a>
      {attachment.caption && (
        <p className="px-1 text-[10px] text-muted-foreground italic">{attachment.caption}</p>
      )}
    </div>
  );
}

export function MessageAttachments({
  attachments,
  isOwn,
}: {
  attachments: ChatAttachment[];
  isOwn: boolean;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {attachments.map((att) => (
        <AttachmentChip key={att.id} attachment={att} isOwn={isOwn} />
      ))}
    </div>
  );
}

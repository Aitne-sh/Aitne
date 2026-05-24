"use client";

import { useCallback, useRef, useState } from "react";
import type { ChatAttachment } from "@/lib/hooks/use-chat";

/** Per-file caps mirrored from daemon's `attachments.ts`. Enforced
 *  client-side so oversize uploads are blocked before they hit the
 *  network — the server also enforces, but a local check avoids
 *  wasting bandwidth on a 25 MB PDF that would be rejected at the
 *  edge. Keep in sync with `ATTACHMENT_LIMITS`. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const NON_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const PER_TURN_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_CONCURRENT_UPLOADS = 5;

export interface PendingUpload {
  /** Stable local id; replaced by the server id once uploaded. */
  clientId: string;
  /** Filled when the upload succeeds — this is the id we send to
   *  POST /api/chat/messages in `attachmentIds`. */
  serverId: string | null;
  file: File;
  progress: number; // 0–100
  status: "uploading" | "uploaded" | "error";
  error?: string;
  mimeType?: string;
  sizeBytes: number;
}

/** Pick the right client-side size cap based on MIME type. */
function maxBytesFor(file: File): number {
  return file.type.startsWith("image/") ? IMAGE_MAX_BYTES : NON_IMAGE_MAX_BYTES;
}

function newClientId(): string {
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * useAttachments — client-side upload orchestration for the chat composer.
 *
 * - Tracks the pending upload list (chips rendered above the textarea).
 * - Enforces per-file + per-turn caps before firing the network call.
 * - Uses `XMLHttpRequest` (not `fetch`) so upload progress is observable
 *   via `onprogress` — the Fetch API doesn't expose request-body progress
 *   in any current browser.
 */
export function useAttachments(): {
  pending: PendingUpload[];
  /** Ready-for-send refs — only uploads that completed successfully. */
  ready: ChatAttachment[];
  /** True while at least one upload is in flight. Disables the Send button. */
  uploading: boolean;
  addFiles: (files: FileList | File[]) => void;
  remove: (clientId: string) => void;
  clear: () => void;
  /** Current error message (set when add-files rejects e.g. per-turn cap). */
  error: string | null;
} {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const xhrsRef = useRef<Map<string, XMLHttpRequest>>(new Map());

  const updatePending = useCallback(
    (clientId: string, update: Partial<PendingUpload>) => {
      setPending((prev) =>
        prev.map((item) => (item.clientId === clientId ? { ...item, ...update } : item)),
      );
    },
    [],
  );

  const totalBytesInFlight = useCallback(
    (list: PendingUpload[], extra = 0): number => {
      return list.reduce((acc, item) => acc + item.sizeBytes, 0) + extra;
    },
    [],
  );

  const remove = useCallback((clientId: string) => {
    const xhr = xhrsRef.current.get(clientId);
    if (xhr) {
      xhr.abort();
      xhrsRef.current.delete(clientId);
    }
    setPending((prev) => prev.filter((item) => item.clientId !== clientId));
    // Best-effort server-side delete for successfully uploaded refs.
    setPending((cur) => {
      const found = cur.find((p) => p.clientId === clientId);
      if (found?.serverId) {
        void fetch(`/api/chat/attachments/${found.serverId}`, { method: "DELETE" }).catch(() => {});
      }
      return cur;
    });
  }, []);

  const clear = useCallback(() => {
    for (const xhr of xhrsRef.current.values()) xhr.abort();
    xhrsRef.current.clear();
    setPending([]);
    setError(null);
  }, []);

  const uploadOne = useCallback(
    (item: PendingUpload) => {
      const xhr = new XMLHttpRequest();
      xhrsRef.current.set(item.clientId, xhr);
      xhr.open("POST", "/api/chat/attachments");
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          updatePending(item.clientId, {
            progress: Math.round((evt.loaded / evt.total) * 100),
          });
        }
      };
      xhr.onload = () => {
        xhrsRef.current.delete(item.clientId);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText) as {
              id: string;
              mimeType: string;
              sizeBytes: number;
            };
            updatePending(item.clientId, {
              serverId: body.id,
              mimeType: body.mimeType,
              progress: 100,
              status: "uploaded",
            });
          } catch {
            updatePending(item.clientId, {
              status: "error",
              error: "Malformed response from server",
            });
          }
        } else {
          let msg = `Upload failed (${xhr.status})`;
          try {
            const body = JSON.parse(xhr.responseText) as { message?: string };
            if (body.message) msg = body.message;
          } catch { /* ignore */ }
          updatePending(item.clientId, { status: "error", error: msg });
        }
      };
      xhr.onerror = () => {
        xhrsRef.current.delete(item.clientId);
        updatePending(item.clientId, {
          status: "error",
          error: "Network error during upload",
        });
      };
      const form = new FormData();
      form.append("file", item.file, item.file.name);
      xhr.send(form);
    },
    [updatePending],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      setError(null);
      const list = Array.from(files);
      if (list.length === 0) return;

      setPending((prev) => {
        if (prev.filter((p) => p.status === "uploading").length + list.length > MAX_CONCURRENT_UPLOADS) {
          setError(`At most ${MAX_CONCURRENT_UPLOADS} concurrent uploads`);
          return prev;
        }
        const running = totalBytesInFlight(prev);
        let runningBytes = running;
        const newItems: PendingUpload[] = [];
        for (const file of list) {
          const cap = maxBytesFor(file);
          if (file.size > cap) {
            setError(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — over the ${(cap / 1024 / 1024).toFixed(0)} MB limit`);
            continue;
          }
          if (runningBytes + file.size > PER_TURN_MAX_BYTES) {
            setError(`Per-turn cap is ${(PER_TURN_MAX_BYTES / 1024 / 1024).toFixed(0)} MB — skipping the rest`);
            break;
          }
          runningBytes += file.size;
          const item: PendingUpload = {
            clientId: newClientId(),
            serverId: null,
            file,
            progress: 0,
            status: "uploading",
            sizeBytes: file.size,
          };
          newItems.push(item);
        }
        for (const item of newItems) void queueMicrotask(() => uploadOne(item));
        return [...prev, ...newItems];
      });
    },
    [totalBytesInFlight, uploadOne],
  );

  const uploading = pending.some((p) => p.status === "uploading");
  const ready: ChatAttachment[] = pending
    .filter((p) => p.status === "uploaded" && p.serverId !== null)
    .map((p) => ({
      id: p.serverId!,
      originalFilename: p.file.name,
      mimeType: p.mimeType ?? (p.file.type || "application/octet-stream"),
      sizeBytes: p.sizeBytes,
    }));

  return { pending, ready, uploading, addFiles, remove, clear, error };
}

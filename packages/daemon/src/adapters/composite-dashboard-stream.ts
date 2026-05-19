import type { IDashboardStream } from "../core/dispatcher.js";
import type { SessionInfoPayload } from "../api/chat-binding-query.js";

/**
 * Fan-out wrapper for the dispatcher's single `IDashboardStream` slot.
 *
 * The dispatcher only knows one outbound stream at a time
 * (`setDashboardStream(adapter)`), but Phase 2 of the docs-QA pipeline
 * introduces a second dashboard-platform adapter (`DocsQAAdapter`)
 * that needs to receive the same outbound calls. Channel routing is
 * content-addressed by `channelId` (each underlying adapter no-ops on
 * unknown ids per `dashboard-adapter.ts:211-218`), so fan-out is
 * naturally safe — only the adapter that owns the channel actually
 * emits.
 *
 * Class members are declared concrete (no `?`) even when the
 * `IDashboardStream` member is optional — the composite always fans
 * out the call; each underlying stream may or may not implement the
 * optional method, so we guard with `s.method?.(...)` per
 * DOCS_QA_B7_DESIGN.md §11.4.
 */
export class CompositeDashboardStream implements IDashboardStream {
  constructor(private readonly streams: readonly IDashboardStream[]) {}

  sendStreamChunk(channelId: string, chunk: string): void {
    for (const s of this.streams) s.sendStreamChunk(channelId, chunk);
  }

  sendStreamEnd(channelId: string): void {
    for (const s of this.streams) s.sendStreamEnd(channelId);
  }

  sendMessageMeta(
    channelId: string,
    meta: { backend?: string; model?: string; durationMs?: number; costUsd?: number },
  ): void {
    for (const s of this.streams) s.sendMessageMeta?.(channelId, meta);
  }

  sendSessionInfo(channelId: string, info: SessionInfoPayload): void {
    for (const s of this.streams) s.sendSessionInfo?.(channelId, info);
  }

  sendError(channelId: string, message: string): void {
    for (const s of this.streams) s.sendError?.(channelId, message);
  }

  sendAttachments(
    channelId: string,
    attachments: Array<{
      id: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      caption?: string;
    }>,
  ): void {
    for (const s of this.streams) s.sendAttachments?.(channelId, attachments);
  }
}

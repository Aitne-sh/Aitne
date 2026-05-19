import { describe, expect, it, vi } from "vitest";
import { CompositeDashboardStream } from "./composite-dashboard-stream.js";
import type { IDashboardStream } from "../core/dispatcher.js";

function makeStub(): IDashboardStream & {
  sendStreamChunk: ReturnType<typeof vi.fn>;
  sendStreamEnd: ReturnType<typeof vi.fn>;
  sendMessageMeta: ReturnType<typeof vi.fn>;
  sendSessionInfo: ReturnType<typeof vi.fn>;
  sendError: ReturnType<typeof vi.fn>;
  sendAttachments: ReturnType<typeof vi.fn>;
} {
  return {
    sendStreamChunk: vi.fn(),
    sendStreamEnd: vi.fn(),
    sendMessageMeta: vi.fn(),
    sendSessionInfo: vi.fn(),
    sendError: vi.fn(),
    sendAttachments: vi.fn(),
  };
}

describe("CompositeDashboardStream", () => {
  it("fans out required methods to every underlying stream", () => {
    const a = makeStub();
    const b = makeStub();
    const composite = new CompositeDashboardStream([a, b]);

    composite.sendStreamChunk("ch", "hello");
    composite.sendStreamEnd("ch");

    expect(a.sendStreamChunk).toHaveBeenCalledWith("ch", "hello");
    expect(b.sendStreamChunk).toHaveBeenCalledWith("ch", "hello");
    expect(a.sendStreamEnd).toHaveBeenCalledWith("ch");
    expect(b.sendStreamEnd).toHaveBeenCalledWith("ch");
  });

  it("fans out optional methods when implemented and skips them when not", () => {
    const full = makeStub();
    // Stream B implements only the required surface — optional methods absent.
    const partial: IDashboardStream = {
      sendStreamChunk: vi.fn(),
      sendStreamEnd: vi.fn(),
    };
    const composite = new CompositeDashboardStream([full, partial]);

    // Should not throw even though `partial` lacks every optional method.
    composite.sendMessageMeta("ch", { backend: "claude", model: "claude-sonnet-4-6" });
    composite.sendSessionInfo("ch", { channelId: "ch", model: "claude-sonnet-4-6" });
    composite.sendError("ch", "boom");
    composite.sendAttachments("ch", [
      { id: "a1", originalFilename: "f.png", mimeType: "image/png", sizeBytes: 10 },
    ]);

    expect(full.sendMessageMeta).toHaveBeenCalledWith("ch", {
      backend: "claude",
      model: "claude-sonnet-4-6",
    });
    expect(full.sendSessionInfo).toHaveBeenCalledWith("ch", {
      channelId: "ch",
      model: "claude-sonnet-4-6",
    });
    expect(full.sendError).toHaveBeenCalledWith("ch", "boom");
    expect(full.sendAttachments).toHaveBeenCalledWith("ch", [
      { id: "a1", originalFilename: "f.png", mimeType: "image/png", sizeBytes: 10 },
    ]);
  });

  it("preserves call order across underlying streams", () => {
    const order: string[] = [];
    const a: IDashboardStream = {
      sendStreamChunk: () => {
        order.push("a");
      },
      sendStreamEnd: () => {},
    };
    const b: IDashboardStream = {
      sendStreamChunk: () => {
        order.push("b");
      },
      sendStreamEnd: () => {},
    };
    new CompositeDashboardStream([a, b]).sendStreamChunk("ch", "x");
    expect(order).toEqual(["a", "b"]);
  });

  it("works with an empty stream list (no-op for every method)", () => {
    const composite = new CompositeDashboardStream([]);
    expect(() => composite.sendStreamChunk("ch", "x")).not.toThrow();
    expect(() => composite.sendStreamEnd("ch")).not.toThrow();
    expect(() => composite.sendMessageMeta("ch", {})).not.toThrow();
    expect(() => composite.sendSessionInfo("ch", { channelId: "ch" })).not.toThrow();
    expect(() => composite.sendError("ch", "msg")).not.toThrow();
    expect(() => composite.sendAttachments("ch", [])).not.toThrow();
  });
});

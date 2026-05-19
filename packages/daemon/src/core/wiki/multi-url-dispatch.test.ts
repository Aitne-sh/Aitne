import { describe, expect, it, vi } from "vitest";
import { dispatchWikiUrlBatch } from "./multi-url-dispatch.js";

describe("dispatchWikiUrlBatch", () => {
  it("queues one wiki.ingest_url event per URL with a shared batch id (parallel)", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const result = await dispatchWikiUrlBatch({
      workspace: "default",
      urls: ["https://a.test/", "https://b.test/"],
      mode: "parallel",
      concurrencyCap: 3,
      enqueue,
    });

    expect(result.queued).toBe(2);
    expect(result.mode).toBe("parallel");
    expect(enqueue).toHaveBeenCalledTimes(2);
    const events = enqueue.mock.calls.map((call) => call[0]);
    expect(events.map((event) => event.type)).toEqual([
      "wiki.ingest_url",
      "wiki.ingest_url",
    ]);
    expect(events[0].data.batch_id).toBe(result.batchId);
    expect(events[1].data.batch_id).toBe(result.batchId);
    expect(events.map((event) => event.data.url).sort()).toEqual([
      "https://a.test/",
      "https://b.test/",
    ]);
  });

  it("respects the parallel worker cap when more URLs than cap", async () => {
    const inFlight: string[] = [];
    let maxInFlight = 0;
    const enqueue = vi.fn(async (event) => {
      inFlight.push(event.data.url as string);
      maxInFlight = Math.max(maxInFlight, inFlight.length);
      await new Promise((res) => setTimeout(res, 10));
      inFlight.shift();
    });
    const urls = Array.from({ length: 6 }, (_, i) => `https://x${i}.test/`);
    const result = await dispatchWikiUrlBatch({
      workspace: "default",
      urls,
      mode: "parallel",
      concurrencyCap: 2,
      enqueue,
    });
    expect(result.queued).toBe(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("enqueues serially when mode=serial — ordering matches input", async () => {
    const seen: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const enqueue = vi.fn(async (event) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      seen.push(event.data.url as string);
      await new Promise((res) => setTimeout(res, 5));
      inFlight -= 1;
    });
    const result = await dispatchWikiUrlBatch({
      workspace: "default",
      urls: ["https://1.test/", "https://2.test/", "https://3.test/"],
      mode: "serial",
      concurrencyCap: 5,
      enqueue,
    });
    expect(result.mode).toBe("serial");
    expect(maxInFlight).toBe(1);
    expect(seen).toEqual([
      "https://1.test/",
      "https://2.test/",
      "https://3.test/",
    ]);
  });

  it("aborts the batch on enqueue failure (serial)", async () => {
    const enqueue = vi.fn().mockImplementation(async (event) => {
      if (event.data.url === "https://bad.test/") {
        throw new Error("eventbus full");
      }
    });
    await expect(
      dispatchWikiUrlBatch({
        workspace: "default",
        urls: ["https://ok.test/", "https://bad.test/", "https://skip.test/"],
        mode: "serial",
        concurrencyCap: 1,
        enqueue,
      }),
    ).rejects.toThrow(/eventbus full/);
    // The third URL must never be enqueued because the second failed.
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("returns zero counts when called with an empty URL list", async () => {
    const enqueue = vi.fn();
    const result = await dispatchWikiUrlBatch({
      workspace: "default",
      urls: [],
      mode: "parallel",
      concurrencyCap: 3,
      enqueue,
    });
    expect(result.queued).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

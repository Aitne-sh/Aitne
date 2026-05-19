import { describe, it, expect, beforeEach } from "vitest";
import {
  recordActivityViewRebuildDuration,
  recordEntityMirrorLag,
  recordManagementMdRenderDuration,
  resetManagementTelemetry,
  snapshotManagementTelemetry,
  summarize,
} from "./management-telemetry.js";

describe("management-telemetry", () => {
  beforeEach(() => {
    resetManagementTelemetry();
  });

  describe("summarize (pure)", () => {
    it("returns nulls for empty input", () => {
      const result = summarize([]);
      expect(result).toEqual({
        count: 0,
        sum: 0,
        min: null,
        max: null,
        avg: null,
        p50: null,
        p90: null,
        p95: null,
      });
    });

    it("computes count/sum/min/max/avg over a single sample", () => {
      const result = summarize([42]);
      expect(result.count).toBe(1);
      expect(result.sum).toBe(42);
      expect(result.min).toBe(42);
      expect(result.max).toBe(42);
      expect(result.avg).toBe(42);
      expect(result.p50).toBe(42);
      expect(result.p90).toBe(42);
      expect(result.p95).toBe(42);
    });

    it("computes nearest-rank quantiles over a sorted distribution", () => {
      const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
      const result = summarize(samples);
      expect(result.count).toBe(100);
      expect(result.sum).toBe(5050);
      expect(result.min).toBe(1);
      expect(result.max).toBe(100);
      expect(result.avg).toBeCloseTo(50.5);
      // Nearest-rank: floor(100 * 0.5) = 50 → samples[50] = 51
      expect(result.p50).toBe(51);
      expect(result.p90).toBe(91);
      expect(result.p95).toBe(96);
    });

    it("does not mutate the input array", () => {
      const samples = [3, 1, 2];
      const before = [...samples];
      summarize(samples);
      expect(samples).toEqual(before);
    });
  });

  describe("recordManagementMdRenderDuration", () => {
    it("appends samples that surface in the snapshot", () => {
      recordManagementMdRenderDuration(10);
      recordManagementMdRenderDuration(20);
      recordManagementMdRenderDuration(30);

      const snap = snapshotManagementTelemetry();
      expect(snap.managementMdRenderMs.count).toBe(3);
      expect(snap.managementMdRenderMs.sum).toBe(60);
      expect(snap.managementMdRenderMs.avg).toBe(20);
    });

    it("ignores NaN, Infinity, and negative values", () => {
      recordManagementMdRenderDuration(Number.NaN);
      recordManagementMdRenderDuration(Number.POSITIVE_INFINITY);
      recordManagementMdRenderDuration(-5);
      recordManagementMdRenderDuration(7);

      const snap = snapshotManagementTelemetry();
      expect(snap.managementMdRenderMs.count).toBe(1);
      expect(snap.managementMdRenderMs.sum).toBe(7);
    });

    it("caps the ring buffer at 256 samples (FIFO eviction)", () => {
      for (let i = 0; i < 300; i++) {
        recordManagementMdRenderDuration(i);
      }
      const snap = snapshotManagementTelemetry();
      expect(snap.managementMdRenderMs.count).toBe(256);
      // Oldest 44 samples (0..43) should have been evicted, so the
      // smallest remaining sample is 44.
      expect(snap.managementMdRenderMs.min).toBe(44);
      expect(snap.managementMdRenderMs.max).toBe(299);
    });
  });

  describe("recordActivityViewRebuildDuration", () => {
    it("groups samples by source label", () => {
      recordActivityViewRebuildDuration("zoom", 10);
      recordActivityViewRebuildDuration("zoom", 20);
      recordActivityViewRebuildDuration("gmail", 5);

      const snap = snapshotManagementTelemetry();
      const bySource = Object.fromEntries(
        snap.activityViewRebuildMs.map((b) => [b.source, b.histogram]),
      );
      expect(bySource.zoom?.count).toBe(2);
      expect(bySource.zoom?.avg).toBe(15);
      expect(bySource.gmail?.count).toBe(1);
      expect(bySource.gmail?.avg).toBe(5);
    });

    it("returns sources sorted lexicographically for deterministic snapshots", () => {
      recordActivityViewRebuildDuration("zoom", 1);
      recordActivityViewRebuildDuration("acme", 1);
      recordActivityViewRebuildDuration("notion", 1);

      const snap = snapshotManagementTelemetry();
      expect(snap.activityViewRebuildMs.map((b) => b.source)).toEqual([
        "acme",
        "notion",
        "zoom",
      ]);
    });

    it("ignores empty source labels and invalid durations", () => {
      recordActivityViewRebuildDuration("", 10);
      recordActivityViewRebuildDuration("zoom", -10);
      recordActivityViewRebuildDuration("zoom", Number.NaN);

      const snap = snapshotManagementTelemetry();
      expect(snap.activityViewRebuildMs).toEqual([]);
    });

    it("evicts oldest samples per source above the buffer cap", () => {
      for (let i = 0; i < 300; i++) {
        recordActivityViewRebuildDuration("zoom", i);
      }
      const snap = snapshotManagementTelemetry();
      const zoom = snap.activityViewRebuildMs.find(
        (b) => b.source === "zoom",
      )?.histogram;
      expect(zoom?.count).toBe(256);
      expect(zoom?.min).toBe(44);
      expect(zoom?.max).toBe(299);
    });
  });

  describe("recordEntityMirrorLag", () => {
    it("captures the latest lag and timestamp", () => {
      const observedAt = new Date("2026-05-03T12:00:00Z");
      recordEntityMirrorLag(123, observedAt);

      const snap = snapshotManagementTelemetry();
      expect(snap.entityMirrorLag.lastMs).toBe(123);
      expect(snap.entityMirrorLag.observedAt).toBe("2026-05-03T12:00:00.000Z");
    });

    it("is a gauge — successive calls overwrite the previous value", () => {
      recordEntityMirrorLag(50);
      recordEntityMirrorLag(120);
      const snap = snapshotManagementTelemetry();
      expect(snap.entityMirrorLag.lastMs).toBe(120);
    });

    it("ignores invalid durations (NaN, Infinity, negative)", () => {
      recordEntityMirrorLag(40);
      recordEntityMirrorLag(Number.NaN);
      recordEntityMirrorLag(-10);
      recordEntityMirrorLag(Number.POSITIVE_INFINITY);

      const snap = snapshotManagementTelemetry();
      expect(snap.entityMirrorLag.lastMs).toBe(40);
    });
  });

  describe("resetManagementTelemetry", () => {
    it("clears all buffers and the gauge", () => {
      recordManagementMdRenderDuration(10);
      recordActivityViewRebuildDuration("zoom", 5);
      recordEntityMirrorLag(99);

      resetManagementTelemetry();

      const snap = snapshotManagementTelemetry();
      expect(snap.managementMdRenderMs.count).toBe(0);
      expect(snap.activityViewRebuildMs).toEqual([]);
      expect(snap.entityMirrorLag.lastMs).toBeNull();
      expect(snap.entityMirrorLag.observedAt).toBeNull();
    });
  });

  describe("snapshotManagementTelemetry", () => {
    it("does not mutate the underlying buffers", () => {
      recordManagementMdRenderDuration(10);
      const snap1 = snapshotManagementTelemetry();
      const snap2 = snapshotManagementTelemetry();
      expect(snap1).toEqual(snap2);
    });
  });
});

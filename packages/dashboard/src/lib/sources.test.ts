import { describe, expect, it } from "vitest";
import type { ManagedTask } from "@aitne/shared";
import { extractSources, mergeActivitySources } from "./sources";

function task(partial: Partial<ManagedTask> & { id: string; app: string }): ManagedTask {
  return {
    id: partial.id,
    intent: partial.intent ?? "fetch",
    app: partial.app,
    app_normalized: partial.app_normalized ?? partial.app.toLowerCase(),
    cadence: partial.cadence ?? "daily 10:00",
    output_path: partial.output_path ?? null,
    schedule_id: partial.schedule_id ?? 1,
    last_run_at: partial.last_run_at ?? null,
    last_result: partial.last_result ?? null,
    consecutive_failures: partial.consecutive_failures ?? 0,
    created_at: partial.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: partial.updated_at ?? "2026-01-01T00:00:00Z",
  };
}

describe("extractSources", () => {
  it("returns [] for undefined input", () => {
    expect(extractSources(undefined)).toEqual([]);
  });

  it("returns [] for empty array", () => {
    expect(extractSources([])).toEqual([]);
  });

  it("dedups by normalized app label", () => {
    const sources = extractSources([
      task({ id: "mt_1", app: "Zoom" }),
      task({ id: "mt_2", app: "ZOOM" }),
      task({ id: "mt_3", app: "zoom" }),
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual({
      normalized: "zoom",
      label: "Zoom",
      count: 3,
      status: "active",
    });
  });

  it("preserves the first user-typed label seen for the bucket", () => {
    const sources = extractSources([
      task({ id: "mt_1", app: "Notion" }),
      task({ id: "mt_2", app: "notion" }),
    ]);
    expect(sources[0].label).toBe("Notion");
  });

  it("sorts results by label.localeCompare", () => {
    const sources = extractSources([
      task({ id: "mt_1", app: "Zoom" }),
      task({ id: "mt_2", app: "Asana" }),
      task({ id: "mt_3", app: "GitHub" }),
    ]);
    expect(sources.map((s) => s.label)).toEqual(["Asana", "GitHub", "Zoom"]);
  });

  it("counts each task once even when the bucket is seeded later", () => {
    const sources = extractSources([
      task({ id: "mt_1", app: "Asana" }),
      task({ id: "mt_2", app: "Zoom" }),
      task({ id: "mt_3", app: "asana" }),
    ]);
    const asana = sources.find((s) => s.normalized === "asana");
    expect(asana?.count).toBe(2);
  });

  it("marks every entry as `active` (the daemon's wider union is merged separately)", () => {
    const sources = extractSources([task({ id: "mt_1", app: "Zoom" })]);
    expect(sources[0].status).toBe("active");
  });
});

describe("mergeActivitySources", () => {
  const active = extractSources([task({ id: "mt_1", app: "Zoom" })]);

  it("returns the active list unchanged when no remote sources are provided", () => {
    expect(mergeActivitySources(active, undefined)).toEqual(active);
    expect(mergeActivitySources(active, [])).toEqual(active);
  });

  it("appends `stopped` entries for sources only present in the daemon's union", () => {
    const merged = mergeActivitySources(active, [
      { label: "Zoom", normalized: "zoom", status: "active" },
      { label: "Old App", normalized: "old app", status: "stopped" },
    ]);
    const stopped = merged.find((s) => s.normalized === "old app");
    expect(stopped).toEqual({
      label: "Old App",
      normalized: "old app",
      count: 0,
      status: "stopped",
    });
  });

  it("does not overwrite an active row when the remote also lists it", () => {
    const merged = mergeActivitySources(active, [
      { label: "ZOOM", normalized: "zoom", status: "active" },
    ]);
    const zoom = merged.find((s) => s.normalized === "zoom");
    expect(zoom?.label).toBe("Zoom"); // active label wins
    expect(zoom?.count).toBe(1);
  });

  it("sorts the merged list by label", () => {
    const merged = mergeActivitySources(active, [
      { label: "Asana", normalized: "asana", status: "stopped" },
    ]);
    expect(merged.map((s) => s.label)).toEqual(["Asana", "Zoom"]);
  });
});

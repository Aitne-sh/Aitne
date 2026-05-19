import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompilePreview } from "./compile-preview.js";
import type { WikiWorkspaceRow } from "./workspaces.js";

function makeWorkspace(rootPath: string, lastCompileAt: string | null = null): WikiWorkspaceRow {
  return {
    id: 1,
    name: "default",
    kind: "internal",
    root_path: rootPath,
    language: "en",
    dispatch_mode: "parallel",
    concurrency_cap: 3,
    dm_agent_write_enabled: 0,
    bridge_enabled: 0,
    bridge_measurement_only: 1,
    bridge_min_confidence: 0.7,
    full_compile_approval_threshold_usd: 2,
    write_strategy: "fs",
    git_pre_compile_enabled: 1,
    schema_version: 1,
    active: 1,
    last_ingest_at: null,
    last_compile_at: lastCompileAt,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
  };
}

describe("buildCompilePreview", () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-preview-"));
    mkdirSync(join(rootPath, "10_raw"));
    mkdirSync(join(rootPath, "20_wiki"));
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("classifies raws with matching wiki pages as 'modified' and rest as 'added'", () => {
    writeFileSync(join(rootPath, "10_raw/quantum.md"), "# Source\n\nraw note about quantum.");
    writeFileSync(join(rootPath, "10_raw/relativity.md"), "# Source\n\nraw note about relativity.");
    writeFileSync(join(rootPath, "20_wiki/quantum.md"), "# Quantum\n\nexisting wiki page.");

    const preview = buildCompilePreview({
      workspace: makeWorkspace(rootPath),
      mode: "full",
    });
    expect(preview.added).toEqual(["20_wiki/relativity.md"]);
    expect(preview.modified).toEqual(["20_wiki/quantum.md"]);
    expect(preview.unchanged).toEqual([]);
  });

  it("incremental mode marks raws older than last_compile_at as unchanged", () => {
    writeFileSync(join(rootPath, "10_raw/old.md"), "# Old");
    writeFileSync(join(rootPath, "10_raw/new.md"), "# New");
    // Set `old.md` mtime to 2026-01-01; last_compile_at = 2026-03-01.
    const oldTime = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(rootPath, "10_raw/old.md"), oldTime, oldTime);
    const newTime = new Date("2026-04-01T00:00:00Z");
    utimesSync(join(rootPath, "10_raw/new.md"), newTime, newTime);

    const preview = buildCompilePreview({
      workspace: makeWorkspace(rootPath, "2026-03-01 00:00:00"),
      mode: "incremental",
    });
    expect(preview.added.sort()).toEqual(["20_wiki/new.md"]);
    expect(preview.unchanged).toContain("10_raw/old.md");
  });

  it("full mode reprocesses everything regardless of last_compile_at", () => {
    writeFileSync(join(rootPath, "10_raw/x.md"), "# X");
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(rootPath, "10_raw/x.md"), old, old);

    const preview = buildCompilePreview({
      workspace: makeWorkspace(rootPath, "2026-05-01 00:00:00"),
      mode: "full",
    });
    expect(preview.added).toEqual(["20_wiki/x.md"]);
    expect(preview.unchanged).toEqual([]);
  });

  it("scales the cost estimate to the pending set in incremental mode", () => {
    // 4 raws, 1 pending after last_compile_at = ratio 0.25.
    for (const name of ["a", "b", "c", "d"]) {
      writeFileSync(join(rootPath, `10_raw/${name}.md`), "# X\n\n" + "lorem ".repeat(200));
    }
    const ancient = new Date("2020-01-01T00:00:00Z");
    for (const name of ["a", "b", "c"]) {
      utimesSync(join(rootPath, `10_raw/${name}.md`), ancient, ancient);
    }
    const recent = new Date("2026-04-01T00:00:00Z");
    utimesSync(join(rootPath, "10_raw/d.md"), recent, recent);

    const fullPreview = buildCompilePreview({
      workspace: makeWorkspace(rootPath),
      mode: "full",
    });
    const incrementalPreview = buildCompilePreview({
      workspace: makeWorkspace(rootPath, "2026-03-01 00:00:00"),
      mode: "incremental",
    });
    expect(incrementalPreview.estimate.expectedUsd).toBeLessThan(fullPreview.estimate.expectedUsd);
    expect(incrementalPreview.estimate.rawCount).toBe(1);
    expect(fullPreview.estimate.rawCount).toBe(4);
  });

  it("reports wiki pages with no pending raw as unchanged", () => {
    writeFileSync(join(rootPath, "20_wiki/orphan.md"), "# Orphan");
    writeFileSync(join(rootPath, "10_raw/new.md"), "# New");
    const preview = buildCompilePreview({
      workspace: makeWorkspace(rootPath),
      mode: "full",
    });
    expect(preview.added).toContain("20_wiki/new.md");
    expect(preview.unchanged).toContain("20_wiki/orphan.md");
  });

  it("returns empty preview when the workspace has no raws", () => {
    const preview = buildCompilePreview({
      workspace: makeWorkspace(rootPath),
      mode: "full",
    });
    expect(preview.added).toEqual([]);
    expect(preview.modified).toEqual([]);
    expect(preview.unchanged).toEqual([]);
    expect(preview.estimatedDurationSeconds).toBe(0);
  });

  it("estimatedDurationSeconds scales with the cost estimate", () => {
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(rootPath, `10_raw/file-${i}.md`), "lorem ipsum ".repeat(500));
    }
    const preview = buildCompilePreview({
      workspace: makeWorkspace(rootPath),
      mode: "full",
    });
    expect(preview.estimatedDurationSeconds).toBeGreaterThan(0);
  });

  it("ignores _index.md when listing wiki slugs", () => {
    writeFileSync(join(rootPath, "20_wiki/_index.md"), "# Index");
    writeFileSync(join(rootPath, "10_raw/foo.md"), "# Foo");
    const preview = buildCompilePreview({
      workspace: makeWorkspace(rootPath),
      mode: "full",
    });
    expect(preview.added).toEqual(["20_wiki/foo.md"]);
    expect(preview.unchanged.find((p) => p.includes("_index"))).toBeUndefined();
  });
});

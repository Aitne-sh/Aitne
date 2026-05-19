import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndexCache } from "./index-cache.js";
import type { WikiWorkspaceRow } from "./workspaces.js";

function makeWorkspace(
  rootPath: string,
  kind: "internal" | "external" = "external",
): WikiWorkspaceRow {
  return {
    id: 1,
    name: "default",
    kind,
    root_path: rootPath,
    language: "en",
    dispatch_mode: "parallel",
    concurrency_cap: 3,
    dm_agent_write_enabled: 0,
    bridge_enabled: 0,
    bridge_measurement_only: 1,
    bridge_min_confidence: 0.7,
    full_compile_approval_threshold_usd: 2,
    write_strategy: "auto",
    git_pre_compile_enabled: 1,
    schema_version: 1,
    active: 1,
    last_ingest_at: null,
    last_compile_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe("WikiIndexCache", () => {
  let rootPath: string;
  let cache: WikiIndexCache;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-index-cache-"));
    cache = new WikiIndexCache();
  });

  afterEach(async () => {
    await cache.shutdown();
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("returns a not-exists snapshot when the file is absent (internal)", () => {
    const snap = cache.get(makeWorkspace(rootPath, "internal"));
    expect(snap.exists).toBe(false);
    expect(snap.content).toBeNull();
  });

  it("reads through to disk on first call (external)", () => {
    mkdirSync(join(rootPath, "20_wiki"), { recursive: true });
    writeFileSync(join(rootPath, "20_wiki/_index.md"), "# Index\n- a\n");
    const snap = cache.get(makeWorkspace(rootPath));
    expect(snap.exists).toBe(true);
    expect(snap.content).toContain("# Index");
  });

  it("returns the cached snapshot on the second call (external)", () => {
    mkdirSync(join(rootPath, "20_wiki"), { recursive: true });
    writeFileSync(join(rootPath, "20_wiki/_index.md"), "# v1\n");
    const ws = makeWorkspace(rootPath);
    const first = cache.get(ws);
    // Mutate the file on disk; if the cache is honoured the second
    // call should still observe the previous snapshot.
    writeFileSync(join(rootPath, "20_wiki/_index.md"), "# v2\n");
    const second = cache.get(ws);
    expect(second.loadedAtMs).toBe(first.loadedAtMs);
    expect(second.content).toContain("# v1");
  });

  it("re-reads from disk after invalidate()", () => {
    mkdirSync(join(rootPath, "20_wiki"), { recursive: true });
    writeFileSync(join(rootPath, "20_wiki/_index.md"), "# v1\n");
    const ws = makeWorkspace(rootPath);
    cache.get(ws);
    writeFileSync(join(rootPath, "20_wiki/_index.md"), "# v2\n");
    cache.invalidate(ws.id);
    const after = cache.get(ws);
    expect(after.content).toContain("# v2");
  });

  it("internal mode skips the cache entirely (always reads from disk)", () => {
    mkdirSync(join(rootPath, "20_wiki"), { recursive: true });
    writeFileSync(join(rootPath, "20_wiki/_index.md"), "# v1\n");
    const ws = makeWorkspace(rootPath, "internal");
    cache.get(ws);
    writeFileSync(join(rootPath, "20_wiki/_index.md"), "# v2\n");
    const after = cache.get(ws);
    expect(after.content).toContain("# v2");
  });
});

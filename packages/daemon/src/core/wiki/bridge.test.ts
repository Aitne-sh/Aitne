import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WikiBridgeProposal } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import {
  BRIDGE_FILE_RE,
  bridgeFilename,
  canonicalBridgeSlug,
  computeBridgeContentHash,
  processBridgeProposal,
  renderBridgeMarkdown,
} from "./bridge.js";
import type { WikiWorkspaceRow } from "./workspaces.js";

function seedWorkspace(
  db: Database.Database,
  overrides: Partial<WikiWorkspaceRow> = {},
): WikiWorkspaceRow {
  const rootPath = overrides.root_path ?? mkdtempSync(join(tmpdir(), "pa-bridge-"));
  // wiki_workspaces is auto-incrementing; we don't pass id explicitly.
  db.prepare(
    `INSERT INTO wiki_workspaces (
       name, kind, root_path, language, dispatch_mode, concurrency_cap,
       dm_agent_write_enabled, bridge_enabled, bridge_measurement_only,
       bridge_min_confidence, full_compile_approval_threshold_usd,
       write_strategy, git_pre_compile_enabled, schema_version, active
     ) VALUES (?, 'internal', ?, 'en', 'parallel', 3, ?, ?, ?, ?, 2.0, 'fs', 1, 1, 1)`,
  ).run(
    overrides.name ?? "default",
    rootPath,
    overrides.dm_agent_write_enabled ?? 1,
    overrides.bridge_enabled ?? 1,
    overrides.bridge_measurement_only ?? 0,
    overrides.bridge_min_confidence ?? 0.7,
  );
  const row = db
    .prepare(`SELECT * FROM wiki_workspaces WHERE name = ?`)
    .get(overrides.name ?? "default") as WikiWorkspaceRow;
  return row;
}

function makeProposal(over: Partial<WikiBridgeProposal> = {}): WikiBridgeProposal {
  return {
    trigger: "explicit",
    summary: "Quantum gravity and information theory share an entropy bound.",
    excerpt:
      "The Bekenstein bound limits the information in a region by its surface area, not its volume.",
    sourceKind: "dm",
    sourceRef: "session-abc:msg-42",
    confidence: 0.95,
    sessionId: "session-abc",
    messageId: "msg-42",
    ...over,
  };
}

describe("computeBridgeContentHash", () => {
  it("is stable across whitespace + casing differences", () => {
    const a = computeBridgeContentHash({
      summary: "Quantum gravity and entropy.",
      excerpt: "Bekenstein bound on information.",
    });
    const b = computeBridgeContentHash({
      summary: "  QUANTUM   gravity, and entropy! ",
      excerpt: "Bekenstein BOUND on information.",
    });
    expect(a).toBe(b);
  });

  it("changes when content actually differs (post-normalisation)", () => {
    const a = computeBridgeContentHash({
      summary: "alpha",
      excerpt: "beta gamma",
    });
    const b = computeBridgeContentHash({
      summary: "alpha",
      excerpt: "beta delta",
    });
    expect(a).not.toBe(b);
  });

  it("treats punctuation-only differences as the same content", () => {
    // The hash is deliberately punctuation-insensitive so that two
    // paraphrases of the same insight collide under dedup. Documents
    // the invariant.
    const a = computeBridgeContentHash({ summary: "x", excerpt: "y" });
    const b = computeBridgeContentHash({ summary: "x", excerpt: "y!" });
    expect(a).toBe(b);
  });
});

describe("bridgeFilename + canonicalBridgeSlug", () => {
  it("emits a deterministic YYYY-MM-DD-HHmmss-<slug>.md filename", () => {
    const filename = bridgeFilename("2026-05-12T10:15:30.456Z", "quantum-gravity");
    expect(filename).toBe("bridge-2026-05-12-101530-quantum-gravity.md");
    expect(`10_raw/${filename}`).toMatch(BRIDGE_FILE_RE);
  });

  it("slugifies the summary when no hint is given", () => {
    const slug = canonicalBridgeSlug(
      makeProposal({ summary: "Bekenstein bound — surface area, not volume!" }),
    );
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(slug).toContain("bekenstein");
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it("honours a valid slug hint verbatim", () => {
    const slug = canonicalBridgeSlug(
      makeProposal({ slug: "bekenstein-bound" }),
    );
    expect(slug).toBe("bekenstein-bound");
  });

  it("rejects an invalid slug hint and falls back to the summary slug", () => {
    const slug = canonicalBridgeSlug(
      makeProposal({ slug: "Has Caps Not Allowed!" }),
    );
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe("renderBridgeMarkdown", () => {
  it("emits the `type: bridge` frontmatter the compiler keys on", () => {
    const body = renderBridgeMarkdown(makeProposal(), {
      detectedAtIso: "2026-05-12T10:15:30.000Z",
      confidence: 0.95,
      workspaceName: "default",
    });
    expect(body).toContain("---\ntype: bridge");
    expect(body).toContain("trigger: explicit");
    expect(body).toContain("source_kind: dm");
    expect(body).toContain("source_ref: session-abc:msg-42");
    expect(body).toContain("## Source excerpt");
  });

  it("returns the caller's pre-rendered body verbatim when provided", () => {
    const body = renderBridgeMarkdown(
      makeProposal({ body: "# Bridge\n\nCustom body." }),
      {
        detectedAtIso: "2026-05-12T10:15:30.000Z",
        confidence: 1,
        workspaceName: "default",
      },
    );
    expect(body).toBe("# Bridge\n\nCustom body.\n");
  });
});

describe("processBridgeProposal", () => {
  let db: Database.Database;
  let workspace: WikiWorkspaceRow;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    workspace = seedWorkspace(db);
  });

  afterEach(() => {
    rmSync(workspace.root_path, { recursive: true, force: true });
    db.close();
  });

  it("rejects when bridge_enabled is 0 (feature disabled)", async () => {
    const offWorkspace = seedWorkspace(db, {
      name: "off",
      bridge_enabled: 0,
    });
    const result = await processBridgeProposal({
      db,
      workspace: offWorkspace,
      proposal: makeProposal(),
      nowIso: "2026-05-12T10:15:30.000Z",
    });
    expect(result.outcome).toBe("feature_disabled");
    expect(result.path).toBeNull();
    rmSync(offWorkspace.root_path, { recursive: true, force: true });
  });

  it("rejects self-bridging (loop guard)", async () => {
    const result = await processBridgeProposal({
      db,
      workspace,
      proposal: makeProposal({
        sourceKind: "wiki",
        sourceRef: "10_raw/bridge-2026-05-12-101530-x.md",
      }),
      nowIso: "2026-05-12T11:00:00.000Z",
    });
    expect(result.outcome).toBe("loop_guard");
    expect(result.path).toBeNull();
    // Audit row landed.
    const audit = db
      .prepare(`SELECT action_type FROM agent_actions WHERE source_kind = 'wiki'`)
      .all() as Array<{ action_type: string }>;
    expect(audit.some((row) => row.action_type === "wiki.bridge.skip")).toBe(true);
  });

  it("drops self-judged proposals below the confidence threshold", async () => {
    const result = await processBridgeProposal({
      db,
      workspace,
      proposal: makeProposal({
        trigger: "self_judged",
        confidence: 0.5,
      }),
      nowIso: "2026-05-12T11:00:00.000Z",
    });
    expect(result.outcome).toBe("below_threshold");
    expect(result.path).toBeNull();
  });

  it("accepts explicit triggers regardless of supplied confidence", async () => {
    const result = await processBridgeProposal({
      db,
      workspace,
      proposal: makeProposal({ trigger: "explicit", confidence: 0.1 }),
      nowIso: "2026-05-12T11:00:00.000Z",
    });
    expect(result.outcome).toBe("written");
    expect(result.path).toMatch(BRIDGE_FILE_RE);
    expect(result.confidence).toBe(1);
  });

  it("writes a bridge file and indexes it in FTS", async () => {
    const result = await processBridgeProposal({
      db,
      workspace,
      proposal: makeProposal(),
      nowIso: "2026-05-12T10:15:30.000Z",
    });
    expect(result.outcome).toBe("written");
    expect(result.path).toMatch(BRIDGE_FILE_RE);
    expect(result.path).toMatch(/^10_raw\/bridge-2026-05-12-101530-quantum-gravity/);
    const onDisk = readFileSync(resolve(workspace.root_path, result.path!), "utf-8");
    expect(onDisk).toContain("type: bridge");
    expect(onDisk).toContain("Bekenstein bound");

    const fts = db
      .prepare(`SELECT path FROM fts_wiki WHERE workspace_id = ?`)
      .all(workspace.id) as Array<{ path: string }>;
    expect(fts.some((row) => row.path === result.path)).toBe(true);
  });

  it("deduplicates identical content_hash within the same workspace", async () => {
    const first = await processBridgeProposal({
      db,
      workspace,
      proposal: makeProposal(),
      nowIso: "2026-05-12T10:15:30.000Z",
    });
    expect(first.outcome).toBe("written");

    const second = await processBridgeProposal({
      db,
      workspace,
      // Identical normalised content; differ in source provenance + casing.
      proposal: makeProposal({
        summary: "  QUANTUM   gravity, and INFORMATION theory share an entropy bound.",
        excerpt:
          "The Bekenstein bound limits the information in a region by its surface area, not its volume.",
        sourceRef: "session-abc:msg-43",
      }),
      nowIso: "2026-05-12T10:16:00.000Z",
    });
    expect(second.outcome).toBe("deduplicated");
    expect(second.existingPath).toBe(first.path);
    expect(second.contentHash).toBe(first.contentHash);

    // Only one bridge file was written.
    const dedupRows = db
      .prepare(`SELECT * FROM wiki_bridge_dedup WHERE workspace_id = ?`)
      .all(workspace.id);
    expect(dedupRows).toHaveLength(1);
  });

  it("measurement-only mode logs a candidate audit row but writes no file", async () => {
    const measuring = seedWorkspace(db, {
      name: "measuring",
      bridge_enabled: 1,
      bridge_measurement_only: 1,
    });
    const result = await processBridgeProposal({
      db,
      workspace: measuring,
      proposal: makeProposal({ trigger: "self_judged", confidence: 0.9 }),
      nowIso: "2026-05-12T11:00:00.000Z",
    });
    expect(result.outcome).toBe("candidate_logged");
    expect(result.path).toBeNull();
    expect(result.measurementOnly).toBe(true);

    // No file on disk.
    expect(existsSync(join(measuring.root_path, "10_raw"))).toBe(false);

    // Audit row recorded as `wiki.bridge.candidate`.
    const audit = db
      .prepare(
        `SELECT action_type FROM agent_actions
         WHERE source_kind = 'wiki' AND source_ref = ?`,
      )
      .all("measuring") as Array<{ action_type: string }>;
    expect(audit.some((row) => row.action_type === "wiki.bridge.candidate")).toBe(true);

    // dedup row also persists so a re-proposal short-circuits.
    const dedup = db
      .prepare(
        `SELECT accepted, bridge_path FROM wiki_bridge_dedup
         WHERE workspace_id = ?`,
      )
      .get(measuring.id) as { accepted: number; bridge_path: string | null };
    expect(dedup.accepted).toBe(0);
    expect(dedup.bridge_path).toBeNull();
    rmSync(measuring.root_path, { recursive: true, force: true });
  });

  it("namespaces dedup per workspace — same hash in two workspaces both write", async () => {
    const second = seedWorkspace(db, {
      name: "second",
      bridge_enabled: 1,
    });

    const a = await processBridgeProposal({
      db,
      workspace,
      proposal: makeProposal(),
      nowIso: "2026-05-12T10:15:30.000Z",
    });
    expect(a.outcome).toBe("written");

    const b = await processBridgeProposal({
      db,
      workspace: second,
      proposal: makeProposal(),
      nowIso: "2026-05-12T10:15:30.000Z",
    });
    expect(b.outcome).toBe("written");

    expect(existsSync(resolve(workspace.root_path, a.path!))).toBe(true);
    expect(existsSync(resolve(second.root_path, b.path!))).toBe(true);
    rmSync(second.root_path, { recursive: true, force: true });
  });
});

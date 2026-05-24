import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SkillsCompiler } from "./skills-compiler.js";
import { resetFetchWindowSystemPromptForTest } from "./fetch-window-prompt-loader.js";
import type { BackendId } from "@aitne/shared";

// FILE_SPLIT_PLAN_SKILLS_COMPILER.md §7 + §11 — Golden snapshot test.
//
// The split moved ~1500 lines across six modules. The plan's
// non-goal §2 was "no behaviour change" — materialization output must
// be byte-identical across the refactor. The existing per-concern test
// suite exercises the parts; this test exercises the whole: a known
// session is materialized for each backend, every produced file is
// hashed, and the manifest is compared against a committed snapshot.
//
// What this catches that the rest of the test suite does not:
//   - Drift in transform ordering (e.g. service-strip vs ref-inline swap)
//   - Silent additions / removals of generated files
//   - Whitespace / trailing-newline differences in any helper
//   - Backend dispatch mistakes (materializing the wrong dotfile root)
//
// The fixture is fully self-contained: a synthetic `agent-assets/`
// tree is constructed inline (no dependency on the repo's real
// `agent-assets/`) so the snapshot stays stable across legitimate
// asset edits. Skill selection is forced through `override.skillSlugs`
// so the snapshot is decoupled from `skills-manifest.ts` churn.
//
// To intentionally update snapshots after a deliberate output change,
// run: `pnpm vitest run -u packages/daemon/src/core/skills-compiler-snapshot.test.ts`

const BACKENDS: readonly BackendId[] = ["claude", "codex", "gemini", "opencode"];

const FIXTURE_SKILLS = ["observations", "mail", "external-services"];

const FIXTURE_PROFILE_SAFETY = [
  "## Safety Invariants",
  "",
  "- Do no harm.",
  "- Never store secrets in files.",
].join("\n");

const FIXTURE_PROFILE_CONVERSATIONAL = [
  "# conversational",
  "",
  "## Tone",
  "",
  "Be friendly and concise.",
  "",
  "## Defaults",
  "",
  "Prefer direct answers over hedging.",
  "",
].join("\n");

const FIXTURE_SKILL_INDEX_PREAMBLE = [
  "## Skills",
  "",
  "Skills are materialized under the per-backend dotfile directory.",
  "When your task matches an entry in `<skill-index>` below, `Read`",
  "its `SKILL.md` and follow the contents.",
].join("\n");

const FIXTURE_OBSERVATIONS_SKILL = [
  "---",
  "name: observations",
  "description: Post observations to the daemon via /api/observations",
  "allowed-tools:",
  "  - Bash",
  "---",
  "",
  "# observations",
  "",
  "Post observations to the daemon via `/api/observations`. The endpoint",
  "is read-sensitive, so the Codex banner is expected to fire here.",
  "",
].join("\n");

const FIXTURE_MAIL_SKILL = [
  "---",
  "name: mail",
  "description: Read and act on mail across configured providers",
  "allowed-tools:",
  "  - Bash",
  "---",
  "",
  "# mail",
  "",
  "## Providers",
  "",
  "{{> ref:providers }}",
  "",
  "## Usage",
  "",
  "Use the daemon API for all mail reads and writes.",
  "",
].join("\n");

const FIXTURE_MAIL_PROVIDERS_REF =
  "Supported providers: Gmail, Outlook, Yahoo, iCloud, generic IMAP.";

const FIXTURE_EXTERNAL_SERVICES_SKILL = [
  "---",
  "name: external-services",
  "description: Reach the user's configured third-party services",
  "allowed-tools:",
  "  - Bash",
  "---",
  "",
  "# external-services",
  "",
  "<!-- service:calendar -->",
  "## Calendar",
  "",
  "Calendar is configured — use it freely.",
  "<!-- /service:calendar -->",
  "",
  "<!-- service:github -->",
  "## GitHub",
  "",
  "GitHub is NOT configured — this section should be stripped.",
  "<!-- /service:github -->",
  "",
].join("\n");

const FIXTURE_CHARACTER = "Speak in plain, friendly prose.";

function buildFixtureWorkspace(root: string): void {
  const profilesRoot = join(root, "agent-assets", "agent-profiles");
  const systemPromptsRoot = join(root, "agent-assets", "system-prompts");
  const skillsRoot = join(root, "agent-assets", "skills");
  mkdirSync(profilesRoot, { recursive: true });
  mkdirSync(systemPromptsRoot, { recursive: true });

  writeFileSync(join(profilesRoot, "_safety.md"), FIXTURE_PROFILE_SAFETY, "utf-8");
  writeFileSync(
    join(profilesRoot, "conversational.md"),
    FIXTURE_PROFILE_CONVERSATIONAL,
    "utf-8",
  );
  writeFileSync(
    join(systemPromptsRoot, "skill-index-instruction.md"),
    FIXTURE_SKILL_INDEX_PREAMBLE,
    "utf-8",
  );

  const observationsDir = join(skillsRoot, "observations");
  mkdirSync(observationsDir, { recursive: true });
  writeFileSync(join(observationsDir, "SKILL.md"), FIXTURE_OBSERVATIONS_SKILL, "utf-8");

  const mailDir = join(skillsRoot, "mail");
  mkdirSync(join(mailDir, "references"), { recursive: true });
  writeFileSync(join(mailDir, "SKILL.md"), FIXTURE_MAIL_SKILL, "utf-8");
  writeFileSync(
    join(mailDir, "references", "providers.md"),
    FIXTURE_MAIL_PROVIDERS_REF,
    "utf-8",
  );

  const externalDir = join(skillsRoot, "external-services");
  mkdirSync(externalDir, { recursive: true });
  writeFileSync(
    join(externalDir, "SKILL.md"),
    FIXTURE_EXTERNAL_SERVICES_SKILL,
    "utf-8",
  );
}

function walkSorted(root: string): string[] {
  const out: string[] = [];
  function recurse(rel: string): void {
    const abs = rel ? join(root, rel) : root;
    const entries = readdirSync(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const childRel = rel ? join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) recurse(childRel);
      else if (ent.isFile()) out.push(childRel);
    }
  }
  recurse("");
  return out;
}

function normalizePathPlaceholders(
  content: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string {
  let out = content;
  for (const [absPath, placeholder] of replacements) {
    while (out.includes(absPath)) {
      out = out.replace(absPath, placeholder);
    }
  }
  return out;
}

function sha256Hex(buf: Buffer | string): string {
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

function buildManifest(
  sessionDir: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string {
  const files = walkSorted(sessionDir);
  const entries: ManifestEntry[] = files.map((relPath) => {
    const abs = join(sessionDir, relPath);
    const raw = readFileSync(abs, "utf-8");
    const normalized = normalizePathPlaceholders(raw, replacements);
    return {
      path: relPath,
      bytes: Buffer.byteLength(normalized, "utf-8"),
      sha256: sha256Hex(normalized),
    };
  });

  // Column-align bytes for readable diffs. Path stays variable-width.
  const maxBytesWidth = entries.reduce(
    (m, e) => Math.max(m, String(e.bytes).length),
    1,
  );
  const lines = entries.map(
    (e) =>
      `${e.path}  bytes=${String(e.bytes).padStart(maxBytesWidth, " ")}  sha256=${e.sha256}`,
  );
  return `${lines.join("\n")}\n`;
}

describe("SkillsCompiler — golden snapshot (FILE_SPLIT_PLAN §11)", () => {
  let workspace: string;
  // Per-backend session dirs created in beforeAll so individual `it`s
  // can read the same materialized output if they want to. Cleanup in
  // afterAll.
  const sessionDirs = new Map<BackendId, string>();

  beforeAll(() => {
    // Drop the daemon-lifetime fetch_window cache in case a prior test
    // file loaded the real-asset prompt; not strictly needed here (we
    // don't materialize routine.fetch_window), but defensive.
    resetFetchWindowSystemPromptForTest();
    workspace = mkdtempSync(join(tmpdir(), "pa-snap-workspace-"));
    buildFixtureWorkspace(workspace);

    const compiler = new SkillsCompiler(
      workspace,
      new Set(["calendar"]),
      [],
      {},
      FIXTURE_CHARACTER,
    );

    for (const backendId of BACKENDS) {
      const sessionDir = mkdtempSync(join(tmpdir(), `pa-snap-${backendId}-`));
      sessionDirs.set(backendId, sessionDir);
      compiler.materializeSessionBundle({
        backendId,
        sessionDir,
        eventType: "message.received",
        override: {
          skillSlugs: FIXTURE_SKILLS,
          profileBody: null,
        },
      });
    }
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
    for (const dir of sessionDirs.values()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const backendId of BACKENDS) {
    it(`materializes a deterministic file tree for backend=${backendId}`, async () => {
      const sessionDir = sessionDirs.get(backendId);
      if (!sessionDir) throw new Error(`session dir missing for ${backendId}`);
      // Path replacements must run from longest to shortest so a session
      // dir nested under tmpdir doesn't get partially substituted as a
      // workspace-rooted path. Today the two are siblings under tmpdir
      // and the order doesn't matter; keep the policy explicit so a
      // future fixture change that nests them stays robust.
      const replacements: ReadonlyArray<readonly [string, string]> = [
        [sessionDir, "<SESSION>"],
        [workspace, "<WORKSPACE>"],
      ];
      const manifest = buildManifest(sessionDir, replacements);
      await expect(manifest).toMatchFileSnapshot(
        `./__snapshots__/skills-compiler-golden-${backendId}.snap`,
      );
    });
  }

  it("manifest builder is deterministic across reruns of the same session dir", () => {
    // Sanity guard against a future refactor that introduces fs-walk
    // non-determinism (e.g. async readdir without a sort). Pick one
    // backend and hash the manifest twice — the strings must match
    // byte-for-byte. Cheaper than rerunning the whole materialize.
    const sessionDir = sessionDirs.get("claude");
    if (!sessionDir) throw new Error("claude session dir missing");
    const replacements: ReadonlyArray<readonly [string, string]> = [
      [sessionDir, "<SESSION>"],
      [workspace, "<WORKSPACE>"],
    ];
    const a = buildManifest(sessionDir, replacements);
    const b = buildManifest(sessionDir, replacements);
    expect(b).toBe(a);
  });

  it("re-materializing the same session into a fresh dir produces an identical manifest", () => {
    // Pin the "no hidden global state" contract — the compiler must not
    // accumulate state across materialize calls within a single
    // instance such that the SECOND materialize on a clean dir drifts
    // from the FIRST. This is exactly the kind of drift the split
    // could introduce if a sibling module accidentally cached
    // first-call inputs.
    const second = mkdtempSync(join(tmpdir(), "pa-snap-claude-rerun-"));
    try {
      const compiler = new SkillsCompiler(
        workspace,
        new Set(["calendar"]),
        [],
        {},
        FIXTURE_CHARACTER,
      );
      compiler.materializeSessionBundle({
        backendId: "claude",
        sessionDir: second,
        eventType: "message.received",
        override: { skillSlugs: FIXTURE_SKILLS, profileBody: null },
      });
      const first = sessionDirs.get("claude");
      if (!first) throw new Error("claude session dir missing");
      const manifestFirst = buildManifest(first, [
        [first, "<SESSION>"],
        [workspace, "<WORKSPACE>"],
      ]);
      const manifestSecond = buildManifest(second, [
        [second, "<SESSION>"],
        [workspace, "<WORKSPACE>"],
      ]);
      expect(manifestSecond).toBe(manifestFirst);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});

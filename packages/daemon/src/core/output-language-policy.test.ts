import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createEvent, EventPriority } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { ContextBuilder } from "./context-builder.js";
import { createServiceRegistry } from "../services/service-registry.js";
import type { AgentConfig } from "../config.js";
import { SkillsCompiler } from "./skills-compiler.js";
import {
  OUTPUT_LANGUAGE_POINTER_HEADING,
  OUTPUT_LANGUAGE_POLICY_SENTINEL,
  applyOutputLanguagePointerRewrite,
  renderOutputLanguagePolicyBlock,
  renderOutputLanguagePolicyPointer,
} from "./output-language-policy.js";

/**
 * Unit + integration tests for the unified output-language policy
 * (`docs/design/appendices/output-language-policy.md`).
 *
 * Three things are validated here:
 *
 *  1. **L2** — ContextBuilder emits the `<output_language_policy>`
 *     block alongside `<settings primary_language="…">`, and the block
 *     embeds the current setting. (§7.1, §9)
 *  2. **L2b** — `skills-compiler` produces a byte-identical
 *     `## Output language` pointer paragraph in CLAUDE.md, AGENTS.md,
 *     and GEMINI.md. (§13.4)
 *  3. **Grep guard** — the full policy text exists in exactly one
 *     source location (this module). No other file under `src/` or
 *     `agent-assets/` may duplicate it. (§9 "grep guard")
 */

describe("renderOutputLanguagePolicyBlock", () => {
  it("emits the block with the supplied primary_language verbatim", () => {
    const out = renderOutputLanguagePolicyBlock("ja");
    expect(out.startsWith("<output_language_policy>")).toBe(true);
    expect(out.endsWith("</output_language_policy>")).toBe(true);
    expect(out).toContain(`primary_language="ja"`);
    // The sentinel anchors the grep-guard test; if its text drifts the
    // duplication scan below will start missing copies. Lock it.
    expect(out).toContain(OUTPUT_LANGUAGE_POLICY_SENTINEL);
  });

  it("defaults to `en` for empty input (defensive — caller should pass the resolved value)", () => {
    expect(renderOutputLanguagePolicyBlock("")).toContain(`primary_language="en"`);
    expect(renderOutputLanguagePolicyBlock("   ")).toContain(`primary_language="en"`);
  });

  it("is value-stable for the same input (no Date.now/Math.random leakage)", () => {
    expect(renderOutputLanguagePolicyBlock("ja")).toBe(renderOutputLanguagePolicyBlock("ja"));
  });
});

describe("renderOutputLanguagePolicyPointer", () => {
  it("renders the `## Output language` heading", () => {
    expect(renderOutputLanguagePolicyPointer()).toContain(OUTPUT_LANGUAGE_POINTER_HEADING);
  });

  it("contains no value substitutions — must be backend-agnostic and setting-agnostic", () => {
    // The pointer is intentionally declarative; the live primary_language
    // lives in the per-turn XML (design §13.5). Any token that looks like
    // a value substitution (`${...}`, `{{...}}`, or a literal BCP-47 tag
    // attribute) is a regression.
    const pointer = renderOutputLanguagePolicyPointer();
    expect(pointer).not.toMatch(/\$\{[^}]+\}/);
    expect(pointer).not.toMatch(/\{\{[^}]+\}\}/);
    expect(pointer).not.toMatch(/primary_language="(?:en|ja|es|fr|de|zh|ko)"/);
  });
});

describe("applyOutputLanguagePointerRewrite", () => {
  it("is idempotent — calling twice produces the same content", () => {
    const seed = [
      "# Profile",
      "",
      "Body before character block.",
      "",
      "## Tone",
      "",
      "Friendly.",
      "",
    ].join("\n");
    const once = applyOutputLanguagePointerRewrite(seed);
    const twice = applyOutputLanguagePointerRewrite(once);
    expect(twice).toBe(once);
  });

  it("inserts after the character-block end marker when present", () => {
    const body = [
      "# Profile",
      "",
      "<!-- safety:end -->",
      "",
      "## Character (user-defined)",
      "<!-- character:start -->",
      "Be terse.",
      "<!-- character:end -->",
      "",
      "Footer line.",
      "",
      "## Tone",
      "",
      "Friendly.",
      "",
    ].join("\n");
    const out = applyOutputLanguagePointerRewrite(body);
    const characterEnd = out.indexOf("<!-- character:end -->");
    const pointerIdx = out.indexOf(OUTPUT_LANGUAGE_POINTER_HEADING);
    const toneIdx = out.indexOf("## Tone");
    expect(characterEnd).toBeGreaterThanOrEqual(0);
    expect(pointerIdx).toBeGreaterThan(characterEnd);
    expect(pointerIdx).toBeLessThan(toneIdx);
  });

  it("inserts after `<!-- safety:end -->` when no character block is present", () => {
    const body = [
      "# Profile",
      "",
      "## Safety Invariants",
      "- Do no harm.",
      "<!-- safety:end -->",
      "",
      "## Tone",
      "",
      "Friendly.",
      "",
    ].join("\n");
    const out = applyOutputLanguagePointerRewrite(body);
    const safetyEnd = out.indexOf("<!-- safety:end -->");
    const pointerIdx = out.indexOf(OUTPUT_LANGUAGE_POINTER_HEADING);
    const toneIdx = out.indexOf("## Tone");
    expect(pointerIdx).toBeGreaterThan(safetyEnd);
    expect(pointerIdx).toBeLessThan(toneIdx);
  });

  it("falls back to inserting before the first `## ` heading for legacy bodies", () => {
    const body = "# Profile\n\n## Tone\n\nFriendly.\n";
    const out = applyOutputLanguagePointerRewrite(body);
    const pointerIdx = out.indexOf(OUTPUT_LANGUAGE_POINTER_HEADING);
    const toneIdx = out.indexOf("## Tone");
    expect(pointerIdx).toBeGreaterThanOrEqual(0);
    expect(pointerIdx).toBeLessThan(toneIdx);
  });

  it("appends to end when character block exists but no following `## ` heading", () => {
    const body = [
      "# Profile",
      "",
      "<!-- character:end -->",
      "",
      "tail prose without a section heading.",
    ].join("\n");
    const out = applyOutputLanguagePointerRewrite(body);
    expect(out).toContain(OUTPUT_LANGUAGE_POINTER_HEADING);
    // The pointer must land at the end since there is no later `## `.
    expect(out.indexOf(OUTPUT_LANGUAGE_POINTER_HEADING)).toBeGreaterThan(
      body.indexOf("<!-- character:end -->"),
    );
  });

  it("appends to end when safety:end sentinel is the last meaningful content", () => {
    const body = "# Profile\n\n<!-- safety:end -->\n";
    const out = applyOutputLanguagePointerRewrite(body);
    expect(out).toContain(OUTPUT_LANGUAGE_POINTER_HEADING);
    expect(out.trimEnd().endsWith(renderOutputLanguagePolicyPointer().trimEnd())).toBe(true);
  });

  it("handles bodies without any heading by appending the block", () => {
    const body = "Just some prose with no headings at all.";
    const out = applyOutputLanguagePointerRewrite(body);
    expect(out.startsWith(body)).toBe(true);
    expect(out).toContain(OUTPUT_LANGUAGE_POINTER_HEADING);
  });

  it("handles fully empty / whitespace-only bodies", () => {
    const out = applyOutputLanguagePointerRewrite("");
    expect(out).toContain(OUTPUT_LANGUAGE_POINTER_HEADING);
    const outWs = applyOutputLanguagePointerRewrite("   \n\n");
    expect(outWs).toContain(OUTPUT_LANGUAGE_POINTER_HEADING);
  });

  it("inserts before a leading `## ` heading at offset zero", () => {
    const body = "## First\n\nbody";
    const out = applyOutputLanguagePointerRewrite(body);
    expect(out.startsWith(OUTPUT_LANGUAGE_POINTER_HEADING)).toBe(true);
    expect(out).toContain("## First");
  });
});

describe("ContextBuilder — output_language_policy block", () => {
  let tmp: string;
  let contextDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-olp-"));
    contextDir = join(tmp, "context");
    mkdirSync(join(contextDir, "rules"), { recursive: true });
    mkdirSync(join(contextDir, "user"), { recursive: true });
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function buildWith(primaryLanguage: string | undefined) {
    const config = {
      dataDir: tmp,
      externalObsidianVaultPath: null,
      agentDisplayName: "ai bot",
      primaryLanguage,
      vaultMode: "plain",
    } as unknown as AgentConfig;
    return new ContextBuilder(config, db, createServiceRegistry());
  }

  it("emits the block with primary_language=ja when configured", async () => {
    const builder = buildWith("ja");
    const event = createEvent({
      type: "test.event",
      source: "test",
      priority: EventPriority.NORMAL,
    });
    const ctx = await builder.build(event);
    expect(ctx).toContain(`<settings primary_language="ja"`);
    expect(ctx).toContain("<output_language_policy>");
    expect(ctx).toContain(`primary_language="ja"`);
    expect(ctx).toContain("</output_language_policy>");
    expect(ctx).toContain(OUTPUT_LANGUAGE_POLICY_SENTINEL);
    // Block sits immediately after <settings ... /> line (within a few
    // characters of separator). Ordering matters because skills look up
    // primary_language from `<settings>` and read the rule from the block.
    const settingsIdx = ctx.indexOf("<settings ");
    const blockIdx = ctx.indexOf("<output_language_policy>");
    expect(blockIdx).toBeGreaterThan(settingsIdx);
  });

  it("defaults to primary_language=en when unset", async () => {
    const builder = buildWith(undefined);
    const event = createEvent({
      type: "test.event",
      source: "test",
      priority: EventPriority.NORMAL,
    });
    const ctx = await builder.build(event);
    expect(ctx).toContain(`<settings primary_language="en"`);
    expect(ctx).toContain(`primary_language="en"`);
  });
});

describe("Output-language pointer — cross-backend uniformity", () => {
  let workspace: string;
  let claudeDir: string;
  let codexDir: string;
  let geminiDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-olp-pointer-"));
    claudeDir = mkdtempSync(join(tmpdir(), "pa-olp-pointer-claude-"));
    codexDir = mkdtempSync(join(tmpdir(), "pa-olp-pointer-codex-"));
    geminiDir = mkdtempSync(join(tmpdir(), "pa-olp-pointer-gemini-"));

    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(
      join(profilesRoot, "_safety.md"),
      "## Safety Invariants\n- Do no harm.\n",
      "utf-8",
    );
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\n## Tone\n\nBe friendly.\n",
      "utf-8",
    );
    mkdirSync(join(workspace, "agent-assets", "skills"), { recursive: true });
  });

  afterEach(() => {
    for (const d of [workspace, claudeDir, codexDir, geminiDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function materializeAll() {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir: claudeDir,
      eventType: "message.received",
    });
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir: codexDir,
      eventType: "message.received",
    });
    compiler.materializeSessionBundle({
      backendId: "gemini",
      sessionDir: geminiDir,
      eventType: "message.received",
    });
    return {
      claude: readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8"),
      codex: readFileSync(join(codexDir, "AGENTS.md"), "utf-8"),
      gemini: readFileSync(join(geminiDir, "GEMINI.md"), "utf-8"),
    };
  }

  function extractOutputLanguageBlock(file: string): string {
    const start = file.indexOf(OUTPUT_LANGUAGE_POINTER_HEADING);
    if (start < 0) throw new Error("output-language heading not found");
    const after = file.slice(start);
    // The block ends at the next `## ` heading or end-of-file. Matches
    // the §13.4 invariant exactly.
    const nextHeading = after.slice(OUTPUT_LANGUAGE_POINTER_HEADING.length).search(/\n## /);
    const body = nextHeading >= 0
      ? after.slice(0, OUTPUT_LANGUAGE_POINTER_HEADING.length + nextHeading + 1)
      : after;
    return body.trimEnd();
  }

  it("output-language pointer is byte-identical across backends", () => {
    const { claude, codex, gemini } = materializeAll();
    for (const file of [claude, codex, gemini]) {
      expect(file).toContain(OUTPUT_LANGUAGE_POINTER_HEADING);
    }
    const claudeBlock = extractOutputLanguageBlock(claude);
    const codexBlock = extractOutputLanguageBlock(codex);
    const geminiBlock = extractOutputLanguageBlock(gemini);
    expect(codexBlock).toBe(claudeBlock);
    expect(geminiBlock).toBe(claudeBlock);
  });

  it("pointer block carries no value-substituted fields", () => {
    const { claude } = materializeAll();
    const block = extractOutputLanguageBlock(claude);
    // No leaked template variables.
    expect(block).not.toMatch(/\$\{[^}]+\}/);
    expect(block).not.toMatch(/\{\{[^}]+\}\}/);
    // No literal primary_language="…" attribute — the setting is in the
    // per-turn XML, not the instruction file (§13.5).
    expect(block).not.toMatch(/primary_language="[a-zA-Z-]+"/);
  });
});

/**
 * Grep guard (§9): the full policy text must live in exactly one source
 * location — this very module. Any duplicate elsewhere in `src/` or
 * `agent-assets/` is a regression: it means a flow re-stated the rule
 * instead of referencing the unified block.
 *
 * The scan walks the tree from the daemon's `src` root and from
 * `agent-assets`, excludes the policy module's own files and the
 * design doc (intentional source of the prose), and asserts the
 * sentinel substring appears in zero remaining files.
 */
describe("output-language-policy — grep guard for duplicated prose", () => {
  const REPO_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../",
  );

  const POLICY_MODULE_BASENAMES = new Set([
    "output-language-policy.ts",
    "output-language-policy.test.ts",
  ]);

  // The design doc is the canonical written reference. It is intentionally
  // allowed to contain the sentinel — and is in fact where the prose was
  // copied from.
  const DESIGN_DOC_RELATIVE = "docs/design/appendices/output-language-policy.md";

  function walk(root: string, predicate: (relPath: string) => boolean): string[] {
    const matches: string[] = [];
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name === "node_modules" || name === "dist" || name === ".turbo" || name === ".git") {
          continue;
        }
        const full = join(dir, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          stack.push(full);
          continue;
        }
        const rel = relative(REPO_ROOT, full);
        if (predicate(rel)) matches.push(full);
      }
    }
    return matches;
  }

  it("no other source file contains the policy sentinel", () => {
    const candidates: string[] = [];
    const daemonSrc = join(REPO_ROOT, "packages", "daemon", "src");
    const sharedSrc = join(REPO_ROOT, "packages", "shared", "src");
    const assets = join(REPO_ROOT, "agent-assets");

    for (const root of [daemonSrc, sharedSrc, assets]) {
      if (!existsSync(root)) continue;
      for (const file of walk(root, (rel) =>
        rel.endsWith(".ts")
        || rel.endsWith(".tsx")
        || rel.endsWith(".md"),
      )) {
        const base = file.split("/").pop()!;
        if (POLICY_MODULE_BASENAMES.has(base)) continue;
        candidates.push(file);
      }
    }

    const offenders = candidates.filter((p) => {
      const content = readFileSync(p, "utf-8");
      return content.includes(OUTPUT_LANGUAGE_POLICY_SENTINEL);
    });

    expect(
      offenders,
      offenders.length
        ? `policy sentinel duplicated in: ${offenders.map((p) => relative(REPO_ROOT, p)).join(", ")}`
        : undefined,
    ).toEqual([]);
  });

  it("design doc still carries the sentinel (canonical reference)", () => {
    const designPath = join(REPO_ROOT, DESIGN_DOC_RELATIVE);
    if (!existsSync(designPath)) {
      // The design doc is the source of the prose; if it has been moved,
      // update DESIGN_DOC_RELATIVE rather than weakening this guard.
      throw new Error(`design doc missing at ${DESIGN_DOC_RELATIVE}`);
    }
    expect(readFileSync(designPath, "utf-8")).toContain(
      OUTPUT_LANGUAGE_POLICY_SENTINEL,
    );
  });
});

/**
 * §14.3 — skill frontmatter (`name`, `description`) is Policy A. The
 * model matches user intent against the *English* description
 * regardless of the user's primary_language, so a description rendered
 * in (say) Japanese degrades intent matching. (`when_to_use:` was
 * removed in docs/design/appendices/skills-unification.md Phase 1 §R6 / sister doc Phase
 * 0.1, but the loop still iterates over it defensively in case a
 * stragler value surfaces in a downstream fork.)
 *
 * Typographic punctuation (en/em dashes, curly quotes, ellipsis) is
 * pure Latin typography — not a localization regression — so the guard
 * rejects only characters from non-Latin scripts that signal a
 * translation slip (CJK Unified, Hiragana, Katakana, Hangul, Arabic,
 * Hebrew, Devanagari, Cyrillic). Add more script blocks here if a
 * regression appears in the wild.
 */
const NON_ENGLISH_SCRIPT = new RegExp(
  [
    "[",
    "\\u3040-\\u309F", // Hiragana
    "\\u30A0-\\u30FF", // Katakana
    "\\u31F0-\\u31FF", // Katakana phonetic extensions
    "\\u3400-\\u4DBF", // CJK Unified extension A
    "\\u4E00-\\u9FFF", // CJK Unified
    "\\uF900-\\uFAFF", // CJK Compatibility
    "\\uAC00-\\uD7AF", // Hangul syllables
    "\\u0400-\\u04FF", // Cyrillic
    "\\u0600-\\u06FF", // Arabic
    "\\u0590-\\u05FF", // Hebrew
    "\\u0900-\\u097F", // Devanagari
    "]",
  ].join(""),
  "u",
);

describe("Skill frontmatter — Policy A (English-only descriptions)", () => {
  const SKILLS_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../agent-assets/skills",
  );

  function parseFrontmatter(content: string): Record<string, string> | null {
    if (!content.startsWith("---")) return null;
    const end = content.indexOf("\n---", 3);
    if (end < 0) return null;
    const block = content.slice(4, end);
    const out: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!m) continue;
      out[m[1]] = m[2];
    }
    return out;
  }

  it("name / description carry no non-Latin-script characters (when_to_use defensively scanned)", () => {
    const offenders: string[] = [];
    if (!existsSync(SKILLS_ROOT)) {
      throw new Error(`skills root missing: ${SKILLS_ROOT}`);
    }
    for (const slug of readdirSync(SKILLS_ROOT)) {
      const skillMd = join(SKILLS_ROOT, slug, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const content = readFileSync(skillMd, "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;
      for (const field of ["name", "description", "when_to_use"] as const) {
        const value = fm[field];
        if (!value) continue;
        if (NON_ENGLISH_SCRIPT.test(value)) {
          offenders.push(`${slug}/SKILL.md → ${field}: non-Latin script in "${value}"`);
        }
      }
    }
    expect(
      offenders,
      offenders.length ? offenders.join("\n") : undefined,
    ).toEqual([]);
  });
});

/**
 * §9 — ad-hoc phrasing drift guard.
 *
 * The design replaces every per-flow restatement of the language rule
 * with the single `<output_language_policy>` reference. To keep the
 * collapse from un-collapsing on future PRs, this test fails CI if any
 * SKILL.md or task-flow file under `agent-assets/skills/` or
 * `agent-assets/task-flows/` reintroduces one of the phrases the design
 * names — *as an agent directive*, not as a quoted user-input example —
 * without either referencing `<output_language_policy>` or carrying the
 * explicit `<output_language>english_only` Policy-A opt-out tag.
 *
 * Quoted user-input examples (e.g. `Triggers: "always reply in English",
 * "shorter please"` in user-profile/SKILL.md, message.received.dm.md)
 * are stripped before the scan because they describe what users *say*,
 * not how the agent should *act*. The strip is per-line and only
 * removes content between straight double-quotes; multi-line quoted
 * blocks remain visible to the scan (matching the design's intent that
 * directive prose in body text be caught).
 *
 * `references/<name>.md` is intentionally out of scope — those files
 * are inlined via `{{> ref:* }}` from their parent SKILL.md, whose
 * top-of-body marker (policy reference or `english_only` opt-out)
 * governs the policy for everything the skill inlines.
 */
describe("Output-language ad-hoc phrasing — drift guard", () => {
  const REPO_ROOT_LOCAL = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../",
  );

  const LINT_ROOTS = [
    join(REPO_ROOT_LOCAL, "agent-assets", "skills"),
    join(REPO_ROOT_LOCAL, "agent-assets", "task-flows"),
  ];

  const FORBIDDEN_PHRASES = [
    "in English",
    "in the user's language",
    "in their language",
    "in the user's preferred language",
    "in their preferred language",
  ];

  function stripQuotedExamples(content: string): string {
    // Per-line strip of straight-double-quoted spans. This is enough to
    // mute the `"always reply in English"` family of quoted user-input
    // examples that appear in user-profile/SKILL.md and the
    // message.received.* flows without affecting agent-directive prose.
    return content
      .split("\n")
      .map((line) => line.replace(/"[^"\n]*"/g, '""'))
      .join("\n");
  }

  function walkMd(root: string): string[] {
    const out: string[] = [];
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const full = join(dir, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          // references/ is governed by the parent SKILL.md's policy
          // marker (see describe-block doc above); skip the subtree.
          if (name === "references") continue;
          stack.push(full);
          continue;
        }
        if (name.endsWith(".md")) out.push(full);
      }
    }
    return out;
  }

  it("no skill or task-flow reintroduces ad-hoc language phrasing without a policy marker", () => {
    const offenders: string[] = [];
    for (const root of LINT_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkMd(root)) {
        const content = readFileSync(file, "utf-8");
        if (content.includes("<output_language_policy>")) continue;
        if (content.includes("<output_language>english_only")) continue;
        const stripped = stripQuotedExamples(content);
        for (const phrase of FORBIDDEN_PHRASES) {
          if (stripped.includes(phrase)) {
            offenders.push(
              `${relative(REPO_ROOT_LOCAL, file)}: contains "${phrase}" without a policy reference or english_only opt-out`,
            );
            break;
          }
        }
      }
    }
    expect(
      offenders,
      offenders.length ? offenders.join("\n") : undefined,
    ).toEqual([]);
  });
});

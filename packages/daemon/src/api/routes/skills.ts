import { Hono, type Context } from "hono";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { isUtf8 } from "node:buffer";
import { join, resolve, relative } from "node:path";
import {
  skillCreateSchema,
  skillUpdateSchema,
  skillNameSchema,
  type SkillSummary,
  type SkillDetail,
} from "@aitne/shared";
import type { AgentConfig } from "../../config.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { SkillsCompiler } from "../../core/skills-compiler.js";
import { resolveUserSkillsRoot } from "../../core/user-skills-root.js";
import {
  listBuiltinSkillDirs,
  resolveBuiltinSkillDir,
} from "../../core/skill-source-paths.js";
import { getProfileForProcess, getSkillsForProcess } from "../../core/skills-manifest.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("skills-api");

/**
 * Skills API — CRUD over *user-authored* Claude Code skills.
 *
 * Two roots coexist:
 *   • Built-in skills → `{workspaceDir}/agent-assets/skills/{slug}/SKILL.md`
 *     Read-only. Tracked in source control. Never mutated by this API.
 *   • User skills     → `{dataDir}/skills/{slug}/SKILL.md`
 *     Mutable. The only directory this API writes to.
 *
 * Listing merges both roots and marks each entry with `builtin: boolean`.
 * Write endpoints resolve paths only inside the user-skills root and reject
 * any slug that collides with a built-in skill — guaranteeing built-ins are
 * immutable *by construction*, not by a fragile allow-list.
 */

export interface SkillsRouteDependencies {
  config: AgentConfig;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Unescape a double-quoted YAML scalar (backslash + double-quote escapes). */
function unescapeDoubleQuoted(inner: string): string {
  return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Unescape a single-quoted YAML scalar (only `''` → `'`). */
function unescapeSingleQuoted(inner: string): string {
  return inner.replace(/''/g, "'");
}

/** Strip YAML quoting off a scalar if present. */
function parseYamlScalar(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return unescapeSingleQuoted(s.slice(1, -1));
  }
  return s;
}

/**
 * Parse SKILL.md with YAML frontmatter. Tolerant of missing fields.
 *
 * Extracts `description` (scalar) and `allowed-tools` (flow sequence OR
 * block sequence). Skips any other keys — the API only round-trips these
 * three frontmatter fields plus `name` (which is always the slug).
 */
function parseSkillFile(raw: string): {
  description: string;
  body: string;
  allowedTools: string[];
} {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { description: "", body: raw, allowedTools: [] };
  const fm = m[1];
  const body = m[2];

  const descMatch = fm.match(/^description:\s*(.*)$/m);
  const description = descMatch ? parseYamlScalar(descMatch[1]) : "";

  const allowedTools = parseAllowedTools(fm);

  return { description, body, allowedTools };
}

/**
 * Parse the `allowed-tools:` field. Supports two forms:
 *
 * Flow sequence on one line:
 *     allowed-tools: [Bash(curl *), Read]
 *
 * Block sequence with one item per line (the canonical Claude Code form):
 *     allowed-tools:
 *       - Bash(curl *)
 *       - Read
 */
function parseAllowedTools(fm: string): string[] {
  const flowMatch = fm.match(/^allowed-tools:\s*\[(.*)\]\s*$/m);
  if (flowMatch) {
    return flowMatch[1]
      .split(",")
      .map((t) => parseYamlScalar(t.trim()))
      .filter((t) => t.length > 0);
  }
  const blockMatch = fm.match(/^allowed-tools:\s*\n((?:[ \t]+-\s.*\n?)+)/m);
  if (blockMatch) {
    return blockMatch[1]
      .split("\n")
      .map((line) => line.match(/^\s+-\s*(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => parseYamlScalar(m[1]))
      .filter((t) => t.length > 0);
  }
  return [];
}

/** Escape a string for use inside a YAML double-quoted scalar. */
function yamlDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Serialize name/description/body into a SKILL.md payload.
 *
 * Description is double-quoted so leading/trailing whitespace and special
 * chars round-trip correctly. `allowed-tools` is emitted as a block sequence
 * to match the style of built-in skills (see `agent-assets/skills/notify/SKILL.md`).
 * The zod schema rejects newlines in description and tool entries, so we
 * never need multi-line scalars.
 */
function serializeSkillFile(
  name: string,
  description: string,
  body: string,
  allowedTools: string[] = [],
): string {
  const fmLines = [
    "---",
    `name: ${name}`,
    `description: ${yamlDoubleQuote(description)}`,
  ];
  if (allowedTools.length > 0) {
    fmLines.push("allowed-tools:");
    for (const tool of allowedTools) {
      fmLines.push(`  - ${yamlDoubleQuote(tool)}`);
    }
  }
  fmLines.push("---");
  const trimmedBody = body.startsWith("\n") ? body : `\n${body}`;
  return fmLines.join("\n") + trimmedBody;
}

/**
 * Resolve a slug to its SKILL.md path under `root`, rejecting traversal.
 * Returns null on any attempt to escape `root`.
 */
function safeSkillPath(root: string, slug: string): string | null {
  const dir = resolve(root, slug);
  const rel = relative(root, dir);
  // The `resolve(rel) === rel` branch guards against absolute-path slugs that
  // somehow pass zod validation; on Unix that path is unreachable because zod
  // rejects slashes and dots, but we keep it for defense-in-depth.
  /* c8 ignore next */
  if (rel.startsWith("..") || rel === "" || resolve(rel) === rel) return null;
  return join(dir, "SKILL.md");
}

/**
 * Built-in equivalent of {@link safeSkillPath} — honours the category
 * subdir convention (WIKI_BUILDER_DESIGN.md §9.1) for wiki slugs while
 * still rejecting traversal. Used only for the *built-in* root; user
 * skills stay flat and continue to use `safeSkillPath`.
 */
function safeBuiltinSkillPath(root: string, slug: string): string | null {
  const dir = resolveBuiltinSkillDir(root, slug);
  const rel = relative(root, dir);
  /* c8 ignore next */
  if (rel.startsWith("..") || rel === "" || resolve(rel) === rel) return null;
  return join(dir, "SKILL.md");
}

/**
 * List skills under a root, each as SKILL.md inside a subdirectory.
 *
 * Built-in skills additionally support a one-level category subdir
 * (WIKI_BUILDER_DESIGN.md §9.1 — wiki slugs live under
 * `skills/wiki/<slug>/`). User skills are always flat. The shared
 * `listBuiltinSkillDirs` helper is safe for both because it falls back
 * to a flat scan when no category subdirs are present.
 */
function listSkillsInRoot(
  root: string,
  builtin: boolean,
): SkillSummary[] {
  if (!existsSync(root)) return [];
  const out: SkillSummary[] = [];
  for (const { slug, dir } of listBuiltinSkillDirs(root)) {
    const skillFile = join(dir, "SKILL.md");
    // Slug dirs without an actual SKILL.md (e.g. those that carry only
    // `curation.json`) are excluded from the listing — the API surface
    // is "skills you can read or edit", not "every slug-shaped dir".
    if (!existsSync(skillFile)) continue;
    try {
      const raw = readFileSync(skillFile, "utf-8");
      const { description } = parseSkillFile(raw);
      const stat = statSync(skillFile);
      out.push({
        name: slug,
        description,
        builtin,
        updatedAt: stat.mtime.toISOString(),
      });
    /* c8 ignore start */
    } catch (err) {
      logger.warn(
        { err, root, name: slug },
        "Failed to parse skill file",
      );
    }
    /* c8 ignore stop */
  }
  return out;
}

function listSkillDetailsInRoot(
  root: string,
  builtin: boolean,
): SkillDetail[] {
  if (!existsSync(root)) return [];
  const out: SkillDetail[] = [];
  for (const { slug, dir } of listBuiltinSkillDirs(root)) {
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    try {
      const raw = readFileSync(skillFile, "utf-8");
      const { description, body, allowedTools } = parseSkillFile(raw);
      const stat = statSync(skillFile);
      out.push({
        name: slug,
        description,
        content: body.replace(/^\n/, ""),
        allowedTools,
        builtin,
        updatedAt: stat.mtime.toISOString(),
      });
    /* c8 ignore start */
    } catch (err) {
      logger.warn(
        { err, root, name: slug },
        "Failed to parse skill detail",
      );
    }
    /* c8 ignore stop */
  }
  return out;
}

export function createSkillsRoutes(deps: SkillsRouteDependencies): Hono {
  const app = new Hono();
  const { config } = deps;

  // CONTEXT_VAULT_REDESIGN_PLAN.md §11.6 (v3.1 V5) — user skills root
  // moved from `<dataDir>/skills/` to `<contextDir>/policies/skills/`.
  // The vault-restructure migration moves any pre-existing slug
  // directories on first boot post-upgrade.
  const userSkillsRoot = resolveUserSkillsRoot(config);
  // Default workspaceDir to cwd if the config stub omits it (test fixtures).
  const workspaceDir = config.workspaceDir ?? process.cwd();
  const builtinSkillsRoot = resolve(workspaceDir, "agent-assets", "skills");
  const compiler = new SkillsCompiler(workspaceDir);

  /**
   * Is the slug shadowed by a built-in? Built-ins are always off-limits.
   *
   * Routes through `safeSkillPath` rather than plain `join` so that any slug
   * escaping the built-ins root (defense in depth — zod already filters
   * traversal, but this keeps the two write-gate checks symmetrical) is
   * treated as "not a built-in" and the upstream handler still runs its own
   * safety check against the user root.
   */
  function isBuiltinSlug(slug: string): boolean {
    if (!existsSync(builtinSkillsRoot)) return false;
    const candidate = safeBuiltinSkillPath(builtinSkillsRoot, slug);
    // candidate is null only for traversal slugs, which zod already rejects
    // at the API boundary — this branch is unreachable for valid slugs.
    /* c8 ignore next */
    if (!candidate) return false;
    return existsSync(candidate);
  }

  /** Load a skill by slug. Checks user root first, then built-in. */
  function loadSkill(slug: string): SkillDetail | null {
    // User skills win on name collisions only in practice because write
    // endpoints reject builtin slugs — but for reads, we check built-in
    // too so the agent can inspect them.
    const userPath = safeSkillPath(userSkillsRoot, slug);
    // userPath is null only for traversal slugs; GET validates via skillNameSchema
    // first, so null is unreachable here. Guard kept for defense-in-depth.
    /* c8 ignore next */
    if (userPath && existsSync(userPath)) {
      const raw = readFileSync(userPath, "utf-8");
      const { description, body, allowedTools } = parseSkillFile(raw);
      const stat = statSync(userPath);
      return {
        name: slug,
        description,
        content: body.replace(/^\n/, ""),
        allowedTools,
        builtin: false,
        updatedAt: stat.mtime.toISOString(),
      };
    }
    const builtinPath = safeBuiltinSkillPath(builtinSkillsRoot, slug);
    // Same defense-in-depth guard — builtinPath is null only for traversal slugs.
    /* c8 ignore next */
    if (builtinPath && existsSync(builtinPath)) {
      const raw = readFileSync(builtinPath, "utf-8");
      const { description, body, allowedTools } = parseSkillFile(raw);
      const stat = statSync(builtinPath);
      return {
        name: slug,
        description,
        content: body.replace(/^\n/, ""),
        allowedTools,
        builtin: true,
        updatedAt: stat.mtime.toISOString(),
      };
    }
    return null;
  }

  // POST /skills/upload — multipart upload of a SKILL.md file
  //
  // Register this BEFORE /skills/:name patterns so Hono's radix router
  // resolves the static segment "upload" as the literal endpoint rather
  // than treating it as a :name parameter.
  async function handleUpload(c: Context) {
    const form = await c.req.formData().catch(() => null);
    if (!form) {
      return respondWithAgentError(c, 400, [
        composeIssue("skills.invalid_form", {
          field: "body",
          received: "<unparseable multipart>",
        }),
      ]);
    }
    const file = form.get("file");
    const nameOverride = (form.get("name") as string | null) ?? null;
    if (!(file instanceof File)) {
      return respondWithAgentError(c, 400, [
        composeIssue("skills.file_field_required", {
          field: "file",
          received: "<missing>",
        }),
      ]);
    }
    // Derive slug from override, filename (stripping .md), or parent folder name
    const fallback = file.name.replace(/\.md$/i, "").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const slug = nameOverride ?? fallback;
    const slugCheck = skillNameSchema.safeParse(slug);
    if (!slugCheck.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("skills.invalid_name", { field: "name", received: slug })],
        {
          legacyFields: {
            message: slugCheck.error.issues[0]?.message,
            slug,
          },
        },
      );
    }
    if (isBuiltinSlug(slug)) {
      return respondWithAgentError(
        c,
        403,
        [composeIssue("skills.builtin_protected", { field: "name", received: slug })],
        { legacyFields: { name: slug } },
      );
    }

    const rawBuf = Buffer.from(await file.arrayBuffer());
    if (rawBuf.length > 256 * 1024) {
      return respondWithAgentError(
        c,
        413,
        [
          composeIssue("skills.file_too_large", {
            field: "file",
            received: rawBuf.length,
          }),
        ],
        { legacyFields: { maxBytes: 256 * 1024 } },
      );
    }
    // Reject non-UTF-8 (e.g. a binary file renamed to .md). Without this
    // check, toString("utf-8") silently inserts replacement chars and we'd
    // write garbage to the skill file.
    if (!isUtf8(rawBuf)) {
      return respondWithAgentError(
        c,
        400,
        [
          composeIssue("skills.invalid_encoding", {
            field: "file",
            received: "<not UTF-8>",
          }),
        ],
        { legacyFields: { message: "file must be valid UTF-8" } },
      );
    }
    const raw = rawBuf.toString("utf-8");
    const { description, body, allowedTools } = parseSkillFile(raw);
    const content = body.replace(/^\n/, "");
    if (!content) {
      return respondWithAgentError(c, 400, [
        composeIssue("skills.empty_content", { field: "content", received: "<empty>" }),
      ]);
    }
    // Reject descriptions with embedded newlines even when parsed from an
    // upload — the regex-based parser can't round-trip them safely.
    // The `^description:\s*(.*)$` regex in parseSkillFile can never return
    // \r or \n in the parsed value (JS `$` in multiline mode matches before
    // both \r and \n), so this branch is unreachable in practice.
    /* c8 ignore start */
    if (/[\r\n]/.test(description)) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("skills.invalid_description", { field: "description", received: description })],
        { legacyFields: { message: "description cannot contain newlines" } },
      );
    }
    /* c8 ignore stop */

    const skillFile = safeSkillPath(userSkillsRoot, slug);
    // skillFile is null only for traversal slugs; the zod slug check above
    // already rejects those — this null branch is unreachable for valid slugs.
    /* c8 ignore start */
    if (!skillFile) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("skills.invalid_name", { field: "name", received: slug })],
        { legacyFields: { name: slug } },
      );
    }
    /* c8 ignore stop */

    try {
      mkdirSync(join(userSkillsRoot, slug), { recursive: true });
      const existed = existsSync(skillFile);
      // Rewrite with normalized frontmatter so uploads always round-trip cleanly
      writeFileSync(
        skillFile,
        serializeSkillFile(slug, description || slug, content, allowedTools),
        "utf-8",
      );
      logger.info({ name: slug, existed }, "User skill uploaded");
      return c.json({ status: existed ? "updated" : "created", name: slug });
    /* c8 ignore start */
    } catch (err) {
      logger.error({ err, name: slug }, "Skill upload failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        500,
        [composeIssue("skills.write_failed", { field: "write", received: message })],
        { legacyFields: { message } },
      );
    }
    /* c8 ignore stop */
  }

  app.post("/skills/upload", handleUpload);

  app.get("/skills/sources", (c) => {
    const skills = listSkillDetailsInRoot(builtinSkillsRoot, true);
    return c.json({ skills });
  });

  app.get("/skills/source", (c) => {
    const files = compiler.readSourceFiles();
    return c.json({ backend: "source", files });
  });

  app.get("/skills/manifest/:processKey", (c) => {
    const processKey = c.req.param("processKey");
    return c.json({
      processKey,
      profile: getProfileForProcess(processKey),
      skills: getSkillsForProcess(processKey),
    });
  });

  // GET /skills — list all skills (built-in + user)
  app.get("/skills", (c) => {
    const builtin = listSkillsInRoot(builtinSkillsRoot, true);
    const user = listSkillsInRoot(userSkillsRoot, false);
    // User skills before built-ins so the dashboard sees custom work first.
    return c.json({ skills: [...user, ...builtin] });
  });

  // GET /skills/:name — fetch one skill
  app.get("/skills/:name", (c) => {
    const name = c.req.param("name");
    const slugCheck = skillNameSchema.safeParse(name);
    if (!slugCheck.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("skills.invalid_name", { field: "name", received: name })],
        { legacyFields: { message: slugCheck.error.issues[0]?.message } },
      );
    }
    const skill = loadSkill(name);
    if (!skill) {
      return respondWithAgentError(
        c,
        404,
        [composeIssue("skills.not_found", { field: "name", received: name })],
        { legacyFields: { name } },
      );
    }
    return c.json(skill);
  });

  // POST /skills — create a new user skill (JSON body)
  app.post("/skills", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = skillCreateSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("skills.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error.issues } },
      );
    }

    const { name, description, content, allowedTools } = parsed.data;

    if (isBuiltinSlug(name)) {
      return respondWithAgentError(
        c,
        403,
        [composeIssue("skills.builtin_protected", { field: "name", received: name })],
        {
          legacyFields: {
            name,
            message: "Built-in skills cannot be modified by this API",
          },
        },
      );
    }

    const skillFile = safeSkillPath(userSkillsRoot, name);
    // skillFile is null only for traversal slugs; zod validation above
    // already rejects those — this branch is unreachable for valid slugs.
    /* c8 ignore start */
    if (!skillFile) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("skills.invalid_name", { field: "name", received: name })],
        { legacyFields: { name } },
      );
    }
    /* c8 ignore stop */
    if (existsSync(skillFile)) {
      return respondWithAgentError(
        c,
        409,
        [composeIssue("skills.already_exists", { field: "name", received: name })],
        { legacyFields: { name } },
      );
    }

    try {
      mkdirSync(join(userSkillsRoot, name), { recursive: true });
      writeFileSync(
        skillFile,
        serializeSkillFile(name, description, content, allowedTools ?? []),
        "utf-8",
      );
      logger.info({ name }, "User skill created");
      return c.json({ status: "created", name });
    /* c8 ignore start */
    } catch (err) {
      logger.error({ err, name }, "Skill create failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        500,
        [composeIssue("skills.write_failed", { field: "write", received: message })],
        { legacyFields: { message } },
      );
    }
    /* c8 ignore stop */
  });

  // PUT /skills/:name — replace an existing user skill (description and/or content)
  app.put("/skills/:name", async (c) => {
    const name = c.req.param("name");
    const slugCheck = skillNameSchema.safeParse(name);
    if (!slugCheck.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("skills.invalid_name", { field: "name", received: name })],
        { legacyFields: { message: slugCheck.error.issues[0]?.message } },
      );
    }
    if (isBuiltinSlug(name)) {
      return respondWithAgentError(
        c,
        403,
        [composeIssue("skills.builtin_protected", { field: "name", received: name })],
        {
          legacyFields: {
            name,
            message: "Built-in skills cannot be modified by this API",
          },
        },
      );
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = skillUpdateSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("skills.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error.issues } },
      );
    }

    const skillFile = safeSkillPath(userSkillsRoot, name);
    if (!skillFile || !existsSync(skillFile)) {
      return respondWithAgentError(
        c,
        404,
        [composeIssue("skills.not_found", { field: "name", received: name })],
        { legacyFields: { name } },
      );
    }

    try {
      // Merge partial update with current content
      const raw = readFileSync(skillFile, "utf-8");
      const current = parseSkillFile(raw);
      const nextDescription = parsed.data.description ?? current.description;
      const nextBody = parsed.data.content ?? current.body.replace(/^\n/, "");
      const nextAllowedTools = parsed.data.allowedTools ?? current.allowedTools;
      writeFileSync(
        skillFile,
        serializeSkillFile(name, nextDescription, nextBody, nextAllowedTools),
        "utf-8",
      );
      logger.info({ name }, "User skill updated");
      return c.json({ status: "updated", name });
    /* c8 ignore start */
    } catch (err) {
      logger.error({ err, name }, "Skill update failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        500,
        [composeIssue("skills.write_failed", { field: "write", received: message })],
        { legacyFields: { message } },
      );
    }
    /* c8 ignore stop */
  });

  // DELETE /skills/:name — delete a user skill
  app.delete("/skills/:name", (c) => {
    const name = c.req.param("name");
    const slugCheck = skillNameSchema.safeParse(name);
    if (!slugCheck.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("skills.invalid_name", { field: "name", received: name })],
        { legacyFields: { message: slugCheck.error.issues[0]?.message } },
      );
    }
    if (isBuiltinSlug(name)) {
      return respondWithAgentError(
        c,
        403,
        [composeIssue("skills.builtin_protected", { field: "name", received: name })],
        {
          legacyFields: {
            name,
            message: "Built-in skills cannot be deleted by this API",
          },
        },
      );
    }

    const skillFile = safeSkillPath(userSkillsRoot, name);
    if (!skillFile || !existsSync(skillFile)) {
      return respondWithAgentError(
        c,
        404,
        [composeIssue("skills.not_found", { field: "name", received: name })],
        { legacyFields: { name } },
      );
    }

    try {
      // Remove the whole skill directory so we clean up any adjacent files
      // (the API only writes SKILL.md, but users can drop references via upload)
      const skillDir = join(userSkillsRoot, name);
      rmSync(skillDir, { recursive: true, force: true });
      logger.info({ name }, "User skill deleted");
      return c.json({ status: "deleted", name });
    /* c8 ignore start */
    } catch (err) {
      logger.error({ err, name }, "Skill delete failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        500,
        [composeIssue("skills.delete_failed", { field: "delete", received: message })],
        { legacyFields: { message } },
      );
    }
    /* c8 ignore stop */
  });

  return app;
}

// Exports for tests
export { parseSkillFile, serializeSkillFile, safeSkillPath, listSkillsInRoot };

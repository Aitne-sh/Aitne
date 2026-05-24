import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { substituteBrandTokens } from "@aitne/shared";

import { listBuiltinSlugs } from "./skill-source-paths.js";
import type { MailAccount } from "../services/mail/provider.js";

export interface SkillCompilerFile {
  path: string;
  content: string;
  updatedAt: string | null;
}

/**
 * Walk a materialized session subdirectory and rewrite every `.md` file with
 * `{APP_NAME}` tokens resolved. Called immediately after `cpSync(src, dest, …)`
 * so the verbatim copy from `agent-assets/` becomes brand-substituted before
 * any downstream transform (renderReferenceIncludes, applyIntegrationModeFilter,
 * tool-deny filter) reads it. Idempotent — running it twice is a no-op.
 */
export function substituteBrandTokensInDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteBrandTokensInDir(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const original = readFileSync(full, "utf-8");
      const substituted = substituteBrandTokens(original);
      if (substituted !== original) {
        writeFileSync(full, substituted, "utf-8");
      }
    }
  }
}

interface WikiWorkspaceTokens {
  vault_path: string;
  language: string;
  workspace_name: string;
  schema_version: string;
}

let wikiWorkspaceTokenResolver:
  | ((processKey: string, workspaceName?: string) => WikiWorkspaceTokens | null)
  | null = null;

export function setWikiWorkspaceTokenResolver(
  resolver:
    | ((processKey: string, workspaceName?: string) => WikiWorkspaceTokens | null)
    | null,
): void {
  wikiWorkspaceTokenResolver = resolver;
}

function wikiTokensFor(
  processKey: string | null | undefined,
  workspaceName: string | undefined,
): WikiWorkspaceTokens | null {
  if (!processKey?.startsWith("wiki.")) return null;
  return wikiWorkspaceTokenResolver?.(processKey, workspaceName) ?? null;
}

export function substituteWikiWorkspaceTokens(
  content: string,
  processKey: string | null | undefined,
  workspaceName: string | undefined,
): string {
  const tokens = wikiTokensFor(processKey, workspaceName);
  if (!tokens) return content;
  return content
    .replaceAll("{{vault_path}}", tokens.vault_path)
    .replaceAll("{{language}}", tokens.language)
    .replaceAll("{{workspace_name}}", tokens.workspace_name)
    .replaceAll("{{schema_version}}", tokens.schema_version);
}

export function substituteWikiWorkspaceTokensInDir(
  dir: string,
  processKey: string | null | undefined,
  workspaceName: string | undefined,
): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteWikiWorkspaceTokensInDir(full, processKey, workspaceName);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const original = readFileSync(full, "utf-8");
      const substituted = substituteWikiWorkspaceTokens(original, processKey, workspaceName);
      if (substituted !== original) {
        writeFileSync(full, substituted, "utf-8");
      }
    }
  }
}

export const EMPTY_MAIL_ACCOUNTS_MD = [
  "# Mail accounts",
  "",
  "No active mail accounts are configured right now. The `mail` skill's API",
  "calls will fail without an `accountId` — do NOT guess account ids. If no",
  "account matches, tell the user no active mail account is configured and",
  "stop — account setup is outside this skill's scope.",
  "",
].join("\n");

export function renderMailAccountsMd(accounts: readonly MailAccount[]): string {
  const rows = accounts.map((a) => {
    const label = a.label ? ` (${a.label})` : "";
    return `| \`${a.id}\` | ${a.kind} | ${a.email}${label} | ${a.idleEnabled ? "IDLE" : "poll"} |`;
  });
  return [
    "# Mail accounts",
    "",
    "Active mail accounts this session can use. Resolve `accountId` from this",
    "table before calling `/api/mail/:accountId/*`. Inactive / unhealthy",
    "accounts are omitted by design — no global \"primary\" default exists;",
    "pick the account from conversation context (reply thread, user mention,",
    "or a single active row) and ask when ambiguous.",
    "",
    "| accountId | kind | email | transport |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/**
 * Remove any built-in skill directory under `destRoot` whose slug is not
 * in `keep`. Recognises a directory as a built-in by its presence under
 * the source `agent-assets/skills/` tree — anything else (user-authored
 * skill, accounts.md, etc.) is left alone, since `syncAllUserSkills` is
 * the canonical writer for those.
 *
 * Idempotent and side-effect-free when there is nothing to prune.
 * Exported for unit testing only.
 */
export function pruneStaleBuiltinSkillDirs(
  destRoot: string,
  sourceSkillsRoot: string,
  keep: readonly string[],
): void {
  if (!existsSync(destRoot)) return;
  if (!existsSync(sourceSkillsRoot)) return;
  const keepSet = new Set(keep);
  // `listBuiltinSlugs` recurses one level into category subdirs (e.g.
  // WIKI_BUILDER_DESIGN.md §9.1 `wiki/`) so wiki slugs are recognised
  // as built-ins for prune purposes even though their source dir is
  // nested. Destination layout stays flat — `<destRoot>/<slug>/` for
  // every slug regardless of source category.
  const builtinSlugs = new Set(listBuiltinSlugs(sourceSkillsRoot));
  for (const entry of readdirSync(destRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!builtinSlugs.has(entry.name)) continue;
    if (keepSet.has(entry.name)) continue;
    rmSync(join(destRoot, entry.name), { recursive: true, force: true });
  }
}

export function readTreeFiles(root: string): SkillCompilerFile[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: SkillCompilerFile[] = [];
  for (const relPath of walkTree(root)) {
    const absPath = join(root, relPath);
    const stat = statSync(absPath);
    files.push({
      path: relPath,
      content: readFileSync(absPath, "utf-8"),
      updatedAt: stat.mtime.toISOString(),
    });
  }
  return files;
}

function walkTree(root: string, current = root): string[] {
  if (!existsSync(current)) {
    return [];
  }

  const entries = readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTree(root, absPath));
      continue;
    }
    files.push(relative(root, absPath));
  }
  return files.sort();
}

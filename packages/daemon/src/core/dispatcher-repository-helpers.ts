/**
 * Zero-dependency repository-run helpers used by the dispatcher's
 * `executeRepositoryRunTask` / `executeScheduledTask` paths.
 *
 * These are pure functions — they read the inbound `taskContext` payload
 * (off the `AgentTaskEvent`) or normalise free-form repository metadata
 * (slug, classification, category) without touching dispatcher instance
 * state. Kept in their own module so the dispatcher's main file stays
 * focused on routing/lifecycle concerns; phase D-1 of
 * `docs/design/appendices/file-split-plan.md`.
 *
 * Not re-exported from `dispatcher.ts` on purpose — these were
 * file-private before the split and no external caller imports them.
 */

import type { AgentTaskEvent, BackendId } from "@aitne/shared";
import type { RepositoryDTO } from "../db/repositories-store.js";

export type RepositoryRunWorkdirMode = "temp" | "local-clone";

export interface RepositoryRunTaskContext {
  triggerSource: string;
  repositoryId: string;
  slug: string;
  localPath: string | null;
  githubRepo: string | null;
  workdirMode: RepositoryRunWorkdirMode;
  prompt: string;
  instructionMd: string | null;
  triggerId?: string;
  triggerName?: string;
  triggerEventType?: string;
  triggerEventPayload?: unknown;
}

export function parseRepositoryRunTaskContext(
  taskCtx: AgentTaskEvent["taskContext"],
): RepositoryRunTaskContext | null {
  if (!taskCtx || typeof taskCtx !== "object") return null;
  const ctx = taskCtx as Record<string, unknown>;
  if (
    ctx.triggerSource !== "manual"
    && ctx.triggerSource !== "trigger_manual_fire"
    && ctx.triggerSource !== "repository_trigger"
  ) {
    return null;
  }
  if (
    typeof ctx.repositoryId !== "string"
    || typeof ctx.slug !== "string"
    || typeof ctx.prompt !== "string"
    || (ctx.workdirMode !== "temp" && ctx.workdirMode !== "local-clone")
  ) {
    return null;
  }
  const localPath =
    typeof ctx.localPath === "string" && ctx.localPath.length > 0
      ? ctx.localPath
      : null;
  const githubRepo =
    typeof ctx.githubRepo === "string" && ctx.githubRepo.length > 0
      ? ctx.githubRepo
      : null;
  return {
    triggerSource: ctx.triggerSource,
    repositoryId: ctx.repositoryId,
    slug: ctx.slug,
    localPath,
    githubRepo,
    workdirMode: ctx.workdirMode,
    prompt: ctx.prompt,
    instructionMd: typeof ctx.instructionMd === "string" ? ctx.instructionMd : null,
    ...(typeof ctx.triggerId === "string" ? { triggerId: ctx.triggerId } : {}),
    ...(typeof ctx.triggerName === "string" ? { triggerName: ctx.triggerName } : {}),
    ...(typeof ctx.triggerEventType === "string" ? { triggerEventType: ctx.triggerEventType } : {}),
    ...("triggerEventPayload" in ctx ? { triggerEventPayload: ctx.triggerEventPayload } : {}),
  };
}

export function repositoryRunInstructionFilename(backendId: BackendId): string {
  // Keep this in lock-step with `cliInstructionFileName` in skills-compiler.ts:
  // Codex and OpenCode both auto-discover AGENTS.md from cwd, Gemini reads
  // GEMINI.md, Claude reads CLAUDE.md. Diverging here silently strands the
  // backend without instructions at repository-run time.
  if (backendId === "codex" || backendId === "opencode") return "AGENTS.md";
  if (backendId === "gemini") return "GEMINI.md";
  return "CLAUDE.md";
}

export function safeRepositoryRunDirName(slug: string): string {
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "repository";
}

export function parseGithubRepoSlug(
  value: string | null,
): [string | null, string | null] {
  if (!value) return [null, null];
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return [null, null];
  return [parts[0], parts[1]];
}

export function normalizeRepositoryClassification(
  value: unknown,
): RepositoryDTO["classification"] {
  return value === "project" ? "project" : "repo-only";
}

export function normalizeRepositoryCategory(value: unknown): RepositoryDTO["category"] {
  return value === "work" ||
    value === "personal" ||
    value === "research" ||
    value === "client" ||
    value === "other"
    ? value
    : "other";
}

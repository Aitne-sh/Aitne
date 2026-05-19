import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  renderJournalMirrorContent,
  type JournalMirrorRendering,
} from "./render.js";

export type JournalMirrorTargetKind = "filesystem" | "obsidian" | "project-root";

export interface JournalMirrorTarget {
  kind: JournalMirrorTargetKind;
  rootPath: string;
  subdirectory?: string | null;
}

export interface JournalMirrorWriteInput {
  relativePath: string;
  content: string;
  rendering: JournalMirrorRendering;
}

export interface JournalMirrorWriteResult {
  targetPath: string;
  bytesWritten: number;
}

/**
 * Mirror-only journal writer. The source markdown is already synthesized by
 * the morning routine into `context/daily/*.md`; this service only writes the
 * mirrored copy to another root for B-005 backends.
 */
export class JournalMirrorService {
  write(
    target: JournalMirrorTarget,
    input: JournalMirrorWriteInput,
  ): JournalMirrorWriteResult {
    const targetPath = resolveJournalMirrorPath(target, input.relativePath);
    const rendered = renderJournalMirrorContent(input.content, {
      rendering: input.rendering,
    });
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, rendered, "utf-8");
    return {
      targetPath,
      bytesWritten: Buffer.byteLength(rendered, "utf-8"),
    };
  }
}

export function resolveJournalMirrorPath(
  target: JournalMirrorTarget,
  relativePath: string,
): string {
  const normalizedRelativePath = normalizeRelativeJournalPath(relativePath);
  const normalizedSubdirectory = normalizeOptionalRelativePath(target.subdirectory);
  return normalizedSubdirectory
    ? join(target.rootPath, normalizedSubdirectory, normalizedRelativePath)
    : join(target.rootPath, normalizedRelativePath);
}

function normalizeOptionalRelativePath(value: string | null | undefined): string {
  if (!value) return "";
  return normalizeRelativeJournalPath(value);
}

function normalizeRelativeJournalPath(value: string): string {
  if (!value.trim()) {
    throw new Error("Journal mirror path must not be empty.");
  }
  if (isAbsolute(value)) {
    throw new Error("Journal mirror path must be relative.");
  }
  const normalized = normalize(value).replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("Journal mirror path must stay inside the target root.");
  }
  return normalized;
}

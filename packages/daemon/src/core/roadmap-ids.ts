import { randomBytes as nodeRandomBytes } from "node:crypto";

export const ROADMAP_ID_PATTERN = "rm-\\d{8}-[a-f0-9]{6}";
export const ROADMAP_ID_RE = new RegExp(`^${ROADMAP_ID_PATTERN}$`);
export const ROADMAP_ID_COMMENT_RE = new RegExp(
  `<!--\\s*id:\\s*(${ROADMAP_ID_PATTERN})\\s*-->`,
);
export const ANY_ROADMAP_ID_COMMENT_RE = /<!--\s*id:\s*([^>]+?)\s*-->/;

export interface RoadmapIdRef {
  id: string;
  line: number;
  text: string;
}

export class RoadmapIdGenerationError extends Error {
  constructor(message = "Unable to generate a unique roadmap id") {
    super(message);
    this.name = "RoadmapIdGenerationError";
  }
}

export function isRoadmapId(value: string): boolean {
  return ROADMAP_ID_RE.test(value);
}

/**
 * Heuristic: does this roadmap-id's 6-char suffix look like an LLM
 * fabrication rather than a daemon-minted random hex?
 *
 * `generateRoadmapId` produces uniformly random `[a-f0-9]{6}`. When
 * the agent is forced to invent IDs inline (e.g. because
 * `POST /api/context/roadmap/id` was misclassified as Approve and
 * 401'd — see incident 2026-04-28), Sonnet's typical fabrications
 * follow an obvious `[0-9][a-f][0-9][a-f][0-9][a-f]` digit-letter
 * alternation: `1a2b3c`, `4d5e6f`, `0d1e2f`, `7a8b9c`, etc.
 *
 * The heuristic returns true only for that strict alternation. False
 * positive rate against uniformly random suffixes is ≈ 1.3% (per ID),
 * so the operator should still review the planned replacements before
 * running the remint script in non-dry-run mode.
 *
 * Source of truth — referenced by `scripts/remint-roadmap-ids.mjs`.
 * If the heuristic changes, update the script's local mirror to match.
 */
export function looksFabricatedRoadmapId(id: string): boolean {
  if (!isRoadmapId(id)) return false;
  const suffix = id.slice(id.lastIndexOf("-") + 1);
  return /^[0-9][a-f][0-9][a-f][0-9][a-f]$/.test(suffix);
}

export function extractRoadmapIdFromLine(line: string): string | null {
  return ROADMAP_ID_COMMENT_RE.exec(line)?.[1] ?? null;
}

export function hasMalformedRoadmapIdComment(line: string): boolean {
  return ANY_ROADMAP_ID_COMMENT_RE.test(line) && !ROADMAP_ID_COMMENT_RE.test(line);
}

export function stripRoadmapIdComment(line: string): {
  line: string;
  id: string | null;
} {
  const id = extractRoadmapIdFromLine(line);
  return {
    line: line.replace(/\s*<!--\s*id:\s*[^>]+?\s*-->\s*$/, "").trimEnd(),
    id,
  };
}

export function appendRoadmapIdComment(line: string, id: string): string {
  if (!isRoadmapId(id)) {
    throw new Error(`Invalid roadmap id: ${id}`);
  }
  const stripped = stripRoadmapIdComment(line).line;
  return `${stripped}  <!-- id: ${id} -->`;
}

export function extractRoadmapIds(content: string): RoadmapIdRef[] {
  const refs: RoadmapIdRef[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const id = extractRoadmapIdFromLine(lines[index]);
    if (id) {
      refs.push({ id, line: index + 1, text: lines[index] });
    }
  }
  return refs;
}

export function findDuplicateRoadmapId(
  content: string,
): { id: string; firstLine: number; duplicateLine: number } | null {
  const seen = new Map<string, number>();
  for (const ref of extractRoadmapIds(content)) {
    const firstLine = seen.get(ref.id);
    if (firstLine !== undefined) {
      return { id: ref.id, firstLine, duplicateLine: ref.line };
    }
    seen.set(ref.id, ref.line);
  }
  return null;
}

export function findMalformedRoadmapIdComment(
  content: string,
): { line: number; text: string } | null {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (hasMalformedRoadmapIdComment(lines[index])) {
      return { line: index + 1, text: lines[index] };
    }
  }
  return null;
}

export function generateRoadmapId(args: {
  creationDate: string;
  existingIds?: Iterable<string>;
  randomBytes?: (size: number) => Buffer;
  maxAttempts?: number;
}): string {
  if (!isValidCreationDate(args.creationDate)) {
    throw new Error(`Invalid roadmap id creation date: ${args.creationDate}`);
  }
  const creationSegment = args.creationDate.replaceAll("-", "");

  const existing = new Set(args.existingIds ?? []);
  const randomBytes = args.randomBytes ?? nodeRandomBytes;
  const maxAttempts = args.maxAttempts ?? 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = `rm-${creationSegment}-${randomBytes(3).toString("hex")}`;
    if (!existing.has(id)) return id;
  }

  throw new RoadmapIdGenerationError();
}

function isValidCreationDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

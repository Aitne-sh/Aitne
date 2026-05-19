import {
  formatAgentOutboundLabel,
  normalizeAgentDisplayName,
} from "@aitne/shared";

function buildAgentIdentitySection(name: string | null | undefined): string {
  const normalized = normalizeAgentDisplayName(name);
  return [
    "## Agent Identity",
    `- AI name: ${normalized}`,
    `- WhatsApp label: ${formatAgentOutboundLabel(normalized)}`,
  ].join("\n");
}

interface SectionRange {
  start: number;
  end: number;
}

// Locate the byte range of `## Agent Identity` in already-LF-normalised
// content. Returns null when the section is absent. The range starts at the
// header and ends at either the start of the next H2 heading or end of input.
//
// Uses line-anchored scanning instead of a single regex because JavaScript
// has no end-of-string anchor that's compatible with the `m` flag (`\Z` is
// treated as a literal `Z`, so a `(?=^##\s|\Z)` lookahead silently fails
// when the section is the last one in the file). Mirrors
// `findActivePoliciesSectionRange` in `core/context/policy-index-reconciler.ts`.
function findAgentIdentitySectionRange(
  normalized: string,
): SectionRange | null {
  const headerPattern = /^## Agent Identity(?:\s|$)/m;
  const headerMatch = headerPattern.exec(normalized);
  if (!headerMatch || headerMatch.index === undefined) return null;
  const start = headerMatch.index;

  const nextHeadingPattern = /^##\s/gm;
  nextHeadingPattern.lastIndex = start + headerMatch[0].length;
  const nextMatch = nextHeadingPattern.exec(normalized);
  const end = nextMatch ? nextMatch.index : normalized.length;

  return { start, end };
}

export function upsertManagementRulesAgentIdentity(
  content: string,
  name: string | null | undefined,
): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const section = buildAgentIdentitySection(name);

  if (!normalized) {
    return section;
  }

  const range = findAgentIdentitySectionRange(normalized);
  if (range) {
    // Slice around the section and re-emit with canonical `\n\n` spacing so
    // GFM doesn't treat a following table as lazy-continuation of the last
    // bullet. The previous regex-based replace consumed the trailing blank
    // line into the match without re-emitting it, which produced output
    // like `- WhatsApp label: [name]## Source of Truth\n| ... |` — the
    // table then folded into the bullet on render.
    const before = normalized.slice(0, range.start).replace(/\s+$/u, "");
    const after = normalized.slice(range.end).replace(/^\s+/u, "");
    const beforePart = before ? `${before}\n\n` : "";
    const afterPart = after ? `\n\n${after}` : "";
    return `${beforePart}${section}${afterPart}`;
  }

  const titleMatch = normalized.match(/^# .+$/m);
  if (!titleMatch || titleMatch.index === undefined) {
    return `${section}\n\n${normalized}`;
  }

  const titleEnd = titleMatch.index + titleMatch[0].length;
  const before = normalized.slice(0, titleEnd).trimEnd();
  const after = normalized.slice(titleEnd).trimStart();
  return after
    ? `${before}\n\n${section}\n\n${after}`
    : `${before}\n\n${section}`;
}

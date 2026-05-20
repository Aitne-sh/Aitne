import type { BrowserHistoryCategory } from "@aitne/shared";

export interface MeaningfulCandidate {
  scheme: string;
  host: string;
  path: string;
  category: BrowserHistoryCategory;
  foregroundSeconds: number | null;
}

export type MeaningfulReason =
  | "scheme_blocked"
  | "category_blocked"
  | "path_denied"
  | "below_dwell_threshold"
  | "domain_noise"
  | "meaningful";

export interface MeaningfulVerdict {
  meaningful: boolean;
  reason: MeaningfulReason;
}

const ALLOWED_CATEGORIES = new Set<BrowserHistoryCategory>([
  "research",
  "news",
  "dev",
]);

const PATH_DENYLIST_SEGMENTS = [
  "settings",
  "preferences",
  "account",
  "profile",
  "admin",
  "dashboard",
  "billing",
  "subscription",
  "login",
  "signin",
  "auth",
  "logout",
  "oauth",
];

const PATH_DENYLIST_PREFIXES = ["api"];

const MIN_FOREGROUND_SECONDS = 30;

interface DomainNoiseRule {
  host: string;
  noiseSegments: readonly string[];
  contentSegments?: readonly string[];
}

const DOMAIN_NOISE_RULES: readonly DomainNoiseRule[] = [
  {
    host: "claude.ai",
    noiseSegments: ["settings", "account", "billing", "usage", "organization"],
    contentSegments: ["chat", "docs", "research"],
  },
  {
    host: "chatgpt.com",
    noiseSegments: ["settings", "account", "billing"],
  },
  {
    host: "gemini.google.com",
    noiseSegments: ["settings", "account", "billing"],
  },
  {
    host: "chat.deepseek.com",
    noiseSegments: ["settings", "account", "billing"],
  },
  {
    host: "github.com",
    noiseSegments: ["settings", "notifications", "account", "billing"],
  },
];

function pathSegments(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

function pathContainsSegment(path: string, candidates: readonly string[]): boolean {
  const segments = pathSegments(path);
  return segments.some((segment) => candidates.includes(segment));
}

function pathStartsWithSegment(path: string, candidates: readonly string[]): boolean {
  const segments = pathSegments(path);
  if (segments.length === 0) return false;
  return candidates.includes(segments[0]);
}

function hostMatches(host: string, target: string): boolean {
  const cleaned = host.replace(/^www\./i, "").toLowerCase();
  const t = target.toLowerCase();
  return cleaned === t || cleaned.endsWith(`.${t}`);
}

function applyDomainNoiseRule(host: string, path: string): MeaningfulReason | null {
  for (const rule of DOMAIN_NOISE_RULES) {
    if (!hostMatches(host, rule.host)) continue;
    const segments = pathSegments(path);
    const first = segments[0];
    if (rule.contentSegments && first && rule.contentSegments.includes(first)) {
      return null;
    }
    if (rule.noiseSegments.includes(first ?? "")) return "domain_noise";
    // Default policy for `claude.ai`, `chatgpt.com`, etc.: if there are
    // no content paths declared, treat anything outside the noise list
    // as ambiguous and let other filters decide; if contentSegments are
    // declared and the path is not in them, we still allow downstream
    // checks (path-denylist, category) to rule on the visit. This keeps
    // the rule narrow rather than aggressively blocking.
  }
  return null;
}

export function classifyMeaningful(input: MeaningfulCandidate): MeaningfulVerdict {
  const scheme = (input.scheme || "").toLowerCase();
  if (scheme !== "https:" && scheme !== "http:") {
    return { meaningful: false, reason: "scheme_blocked" };
  }
  // Treat plain `http:` as suspicious for research signals — modern
  // content is HTTPS and Layer 1 should not count plain-HTTP visits
  // toward research clusters. This is in line with the design's
  // "scheme allowlist: https:// only" rule.
  if (scheme !== "https:") {
    return { meaningful: false, reason: "scheme_blocked" };
  }
  if (!ALLOWED_CATEGORIES.has(input.category)) {
    return { meaningful: false, reason: "category_blocked" };
  }
  if (pathStartsWithSegment(input.path, PATH_DENYLIST_PREFIXES)) {
    return { meaningful: false, reason: "path_denied" };
  }
  if (pathContainsSegment(input.path, PATH_DENYLIST_SEGMENTS)) {
    return { meaningful: false, reason: "path_denied" };
  }
  const noise = applyDomainNoiseRule(input.host, input.path);
  if (noise) {
    return { meaningful: false, reason: noise };
  }
  const foreground = input.foregroundSeconds ?? 0;
  if (foreground < MIN_FOREGROUND_SECONDS) {
    return { meaningful: false, reason: "below_dwell_threshold" };
  }
  return { meaningful: true, reason: "meaningful" };
}

export function isMeaningful(input: MeaningfulCandidate): boolean {
  return classifyMeaningful(input).meaningful;
}

import type { BrowserHistoryCategory } from "@aitne/shared";

export interface MeaningfulCandidate {
  scheme: string;
  host: string;
  path: string;
  category: BrowserHistoryCategory;
  foregroundSeconds: number | null;
}

/**
 * BROWSER_HISTORY_INTEGRATION_PLAN §5.F1.meaningful rule 6 — user-curated
 * domain allowlist / denylist for the meaningful-research filter. Both
 * default to an empty `Set`. When the allowlist is non-empty, the filter
 * switches to "allowlist-only" mode: a visit is meaningful only if its
 * eTLD+1 is in the allowlist AND it passes rules 1-5. The denylist is
 * always-on and wins over the allowlist (defensive — explicit deny
 * always denies). Entries must already be normalized to eTLD+1 by the
 * caller; `normalizeResearchDomain` does that work for raw user input.
 */
export interface ResearchDomainLists {
  allowlist: ReadonlySet<string>;
  denylist: ReadonlySet<string>;
}

export const EMPTY_RESEARCH_DOMAIN_LISTS: ResearchDomainLists = {
  allowlist: new Set(),
  denylist: new Set(),
};

export type MeaningfulReason =
  | "scheme_blocked"
  | "category_blocked"
  | "path_denied"
  | "below_dwell_threshold"
  | "domain_noise"
  | "domain_denylisted"
  | "domain_outside_allowlist"
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

export function classifyMeaningful(
  input: MeaningfulCandidate,
  domainLists: ResearchDomainLists = EMPTY_RESEARCH_DOMAIN_LISTS,
): MeaningfulVerdict {
  // Rule 6 (denylist) runs first per §5.F1.meaningful precedence:
  // "denylist > allowlist (if set) > per-domain noise > scheme > path
  // > category > foreground threshold". Denylist always wins; an
  // explicit "never count this domain" stamp shouldn't depend on the
  // visit passing other gates first.
  const etld1 = registeredDomain(input.host);
  if (etld1 && domainLists.denylist.has(etld1)) {
    return { meaningful: false, reason: "domain_denylisted" };
  }
  // Allowlist mode switch — only engaged when the set is non-empty.
  // A visit outside the allowlist is non-meaningful even if it would
  // otherwise have passed rules 1-5. This is what makes "I only want
  // my serious research domains tracked" expressible without losing
  // the row history (the visit is still inserted, just doesn't
  // contribute to cluster meaningful_* totals).
  if (domainLists.allowlist.size > 0) {
    if (!etld1 || !domainLists.allowlist.has(etld1)) {
      return { meaningful: false, reason: "domain_outside_allowlist" };
    }
  }
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

export function isMeaningful(
  input: MeaningfulCandidate,
  domainLists: ResearchDomainLists = EMPTY_RESEARCH_DOMAIN_LISTS,
): boolean {
  return classifyMeaningful(input, domainLists).meaningful;
}

const TWO_LEVEL_TLDS = new Set([
  "co.jp",
  "co.uk",
  "com.au",
  "com.br",
  "co.kr",
  "co.nz",
  "ac.jp",
  "ne.jp",
  "or.jp",
]);

/**
 * eTLD+1 extractor — strips `www.`, lowercases, and returns the
 * registered-domain label (last two labels, or last three when the
 * tail is a known two-level public suffix like `co.jp`). Mirrors the
 * private helper in `sensitive-hosts.ts` (kept distinct because the
 * sensitive-host module returns the bare registered label for keyword
 * probing; here we need the full registered domain for set membership).
 */
function registeredDomain(host: string): string {
  if (!host) return "";
  const cleaned = host.replace(/^www\./i, "").toLowerCase();
  const parts = cleaned.split(".").filter((segment) => segment.length > 0);
  if (parts.length === 0) return "";
  if (parts.length < 3) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_LEVEL_TLDS.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

/**
 * Normalize a user-supplied research-domain entry to its eTLD+1 form.
 * Accepts free-form input — `arxiv.org`, `https://arxiv.org`,
 * `www.arxiv.org/abs/2402.06196`, ` ARXIV.ORG ` all resolve to
 * `"arxiv.org"`. Returns the empty string when the input contains no
 * extractable host (caller skips empty entries).
 */
export function normalizeResearchDomain(input: string): string {
  if (!input) return "";
  let value = input.trim();
  if (!value) return "";
  // Strip scheme + leading slashes if the user pasted a URL.
  const schemeStripped = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Take the host portion (everything up to the first slash / question
  // mark / colon for port — but leave the rest of the string intact
  // for the lowercase + parse step below).
  const hostPortion = schemeStripped.split(/[/?#]/, 1)[0]!;
  // Drop any user@ prefix or :port suffix; we only care about the host.
  const hostNoUser = hostPortion.includes("@")
    ? hostPortion.slice(hostPortion.indexOf("@") + 1)
    : hostPortion;
  const hostNoPort = hostNoUser.split(":", 1)[0]!;
  value = hostNoPort;
  return registeredDomain(value);
}

/**
 * Build a `ResearchDomainLists` from raw config arrays. Filters empty /
 * invalid entries, normalizes each entry to eTLD+1, and de-duplicates.
 * The returned `Set`s are frozen-by-convention (Set is mutable but the
 * caller treats them as read-only). The denylist wins over the
 * allowlist when both contain the same domain — same precedence the
 * classifier itself encodes.
 */
export function buildResearchDomainLists(
  allowlistInput: readonly string[] | undefined,
  denylistInput: readonly string[] | undefined,
): ResearchDomainLists {
  const allowlist = new Set<string>();
  for (const raw of allowlistInput ?? []) {
    const normalized = normalizeResearchDomain(raw);
    if (normalized) allowlist.add(normalized);
  }
  const denylist = new Set<string>();
  for (const raw of denylistInput ?? []) {
    const normalized = normalizeResearchDomain(raw);
    if (normalized) denylist.add(normalized);
  }
  return { allowlist, denylist };
}

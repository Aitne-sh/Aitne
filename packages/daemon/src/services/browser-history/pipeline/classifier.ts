import type { BrowserHistoryCategory } from "@aitne/shared";
import { classifyHost } from "./sensitive-hosts.js";

export interface ClassifierInput {
  scheme: string;
  host: string;
  path: string;
}

const APP_CONFIG_SCHEMES = new Set([
  "chrome:",
  "edge:",
  "brave:",
  "about:",
  "chrome-extension:",
  "moz-extension:",
]);

const APP_CONFIG_PATH_SEGMENTS = [
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

const CLOUD_CONSOLE_HOSTS = [
  "console.aws.amazon.com",
  "console.cloud.google.com",
  "portal.azure.com",
  "console.cloudflare.com",
];

const DEV_DOMAINS = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "stackoverflow.com",
  "stackexchange.com",
  "developer.mozilla.org",
  "npmjs.com",
  "pypi.org",
  "crates.io",
  "rust-lang.org",
  "golang.org",
  "go.dev",
  "kubernetes.io",
  "docker.com",
  "registry.hub.docker.com",
  "anthropic.com",
  "platform.openai.com",
  "claude.ai",
  "chatgpt.com",
  "gemini.google.com",
  "huggingface.co",
];

const SOCIAL_DOMAINS = [
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "reddit.com",
  "threads.net",
  "bsky.app",
  "mastodon.social",
  "discord.com",
  "telegram.org",
];

const NEWS_DOMAINS = [
  "nytimes.com",
  "washingtonpost.com",
  "wsj.com",
  "ft.com",
  "bbc.com",
  "bbc.co.uk",
  "reuters.com",
  "bloomberg.com",
  "theguardian.com",
  "economist.com",
  "cnn.com",
  "npr.org",
  "axios.com",
  "techcrunch.com",
  "theverge.com",
  "arstechnica.com",
  "wired.com",
  "ycombinator.com",
  "news.ycombinator.com",
];

const ENTERTAINMENT_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "netflix.com",
  "twitch.tv",
  "spotify.com",
  "tiktok.com",
  "vimeo.com",
  "hulu.com",
  "disneyplus.com",
];

const SHOPPING_DOMAINS = [
  "amazon.com",
  "amazon.co.jp",
  "amazon.co.uk",
  "amazon.de",
  "amazon.fr",
  "amazon.in",
  "amazon.ca",
  "amazon.com.au",
  "amazon.com.br",
  "amazon.it",
  "amazon.es",
  "ebay.com",
  "etsy.com",
  "walmart.com",
  "target.com",
  "bestbuy.com",
  "rakuten.co.jp",
  "yahoo.co.jp/shopping",
  "shopify.com",
  "aliexpress.com",
  "shopee.com",
  "mercari.com",
];

const RESEARCH_DOMAINS = [
  "wikipedia.org",
  "arxiv.org",
  "scholar.google.com",
  "semanticscholar.org",
  "papers.ssrn.com",
  "researchgate.net",
  "academic.oup.com",
  "nature.com",
  "science.org",
  "acm.org",
  "ieee.org",
  "biorxiv.org",
  "medrxiv.org",
  "openreview.net",
  "distill.pub",
  "ai.googleblog.com",
  "openai.com",
  "deepmind.com",
  "deepmind.google",
];

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function pathHasSegment(path: string, candidates: readonly string[]): boolean {
  const segments = pathSegments(path);
  if (segments.length === 0) return false;
  const lower = segments.map((segment) => segment.toLowerCase());
  return lower.some((segment) => candidates.includes(segment));
}

function eTldPlusOne(host: string): string {
  // Lightweight registered-domain heuristic. We do not bundle a full PSL
  // table; the classifier already operates on host strings drawn from the
  // browser's own URL parser, and false positives in eTLD+1 detection
  // only affect category routing (not redaction — that goes through
  // sensitive-hosts.ts which has its own eTLD logic).
  const cleaned = host.replace(/^www\./i, "").toLowerCase();
  return cleaned;
}

function hostMatchesAny(host: string, domains: readonly string[]): boolean {
  const cleaned = eTldPlusOne(host);
  return domains.some((domain) => {
    const d = domain.toLowerCase();
    return cleaned === d || cleaned.endsWith(`.${d}`);
  });
}

function hostMatchesPrefixedAny(
  host: string,
  prefixes: readonly string[],
): boolean {
  const cleaned = host.toLowerCase();
  return prefixes.some((prefix) => cleaned === prefix || cleaned.endsWith(`.${prefix}`));
}

export function classifyVisit(input: ClassifierInput): BrowserHistoryCategory {
  const scheme = (input.scheme || "").toLowerCase();
  const host = (input.host || "").toLowerCase();
  const path = input.path || "/";

  if (APP_CONFIG_SCHEMES.has(scheme)) return "app-config";
  if (scheme === "file:") return "localhost";

  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "localhost";
  }

  // Sensitive categories first — they short-circuit any later classification.
  const sensitive = classifyHost(host);
  if (sensitive) return sensitive;

  if (hostMatchesPrefixedAny(host, CLOUD_CONSOLE_HOSTS)) {
    return "cloud-console";
  }

  if (pathHasSegment(path, APP_CONFIG_PATH_SEGMENTS)) {
    return "app-config";
  }

  if (hostMatchesAny(host, RESEARCH_DOMAINS)) return "research";
  if (hostMatchesAny(host, DEV_DOMAINS)) return "dev";
  if (hostMatchesAny(host, NEWS_DOMAINS)) return "news";
  if (hostMatchesAny(host, SHOPPING_DOMAINS)) return "shopping";
  if (hostMatchesAny(host, SOCIAL_DOMAINS)) return "social";
  if (hostMatchesAny(host, ENTERTAINMENT_DOMAINS)) return "entertainment";

  return "other";
}

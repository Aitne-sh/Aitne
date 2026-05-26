export type StalenessTier = "loud" | "quiet";

export interface PromptContextChangeMetadata {
  tierReason?: string;
}

export type PromptContextChangedCallback = (
  path: string,
  reason: string,
  tier?: StalenessTier,
  metadata?: PromptContextChangeMetadata,
) => void;

export interface ContextStalenessClassification {
  tier: StalenessTier;
  tierReason: string;
}

export interface ContextWriteStalenessInput {
  path: string;
  method: "PUT" | "PATCH" | "RESTORE" | "REPAIR";
  mode?: string;
  section?: string;
  content?: string;
  previousContent?: string;
}

export interface PromptContextStalenessDecision {
  requestedTier: StalenessTier;
  effectiveTier: StalenessTier;
  invalidatesDmSessions: boolean;
  skippedForSetup: boolean;
}

export interface PromptContextStalenessInput {
  path: string;
  reason: string;
  tier?: StalenessTier;
  metadata?: PromptContextChangeMetadata;
}

export interface ApplyPromptContextStalenessOptions {
  dmStalenessStrict: boolean;
  setupInProgress: boolean;
  markContextChanged: () => void;
  markActiveDmSessionsStale: (reason: string) => void;
}

const QUIET_PROJECT_ACTIVITY_SECTIONS = new Set([
  "activity_log",
  "daily_activity_log",
]);

export function normalizeContextWritePath(path: string): string {
  return path.replace(/\.(md|base)$/i, "");
}

export function normalizeContextSection(section: string | undefined): string {
  return (section ?? "")
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

export function classifyContextWriteStaleness(
  input: ContextWriteStalenessInput,
): ContextStalenessClassification {
  const path = normalizeContextWritePath(input.path);
  const section = normalizeContextSection(input.section);

  if (path === "state/today" && input.method === "PATCH") {
    if (section === "agent_log") {
      return {
        tier: "quiet",
        tierReason: "today_agent_log_section",
      };
    }
    if (
      !section
      && input.mode === "append_to_file"
      && appendWouldLandInAgentLog(input.previousContent)
      && looksLikeAgentLogEntry(input.content)
    ) {
      return {
        tier: "quiet",
        tierReason: "today_agent_log_append_to_file",
      };
    }
  }

  if (
    path.startsWith("plans/projects/")
    && input.method === "PATCH"
    && QUIET_PROJECT_ACTIVITY_SECTIONS.has(section)
  ) {
    return {
      tier: "quiet",
      tierReason: "project_activity_log_section",
    };
  }

  return {
    tier: "loud",
    tierReason: "default_loud",
  };
}

export function resolvePromptContextStaleness(
  input: {
    tier?: StalenessTier;
    dmStalenessStrict: boolean;
    setupInProgress: boolean;
  },
): PromptContextStalenessDecision {
  const requestedTier = input.tier ?? "loud";
  const effectiveTier = input.dmStalenessStrict ? "loud" : requestedTier;
  const skippedForSetup = input.setupInProgress;
  return {
    requestedTier,
    effectiveTier,
    skippedForSetup,
    invalidatesDmSessions: !skippedForSetup && effectiveTier === "loud",
  };
}

export function applyPromptContextStaleness(
  input: PromptContextStalenessInput,
  opts: ApplyPromptContextStalenessOptions,
): PromptContextStalenessDecision {
  const decision = resolvePromptContextStaleness({
    tier: input.tier,
    dmStalenessStrict: opts.dmStalenessStrict,
    setupInProgress: opts.setupInProgress,
  });

  if (decision.invalidatesDmSessions) {
    opts.markContextChanged();
    opts.markActiveDmSessionsStale(`${input.reason}:${input.path}`);
  }

  return decision;
}

function appendWouldLandInAgentLog(content: string | undefined): boolean {
  if (!content) return false;
  const headings = [...content.matchAll(/^##\s+(.+)$/gm)];
  if (headings.length === 0) return false;
  const lastHeading = headings[headings.length - 1]?.[1];
  return normalizeContextSection(lastHeading) === "agent_log";
}

function looksLikeAgentLogEntry(content: string | undefined): boolean {
  const firstLine = content
    ?.split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (!firstLine) return false;
  return /^-\s*(?:\d{2}:\d{2}\b|\[[a-z0-9_.:-]+\s+\d{2}:\d{2}\])/i.test(firstLine);
}

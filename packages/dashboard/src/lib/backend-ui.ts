import { isRuntimeAvailableBackendId, type BackendId } from "@aitne/shared";

export const BACKEND_LABELS: Record<BackendId, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

/**
 * Dashboard-only "coming soon" gate. Backends listed here keep their full
 * daemon-side wiring (BackendRouter, IAgentCore, API write-acceptance via
 * `RUNTIME_AVAILABLE_BACKEND_IDS`) but the dashboard renders them as
 * preview-only so the user cannot pick them from any selector. The cards
 * stay visible so users see what is on the roadmap; only the controls are
 * disabled.
 *
 * This gate is intentionally separate from `RUNTIME_AVAILABLE_BACKEND_IDS`
 * — removing a backend from the runtime gate also rejects API writes and
 * cascades existing rows, which is the wrong default for a release-blocked
 * "untested but functional" backend. To re-enable a backend everywhere,
 * remove it from this set and the cards/dropdowns will automatically
 * become selectable again — no other UI edits needed.
 */
export const UI_PREVIEW_ONLY_BACKEND_IDS: ReadonlySet<BackendId> = new Set<BackendId>([
  "opencode",
]);

export function isUiPreviewOnlyBackend(backendId: BackendId): boolean {
  return UI_PREVIEW_ONLY_BACKEND_IDS.has(backendId);
}

/**
 * Combined gate: true if the user must not be able to pick this backend in
 * the dashboard. Covers both
 *  - the runtime gate (`RUNTIME_AVAILABLE_BACKEND_IDS`) — daemon has no
 *    `IAgentCore` wired and rejects API writes with
 *    `backend_not_runtime_supported`, and
 *  - the UI-only preview gate above — daemon would run fine, but a release
 *    has flagged the backend off the UI.
 *
 * This is the single helper every dashboard selector should reach for so
 * that the two gates stay consistent across cards, dropdowns, radios, and
 * native `<select>` elements.
 */
export function isBackendSelectionDisabled(backendId: BackendId): boolean {
  return (
    !isRuntimeAvailableBackendId(backendId) || isUiPreviewOnlyBackend(backendId)
  );
}

export const UI_PREVIEW_ONLY_REASON =
  "Coming soon — OpenCode is wired internally but not yet ready for selection in this release. The card stays visible so you can see what is on the roadmap.";

/** Compact suffix appended to dropdown labels for preview-only backends. */
export const UI_PREVIEW_ONLY_BADGE_SUFFIX = " (coming soon)";

const BACKEND_SHORT_LABELS: Record<BackendId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
};

/**
 * Provider-friendly labels for backend / API-key UIs. Users think in
 * terms of "I have an Anthropic API key", not "I have a Claude Code
 * API key" — so surfaces that name the upstream provider (setup
 * wizard backend step, /settings/models API-key panel) should prefer
 * this set over BACKEND_LABELS (which names the CLI product).
 */
export const BACKEND_PROVIDER_LABELS: Record<BackendId, string> = {
  claude: "Claude (Anthropic)",
  codex: "ChatGPT (OpenAI)",
  gemini: "Gemini (Google)",
  opencode: "OpenCode (sst/opencode)",
};

/** Short provider name used in compact badges (e.g. "ChatGPT" not "OpenAI Codex"). */
export const BACKEND_PROVIDER_SHORT: Record<BackendId, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  gemini: "Gemini",
  opencode: "OpenCode",
};

/**
 * Per-backend description of the web-search toggle on `/settings/models`.
 * Each backend wires to a different upstream surface, so the hint names
 * that surface so the user knows what they are turning on.
 *
 * - Claude: SDK-native `WebSearch` tool, gated by allowedTools.
 * - Codex: OpenAI Responses-API `web_search` tool, enabled per-spawn via
 *   `-c tools.web_search=true`. Works under the workspace-write sandbox
 *   because the tool runs server-side at OpenAI — no sandbox bypass
 *   required.
 * - Gemini: `google_web_search` tool, allowed via the per-session admin
 *   policy TOML.
 */
export const BACKEND_WEB_SEARCH_DESCRIPTIONS: Record<BackendId, string> = {
  claude: "Lets the agent call Anthropic's built-in WebSearch tool.",
  codex:
    "Lets the agent call OpenAI's web_search tool. Works in safe (sandbox) mode — the tool runs at OpenAI, not as a local shell command.",
  gemini: "Lets the agent call Gemini's google_web_search tool.",
  opencode: "Lets the agent call the configured OpenCode provider's web-search tool when the OpenCode runtime is enabled.",
};

/**
 * Primary brand color per backend, chosen to match each vendor's actual
 * app-icon hue so charts read as "that's the Claude backend" at a glance.
 * - Claude — the warm red-orange of the Anthropic macOS icon.
 * - Codex (ChatGPT) — ChatGPT's icon is white, so we use a bright
 *   pink-leaning fuchsia (slightly purple-tinted pink).
 * - Gemini — the vivid Google Blue anchoring the Gemini spark gradient.
 */
export const BACKEND_COLORS: Record<BackendId, string> = {
  claude: "#E15B40", // Anthropic app-icon red-orange
  codex: "#D946EF", // bright fuchsia (pink with purple tint)
  gemini: "#1C69FF", // vivid Google Blue
  opencode: "#FF7300", // OpenCode orange
};

/**
 * A small palette of distinct shades per backend family. Used to
 * differentiate individual models within the same backend on charts
 * like the Model Breakdown pie — the eye can still group Claude/Codex/
 * Gemini by hue family, but each model gets its own readable shade.
 *
 * Each palette is ordered dark→light and contains the primary brand
 * color in the middle, so a single-model render picks the brand color
 * and small groups (2–4 models) get colors spread across the palette
 * via `assignModelColors` for maximum contrast.
 */
export const BACKEND_MODEL_PALETTES: Record<BackendId, string[]> = {
  // Anthropic red-orange / coral family.
  claude: ["#7C2D12", "#B54B2D", "#E15B40", "#F97316", "#FDBA74"],
  // OpenAI-ish pink-purple / fuchsia family.
  codex: ["#86198F", "#A21CAF", "#D946EF", "#E879F9", "#F5D0FE"],
  // Google blue family.
  gemini: ["#1E3A8A", "#1D4ED8", "#1C69FF", "#60A5FA", "#93C5FD"],
  // OpenCode orange / amber family.
  opencode: ["#7C2D12", "#C2410C", "#FF7300", "#F59E0B", "#FCD34D"],
};

const OTHER_MODEL_PALETTE = ["#6b7280", "#9ca3af", "#4b5563", "#374151"];

/**
 * Qualitative palette for categorical charts (e.g. event-type breakdown)
 * where bars have no intrinsic backend affiliation but should be visually
 * distinguishable from each other.
 */
export const CHART_CATEGORY_PALETTE: string[] = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
  "#6366f1", // indigo
  "#ef4444", // red
  "#22c55e", // green
];

export const BACKEND_BADGE_VARIANTS: Record<BackendId, "orange" | "pink" | "blue"> = {
  claude: "orange",
  codex: "pink",
  gemini: "blue",
  opencode: "orange",
};

const PROCESS_LABELS: Record<string, string> = {
  "routine.morning_routine": "Morning Routine",
  "routine.evening_review": "Evening Review",
  "routine.weekly_review": "Weekly Review",
  "routine.monthly_review": "Monthly Review",
  "routine.hourly_check": "Hourly Check",
  "routine.roadmap_refresh": "Roadmap Refresh",
  "message.dm": "Direct Messages",
  "message.mention": "Mentions",
  "dashboard.chat": "Dashboard Chat",
  "agent.task": "Scheduled Tasks",
  "calendar.change": "Calendar Events",
  "gmail_classify": "Gmail Classification",
  "github.pull_request.review_requested": "GitHub Review Requests",
  "github.assigned": "GitHub Assignments",
  "github.security_alert": "GitHub Security Alerts",
  "github.workflow_run.failed": "GitHub CI Failures",
  "wiki.ingest_url": "Wiki URL Ingest",
  "wiki.compile": "Wiki Compile",
  "wiki.ask": "Wiki Ask",
};

export function getBackendLabel(backendId: BackendId): string {
  return BACKEND_LABELS[backendId];
}

export function getBackendShortLabel(backendId: BackendId): string {
  return BACKEND_SHORT_LABELS[backendId];
}

export function getProcessLabel(processKey: string): string {
  return PROCESS_LABELS[processKey] ?? processKey;
}

export function getProcessGroup(processKey: string): string {
  if (processKey.startsWith("wiki.")) return "Wiki";
  if (processKey.startsWith("message.") || processKey.startsWith("dashboard.")) {
    return "Conversation";
  }
  if (processKey.startsWith("routine.")) return "Routines";
  if (processKey.startsWith("git.") || processKey.startsWith("github.")) {
    return "Git & GitHub";
  }
  if (processKey.startsWith("calendar.") || processKey === "gmail_classify") {
    return "Integrations";
  }
  return "Tasks";
}

export function formatModelName(modelId: string | null | undefined): string {
  if (!modelId) return "Not set";

  return modelId
    .replace(/^[a-z0-9_.-]+\//i, "")
    .replace(/^claude-/, "Claude ")
    .replace(/^gpt-/, "GPT-")
    .replace(/^gemini-/, "Gemini ")
    .replace(/-/g, " ")
    .replace(/\bpreview\b/gi, "(preview)")
    .replace(/\bpro\b/gi, "Pro")
    .replace(/\bflash\b/gi, "Flash")
    .replace(/\blite\b/gi, "Lite")
    .replace(/\bmini\b/gi, "Mini")
    .replace(/\bcodex\b/gi, "Codex")
    .replace(/\bopus\b/gi, "Opus")
    .replace(/\bsonnet\b/gi, "Sonnet")
    .replace(/\bhaiku\b/gi, "Haiku")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compact model label for badge display (e.g. "Opus 4.7", "GPT-5.5").
 * Handles both legacy short forms ("opus") and full IDs ("claude-opus-4-6").
 */
export function formatShortModelName(modelId: string | null | undefined): string {
  if (!modelId) return "unknown";

  // Legacy short forms from old DB rows
  if (modelId === "opus") return "Opus";
  if (modelId === "sonnet") return "Sonnet";

  const normalized = modelId.replace(/^[a-z0-9_.-]+\//i, "");
  let s = normalized
    .replace(/-\d{8,}$/, "")                    // drop date suffix (e.g. -20251001)
    .replace(/^claude-/, "")                     // "claude-opus-4-6" → "opus-4-6"
    .replace(/(\d+)-(\d+)(?![-\d])/g, "$1.$2")  // version: "4-6" → "4.6"
    .replace(/-/g, " ");                         // remaining dashes → spaces

  // Apply prefix branding after dashes are resolved
  if (normalized.startsWith("gpt-")) s = `GPT-${s.replace(/^gpt\s*/i, "")}`;
  if (normalized.startsWith("gemini-")) s = s.replace(/^gemini\s*/i, "Gemini ");

  return s
    .replace(/\bopus\b/gi, "Opus")
    .replace(/\bsonnet\b/gi, "Sonnet")
    .replace(/\bhaiku\b/gi, "Haiku")
    .replace(/\bpro\b/gi, "Pro")
    .replace(/\bflash\b/gi, "Flash")
    .replace(/\blite\b/gi, "Lite")
    .replace(/\bmini\b/gi, "Mini")
    .replace(/\s+/g, " ")
    .trim();
}

/** Badge variant for a model string, resolved via backend detection. */
export function modelBadgeVariant(modelId: string | null | undefined): "orange" | "pink" | "blue" | "gray" {
  if (!modelId) return "gray";
  const backend = detectBackendFromModel(modelId);
  return backend ? BACKEND_BADGE_VARIANTS[backend] : "gray";
}

/**
 * Parsed entry from `agent_actions.model_usage_json` — what the SDK actually
 * billed per underlying model. The SDK can silently route a request for one
 * model to a sibling (e.g. opus-4-7 → opus-4-6[1m]); this struct surfaces
 * that, so the dashboard can show the real model and matching cost.
 */
export interface BilledModelEntry {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Parse the JSON-encoded modelUsage map. Returns entries sorted by costUsd
 * desc so the dominant model is first (the one a single-row badge should
 * use). Returns an empty array on malformed input.
 */
export function parseModelUsage(json: string | null | undefined): BilledModelEntry[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];

  const entries: BilledModelEntry[] = [];
  for (const [modelId, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    entries.push({
      modelId,
      inputTokens: typeof v.inputTokens === "number" ? v.inputTokens : 0,
      outputTokens: typeof v.outputTokens === "number" ? v.outputTokens : 0,
      costUsd: typeof v.costUsd === "number" ? v.costUsd : 0,
    });
  }
  return entries.sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Return the model id the dashboard should badge for a row. Prefers the
 * dominant entry from `model_usage_json` (the SDK-billed model — what
 * actually drove the cost). Falls back to `model_used` (the requested
 * model) when modelUsage is missing or empty.
 */
export function pickDisplayModel(
  modelUsed: string | null | undefined,
  modelUsageJson: string | null | undefined,
): string | null {
  const entries = parseModelUsage(modelUsageJson);
  if (entries.length > 0 && entries[0]) {
    return entries[0].modelId;
  }
  return modelUsed ?? null;
}

export function detectBackendFromModel(modelId: string): BackendId | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+/.test(lower)) {
    return "opencode";
  }
  if (
    lower.includes("claude") ||
    lower.includes("sonnet") ||
    lower.includes("opus") ||
    lower.includes("haiku")
  ) {
    return "claude";
  }
  if (lower.includes("gemini")) return "gemini";
  if (
    lower.includes("gpt") ||
    lower.includes("codex") ||
    lower.includes("o3") ||
    lower.includes("o4")
  ) {
    return "codex";
  }
  return null;
}

/**
 * Assign a distinct color to each model. Models are grouped by backend
 * and sorted by name for stable assignment across renders; within each
 * group, colors are spread across `BACKEND_MODEL_PALETTES` so that small
 * groups (e.g. 2 Claude models) use non-adjacent palette slots and read
 * as clearly different shades, rather than two neighbouring darks.
 *
 * - 1 model  → the brand-color slot (palette midpoint)
 * - 2 models → slots at ~1/4 and ~3/4 of the palette (dark + light)
 * - 3 models → evenly spaced across the palette
 * - 4+ models → spread evenly, wrapping if the group exceeds the palette
 */
export function assignModelColors(models: string[]): Record<string, string> {
  const byBackend = new Map<BackendId | "other", string[]>();
  for (const model of models) {
    if (!model) continue;
    const backend = detectBackendFromModel(model) ?? "other";
    const bucket = byBackend.get(backend) ?? [];
    bucket.push(model);
    byBackend.set(backend, bucket);
  }

  const result: Record<string, string> = {};
  for (const [backend, list] of byBackend) {
    list.sort((a, b) => a.localeCompare(b));
    const palette =
      backend === "other" ? OTHER_MODEL_PALETTE : BACKEND_MODEL_PALETTES[backend];
    const n = list.length;
    list.forEach((model, i) => {
      let idx: number;
      if (n >= palette.length) {
        // Group larger than the palette — wrap around.
        idx = i % palette.length;
      } else if (n === 1) {
        // Single model → use the brand-color slot (palette midpoint).
        idx = Math.floor(palette.length / 2);
      } else {
        // Small group → spread across the palette so shades are distinct.
        idx = Math.floor(((i + 0.5) * palette.length) / n);
      }
      result[model] = palette[idx]!;
    });
  }
  return result;
}

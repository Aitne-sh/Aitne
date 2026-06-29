/**
 * SETUP-FLOW-REDESIGN-PLAN §5.1 — pure decision logic for the Basics
 * step. Tests live in the `.test.ts` sibling. The component is a thin
 * shell around these helpers.
 *
 * Replaces the former Welcome step + the language portion of the old
 * Vault step. Two atomic fields persisted on Continue:
 *
 *   - `agentDisplayName` — trim, length 1–40, no leading/trailing
 *     whitespace.
 *   - `language` — BCP-47 tag (e.g. `en-US`, `zh-Hans`); validated
 *     against the same regex used by the legacy vault-step logic so
 *     dashboards that already saved a custom tag round-trip cleanly.
 */

export const LANGUAGE_TAG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/** UI-visible upper bound — keeps Slack/WhatsApp prefixes readable. */
export const AGENT_DISPLAY_NAME_MAX_LENGTH = 40;

export const SUPPORTED_LANGUAGES: ReadonlyArray<{
  tag: string;
  label: string;
}> = [
  { tag: "en", label: "English" },
  { tag: "ja", label: "日本語 (Japanese)" },
  { tag: "zh", label: "中文 (Chinese)" },
  { tag: "es", label: "Español (Spanish)" },
  { tag: "fr", label: "Français (French)" },
  { tag: "de", label: "Deutsch (German)" },
  { tag: "pt", label: "Português (Portuguese)" },
  { tag: "ko", label: "한국어 (Korean)" },
  { tag: "__custom__", label: "Other (enter BCP-47 tag…)" },
];

const SUPPORTED_TAG_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LANGUAGES.filter((l) => l.tag !== "__custom__").map((l) => l.tag),
);

/**
 * Resolve the language tag the form will POST. Mirrors the legacy
 * vault-step helper — `__custom__` falls through to the user-entered
 * BCP-47 tag, anything else is the dropdown value verbatim.
 */
export function resolveLanguage(
  primarySelection: string,
  customRaw: string,
): string {
  return primarySelection === "__custom__"
    ? customRaw.trim()
    : primarySelection;
}

export function isCustomLanguageInvalid(
  primarySelection: string,
  customRaw: string,
): boolean {
  if (primarySelection !== "__custom__") return false;
  const trimmed = customRaw.trim();
  if (trimmed.length === 0) return false;
  return !LANGUAGE_TAG_RE.test(trimmed);
}

/**
 * True when the form is ready to POST. Blocks while a save is in flight
 * and when either field fails validation.
 */
export function canContinue(input: {
  agentDisplayName: string;
  resolvedLanguage: string;
  saving: boolean;
}): boolean {
  if (input.saving) return false;
  const trimmed = input.agentDisplayName.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > AGENT_DISPLAY_NAME_MAX_LENGTH) return false;
  if (input.resolvedLanguage.length === 0) return false;
  if (!LANGUAGE_TAG_RE.test(input.resolvedLanguage)) return false;
  return true;
}

/**
 * Build the `PATCH /api/config` body. Fields are emitted only when
 * non-empty so the API short-circuits no-op writes.
 */
export interface BasicsPatchBody {
  agentDisplayName: string;
  primaryLanguage: string;
}

export function buildBasicsPatchBody(input: {
  agentDisplayName: string;
  resolvedLanguage: string;
}): BasicsPatchBody {
  return {
    agentDisplayName: input.agentDisplayName.trim(),
    primaryLanguage: input.resolvedLanguage,
  };
}

/**
 * When hydrating from `config`, resolve a stored tag back into the
 * `(dropdown value, custom input)` pair the form expects. Unknown tags
 * land in `__custom__` so the user sees their previous choice intact.
 */
export function hydrateLanguageSelection(
  storedTag: string | null | undefined,
): { primary: string; custom: string } {
  if (typeof storedTag !== "string" || storedTag.length === 0) {
    return { primary: "en", custom: "" };
  }
  if (SUPPORTED_TAG_SET.has(storedTag)) {
    return { primary: storedTag, custom: "" };
  }
  return { primary: "__custom__", custom: storedTag };
}

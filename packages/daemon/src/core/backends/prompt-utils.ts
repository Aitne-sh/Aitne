import type { Event } from "@aitne/shared";
import {
  isCalendarChangeEvent,
  isMessageEvent,
  isRoutineEvent,
  isScheduledEvent,
} from "@aitne/shared";

export function buildExecutionPrompt(
  prompt: string,
  context: string,
  event: Event,
  conversationHistory?: string,
): string {
  const resolvedPrompt = resolveTemplate(prompt, context, extractEventData(event));
  if (!conversationHistory?.trim()) {
    return resolvedPrompt;
  }

  // Conversation history is built from past user / agent messages and
  // is therefore untrusted in the same sense as `event_data[content]`:
  // a prior user message could carry `</conversation_history>` to
  // close the wrapper early and inject instructions outside it. Same
  // defence as `sanitizeUntrustedTemplateValue` — escape `<`/`>` and
  // strip C0 controls.
  return [
    resolvedPrompt,
    "",
    "<conversation_history>",
    sanitizeUntrustedTemplateValue(conversationHistory),
    "</conversation_history>",
  ].join("\n");
}

export function buildSummaryPrompt(conversationText: string): string {
  // Same untrusted-content discipline as `buildExecutionPrompt` —
  // sanitise the body so a prior user message containing
  // `</conversation>` cannot close the wrapper early.
  return [
    "Summarize the following conversation concisely in the same language used by the user.",
    "Focus on: decisions made, preferences expressed, action items, and key information shared.",
    "Keep it under 300 words.",
    "",
    "<conversation>",
    sanitizeUntrustedTemplateValue(conversationText),
    "</conversation>",
  ].join("\n");
}

/**
 * Neutralise XML-tag breakout in untrusted values.
 *
 * Task-flow templates wrap event data in structural tags such as
 * `<user_input>` / `<external_content>`. If user content contains a literal
 * `</user_input>` closing tag, the rendered prompt has two close tags and
 * the model may treat the text *after* the first close tag as if it lived
 * outside the untrusted wrapper — turning a chat message into instructions.
 *
 * Defence: every `<` / `>` in user data is encoded to `&lt;` / `&gt;`
 * before substitution. The model still understands the content semantically
 * (HTML entity encoding is universally trained on); the only thing it
 * cannot do is close a structural tag from inside the data.
 *
 * Also strip C0 control characters (except `\n`, `\t`, `\r`) and DEL —
 * they can be used to confuse the model with invisible directives and
 * have no legitimate place in chat content.
 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeUntrustedTemplateValue(value: string): string {
  // The type signature says `string`, but `extractEventData` can produce
  // undefined entries when an event is missing optional fields (e.g. a
  // routine event without `routine` set in test fixtures). Coerce
  // defensively rather than throwing — the historical behaviour of
  // `resolveTemplate` was to leave the placeholder untouched on missing
  // keys, and this preserves that contract for missing/undefined values.
  if (typeof value !== "string") return "";
  return value
    .replace(CONTROL_CHARS, "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function resolveTemplate(
  template: string,
  context: string,
  eventData: Record<string, string>,
): string {
  // `context` is daemon-rendered (context-builder.ts) and contains the
  // structural XML tags the template depends on — it must NOT be sanitised.
  // Every other field originates from user-controlled sources (DM bodies,
  // calendar titles, mail subjects, etc.) and is treated as untrusted.
  //
  // Skip undefined values rather than coercing them to `""`. The
  // pre-sanitization contract was `vars[key] ?? match` — i.e. an
  // unbound placeholder is left literal in the rendered prompt — and
  // some events legitimately carry undefined fields (e.g. a routine
  // event without a `routine` slot in test fixtures). Coercing to ""
  // would silently swallow such placeholders and mask template bugs.
  const vars: Record<string, string> = { context };
  for (const [key, value] of Object.entries(eventData)) {
    if (value === undefined) continue;
    vars[`event_data[${key}]`] = sanitizeUntrustedTemplateValue(value);
  }

  return template.replace(/\{([^}]+)\}/g, (match, key: string) => vars[key] ?? match);
}

/** Max chars for user message content injected into prompts (≈ 2500 tokens) */
const MAX_EVENT_CONTENT_LENGTH = 10_000;

export function extractEventData(event: Event): Record<string, string> {
  const data: Record<string, string> = {
    type: event.type,
    source: event.source,
  };

  if (isMessageEvent(event)) {
    // Truncate user message content to prevent prompt stuffing that could
    // push out critical context (management_rules, today.md, etc.)
    const content = event.content.length > MAX_EVENT_CONTENT_LENGTH
      ? event.content.slice(0, MAX_EVENT_CONTENT_LENGTH) + "\n[...truncated]"
      : event.content;
    Object.assign(data, {
      platform: event.platform,
      sender: event.sender,
      content,
      channel: event.channel,
    });
  } else if (isCalendarChangeEvent(event)) {
    Object.assign(data, {
      event_title: event.eventTitle,
      start_time: event.startTime?.toISOString() ?? "",
      end_time: event.endTime?.toISOString() ?? "",
      change_type: event.changeType,
    });
  } else if (isRoutineEvent(event)) {
    Object.assign(data, { routine: event.routine });
  } else if (isScheduledEvent(event)) {
    // Both scheduled.task and scheduled.dm carry identical fields. The
    // sub-flow router in scheduled.dm.md keys off `{event_data[task]}`
    // prefix matching, so collapsing the branch is required — without
    // this, scheduled.dm would interpolate an empty `task` and the
    // router would fall through every fire.
    Object.assign(data, {
      task: event.task,
      task_context: JSON.stringify(event.taskContext),
    });
  }

  for (const [key, value] of Object.entries(event.data)) {
    data[key] = String(value);
  }

  return data;
}

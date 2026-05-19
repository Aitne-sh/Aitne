import type {
  SendInput,
  UpdateDraftInput,
} from "../../../services/mail/provider.js";

export function parseIntParam(
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(bounds.min, Math.min(bounds.max, n));
}

export function toStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.every((v) => typeof v === "string")) return value as string[];
  return null;
}

export function validateSendInput(
  body: unknown,
): { ok: true; value: SendInput } | { ok: false; code: string; message: string } {
  const raw = body as Partial<SendInput> & { to?: unknown; reply?: unknown };
  const to = toStringArray(raw?.to);
  if (!to || to.length === 0) {
    return {
      ok: false,
      code: "invalid_body",
      message: "to: non-empty string[] required",
    };
  }
  if (typeof raw.subject !== "string") {
    return {
      ok: false,
      code: "invalid_body",
      message: "subject: string required",
    };
  }
  const cc = raw.cc === undefined ? undefined : toStringArray(raw.cc);
  const bcc = raw.bcc === undefined ? undefined : toStringArray(raw.bcc);
  if (cc === null || bcc === null) {
    return {
      ok: false,
      code: "invalid_body",
      message: "cc/bcc must be string[] when present",
    };
  }
  const reply = parseReplyContext(raw.reply);
  if (reply === "invalid") {
    return {
      ok: false,
      code: "invalid_body",
      message: "reply requires inReplyToRfc822Id (string) and references (string[])",
    };
  }
  return {
    ok: true,
    value: {
      to,
      cc,
      bcc,
      subject: raw.subject,
      textBody: typeof raw.textBody === "string" ? raw.textBody : undefined,
      htmlBody: typeof raw.htmlBody === "string" ? raw.htmlBody : undefined,
      reply,
      // `draftOnly` is intentionally NOT surfaced at the route boundary.
      // Drafts go through POST /mail/:id/drafts (Autonomous tier); sends
      // go through POST /mail/:id/messages/send (Notify tier). Body flags
      // cannot be classified by the path-prefix risk classifier.
    },
  };
}

function parseReplyContext(
  raw: unknown,
): SendInput["reply"] | "invalid" | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return "invalid";
  const r = raw as Record<string, unknown>;
  if (typeof r.inReplyToRfc822Id !== "string") return "invalid";
  const refs = toStringArray(r.references);
  if (!refs) return "invalid";
  return {
    inReplyToRfc822Id: r.inReplyToRfc822Id,
    references: refs,
    providerThreadId:
      typeof r.providerThreadId === "string" ? r.providerThreadId : undefined,
    parentProviderMsgId:
      typeof r.parentProviderMsgId === "string"
        ? r.parentProviderMsgId
        : undefined,
  };
}

export function validateUpdateDraftInput(
  body: unknown,
):
  | { ok: true; value: UpdateDraftInput }
  | { ok: false; code: string; message: string } {
  const raw = body as Partial<UpdateDraftInput> & { reply?: unknown };
  const to = raw.to === undefined ? undefined : toStringArray(raw.to);
  const cc = raw.cc === undefined ? undefined : toStringArray(raw.cc);
  const bcc = raw.bcc === undefined ? undefined : toStringArray(raw.bcc);
  if (to === null || cc === null || bcc === null) {
    return {
      ok: false,
      code: "invalid_body",
      message: "to/cc/bcc must be string[] when present",
    };
  }
  // `reply` tri-state: undefined = leave existing threading; null = clear;
  // object = reshape (must include inReplyToRfc822Id + references).
  let reply: UpdateDraftInput["reply"];
  if (raw.reply === null) {
    reply = null;
  } else if (raw.reply !== undefined) {
    const parsed = parseReplyContext(raw.reply);
    if (parsed === "invalid") {
      return {
        ok: false,
        code: "invalid_body",
        message:
          "reply requires inReplyToRfc822Id (string) and references (string[]); pass null to clear",
      };
    }
    reply = parsed;
  }
  return {
    ok: true,
    value: {
      to,
      cc,
      bcc,
      subject: typeof raw.subject === "string" ? raw.subject : undefined,
      textBody: typeof raw.textBody === "string" ? raw.textBody : undefined,
      htmlBody: typeof raw.htmlBody === "string" ? raw.htmlBody : undefined,
      reply,
    },
  };
}

import { describe, it, expect } from "vitest";
import {
  parseIntParam,
  toStringArray,
  validateSendInput,
  validateUpdateDraftInput,
} from "./validators.js";

describe("parseIntParam", () => {
  const bounds = { min: 1, max: 100 };

  it("returns fallback when raw is undefined", () => {
    expect(parseIntParam(undefined, 42, bounds)).toBe(42);
  });

  it("returns fallback when raw is the empty string (falsy)", () => {
    expect(parseIntParam("", 7, bounds)).toBe(7);
  });

  it("returns fallback when raw is not a finite integer", () => {
    expect(parseIntParam("not-a-number", 7, bounds)).toBe(7);
  });

  it("parses a valid integer in-bounds", () => {
    expect(parseIntParam("25", 1, bounds)).toBe(25);
  });

  it("clamps below the min", () => {
    expect(parseIntParam("-5", 50, bounds)).toBe(1);
  });

  it("clamps above the max", () => {
    expect(parseIntParam("9999", 50, bounds)).toBe(100);
  });
});

describe("toStringArray", () => {
  it("treats undefined as an empty array", () => {
    expect(toStringArray(undefined)).toEqual([]);
  });

  it("rejects non-array values with null", () => {
    expect(toStringArray("hello")).toBeNull();
    expect(toStringArray(42)).toBeNull();
    expect(toStringArray({ to: "x" })).toBeNull();
    expect(toStringArray(null)).toBeNull();
  });

  it("rejects arrays containing non-strings", () => {
    expect(toStringArray(["a", 1, "b"])).toBeNull();
    expect(toStringArray([null])).toBeNull();
  });

  it("returns the array verbatim when every element is a string", () => {
    const input = ["a", "b", "c"];
    expect(toStringArray(input)).toEqual(input);
  });

  it("accepts an empty array as a string array", () => {
    expect(toStringArray([])).toEqual([]);
  });
});

describe("validateSendInput", () => {
  const validBase = {
    to: ["alice@example.test"],
    subject: "Hello",
    textBody: "Hi.",
  };

  it("accepts a minimal valid body", () => {
    const out = validateSendInput(validBase);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.to).toEqual(["alice@example.test"]);
      expect(out.value.subject).toBe("Hello");
      expect(out.value.textBody).toBe("Hi.");
      expect(out.value.htmlBody).toBeUndefined();
      expect(out.value.cc).toBeUndefined();
      expect(out.value.bcc).toBeUndefined();
      expect(out.value.reply).toBeUndefined();
    }
  });

  it("rejects when `to` is missing", () => {
    const out = validateSendInput({ subject: "x" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("invalid_body");
      expect(out.message).toMatch(/to: non-empty/);
    }
  });

  it("rejects when `to` is an empty array", () => {
    const out = validateSendInput({ to: [], subject: "x" });
    expect(out.ok).toBe(false);
  });

  it("rejects when `to` contains a non-string", () => {
    const out = validateSendInput({ to: ["ok", 5], subject: "x" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/non-empty string/);
  });

  it("rejects when subject is missing", () => {
    const out = validateSendInput({ to: ["a@b"] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/subject/);
  });

  it("rejects when subject is not a string", () => {
    const out = validateSendInput({ to: ["a@b"], subject: 123 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/subject/);
  });

  it("rejects when cc is not a string[]", () => {
    const out = validateSendInput({ ...validBase, cc: "nope" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/cc\/bcc/);
  });

  it("rejects when bcc contains a non-string", () => {
    const out = validateSendInput({ ...validBase, bcc: [42] });
    expect(out.ok).toBe(false);
  });

  it("accepts cc/bcc as undefined (omits them)", () => {
    const out = validateSendInput(validBase);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.cc).toBeUndefined();
      expect(out.value.bcc).toBeUndefined();
    }
  });

  it("accepts cc/bcc as valid string[]", () => {
    const out = validateSendInput({
      ...validBase,
      cc: ["c@b"],
      bcc: ["d@b"],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.cc).toEqual(["c@b"]);
      expect(out.value.bcc).toEqual(["d@b"]);
    }
  });

  it("accepts a well-formed reply context", () => {
    const out = validateSendInput({
      ...validBase,
      reply: {
        inReplyToRfc822Id: "<orig@host>",
        references: ["<a@host>", "<b@host>"],
        providerThreadId: "thread-1",
        parentProviderMsgId: "msg-1",
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.reply?.inReplyToRfc822Id).toBe("<orig@host>");
      expect(out.value.reply?.references).toEqual(["<a@host>", "<b@host>"]);
      expect(out.value.reply?.providerThreadId).toBe("thread-1");
      expect(out.value.reply?.parentProviderMsgId).toBe("msg-1");
    }
  });

  it("accepts reply without optional providerThreadId / parentProviderMsgId", () => {
    const out = validateSendInput({
      ...validBase,
      reply: {
        inReplyToRfc822Id: "<a>",
        references: [],
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.reply?.providerThreadId).toBeUndefined();
      expect(out.value.reply?.parentProviderMsgId).toBeUndefined();
    }
  });

  it("rejects a non-object reply", () => {
    const out = validateSendInput({ ...validBase, reply: "not-an-object" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/reply requires/);
  });

  it("rejects a reply without inReplyToRfc822Id", () => {
    const out = validateSendInput({
      ...validBase,
      reply: { references: ["<a>"] },
    });
    expect(out.ok).toBe(false);
  });

  it("rejects a reply with non-string references", () => {
    const out = validateSendInput({
      ...validBase,
      reply: { inReplyToRfc822Id: "<a>", references: ["ok", 5] },
    });
    expect(out.ok).toBe(false);
  });

  it("treats reply === null as no reply context", () => {
    const out = validateSendInput({ ...validBase, reply: null });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.reply).toBeUndefined();
  });

  it("does not propagate htmlBody when the input field is not a string", () => {
    const out = validateSendInput({ ...validBase, htmlBody: 42 });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.htmlBody).toBeUndefined();
  });

  it("does not propagate textBody when the input field is not a string", () => {
    const out = validateSendInput({
      to: ["a@b"],
      subject: "x",
      textBody: { not: "a string" },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.textBody).toBeUndefined();
  });

  it("propagates htmlBody when supplied as a string", () => {
    const out = validateSendInput({
      ...validBase,
      htmlBody: "<p>x</p>",
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.htmlBody).toBe("<p>x</p>");
  });

  it("does not surface draftOnly even if supplied", () => {
    // `draftOnly` is intentionally NOT surfaced at the route boundary.
    const out = validateSendInput({ ...validBase, draftOnly: true });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const v = out.value as { draftOnly?: boolean };
      expect(v.draftOnly).toBeUndefined();
    }
  });
});

describe("validateUpdateDraftInput", () => {
  it("accepts a fully empty body (all fields undefined)", () => {
    const out = validateUpdateDraftInput({});
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.to).toBeUndefined();
      expect(out.value.cc).toBeUndefined();
      expect(out.value.bcc).toBeUndefined();
      expect(out.value.subject).toBeUndefined();
      expect(out.value.reply).toBeUndefined();
    }
  });

  it("accepts to/cc/bcc as string[] and propagates them", () => {
    const out = validateUpdateDraftInput({
      to: ["a@b"],
      cc: ["c@b"],
      bcc: ["d@b"],
      subject: "S",
      textBody: "t",
      htmlBody: "<p>h</p>",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.to).toEqual(["a@b"]);
      expect(out.value.cc).toEqual(["c@b"]);
      expect(out.value.bcc).toEqual(["d@b"]);
      expect(out.value.subject).toBe("S");
      expect(out.value.textBody).toBe("t");
      expect(out.value.htmlBody).toBe("<p>h</p>");
    }
  });

  it("rejects when to/cc/bcc are not string[]", () => {
    expect(validateUpdateDraftInput({ to: 5 }).ok).toBe(false);
    expect(validateUpdateDraftInput({ cc: ["ok", 1] }).ok).toBe(false);
    expect(validateUpdateDraftInput({ bcc: "nope" }).ok).toBe(false);
  });

  it("treats reply: null as clear (passes null through)", () => {
    const out = validateUpdateDraftInput({ reply: null });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.reply).toBeNull();
  });

  it("treats reply: undefined as leave-as-is (omits from value)", () => {
    const out = validateUpdateDraftInput({ subject: "x" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.reply).toBeUndefined();
  });

  it("accepts a valid reply object", () => {
    const out = validateUpdateDraftInput({
      reply: {
        inReplyToRfc822Id: "<a>",
        references: ["<a>"],
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.reply).toEqual({
        inReplyToRfc822Id: "<a>",
        references: ["<a>"],
        providerThreadId: undefined,
        parentProviderMsgId: undefined,
      });
    }
  });

  it("rejects a malformed reply (returns the 'pass null to clear' hint)", () => {
    const out = validateUpdateDraftInput({ reply: { references: [] } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/pass null to clear/);
  });

  it("ignores non-string subject/textBody/htmlBody fields", () => {
    const out = validateUpdateDraftInput({
      subject: 1,
      textBody: 2,
      htmlBody: 3,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.subject).toBeUndefined();
      expect(out.value.textBody).toBeUndefined();
      expect(out.value.htmlBody).toBeUndefined();
    }
  });
});

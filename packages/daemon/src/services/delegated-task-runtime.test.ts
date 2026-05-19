import { describe, it, expect } from "vitest";
import {
  buildRetryFollowup,
  buildTaskPrompt,
  checkOutputSchema,
  classifyStructuredOutput,
  compileSchema,
  detectConfirmationEnvelope,
  detectErrorEnvelope,
  extractAndValidateResult,
  hashTaskArgs,
  isReadOnlyBareToolName,
  resolveAllowedToolPatterns,
  resolveDestructiveToolPatterns,
  resolveRunWriteClassToolPatterns,
  resolveWriteClassToolPatterns,
  sumTraceCosts,
  wrapSchemaForStructuredOutput,
} from "./delegated-task-runtime.js";

const SAMPLE_SCHEMA = {
  type: "object",
  required: ["messages"],
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        required: ["from", "subject"],
        properties: {
          from: { type: "string" },
          subject: { type: "string" },
        },
      },
    },
  },
} as const;

describe("checkOutputSchema", () => {
  it("accepts a small valid object schema", () => {
    expect(checkOutputSchema(SAMPLE_SCHEMA).ok).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(checkOutputSchema(null)).toMatchObject({ ok: false, reason: "invalid" });
    expect(checkOutputSchema("string")).toMatchObject({ ok: false, reason: "invalid" });
    expect(checkOutputSchema([1, 2])).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects schemas larger than 4 KB", () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => ({
      type: "string",
      description: `field-${i}-with-some-padding-text-to-bloat-the-payload`,
    }));
    const big = {
      type: "object",
      properties: Object.fromEntries(
        bigArray.map((s, i) => [`f${i}`, s]),
      ),
    };
    const result = checkOutputSchema(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
  });

  it("rejects remote $ref", () => {
    const schema = {
      type: "object",
      properties: {
        x: { $ref: "https://example.com/foo.json" },
      },
    };
    const result = checkOutputSchema(schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("remote_ref");
  });

  it("accepts local $ref", () => {
    const schema = {
      type: "object",
      definitions: {
        msg: { type: "string" },
      },
      properties: { x: { $ref: "#/definitions/msg" } },
    };
    expect(checkOutputSchema(schema).ok).toBe(true);
  });

  it("rejects malformed schemas (Ajv compile failure)", () => {
    const schema = { type: "not-a-real-type" };
    const result = checkOutputSchema(schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rejects schemas that JSON.stringify cannot serialize (e.g. circular refs)", () => {
    const schema: Record<string, unknown> = { type: "object" };
    schema.self = schema; // circular reference forces JSON.stringify to throw
    const result = checkOutputSchema(schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid");
      expect(result.message).toMatch(/not JSON-serializable/);
    }
  });
});

describe("buildTaskPrompt", () => {
  it("renders task, schema, allowed-tool patterns, and destructive list", () => {
    const prompt = buildTaskPrompt({
      task: "Search inbox",
      outputSchema: SAMPLE_SCHEMA,
      allowedToolPatterns: ["mcp_x_search", "mcp_x_get"],
      destructiveToolNamespaced: ["mcp_x_delete"],
      maxToolCalls: 5,
      timeoutMs: 60000,
      maxBudgetUsd: 0.05,
      allowDestructive: false,
    });
    expect(prompt).toContain("Search inbox");
    expect(prompt).toContain("- mcp_x_search");
    expect(prompt).toContain("- mcp_x_get");
    expect(prompt).toContain("- mcp_x_delete");
    expect(prompt).toContain("Maximum tool calls: 5");
    expect(prompt).toContain("60s");
    expect(prompt).toContain("$0.05");
    expect(prompt).toContain("MUST NOT execute any destructive operation");
    expect(prompt).toContain("needsConfirmation");
    // Schema is pretty-printed inline.
    expect(prompt).toContain('"messages"');
  });

  it("flips destructive prose when allowDestructive=true", () => {
    const prompt = buildTaskPrompt({
      task: "Send email",
      outputSchema: SAMPLE_SCHEMA,
      allowedToolPatterns: ["mcp_x_send"],
      destructiveToolNamespaced: ["mcp_x_send"],
      maxToolCalls: 1,
      timeoutMs: 30000,
      maxBudgetUsd: 0.05,
      allowDestructive: true,
    });
    expect(prompt).toContain("user has explicitly authorized destructive operations");
    expect(prompt).not.toContain("MUST NOT execute any destructive operation");
  });

  it("prints sentinel when allowed-tool list is empty", () => {
    const prompt = buildTaskPrompt({
      task: "x",
      outputSchema: SAMPLE_SCHEMA,
      allowedToolPatterns: [],
      destructiveToolNamespaced: [],
      maxToolCalls: 1,
      timeoutMs: 1000,
      maxBudgetUsd: 0.01,
      allowDestructive: false,
    });
    expect(prompt).toContain("(none — every tool call will fail");
    expect(prompt).toContain("(none — this integration exposes no destructive tools)");
  });
});

describe("resolveAllowedToolPatterns", () => {
  it("returns namespaced tool union for a backend", () => {
    const tools = resolveAllowedToolPatterns({
      integrationKey: "google_calendar",
      delegatedBackend: "gemini",
      allowDestructive: true,
      deniedTools: [],
    });
    expect(tools).toContain("mcp_google-workspace_calendar.listEvents");
    expect(tools).toContain("mcp_google-workspace_calendar.createEvent");
    expect(tools.every((t) => t.startsWith("mcp_google-workspace_calendar."))).toBe(true);
  });

  it("removes destructive tools when allowDestructive=false", () => {
    const tools = resolveAllowedToolPatterns({
      integrationKey: "google_calendar",
      delegatedBackend: "gemini",
      allowDestructive: false,
      deniedTools: [],
    });
    expect(tools).not.toContain("mcp_google-workspace_calendar.createEvent");
    expect(tools).not.toContain("mcp_google-workspace_calendar.deleteEvent");
    expect(tools).toContain("mcp_google-workspace_calendar.listEvents");
    expect(tools).toContain("mcp_google-workspace_calendar.getEvent");
  });

  it("removes user denied tools on top of destructive subtraction", () => {
    const tools = resolveAllowedToolPatterns({
      integrationKey: "gmail",
      delegatedBackend: "gemini",
      allowDestructive: false,
      deniedTools: ["search"],
    });
    expect(tools).not.toContain("mcp_google-workspace_gmail.search");
    expect(tools).toContain("mcp_google-workspace_gmail.get");
  });

  it("returns sorted output for stable prompt rendering", () => {
    const tools = resolveAllowedToolPatterns({
      integrationKey: "gmail",
      delegatedBackend: "claude",
      allowDestructive: true,
      deniedTools: [],
    });
    const sorted = [...tools].sort();
    expect(tools).toEqual(sorted);
  });

  it("returns [] for an integration without a connector for the requested backend", () => {
    // outlook_mail/outlook_calendar ship `backendConnectors: {}` (user-managed
    // delegated connectors). The function returns an empty list so callers
    // do not crash when probing one of these integrations.
    expect(
      resolveAllowedToolPatterns({
        integrationKey: "outlook_mail",
        delegatedBackend: "claude",
        allowDestructive: true,
        deniedTools: [],
      }),
    ).toEqual([]);
  });
});

describe("resolveDestructiveToolPatterns", () => {
  it("returns namespaced destructive tool names", () => {
    const tools = resolveDestructiveToolPatterns("gmail", "gemini");
    expect(tools).toContain("mcp_google-workspace_gmail.send");
    expect(tools).toContain("mcp_google-workspace_gmail.modify");
    expect(tools).not.toContain("mcp_google-workspace_gmail.listLabels");
  });
});

describe("isReadOnlyBareToolName", () => {
  it("classifies search/list/get/read/find/fetch/query/suggest as read-only", () => {
    for (const name of [
      "search_threads",
      "search_emails",
      "list_drafts",
      "list_labels",
      "list_calendars",
      "list_events",
      "get_thread",
      "get_event",
      "read_email",
      "read_email_thread",
      "read_attachment",
      "fetch",
      "find_pages",
      "query_data_sources",
      "suggest_time",
    ]) {
      expect(isReadOnlyBareToolName(name), name).toBe(true);
    }
  });

  it("classifies create/update/send/delete/etc as write-class", () => {
    for (const name of [
      "create_draft",
      "update_draft",
      "send_email",
      "send_draft",
      "forward_emails",
      "delete_emails",
      "archive_emails",
      "label_message",
      "create_label",
      "respond_to_event",
      "create_event",
      "update_event",
      "delete_event",
      "apply_labels_to_emails",
      "batch_modify_email",
    ]) {
      expect(isReadOnlyBareToolName(name), name).toBe(false);
    }
  });

  it("strips notion- / notion_ descriptor prefix before matching", () => {
    expect(isReadOnlyBareToolName("notion-search")).toBe(true);
    expect(isReadOnlyBareToolName("notion-fetch")).toBe(true);
    expect(isReadOnlyBareToolName("notion-get-comments")).toBe(true);
    expect(isReadOnlyBareToolName("notion_get_users")).toBe(true);
    expect(isReadOnlyBareToolName("notion-create-pages")).toBe(false);
    expect(isReadOnlyBareToolName("notion_update_page")).toBe(false);
    expect(isReadOnlyBareToolName("notion_query_data_sources")).toBe(true);
  });

  it("biases conservative on ambiguous names (treats unknown verbs as write-class)", () => {
    // §6.2 / §7.4 — false positives cost a missed retry; false negatives
    // re-execute writes. Unknown verbs land in the write-class bucket.
    expect(isReadOnlyBareToolName("dispatch_thing")).toBe(false);
    expect(isReadOnlyBareToolName("enumerate_items")).toBe(false);
    expect(isReadOnlyBareToolName("inspect_state")).toBe(false);
  });
});

describe("resolveWriteClassToolPatterns", () => {
  it("returns a strict superset of resolveDestructiveToolPatterns", () => {
    for (
      const [integrationKey, backendId] of [
        ["gmail", "claude"] as const,
        ["gmail", "codex"] as const,
        ["gmail", "gemini"] as const,
        ["google_calendar", "claude"] as const,
        ["google_calendar", "codex"] as const,
        ["google_calendar", "gemini"] as const,
        ["notion", "claude"] as const,
        ["notion", "codex"] as const,
        ["notion", "gemini"] as const,
      ]
    ) {
      const writeClass = new Set(
        resolveWriteClassToolPatterns(integrationKey, backendId),
      );
      const destructive = resolveDestructiveToolPatterns(
        integrationKey,
        backendId,
      );
      for (const d of destructive) {
        expect(writeClass.has(d), `${integrationKey}/${backendId}: ${d}`)
          .toBe(true);
      }
    }
  });

  it("includes reversible writes that are NOT destructive (create_draft, update_draft)", () => {
    // §7.4 motivating case — `create_draft` is write-class but reversible,
    // permitted by default in task mode but must still suppress retry.
    const claudeGmail = resolveWriteClassToolPatterns("gmail", "claude");
    expect(claudeGmail).toContain("mcp__claude_ai_Gmail__create_draft");
    // `list_drafts` is read-only and must NOT be in write-class.
    expect(claudeGmail).not.toContain("mcp__claude_ai_Gmail__list_drafts");

    const codexGmail = resolveWriteClassToolPatterns("gmail", "codex");
    expect(codexGmail).toContain("mcp__codex_apps__gmail._create_draft");
    expect(codexGmail).toContain("mcp__codex_apps__gmail._update_draft");
    expect(codexGmail).not.toContain("mcp__codex_apps__gmail._list_drafts");
    expect(codexGmail).not.toContain("mcp__codex_apps__gmail._search_emails");
  });

  it("excludes pure-read tools from the write-class set", () => {
    const claudeCalendar = resolveWriteClassToolPatterns(
      "google_calendar",
      "claude",
    );
    // List/get/suggest are read.
    expect(claudeCalendar).not.toContain(
      "mcp__claude_ai_Google_Calendar__list_calendars",
    );
    expect(claudeCalendar).not.toContain(
      "mcp__claude_ai_Google_Calendar__list_events",
    );
    expect(claudeCalendar).not.toContain(
      "mcp__claude_ai_Google_Calendar__get_event",
    );
    expect(claudeCalendar).not.toContain(
      "mcp__claude_ai_Google_Calendar__suggest_time",
    );
    // Create/update/delete/respond are write.
    expect(claudeCalendar).toContain(
      "mcp__claude_ai_Google_Calendar__create_event",
    );
    expect(claudeCalendar).toContain(
      "mcp__claude_ai_Google_Calendar__respond_to_event",
    );
  });

  it("strips notion descriptor prefix and classifies correctly", () => {
    const claudeNotion = resolveWriteClassToolPatterns("notion", "claude");
    expect(claudeNotion).not.toContain("mcp__claude_ai_Notion__notion-search");
    expect(claudeNotion).not.toContain("mcp__claude_ai_Notion__notion-fetch");
    expect(claudeNotion).not.toContain(
      "mcp__claude_ai_Notion__notion-get-comments",
    );
    expect(claudeNotion).toContain(
      "mcp__claude_ai_Notion__notion-create-pages",
    );
    expect(claudeNotion).toContain(
      "mcp__claude_ai_Notion__notion-update-page",
    );
  });

  it("returns sorted output for stable ordering in trace assertions", () => {
    const tools = resolveWriteClassToolPatterns("gmail", "claude");
    const sorted = [...tools].sort();
    expect(tools).toEqual(sorted);
  });

  it("returns [] for an integration without a connector for the requested backend", () => {
    // outlook_mail has `backendConnectors: {}` in the integration registry —
    // delegated mode is user-managed and ships no per-backend connector
    // variants. The defensive `!connector` branch returns an empty list so
    // the caller can fall through gracefully.
    expect(resolveWriteClassToolPatterns("outlook_mail", "claude")).toEqual([]);
  });
});

// ── DELEGATED-TASK-MODE-DESIGN.md §4.2 — Phase 2 /run write-class derivation ─

describe("resolveRunWriteClassToolPatterns", () => {
  it("classifies exact patterns by their verb suffix", () => {
    const out = resolveRunWriteClassToolPatterns([
      "mcp_my-server_search",
      "mcp_my-server_list_items",
      "mcp_my-server_get_by_id",
      "mcp_my-server_read",
      "mcp_my-server_send",
      "mcp_my-server_delete",
      "mcp_my-server_create_thing",
    ]);
    // Read-only verbs filtered out; write verbs retained.
    expect(out).toEqual([
      "mcp_my-server_send",
      "mcp_my-server_delete",
      "mcp_my-server_create_thing",
    ]);
  });

  it("treats broad globs as write-class (false-positive bias)", () => {
    // §4.2 / §6.2: a glob without a discriminating suffix carries no
    // verb hint. Better to suppress the §6.2 retry than to risk a
    // duplicate write side-effect on retry.
    const out = resolveRunWriteClassToolPatterns([
      "mcp_my-server_*",
      "mcp_other-server_*",
    ]);
    expect(out).toEqual([
      "mcp_my-server_*",
      "mcp_other-server_*",
    ]);
  });

  it("handles dot-separated suffixes (e.g. subtool.action)", () => {
    const out = resolveRunWriteClassToolPatterns([
      "mcp_my-server_subtool.search",
      "mcp_my-server_subtool.send",
    ]);
    expect(out).toEqual(["mcp_my-server_subtool.send"]);
  });

  it("does not split on `-`, so a hyphenated server name with a verb-shaped substring stays write-class", () => {
    // A server literally named "search-server" that exposes a `send`
    // tool must NOT be classified as read-only just because "search"
    // appears in the namespace. Splitting only on `_` and `.` keeps
    // `search-server` whole.
    const out = resolveRunWriteClassToolPatterns([
      "mcp_search-server_send",
    ]);
    expect(out).toEqual(["mcp_search-server_send"]);
  });

  it("handles multi-word read-only ops (list_items, get_by_id)", () => {
    const out = resolveRunWriteClassToolPatterns([
      "mcp_my-server_list_items",
      "mcp_my-server_get_by_id",
    ]);
    expect(out).toEqual([]);
  });
});

describe("extractAndValidateResult", () => {
  const validator = compileSchema(SAMPLE_SCHEMA);

  it("strips ```json fences and parses JSON", () => {
    const raw = '```json\n{"messages": [{"from":"a","subject":"b"}]}\n```';
    const result = extractAndValidateResult(raw, validator);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        messages: [{ from: "a", subject: "b" }],
      });
    }
  });

  it("strips bare ``` fences", () => {
    const raw = '```\n{"messages": [{"from":"a","subject":"b"}]}\n```';
    const result = extractAndValidateResult(raw, validator);
    expect(result.ok).toBe(true);
  });

  it("classifies parse_error on malformed JSON", () => {
    const result = extractAndValidateResult("not json at all", validator);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("parse_error");
  });

  it("classifies schema_violation on parsed-but-invalid JSON", () => {
    const result = extractAndValidateResult(
      '{"messages": [{"from": "a"}]}',
      validator,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("schema_violation");
      expect(result.message).toContain("subject");
    }
  });

  it("classifies parse_error on empty input", () => {
    const result = extractAndValidateResult("   \n  ", validator);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("parse_error");
  });

  it("falls back to a generic message when the validator reports zero errors but returns false", () => {
    // An Ajv-style validator that returns false but exposes no errors array
    // (validator.errors is null) should still produce a sensible
    // schema_violation message rather than throwing. This exercises the
    // `validator.errors ?? []` and `issues || "result failed schema
    // validation"` fallbacks.
    type V = ((value: unknown) => boolean) & { errors: null };
    const validatorNoErrors = ((value: unknown) => false) as unknown as V;
    validatorNoErrors.errors = null;

    const result = extractAndValidateResult(
      '{"messages": [{"from":"a","subject":"b"}]}',
      validatorNoErrors as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("schema_violation");
      expect(result.message).toBe("result failed schema validation");
    }
  });

  it("falls back to '/' and 'invalid' when an Ajv error is missing instancePath / message", () => {
    // Ajv normally populates both fields, but the runtime defends against
    // a stripped error (e.g. instancePath = "", message = undefined). The
    // bare `||` fallbacks ensure a deterministic message.
    type V = ((value: unknown) => boolean) & {
      errors: Array<{ instancePath: string; message?: string }>;
    };
    const validatorEmpty = ((value: unknown) => false) as unknown as V;
    validatorEmpty.errors = [{ instancePath: "", message: undefined }];

    const result = extractAndValidateResult(
      '{"messages": [{"from":"a","subject":"b"}]}',
      validatorEmpty as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("schema_violation");
      expect(result.message).toBe("/ invalid");
    }
  });
});

describe("detectConfirmationEnvelope", () => {
  it("matches needsConfirmation:true with plan", () => {
    const env = detectConfirmationEnvelope({
      needsConfirmation: true,
      confirmationPlan: "Will delete 3 emails",
    });
    expect(env).toEqual({ plan: "Will delete 3 emails" });
  });

  it("matches needsConfirmation:true with missing plan (empty string)", () => {
    const env = detectConfirmationEnvelope({ needsConfirmation: true });
    expect(env).toEqual({ plan: "" });
  });

  it("returns null for normal results", () => {
    expect(detectConfirmationEnvelope({ messages: [] })).toBe(null);
    expect(detectConfirmationEnvelope({ needsConfirmation: false })).toBe(null);
    expect(detectConfirmationEnvelope(null)).toBe(null);
    expect(detectConfirmationEnvelope([])).toBe(null);
  });
});

describe("detectErrorEnvelope", () => {
  it("classifies tool_unavailable", () => {
    const env = detectErrorEnvelope({
      error: "tool_unavailable",
      missing: "send_email tool",
    });
    expect(env?.errorClass).toBe("tool_unavailable");
    expect(env?.message).toContain("send_email tool");
  });

  it("classifies tool_failed", () => {
    const env = detectErrorEnvelope({
      error: "tool_failed",
      tool: "search",
      message: "API down",
    });
    expect(env?.errorClass).toBe("tool_failed");
    expect(env?.message).toContain("search");
    expect(env?.message).toContain("API down");
  });

  it("classifies budget_exhausted", () => {
    const env = detectErrorEnvelope({ error: "budget_exhausted" });
    expect(env?.errorClass).toBe("budget_exhausted");
  });

  it("returns null for non-error envelopes", () => {
    expect(detectErrorEnvelope({ messages: [] })).toBe(null);
    expect(detectErrorEnvelope({ error: "unknown_class" })).toBe(null);
    expect(detectErrorEnvelope(null)).toBe(null);
  });
});

describe("buildRetryFollowup", () => {
  it("instructs the subprocess to re-emit pure JSON", () => {
    const text = buildRetryFollowup({
      errorClass: "schema_violation",
      message: "messages[0].subject is required",
    });
    expect(text).toContain("schema_violation");
    expect(text).toContain("messages[0].subject is required");
    expect(text).toContain("Re-emit pure JSON");
    expect(text).toContain("Do not call any more tools");
  });
});

describe("sumTraceCosts", () => {
  it("sums null-tolerant cost fields", () => {
    const total = sumTraceCosts([
      {
        toolName: "a",
        toolArgs: null,
        durationMs: 100,
        status: "ok",
        costUsd: 0.001,
        tokensInput: 100,
        tokensOutput: 50,
      },
      {
        toolName: "b",
        toolArgs: null,
        durationMs: 100,
        status: "ok",
        costUsd: null,
        tokensInput: null,
        tokensOutput: null,
      },
    ]);
    expect(total.costUsd).toBe(0.001);
    expect(total.tokensInput).toBe(100);
    expect(total.tokensOutput).toBe(50);
  });
});

describe("hashTaskArgs", () => {
  it("returns stable 16-hex hashes for equivalent payloads", () => {
    expect(hashTaskArgs({ a: 1 })).toBe(hashTaskArgs({ a: 1 }));
    expect(hashTaskArgs(null)).toMatch(/^[a-f0-9]{16}$/);
  });

  it("returns 'unhashable' when JSON.stringify throws (e.g. circular refs)", () => {
    const args: Record<string, unknown> = { v: 1 };
    args.self = args;
    expect(hashTaskArgs(args)).toBe("unhashable");
  });
});

describe("wrapSchemaForStructuredOutput", () => {
  it("returns the user schema unmodified (verbatim per Phase 3.1 review)", () => {
    // Post-review design: pass the user's schema through unchanged. The
    // helper is a chokepoint for future shape adjustments if the API
    // turns out to require a wrapper. Confirmation/error envelopes are
    // routed via the text-extract fallback when the SDK can't produce
    // schema-conforming structured output.
    const result = wrapSchemaForStructuredOutput(SAMPLE_SCHEMA);
    expect(result).toBe(SAMPLE_SCHEMA);
  });

  it("admits the user's success shape", () => {
    const result = wrapSchemaForStructuredOutput(SAMPLE_SCHEMA);
    const validate = compileSchema(result as Record<string, unknown>);
    expect(validate({ messages: [{ from: "a", subject: "hi" }] })).toBe(true);
  });

  it("does NOT admit the §7.2 confirmation envelope (text fallback handles it)", () => {
    const result = wrapSchemaForStructuredOutput(SAMPLE_SCHEMA);
    const validate = compileSchema(result as Record<string, unknown>);
    expect(validate({
      needsConfirmation: true,
      confirmationPlan: "I would send the email...",
    })).toBe(false);
  });

  it("rejects shapes that don't match the user schema", () => {
    const result = wrapSchemaForStructuredOutput(SAMPLE_SCHEMA);
    const validate = compileSchema(result as Record<string, unknown>);
    expect(validate({ totally: "wrong" })).toBe(false);
  });
});

describe("classifyStructuredOutput", () => {
  const validate = compileSchema(SAMPLE_SCHEMA as Record<string, unknown>);

  it("returns envelope: 'confirmation' for the §7.2 envelope", () => {
    const r = classifyStructuredOutput(
      { needsConfirmation: true, confirmationPlan: "send to bob" },
      validate,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect("envelope" in r && r.envelope).toBe("confirmation");
  });

  it("returns envelope: 'error' for the §5.1 error envelopes", () => {
    const r = classifyStructuredOutput(
      { error: "tool_unavailable", missing: "x" },
      validate,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect("envelope" in r && r.envelope).toBe("error");
  });

  it("returns envelope: 'result' on a valid user schema match", () => {
    const r = classifyStructuredOutput(
      { messages: [{ from: "a", subject: "hi" }] },
      validate,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect("envelope" in r && r.envelope).toBe("result");
  });

  it("returns schema_violation when output matches neither envelope nor user schema", () => {
    const r = classifyStructuredOutput({ totally: "wrong" }, validate);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorClass).toBe("schema_violation");
  });

  it("falls back to a generic message when validator returns false with no errors", () => {
    type V = ((value: unknown) => boolean) & { errors: null };
    const noErrors = ((value: unknown) => false) as unknown as V;
    noErrors.errors = null;
    const r = classifyStructuredOutput(
      { messages: [{ from: "a", subject: "hi" }] },
      noErrors as never,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorClass).toBe("schema_violation");
      expect(r.message).toBe("result failed user schema validation");
    }
  });

  it("falls back to '/' and 'invalid' on missing instancePath / message", () => {
    type V = ((value: unknown) => boolean) & {
      errors: Array<{ instancePath: string; message?: string }>;
    };
    const sparse = ((value: unknown) => false) as unknown as V;
    sparse.errors = [{ instancePath: "", message: undefined }];
    const r = classifyStructuredOutput(
      { messages: [{ from: "a", subject: "hi" }] },
      sparse as never,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorClass).toBe("schema_violation");
      expect(r.message).toBe("/ invalid");
    }
  });
});

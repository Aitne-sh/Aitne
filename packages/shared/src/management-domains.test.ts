import { describe, it, expect } from "vitest";
import {
  APP_MAX_LENGTH,
  DOMAINS,
  ENTITY_TYPES,
  INTENT_MAX_LENGTH,
  LAST_RESULT_MAX_LENGTH,
  MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING,
  MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT,
  MANAGEMENT_MAX_ACTIVE_TASKS_DEFAULT,
  MANAGEMENT_MIN_CADENCE_MINUTES_DEFAULT,
  TYPE_PLURALS,
  entitySchema,
  entitySourceEntrySchema,
  formatManagedTaskId,
  isDomain,
  isEntityType,
  isValidManagedTaskId,
  isValidOutputPath,
  isValidSlug,
  managedTaskCreateSchema,
  managedTaskPatchSchema,
  managedTaskRunResultSchema,
  managedTaskSchema,
  normalizeAppLabel,
  parseEntityPath,
  pluralToType,
  sotBindingSchema,
  sotBindingsSchema,
  validateAppLabel,
  validateIntent,
} from "./management-domains.js";

// ── Domain enum ───────────────────────────────────────────────────────────

describe("DOMAINS / isDomain", () => {
  it("contains the v1 fixed enum", () => {
    expect([...DOMAINS]).toEqual([
      "work",
      "travel",
      "finance",
      "personal",
      "health",
      "learning",
    ]);
  });

  it("recognizes every enum value", () => {
    for (const d of DOMAINS) {
      expect(isDomain(d)).toBe(true);
    }
  });

  it("rejects unknown strings, non-strings, and empty input", () => {
    expect(isDomain("custom")).toBe(false);
    expect(isDomain("")).toBe(false);
    expect(isDomain(null)).toBe(false);
    expect(isDomain(undefined)).toBe(false);
    expect(isDomain(42)).toBe(false);
    expect(isDomain({})).toBe(false);
  });
});

// ── Entity-type enum ──────────────────────────────────────────────────────

describe("ENTITY_TYPES / isEntityType", () => {
  it("contains the six v1 types", () => {
    expect([...ENTITY_TYPES]).toEqual([
      "meeting",
      "trip",
      "receipt",
      "project",
      "book",
      "note",
    ]);
  });

  it("recognizes every enum value", () => {
    for (const t of ENTITY_TYPES) {
      expect(isEntityType(t)).toBe(true);
    }
  });

  it("rejects unknowns and non-strings", () => {
    expect(isEntityType("invoice")).toBe(false);
    expect(isEntityType(null)).toBe(false);
    expect(isEntityType(undefined)).toBe(false);
    expect(isEntityType(0)).toBe(false);
  });
});

describe("TYPE_PLURALS / pluralToType", () => {
  it("maps every entity type to a unique plural", () => {
    const plurals = ENTITY_TYPES.map((t) => TYPE_PLURALS[t]);
    expect(new Set(plurals).size).toBe(plurals.length);
    expect(plurals).toEqual([
      "meetings",
      "trips",
      "receipts",
      "projects",
      "books",
      "notes",
    ]);
  });

  it("pluralToType returns the singular form", () => {
    expect(pluralToType("meetings")).toBe("meeting");
    expect(pluralToType("books")).toBe("book");
  });

  it("pluralToType returns null on unknown plural", () => {
    expect(pluralToType("invoices")).toBeNull();
    expect(pluralToType("")).toBeNull();
  });
});

// ── Caps ──────────────────────────────────────────────────────────────────

describe("caps & limits", () => {
  it("exposes the design-doc constants", () => {
    expect(APP_MAX_LENGTH).toBe(64);
    expect(INTENT_MAX_LENGTH).toBe(200);
    expect(LAST_RESULT_MAX_LENGTH).toBe(120);
    expect(MANAGEMENT_MAX_ACTIVE_TASKS_DEFAULT).toBe(100);
    expect(MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING).toBe(30);
    expect(MANAGEMENT_MIN_CADENCE_MINUTES_DEFAULT).toBe(5);
    expect(MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT).toBe(3);
  });
});

// ── App / intent string validators ────────────────────────────────────────

describe("validateAppLabel", () => {
  it("trims and NFC-normalizes", () => {
    // half-width katakana → NFC composed katakana would be different;
    // here we use a simple roundtrip that is identity under NFC.
    expect(validateAppLabel("  zoom  ")).toBe("zoom");
    expect(validateAppLabel("Zoom")).toBe("Zoom");
  });

  it("rejects empty / whitespace-only input", () => {
    expect(validateAppLabel("")).toBeNull();
    expect(validateAppLabel("   ")).toBeNull();
  });

  it("rejects newlines and pipe characters", () => {
    expect(validateAppLabel("zoom\napp")).toBeNull();
    expect(validateAppLabel("zoom\rapp")).toBeNull();
    expect(validateAppLabel("zoom|app")).toBeNull();
  });

  it("rejects strings exceeding APP_MAX_LENGTH", () => {
    expect(validateAppLabel("a".repeat(APP_MAX_LENGTH))).toBe(
      "a".repeat(APP_MAX_LENGTH),
    );
    expect(validateAppLabel("a".repeat(APP_MAX_LENGTH + 1))).toBeNull();
  });

  it("rejects when only-whitespace padding pushes a valid core over the cap", () => {
    // Length is checked AFTER trim — leading/trailing whitespace is OK
    // even when padding the input past APP_MAX_LENGTH.
    const padded = "  " + "a".repeat(APP_MAX_LENGTH) + "  ";
    expect(validateAppLabel(padded)).toBe("a".repeat(APP_MAX_LENGTH));
  });
});

describe("normalizeAppLabel", () => {
  it("lowercases, NFC-normalizes, and collapses whitespace", () => {
    expect(normalizeAppLabel("  Zoom  ")).toBe("zoom");
    expect(normalizeAppLabel("Google\tDocs")).toBe("google docs");
    expect(normalizeAppLabel("Google   Docs")).toBe("google docs");
  });

  it("returns identical normalization for equivalent inputs", () => {
    expect(normalizeAppLabel("ZOOM")).toBe(normalizeAppLabel("zoom"));
    expect(normalizeAppLabel("Zoom ")).toBe(normalizeAppLabel(" zoom"));
  });
});

describe("validateIntent", () => {
  it("accepts valid descriptions up to INTENT_MAX_LENGTH", () => {
    expect(validateIntent("Zoom recordings → meeting entity")).toBe(
      "Zoom recordings → meeting entity",
    );
    expect(validateIntent("a".repeat(INTENT_MAX_LENGTH))).toBe(
      "a".repeat(INTENT_MAX_LENGTH),
    );
  });

  it("rejects empty input", () => {
    expect(validateIntent("")).toBeNull();
    expect(validateIntent("   ")).toBeNull();
  });

  it("rejects forbidden chars and over-length", () => {
    expect(validateIntent("a\nb")).toBeNull();
    expect(validateIntent("a|b")).toBeNull();
    expect(validateIntent("a".repeat(INTENT_MAX_LENGTH + 1))).toBeNull();
  });
});

// ── Slugs ─────────────────────────────────────────────────────────────────

describe("isValidSlug", () => {
  it("accepts kebab-case slugs", () => {
    expect(isValidSlug("foo")).toBe(true);
    expect(isValidSlug("foo-bar")).toBe(true);
    expect(isValidSlug("2026-12-04-foo-1on1")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });

  it("rejects bad shape", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("Foo")).toBe(false);
    expect(isValidSlug("-foo")).toBe(false);
    expect(isValidSlug("foo bar")).toBe(false);
    expect(isValidSlug("foo_bar")).toBe(false);
    expect(isValidSlug("foo.md")).toBe(false);
  });

  it("rejects over-length slugs", () => {
    expect(isValidSlug("a".repeat(100))).toBe(true);
    expect(isValidSlug("a".repeat(101))).toBe(false);
  });

  it("rejects non-string inputs", () => {
    // @ts-expect-error — exercising the runtime guard.
    expect(isValidSlug(123)).toBe(false);
    // @ts-expect-error — exercising the runtime guard.
    expect(isValidSlug(null)).toBe(false);
  });
});

// ── isValidOutputPath ─────────────────────────────────────────────────────

describe("isValidOutputPath", () => {
  it("accepts canonical two-segment paths", () => {
    expect(isValidOutputPath("work/meetings/")).toBe(true);
    expect(isValidOutputPath("finance/receipts/")).toBe(true);
    expect(isValidOutputPath("personal/notes/")).toBe(true);
  });

  it("rejects empty / non-string", () => {
    expect(isValidOutputPath("")).toBe(false);
    // @ts-expect-error — runtime guard
    expect(isValidOutputPath(null)).toBe(false);
    // @ts-expect-error — runtime guard
    expect(isValidOutputPath(undefined)).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(isValidOutputPath("/work/meetings/")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isValidOutputPath("work/../etc/")).toBe(false);
    expect(isValidOutputPath("../meetings/")).toBe(false);
    expect(isValidOutputPath("work/../")).toBe(false);
  });

  it("rejects missing trailing slash", () => {
    expect(isValidOutputPath("work/meetings")).toBe(false);
  });

  it("rejects wrong segment count", () => {
    expect(isValidOutputPath("work/")).toBe(false);
    expect(isValidOutputPath("work/meetings/extra/")).toBe(false);
    expect(isValidOutputPath("/")).toBe(false);
  });

  it("rejects unknown domain", () => {
    expect(isValidOutputPath("custom/meetings/")).toBe(false);
  });

  it("rejects unknown type-plural", () => {
    expect(isValidOutputPath("work/invoices/")).toBe(false);
  });

  it("rejects empty segments", () => {
    expect(isValidOutputPath("//meetings/")).toBe(false);
    expect(isValidOutputPath("work//")).toBe(false);
  });
});

// ── parseEntityPath / buildEntityPath ─────────────────────────────────────

describe("parseEntityPath", () => {
  it("parses a canonical path", () => {
    expect(parseEntityPath("work/meetings/2026-12-04-foo-1on1.md")).toEqual({
      domain: "work",
      type: "meeting",
      typePlural: "meetings",
      slug: "2026-12-04-foo-1on1",
      path: "work/meetings/2026-12-04-foo-1on1.md",
    });
  });

  it("returns null for non-string / empty", () => {
    expect(parseEntityPath("")).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseEntityPath(null)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseEntityPath(123)).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(parseEntityPath("/work/meetings/foo.md")).toBeNull();
  });

  it("rejects path traversal", () => {
    expect(parseEntityPath("work/../etc/foo.md")).toBeNull();
    expect(parseEntityPath("../meetings/foo.md")).toBeNull();
  });

  it("rejects non-.md files", () => {
    expect(parseEntityPath("work/meetings/foo")).toBeNull();
    expect(parseEntityPath("work/meetings/foo.txt")).toBeNull();
  });

  it("rejects wrong segment count", () => {
    expect(parseEntityPath("foo.md")).toBeNull();
    expect(parseEntityPath("work/foo.md")).toBeNull();
    expect(parseEntityPath("work/meetings/sub/foo.md")).toBeNull();
  });

  it("rejects empty segments", () => {
    expect(parseEntityPath("/meetings/foo.md")).toBeNull();
    expect(parseEntityPath("work//foo.md")).toBeNull();
    expect(parseEntityPath("work/meetings/.md")).toBeNull();
  });

  it("rejects unknown domain or type-plural", () => {
    expect(parseEntityPath("custom/meetings/foo.md")).toBeNull();
    expect(parseEntityPath("work/invoices/foo.md")).toBeNull();
  });

  it("rejects invalid slug", () => {
    expect(parseEntityPath("work/meetings/Foo.md")).toBeNull();
    expect(parseEntityPath("work/meetings/-foo.md")).toBeNull();
  });
});

// ── Managed-task ID ───────────────────────────────────────────────────────

describe("isValidManagedTaskId / formatManagedTaskId", () => {
  it("accepts well-formed ids", () => {
    expect(isValidManagedTaskId("mt_1")).toBe(true);
    expect(isValidManagedTaskId("mt_42")).toBe(true);
    expect(isValidManagedTaskId("mt_999999")).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isValidManagedTaskId("")).toBe(false);
    expect(isValidManagedTaskId("mt_0")).toBe(false);
    expect(isValidManagedTaskId("mt_01")).toBe(false);
    expect(isValidManagedTaskId("mt_-1")).toBe(false);
    expect(isValidManagedTaskId("mt_a")).toBe(false);
    expect(isValidManagedTaskId("MT_42")).toBe(false);
    expect(isValidManagedTaskId(null)).toBe(false);
    expect(isValidManagedTaskId(undefined)).toBe(false);
    expect(isValidManagedTaskId(42)).toBe(false);
  });

  it("formatManagedTaskId formats positive ints", () => {
    expect(formatManagedTaskId(1)).toBe("mt_1");
    expect(formatManagedTaskId(42)).toBe("mt_42");
  });

  it("formatManagedTaskId throws on bad inputs", () => {
    expect(() => formatManagedTaskId(0)).toThrow(RangeError);
    expect(() => formatManagedTaskId(-1)).toThrow(RangeError);
    expect(() => formatManagedTaskId(1.5)).toThrow(RangeError);
    expect(() => formatManagedTaskId(Number.NaN)).toThrow(RangeError);
  });
});

// ── Zod schemas ───────────────────────────────────────────────────────────

describe("entitySourceEntrySchema", () => {
  it("accepts the documented optional fields and passes through extras", () => {
    const parsed = entitySourceEntrySchema.parse({
      id: "abc",
      url: "https://example.com",
      external_id: "ext-1",
      app_specific: { recording: "zm_xyz" },
    });
    expect(parsed.id).toBe("abc");
    expect(
      (parsed as Record<string, unknown>).app_specific,
    ).toEqual({ recording: "zm_xyz" });
  });

  it("rejects an invalid url", () => {
    expect(
      entitySourceEntrySchema.safeParse({ url: "not-a-url" }).success,
    ).toBe(false);
  });
});

describe("entitySchema", () => {
  const minimal = {
    type: "meeting" as const,
    domain: "work" as const,
    slug: "2026-12-04-foo",
    title: "Foo 1on1",
    created: "2026-12-04T10:00:00Z",
  };

  it("accepts a minimal entity", () => {
    const parsed = entitySchema.parse(minimal);
    expect(parsed.sources).toEqual({});
    expect(parsed.related).toEqual([]);
    expect(parsed.tags).toEqual([]);
  });

  it("accepts a full entity", () => {
    const parsed = entitySchema.parse({
      ...minimal,
      status: "upcoming",
      sources: {
        zoom: { external_id: "zm_xyz", url: "https://zoom.us/r/123" },
        gdocs: { id: "doc_456" },
      },
      related: ["work/projects/foo.md"],
      tags: ["1on1"],
      last_synced_at: "2026-12-05T03:45:00Z",
    });
    expect(parsed.sources.zoom?.external_id).toBe("zm_xyz");
  });

  it("rejects bad type/domain/slug/title", () => {
    expect(
      entitySchema.safeParse({ ...minimal, type: "invoice" }).success,
    ).toBe(false);
    expect(
      entitySchema.safeParse({ ...minimal, domain: "custom" }).success,
    ).toBe(false);
    expect(entitySchema.safeParse({ ...minimal, slug: "Foo" }).success).toBe(
      false,
    );
    expect(entitySchema.safeParse({ ...minimal, title: "" }).success).toBe(
      false,
    );
  });

  it("rejects an empty source-key", () => {
    expect(
      entitySchema.safeParse({
        ...minimal,
        sources: { "": { external_id: "x" } },
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed created datetime", () => {
    expect(
      entitySchema.safeParse({ ...minimal, created: "yesterday" }).success,
    ).toBe(false);
  });
});

describe("sotBindingSchema / sotBindingsSchema", () => {
  // §9.1 example uses categories like "tasks", "meetings", "notes" —
  // values not in the §9.4 DOMAINS enum. SotBinding.category is
  // intentionally free-form (validated via the same trim/NFC/forbidden-
  // char rules as App labels). See the schema's docblock for rationale.
  it("accepts a binding with a free-form category from §9.1's example", () => {
    const parsed = sotBindingSchema.parse({
      category: "tasks",
      sotApp: "notion",
      mirrorPath: "context/work/tasks-index.md",
      policy: "Mirror is read-only summary",
      writer: "agent",
    });
    expect(parsed.category).toBe("tasks");
    expect(parsed.sotApp).toBe("notion");
  });

  it("accepts other example categories from the design doc", () => {
    for (const category of ["meetings", "notes", "projects"] as const) {
      expect(
        sotBindingSchema.safeParse({
          category,
          sotApp: "x",
          mirrorPath: null,
          policy: null,
          writer: "shared",
        }).success,
      ).toBe(true);
    }
  });

  it("trims and NFC-normalizes category and sotApp", () => {
    const parsed = sotBindingSchema.parse({
      category: "  tasks  ",
      sotApp: "  Notion  ",
      mirrorPath: null,
      policy: null,
      writer: "shared",
    });
    expect(parsed.category).toBe("tasks");
    expect(parsed.sotApp).toBe("Notion");
  });

  it("accepts null mirrorPath / null policy", () => {
    expect(
      sotBindingSchema.safeParse({
        category: "notes",
        sotApp: "obsidian",
        mirrorPath: null,
        policy: null,
        writer: "shared",
      }).success,
    ).toBe(true);
  });

  it("rejects bad writer", () => {
    expect(
      sotBindingSchema.safeParse({
        category: "tasks",
        sotApp: "notion",
        mirrorPath: null,
        policy: null,
        writer: "robot",
      }).success,
    ).toBe(false);
  });

  it("rejects pipe / newline in category or sotApp", () => {
    expect(
      sotBindingSchema.safeParse({
        category: "ta|sks",
        sotApp: "notion",
        mirrorPath: null,
        policy: null,
        writer: "agent",
      }).success,
    ).toBe(false);
    expect(
      sotBindingSchema.safeParse({
        category: "tasks",
        sotApp: "no|tion",
        mirrorPath: null,
        policy: null,
        writer: "agent",
      }).success,
    ).toBe(false);
    expect(
      sotBindingSchema.safeParse({
        category: "tasks",
        sotApp: "no\ntion",
        mirrorPath: null,
        policy: null,
        writer: "agent",
      }).success,
    ).toBe(false);
  });

  it("rejects empty / over-length category and sotApp", () => {
    expect(
      sotBindingSchema.safeParse({
        category: "",
        sotApp: "notion",
        mirrorPath: null,
        policy: null,
        writer: "agent",
      }).success,
    ).toBe(false);
    expect(
      sotBindingSchema.safeParse({
        category: "tasks",
        sotApp: "",
        mirrorPath: null,
        policy: null,
        writer: "agent",
      }).success,
    ).toBe(false);
    expect(
      sotBindingSchema.safeParse({
        category: "tasks",
        sotApp: "a".repeat(APP_MAX_LENGTH + 1),
        mirrorPath: null,
        policy: null,
        writer: "agent",
      }).success,
    ).toBe(false);
  });

  it("sotBindingsSchema validates an array", () => {
    const ok = sotBindingsSchema.safeParse([
      {
        category: "tasks",
        sotApp: "notion",
        mirrorPath: null,
        policy: null,
        writer: "agent",
      },
    ]);
    expect(ok.success).toBe(true);
    expect(sotBindingsSchema.safeParse("not-an-array").success).toBe(false);
  });
});

describe("managedTaskSchema", () => {
  const minimal = {
    id: "mt_42",
    intent: "Zoom recordings → meeting entity",
    app: "zoom",
    app_normalized: "zoom",
    cadence: "daily 10:00 (Asia/Tokyo)",
    output_path: "work/meetings/",
    schedule_id: 42,
    last_run_at: null,
    last_result: null,
    consecutive_failures: 0,
    created_at: "2026-12-04T00:00:00Z",
    updated_at: "2026-12-04T00:00:00Z",
  };

  it("accepts a valid row", () => {
    expect(managedTaskSchema.parse(minimal)).toEqual(minimal);
  });

  it("accepts null output_path", () => {
    expect(
      managedTaskSchema.safeParse({ ...minimal, output_path: null }).success,
    ).toBe(true);
  });

  it("rejects bad output_path", () => {
    expect(
      managedTaskSchema.safeParse({
        ...minimal,
        output_path: "work/meetings",
      }).success,
    ).toBe(false);
    expect(
      managedTaskSchema.safeParse({
        ...minimal,
        output_path: "custom/meetings/",
      }).success,
    ).toBe(false);
  });

  it("rejects bad id / schedule_id / consecutive_failures", () => {
    expect(managedTaskSchema.safeParse({ ...minimal, id: "MT_42" }).success).toBe(
      false,
    );
    expect(
      managedTaskSchema.safeParse({ ...minimal, schedule_id: -1 }).success,
    ).toBe(false);
    expect(
      managedTaskSchema.safeParse({ ...minimal, consecutive_failures: -1 })
        .success,
    ).toBe(false);
  });

  it("rejects last_result that exceeds the cap", () => {
    expect(
      managedTaskSchema.safeParse({
        ...minimal,
        last_result: "x".repeat(LAST_RESULT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("accepts ISO-8601 last_run_at and rejects malformed strings", () => {
    expect(
      managedTaskSchema.safeParse({
        ...minimal,
        last_run_at: "2026-12-04T10:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      managedTaskSchema.safeParse({ ...minimal, last_run_at: "yesterday" })
        .success,
    ).toBe(false);
  });
});

describe("managedTaskCreateSchema", () => {
  const ok = {
    intent: "Zoom recordings → meeting entity",
    app: "zoom",
    cadence: "daily 10:00 (Asia/Tokyo)",
    recurrenceRule: {
      frequency: "daily" as const,
      time: "10:00",
      timezone: "Asia/Tokyo",
    },
  };

  it("accepts without output_path", () => {
    expect(managedTaskCreateSchema.safeParse(ok).success).toBe(true);
  });

  it("accepts with valid output_path", () => {
    expect(
      managedTaskCreateSchema.safeParse({
        ...ok,
        output_path: "work/meetings/",
      }).success,
    ).toBe(true);
  });

  it("rejects with invalid output_path", () => {
    expect(
      managedTaskCreateSchema.safeParse({
        ...ok,
        output_path: "work/meetings",
      }).success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    const noApp = {
      intent: ok.intent,
      cadence: ok.cadence,
      recurrenceRule: ok.recurrenceRule,
    };
    expect(managedTaskCreateSchema.safeParse(noApp).success).toBe(false);
  });

  it("rejects malformed recurrenceRule", () => {
    expect(
      managedTaskCreateSchema.safeParse({
        ...ok,
        recurrenceRule: { frequency: "weekly", time: "10:00" },
      }).success,
    ).toBe(false); // weekly without daysOfWeek
  });

  it("trims/normalizes app and intent at the API boundary", () => {
    const parsed = managedTaskCreateSchema.parse({
      ...ok,
      app: "  Zoom  ",
      intent: "  capture meeting recordings  ",
    });
    expect(parsed.app).toBe("Zoom");
    expect(parsed.intent).toBe("capture meeting recordings");
  });

  it("rejects pipe characters in app and intent (would break the rendered table)", () => {
    expect(
      managedTaskCreateSchema.safeParse({ ...ok, app: "zoom|hack" }).success,
    ).toBe(false);
    expect(
      managedTaskCreateSchema.safeParse({ ...ok, intent: "rogue\nintent" })
        .success,
    ).toBe(false);
  });

  it("rejects empty-after-trim app and intent", () => {
    expect(managedTaskCreateSchema.safeParse({ ...ok, app: "   " }).success).toBe(
      false,
    );
    expect(
      managedTaskCreateSchema.safeParse({ ...ok, intent: "" }).success,
    ).toBe(false);
  });
});

describe("managedTaskPatchSchema", () => {
  it("accepts a single-field patch", () => {
    expect(managedTaskPatchSchema.safeParse({ cadence: "hourly" }).success).toBe(
      true,
    );
  });

  it("accepts a null output_path", () => {
    expect(
      managedTaskPatchSchema.safeParse({ output_path: null }).success,
    ).toBe(true);
  });

  it("accepts a valid output_path", () => {
    expect(
      managedTaskPatchSchema.safeParse({ output_path: "personal/meetings/" })
        .success,
    ).toBe(true);
  });

  it("rejects a bad output_path", () => {
    expect(
      managedTaskPatchSchema.safeParse({ output_path: "bad" }).success,
    ).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(managedTaskPatchSchema.safeParse({}).success).toBe(false);
  });

  it("trims/normalizes intent on patch", () => {
    const parsed = managedTaskPatchSchema.parse({ intent: "  new intent  " });
    expect(parsed).toEqual({ intent: "new intent" });
  });

  it("rejects pipe in intent on patch", () => {
    expect(
      managedTaskPatchSchema.safeParse({ intent: "rogue|intent" }).success,
    ).toBe(false);
  });
});

describe("managedTaskRunResultSchema", () => {
  it("accepts a success run-result", () => {
    expect(
      managedTaskRunResultSchema.safeParse({
        last_run_at: "2026-12-04T10:00:00Z",
        last_result: "ok (3 new)",
        consecutive_failures: 0,
      }).success,
    ).toBe(true);
  });

  it("accepts a failure run-result", () => {
    expect(
      managedTaskRunResultSchema.safeParse({
        last_run_at: "2026-12-04T10:00:00Z",
        last_result: "failed: connector timeout",
        consecutive_failures: 1,
      }).success,
    ).toBe(true);
  });

  it("rejects malformed last_run_at and over-length last_result", () => {
    expect(
      managedTaskRunResultSchema.safeParse({
        last_run_at: "",
        last_result: "ok",
        consecutive_failures: 0,
      }).success,
    ).toBe(false);
    // Plain string that isn't ISO-8601 — caught by .datetime().
    expect(
      managedTaskRunResultSchema.safeParse({
        last_run_at: "yesterday",
        last_result: "ok",
        consecutive_failures: 0,
      }).success,
    ).toBe(false);
    expect(
      managedTaskRunResultSchema.safeParse({
        last_run_at: "2026-12-04T10:00:00Z",
        last_result: "x".repeat(LAST_RESULT_MAX_LENGTH + 1),
        consecutive_failures: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects negative consecutive_failures", () => {
    expect(
      managedTaskRunResultSchema.safeParse({
        last_run_at: "2026-12-04T10:00:00Z",
        last_result: "ok",
        consecutive_failures: -1,
      }).success,
    ).toBe(false);
  });
});

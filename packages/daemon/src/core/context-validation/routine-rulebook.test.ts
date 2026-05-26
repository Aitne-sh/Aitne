import { describe, it, expect } from "vitest";
import {
  explainCustomRoutineValidationError,
  extractRoutineFrontmatter,
  readRoutineFrontmatterScalar,
  validateBaseYamlSyntax,
  validateBuiltInRoutineRulebook,
} from "./routine-rulebook.js";

describe("validateBaseYamlSyntax", () => {
  it("accepts simple Obsidian Bases yaml", () => {
    expect(
      validateBaseYamlSyntax(
        'filters:\n  and:\n    - file.inFolder("projects")\nviews:\n  - type: table\n',
      ),
    ).toBeNull();
  });

  it("rejects tab-indented yaml", () => {
    expect(validateBaseYamlSyntax("filters:\n\tbad: true\n")).toContain(
      "tab indentation",
    );
  });

  it("rejects empty content", () => {
    expect(validateBaseYamlSyntax("")).toContain("must not be empty");
    expect(validateBaseYamlSyntax("   \n  \n")).toContain("must not be empty");
  });

  it("rejects when only comments and blank lines are present", () => {
    expect(validateBaseYamlSyntax("# only a comment\n\n# another\n")).toContain(
      "at least one mapping entry",
    );
  });

  it("rejects odd-numbered indentation", () => {
    expect(validateBaseYamlSyntax("filters:\n bad: true\n")).toContain(
      "2-space indentation",
    );
  });

  it("rejects non-mapping non-list lines", () => {
    expect(validateBaseYamlSyntax("invalid line with no colon\n")).toContain(
      "Invalid .base YAML structure",
    );
  });

  it("ignores comment lines mixed with valid mappings", () => {
    expect(
      validateBaseYamlSyntax("# top comment\nfilters:\n  active: true\n"),
    ).toBeNull();
  });
});

describe("extractRoutineFrontmatter", () => {
  it("returns the frontmatter body for LF-delimited files", () => {
    expect(extractRoutineFrontmatter("---\ntype: rule\nslug: x\n---\n# Body\n"))
      .toBe("type: rule\nslug: x");
  });

  it("returns the frontmatter body for CRLF-delimited files", () => {
    expect(
      extractRoutineFrontmatter("---\r\ntype: rule\r\nslug: x\r\n---\r\n# Body\r\n"),
    ).toBe("type: rule\r\nslug: x\r");
  });

  it("returns null when no opening delimiter is present", () => {
    expect(extractRoutineFrontmatter("# Body only\n")).toBeNull();
  });

  it("returns null when the closing delimiter is missing", () => {
    expect(extractRoutineFrontmatter("---\ntype: rule\n# Body\n")).toBeNull();
  });
});

describe("readRoutineFrontmatterScalar", () => {
  it("reads a bare scalar", () => {
    expect(readRoutineFrontmatterScalar("type: rule\nslug: x\n", "type")).toBe("rule");
  });

  it("strips double quotes", () => {
    expect(readRoutineFrontmatterScalar('name: "morning"\n', "name")).toBe("morning");
  });

  it("strips single quotes", () => {
    expect(readRoutineFrontmatterScalar("name: 'morning'\n", "name")).toBe("morning");
  });

  it("returns null when the field is absent", () => {
    expect(readRoutineFrontmatterScalar("type: rule\n", "slug")).toBeNull();
  });
});

describe("validateBuiltInRoutineRulebook", () => {
  const validBody = [
    "---",
    "type: rule",
    "slug: morning",
    "---",
    "# Morning routine",
    "",
    "## Checks",
    "- something",
  ].join("\n");

  it("accepts a canonical rulebook", () => {
    expect(validateBuiltInRoutineRulebook("policies/routines/morning", validBody)).toBeNull();
  });

  it("rejects when frontmatter is missing", () => {
    expect(
      validateBuiltInRoutineRulebook("policies/routines/morning", "# Morning\n## Checks\n- x\n"),
    ).toContain("YAML frontmatter");
  });

  it("rejects when type is missing", () => {
    const body = validBody.replace("type: rule\n", "");
    expect(validateBuiltInRoutineRulebook("policies/routines/morning", body)).toContain(
      "`type: rule`",
    );
  });

  it("rejects when type is not `rule`", () => {
    const body = validBody.replace("type: rule", "type: skill");
    expect(validateBuiltInRoutineRulebook("policies/routines/morning", body)).toContain(
      "must declare `type: rule`",
    );
  });

  it("rejects when slug is missing", () => {
    const body = validBody.replace("slug: morning\n", "");
    expect(validateBuiltInRoutineRulebook("policies/routines/morning", body)).toContain(
      "require a `slug`",
    );
  });

  it("rejects slug-filename mismatch", () => {
    expect(validateBuiltInRoutineRulebook("policies/routines/morning", validBody.replace("slug: morning", "slug: evening"))).toContain(
      "match the filename",
    );
  });

  it("rejects when the ## Checks section is missing", () => {
    const body = validBody.replace("## Checks\n- something", "## Other\n- thing");
    expect(validateBuiltInRoutineRulebook("policies/routines/morning", body)).toContain(
      "`## Checks`",
    );
  });
});

describe("explainCustomRoutineValidationError", () => {
  it("translates each parse-error kind", () => {
    expect(
      explainCustomRoutineValidationError({ kind: "missing_field", field: "cron" }),
    ).toContain("`cron`");
    expect(
      explainCustomRoutineValidationError({ kind: "invalid_cron", value: "X X X" }),
    ).toContain("X X X");
    expect(
      explainCustomRoutineValidationError({ kind: "invalid_slug", value: "Bad Slug" }),
    ).toContain("Bad Slug");
    expect(
      explainCustomRoutineValidationError({ kind: "invalid_type", value: "skill" }),
    ).toContain("type: rule");
    expect(
      explainCustomRoutineValidationError({
        kind: "invalid_process_key",
        value: "wrong",
      }),
    ).toContain("process_key");
    expect(
      explainCustomRoutineValidationError({ kind: "invalid_enabled", value: "maybe" }),
    ).toContain("true");
    expect(
      explainCustomRoutineValidationError({ kind: "invalid_tier", value: "extreme" }),
    ).toContain("light");
    expect(
      explainCustomRoutineValidationError({ kind: "invalid_budget", value: "-3" }),
    ).toContain("positive number");
    expect(
      explainCustomRoutineValidationError({ kind: "missing_checks_section" }),
    ).toContain("## Checks");
    expect(explainCustomRoutineValidationError({ kind: "no_frontmatter" })).toContain(
      "YAML frontmatter",
    );
  });
});

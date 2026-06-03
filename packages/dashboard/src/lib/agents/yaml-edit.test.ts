import { describe, expect, it } from "vitest";
import {
  scaffoldUserAgentMarkdown,
  slugFromMarkdown,
  splitFrontmatter,
  validateAgentMarkdown,
  validateUserAgentEdit,
} from "./yaml-edit";

const VALID = `---
slug: weekly-bookmarks
name: Weekly Bookmarks
description: Summarise saved bookmarks.
kind: user
schedule:
  kind: cron
  expression: "0 21 * * 0"
backend:
  process_key: agent.task
limits:
  max_turns: 10
  max_budget_usd: 0.1
  timeout_minutes: 5
---

Summarise the week's bookmarks into the reading log.
`;

describe("splitFrontmatter", () => {
  it("splits a fenced document", () => {
    const split = splitFrontmatter(VALID);
    expect(split).not.toBeNull();
    expect(split!.yamlText).toContain("slug: weekly-bookmarks");
    expect(split!.body).toBe("Summarise the week's bookmarks into the reading log.");
  });

  it("returns null without an opening fence", () => {
    expect(splitFrontmatter("no fence here")).toBeNull();
    expect(splitFrontmatter("")).toBeNull();
  });

  it("returns null when the fence never closes", () => {
    expect(splitFrontmatter("---\nslug: x\nname: y")).toBeNull();
  });
});

describe("validateAgentMarkdown", () => {
  it("accepts a valid user agent", () => {
    expect(validateAgentMarkdown(VALID)).toEqual({ ok: true });
  });

  it("flags a missing fence", () => {
    const res = validateAgentMarkdown("slug: x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0].path).toBe("");
  });

  it("flags invalid YAML", () => {
    const res = validateAgentMarkdown("---\n\tslug: x\n  bad: : :\n---\nbody");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0].message).toMatch(/not valid YAML/);
  });

  it("flags an empty frontmatter block", () => {
    const res = validateAgentMarkdown("---\n---\nbody");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0].message).toMatch(/empty/);
  });

  it("flags a non-mapping frontmatter", () => {
    const res = validateAgentMarkdown("---\n- a\n- b\n---\nbody");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0].message).toMatch(/mapping/);
  });

  it("surfaces schema issues with field paths", () => {
    const res = validateAgentMarkdown(`---
slug: Bad_Slug
name: X
description: Y
kind: user
schedule:
  kind: cron
backend:
  process_key: agent.task
limits:
  max_turns: 10
  max_budget_usd: 0.1
  timeout_minutes: 5
---
body`);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const paths = res.issues.map((i) => i.path);
      // bad slug + cron missing expression both surface
      expect(paths).toContain("slug");
    }
  });

  it("rejects a user agent with a null process key (schema superRefine)", () => {
    const res = validateAgentMarkdown(`---
slug: x
name: X
description: Y
kind: user
schedule:
  kind: cron
  expression: "0 9 * * *"
backend:
  process_key: null
limits:
  max_turns: 10
  max_budget_usd: 0.1
  timeout_minutes: 5
---
body`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => i.path === "backend.process_key")).toBe(true);
  });
});

describe("slugFromMarkdown", () => {
  it("extracts the slug", () => {
    expect(slugFromMarkdown(VALID)).toBe("weekly-bookmarks");
  });

  it("returns null without a fence or slug", () => {
    expect(slugFromMarkdown("no fence")).toBeNull();
    expect(slugFromMarkdown("---\nname: x\n---\nbody")).toBeNull();
    expect(slugFromMarkdown("---\n- a\n---\nbody")).toBeNull();
  });

  it("returns null on invalid YAML", () => {
    expect(slugFromMarkdown("---\n\tbad: : :\n---\nbody")).toBeNull();
  });
});

describe("validateUserAgentEdit (slug immutability §3.3)", () => {
  it("accepts an edit that keeps the slug", () => {
    expect(validateUserAgentEdit(VALID, "weekly-bookmarks")).toEqual({ ok: true });
  });

  it("blocks an edit that changes the slug (would invalidate on reload)", () => {
    const res = validateUserAgentEdit(VALID, "different-slug");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0].path).toBe("slug");
    expect(res.issues[0].message).toContain('different-slug');
  });

  it("does not enforce immutability for the create scaffold (no canonicalSlug)", () => {
    expect(validateUserAgentEdit(VALID)).toEqual({ ok: true });
  });

  it("returns the underlying schema errors first (slug check only runs on a valid doc)", () => {
    const res = validateUserAgentEdit("---\nslug: x\n---\nbody", "weekly-bookmarks");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // Schema failure surfaces, not the slug-mismatch synthetic issue.
    expect(res.issues.some((i) => i.path === "slug" && i.message.includes("must stay"))).toBe(false);
  });
});

describe("scaffoldUserAgentMarkdown", () => {
  it("produces a document that validates", () => {
    const doc = scaffoldUserAgentMarkdown("my-new-agent");
    expect(slugFromMarkdown(doc)).toBe("my-new-agent");
    expect(validateAgentMarkdown(doc)).toEqual({ ok: true });
  });

  it("falls back to a default slug when blank", () => {
    expect(slugFromMarkdown(scaffoldUserAgentMarkdown("  "))).toBe("my-agent");
  });
});

import { describe, it, expect } from "vitest";
import { resolveRelativeDocLink } from "./relative-link";

describe("resolveRelativeDocLink", () => {
  it("resolves a same-directory link", () => {
    expect(
      resolveRelativeDocLink(
        "concepts/safety-model",
        "delegated-mode.md",
      ),
    ).toEqual({ slug: "concepts/delegated-mode", anchor: null });
  });

  it("resolves a parent-directory link", () => {
    expect(
      resolveRelativeDocLink(
        "getting-started/04-first-day",
        "../features/routines/morning-routine.md",
      ),
    ).toEqual({ slug: "features/routines/morning-routine", anchor: null });
  });

  it("resolves a multi-parent link", () => {
    expect(
      resolveRelativeDocLink(
        "features/memory-files/today",
        "../../troubleshooting/morning-routine-didnt-run.md",
      ),
    ).toEqual({
      slug: "troubleshooting/morning-routine-didnt-run",
      anchor: null,
    });
  });

  it("preserves an anchor fragment", () => {
    expect(
      resolveRelativeDocLink(
        "features/routines/morning-routine",
        "../../concepts/agent-day.md#boundary",
      ),
    ).toEqual({ slug: "concepts/agent-day", anchor: "boundary" });
  });

  it("returns null when the path escapes the corpus root", () => {
    expect(
      resolveRelativeDocLink(
        "concepts/safety-model",
        "../../../docs/design/14-integration-delegation.md",
      ),
    ).toBeNull();
  });

  it("returns null for non-.md targets", () => {
    expect(
      resolveRelativeDocLink("concepts/safety-model", "../assets/diagram.png"),
    ).toBeNull();
    expect(
      resolveRelativeDocLink("concepts/safety-model", "delegated-mode"),
    ).toBeNull();
  });

  it("returns null for absolute or scheme links", () => {
    expect(
      resolveRelativeDocLink(
        "concepts/safety-model",
        "https://example.com/x.md",
      ),
    ).toBeNull();
    expect(
      resolveRelativeDocLink("concepts/safety-model", "mailto:foo@bar.com"),
    ).toBeNull();
    expect(
      resolveRelativeDocLink("concepts/safety-model", "pa-doc:concepts/foo"),
    ).toBeNull();
    expect(
      resolveRelativeDocLink("concepts/safety-model", "/docs/foo.md"),
    ).toBeNull();
    expect(
      resolveRelativeDocLink("concepts/safety-model", "#section"),
    ).toBeNull();
  });

  it("returns null for empty href", () => {
    expect(resolveRelativeDocLink("concepts/safety-model", "")).toBeNull();
  });

  it("returns null when the trailing segment strips to empty", () => {
    // `.md` and `foo/.md` strip the `.md` suffix to an empty filename,
    // which would produce a slug ending with `/` — reject instead.
    expect(resolveRelativeDocLink("concepts/safety-model", ".md")).toBeNull();
    expect(
      resolveRelativeDocLink("concepts/safety-model", "../.md"),
    ).toBeNull();
    expect(
      resolveRelativeDocLink("concepts/safety-model", "foo/.md"),
    ).toBeNull();
  });

  it("treats `./` segments as no-ops", () => {
    expect(
      resolveRelativeDocLink(
        "features/integrations/calendar",
        "./mail.md",
      ),
    ).toEqual({ slug: "features/integrations/mail", anchor: null });
  });
});

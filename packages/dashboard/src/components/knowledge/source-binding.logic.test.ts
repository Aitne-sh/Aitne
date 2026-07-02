import { describe, it, expect } from "vitest";
import {
  mimeShortLabel,
  sourceBinding,
  sourceFileHref,
} from "./source-binding.logic";
import type { ParsedFrontmatter } from "@/lib/frontmatter";

const fields = (
  entries: Record<string, ParsedFrontmatter["fields"][number]["value"]>,
): ParsedFrontmatter["fields"] =>
  Object.entries(entries).map(([key, value]) => ({ key, value }));

describe("sourceBinding", () => {
  it("returns the binding for a full source card", () => {
    expect(
      sourceBinding(
        fields({
          type: "source",
          owner: "agent",
          source_id: "src_1234",
          mime: "application/pdf",
        }),
      ),
    ).toEqual({ sourceId: "src_1234", mime: "application/pdf" });
  });

  it("returns null when type is absent or not 'source'", () => {
    expect(sourceBinding(fields({ source_id: "src_1234" }))).toBeNull();
    expect(
      sourceBinding(fields({ type: "dossier", source_id: "src_1234" })),
    ).toBeNull();
  });

  it("returns null when source_id is missing or malformed", () => {
    expect(sourceBinding(fields({ type: "source" }))).toBeNull();
    expect(sourceBinding(fields({ type: "source", source_id: 42 }))).toBeNull();
    expect(
      sourceBinding(fields({ type: "source", source_id: "att_99" })),
    ).toBeNull();
  });

  it("returns a null mime when absent or empty", () => {
    expect(
      sourceBinding(fields({ type: "source", source_id: "src_1", mime: "" })),
    ).toEqual({ sourceId: "src_1", mime: null });
    expect(sourceBinding(fields({ type: "source", source_id: "src_1" }))).toEqual(
      { sourceId: "src_1", mime: null },
    );
  });
});

describe("sourceFileHref", () => {
  it("encodes the id into the daemon binary route", () => {
    expect(sourceFileHref("src_ab/cd")).toBe("/api/sources/src_ab%2Fcd/file");
  });
});

describe("mimeShortLabel", () => {
  it("maps the auto-capture office mimes", () => {
    expect(mimeShortLabel("application/pdf")).toBe("PDF");
    expect(
      mimeShortLabel(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("DOCX");
    expect(
      mimeShortLabel(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe("PPTX");
    expect(
      mimeShortLabel(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("XLSX");
  });

  it("falls back to the uppercased subtype for unknown mimes", () => {
    expect(mimeShortLabel("application/zip")).toBe("ZIP");
  });

  it("returns null for null or malformed mimes", () => {
    expect(mimeShortLabel(null)).toBeNull();
    expect(mimeShortLabel("weird")).toBeNull();
  });
});

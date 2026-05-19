import { describe, expect, it } from "vitest";
import {
  distinctProcessKeys,
  filterByProcessKey,
  findLatestHealthReportPath,
  parseWikiHealthReport,
  parseWikiLog,
  sortWikiLogEntries,
} from "./wiki-timeline.js";

const SAMPLE_LOG = `# Wiki Log

- 2026-05-12T09:00:00.000Z wiki.ingest_url post 10_raw/article-a.md
- 2026-05-12T09:00:01.000Z wiki.ingest_url post 10_raw/article-b.md
- 2026-05-12T10:15:00.000Z wiki.compile post 20_wiki/quantum-computing.md
- 2026-05-12T10:15:01.000Z wiki.compile patch 20_wiki/_index.md
- 2026-05-12T11:30:00.000Z wiki.ask post 30_outputs/2026-05-12-current-state.md
- 2026-05-12T18:00:00.000Z wiki.lint post 90_meta/health/2026-05-12.md
- 2026-05-12T18:00:00.500Z wiki.lint patch 90_meta/taxonomy.md
- 2026-05-12T19:00:00.000Z wiki.trace post 30_outputs/2026-05-12-trace-physics.md
- 2026-05-12T19:30:00.000Z wiki.connect post 30_outputs/2026-05-12-connect-physics--computing.md
`;

describe("parseWikiLog", () => {
  it("extracts every well-formed bullet line and ignores prose / headers", () => {
    const entries = parseWikiLog(SAMPLE_LOG);
    expect(entries).toHaveLength(9);
    expect(entries[0]).toMatchObject({
      timestamp: "2026-05-12T09:00:00.000Z",
      processKey: "wiki.ingest_url",
      operation: "post",
      relPath: "10_raw/article-a.md",
    });
    expect(entries[0].lineNumber).toBeGreaterThan(1);
  });

  it("returns an empty array for empty / undefined input", () => {
    expect(parseWikiLog("")).toEqual([]);
    expect(parseWikiLog("# Header only\n\n")).toEqual([]);
  });

  it("drops lines whose timestamp does not match the ISO shape", () => {
    const entries = parseWikiLog([
      "- not-a-timestamp wiki.compile post 20_wiki/foo.md",
      "- 2026-05-12T09:00:00.000Z wiki.compile post 20_wiki/ok.md",
    ].join("\n"));
    expect(entries).toHaveLength(1);
    expect(entries[0].relPath).toBe("20_wiki/ok.md");
  });

  it("drops lines whose token in the process-key slot does not look like a process key", () => {
    const entries = parseWikiLog([
      "- 2026-05-12T09:00:00.000Z some-prose-bullet ignore me please",
      "- 2026-05-12T09:00:01.000Z wiki.compile post 20_wiki/ok.md",
    ].join("\n"));
    expect(entries).toHaveLength(1);
    expect(entries[0].processKey).toBe("wiki.compile");
  });

  it("accepts the daemon's `unknown` fallback in the process-key slot", () => {
    const entries = parseWikiLog(
      "- 2026-05-12T09:00:00.000Z unknown post 20_wiki/legacy.md",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].processKey).toBe("unknown");
  });

  it("tolerates CRLF line endings", () => {
    const body = SAMPLE_LOG.replace(/\n/g, "\r\n");
    expect(parseWikiLog(body)).toHaveLength(9);
  });
});

describe("sortWikiLogEntries", () => {
  it("orders newest-first", () => {
    const entries = parseWikiLog(SAMPLE_LOG);
    const sorted = sortWikiLogEntries(entries);
    expect(sorted[0].processKey).toBe("wiki.connect");
    expect(sorted[sorted.length - 1].processKey).toBe("wiki.ingest_url");
  });

  it("breaks ties on identical timestamps using insertion order (newest line first)", () => {
    // Two entries with the *same* timestamp — the one with the higher
    // line number is the later insertion and must rank first.
    const body = [
      "- 2026-05-12T09:00:00.000Z wiki.compile post 20_wiki/a.md",
      "- 2026-05-12T09:00:00.000Z wiki.compile post 20_wiki/b.md",
    ].join("\n");
    const sorted = sortWikiLogEntries(parseWikiLog(body));
    expect(sorted[0].relPath).toBe("20_wiki/b.md");
    expect(sorted[1].relPath).toBe("20_wiki/a.md");
  });

  it("does not mutate the input array", () => {
    const entries = parseWikiLog(SAMPLE_LOG);
    const before = entries.map((e) => e.lineNumber);
    sortWikiLogEntries(entries);
    expect(entries.map((e) => e.lineNumber)).toEqual(before);
  });
});

describe("distinctProcessKeys", () => {
  it("returns each process key once, alphabetically", () => {
    const entries = parseWikiLog(SAMPLE_LOG);
    expect(distinctProcessKeys(entries)).toEqual([
      "wiki.ask",
      "wiki.compile",
      "wiki.connect",
      "wiki.ingest_url",
      "wiki.lint",
      "wiki.trace",
    ]);
  });

  it("returns an empty array when the log is empty", () => {
    expect(distinctProcessKeys([])).toEqual([]);
  });
});

describe("filterByProcessKey", () => {
  const entries = parseWikiLog(SAMPLE_LOG);

  it("returns every entry when filter is `all` / null / undefined", () => {
    expect(filterByProcessKey(entries, "all")).toHaveLength(entries.length);
    expect(filterByProcessKey(entries, null)).toHaveLength(entries.length);
    expect(filterByProcessKey(entries, undefined)).toHaveLength(entries.length);
  });

  it("returns only matching entries for a specific filter", () => {
    const lintOnly = filterByProcessKey(entries, "wiki.lint");
    expect(lintOnly).toHaveLength(2);
    expect(lintOnly.every((e) => e.processKey === "wiki.lint")).toBe(true);
  });

  it("returns an empty array when no entry matches", () => {
    expect(filterByProcessKey(entries, "wiki.does-not-exist")).toEqual([]);
  });
});

describe("findLatestHealthReportPath", () => {
  it("returns the newest dated path", () => {
    const path = findLatestHealthReportPath([
      { path: "90_meta/health/2026-05-10.md" },
      { path: "90_meta/health/2026-05-12.md" },
      { path: "90_meta/health/2026-05-11.md" },
      { path: "20_wiki/_index.md" },
    ]);
    expect(path).toBe("90_meta/health/2026-05-12.md");
  });

  it("returns null when no health reports exist", () => {
    expect(findLatestHealthReportPath([{ path: "20_wiki/foo.md" }])).toBeNull();
    expect(findLatestHealthReportPath([])).toBeNull();
  });

  it("ignores files outside `90_meta/health/` even if they share a date prefix", () => {
    expect(
      findLatestHealthReportPath([
        { path: "30_outputs/2026-05-12-trace-foo.md" },
      ]),
    ).toBeNull();
  });
});

const SAMPLE_HEALTH = `# Wiki Health — 2026-05-12

## Summary
- 3 orphans, 1 broken link, 2 taxonomy candidates
- 0 stale notes

## Action items
- Re-link \`20_wiki/orphan-a.md\` from \`20_wiki/_index.md\`
- Resolve broken wikilink \`[[gone]]\` in \`20_wiki/foo.md\`
- Review taxonomy candidates section before promoting any

## Orphans
- \`20_wiki/orphan-a.md\`
- \`20_wiki/orphan-b.md\`

## Broken wikilinks
- \`20_wiki/foo.md\` → \`[[gone]]\`

## Missing frontmatter
_(none)_

## Stale content
_(none)_

## Term inconsistencies
_(none)_

## Taxonomy candidates
- quantum-computing — referenced by 4 raw / 0 wiki
- formal-methods — referenced by 3 raw / 1 wiki

## Index drift
_(none)_
`;

describe("parseWikiHealthReport", () => {
  it("extracts the summary and action items in document order", () => {
    const parsed = parseWikiHealthReport(
      "90_meta/health/2026-05-12.md",
      SAMPLE_HEALTH,
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.date).toBe("2026-05-12");
    expect(parsed!.summary).toEqual([
      "3 orphans, 1 broken link, 2 taxonomy candidates",
      "0 stale notes",
    ]);
    expect(parsed!.actionItems).toHaveLength(3);
    expect(parsed!.actionItems[0]).toMatch(/orphan-a/);
  });

  it("returns null when the path does not look like a health report", () => {
    expect(parseWikiHealthReport("20_wiki/foo.md", SAMPLE_HEALTH)).toBeNull();
  });

  it("skips `_(none)_` placeholder bullets", () => {
    const parsed = parseWikiHealthReport(
      "90_meta/health/2026-05-12.md",
      `## Summary\n_(none)_\n\n## Action items\n_(none)_\n`,
    );
    expect(parsed?.summary).toEqual([]);
    expect(parsed?.actionItems).toEqual([]);
  });

  it("preserves the raw body for the expand-on-click view", () => {
    const parsed = parseWikiHealthReport(
      "90_meta/health/2026-05-12.md",
      SAMPLE_HEALTH,
    );
    expect(parsed?.rawBody).toBe(SAMPLE_HEALTH);
  });
});

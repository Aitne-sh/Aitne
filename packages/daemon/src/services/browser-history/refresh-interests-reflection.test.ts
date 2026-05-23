import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { readRuntimeState } from "../../db/runtime-state.js";
import { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import {
  InterestsReflectionLockBusyError,
  _resetInterestsReflectionLockForTests,
  acquireInterestsReflectionLock,
} from "./interests-reflection-lock.js";
import {
  MAX_PROFILE_MD_THEMES,
  MIN_PROFILE_MD_THEMES,
  refreshInterestsReflection,
  RUNTIME_STATE_LAST_RUN_AT_KEY,
  RUNTIME_STATE_LAST_RUN_TARGETS_KEY,
  selectProfileMdThemes,
} from "./refresh-interests-reflection.js";
import type { ClusterSnapshot } from "./pipeline/weekly-interests-summary.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const TOKYO = { timezone: "Asia/Tokyo", dayBoundaryHour: 4 };
const WEEK_START = "2026-05-18";

function tsInWindow(dayOffset: number, hour = 12): number {
  return Date.UTC(2026, 4, 17, 19 + dayOffset * 24 + (hour - 4), 0, 0);
}

function tsInPriorWindow(dayOffset: number, hour = 12): number {
  return Date.UTC(2026, 4, 10, 19 + dayOffset * 24 + (hour - 4), 0, 0);
}

let visitCounter = 0;

function seedCluster(
  db: Database.Database,
  args: {
    slug: string;
    displayName: string;
    rootTaskId: number;
    status?: "active" | "dormant" | "muted" | "concluded";
    lastActivityAt: number;
    researchOfferAcceptedAt?: number | null;
    wikiSummaryWrittenAt?: number | null;
  },
) {
  db.prepare(
    `INSERT INTO browser_research_clusters (
       slug, root_task_id, display_name, started_at, last_activity_at,
       visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
       distinct_meaningful_domains, status,
       research_offer_accepted_at, wiki_summary_written_at,
       agent_summary_revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    args.slug,
    args.rootTaskId,
    args.displayName,
    args.lastActivityAt - 86_400_000,
    args.lastActivityAt,
    30,
    22,
    5400,
    4,
    args.status ?? "active",
    args.researchOfferAcceptedAt ?? null,
    args.wikiSummaryWrittenAt ?? null,
  );
}

function seedVisit(
  db: Database.Database,
  args: {
    rootTaskId: number;
    ts: number;
    domain: string;
    foregroundSec?: number;
  },
) {
  visitCounter += 1;
  db.prepare(
    `INSERT INTO browser_visits (
       ts, browser, profile, url_hash, domain, category, meaningful,
       foreground_sec, transition, is_reload, root_task_id
     ) VALUES (?, 'chrome', 'Default', ?, ?, 'research', 1, ?, 0, 0, ?)`,
  ).run(
    args.ts,
    `hash-${visitCounter}`,
    args.domain,
    args.foregroundSec ?? 600,
    args.rootTaskId,
  );
}

function makeCluster(
  overrides: Partial<ClusterSnapshot> & { slug: string },
): ClusterSnapshot {
  return {
    slug: overrides.slug,
    displayName: overrides.displayName ?? overrides.slug,
    daysActive: overrides.daysActive ?? 3,
    meaningfulVisits: overrides.meaningfulVisits ?? 12,
    meaningfulForegroundSec: overrides.meaningfulForegroundSec ?? 3600,
    distinctMeaningfulDomains: overrides.distinctMeaningfulDomains ?? 4,
    topDomains: overrides.topDomains ?? [],
    status: overrides.status ?? "active",
    statusChange: overrides.statusChange ?? "active_continued",
    clusterJournalPath:
      overrides.clusterJournalPath ?? `research/${overrides.slug}.md`,
    hasOpenOffer: overrides.hasOpenOffer ?? false,
    hasAcceptedResearch: overrides.hasAcceptedResearch ?? false,
    hasWikiSummary: overrides.hasWikiSummary ?? false,
    lastActivityDate: overrides.lastActivityDate ?? "2026-05-21",
    lastActivityMs: overrides.lastActivityMs ?? 0,
  };
}

describe("selectProfileMdThemes", () => {
  const nowMs = tsInWindow(6, 23);

  it("returns up to MAX_PROFILE_MD_THEMES ranked by score desc", () => {
    const clusters: ClusterSnapshot[] = [];
    for (let i = 0; i < 10; i++) {
      clusters.push(
        makeCluster({
          slug: `c-${i.toString().padStart(2, "0")}`,
          meaningfulForegroundSec: 100 - i * 10,
        }),
      );
    }
    const selected = selectProfileMdThemes(clusters, nowMs);
    expect(selected).toHaveLength(MAX_PROFILE_MD_THEMES);
    expect(selected[0]).toBe("c-00");
  });

  it("biases new themes upward by 20%", () => {
    const selected = selectProfileMdThemes(
      [
        makeCluster({
          slug: "established",
          meaningfulForegroundSec: 1000,
          statusChange: "active_continued",
        }),
        makeCluster({
          slug: "fresh",
          // 850 * 1.2 = 1020 > 1000 — fresh wins despite lower raw time
          meaningfulForegroundSec: 850,
          statusChange: "new",
        }),
      ],
      nowMs,
    );
    expect(selected[0]).toBe("fresh");
  });

  it("biases accepted research offers upward by 30%", () => {
    const selected = selectProfileMdThemes(
      [
        makeCluster({
          slug: "engaged",
          meaningfulForegroundSec: 800,
          hasAcceptedResearch: true,
        }),
        makeCluster({
          slug: "neutral",
          meaningfulForegroundSec: 1000,
        }),
      ],
      nowMs,
    );
    expect(selected[0]).toBe("engaged");
  });

  it("decays concluded topics with wiki summary + stale activity by 50%", () => {
    const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
    const selected = selectProfileMdThemes(
      [
        makeCluster({
          slug: "concluded",
          meaningfulForegroundSec: 2000,
          hasWikiSummary: true,
          lastActivityMs: sevenDaysAgo,
        }),
        makeCluster({
          slug: "fresh-and-engaged",
          meaningfulForegroundSec: 1500,
        }),
      ],
      nowMs,
    );
    // concluded: 2000 * 0.5 = 1000; fresh-and-engaged: 1500. The fresh wins.
    expect(selected[0]).toBe("fresh-and-engaged");
  });

  it("does not decay wiki summary topics that are still actively visited", () => {
    const selected = selectProfileMdThemes(
      [
        makeCluster({
          slug: "still-active",
          meaningfulForegroundSec: 2000,
          hasWikiSummary: true,
          lastActivityMs: nowMs - 60_000,
        }),
        makeCluster({
          slug: "other",
          meaningfulForegroundSec: 1500,
        }),
      ],
      nowMs,
    );
    expect(selected[0]).toBe("still-active");
  });

  it("treats lastActivityMs=0 as infinitely stale", () => {
    const selected = selectProfileMdThemes(
      [
        makeCluster({
          slug: "wiki-stale",
          meaningfulForegroundSec: 2000,
          hasWikiSummary: true,
          lastActivityMs: 0,
        }),
        makeCluster({
          slug: "newer",
          meaningfulForegroundSec: 1200,
        }),
      ],
      nowMs,
    );
    expect(selected[0]).toBe("newer");
  });

  it("breaks ties deterministically by slug asc", () => {
    const selected = selectProfileMdThemes(
      [
        makeCluster({ slug: "zeta", meaningfulForegroundSec: 1000 }),
        makeCluster({ slug: "alpha", meaningfulForegroundSec: 1000 }),
        makeCluster({ slug: "kappa", meaningfulForegroundSec: 1000 }),
      ],
      nowMs,
    );
    expect(selected).toEqual(["alpha", "kappa", "zeta"]);
  });
});

describe("refreshInterestsReflection", () => {
  let db: Database.Database;
  let dir: string;
  const nowMs = tsInWindow(6, 23);

  function seedThreeRichClusters() {
    seedCluster(db, {
      slug: "prompt-injection-defenses",
      displayName: "Prompt-injection defenses",
      rootTaskId: 1,
      lastActivityAt: tsInWindow(3),
    });
    for (let i = 0; i < 4; i++) {
      seedVisit(db, {
        rootTaskId: 1,
        ts: tsInWindow(i, 9 + i),
        domain: "anthropic.com",
        foregroundSec: 800,
      });
    }
    seedCluster(db, {
      slug: "quantum-mechanics-intro",
      displayName: "Quantum mechanics intro",
      rootTaskId: 2,
      lastActivityAt: tsInWindow(2),
    });
    for (let i = 0; i < 3; i++) {
      seedVisit(db, {
        rootTaskId: 2,
        ts: tsInWindow(i, 10 + i),
        domain: "en.wikipedia.org",
        foregroundSec: 500,
      });
    }
    seedCluster(db, {
      slug: "rust-borrow-checker",
      displayName: "Rust borrow checker",
      rootTaskId: 3,
      lastActivityAt: tsInWindow(2),
    });
    for (let i = 0; i < 2; i++) {
      seedVisit(db, {
        rootTaskId: 3,
        ts: tsInWindow(i, 12 + i),
        domain: "doc.rust-lang.org",
        foregroundSec: 400,
      });
    }
  }

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    dir = mkdtempSync(join(tmpdir(), "rir-test-"));
    visitCounter = 0;
    // rev 4 — the lock is process-global. A leaked lock from a prior
    // test would make every subsequent invocation throw
    // `InterestsReflectionLockBusyError`, so reset between tests for
    // isolation. The real production code never resets — every
    // legitimate acquire is paired with `release` in a finally block.
    _resetInterestsReflectionLockForTests();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    _resetInterestsReflectionLockForTests();
  });

  it("skips with fewer_than_min_themes when only 2 clusters qualify", () => {
    seedCluster(db, {
      slug: "lone",
      displayName: "Lone",
      rootTaskId: 1,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, { rootTaskId: 1, ts: tsInWindow(2), domain: "ex.com" });
    seedCluster(db, {
      slug: "two",
      displayName: "Two",
      rootTaskId: 2,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, { rootTaskId: 2, ts: tsInWindow(2), domain: "two.com" });

    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    expect(result.skipped?.reason).toBe("fewer_than_min_themes");
    expect(result.targetsWritten).toEqual([]);
    expect(existsSync(join(dir, "user", "research-themes.md"))).toBe(false);

    const audit = db
      .prepare(
        `SELECT result, detail FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as { result: string; detail: string };
    expect(audit.result).toBe("skipped");
    const detail = JSON.parse(audit.detail);
    expect(detail.skipped.reason).toBe("fewer_than_min_themes");
  });

  it("writes all four targets on the happy path", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    writeFileSync(
      join(dir, "user", "profile.md"),
      [
        "---",
        "type: user",
        "owner: user",
        "updated: 2026-05-01",
        "---",
        "# Profile",
        "",
        "## Identity",
        "Author of these notes.",
        "",
        "## Raw Signals",
        "- 2026-05-10 said something",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "user", "_index.md"),
      [
        "---",
        "type: user",
        "owner: user",
        "updated: 2026-05-01",
        "---",
        "# User topic index",
        "",
        "- `expertise.md` — what the user knows",
      ].join("\n"),
    );
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(
      join(dir, "projects", "prompt-injection-defenses.md"),
      [
        "---",
        "type: project",
        "owner: user",
        "updated: 2026-05-01",
        "aitne_project_keywords: [prompt, injection, defenses]",
        "---",
        "# Prompt-injection defenses project",
      ].join("\n"),
    );

    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });

    expect(result.skipped).toBeUndefined();
    expect(result.targetsWritten).toContain("user/profile.md");
    expect(result.targetsWritten).toContain("user/research-themes.md");
    expect(result.targetsWritten).toContain("user/_index.md");
    expect(result.targetsWritten).toContain(
      "projects/prompt-injection-defenses.md",
    );
    expect(result.projectsAnnotated).toBe(1);

    // profile.md gained the auto-block.
    const profileBytes = readFileSync(join(dir, "user", "profile.md"), "utf-8");
    expect(profileBytes).toContain("<!-- BEGIN aitne:browser-interests v1");
    expect(profileBytes).toContain("## Current research themes (auto)");
    // The user-authored sections must be untouched.
    expect(profileBytes).toContain("## Identity");
    expect(profileBytes).toContain("## Raw Signals");
    expect(profileBytes).toContain("- 2026-05-10 said something");

    // research-themes.md was created with the full snapshot.
    const themesBytes = readFileSync(
      join(dir, "user", "research-themes.md"),
      "utf-8",
    );
    expect(themesBytes).toContain("type: user");
    expect(themesBytes).toContain("owner: aitne-browser-history");
    expect(themesBytes).toContain("clusters_active: 3");

    // _index.md got the disambiguated entry.
    const indexBytes = readFileSync(join(dir, "user", "_index.md"), "utf-8");
    expect(indexBytes).toContain("target=research-themes");
    expect(indexBytes).toContain("- `expertise.md` — what the user knows");

    // Project file got annotated.
    const projectBytes = readFileSync(
      join(dir, "projects", "prompt-injection-defenses.md"),
      "utf-8",
    );
    expect(projectBytes).toContain(
      "<!-- BEGIN aitne:browser-interests v1 project=prompt-injection-defenses",
    );

    // runtime_state markers were written.
    expect(readRuntimeState<number>(db, RUNTIME_STATE_LAST_RUN_AT_KEY)).toBe(
      nowMs,
    );
    expect(
      readRuntimeState<string[]>(db, RUNTIME_STATE_LAST_RUN_TARGETS_KEY),
    ).toContain("user/research-themes.md");
  });

  it("records profile_md_missing skip when profile.md is absent", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    // No profile.md, no _index.md
    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    expect(result.targetsWritten).toContain("user/research-themes.md");
    expect(result.targetsWritten).not.toContain("user/profile.md");
    expect(result.targetsSkipped.some((s) => s.reason === "profile_md_missing")).toBe(
      true,
    );
    expect(result.targetsSkipped.some((s) => s.reason === "_index_missing")).toBe(
      true,
    );
  });

  it("preserves testimonial sections of profile.md exactly", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    const original = [
      "---",
      "type: user",
      "owner: user",
      "updated: 2026-05-01",
      "---",
      "# Profile",
      "",
      "## Identity",
      "User identity.",
      "",
      "## Work Pattern",
      "Patterns.",
      "",
      "## Expertise",
      "Knows things.",
      "",
      "## Raw Signals",
      "- 2026-05-10 raw thing",
      "",
      "## Learned Context",
      "- 2026-05-09 learned thing",
    ].join("\n");
    writeFileSync(join(dir, "user", "profile.md"), original);

    refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });

    const after = readFileSync(join(dir, "user", "profile.md"), "utf-8");
    // Every byte of the original sections must be intact.
    for (const heading of [
      "## Identity\nUser identity.",
      "## Work Pattern\nPatterns.",
      "## Expertise\nKnows things.",
      "## Raw Signals\n- 2026-05-10 raw thing",
      "## Learned Context\n- 2026-05-09 learned thing",
    ]) {
      expect(after).toContain(heading);
    }
    expect(after).toContain("<!-- BEGIN aitne:browser-interests v1");
  });

  it("is idempotent on a second run within the same week", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    writeFileSync(
      join(dir, "user", "profile.md"),
      ["---", "type: user", "owner: user", "updated: 2026-05-01", "---", "# Profile"].join("\n"),
    );
    const r1 = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    const profile1 = readFileSync(join(dir, "user", "profile.md"), "utf-8");
    const themes1 = readFileSync(
      join(dir, "user", "research-themes.md"),
      "utf-8",
    );

    const r2 = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    const profile2 = readFileSync(join(dir, "user", "profile.md"), "utf-8");
    const themes2 = readFileSync(
      join(dir, "user", "research-themes.md"),
      "utf-8",
    );

    expect(r2.themesSelected).toEqual(r1.themesSelected);
    expect(profile2).toBe(profile1);
    expect(themes2).toBe(themes1);
  });

  it("strips a prior project annotation when this week has no match", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "projects"), { recursive: true });
    // A project that does not match any of this week's clusters.
    const projectPath = join(dir, "projects", "espresso-machine.md");
    const initial = [
      "---",
      "type: project",
      "owner: user",
      "updated: 2026-05-01",
      "aliases: [espresso, machine]",
      "---",
      "# Espresso machine",
      "",
      "<!-- BEGIN aitne:browser-interests v1 project=espresso-machine weekStart=2026-05-11 generatedAt=2026-05-18T00:00:00Z -->",
      "stale annotation",
      "<!-- END aitne:browser-interests v1 project=espresso-machine -->",
      "",
    ].join("\n");
    writeFileSync(projectPath, initial);

    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    expect(result.projectsAnnotated).toBe(0);
    expect(result.projectsSkippedNoMatch).toBe(1);
    const after = readFileSync(projectPath, "utf-8");
    expect(after).not.toContain("stale annotation");
    expect(after).not.toContain("<!-- BEGIN aitne:browser-interests v1 project=espresso-machine");
    expect(after).toContain("# Espresso machine");
  });

  it("records project_missing when a project file vanishes between load and write", () => {
    seedThreeRichClusters();
    // Inject a project entry whose path does not exist on disk —
    // simulates the FS race where loadProjectKeywords scanned the
    // file but it was deleted before the writer reached it.
    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
      projectKeywordsOverride: [
        {
          projectSlug: "ghost",
          projectPath: join(dir, "projects", "ghost.md"),
          keywords: new Set(["ghost"]),
          source: "explicit",
        },
      ],
    });
    expect(result.targetsSkipped.some((s) => s.reason === "project_missing")).toBe(
      true,
    );
    expect(result.projectsAnnotated).toBe(0);
  });

  it("uses Date.now() when nowMs option is omitted", () => {
    // Just exercise the default-branch path; no clusters seeded, so
    // the helper takes the early-skip route, but the default-nowMs
    // assignment has already run by then.
    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      trigger: "test",
    });
    expect(result.skipped?.reason).toBe("fewer_than_min_themes");
  });

  it("does not throw when the audit-row insert fails", () => {
    seedThreeRichClusters();
    db.prepare("DROP TABLE agent_actions").run();
    // The refresh still completes file writes; the audit failure is
    // caught and logged. No exception propagates to the caller.
    expect(() =>
      refreshInterestsReflection(db, dir, {
        boundary: TOKYO,
        weekStart: WEEK_START,
        nowMs,
        trigger: "test",
      }),
    ).not.toThrow();
    expect(existsSync(join(dir, "user", "research-themes.md"))).toBe(true);
  });

  it("emits audit row with scheduler trigger source_kind=cron", () => {
    seedThreeRichClusters();
    refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "scheduler",
    });
    const row = db
      .prepare(
        `SELECT source_kind, trigger FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as { source_kind: string; trigger: string };
    expect(row.source_kind).toBe("cron");
    expect(row.trigger).toBe("weekly_interests_reflection:scheduler");
  });

  it("emits audit row with dashboard trigger source_kind=manual", () => {
    seedThreeRichClusters();
    refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "dashboard",
    });
    const row = db
      .prepare(
        `SELECT source_kind FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as { source_kind: string };
    expect(row.source_kind).toBe("manual");
  });

  it("derives weekStart from nowMs when not supplied", () => {
    seedThreeRichClusters();
    // Saturday tsInWindow(5) — agent-week boundary depends on caller;
    // here we just confirm the helper returns a string week_start in
    // ISO form and uses it in the audit detail.
    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      nowMs,
      trigger: "test",
    });
    expect(result.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses the local 04:00 default boundary when none supplied", () => {
    // The default boundary is { timezone: undefined, dayBoundaryHour: 4 }
    // — matches the CLAUDE.md invariant. Anchor visits well after the
    // 04:00 local boundary on a day inside the requested window so the
    // resolver picks them up regardless of the machine's local TZ.
    const localMiddayOnDay3 = Date.UTC(2026, 4, 20, 18, 0, 0);
    seedCluster(db, {
      slug: "a",
      displayName: "A",
      rootTaskId: 1,
      lastActivityAt: localMiddayOnDay3,
    });
    seedCluster(db, {
      slug: "b",
      displayName: "B",
      rootTaskId: 2,
      lastActivityAt: localMiddayOnDay3,
    });
    seedCluster(db, {
      slug: "c",
      displayName: "C",
      rootTaskId: 3,
      lastActivityAt: localMiddayOnDay3,
    });
    for (let i = 1; i <= 3; i++) {
      seedVisit(db, {
        rootTaskId: i,
        ts: localMiddayOnDay3,
        domain: `d${i}.example.com`,
        foregroundSec: i * 100,
      });
    }
    const result = refreshInterestsReflection(db, dir, {
      weekStart: "2026-05-18",
      nowMs: Date.UTC(2026, 4, 22, 23),
      trigger: "test",
    });
    expect(result.skipped).toBeUndefined();
    expect(result.targetsWritten).toContain("user/research-themes.md");
  });

  it("snaps the default weekStart back to the most recent Monday", () => {
    // Thursday in JST → weekStart should be the prior Monday.
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    const thursdayJst = Date.UTC(2026, 4, 21, 6); // 2026-05-21 15:00 JST
    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      nowMs: thursdayJst,
      trigger: "test",
    });
    expect(result.weekStart).toBe("2026-05-18");
  });

  it("keeps weekStart unchanged when the snap day is already Monday", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    const mondayJst = Date.UTC(2026, 4, 18, 6); // 2026-05-18 15:00 JST
    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      nowMs: mondayJst,
      trigger: "test",
    });
    expect(result.weekStart).toBe("2026-05-18");
  });

  it("snaps from a Sunday back to the prior Monday", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    const sundayJst = Date.UTC(2026, 4, 24, 6); // 2026-05-24 15:00 JST (Sun)
    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      nowMs: sundayJst,
      trigger: "test",
    });
    expect(result.weekStart).toBe("2026-05-18");
  });

  it("ignores existing irrelevant blocks in project files when picking what to strip", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "projects"), { recursive: true });
    const projectPath = join(dir, "projects", "espresso.md");
    writeFileSync(
      projectPath,
      [
        "---",
        "owner: user",
        "---",
        "# espresso",
        "",
        "<!-- BEGIN aitne:browser-interests v1 project=other-project weekStart=2026-05-11 -->",
        "should NOT be removed by this run",
        "<!-- END aitne:browser-interests v1 project=other-project -->",
      ].join("\n"),
    );
    refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    const after = readFileSync(projectPath, "utf-8");
    expect(after).toContain("should NOT be removed by this run");
  });

  it("strips a stale block whose slug embeds the HTML-comment closer", () => {
    // Project slug "evil-->name" is implausible from real filenames
    // but it pins the escape contract — render and strip must agree on
    // the BEGIN/END marker form ("evil-→name", not "evil-->name").
    seedThreeRichClusters();
    mkdirSync(join(dir, "projects"), { recursive: true });
    const projectPath = join(dir, "projects", "evil--name.md");
    const initial = [
      "---",
      "owner: user",
      "---",
      "# Evil",
      "",
      "<!-- BEGIN aitne:browser-interests v1 project=evil-→name weekStart=2026-05-11 generatedAt=2026-05-18T00:00:00Z -->",
      "stale annotation",
      "<!-- END aitne:browser-interests v1 project=evil-→name -->",
      "",
    ].join("\n");
    writeFileSync(projectPath, initial);

    refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
      projectKeywordsOverride: [
        {
          projectSlug: "evil-->name",
          projectPath,
          keywords: new Set(["unrelated"]),
          source: "explicit",
        },
      ],
    });

    const after = readFileSync(projectPath, "utf-8");
    expect(after).not.toContain("stale annotation");
    expect(after).not.toContain("evil-→name");
  });

  it("marks every written target on the agent-write tracker (content-hash mode)", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    writeFileSync(
      join(dir, "user", "profile.md"),
      ["---", "type: user", "owner: user", "---", "# Profile"].join("\n"),
    );
    writeFileSync(
      join(dir, "user", "_index.md"),
      ["---", "owner: user", "---", "# Index"].join("\n"),
    );
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(
      join(dir, "projects", "rust-borrow-checker.md"),
      [
        "---",
        "owner: user",
        "aitne_project_keywords: [rust, borrow, checker]",
        "---",
        "# Rust borrow checker",
      ].join("\n"),
    );
    const writeTracker = new AgentWriteTracker(60_000);
    refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
      writeTracker,
    });

    // Every target's on-disk bytes must satisfy `isMarked` in
    // content-hash mode — that's the contract for FS-watch
    // attribution: the chokidar observer reads the file and supplies
    // the bytes it saw to `isMarked`.
    for (const rel of [
      "user/profile.md",
      "user/research-themes.md",
      "user/_index.md",
      "projects/rust-borrow-checker.md",
    ]) {
      const fullPath = join(dir, rel);
      const bytes = readFileSync(fullPath, "utf-8");
      expect(writeTracker.isMarked(fullPath, bytes)).toBe(true);
    }
  });

  it("rolls the agent-write mark back when an atomic write throws", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    // Replace the parent directory of user/research-themes.md with a
    // read-only file — the atomic rename will fail because the
    // destination's parent isn't writable. The helper must surface the
    // throw and unmark the path so a later observer of the original
    // disk state isn't told "the agent wrote this".
    const themesPath = join(dir, "user", "research-themes.md");
    // Pre-existing profile.md so the prior target succeeds; we want
    // the throw to land on the research-themes write specifically.
    writeFileSync(
      join(dir, "user", "profile.md"),
      ["---", "type: user", "owner: user", "---", "# Profile"].join("\n"),
    );
    const writeTracker = new AgentWriteTracker(60_000);
    // Pre-create research-themes.md as a directory (not a file) so the
    // atomic rename target is unwritable. This is the cheapest
    // platform-portable way to force a throw inside writeFileAtomically.
    mkdirSync(themesPath, { recursive: true });

    expect(() =>
      refreshInterestsReflection(db, dir, {
        boundary: TOKYO,
        weekStart: WEEK_START,
        nowMs,
        trigger: "test",
        writeTracker,
      }),
    ).toThrow();

    // The path-level mark for research-themes.md is rolled back. The
    // profile.md mark stays because that write succeeded — `isMarked`
    // confirms the post-write bytes match.
    expect(writeTracker.isMarked(themesPath, "")).toBe(false);
    expect(
      writeTracker.isMarked(
        join(dir, "user", "profile.md"),
        readFileSync(join(dir, "user", "profile.md"), "utf-8"),
      ),
    ).toBe(true);
  });

  it("is a structural no-op when writeTracker is omitted", () => {
    // The optional `writeTracker` must remain truly optional — tests
    // and the dashboard preview pathway both pass undefined. Verifies
    // there's no implicit dependency that would NPE the helper.
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    writeFileSync(
      join(dir, "user", "profile.md"),
      ["---", "type: user", "owner: user", "---", "# Profile"].join("\n"),
    );
    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    expect(result.skipped).toBeUndefined();
    expect(result.targetsWritten).toContain("user/profile.md");
  });

  it("re-renders the project block when a refresh swaps the matching cluster set", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "projects"), { recursive: true });
    const projectPath = join(dir, "projects", "rust-borrow-checker.md");
    writeFileSync(
      projectPath,
      [
        "---",
        "owner: user",
        "aitne_project_keywords: [rust, borrow, checker]",
        "---",
        "# Rust borrow checker",
      ].join("\n"),
    );

    const r1 = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    expect(r1.projectsAnnotated).toBe(1);
    const after1 = readFileSync(projectPath, "utf-8");
    expect(after1).toContain("project=rust-borrow-checker");

    // Run again — same data → byte-identical project annotation.
    refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    const after2 = readFileSync(projectPath, "utf-8");
    expect(after2).toBe(after1);
  });

  // ──────────────────────────────────────────────────────────────────
  // rev 4 behaviors — unified skip taxonomy, lock, partial audit row,
  // explicit metadata column.
  // ──────────────────────────────────────────────────────────────────

  it("short-circuits with skipped='no_browser_history' when integrationDisabled is true", () => {
    seedThreeRichClusters();
    const result = refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "scheduler",
      integrationDisabled: true,
    });
    expect(result.skipped?.reason).toBe("no_browser_history");
    expect(result.targetsWritten).toEqual([]);
    expect(result.themesSelected).toEqual([]);
    // research-themes.md is NOT created — no disk write happens at all.
    expect(existsSync(join(dir, "user", "research-themes.md"))).toBe(false);

    // Audit row uniform with the fewer_than_min_themes case.
    const row = db
      .prepare(
        `SELECT result, trigger, detail, error, metadata FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as {
      result: string;
      trigger: string;
      detail: string;
      error: string | null;
      metadata: string;
    };
    expect(row.result).toBe("skipped");
    expect(row.trigger).toBe("weekly_interests_reflection:scheduler");
    expect(row.error).toBeNull();
    expect(row.metadata).toBe("{}");
    const detail = JSON.parse(row.detail);
    expect(detail.skipped.reason).toBe("no_browser_history");
  });

  it("does not take the lock when integrationDisabled is true (cleanup can still run concurrently)", () => {
    // The disabled-gate short-circuit must not engage the lock —
    // otherwise an admin could not click "Clean up auto-blocks" while
    // the scheduler is in its disabled-gate path each Friday.
    seedThreeRichClusters();
    refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "scheduler",
      integrationDisabled: true,
    });
    // A subsequent acquire by an unrelated caller must succeed — the
    // disabled path never held the lock.
    const release = acquireInterestsReflectionLock("cleanup:dashboard");
    release();
  });

  it("emits result='partial' audit row when write throws mid-flight after profile.md was already written", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    writeFileSync(
      join(dir, "user", "profile.md"),
      ["---", "type: user", "owner: user", "---", "# Profile"].join("\n"),
    );
    // Force research-themes.md write to throw — directory at the
    // intended file path is the cheapest portable way to do this.
    mkdirSync(join(dir, "user", "research-themes.md"), { recursive: true });

    expect(() =>
      refreshInterestsReflection(db, dir, {
        boundary: TOKYO,
        weekStart: WEEK_START,
        nowMs,
        trigger: "test",
      }),
    ).toThrow();

    // Even though the helper threw, the audit row records the partial
    // state — `result='partial'` plus `error` populated with the
    // throw's message. The dashboard's audit log uses this to surface
    // "the scheduler ran but only got X targets written".
    const row = db
      .prepare(
        `SELECT result, detail, error, metadata FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as {
      result: string;
      detail: string;
      error: string | null;
      metadata: string;
    };
    expect(row.result).toBe("partial");
    expect(row.error).toMatch(/EISDIR|rename|directory/i);
    expect(row.metadata).toBe("{}");
    const detail = JSON.parse(row.detail);
    expect(detail.targets_written).toContain("user/profile.md");
    expect(detail.error_message).toBe(row.error);
  });

  it("emits result='failed' audit row when build throws before any write", () => {
    seedThreeRichClusters();
    // Drop the clusters table — the very first read inside the helper
    // throws SqliteError, before any disk write. `partial` shouldn't
    // apply because targetsWritten is empty.
    db.prepare("DROP TABLE browser_research_clusters").run();
    expect(() =>
      refreshInterestsReflection(db, dir, {
        boundary: TOKYO,
        weekStart: WEEK_START,
        nowMs,
        trigger: "test",
      }),
    ).toThrow();
    const row = db
      .prepare(
        `SELECT result, error FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as { result: string; error: string | null };
    expect(row.result).toBe("failed");
    expect(row.error).toMatch(/no such table|browser_research_clusters/i);
  });

  it("releases the lock in the finally block on a thrown write", () => {
    seedThreeRichClusters();
    mkdirSync(join(dir, "user"), { recursive: true });
    writeFileSync(
      join(dir, "user", "profile.md"),
      ["---", "type: user", "owner: user", "---", "# Profile"].join("\n"),
    );
    mkdirSync(join(dir, "user", "research-themes.md"), { recursive: true });

    expect(() =>
      refreshInterestsReflection(db, dir, {
        boundary: TOKYO,
        weekStart: WEEK_START,
        nowMs,
        trigger: "test",
      }),
    ).toThrow();
    // After the throw, the lock MUST be free — otherwise the next
    // weekly_review tick can never run again.
    const release = acquireInterestsReflectionLock("after:throw");
    release();
  });

  it("rejects a concurrent helper invocation with InterestsReflectionLockBusyError", () => {
    // Simulate the scheduler-vs-dashboard race by acquiring the lock
    // externally, then calling the helper.
    const externalRelease = acquireInterestsReflectionLock(
      "external:simulation",
    );
    try {
      seedThreeRichClusters();
      expect(() =>
        refreshInterestsReflection(db, dir, {
          boundary: TOKYO,
          weekStart: WEEK_START,
          nowMs,
          trigger: "dashboard",
        }),
      ).toThrow(InterestsReflectionLockBusyError);
    } finally {
      externalRelease();
    }
  });

  it("does NOT throw lock-busy when the contention is the disabled-gate short-circuit (no acquire)", () => {
    // The disabled-gate short-circuit must succeed even if the lock is
    // currently held by some other operation — it never tries to
    // acquire. This is the load-bearing case for the scheduler tick
    // racing a dashboard cleanup: the scheduler bails out cleanly with
    // 'no_browser_history' without colliding with cleanup's lock.
    const externalRelease = acquireInterestsReflectionLock(
      "cleanup:dashboard",
    );
    try {
      const result = refreshInterestsReflection(db, dir, {
        boundary: TOKYO,
        weekStart: WEEK_START,
        nowMs,
        trigger: "scheduler",
        integrationDisabled: true,
      });
      expect(result.skipped?.reason).toBe("no_browser_history");
    } finally {
      externalRelease();
    }
  });

  it("passes explicit metadata='{}' to the audit insert (rev 4 — documents the empty side-channel)", () => {
    seedThreeRichClusters();
    refreshInterestsReflection(db, dir, {
      boundary: TOKYO,
      weekStart: WEEK_START,
      nowMs,
      trigger: "test",
    });
    const row = db
      .prepare(
        `SELECT metadata FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as { metadata: string };
    // Explicit '{}' — not undefined, not null. Documents at the SQL
    // call site that the daemon-write side never populates metadata
    // (the agent-self-report channel is for `PATCH /api/agent-actions/
    // self`, per agent_actions schema comment).
    expect(row.metadata).toBe("{}");
  });
});

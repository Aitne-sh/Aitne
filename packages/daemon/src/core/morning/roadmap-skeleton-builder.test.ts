import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRoadmapSkeleton,
  extractAnnualGoals,
  gatherRoadmapSkeletonFacts,
  type RoadmapSkeletonCalendarEvent,
  type RoadmapSkeletonProject,
  type RoadmapSkeletonTravelBooking,
} from "./roadmap-skeleton-builder.js";

// `roadmap-skeleton-builder` only depends on the `travel_bookings` table;
// the projects + management-rules data lives in the fs context dir. We
// build the minimum schema inline so the test stays decoupled from the
// daemon's full `applySchema` (which would also seed unrelated process
// presets and slow the suite).
function seedTravelTable(db: Database.Database): void {
  db.exec(`CREATE TABLE travel_bookings (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    provider TEXT NOT NULL,
    destination TEXT,
    start_date TEXT,
    end_date TEXT,
    confirmation_number TEXT,
    amount INTEGER,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT DEFAULT 'upcoming',
    provider_msg_id TEXT,
    account_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
}

function insertTravel(
  db: Database.Database,
  row: {
    type: string;
    destination: string | null;
    startDate: string | null;
    endDate: string | null;
    status?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO travel_bookings (type, provider, destination, start_date, end_date, status)
     VALUES (?, 'test', ?, ?, ?, COALESCE(?, 'upcoming'))`,
  ).run(row.type, row.destination, row.startDate, row.endDate, row.status ?? null);
}

describe("extractAnnualGoals", () => {
  it("returns [] when the heading is absent", () => {
    expect(extractAnnualGoals("# rules\n\n## Other\n- x\n")).toEqual([]);
  });

  it("collects `-` and `*` bullets under `## Annual Goals` until next H2", () => {
    const body = [
      "# rules",
      "",
      "## Annual Goals",
      "- Ship Aitne 1.0",
      "* Maintain agent journal discipline",
      "  - nested bullet ignored at this nesting depth", // current rule: leading whitespace tolerated
      "",
      "## Quarterly Goals",
      "- not collected",
      "",
    ].join("\n");
    expect(extractAnnualGoals(body)).toEqual([
      "Ship Aitne 1.0",
      "Maintain agent journal discipline",
      "nested bullet ignored at this nesting depth",
    ]);
  });

  it("stops at the next H2 even when bullets follow", () => {
    const body = [
      "## Annual Goals",
      "- Goal A",
      "## Notes",
      "- Note A",
    ].join("\n");
    expect(extractAnnualGoals(body)).toEqual(["Goal A"]);
  });

  it("returns [] when the section is empty", () => {
    const body = "## Annual Goals\n\n## Next\n- x\n";
    expect(extractAnnualGoals(body)).toEqual([]);
  });
});

describe("gatherRoadmapSkeletonFacts", () => {
  let db: Database.Database;
  let contextDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    seedTravelTable(db);
    contextDir = mkdtempSync(join(tmpdir(), "roadmap-skel-"));
  });

  afterEach(() => {
    db.close();
    rmSync(contextDir, { recursive: true, force: true });
  });

  it("returns empty facts on a fresh install (no projects, no rules, no travel)", () => {
    const facts = gatherRoadmapSkeletonFacts(db, contextDir, "2026-05-16");
    expect(facts).toEqual({
      activeProjects: [],
      annualGoals: [],
      upcomingTravel: [],
    });
  });

  it("walks context/projects/ and excludes archived + leading-underscore files", () => {
    const projectsDir = join(contextDir, "plans", "projects");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "aitne.md"),
      "---\nstate: active\ndue: 2026-06-30\nnext_milestone: Ship 1.0\n---\n\n# Aitne 1.0\nbody\n",
    );
    writeFileSync(
      join(projectsDir, "archived-project.md"),
      "---\nstate: archived\n---\n\n# Archived\n",
    );
    writeFileSync(
      join(projectsDir, "_template.md"),
      "---\nstate: active\n---\n\n# Template\n",
    );

    const facts = gatherRoadmapSkeletonFacts(db, contextDir, "2026-05-16");
    expect(facts.activeProjects).toHaveLength(1);
    expect(facts.activeProjects[0]).toMatchObject({
      slug: "aitne",
      title: "Aitne 1.0",
      state: "active",
      due: "2026-06-30",
      nextMilestone: "Ship 1.0",
    });
  });

  it("sorts active projects by due ascending then slug", () => {
    const projectsDir = join(contextDir, "plans", "projects");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "zebra.md"),
      "---\nstate: active\ndue: 2026-07-01\n---\n\n# Zebra\n",
    );
    writeFileSync(
      join(projectsDir, "alpha.md"),
      "---\nstate: active\n---\n\n# Alpha (no due)\n",
    );
    writeFileSync(
      join(projectsDir, "beta.md"),
      "---\nstate: active\ndue: 2026-06-01\n---\n\n# Beta\n",
    );
    const facts = gatherRoadmapSkeletonFacts(db, contextDir, "2026-05-16");
    expect(facts.activeProjects.map((p) => p.slug)).toEqual([
      "beta",
      "zebra",
      "alpha",
    ]);
  });

  it("reads Annual Goals out of rules/management.md", () => {
    const rulesDir = join(contextDir, "policies");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, "management.md"),
      "# Management rules\n\n## Annual Goals\n- Ship Aitne 1.0\n- Open-source by EOY\n\n## Other\n",
    );
    const facts = gatherRoadmapSkeletonFacts(db, contextDir, "2026-05-16");
    expect(facts.annualGoals).toEqual([
      "Ship Aitne 1.0",
      "Open-source by EOY",
    ]);
  });

  it("returns upcoming travel ordered by start_date and skips cancelled rows", () => {
    insertTravel(db, {
      type: "flight",
      destination: "Tokyo",
      startDate: "2026-06-01",
      endDate: "2026-06-01",
    });
    insertTravel(db, {
      type: "hotel",
      destination: "Tokyo",
      startDate: "2026-06-01",
      endDate: "2026-06-05",
    });
    insertTravel(db, {
      type: "flight",
      destination: "Past",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
    });
    insertTravel(db, {
      type: "flight",
      destination: "Cancelled",
      startDate: "2026-06-15",
      endDate: "2026-06-15",
      status: "cancelled",
    });
    insertTravel(db, {
      type: "flight",
      destination: "Future",
      startDate: "2026-07-15",
      endDate: "2026-07-15",
    });

    const facts = gatherRoadmapSkeletonFacts(db, contextDir, "2026-05-16");
    expect(facts.upcomingTravel.map((r) => r.destination)).toEqual([
      "Tokyo",
      "Tokyo",
      "Future",
    ]);
  });

  it("silent-skips travel when the table is missing (defensive fallback)", () => {
    const cleanDb = new Database(":memory:");
    try {
      const facts = gatherRoadmapSkeletonFacts(cleanDb, contextDir, "2026-05-16");
      expect(facts.upcomingTravel).toEqual([]);
    } finally {
      cleanDb.close();
    }
  });
});

describe("buildRoadmapSkeleton", () => {
  const today = "2026-05-16";
  const projectA: RoadmapSkeletonProject = {
    slug: "aitne",
    title: "Aitne 1.0",
    state: "active",
    due: "2026-06-30",
    nextMilestone: "Ship release",
  };
  const cal: RoadmapSkeletonCalendarEvent[] = [
    { date: "2026-05-17", title: "Standup" },
    { date: "2026-05-19", title: "Onsite kickoff" },
  ];
  const travel: RoadmapSkeletonTravelBooking[] = [
    {
      type: "flight",
      destination: "Tokyo",
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      status: "upcoming",
    },
    {
      type: "hotel",
      destination: "Tokyo",
      startDate: "2026-06-01",
      endDate: "2026-06-05",
      status: "upcoming",
    },
  ];

  it("renders every section with provided facts", () => {
    const body = buildRoadmapSkeleton(
      { todayDateStr: today, calendarEvents: cal, timezone: "Asia/Tokyo" },
      {
        activeProjects: [projectA],
        annualGoals: ["Ship Aitne 1.0", "Open-source by EOY"],
        upcomingTravel: travel,
      },
    );
    expect(body).toContain("## Annual Goals");
    expect(body).toContain("- Ship Aitne 1.0");
    expect(body).toContain("- Open-source by EOY");
    expect(body).toContain("## Quarterly Focus");
    expect(body).toContain("### Active projects");
    expect(body).toContain("Aitne 1.0 (`aitne`)");
    expect(body).toContain("next: Ship release");
    expect(body).toContain("due: 2026-06-30");
    expect(body).toContain("### Near-term calendar (7d)");
    expect(body).toContain("- 2026-05-17 — Standup");
    expect(body).toContain("- 2026-05-19 — Onsite kickoff");
    expect(body).toContain("## Preparation Timeline");
    expect(body).toContain("### Travel");
    expect(body).toContain("- 2026-06-01 — flight: Tokyo");
    expect(body).toContain("- 2026-06-01 → 2026-06-05 — hotel: Tokyo");
    expect(body).toContain("Asia/Tokyo");
    expect(body).toContain(today);
  });

  it("renders placeholders when every section is empty", () => {
    const body = buildRoadmapSkeleton(
      { todayDateStr: today, calendarEvents: [] },
      { activeProjects: [], annualGoals: [], upcomingTravel: [] },
    );
    expect(body).toContain("## Annual Goals");
    expect(body).toContain("_(Not yet configured");
    expect(body).toContain("rules/management.md has no `## Annual Goals` section");
    expect(body).toContain("## Quarterly Focus");
    expect(body).toContain("no active projects under context/projects/");
    expect(body).toContain("## Preparation Timeline");
    expect(body).toContain("no upcoming travel_bookings");
    // Stage A Action Plan section is intentionally NOT emitted by the
    // skeleton — see module JSDoc rationale.
    expect(body).not.toContain("## Agent Action Plan");
  });

  it("renders the Stage A scratch banner with timezone fallback", () => {
    const body = buildRoadmapSkeleton(
      { todayDateStr: today, calendarEvents: [] },
      { activeProjects: [], annualGoals: [], upcomingTravel: [] },
    );
    expect(body).toContain("Stage A: this is daemon-prepared scratch data");
    expect(body).toContain("Calendar dates are in system");
  });

  it("hides the Active projects subheading when projects are empty but calendar is present", () => {
    const body = buildRoadmapSkeleton(
      { todayDateStr: today, calendarEvents: cal },
      { activeProjects: [], annualGoals: ["x"], upcomingTravel: [] },
    );
    expect(body).not.toContain("### Active projects");
    expect(body).toContain("### Near-term calendar (7d)");
  });

  it("hides the Travel subheading when travel is empty but calendar is present", () => {
    const body = buildRoadmapSkeleton(
      { todayDateStr: today, calendarEvents: cal },
      { activeProjects: [projectA], annualGoals: ["x"], upcomingTravel: [] },
    );
    expect(body).not.toContain("### Travel");
    expect(body).toContain("### Calendar (7d)");
  });

  it("renders single-day travel as one date without the arrow", () => {
    const body = buildRoadmapSkeleton(
      { todayDateStr: today, calendarEvents: [] },
      {
        activeProjects: [],
        annualGoals: [],
        upcomingTravel: [
          {
            type: "flight",
            destination: "Tokyo",
            startDate: "2026-06-01",
            endDate: "2026-06-01",
            status: "upcoming",
          },
        ],
      },
    );
    expect(body).toContain("- 2026-06-01 — flight: Tokyo");
    expect(body).not.toContain("→ 2026-06-01");
  });

  it("flags non-upcoming travel status inline", () => {
    const body = buildRoadmapSkeleton(
      { todayDateStr: today, calendarEvents: [] },
      {
        activeProjects: [],
        annualGoals: [],
        upcomingTravel: [
          {
            type: "flight",
            destination: "Tokyo",
            startDate: "2026-06-01",
            endDate: "2026-06-01",
            status: "tentative",
          },
        ],
      },
    );
    expect(body).toContain("[tentative]");
  });

  it("emits `(untitled)` for blank-title events", () => {
    const body = buildRoadmapSkeleton(
      {
        todayDateStr: today,
        calendarEvents: [{ date: "2026-05-17", title: "  " }],
      },
      { activeProjects: [], annualGoals: ["x"], upcomingTravel: [] },
    );
    expect(body).toContain("- 2026-05-17 — (untitled)");
  });

  it("emits `(destination tbd)` for travel rows missing destination", () => {
    const body = buildRoadmapSkeleton(
      { todayDateStr: today, calendarEvents: [] },
      {
        activeProjects: [],
        annualGoals: [],
        upcomingTravel: [
          {
            type: "flight",
            destination: null,
            startDate: "2026-06-01",
            endDate: "2026-06-01",
            status: "upcoming",
          },
        ],
      },
    );
    expect(body).toContain("(destination tbd)");
  });
});

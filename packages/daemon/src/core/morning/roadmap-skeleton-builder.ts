/**
 * `buildRoadmapSkeleton` + `gatherRoadmapSkeletonFacts` — assemble the
 * `<roadmap_skeleton>` MD body that the morning-routine orchestrator
 * injects into Stage A's prompt on the **first-run** (no-yesterday)
 * branch.
 *
 * Why this exists — `docs/design/appendices/morning-routine-optimization.md`
 * retires `routine.morning_routine_initial`'s high-tier session.
 * On the first run after setup, the wizard-installed `roadmap.md`
 * carries only the `_(Not yet configured)_` placeholder rows. The
 * legacy initial routine spent a high-tier (Opus) cold-start session
 * regenerating every section from scratch — read management rules,
 * survey active projects, scan calendar, query travel bookings, then
 * compose the markdown. That last step is template assembly and is
 * what justified the tier upgrade. By doing the deterministic data
 * gather here and emitting a pre-shaped `<roadmap_skeleton>` block,
 * Stage A on medium tier can spot-edit the skeleton into
 * `roadmap.md` via the same `PATCH` paths the recurring branch uses —
 * collapsing the variant into a single medium-tier flow.
 *
 * The skeleton is **scratch data**. Stage A is the only writer of
 * `roadmap.md`; the skeleton's role is to amortize the "what should I
 * even put in `## Annual Goals` / `## Quarterly Focus` / `## Preparation
 * Timeline`" research over a deterministic SQL+fs pass instead of a
 * judgment-heavy turn. Stage A may reshape, prune, or reword every
 * section before its `PUT /api/context/roadmap`. There is no
 * byte-for-byte preservation contract — unlike the journal skeleton —
 * because `roadmap.md` is daemon-tracked but has no per-field
 * validator, and Stage A's judgement (active vs. archived projects,
 * which calendar events count as preparation, which travel rows are
 * still relevant) is the load-bearing reason this stays on medium tier.
 *
 * Gating: the orchestrator only computes the skeleton when
 * `yesterday.md` is absent (the first-run signal). The recurring
 * branch leaves `<roadmap_skeleton>` absent and Stage A falls back to
 * the truncated `<roadmap>` block ContextBuilder injects today; this is
 * exactly how the variant collapse is supposed to read.
 *
 * Two-layer design mirrors `journal-skeleton-builder.ts`:
 *   - `gatherRoadmapSkeletonFacts(db, contextDir, ...)` — runs SQLite
 *     aggregations against `travel_bookings`, walks `context/projects/`
 *     for active project frontmatter, parses `rules/management.md`
 *     for the operator-declared goals block, and pulls 7-day calendar
 *     events for the `## Quarterly Focus` synthesis hints. Pure
 *     read-only, idempotent.
 *   - `buildRoadmapSkeleton(inputs, facts)` — pure markdown composer
 *     that emits one section per roadmap.md heading the template
 *     expects.
 *
 * The split keeps the I/O-bound queries testable independently and
 * lets the pure builder be exercised with synthesized fixtures.
 */

import type Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Calendar event filtered to the look-ahead window for Quarterly Focus + Preparation Timeline hints. */
export interface RoadmapSkeletonCalendarEvent {
  /** `YYYY-MM-DD` start date in the operator timezone. */
  date: string;
  /** Event title. May be empty (rendered as `(untitled)`). */
  title: string;
}

/** Inputs the daemon assembles before invoking the builder. */
export interface RoadmapSkeletonInputs {
  /** Today's agent-day date in `YYYY-MM-DD`. Lands in the `updated:` frontmatter. */
  todayDateStr: string;
  /**
   * Forward-looking calendar events spanning the next 7 days. Used as
   * candidates for ## Quarterly Focus near-term milestones and as
   * preparation triggers (e.g. an `Onsite` block 3 days out cues a
   * `Preparation Timeline` row).
   */
  calendarEvents: ReadonlyArray<RoadmapSkeletonCalendarEvent>;
  /**
   * IANA timezone (e.g. `Asia/Tokyo`) — surfaced in the skeleton's
   * front-matter comment so Stage A knows which zone the embedded
   * dates are in. Optional; falls back to "system".
   */
  timezone?: string;
}

/** Project summary derived from `context/projects/<slug>.md` frontmatter. */
export interface RoadmapSkeletonProject {
  slug: string;
  title: string;
  state: string;
  /** ISO date (`YYYY-MM-DD`) parsed from `due:` frontmatter when present. */
  due: string | null;
  /** Free-text "what's next" line, parsed from `next_milestone:`. */
  nextMilestone: string | null;
}

/** Travel booking row condensed for the Preparation Timeline. */
export interface RoadmapSkeletonTravelBooking {
  type: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
}

/** Facts derived from SQLite + fs for the first-run skeleton. */
export interface RoadmapSkeletonFacts {
  /**
   * Active project summaries — every `context/projects/*.md` whose
   * `state` frontmatter is not `archived`. Stable order: due ascending
   * (nulls last), then slug ascending — same sort the active-projects
   * block in ContextBuilder uses so the two blocks read as one
   * coherent picture in Stage A's prompt.
   */
  activeProjects: ReadonlyArray<RoadmapSkeletonProject>;
  /**
   * Annual goals — operator-supplied free-text lines extracted from
   * `rules/management.md` under a `## Annual Goals` heading. Empty
   * when the heading is absent or the section is empty (the skeleton
   * then renders an explicit `_(Not yet configured)_` placeholder
   * Stage A is expected to replace with the operator's intent — same
   * line the setup wizard wrote).
   */
  annualGoals: ReadonlyArray<string>;
  /**
   * Upcoming travel rows — `start_date >= today AND status != 'cancelled'`,
   * ordered by `start_date` ascending. The Preparation Timeline section
   * cites these as the rows the agent should fan preparation tasks
   * out from.
   */
  upcomingTravel: ReadonlyArray<RoadmapSkeletonTravelBooking>;
}

/**
 * Source paths consumed by `gatherRoadmapSkeletonFacts`. All paths are
 * relative to the daemon's `contextDir`. Centralised here so test
 * harnesses can substitute the directory without re-implementing the
 * fs walk.
 */
const PROJECTS_REL = "projects";
const MANAGEMENT_RULES_REL = "rules/management.md";

/**
 * Run the SQLite + fs aggregations that feed the skeleton. Pure
 * read-only; callers own the timezone math (`todayDateStr` is the
 * filter the `start_date >= ?` predicate joins against).
 *
 * `contextDir` must point at the daemon's runtime context directory
 * (e.g. `~/.personal-agent/context`). Missing files are silent-skipped
 * — the skeleton renders explicit placeholders so the failure mode is
 * "Stage A sees an empty section" rather than "Stage A sees no
 * skeleton at all", which is what the variant collapse depends on.
 */
export function gatherRoadmapSkeletonFacts(
  db: Database.Database,
  contextDir: string,
  todayDateStr: string,
): RoadmapSkeletonFacts {
  const activeProjects = readActiveProjects(contextDir);
  const annualGoals = readAnnualGoals(contextDir);
  const upcomingTravel = readUpcomingTravel(db, todayDateStr);
  return { activeProjects, annualGoals, upcomingTravel };
}

/**
 * Compose the `<roadmap_skeleton>` MD body. Pure — every output byte is
 * a deterministic function of `inputs` + `facts`. Stage A reads this as
 * scratch input and authors `roadmap.md` per the operator-visible
 * template (`## Annual Goals` / `## Quarterly Focus` /
 * `## Preparation Timeline` / `## Agent Action Plan`).
 *
 * The composer NEVER emits the `## Agent Action Plan` section — that
 * is operationally tightly coupled to today's User Tasks + roadmap-
 * relevant `agent_schedule` rows, both of which Stage A enumerates
 * inside its own turn from the live observations table. Including a
 * stale skeleton plan would invite Stage A to copy it verbatim and
 * mask schedule-fan-out drift.
 */
export function buildRoadmapSkeleton(
  inputs: RoadmapSkeletonInputs,
  facts: RoadmapSkeletonFacts,
): string {
  const lines: string[] = [];
  const tzLabel = inputs.timezone ?? "system";
  lines.push("<!-- Stage A: this is daemon-prepared scratch data.");
  lines.push("     Reshape, prune, or reword before PUT /api/context/roadmap.");
  lines.push(
    `     Calendar dates are in ${tzLabel}; today is ${inputs.todayDateStr}.`,
  );
  lines.push("     No byte-for-byte preservation contract — author per the");
  lines.push("     roadmap.md operator template. -->");
  lines.push("");
  appendAnnualGoalsSection(lines, facts.annualGoals);
  appendQuarterlyFocusSection(lines, facts, inputs.calendarEvents);
  appendPreparationTimelineSection(
    lines,
    facts.upcomingTravel,
    inputs.calendarEvents,
  );
  return lines.join("\n");
}

// ── Section emitters ───────────────────────────────────────────────────────

function appendAnnualGoalsSection(out: string[], goals: ReadonlyArray<string>): void {
  out.push("## Annual Goals");
  if (goals.length === 0) {
    out.push("_(Not yet configured — rules/management.md has no `## Annual Goals` section. Stage A: read `<management_rules>` for intent or leave the placeholder for the operator to fill.)_");
  } else {
    for (const goal of goals) {
      out.push(`- ${goal}`);
    }
  }
  out.push("");
}

function appendQuarterlyFocusSection(
  out: string[],
  facts: RoadmapSkeletonFacts,
  calendarEvents: ReadonlyArray<RoadmapSkeletonCalendarEvent>,
): void {
  out.push("## Quarterly Focus");
  if (facts.activeProjects.length === 0 && calendarEvents.length === 0) {
    out.push("_(Not yet configured — no active projects under context/projects/ and no calendar events in the next 7 days.)_");
    out.push("");
    return;
  }
  if (facts.activeProjects.length > 0) {
    out.push("### Active projects");
    for (const project of facts.activeProjects) {
      const parts: string[] = [`state: ${project.state}`];
      if (project.nextMilestone) parts.push(`next: ${project.nextMilestone}`);
      if (project.due) parts.push(`due: ${project.due}`);
      out.push(
        `- ${project.title} (\`${project.slug}\`) — ${parts.join("; ")}`,
      );
    }
    out.push("");
  }
  if (calendarEvents.length > 0) {
    out.push("### Near-term calendar (7d)");
    for (const event of calendarEvents) {
      const title = event.title.trim().length === 0 ? "(untitled)" : event.title.trim();
      out.push(`- ${event.date} — ${title}`);
    }
    out.push("");
  }
}

function appendPreparationTimelineSection(
  out: string[],
  travel: ReadonlyArray<RoadmapSkeletonTravelBooking>,
  calendarEvents: ReadonlyArray<RoadmapSkeletonCalendarEvent>,
): void {
  out.push("## Preparation Timeline");
  if (travel.length === 0 && calendarEvents.length === 0) {
    out.push("_(Not yet configured — no upcoming travel_bookings and no calendar events in the next 7 days.)_");
    out.push("");
    return;
  }
  if (travel.length > 0) {
    out.push("### Travel");
    for (const row of travel) {
      const dest = row.destination?.trim().length ? row.destination.trim() : "(destination tbd)";
      const span = formatTravelSpan(row.startDate, row.endDate);
      const statusSuffix =
        row.status && row.status !== "upcoming" ? ` [${row.status}]` : "";
      out.push(`- ${span} — ${row.type}: ${dest}${statusSuffix}`);
    }
    out.push("");
  }
  if (calendarEvents.length > 0) {
    out.push("### Calendar (7d)");
    for (const event of calendarEvents) {
      const title = event.title.trim().length === 0 ? "(untitled)" : event.title.trim();
      out.push(`- ${event.date} — ${title}`);
    }
    out.push("");
  }
}

function formatTravelSpan(
  startDate: string | null,
  endDate: string | null,
): string {
  if (startDate && endDate && startDate !== endDate) {
    return `${startDate} → ${endDate}`;
  }
  if (startDate) return startDate;
  if (endDate) return endDate;
  return "(dates tbd)";
}

// ── fs / SQL readers ───────────────────────────────────────────────────────

function readActiveProjects(contextDir: string): RoadmapSkeletonProject[] {
  const projectsDir = join(contextDir, PROJECTS_REL);
  if (!existsSync(projectsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const summaries: RoadmapSkeletonProject[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if (name.startsWith("_")) continue;
    const full = join(projectsDir, name);
    let body: string;
    try {
      body = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    const project = summarizeProject(name, body);
    if (project === null) continue;
    if (project.state === "archived") continue;
    summaries.push(project);
  }
  summaries.sort((a, b) => {
    const aDue = a.due ?? "9999-12-31";
    const bDue = b.due ?? "9999-12-31";
    if (aDue !== bDue) return aDue.localeCompare(bDue);
    return a.slug.localeCompare(b.slug);
  });
  return summaries;
}

function summarizeProject(filename: string, content: string): RoadmapSkeletonProject | null {
  const slug = filename.replace(/\.md$/, "");
  const { frontmatter, body } = splitFrontmatter(content);
  const state = readFrontmatterScalar(frontmatter, "state") ?? "active";
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug;
  return {
    slug,
    title,
    state,
    due: readFrontmatterScalar(frontmatter, "due"),
    nextMilestone: readFrontmatterScalar(frontmatter, "next_milestone"),
  };
}

function readAnnualGoals(contextDir: string): string[] {
  const path = join(contextDir, MANAGEMENT_RULES_REL);
  if (!existsSync(path)) return [];
  let body: string;
  try {
    body = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  return extractAnnualGoals(body);
}

/**
 * Pull bullet entries under the first `## Annual Goals` heading. Stops
 * at the next `## ` heading or end-of-file. Bullets are returned with
 * the `- ` / `* ` marker stripped and surrounding whitespace trimmed.
 *
 * Exported for unit testing only.
 */
export function extractAnnualGoals(rulesBody: string): string[] {
  const lines = rulesBody.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  for (const raw of lines) {
    if (/^##\s+Annual Goals\b/i.test(raw)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^##\s+/.test(raw)) break;
    const bullet = raw.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet) {
      const text = bullet[1].trim();
      if (text.length > 0) out.push(text);
    }
  }
  return out;
}

function readUpcomingTravel(
  db: Database.Database,
  todayDateStr: string,
): RoadmapSkeletonTravelBooking[] {
  let rows: Array<{
    type: string;
    destination: string | null;
    start_date: string | null;
    end_date: string | null;
    status: string | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT type, destination, start_date, end_date, status
           FROM travel_bookings
          WHERE start_date IS NOT NULL
            AND start_date >= ?
            AND COALESCE(status, 'upcoming') != 'cancelled'
          ORDER BY start_date ASC, id ASC
          LIMIT 20`,
      )
      .all(todayDateStr) as typeof rows;
  } catch {
    // The table existed since v4.x but bench / first-launch installs may
    // not have it; treat the schema gap the same way a row count of 0
    // is treated — silent skip, skeleton renders the placeholder.
    return [];
  }
  return rows.map((r) => ({
    type: r.type,
    destination: r.destination,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
  }));
}

// ── shared frontmatter helpers ─────────────────────────────────────────────
//
// Re-implemented here (rather than imported from context-builder) so the
// morning-routine modules stay decoupled from the dispatcher's ContextBuilder
// — the only consumers of those helpers in context-builder are private to
// the file and not exported. Keeping this layer thin keeps the variant-
// collapse path self-contained.

function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    return { frontmatter: "", body: content };
  }
  const endIdx = content.indexOf("\n---", 4);
  if (endIdx < 0) {
    return { frontmatter: "", body: content };
  }
  return {
    frontmatter: content.slice(4, endIdx),
    body: content.slice(endIdx + 4).replace(/^\n+/, ""),
  };
}

function readFrontmatterScalar(frontmatter: string, key: string): string | null {
  if (!frontmatter) return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatter.match(new RegExp(`^${escapedKey}:\\s*(.+)$`, "m"));
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

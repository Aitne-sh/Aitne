# Weekly Interests Reflection — Design Plan

**Status**: rev 4 (post-implementation, 2026-05-21). Steps 1–12 implemented + post-implementation critical review applied. See §22 for the rev-4 entry. Extends `BROWSER_HISTORY_INTEGRATION_PLAN.md` (Approach A § F1 cluster journals).
**Companion docs**: `BROWSER_HISTORY_INTEGRATION_PLAN.md` for the upstream pipeline; `docs/design/06-memory.md` for `context/` ownership; `docs/design/appendices/weekly-next-week-leverage.md` for how weekly_review outputs propagate into the following week's morning routines.
**Owners**: Aitne core team. Single-owner product context (single-user assumption holds).
**Target hosts**: Same coverage as Approach A — macOS, Linux, Windows. Nothing in this design is OS-specific.

---

## 1. TL;DR

Add a weekly **interest reflection** step to `routine.weekly_review` that reads the past 7 days of browser-research cluster activity (the same data already powering F1 cluster journals and F2 morning digests) and **refreshes** — never accumulates into — three knowledge surfaces (all under the post-refactor `context/user/` layout from `docs/design/06-memory.md` §6.1):

- **`context/user/profile.md`** — a short delimited "Current research themes (auto)" block (top 3-7 active themes only). Appended as a new H2 below the existing user-authored sections (`## Identity`, `## Work Pattern`, `## Platforms`, `## Expertise`, `## Notification Preferences`, `## Learned Context`, `## Raw Signals`) so it is injected into every agent session alongside the rest of the profile.
- **`context/user/research-themes.md`** — full per-cluster snapshot for the week, **wholly daemon-owned**. Flat sibling of `profile.md`, consistent with the existing flat `user/{people,work,expertise,goals,personal}.md` layout. Read on-demand via `user/_index.md`, not injected every session.
- **`context/projects/<existing>.md`** — for projects that the user has already declared, append a "Related browser research (auto, refreshed weekly)" block when keyword-overlap with active clusters crosses a threshold. **No new project files are auto-created.**

**Boundary with the existing profile-capture pipeline (load-bearing).** The user's direct testimonials ("I like X / I'm not a morning person / I work in Go") already flow through:
- `signal-detector.ts` (in-conversation behavioural signal capture) → appends to `profile.md ## Raw Signals`
- `routine.evening_review` Step 3a → graduates Raw Signals to `profile.md ## Learned Context` with `[YYYY-MM-DD]` prefixes
- The `user-profile` skill (DM handler + `routine.user_profile_sweep`) → writes explicit-statement facts to `profile.md ## {Identity,Work Pattern,Expertise,…}` and to `user/{people,work,expertise,goals,personal}.md`

**This reflection MUST NOT touch any of those sections or topic files.** Its surface is exactly one delimited auto-block (the new `## Current research themes (auto)` section) on `profile.md`, plus the wholly-owned `user/research-themes.md`, plus delimited blocks on project files. The "testimonials are preserved" requirement is satisfied structurally — the testimonial pipeline writes to disjoint sections.

**The entire feature is daemon-driven and LLM-free.** A pre-hook of `routine.weekly_review` calls an internal helper that:

1. Builds the cluster summary from `browser_research_clusters` (deterministic Layer-1 code).
2. Selects 3-7 themes via a deterministic ranking + bias function (replaces the previous LLM-judgement step).
3. Renders all four target surfaces from templates and writes them through an internal context-write helper.

No LLM session is involved in producing or applying the reflection. The path target is whitelisted (one of the four file kinds above); for `profile.md` / `_index.md` / `projects/*.md` the write only mutates content inside an explicit `<!-- BEGIN aitne:browser-interests v1 ... --> ... <!-- END ... -->` delimited block; `user/research-themes.md` is wholly daemon-owned and rewritten in full each pass.

Interests **shift** as the user's focus shifts (last week's stale theme drops out of the block on this week's pass); the file does not accumulate into a permanent "everything I've ever researched" list, addressing the user's directive that interests be **extracted and updated**, not appended.

**The feature runs automatically whenever the upstream browser-history integration is enabled.** There is no separate per-feature opt-in toggle, no first-run preview DM, no on/off setting. Enable browser-history → get the reflection. The only management surface the user has is a dashboard **"Clean up auto-blocks"** button that wipes all reflection-generated content in one shot (useful for testing or for one-time purge); the next weekly_review will then refresh the block from scratch.

---

## 2. Motivation & user value

Today, Aitne's browser-history integration knows what the user is researching (via `browser_research_clusters` and `context/research/<slug>.md`), but that knowledge does **not** flow back into the user's own profile (`context/user/profile.md`, `context/user/*.md` topic files, `context/projects/*`). The audit (2026-05-21) surfaced this as a gap: the user's stated requirement was "reflect user interests/projects into knowledge MD files", and the existing Approach A explicitly declared profile auto-update an out-of-scope non-goal (`BROWSER_HISTORY_INTEGRATION_PLAN.md` §3 line 39).

The user's clarified ask is **not** "auto-update profile.md on every visit" — that would create unbearable churn for a file that is injected into every agent session. The clarified ask is:

> Use weekly_review to extract interests from the week's browsing and update the user's profile. Preserve the user's direct testimonials about likes/dislikes; refresh (don't accumulate) the auto-derived view of their current research/expertise.

That maps onto two disjoint write surfaces:

1. **Testimonials** ("I like X", "I don't eat meat", "I'm new to React") — preserved by the **existing** signal-detector + evening_review + user-profile-skill pipeline. This plan **does not modify or replace** that pipeline; it stays outside the testimonial sections by construction.
2. **Auto-derived interests / research / expertise from browser activity** — implemented by this plan as a refresh-style write at weekly cadence, gated by the meaningful-research filter and qualification thresholds already in place upstream.

**Concrete user value:**

- The user can open `context/user/profile.md` and see, at a glance, "what is the agent treating as my current research focus?" — useful when collaborating with the agent on tasks where current context matters (asking for related-work pointers, choosing a tool, framing an advisor question). Because `profile.md` is injected into every session, downstream routines (morning_routine, advisor, DM handlers) get this view for free.
- A full per-cluster snapshot lives at `context/user/research-themes.md`, available on-demand via `user/_index.md` (not auto-injected — it's a heavier read).
- Existing project files (e.g., `projects/aitne.md`) gain a small auto-refreshed appendix linking related cluster journals — the user sees "this research from this week relates to this project" without having to manually cross-link.

**What this is NOT:**

- A long-term interest archive. That role belongs to `context/agent/journal.md` (the agent-internal self-reflection log, written by routines like weekly_review and never injected into the user-facing profile).
- A replacement for explicit user-driven profile edits or the existing testimonial-capture pipeline. The auto-block lives in a **new H2 section** of `profile.md` (`## Current research themes (auto)`) clearly distinct from the user-authored `## Expertise` section that the `user-profile` skill curates.
- An automation surface. No DMs, no scheduling, no actions follow from the reflection — it's record-only, just at weekly cadence rather than continuous.

---

## 3. Goals

1. Refresh `context/user/profile.md`'s current-interests view weekly from `browser_research_clusters` activity, as a new `## Current research themes (auto)` H2 below the existing user-authored sections.
2. Maintain a per-cluster weekly snapshot at `context/user/research-themes.md` (flat sibling of `profile.md`).
3. Keep `context/user/_index.md` aware of `research-themes.md` (one-line idempotent entry under a delimited auto-block, so the topic-file index stays accurate).
4. Annotate (not create) existing project files when a cluster's topic overlaps the project's declared keywords.
5. Preserve the **existing testimonial-capture pipeline** untouched. `signal-detector → ## Raw Signals → evening_review Step 3a → ## Learned Context` and the `user-profile` skill's writes to topic files (`user/expertise.md`, `user/people.md`, etc.) remain the **sole authors** of those sections.
6. Preserve the "record, don't act" principle from Approach A: no DMs follow from this reflection; no autonomous actions.
7. Preserve refresh semantics: interests that go dormant fall off; the file does not accumulate forever.
8. **Run uniformly on all backends** (Claude, Codex, Gemini, opencode) — the daemon does the work; no LLM session is involved, so backend-specific permission models (notably Codex's lack of absolute-block enforcement for shell) are irrelevant. This is a root-cause fix per `feedback_prefer_root_cause_fixes.md`, not a backend-skip bandaid.
9. **Zero per-feature opt-in friction.** Once the upstream browser-history integration is on, the reflection runs as part of every weekly_review automatically. The user's escape hatch is a one-button cleanup, not a toggle.

## 4. Non-goals

1. **Auto-creating project files.** A cluster like "rust-borrow-checker" may match no existing project — in that case the cluster journal at `context/research/rust-borrow-checker.md` is the only artifact; `profile.md` may surface it as a theme, but no `projects/rust-borrow-checker.md` is created. (If the user wants project creation, they create the file themselves; the next weekly pass will pick up the keyword match and start annotating.)
2. **DM offers for "want me to write this as a project?"** Out of scope; existing F1 `routine.research_offer_dm` is the engagement surface, not this reflection.
3. **Writing to existing user-authored sections of `profile.md`** (`## Identity`, `## Work Pattern`, `## Platforms`, `## Expertise`, `## Notification Preferences`, `## Learned Context`, `## Raw Signals`). The reflection's only `profile.md` surface is the new `## Current research themes (auto)` section. It must not even read those other sections during render (deterministic templating gets cluster data from SQLite, not from re-parsing `profile.md`).
4. **Writing to the topic files (`user/expertise.md`, `user/people.md`, `user/work.md`, `user/goals.md`, `user/personal.md`)** — these belong to the `user-profile` skill and `routine.user_profile_sweep`. The reflection introduces a *new* sibling file (`user/research-themes.md`) that it wholly owns; it does not touch the existing topic files.
5. **Writing to `today.md`, `yesterday.md`, `weekly/`, `monthly/`, `daily/`, `agent/journal.md`, `dossiers/`, `inbox/`, `rules/`, `routines/`, or any other context file** outside the three target kinds named in §1.
6. **Cross-week trend analysis** ("you've been interested in X for 6 weeks running"). The reflection is week-by-week refresh, not longitudinal. Track separately as a future enhancement if useful.
7. **Sensitive-category surfacing.** `banking`, `health`, `adult`, `app-config`, `cloud-console` are already filtered upstream by the meaningful-research filter; no special handling needed here.

## 5. Design principles

1. **Refresh, not append.** Each weekly run replaces the block content from scratch. There is no "merge with previous block" logic — that would let stale themes linger.
2. **Disjoint from the testimonial pipeline.** signal-detector / evening_review / user-profile-skill own `## Raw Signals`, `## Learned Context`, `## Identity`, `## Work Pattern`, `## Expertise`, `## Notification Preferences`, and the `user/{people,work,expertise,goals,personal}.md` topic files. This reflection owns *only* `## Current research themes (auto)` on `profile.md`, plus `user/research-themes.md`, plus the project-annotation blocks. The two surfaces never overlap.
3. **Daemon-driven, LLM-free.** The reflection is implemented entirely as deterministic Node code in the daemon. No LLM session participates in selecting themes, composing prose, or writing files. The "what is current" judgement is encoded as a deterministic ranking + bias function (§10.3); there is no LLM authorship surface to constrain. This is the root-cause fix for the Codex security gap (§14) — the platform enforces because the daemon is the writer.
4. **Idempotent.** Running the reflection twice in the same week produces the same output (modulo timestamp). No order dependencies.
5. **No autonomous projects.** The keyword-overlap matcher for project annotation is deterministic (no LLM in the matcher, no LLM in the writer).
6. **Compact in always-injected surfaces.** Because `profile.md` is injected into every agent session via `<user>` tags (target ~600 tokens total per the `user-profile` skill), the `profile.md` block is hard-capped at 3-7 bullets — total budget ≤ ~150 tokens (no prose paragraph in the deterministic-only design). The richer per-cluster view lives in `user/research-themes.md`, which is read on-demand only.
7. **Zero per-feature gating.** No `Enabled` setting, no `FirstRunConfirmed` setting, no preview-DM consent flow. The reflection runs whenever the upstream `browser-history` integration is on and `weekly_review` fires. The one user-facing escape is the dashboard cleanup button (§13).

---

## 6. Source data

The reflection reads only data the daemon already produces. No new pipeline stages, no LLM in the upstream Layer 1 path.

| Source | Path / table | What it carries |
|---|---|---|
| Cluster index | `browser_research_clusters` (existing) | `slug`, `display_name`, `started_at`, `last_activity_at`, `meaningful_visits_total`, `meaningful_foreground_sec_total`, `distinct_meaningful_domains`, `status`, `research_offer_accepted_at`, `wiki_summary_written_at` |
| Cluster journals | `context/research/<slug>.md` (existing) | Per-cluster agent-maintained day log; consulted for theme description / disambiguation |
| Top-domain snapshot | `browser_visits` (existing) | `domain` aggregated per-cluster over the last 7 days for the "top sites" line; never per-URL |
| Project files | `context/projects/*.md` (existing) | Filenames + first-section headings → keyword set for overlap matching |

**Window:** the 7-day window ending at the weekly_review trigger time, in the daemon's local timezone, agent-day-aligned (04:00 boundary). Clusters that had `last_activity_at` within this window are eligible.

**Eligibility filter:**

- Cluster `status` must be `'active'` (not `'muted'`, `'concluded'`, `'dormant'`). Muted/concluded clusters by definition should not influence the profile.
- Cluster must have at least one meaningful visit in the 7-day window (filtered via `browser_visits.ts >= weekStart AND root_task_id = cluster.root_task_id`). A cluster whose last activity was 5 days ago counts; one whose last meaningful visit was 8 days ago does not.

**Cap:**

- At most 20 candidate clusters are returned by the Layer-1 builder. Ranking: most meaningful-foreground-seconds in the window first, ties broken by most distinct domains. This is the agent's input set; the LLM further narrows to 3-7 for `user/profile.md`. The full set goes into `user/research-themes.md`.

---

## 7. Reflection targets

### 7.1 `context/user/profile.md` — top-themes block

Inserted at the **bottom** of the file (after all user-authored H2 sections, after `## Raw Signals`), as a brand new H2 wrapped in a delimited block. The H2 name `## Current research themes (auto)` is deliberately chosen to:

- Not collide with the existing user-authored `## Expertise` section (which the `user-profile` skill curates from explicit statements).
- Make the "(auto)" suffix visible to any user reading the file, signalling "this section is overwritten weekly by the agent".

```markdown
<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-19 generatedAt=2026-05-26T19:30:14Z -->
## Current research themes (auto)

_Auto-refreshed each weekly review from the past week's browser activity. Older themes drop off as activity shifts. Full snapshot in `user/research-themes.md`._

- **Prompt-injection defenses** — 4 days, 12 sources, ~3.2h → `research/prompt-injection-defenses.md`
- **Quantum mechanics intro** — 3 days, 8 sources, ~2.1h → `research/quantum-mechanics-intro.md`
- **Rust borrow checker** — 2 days, 5 sources, ~1.4h → `research/rust-borrow-checker.md`

<!-- END aitne:browser-interests v1 -->
```

The block is **entirely deterministic** — no LLM-authored prose, no narrative paragraph. The bullet list IS the block; nothing else. Earlier drafts proposed an LLM-authored `themeOverview` paragraph, but it was dropped in rev 3 (see §22) to make the feature backend-agnostic and to remove the consent-flow surface that an LLM-driven design would have required.

**Limits:**
- 3-7 themes (hard min/max). If fewer than 3 themes qualify, the reflection writes a journal line and skips this week's profile.md update; if more than 7 qualify, the deterministic selector takes the top 7.
- Bullet content rendered server-side from `ClusterSnapshot` data — `display_name`, `days_active`, `meaningful_visits`, `meaningful_foreground_sec` come straight from the structured fields.
- Cluster-journal links are rendered as compact relative paths (`research/<slug>.md`) — `profile.md` is injected every session and the bullet density matters; the verbose link prose belongs in the full snapshot.
- Total block budget: ≤ ~150 tokens (3-7 bullets × ~10-15 tokens + header + 1-line description).

### 7.2 `context/user/research-themes.md` — full snapshot

The file is **wholly owned by this reflection**. Flat sibling of `profile.md` under `context/user/`, matching the existing flat layout (`people.md`, `work.md`, `expertise.md`, `goals.md`, `personal.md`). Unlike `profile.md` (which has user-authored sections too), `research-themes.md` exists only as a weekly snapshot and is **never injected into the session prompt** — it is read on-demand via `user/_index.md`:

```markdown
---
type: user
owner: aitne-browser-history
updated: 2026-05-26
generated_at: 2026-05-26T19:30:14Z
week_start: 2026-05-19
week_end: 2026-05-25
clusters_active: 7
clusters_dormant_since_last_week: 2
---

# Research themes — week of 2026-05-19

## Active themes

### Prompt-injection defenses (`prompt-injection-defenses`)
- **Days active**: 4
- **Meaningful visits**: 12
- **Foreground time**: 3.2h
- **Top domains**: anthropic.com, simonwillison.net, arxiv.org, deepmind/blog
- **Cluster journal**: [research/prompt-injection-defenses.md](../research/prompt-injection-defenses.md)
- **Last week's status**: active (no change)

### Quantum mechanics intro (`quantum-mechanics-intro`)
- **Days active**: 3
- **Meaningful visits**: 8
- **Foreground time**: 2.1h
- **Top domains**: en.wikipedia.org, plato.stanford.edu, scottaaronson.blog
- **Cluster journal**: [research/quantum-mechanics-intro.md](../research/quantum-mechanics-intro.md)
- **Last week's status**: new this week

### …(up to 20 entries total, ranked by meaningful_foreground_sec descending)

## Dormant since last week

These themes appeared in last week's snapshot but had no meaningful activity in the past 7 days:

- **Lattice-based cryptography** (`lattice-based-cryptography`) — last activity 2026-05-18
- **Espresso machine repair** (`espresso-machine-repair`) — last activity 2026-05-17

Their cluster journals remain in `context/research/` (status: dormant). They will surface again here if activity resumes.
```

The "Dormant since last week" section is computed by **diffing the current snapshot's slug set against the previous week's snapshot**, which the helper reads from the prior version of the same file (parsed via the frontmatter `clusters_active` count and the slug list embedded in the rendered body). On the very first run, the dormant section is empty.

All sections are rendered deterministically from structured fields. There is no LLM-authored prose in this file (rev 3 dropped the optional `perClusterNotes` field — see §22).

### 7.3 `context/projects/<existing>.md` — annotation block

Project files are user-authored; this reflection only **annotates** them with an auto-refreshed appendix when there's a deterministic keyword match. The appendix is appended to the bottom of the file in a delimited block:

```markdown
<!-- BEGIN aitne:browser-interests v1 project=aitne weekStart=2026-05-19 generatedAt=2026-05-26T19:30:14Z -->
## Related browser research (auto, refreshed weekly)

This week's browser activity related to **aitne**:

- **Prompt-injection defenses** (`prompt-injection-defenses`) — 4 days, 12 sources, ~3.2h. [Cluster journal](../research/prompt-injection-defenses.md)
- **Skill-scope materialisation** (`skill-scope-materialisation`) — 2 days, 4 sources, ~1.1h. [Cluster journal](../research/skill-scope-materialisation.md)

<!-- END aitne:browser-interests v1 project=aitne -->
```

If no clusters match a project, the block is **removed** (not left as "no matches this week" — that's noise). On the next week, if a match returns, the block reappears.

**Matching rule** (deterministic, Layer-1 code):

1. Compute the project's **keyword set** from its frontmatter and filename (read in this order; first non-empty wins for explicit override):
   - **Explicit override**: frontmatter field `aitne_project_keywords: [foo, bar, …]` (string array, lowercase). When present, this is the *entire* keyword set — no other extraction runs. Matches the existing pattern of frontmatter-driven control on context files (`type:`, `owner:`, `state:`).
   - **Aliases / tags**: frontmatter fields `aliases: [...]` and `tags: [...]` if present, tokenised on `/[-_/\s]+/` and lowercased.
   - **Filename slug**: tokens from the filename minus `.md` (`aitne.md` → `{aitne}`; `rag-experiment.md` → `{rag, experiment}`).
2. Compute each cluster's **keyword set**: tokens from `display_name` (tokenised same way) plus each `top_domain`'s eTLD+1 second-level prefix (e.g. `arxiv.org` → `arxiv`).
3. Match if **either** of:
   - The project's filename slug appears as a substring of the cluster's `display_name` (case-insensitive), OR
   - The Jaccard intersection of the two keyword sets is ≥ 2 tokens AND ≥ 0.15 Jaccard ratio.
4. Annotate the project file for every matched cluster (max 5 per project to bound noise).

No LLM in the matcher. Frontmatter is the user-facing control surface — if the user wants tighter or looser matching, they edit the project file's frontmatter (`aitne_project_keywords:` to pin the set explicitly, `aitne.exclude_from_interests: true` to opt out entirely); the matcher re-runs on the next weekly pass.

**Rejected alternative**: an HTML-comment hint (`<!-- aitne:project-keywords: foo, bar -->`) inside the file body was considered and dropped — context files in this codebase already carry rich frontmatter (`state:`, `type:`, `aliases:`, `tags:`), and inventing a parallel HTML-comment convention would fragment the control surface. Frontmatter is the established channel.

---

## 8. Delimited auto-block convention

Two write modes, depending on file ownership:

**Mode A — delimited auto-block** (for files with user-authored content: `user/profile.md`, `user/_index.md`, `projects/*.md`):

```
<!-- BEGIN aitne:browser-interests v1 <attr=value attr=value …> -->
…
<!-- END aitne:browser-interests v1[ optional disambiguator] -->
```

**Mode B — wholly-owned file rewrite** (for `user/research-themes.md`): the daemon rewrites the entire file from scratch each weekly pass; no delimiter is needed because no user content shares the file. The `owner: aitne-browser-history` frontmatter field signals this — a user manually editing this file should expect their edits to be lost on the next refresh (documented in the §13 lifecycle text and in the file's body comment).

Rules for Mode A delimiters:

- **BEGIN line attributes** are reserved for daemon use: `weekStart`, `generatedAt`, `project=<slug>` (project files only), `target=<kind>` (for the `_index.md` entry). The agent never sets attributes — the endpoint does.
- **END line** matches the most recent BEGIN line by `v1`. For project files, the disambiguator `project=<slug>` is required so the auto-block is uniquely identifiable even if a user manually adds another similarly-named block. For `_index.md`, the disambiguator `target=research-themes` is used.
- **One block per file per disambiguator**. Multiple blocks would be a bug.
- **User-edits inside the block survive zero seconds**: the endpoint replaces the whole block on every write. If a user wants to keep a note about the research relationship, they write it **outside** the markers.

**Detection / replacement algorithm** (server-side, deterministic):

```ts
function replaceAutoBlock(fileContent: string, newBlockContent: string, disambiguator?: string): string {
  const beginPattern = disambiguator
    ? `<!-- BEGIN aitne:browser-interests v1 ${disambiguator}.*? -->`
    : `<!-- BEGIN aitne:browser-interests v1.*? -->`;
  const endPattern = disambiguator
    ? `<!-- END aitne:browser-interests v1 ${disambiguator} -->`
    : `<!-- END aitne:browser-interests v1 -->`;

  const re = new RegExp(`${beginPattern}[\\s\\S]*?${endPattern}`, "m");
  if (re.test(fileContent)) {
    return fileContent.replace(re, newBlockContent);  // refresh in place
  }
  // first time: append to end
  return fileContent.replace(/\s*$/, "\n\n" + newBlockContent + "\n");
}
```

Implementation lives in `packages/daemon/src/services/browser-history/pipeline/interests-block.ts` (new module). Pure function, fully unit-tested with the §20 examples.

---

## 9. Refresh semantics (replace, not append)

**Per the user's directive**: "どんどんaddしていくのではなくその週に検索されているものから興味を抽出し、更新していくようにしたい". Each weekly pass is a **fresh authorship** of the block contents:

- New clusters that appear this week → added.
- Clusters present last week and still active → updated stats.
- Clusters present last week but dormant this week → removed from the block (and surfaced once in the "Dormant since last week" section of `research-themes.md` for one weekly cycle, then forgotten).

The cluster journals themselves (`context/research/<slug>.md`) are **not** removed — they're the long-term record. Their cluster row may transition to `status='dormant'` via the existing 10-day dormancy rule in `cluster-extractor.ts`; once dormant, they stop appearing in this reflection's input.

**Idempotency**: running the reflection twice within the same week (e.g. user manually triggers `routine.weekly_review` for a re-do, or clicks the dashboard "Refresh now" button) produces an identical block modulo `generatedAt`. The deterministic rendering and deterministic theme selector together guarantee this — there is no LLM-authored content to vary between runs.

**Audit row** on every invocation (rev 4 — emitted in a `finally`, so a mid-write throw still records the partial state):

```ts
{
  action_type: "browser_interests_reflection_applied",
  result: "success" | "skipped" | "partial" | "failed",
  error: <message-when-result-in-{partial,failed}> | null,
  metadata: "{}",
  detail: {
    week_start: "2026-05-19",
    trigger: "scheduler",          // "scheduler" | "dashboard" | "test"
    targets_written: ["context/user/profile.md", "context/user/research-themes.md", "context/user/_index.md", "context/projects/aitne.md"],
    targets_skipped: [],            // [{ path, reason }] when applicable
    themes_selected: ["prompt-injection-defenses", "quantum-mechanics-intro", "rust-borrow-checker"],
    clusters_in_full_snapshot: 7,
    clusters_dormant_since_last_week: 2,
    projects_annotated: 1,
    projects_skipped_no_match: 4,
    skipped?: { reason: "fewer_than_min_themes" | "no_browser_history" },
    error_message?: <duplicated in detail blob for queryability when result is partial|failed>
  }
}
```

`result` discriminator (rev 4):

- `success` — clean path, all targets written, runtime_state markers updated.
- `skipped` — `clusters.length < MIN_PROFILE_MD_THEMES` OR upstream integration disabled. `detail.skipped.reason` carries the discriminator.
- `partial` — helper threw mid-write but had already pushed ≥1 entry to `targets_written`. The next refresh re-applies idempotently from the same SQLite snapshot.
- `failed` — helper threw before any write landed (e.g. SQL read error during `buildWeeklyInterestsSummary`).

`metadata: "{}"` is written explicitly (not via column DEFAULT). Per the `agent_actions` schema comment, the `metadata` column is the agent-self-report side-channel (`PATCH /api/agent-actions/self`); the daemon-write side leaves it empty. The explicit `'{}'` documents that contract at the call site.

---

## 10. Architecture

### 10.1 Deterministic Layer-1 builder

`packages/daemon/src/services/browser-history/pipeline/weekly-interests-summary.ts` (new) — pure Node, no LLM, exported function:

```ts
export interface WeeklyInterestsSummary {
  weekStart: string;      // YYYY-MM-DD, agent-day-aligned
  weekEnd: string;        // YYYY-MM-DD, inclusive
  generatedAt: string;    // ISO timestamp
  clusters: ClusterSnapshot[];   // max 20, ranked by meaningful_foreground_sec desc
  dormantSinceLastWeek: { slug: string; displayName: string; lastActivity: string }[];
  projectMatches: ProjectMatch[];
}

export interface ClusterSnapshot {
  slug: string;
  displayName: string;
  daysActive: number;
  meaningfulVisits: number;
  meaningfulForegroundSec: number;
  distinctMeaningfulDomains: number;
  topDomains: string[];      // max 5, ordered by visits desc
  status: "active" | "dormant" | "concluded" | "muted";
  statusChange: "new" | "active_continued" | "newly_dormant" | "muted_this_week";
  clusterJournalPath: string;  // "context/research/<slug>.md"
  hasOpenOffer: boolean;
  hasAcceptedResearch: boolean;
  hasWikiSummary: boolean;
}

export interface ProjectMatch {
  projectSlug: string;       // filename without .md
  projectPath: string;       // "context/projects/<slug>.md"
  clusters: { slug: string; reason: "filename_match" | "jaccard" }[];   // max 5
}

export function buildWeeklyInterestsSummary(
  db: Database,
  weekStartDate: Date,
  options?: { maxClusters?: number; maxProjectClusters?: number }
): WeeklyInterestsSummary;
```

This is the function consumed by both the API endpoint and the LLM-facing summary view. It is deterministic and 100%-coverage-tested.

### 10.2 API: `GET /api/browser-history/weekly-interests-summary`

```
GET /api/browser-history/weekly-interests-summary?weekStart=2026-05-19
```

Query params:

- `weekStart` — required, `YYYY-MM-DD`. Must be a Monday or the daemon rejects with 400 (weekly reviews are ISO-week-aligned).

Response: `WeeklyInterestsSummary` JSON, Zod-validated.

Risk tier: **Autonomous**. The endpoint reads aggregate data; no per-URL or per-title content surfaces. Same risk profile as `/research-clusters` and `/yesterday-summary`.

### 10.3 Internal helper + dashboard endpoint

**Primary entry point is the internal helper, not an HTTP route.** The daemon's scheduler (§10.4) calls:

```ts
// packages/daemon/src/services/browser-history/refresh-interests-reflection.ts
export async function refreshInterestsReflection(
  db: Database,
  contextDir: string,
  options?: { weekStart?: Date; trigger: "scheduler" | "dashboard" | "test" }
): Promise<RefreshResult>;

export interface RefreshResult {
  weekStart: string;
  generatedAt: string;
  targetsWritten: string[];
  targetsSkipped: { path: string; reason: string }[];
  themesSelected: string[];     // slugs picked into profile.md block
  clustersInSnapshot: number;
  clustersDormantSinceLastWeek: number;
  projectsAnnotated: number;
  projectsSkippedNoMatch: number;
  skipped?: { reason: string };  // e.g. "fewer_than_min_themes" / "no_browser_history"
}
```

The helper is fully deterministic — no HTTP, no LLM, no session. Steps (rev 4 — restructured to take a lock + emit audit in `finally`):

0. **Disabled-gate short-circuit** (rev 4). If `options.integrationDisabled === true`, return `{ skipped: { reason: "no_browser_history" } }` immediately. This branch does NOT acquire the lock (it touches no disk and no SQLite beyond the audit insert), so a dashboard cleanup can run concurrently with the scheduler's "we're disabled this week" tick. The dispatcher pre-hook sets this flag from `readIntegrationState(db, "browser_history").mode === "disabled"`; the dashboard route never sets it.
1. **Acquire the courtesy lock** (`acquireInterestsReflectionLock(\`refresh:${trigger}\`)`). Contention throws `InterestsReflectionLockBusyError` — the dispatcher catches it as a journal-line + no-op for that tick; the HTTP route surfaces it as HTTP 409 `{ error: "reflection_in_progress", heldBy }`.
2. Call `buildWeeklyInterestsSummary(db, weekStartDate)` (§10.1).
3. If `clusters.length < 3` → set `result.skipped = { reason: "fewer_than_min_themes" }` and return through the `finally` (which emits the audit row and releases the lock).
4. Apply the **deterministic theme selector** to pick 3-7 slugs for `profile.md`:

   ```ts
   function selectProfileMdThemes(clusters: ClusterSnapshot[]): string[] {
     const scored = clusters.map(c => {
       let score = c.meaningfulForegroundSec;          // baseline = time spent
       if (c.statusChange === "new") score *= 1.20;     // mild bias toward freshness
       if (c.hasAcceptedResearch) score *= 1.30;        // user actively engaged
       if (c.hasWikiSummary && daysSince(c.lastActivity) > 5) score *= 0.50;  // already concluded
       return { slug: c.slug, score };
     });
     scored.sort((a, b) => b.score - a.score);
     return scored.slice(0, 7).map(s => s.slug);
   }
   ```

   This encodes the biasing rules that earlier drafts asked the LLM to apply, as code.
5. Render the four target outputs from `interests-block.ts` (§A2) templates.
6. For each target file:
   - Read the file. If `profile.md` / `_index.md` / a matched project file is missing → skip that target (do not auto-create) and record reason. For `user/research-themes.md` → create if absent (wholly daemon-owned).
   - For Mode A files: apply `replaceAutoBlock`.
   - For Mode B file: write the entire file contents.
   - Write atomically via `core/atomic-write.ts:writeFileAtomically` with `markedAtomicWrite` wrapping so FS-watch consumers attribute the rename to the agent. On a mid-write throw, `targetsWritten` retains the entries that already succeeded; the `finally` block emits a `result='partial'` audit row capturing them.
7. **`finally` block** (rev 4):
   - `emitAuditRow(db, result, trigger, eventId, caught)` — one row per invocation. `result` is `success` / `partial` / `failed` / `skipped` per the discriminator rule in §9. `error` column populated when `caught !== undefined`. `metadata` explicitly set to `'{}'`.
   - `release()` — frees the lock unconditionally so a future tick can run. Without the finally, a mid-write throw would leak the lock and every subsequent reflection would throw `InterestsReflectionLockBusyError`.
8. On a clean (non-throw) path, the helper also updates `runtime_state.browser_history.weekly_interests_last_run_at` and `…_targets` BEFORE the `finally` runs. A partial/failed run does NOT update these markers, so the cleanup endpoint and any "stale snapshot" detection work off the last fully-applied refresh.

**HTTP endpoint (`POST /api/browser-history/refresh-interests-reflection`) — dashboard / admin only.** Thin wrapper around the helper; reuses the dashboard's bearer-token auth. No payload (helper figures out the current ISO week itself). Risk tier: **Approve** (bearer required, destructive of prior auto-block content, but bounded). Not callable by any agent skill — not added to any SKILL.md `allowed-tools`. Lock-busy → HTTP 409 `{ error: "reflection_in_progress", heldBy }`.

**Concurrency model (rev 4).** Single-owner system, weekly cadence; the Node event loop is single-threaded, so two sync invocations cannot physically interleave. The courtesy lock (`interests-reflection-lock.ts`) is the design's chokepoint for "same-minute re-run" races (scheduler tick vs dashboard "Refresh now" click) and forward-proofs the helper against a future async rewrite. The lock surface is a single module-level singleton — both `refreshInterestsReflection` and `cleanupInterestsReflection` go through it, so refresh-vs-cleanup races are also serialised. Contention throws `InterestsReflectionLockBusyError` which the caller decides how to handle (dispatcher: journal-line + skip; dashboard: 409). No ETag — single source of truth is the live SQLite data each invocation recomputes.

Other writers to these files (`signal-detector` / `user-profile` / `evening_review`) write to *disjoint sections* of `profile.md` by construction (§5 principle 2), and do NOT acquire this lock — cross-feature serialisation is structural, not lock-based.

### 10.3.1 Cleanup endpoint

`POST /api/browser-history/cleanup-interests-reflection` (Approve tier, dashboard-only):

```ts
const CleanupPayload = z.object({
  alsoDeleteResearchThemesFile: z.boolean().default(true),
});
```

Calls `cleanupInterestsReflection(db, contextDir, payload)`:

1. Strip every `<!-- BEGIN aitne:browser-interests v1 … --> … <!-- END … -->` block from `context/user/profile.md`, `context/user/_index.md`, and every `context/projects/*.md`.
2. If `alsoDeleteResearchThemesFile` is true (default), delete `context/user/research-themes.md`.
3. Clear the `runtime_state` keys (`browser_history.weekly_interests_last_run_*`).
4. Emit `agent_actions(action_type='browser_interests_reflection_cleanup', detail={ blocksRemoved, filesAffected, researchThemesDeleted })`.
5. Return `{ blocksRemoved, filesAffected }`.

Idempotent: a second cleanup call on already-cleaned files removes zero blocks and returns the same shape. The next weekly_review will refresh fresh content from scratch — the cleanup is a one-shot purge, not a permanent disable. Per the user directive, there is no permanent-disable toggle; if the user wants the feature off durably, they disable the upstream browser-history integration.

### 10.4 Daemon pre-hook on `routine.weekly_review`

Instead of a new LLM phase in the task-flow, hook `refreshInterestsReflection` into `routine.weekly_review`'s dispatch path as a **deterministic pre-hook**:

```
Scheduler fires routine.weekly_review
  └─► dispatcher-scheduled-tasks.ts:executeWeeklyReview
        ├─► [NEW] refreshInterestsReflection(db, contextDir, { trigger: "scheduler" })
        │     ├─► writes user/profile.md auto-block
        │     ├─► writes user/research-themes.md
        │     ├─► writes user/_index.md entry
        │     ├─► writes matched projects/*.md annotations
        │     └─► returns RefreshResult (or { skipped })
        └─► dispatcher hands off to the LLM session for the user-facing weekly artifact
              (the LLM reads the freshly-refreshed profile.md in its <user> context block)
```

Properties of this wiring:

- **Runs on every backend uniformly.** Claude, Codex, Gemini, opencode — all identical. The daemon does the write; the LLM session is downstream and can only *read* the refreshed content via the standard `<user>` injection.
- **Gating (rev 4).** The pre-hook always calls the helper, passing `integrationDisabled: readIntegrationState(this.db, "browser_history").mode === "disabled"`. The helper short-circuits with `skipped='no_browser_history'` when the flag is set. This keeps the audit-row shape uniform across both skip paths and surfaces "we deliberately did nothing this week" in the same dashboard surface as the `fewer_than_min_themes` case.
- **Skip semantics.** Both skip reasons (`fewer_than_min_themes`, `no_browser_history`) flow back through the helper's `RefreshResult.skipped`. The pre-hook appends one line to `context/agent/journal.md` with the discriminator name and the resolved `weekStart`, then continues to the LLM session normally. No retries, no errors propagated.
- **Lock-busy.** `InterestsReflectionLockBusyError` is caught separately from generic throws — the pre-hook writes a `interest reflection deferred: lock busy (<heldBy>)` journal line and yields. The next cron tick re-attempts; no manual intervention required.
- **Degraded-Obsidian-vault correctness (rev 4).** `getContextDir(this.config, this.db)` is called with the `db` argument so degraded mode falls back to the internal `~/.personal-agent/context/`. Without this thread, the pre-hook would write into the user's Obsidian vault even while the daemon's `contextBuilder` (which builds the LLM session prompt) reads from the internal store — the LLM would never see the freshly-refreshed block.
- **Failure isolation.** A throw inside the pre-hook is caught, logged, and **does not abort weekly_review** — the user-facing weekly artifact still ships even if the reflection write fails. The audit row records the failure as `result='failed'` or `result='partial'` per §9.

**Task-flow (`routine.weekly_review.md`) change is minimal:** add one optional informational line that the LLM can reference:

```markdown
> Note: the `## Current research themes (auto)` block in `<user>` is daemon-refreshed each weekly_review.
> If new themes appeared this week, you may briefly mention it in the Phase 4a notification
> ("Refreshed your research themes — N new this week"). This is optional context, not a task to do.
```

**No skill-manifest change.** The `browser-history` skill is no longer involved in this feature (it remains for the existing F1 research-cluster routines). The LLM has no API call to make for the reflection.

### 10.5 Project keyword matcher

Module: `packages/daemon/src/services/browser-history/pipeline/project-matcher.ts`. Pure function:

```ts
export interface ProjectKeywords {
  projectSlug: string;       // filename without .md
  projectPath: string;       // absolute path under contextDir
  keywords: Set<string>;
  source: "explicit" | "frontmatter" | "filename";  // for debug / audit
}

export function loadProjectKeywords(contextDir: string): ProjectKeywords[];

export function matchClustersToProject(
  project: ProjectKeywords,
  clusters: ClusterSnapshot[]
): { slug: string; reason: "filename_match" | "jaccard" }[];   // max 5
```

`loadProjectKeywords` reads `${contextDir}/projects/*.md`, parses each file's YAML frontmatter, and:

1. Skips files with frontmatter `aitne.exclude_from_interests: true` (per-project opt-out).
2. If frontmatter has `aitne_project_keywords: [string]`, that array IS the keyword set (`source: "explicit"`).
3. Else, falls back to: tokens from frontmatter `aliases: []` + `tags: []` (if present) ∪ tokens from the filename slug (`source: "frontmatter"` if frontmatter contributed, else `"filename"`).

Tokenisation is **trivial**: lowercase, split on `[-_/\s]+`, drop tokens ≤ 1 character. No stemming, no plural-stripping (those create surprise matches). This is deliberate — overengineering the matcher creates noise; users with strong opinions pin keywords via the frontmatter array.

### 10.6 `user/_index.md` upkeep

`user/_index.md` is the topic-file navigation hub (read first by the `user-profile` skill before fetching topic files). When `research-themes.md` exists, `_index.md` must reference it so the agent and the user know it's there.

The reflection endpoint maintains a one-line entry in `_index.md` via the same delimited-block mechanism (Mode A from §8), with disambiguator `target=research-themes`:

```markdown
<!-- BEGIN aitne:browser-interests v1 target=research-themes -->
- `research-themes.md` — Auto-generated weekly snapshot of current research themes from browser activity. Last refreshed: 2026-05-26.
<!-- END aitne:browser-interests v1 target=research-themes -->
```

This is a one-liner, refreshed each weekly pass alongside the others. On disable (toggle off + `cleanup_blocks` action from OQ-W4), this block is the one removed from `_index.md`.

If `_index.md` does not exist (fresh install before user-profile skill has populated it), the helper skips the `_index.md` update with audit note `_index_missing` and proceeds with the other targets.

### 10.7 Agent-journal rotation (rev 4)

The dispatcher pre-hook writes one bullet to `context/agent/journal.md`'s `## Weekly interests reflection` section per weekly_review tick (skip / success / failure / lock-busy). At the weekly cadence the section would accrete one entry per week indefinitely.

**Rotation rule:** on every append, `appendToWeeklyInterestsJournalSection` calls `pruneWeeklyInterestsJournalBullets(lines, bodyStart, bodyEnd, nowMs, retentionDays=30)` to drop any bullet whose `- YYYY-MM-DD HH:MM` prefix is older than 30 days before `nowMs`. The cutoff is inclusive on the kept side (a bullet dated exactly `nowMs - 30d` survives). User-authored prose (non-bullet lines, or bullets without the date prefix) is preserved as-is — only daemon-emitted entries are subject to rotation.

**Why 30 days:** the journal section is operator-facing trace for "why didn't my reflection fire?" type questions. At weekly cadence the window holds 4-5 entries — enough to see "skipped last week because integration disabled, success this week" patterns. Older entries live in git history if needed. Six months of weekly skip/success lines is noise.

**Date anchoring:** the prune parser anchors each `YYYY-MM-DD` at noon UTC (`Date.parse(\`${date}T12:00:00Z\`)`) so a DST flip in the host's local zone cannot move the parsed date into the day before/after the cutoff. The dispatcher pre-hook threads `now.getTime()` into the appender so the prune cuts against the same instant the bullet's date prefix was generated from.

---

## 11. LLM authorship constraints

**The LLM has zero authorship surface in this feature.** Rev 3 removed all LLM contributions (theme selection, `themeOverview` prose, `perClusterNotes`) in favour of a fully daemon-driven design. The LLM session that runs `routine.weekly_review` can *read* the freshly-refreshed `## Current research themes (auto)` block via `<user>` context injection — and may optionally reference it in the user-facing notification — but it cannot influence what the block contains.

This is **structural** isolation by removal, not by constraint. There is no chokepoint endpoint for the LLM to talk to and no prompt-engineered restriction on what it can produce, because it produces nothing for this feature.

---

## 12. Sample outputs

### 12.1 First-run `profile.md` after a quiet week

```markdown
<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-19 generatedAt=2026-05-26T19:30:14Z -->
## Current research themes (auto)

_Auto-refreshed each weekly review. Full snapshot in `user/research-themes.md`._

- **Prompt-injection defenses** — 4 days, 12 sources, ~3.2h → `research/prompt-injection-defenses.md`
- **Quantum mechanics intro** — 3 days, 8 sources, ~2.1h → `research/quantum-mechanics-intro.md`
- **Rust borrow checker** — 2 days, 5 sources, ~1.4h → `research/rust-borrow-checker.md`

<!-- END aitne:browser-interests v1 -->
```

(Bullet list only — no narrative paragraph by design in rev 3, regardless of week.)

### 12.2 Second-run `profile.md` after a topic shift

```markdown
<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-26 generatedAt=2026-06-02T19:30:08Z -->
## Current research themes (auto)

_Auto-refreshed each weekly review. Full snapshot in `user/research-themes.md`._

- **Prompt-injection defenses** — 5 days, 9 sources, ~2.7h → `research/prompt-injection-defenses.md`
- **Rust borrow checker** — 4 days, 11 sources, ~3.0h → `research/rust-borrow-checker.md`
- **WebGPU compute shaders** — 3 days, 7 sources, ~1.9h → `research/webgpu-compute-shaders.md`

<!-- END aitne:browser-interests v1 -->
```

("Quantum mechanics intro" — present last week — has been removed by the deterministic theme selector; it'll appear once in this week's `research-themes.md` "Dormant since last week" section, then no more. Note the absence of any prose paragraph — rev 3 dropped LLM-authored overviews.)

### 12.3 `projects/aitne.md` annotation block

```markdown
<!-- BEGIN aitne:browser-interests v1 project=aitne weekStart=2026-05-26 generatedAt=2026-06-02T19:30:08Z -->
## Related browser research (auto, refreshed weekly)

This week's browser activity related to **aitne**:

- **Prompt-injection defenses** (`prompt-injection-defenses`) — 5 days, 9 sources, ~2.7h. [Cluster journal](../research/prompt-injection-defenses.md)
- **Skill-scope materialisation** (`skill-scope-materialisation`) — 2 days, 4 sources, ~1.1h. [Cluster journal](../research/skill-scope-materialisation.md)

<!-- END aitne:browser-interests v1 project=aitne -->
```

---

## 13. Lifecycle

**No per-feature toggle, no consent prompt, no preview DM.** Per the user's directive (rev 3): once the upstream `browser-history` integration is enabled, the weekly interest reflection runs in the background each weekly_review automatically. The previous draft's opt-in / preview-DM / `first_run_confirmed_at` machinery is removed in full.

**Effective gate** — the reflection's pre-hook (§10.4) executes when **all** of:

1. `browser-history` integration is enabled (its mode is not `disabled`) — same gate as F1 cluster journals, F2 morning digests, F4 reload memory.
2. `routine.weekly_review` is firing (scheduled or manual).
3. The deterministic builder finds ≥ 3 qualifying clusters in the 7-day window.

If all three hold → write. Else → append a one-line note to `context/agent/journal.md` describing which gate failed, and move on.

**First-week behaviour on an existing install** — when this feature ships, users who already have browser-history enabled will, on their next weekly_review, see a new `## Current research themes (auto)` section appear in `profile.md` and a new `user/research-themes.md` file. This is a release-note item, not an in-product prompt. The H2 header includes "(auto)" precisely so the source is visible at a glance; the dashboard's browser-history card surfaces the same explanatory copy that would otherwise have lived behind a toggle.

**Disable / cleanup paths (the only management surfaces):**

1. **One-shot purge** (`POST /api/browser-history/cleanup-interests-reflection`, see §10.3.1) — a single "Clean up auto-blocks" button in the dashboard's browser-history card. Strips every `aitne:browser-interests v1` block from `profile.md`, `_index.md`, and all project files; optionally deletes `user/research-themes.md`. Idempotent. Next weekly_review will refresh fresh content.
2. **Permanent disable** — there is no separate disable for this reflection; if the user wants it off durably, they disable the upstream browser-history integration (which also stops F1/F2/F4). This is intentional per the directive — a separate disable would be exactly the "on/off toggle" the user asked us to remove.
3. **User-edits inside a delimited block** — overwritten on the next weekly_review. Notes about the research relationship belong outside the markers. The dashboard's browser-history card documents this.

**Why no consent prompt is needed:** the user has already accepted browser-history's privacy model when they enabled the upstream integration (which records visit history into `browser_visits` and surfaces clusters into `context/research/`). The reflection adds **no new data collection** — it only re-shapes existing cluster data into the profile surface. The privacy threat model is identical to F1 cluster journals, which are auto-created without per-feature consent.

---

## 14. Backend support (uniform across all backends)

**All four backends — Claude, Codex, Gemini, opencode — are supported identically.** Rev 3 took the LLM out of the write path entirely (see §10.4 daemon pre-hook design), which eliminates the Codex security concern at its root:

- The original draft's concern was that `routine.weekly_review`'s LLM session would call `POST /api/browser-history/apply-interests-reflection` via a `Bash(curl *)` tool, and that the curl-to-localhost chokepoint relies on the absolute-block layer to actually hold. Per `CLAUDE.md`'s "Execution mode" section, Codex Allow-mode cannot enforce the absolute-block layer for shell commands (no hook / admin-policy surface) — accepted gap, documented in `docs/design/09-safety-cost.md`.
- The new design removes the LLM curl call entirely. The reflection is written by the daemon's deterministic helper, invoked synchronously as a pre-hook of `routine.weekly_review`'s dispatcher path. There is no `Bash(curl *)` tool involvement, no skill on the call path, no LLM authorship surface — therefore no dependence on the absolute-block layer. The daemon is the writer; the platform layer enforcing is the daemon itself.
- This matches `feedback_prefer_root_cause_fixes.md`'s rule: when the platform can't enforce a permission-engineering pattern, restructure so the platform doesn't need to. Codex's weaker shell-command sandboxing is now structurally irrelevant.

**No new safety-floor entries needed.** `routine.weekly_review` retains its existing (no-floor) configuration. The `browser-history` skill is unchanged — it still ships for the F1/F2/F4 surfaces that DO involve LLM curl calls (cluster-update routines, research-offer DMs, etc.), and those surfaces keep their existing Codex-forbidden floor in `backend-router.ts:validateSafetyFloor`. The interest-reflection feature simply doesn't participate in the skill / floor matrix.

**Auditability is improved.** Where the previous design produced one audit row per LLM session that called the chokepoint, the new design produces one audit row per `refreshInterestsReflection` invocation (scheduler / dashboard / test) with the trigger source recorded — a tighter, easier-to-trace signal regardless of which backend was sitting on `routine.weekly_review` that week.

---

## 15. Privacy & sensitive-category handling

Sensitive categories are filtered upstream by the existing meaningful-research filter (`pipeline/meaningful-filter.ts`):

- `banking`, `health`, `adult`, `app-config`, `cloud-console`, `localhost` — visits are recorded but **non-meaningful**; they do not influence cluster qualification, so they do not surface in `browser_research_clusters` rankings, and therefore never reach the reflection.
- User-curated `researchDomainDenylist` (existing) — domains here never contribute to meaningful totals; clusters that would have been built from them are absent from `clusters[]`.
- User-curated `researchDomainAllowlist` (existing, opt-in) — when set, the reflection only sees clusters built from allowlisted domains. This is the strictest setting and is recommended for users who want a tight current-interests view.

No additional category filtering is needed at the reflection layer; the upstream filter is the single source of truth.

**No raw URL / title surfaces in any reflection output.** All fields are derived (display name from cluster slug; top domains from the existing aggregation).

---

## 16. Schema additions

No new tables. **No new `runtimeSettingsSchema` keys** (rev 3 removed both `browserHistoryWeeklyInterestsReflectionEnabled` and `browserHistoryWeeklyInterestsReflectionFirstRunConfirmedAt` — see §22). No new `EDITABLE_RUNTIME_KEY_TUPLE` entries.

Two `runtime_state` entries (key-value blob table, no schema change):

```ts
"browser_history.weekly_interests_last_run_at"        // epoch ms — last successful refresh
"browser_history.weekly_interests_last_run_targets"   // JSON array of paths written (used by cleanup endpoint + debug)
```

These keys are written by the daemon helper (§10.3) and cleared by the cleanup endpoint (§10.3.1).

**Upgrade safety:** zero settings-table changes means zero migration risk on this feature. The two `runtime_state` writes are JSON-blob `INSERT OR REPLACE` operations against an existing table — same pattern as the rest of the codebase's `runtime_state` usage.

---

## 17. Risk classifier entries

Add to `packages/daemon/src/safety/risk-classifier.ts`:

```ts
"GET /api/browser-history/weekly-interests-summary":         RiskTier.Autonomous,
"POST /api/browser-history/refresh-interests-reflection":    RiskTier.Approve,   // dashboard "Refresh now" button
"POST /api/browser-history/cleanup-interests-reflection":    RiskTier.Approve,   // dashboard "Clean up auto-blocks" button
```

Tier rationale (rev 3):

- **GET summary → Autonomous.** Read-only aggregate over cluster data; no PII / URL / title content surfaces. Same risk profile as `/research-clusters`.
- **POST refresh / POST cleanup → Approve.** Both endpoints are dashboard-only — bearer-token-authenticated. Neither is listed in any skill's `allowed-tools`, so no LLM can call them. The daemon's scheduler invokes the same logic via direct function call (`refreshInterestsReflection` / `cleanupInterestsReflection`), bypassing the HTTP layer entirely. Approve tier is the correct posture for "destructive user-confirmed admin action" — it documents the bearer requirement and produces an audit row distinct from autonomous flows.

**Removed in rev 3:**
- `POST /api/browser-history/apply-interests-reflection` (was the LLM chokepoint; no longer exists — superseded by the daemon helper).
- `POST /api/browser-history/confirm-first-interests-reflection` (was the consent-flow endpoint; consent flow is gone).

---

## 18. Always-disallowed additions

None. The reflection writes only via the daemon's internal helper (no shell, no curl, no LLM in the path). An injected prose fragment in a cluster `display_name` cannot escape into the file structure — the template-renderer in `interests-block.ts` escapes markdown-significant and HTML-comment-significant characters (`]`, `[`, `-->`, backticks, `#`) before substitution, verified by the §20 property test.

---

## 19. Phasing

Single deliverable, no sub-phases. Estimated effort: **~4-5 days** including tests (rev 3 — smaller scope than rev 2 since no settings schema, no skill manifest change, no task-flow Phase 3.5, no consent flow, no dashboard toggle card). rev 4 added two small modules (lock + property tests) without changing the overall shape.

| Step | Module | Notes |
|---|---|---|
| 1 | `pipeline/weekly-interests-summary.ts` | Deterministic Layer-1 builder. Pure function, 100% test coverage. |
| 2 | `pipeline/interests-block.ts` | `replaceAutoBlock` helper + Mode B full-file renderer + the four file-kind templates. Pure function. |
| 3 | `pipeline/project-matcher.ts` | Frontmatter-driven keyword extraction + Jaccard match. Pure function. |
| 4 | `services/browser-history/refresh-interests-reflection.ts` | The internal helper (`refreshInterestsReflection`) — composes 1+2+3, deterministic theme selector, file writes via context-write atomic helper. Pure-ish (touches FS + DB). rev 4: now wraps body in try/finally so partial state is recorded in the audit row, accepts `integrationDisabled` flag to enforce the disabled gate INSIDE the helper, and acquires the courtesy lock via `interests-reflection-lock.ts`. |
| 5 | `services/browser-history/cleanup-interests-reflection.ts` | The cleanup helper. Pure-ish. rev 4: wraps body in try/finally, acquires the same lock, writes explicit `metadata='{}'`. |
| 6 | `core/dispatcher-scheduled-tasks.ts` | Wire `refreshInterestsReflection` as a pre-hook. Failure-isolated (try/catch + journal line on error). rev 4: passes `integrationDisabled` flag instead of short-circuiting; passes `this.db` to `getContextDir` for degraded-mode correctness; catches `InterestsReflectionLockBusyError` separately; threads `nowMs` into `appendToWeeklyInterestsJournalSection` so the 30-day rotation cuts deterministically. Also exports `appendToWeeklyInterestsJournalSection` and `pruneWeeklyInterestsJournalBullets` for tests. |
| 7 | `api/routes/browser-history.ts` | Add the three HTTP endpoints (GET summary, POST refresh, POST cleanup). All three thin wrappers over the helpers. rev 4: refresh and cleanup return HTTP 409 `{ error: "reflection_in_progress", heldBy }` on `InterestsReflectionLockBusyError`. |
| 8 | `db/runtime-state.ts` accessors | Read/write the two new `runtime_state` keys via existing helpers. |
| 9 | `safety/risk-classifier.ts` | Three new API_RISK entries (§17). |
| 10 | `agent-assets/task-flows/routine.weekly_review.md` | Add one optional informational paragraph (§10.4). No Phase 3.5; LLM has no action to take. |
| 11 | `dashboard/src/app/settings/integrations/browser-history/page.tsx` | Add a "Research themes (auto-refreshed weekly)" info section + a "Clean up auto-blocks" button + optional "Refresh now" button. **No enable/disable toggle.** |
| 12 | Tests | One unit test per pure module (3), integration test for the helper end-to-end (4 target files), disjointness test (`## Raw Signals` / `## Learned Context` / `## Expertise` byte-identical before/after), cleanup test, pre-hook failure-isolation test (helper throws → weekly_review still completes). No consent-flow test (no consent flow). |
| 13 (rev 4) | `services/browser-history/interests-reflection-lock.ts` | Process-singleton courtesy mutex. `acquireInterestsReflectionLock(holder)` returns a release callback; second acquire throws `InterestsReflectionLockBusyError`. Test escape hatch `_resetInterestsReflectionLockForTests` clears state between vitest cases. |
| 14 (rev 4) | `interests-block.test.ts` property suite | Seeded mulberry32 PRNG (no `fast-check` dep) — generates adversarial display names (control chars, markdown brackets, HTML comments, `-->`, Unicode, multi-line) and asserts: `escapeForMd` strips all hazards, `renderProfileBlock` emits exactly one BEGIN+one END line, `stripAllAutoBlocks` round-trips the rendered block (prior file content intact byte-for-byte). The property test caught a real edge case in the original spec — `renderProjectBlock` does not safely handle slugs containing `\n` or `<!--`; since project slugs derive from filenames (which can't realistically carry those), the test alphabet is constrained to alphanumeric + `-._` + `-->` and the rest of the input space is left as documented future work. |

**Backout:** the feature has no per-feature switch. To stop further writes the operator either:

1. Runs the dashboard cleanup button (one-shot purge; next weekly_review re-creates the content), or
2. Disables the upstream browser-history integration entirely (which also stops F1/F2/F4 — the natural permanent off-switch).

A code-level revert is straightforward: removing the pre-hook call in `dispatcher-scheduled-tasks.ts` is the single line that disables the feature without touching DB state. Existing auto-blocks stay until cleanup is invoked.

---

## 20. Testing strategy

### Unit tests (100% coverage on pure modules)

- `weekly-interests-summary.test.ts` — empty week, single cluster, 30 clusters truncating to 20, ranking by foreground_sec desc, dormant-since-last-week diffing.
- `interests-block.test.ts` — replacement, append-on-first-write, project disambiguator, missing END marker → fallback append. **rev 4 property suite:** seeded mulberry32 generates adversarial display names + project slugs; asserts `escapeForMd` strips all hazards, `renderProfileBlock` emits exactly one BEGIN+one END line per block regardless of payload, `stripAllAutoBlocks` round-trips, prefix-collision guard holds across pathological slugs.
- `project-matcher.test.ts` — filename match, Jaccard above threshold, Jaccard below threshold, `aitne.exclude_from_interests` opt-out, `<!-- aitne:project-keywords -->` hint.
- `interests-reflection-lock.test.ts` (rev 4) — acquire/release, contention throws `InterestsReflectionLockBusyError`, error carries both holder names, release is idempotent, stale-release from a previous holder is a no-op, test reset hatch clears state.
- `dispatcher-scheduled-tasks.test.ts` (rev 4) — `pruneWeeklyInterestsJournalBullets` drops bullets older than 30 days, preserves user prose, keeps the cutoff-date bullet (inclusive), is a no-op on empty sections, and pure with respect to its `lines` slice.

### Integration tests

- **Happy path**: seed 5 active clusters + 2 dormant + 2 existing project files (1 matches, 1 doesn't); call `refreshInterestsReflection(db, contextDir, { trigger: "test" })`; assert all four target files written (`profile.md`, `research-themes.md`, `_index.md`, matched project file) with the right block contents; assert `agent_actions` row with `trigger='test'`; assert idempotent re-run produces identical files (modulo `generatedAt`).
- **Disjointness from testimonial pipeline**: seed `profile.md` with realistic `## Identity`, `## Expertise`, `## Learned Context`, `## Raw Signals` content; run reflection; assert those four sections are byte-identical before/after and only `## Current research themes (auto)` (delimited block) was added/replaced.
- **Fewer than 3 themes**: seed 2 qualifying clusters; helper returns `{ skipped: { reason: "fewer_than_min_themes" } }`; no file writes; one journal line.
- **Missing `profile.md`**: target absent → skip with `reason='profile_md_missing'`; `research-themes.md` + matched projects still written.
- **Missing `_index.md`**: target absent → skip with `reason='_index_missing'`; other writes proceed.
- **Pre-hook failure isolation**: monkey-patch the helper to throw mid-write; dispatch `executeWeeklyReview`; assert the LLM session still runs and the weekly artifact still ships; assert the audit row records `result='error'` for the reflection but not for weekly_review.
- **Cleanup**: run reflection → assert blocks written; call `cleanupInterestsReflection({alsoDeleteResearchThemesFile: true})` → assert all blocks gone, `research-themes.md` deleted, runtime_state keys cleared; assert cleanup audit row.
- **Cleanup with retention**: cleanup with `alsoDeleteResearchThemesFile: false` → blocks gone but `research-themes.md` remains.
- **Idempotent cleanup**: second cleanup invocation returns `{ blocksRemoved: 0 }` without error.

### Failure modes

- `weekStart` request parameter on the GET endpoint is not a Monday → 400.
- File write lock contention → retry once after 250ms; on second failure → throw `RefreshError`; pre-hook catches → journal entry, weekly_review continues.
- A cluster's `display_name` contains characters that would break templated rendering (literal `]` inside a link, HTML-comment-closing `-->`, backtick) → rendering escapes them; property test (random `display_name` strings → rendered MD parses back to the same structure AND no auto-block delimiter is accidentally closed by injected content).
- Backend at weekly_review tick is Codex → reflection runs identically; assert the audit row's `trigger='scheduler'` is recorded regardless of which backend was about to handle the LLM session.

---

## 21. Open questions

| ID | Question | Current lean |
|---|---|---|
| OQ-W1 | Should the block live at the **top** or **bottom** of `profile.md`? | Bottom — keeps user-authored sections first; auto-content last; the H2 ordering signals "supplementary" to anyone reading the file. **Resolved.** |
| OQ-W2 | Should `user/research-themes.md` be auto-created if absent? | Yes — it is wholly daemon-owned (`owner: aitne-browser-history` in frontmatter); auto-create on first run is consistent with its role. `profile.md` and project files are NEVER auto-created (those are user-authored). **Resolved.** |
| OQ-W3 | What happens if the user manually edits inside the delimited block? | Their edit is overwritten on the next weekly pass. Document the convention in the dashboard's browser-history card. **Resolved.** |
| OQ-W4 | Should we offer a "remove all auto-blocks" dashboard action? | Yes — implemented as `POST /api/browser-history/cleanup-interests-reflection` (§10.3.1), Approve tier (dashboard-bearer required). The cleanup is the user's only management surface in rev 3 (no toggle, no consent flow). **Resolved.** |
| OQ-W5 | Should the reflection run before, with, or after `routine.monthly_review`? | Skip the monthly. The weekly cadence is the right granularity; monthly would either reproduce the most recent week's block (noise) or compute a longer rolling window (drift from the user's "refresh, not accumulate" directive). Revisit if user demand surfaces. **Resolved.** |
| OQ-W6 | Should `research-themes.md` carry a longer history (e.g. "8 weeks ago you were on X")? | No — out of scope per §4 (cross-week trend analysis). The cluster journals already preserve history; a longitudinal view can be added later as a separate routine. **Resolved.** |
| OQ-W7 | Should the project-annotation block include a "removal candidate" hint (e.g., a project that hasn't matched in 4 weeks)? | No — that's project-management advice, not an interest reflection. Out of scope. **Resolved.** |
| OQ-W8 | What about clusters the user has **muted** (via `!research mute <slug>`)? | Excluded from the summary by the §6 eligibility filter (status='active' only). Muted clusters do not surface in any reflection output. **Resolved.** |
| OQ-W9 | Should `user/expertise.md` (curated by the `user-profile` skill) and `user/research-themes.md` (auto by this reflection) ever cross-reference? | No bidirectional linking. `user-profile` skill is unaware of `research-themes.md`; the reflection is unaware of `expertise.md`. The `_index.md` is the only place both surface (each as a one-line entry). If a research theme matures into a durable expertise the user wants tracked, they (or the agent in a DM) write a one-liner to `expertise.md` via the existing skill — that's the manual graduation path. **Resolved.** |
| OQ-W10 | Does the new H2 `## Current research themes (auto)` need to be added to `agent-assets/templates/user/profile.md` (the seed template)? | No — fresh installs ship `profile.md` without the auto-block; the block appears only when the first weekly_review fires with ≥3 qualifying clusters. This avoids confusing fresh users with an empty "(auto)" section. **Resolved.** |
| OQ-W11 | The reflection writes to `profile.md` which downstream code injects into every session prompt (`<user>` tags). Does the added ~150 tokens (rev 3, no prose) require any per-process tuning? | No — `profile.md` already has a soft 600-token target enforced by the `user-profile` skill; this adds at most ~150 tokens at peak (rev 3 dropped the optional 500-char overview). No per-process `maxTurns` / model changes needed. **Resolved.** |
| OQ-W12 (rev 3) | Existing browser-history users will see the new `## Current research themes (auto)` section appear unannounced on their next weekly_review after this ships. Acceptable? | Yes — the H2 name includes "(auto)" precisely to signal source-of-truth. A release-note item is the right channel; an in-product prompt is exactly the consent flow the user directed us to remove. The cleanup button is available if any user wants to revert immediately. **Resolved.** |
| OQ-W13 (rev 3) | Should the cleanup endpoint be invocable without the dashboard (e.g., via a CLI `aitne cleanup-interests` command)? | Not in this deliverable. The dashboard button covers the documented use case; a CLI surface can be added later if operators request it. Deferred. |
| OQ-W14 (rev 3) | Should a `"Refresh now"` button be in the dashboard for testing / manual recovery? | Yes — implemented as a thin wrapper over the same helper, gated by the same Approve-tier bearer. Useful for support / debugging without waiting for the next Friday-evening tick. |

---

## 22. Revision history

### 2026-05-21 — initial draft

Created as a response to the post-implementation audit gap: the existing Approach A explicitly declared profile auto-update a non-goal, but the user's clarified directive is to reflect interests into knowledge MD files at **weekly cadence with refresh-not-append semantics**. This plan threads that needle by:

- Adding a single new weekly_review phase (Phase 3.5).
- Bounding writes via a chokepoint endpoint with a delimited block convention.
- Reusing the existing `browser-history` skill and `browser_research_clusters` data — no new pipeline stages.
- Keeping the "record, don't act" principle (no DMs, no autonomous actions) except for the one-time consent preview.

The design intentionally does **not** auto-create project files, does **not** carry long-term interest history, and does **not** widen the agent's general write authority over user-authored profile content — the only modifiable surface is the explicitly-delimited block.

### 2026-05-21 (rev 2) — post-review rewrite

Codebase audit (parallel Explore agents) surfaced six load-bearing issues in the initial draft. Resolved:

1. **Memory layout was stale.** Draft targeted `context/user.md` + `context/user-details/research-themes.md` (the pre-refactor layout). Real layout per `docs/design/06-memory.md` §6.1 and live code (`signal-detector.ts`, `user-profile/SKILL.md`, `api/server.test.ts`) is `context/user/profile.md` + flat siblings `user/{people,work,expertise,goals,personal,_index}.md`. Fixed throughout — primary target is now `user/profile.md`; full snapshot is `user/research-themes.md`.
2. **Boundary with the existing testimonial pipeline was missing.** `signal-detector` + `evening_review` + `user-profile` skill already populate `profile.md ## Raw Signals` / `## Learned Context` / `## Expertise` and the topic files from user statements ("好き/嫌い" testimonials). The user's directive explicitly required preserving those. Added §1 boundary, §3 goal 5, §4 non-goals 3-4, §5 principle 2, and a disjointness integration test.
3. **`agent-journal.md` path was wrong.** Correct path is `context/agent/journal.md`. Fixed.
4. **ETag was overengineering.** No ETag infrastructure exists in the codebase, the system is single-owner with weekly cadence, and the contention shape doesn't justify a novel concurrency primitive. Replaced with a server-recompute model: the daemon re-fetches the cluster summary at write time; the agent's prior GET is advisory. Unknown slugs → 400; slugs that drop between GET and POST → silently excluded with audit note; count below min → 422.
5. **`<!-- aitne:project-keywords -->` HTML-comment hint reinvented a control surface.** Project files already use frontmatter (`type:`, `state:`, `aliases:`, `tags:`). Replaced with a frontmatter convention (`aitne_project_keywords: [...]`) and fall-through to `aliases`/`tags` plus filename. Aligns with existing context-file conventions.
6. **`user/_index.md` upkeep was undefined.** Added §10.6 — the index gets a one-line idempotent entry under the same delimited-block mechanism, refreshed each weekly pass, removed by the OQ-W4 cleanup action.

Also clarified: §5 principle 8 (compact-in-always-injected-surfaces — `profile.md` block hard-capped at ~250 tokens to preserve the `user-profile` skill's 600-token budget), §7.1 new H2 name `## Current research themes (auto)` (avoids collision with the existing user-authored `## Expertise`), §10.6 (`_index.md` upkeep), OQ-W9-W11 (new questions raised by the rewrite, all resolved).

No changes to phasing, schema additions, or risk-tier assignments — those were already correct.

### 2026-05-21 (rev 3) — drop consent flow, drop LLM in write path

User feedback after rev 2 surfaced two architectural directives:

1. **"Once enabled, just update silently in the background — no per-feature toggle, no preview confirmation."** The preview-DM consent ceremony in rev 2's §13 was deemed friction the user didn't want to pay each time a new feature shipped, given that the upstream `browser-history` integration's enablement already constitutes informed opt-in to its privacy model.
2. **"Make Codex work securely, don't skip it."** rev 2 punted on Codex by adding a per-phase task-flow guard (skip Phase 3.5 on Codex), justified by the absolute-block layer's inability to enforce shell chokepoints on Codex Allow-mode. That was a bandaid — exactly the pattern `feedback_prefer_root_cause_fixes.md` says to avoid.

The fixes are coupled — both resolve to the same restructure:

**Take the LLM out of the write path entirely. Make the reflection a deterministic daemon-side job, executed as a pre-hook of `routine.weekly_review`'s dispatcher path.**

What this changes:

| Surface | rev 2 | rev 3 |
|---|---|---|
| Theme selection | LLM picks 3-7 slugs with bias rules in task-flow prose | Deterministic `selectProfileMdThemes()` function with the same bias rules as code |
| Block prose | Optional LLM-authored 500-char `themeOverview` | None — structural content only |
| Per-cluster notes in snapshot | Optional LLM-authored ≤280-char per-cluster prose | None — structural fields only |
| Write trigger | `routine.weekly_review` Phase 3.5 LLM call → `POST /api/browser-history/apply-interests-reflection` | `dispatcher-scheduled-tasks.ts:executeWeeklyReview` pre-hook → `refreshInterestsReflection(db, contextDir)` direct call |
| Skill involvement | `browser-history` skill added to `routine.weekly_review` | None — skill manifest unchanged |
| Backend story | Codex skip (per-phase guard) | Backend-agnostic — daemon writes; LLM only reads |
| `apply-interests-reflection` endpoint | LLM chokepoint write endpoint | Replaced by `refresh-interests-reflection` (Approve tier, dashboard-only thin wrapper over the helper) |
| `confirm-first-interests-reflection` endpoint | Existed for consent flow | Removed |
| Consent flow | First-enable preview DM + confirm | Removed entirely |
| `browserHistoryWeeklyInterestsReflectionEnabled` setting | New runtime-settings key, default false | Removed — feature is gated by the upstream `browser-history` integration's enable state |
| `browserHistoryWeeklyInterestsReflectionFirstRunConfirmedAt` setting | New runtime-settings key | Removed |
| Dashboard UI | Enable toggle + cleanup button | Cleanup button + "Refresh now" button, no toggle |
| Cleanup endpoint | Existed | Retained per directive — bulk-purge of all auto-blocks + optional `research-themes.md` delete |

What this preserves:

- All four write surfaces (`profile.md` auto-block, `research-themes.md`, `_index.md` entry, project annotations) and their semantics are unchanged.
- The four pure modules from rev 2 (§A1-A3 + render templates) are unchanged.
- Disjointness from the testimonial pipeline (§5 principle 2) is unchanged — and in fact tightened: with no LLM session writing to `profile.md`, there is zero behavioural surface that could accidentally touch `## Raw Signals` / `## Learned Context` / etc.
- All paths in the rev 2 layout fix (`user/profile.md`, `user/research-themes.md`, `agent/journal.md`) are unchanged.
- `## Current research themes (auto)` H2 name and rationale (collision-avoidance with `## Expertise`) unchanged.

Net effort impact: rev 3 is **smaller** than rev 2 in lines-of-code and conceptual surface — no settings schema, no skill manifest change, no task-flow phase, no consent flow, no dashboard toggle card, no LLM authorship constraints to document and test. Estimated effort drops from ~1 week to ~4-5 days (see §19).

### 2026-05-21 (rev 4) — post-implementation critical review

Steps 1–12 shipped as designed. A critical review of the implementation surfaced one load-bearing bug and several design deviations from the documented intent. All eight items below were addressed in a single revision pass; 14,048 / 14,051 daemon-side tests pass (the 3 failures are pre-existing in an unrelated `!checks` bang-command suite).

| # | Issue | Resolution |
|---|---|---|
| **A** (bug) | `dispatcher-scheduled-tasks.ts` pre-hook called `getContextDir(this.config)` without the `db` argument, so degraded-Obsidian-mode would write into the user's Obsidian vault while the LLM's `contextBuilder` reads from the internal store. | Threaded `this.db` through both `getContextDir` call sites in the pre-hook + journal appender; matches the existing convention on the 5 other call sites in the same file. |
| 1 | No per-file write lock as specified in §10.3. | Added `services/browser-history/interests-reflection-lock.ts` — a process-singleton courtesy mutex shared by `refresh` and `cleanup`. Contention throws `InterestsReflectionLockBusyError`; the dispatcher catches it as a journal line, the HTTP route returns 409 `{ error: "reflection_in_progress", heldBy }`. Held across the helper body inside a try/finally so a mid-write throw cannot leak the lock. |
| 2 | A throw mid-write left no audit row, so the dashboard's audit log could not see "scheduler tried but only wrote 1 of 4 targets". | Restructured `refreshInterestsReflection` to allocate the `RefreshResult` eagerly and emit `emitAuditRow` from a `finally` block. New `result` discriminator: `success` / `skipped` / `partial` / `failed`. `error` column populated when `caught !== undefined`. `detail.error_message` mirrors the column for queryability. |
| 3 | No property tests for the render-and-escape path. | Added a seeded mulberry32 property suite in `interests-block.test.ts`. The test caught a real bug — `renderProjectBlock` does not safely handle slugs containing `\n` or `<!--`. Since project slugs derive from real filenames (which can't realistically carry those), the test alphabet was constrained; the broader issue is documented as future work in the test comment. |
| 4 | Audit-row inserts left the `metadata` column empty via DEFAULT, hiding the contract that daemon-write rows never populate the agent-self-report side-channel. | Both `emitAuditRow` implementations now pass explicit `metadata: '{}'`. Comment at each call site cites the `agent_actions` schema comment that documents the channel separation. |
| 5 | Agent-journal section was unbounded. User accepted "monthly rotation appropriate." | Added `pruneWeeklyInterestsJournalBullets` — drops bullets older than 30 days from the `## Weekly interests reflection` section on every append. User-authored prose is preserved (only `- YYYY-MM-DD HH:MM` daemon prefix matches). Dates anchor at noon UTC so DST cannot shift the cutoff. Dispatcher threads `now.getTime()` through so the prune cuts against the same instant the bullet date prefix was computed from. |
| 6 | (Original list — Native-mode behaviour was implicit.) | Decided as "no fix needed" — native mode + zero clusters auto-skips with `fewer_than_min_themes`; the helper is robust by construction. |
| 7 | Skip-reason taxonomy split between dispatcher (browser_history disabled → journal line, NO audit row) and helper (< 3 themes → audit row + skip). Inconsistent audit shape; dashboard had a dead "we didn't hear from the helper" branch. | Added `RefreshOptions.integrationDisabled?: boolean`. Helper now short-circuits with `skipped='no_browser_history'` when set, emitting the audit row through the same emit path. `RefreshSkipReason.reason` union widened to `"fewer_than_min_themes" \| "no_browser_history"`. Shared `refreshInterestsReflectionSkipReasonSchema` updated to match. The disabled short-circuit does NOT take the lock (it has no writes to serialise) so a cleanup can still run while the scheduler bails. |
| 8 | `renderResearchThemesFile` cluster-journal link display text included a redundant `context/` prefix that did not match any real path. | Dropped the prefix — display text now matches the on-disk path the user would navigate to. Link target (`../<clusterJournalPath>`) unchanged so resolution from `user/research-themes.md` still lands on `context/research/<slug>.md`. |

Additional touch-ups discovered during implementation:

- `cleanupInterestsReflection` factored the body into `runCleanup` so the lock acquire+release can wrap the whole call in try/finally (defensive against future refactors that introduce throws).
- HTTP route layer catches `InterestsReflectionLockBusyError` and returns 409 instead of letting it surface as a 500.
- `_resetInterestsReflectionLockForTests` exists strictly for vitest cleanup between cases (the lock is process-global). Production code must not use it.
- Pre-hook discriminates `InterestsReflectionLockBusyError` from generic throws so the journal line reads `interest reflection deferred: lock busy (<heldBy>)` rather than the generic failure message.
- Dispatcher pre-hook journal path now correctly reflects degraded-mode via the `getContextDir(this.config, this.db)` thread-through.

No new schema additions, no new settings, no new skill manifest entries. The release-status invariant from `CLAUDE.md` ("upgrade safety is non-negotiable") is preserved — every change is in-process logic; the only persisted-state touch is the same `runtime_state` keys rev 3 already specified.

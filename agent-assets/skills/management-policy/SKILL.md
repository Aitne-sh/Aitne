---
name: management-policy
description: Capture a durable management rule from a DM — 'every morning X', 'from now on when Y', pause/resume/remove. Wires policy file + linked routine + dossier together. SKIP for one-off `schedule`, tone/style (character), or single user facts (`user-profile`).
allowed-tools:
  - Bash(curl *)
  - Read
---

# Management Policy Capture

A **management policy** is a durable, ongoing rule the user wants the
agent to keep applying. It is NOT a one-off task.

Each policy lives at `policies/management-captures/<slug>.md` and may link to:

- `policies/routines/custom/<slug>.md` — the cron-driven execution rulebook
- `knowledge/dossiers/<topic>.md` — where the policy's accumulating data lands

A readable summary of every policy lives at `policies/management-captures/_index.md`,
which the daemon's policy-index reconciler **auto-maintains** from the
policy files on disk. The directory listing under `policies/management-captures/` is
the source of truth; `_index.md` is a derived snapshot — **do not
PATCH or PUT it by hand**. The same reconciler also re-renders the
`## Active Policies` section in `policies/management.md` so it stays in
sync. Both files refresh within ~10 s of any policy file write.

## When to use this skill

Use when the user expresses a **durable, ongoing management rule**:

- "every morning, run my finance app and log the balance"
- "from now on, when a Linear ticket lands in the Inbox project, summarize it for me"
- "for travel, always check the weather the day before and DM me"
- "stop doing the daily X check" → policy pause/remove
- "actually let's resume the morning finance thing" → policy resume

## When NOT to use this skill

| Shape | Use instead |
|---|---|
| One-off "remind me at 3pm to call the bank" | `schedule` |
| "Reply more tersely from now on" / tone, voice, style | `user-profile` (routes to `character`) |
| "I'm an NYC-based dev" / single user fact | `user-profile` |
| "Add a project for the Q3 roadmap" | `context` (`projects/*.md`) |
| Pure data write — "log this transaction" | direct context write to the relevant `knowledge/dossiers/<topic>.md` |

If the user's request is **a recurring task with no need for a recorded
reason** (e.g. "ping me every Monday at 9 to start standup prep"), use
`schedule`'s recurring-schedules path. A management policy is the right
home only when the user wants the **why** captured alongside the
cadence so it survives a context reset.

## Workflow

### Step 1 — List existing policies (mandatory)

Read the auto-maintained index for a quick summary, then fall back to
the directory listing if you need authoritative state.

```bash
# Auto-maintained by the daemon — fastest read for slug / status /
# cadence / linked routine + dossier / one-line why.
curl -s "http://localhost:8321/api/context/policies/management-captures/_index"

# Directory listing — authoritative source of truth. Use this if a
# specific policy file looks newer than the index (the reconciler
# debounces ~10 s; fresh writes may not be reflected yet).
curl -s "http://localhost:8321/api/context/list/policies"
```

If the listing and `_index.md` rows disagree, **prefer the listing**
and trust the next reconcile pass to refresh the index. Do **not**
hand-PATCH `_index.md` to fix the drift — that just creates more churn.

### Step 2 — Detect similarity

Heuristics to compare against existing policies:

| Signal | Likely interpretation |
|---|---|
| Same `linked.dossier` topic | Likely a duplicate or extension of an existing policy |
| Same cron expression on the linked routine | Likely a duplicate cadence |
| Slug stem matches an existing slug ("finance", "inbox", …) | Likely related |

If a candidate matches, ask the user **before** creating:

> "I already have `<existing-slug>` doing `<one-line why>` on
> `<cadence>`. Update that one, or create a new policy?"

Stop until the user picks. Do not create a duplicate silently.

### Step 3 — Echo interpretation

Paraphrase the rule back in **one short paragraph**:

- the cadence (or trigger condition)
- the action
- where the data accumulates (which dossier)
- which existing routine / dossier you'll create or extend

Wait for an explicit yes. If the user corrects a detail, re-echo and
wait again.

### Step 4 — Build the policy file

Emit the full `policies/management-captures/<slug>.md` content as a fenced markdown
block in the DM **before** writing, so the user sees what's about to be
saved. The slug must:

- equal the filename stem
- match `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (or a single `[a-z0-9]`)
- be ≤ 64 chars
- equal the linked `policies/routines/custom/<slug>.md` slug (if any) — keep
  them aligned in v1

### Step 5 — Wire the dependencies (strict order; on failure, roll back in reverse)

5.1 dossier → 5.2 routine → 5.3 policy file → 5.4 (auto-index — no
manual step). Each step gates the next. The full curl recipes,
when-to-skip rules, and rollback table are in the policy-workflow
reference below.

{{> ref:policy-workflow }}

### Step 6 — Confirm to the user (one DM)

Use the `notify` skill (or reply-in-channel, depending on flow) with a
concise summary:

- policy slug + cadence
- what was created (dossier / routine / policy / index)
- how to pause it later (e.g. "say 'pause the morning finance check'")

### Step 7 — Audit

Each PUT/PATCH at steps 5.1-5.4 is Autonomous (`risk-classifier.ts`,
post-Notify-abolition). The route layer snapshots the prior file
content into `md_file_snapshots` (trigger `api_put` / `api_patch` /
`api_delete`) so the skill's rollback path can recover pre-edit state,
and every write is logged to `agent_actions` for the user's on-demand
retrospective via `GET /api/agent/actions`. Do **not** call any extra
audit endpoint — the durable trail is already produced.

## Pause / resume / remove (best-effort fan-out)

Identify the policy slug from the user's wording. If ambiguous, list
the active policies first and ask.

### Pause

1. GET the policy file, flip the frontmatter `status: paused` and
   `updated: <today>`, PUT back. (The frontmatter parser is
   line-scalar so a per-field PATCH section call would not target a
   frontmatter key — always GET-merge-PUT for frontmatter edits.)
2. If `linked.routine` is set: GET `policies/routines/custom/<slug>`, flip
   frontmatter `enabled: false`, PUT back. The reload hook flips the
   cron job off automatically.

The policy-index reconciler picks the change up on the FS event and
re-renders both `_index.md` and the management.md section within
~10 s. Do not PATCH them manually.

If step 2 fails after step 1 succeeded, **attempt to roll back step 1**
(`status` back to `active`). If the rollback itself fails, report the
partial state to the user and tell them which file is in which state.

### Resume

Same fan-out, with `status: active` and `enabled: true`.

### Remove

1. GET the policy file, flip frontmatter `status: removed` and
   `updated: <today>`, PUT back.
2. If `linked.routine` is set: `DELETE
   /api/context/policies/routines/custom/<slug>` (whitelisted).

The reconciler moves the row from `## Active` to `## Removed`
automatically — the `removedAt` cell is read from the policy file's
`updated` field, which step 1 set to today.

The policy file itself is **kept for history** — DELETE on `rules/*`
is intentionally not whitelisted (see MANAGEMENT-POLICY-CAPTURE-PLAN
§5.1).

## What this skill does NOT do

- Does NOT touch `policies/management.md` body sections (Source of Truth
  table, Notification Rules, Schedule, etc.). Those are wizard-only.
- Does NOT create rows in the `recurring_schedules` DB table — defer to
  `policies/routines/custom/` for cron, which gives the user a visible MD file
  to edit.
- Does NOT migrate existing custom routines into policy files
  retroactively. Migration is a separate one-time operation.

## Cross-skill pointers

- **Need a one-off wake-up?** Use `schedule` (`/api/schedule` or
  `/api/schedule/dm`) — no policy file needed.
- **Need a recurring task with no recorded `## Why`?** Recurring autonomous
  **work** → create an Agent via the `agent-create` skill (`POST /api/agents`);
  recurring scheduled **DM / briefing** → `schedule`'s
  `/api/recurring-schedules` with `taskType: "dm_session"`. Default to
  `tier:"medium"`; pin a specific model id only when the rule needs to
  outlive a `/settings/models` re-route.
- **Tone / voice / language preference?** Belongs in `user-profile`
  (which routes to `PATCH /api/config/character`), NOT a policy file.
  Full recipe in `user-profile/references/character-preferences.md`.

## API surface

All writes go through `/api/context/*` — see the **context** skill's
`references/api.md` for verb / mode / error envelope details. This
skill targets these paths:

- `GET /api/context/policies/management-captures/_index` (Step 1 summary)
- `GET /api/context/list/policies` (Step 1 authoritative — entries prefixed `management-captures/`)
- `GET /api/context/policies/management-captures/<slug>` (read before pause / resume / remove)
- `PUT /api/context/knowledge/dossiers/<topic>` (Step 5.1 — if new)
- `PUT /api/context/policies/routines/custom/<slug>` (Step 5.2 — if scheduling)
- `PUT /api/context/policies/management-captures/<slug>` (Step 5.3)
- `PATCH /api/context/policies/management-captures/<slug>` (pause / resume / remove; frontmatter via GET-merge-PUT only — line-scalar parser)
- `DELETE /api/context/policies/routines/custom/<slug>` (remove only)

`policies/management-captures/_index.md` and the `## Active Policies` section in
`policies/management.md` are written by the daemon's policy-index
reconciler — they are NOT in the agent's write surface for this skill.

Frontmatter validation enforces `kind: policy`, `owner: agent`, and
the slug rules in Step 4. Malformed writes return 422 with the failing
field — surface that text to the user verbatim rather than retrying
blindly.

## Policy file section shape (auto-curated)

<!-- CURATION:knowledge_layout id="policy-file-shape" -->

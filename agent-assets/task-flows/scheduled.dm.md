{context}

## Task: Scheduled DM-tone session

You are running on the conversational agent profile. The user knows
this voice from regular DMs — your final assistant turn IS the DM
that the daemon will deliver. Compose accordingly.

Origin: {event_data[source]}
Task: {event_data[task]}

<task_context>
{event_data[task_context]}
</task_context>

## Context blocks you receive

- `<today>` — today.md (User Schedule, User Tasks, Agent Plan, Agent
  Notes, Handoff)
- `<calendar_today>` — live 1-day calendar fetch at fire time
- `<recent_dm_messages window="60min">` — owner's inbound DMs in the
  last hour. Empty/missing means the user has been quiet.
- `<recent_dm_conversation>` — last 20 turns of DM history (rolling
  topic context)
- `<task_origin>` — what triggered this run (recurring schedule id,
  source)

## Agent Plan close-out (plan-backed firings)

When this firing matches a pending `## Agent Plan` row in <today>
(typically a `→wake` row the Morning Routine registered — match HH:MM
+ action text), run these gates BEFORE composing, then close the loop
per the today skill's Agent Plan lifecycle:

1. **Day-type filter** — if the row's `[category]` focus is `off` on
   line 2 of <today>, do not send the DM: end with empty output (the
   delivery path drops zero-length turns) and close the loop with
   outcome `skipped (focus off)`.
2. **Premise check** — if the row references a calendar event that
   <calendar_today> positively shows gone or moved, skip the same way
   with outcome `skipped (premise gone)`. Missing or unfetchable
   calendar data is NOT evidence — proceed normally.
3. **Close the loop** — append the Agent Log entry, then flip the row
   to `[x]` (annotate skips / failures per the lifecycle).

Recurring briefings and confirm sub-flows with no matching row skip
this section silently.

## Conversation-state framing (universal — every dm_session)

Detect state from `<recent_dm_messages>`:

- **asleep** — block empty, or oldest message > 60 min old
- **active** — inbound user DM in the last 30 min
- **very-recent** — inbound user DM in the last 5 min

The state controls the framing of your DM:

- **asleep** → Variant A: standard DM with greeting opener
- **active** or **very-recent** → Variant B: conversational weave,
  NO greeting, acknowledge the interruption, reference the recent
  topic if extractable, hand the floor back at the end

Content blocks (Schedule / Tasks / Overnight / At-risk) are identical
across both variants. Only the opener and closer differ.

## Persona compliance — IMPORTANT, NON-NEGOTIABLE

**The example phrasings throughout this document illustrate STRUCTURE,
not TONE.** The actual voice, register, language, formality, and
emoji policy MUST come from:

1. `agent-profiles/<active>.md` — the configured agent persona, already
   in your system prompt. Voice rules, character traits, speech
   patterns all live there.
2. The `## Character (user-defined)` block in your system prompt
   (see `docs/design/15-character.md`) — the user's preferred tone,
   language, formality, register, emoji policy, and verbosity. Present
   when set; absent when empty. The Character block overlays — it
   never overrides — persona voice rules or safety invariants.

If the configured persona is formal, do NOT use the casual phrasings
in the examples. Output language: follow `<output_language_policy>` —
DM replies match the user's input language and fall back to
`<settings primary_language>` for system-initiated turns; register and
emoji policy come from the Character block (when set). The examples
teach you what to put WHERE — not how to sound.

Voice drift here is high-impact: dm_session is the most
persona-load-bearing daemon-initiated touchpoint. The user
experiences a voice mismatch as "the agent feels like a different
person at 9am than during the day."

## Sub-flow routing

The specific dm_session sub-flow is selected by the **structural**
`sub_flow` field inside `<task_context>` — a value the daemon sets and
the user never edits, so routing stays correct even after the task's
prompt/content is freely edited (e.g. through the `task` board facade).
Read `sub_flow` out of the JSON in the `<task_context>` block and match
it below. If `sub_flow` is absent (legacy rows predating the field),
fall back to `{event_data[task]}` prefix matching.

- `sub_flow` is `morning_briefing` (legacy fallback: task starts with `morning briefing`) → see `## Morning briefing` below
- `sub_flow` is `task_delivery` (legacy fallback: task starts with `task delivery:`) → see `## Task delivery` below
- `sub_flow` is `profile_interview` (legacy fallback: task starts with `profile_interview:`) → see `## Profile interview` below
- `sub_flow` is `confirm` (legacy fallback: task starts with `confirm:`) → see `## Confirmation follow-up` below
- (future sub-flows added here)

If no sub-flow matches:

1. Append a one-line warning to today.md `## Agent Log` (PATCH append,
   section=agent_log) using the `today` skill:
   ```
   - HH:MM [dm_session] unrecognized task: "<task description>" — skipped
   ```
2. End the turn with NO assistant text — the daemon's notification
   path skips zero-length outputs, so no DM is sent.

Do NOT emit a placeholder line like `(unrecognized ...)` as the final
text. shouldNotify is unconditional for `scheduled.dm` (any non-empty
final text is delivered as a DM), so a placeholder would reach the
user verbatim — defeating the skip.

---

## Task delivery

Triggered by `sub_flow` = `task_delivery` in `<task_context>` (legacy
fallback: `{event_data[task]}` starts with `task delivery:`).

Your final assistant turn IS the DM that delivers a background task
artifact. The daemon has already decided that the owner is active in
conversation, so weave this into the current thread instead of writing a
standalone report.

Read `<task_context>` → `task_delivery`:

- `deliveryType: "task_result"` means a task finished. Use `draft` for
  the compact owner-facing summary and `report` as the fidelity source.
- `deliveryType: "task_clarification"` means the task is blocked on an
  answer. Ask the question naturally and briefly; if there is useful
  `contextSummary`, include only what helps the owner answer.
- `title` is the human task label. Use it only when it helps orient the
  owner.
- `assets` is the list of files the task produced for the owner (each has
  a `filename`, a `kind` like `screenshot` / `pdf` / `slides` / `image`,
  and sometimes a `label`). **When `assets` is present, the daemon attaches
  those files to THIS message automatically** — you do not upload anything.
  Reference them naturally so the attachment makes sense (e.g. "I've
  attached the confirmation screenshots" or "the slide deck is attached").
  When `assets` is absent or empty, do not mention or imply any file.
- IDs and other internal fields are for daemon routing and audit. Do not
  expose filenames-as-paths, keys, or IDs in user-facing text.

Delivery rules:

1. Use the conversational state from `<recent_dm_messages>` and
   `<recent_dm_conversation>` to write a short interruption-preface when
   the owner is mid-topic. If the recent topic is clear, acknowledge it
   lightly and hand the floor back after the task note.
2. Preserve factual fidelity. Do not invent findings, counts, URLs, or
   decisions not present in `report` / `draft`. Do not claim a file is
   attached unless it appears in `assets`.
3. Do not mention implementation details such as task IDs,
   `task.delivery`, `scheduled.dm`, artifacts, metadata, API routes,
   context blocks, or background runners.
4. Keep the message compact. For long reports, summarize the decision
   points and offer to pull details if the owner asks. If the owner later
   asks for a file again, you can re-send it from the task detail in a
   normal turn (the artifact API exposes the asset list).
5. End with exactly the message to send. Do not perform follow-up work in
   this turn.

---

## Morning briefing

Triggered by `sub_flow` = `morning_briefing` in `<task_context>` (legacy
fallback: `{event_data[task]}` starts with `morning briefing`).

> Universal rules from the notify skill § Universal user-facing
> message discipline apply on top of the contract below — particularly
> the awareness gate (lead with what the agent learned overnight, not
> calendar readback), the no-ceremony / no-internal-mechanism-names
> rules, and compactness.

Goal: give the user a single integrated view of today, plus anything
new the agent learned overnight, plus a closing note calibrated to
the day's shape. Always send — even on empty days, the briefing is
the daily greeting.

### Sources to gather

1. `<today>` ## User Schedule — today's calendar events
2. `<today>` ## User Tasks — already merged from Notion / mail /
   roadmap by the morning routine at 04:00
3. **Overnight delta (since 04:00 today)** — re-query at fire time:
   - Mail: per active account in mail skill's accounts.md, fetch the
     10 most recent messages and keep items received between 04:00 and
     now. The wire surface depends on Gmail's mode in
     `<integration_modes>`:
<!-- mode:direct:gmail -->
     Use the `mail` skill — `GET /api/mail/:accountId/messages?limit=10`
     for every account (Gmail, Outlook, iCloud, Yahoo, IMAP — same wire surface).
<!-- /mode:direct:gmail -->
<!-- mode:delegated-same:gmail -->
     Non-Gmail accounts (iCloud / Outlook / Yahoo / IMAP): use the
     `mail` skill as in direct mode. Gmail accounts: the `/api/mail/*`
     per-account gate returns 410 — use your session backend's native
     Gmail MCP tool with a "10 most recent inbox" query (`q=in:inbox`,
     limit/maxResults `10`). The `mail` skill body lists the
     per-backend tool names; this session is same-backend so no daemon
     proxy is involved.
<!-- /mode:delegated-same:gmail -->
<!-- mode:delegated-cross:gmail -->
     Non-Gmail accounts: use the `mail` skill as in direct mode.
     Gmail accounts: call
     `POST http://localhost:8321/api/integrations/gmail/exec` with a
     natural-language `task` (e.g. "Search Gmail for the 10 most
     recent inbox messages, return from / subject / snippet / ts") and
     a small `outputSchema`. The cross-backend `mail` skill variant
     (`SKILL.delegated.<session-backend>.md`, materialized for this
     session) carries the worked schema templates. Do NOT call
     `/api/mail/:gmail-account/*` (returns 410), and do NOT fall back
     to your own backend's native Gmail MCP tools — that connector
     reads a different account than the user's delegated one.
<!-- /mode:delegated-cross:gmail -->
<!-- mode:native:gmail -->
     Non-Gmail accounts: use the `mail` skill as in direct mode.
     Gmail accounts: the `/api/mail/*` per-account gate returns 410
     `{"error":"integration_native"}` — use your session backend's
     native Gmail MCP tool with a "10 most recent inbox" query
     (`q=in:inbox`, limit/maxResults `10`). The materialized `mail`
     skill body (`SKILL.native.<session-backend>.md`) lists the
     per-backend tool names. The daemon does not proxy in native mode;
     do NOT call `/api/integrations/gmail/exec` (also returns 410).
<!-- /mode:native:gmail -->
<!-- mode:disabled:gmail -->
     Gmail is disabled — skip Gmail accounts entirely. Continue with
     the remaining accounts (iCloud / Outlook / Yahoo / IMAP) via the
     `mail` skill.
<!-- /mode:disabled:gmail -->
   - DMs: covered by `<recent_dm_messages>` already
   - Calendar updates: events in today→+7d window with updated_at
     >= today 04:00
   - Pending observations: `GET /api/observations?pending=true&actor=user`
   - Filed background results (§10.5): `GET /api/background-task?state=completed&notify=false&sinceHours=24` — background tasks the user started that finished without clearing the bar to ping (a `silent` task, or an `if_significant` task whose criteria weren't met). Each row carries a `title` and a one-line `significance`. These were deliberately not surfaced when they finished; the briefing is where they get a quiet mention so nothing is silently dropped. Empty list → nothing to mention.
4. **At-risk items** — schedule conflicts, missing prep for known
   events, unanswered RSVPs. Derive by cross-referencing 1+2+3.

### Output structure (omit empty sections entirely)

Plain text. No markdown headers — most messaging platforms strip
them. Section labels are simple `Label:` lines. Order is fixed:

```
<persona greeting line>            (Variant A only)
<persona bridge line>              (Variant B only)

Schedule:
- HH:MM title

Tasks:
- [ ] item

Overnight:
- (mail) summary
- (calendar) summary
- (dm) summary
- (filed) N background results: <title> (<significance>), …

At-risk:
- conflict / prep gap

<persona closer — one sentence calibrated to today's shape>
```

### Bridge-line rules (Variant B, non-negotiable)

- NEVER greet ("morning", "good morning", or any locale equivalent).
  The user is awake and conversing; greeting them is unnatural.
- Acknowledge the interruption ("sorry to break in", "mid-thought
  but...", or persona-equivalent).
- Reference the conversation topic if extractable from the recent
  messages. Adds significant naturalness.
- State the trigger briefly ("it's 9", "9 o'clock came up").
- Exactly one sentence, in persona voice.

Structural examples (TONE FROM PERSONA, not from these — these are
casual English; if your persona is formal or speaks a different
language, adapt accordingly):

- "Sorry, mid-thought but it's 9 — let me drop today's plan first
  then we'll come back to <topic>."
- "Quick break: it's 9, here's today's plan, then back to <topic>."
- "9 o'clock — let me share today's shape, then we keep going on
  <topic>."

### Closer rules

Variant A — orienting note about today's shape (calibrate to actual
day, never generic):

- "Three meetings today — leave space between them or the afternoon
  will be tight."
- "Open day — good window for the A draft."
- "Travel day — pack the charger and a book before you head out."

Variant B — hand the floor back to the conversation:

- "Back to <topic>?"
- "Now, where were we on <topic>?"
- "That's the shape — let's pick up <topic>."

### Closer rules — forbidden across both variants

- Empty cheerleading ("have a great day", "good luck", "you got
  this") — zero information, persona-disrespecting.
- Generic openers / closers ("here's your day", "today you have N
  items") — readback patterns the user already knows.
- Saccharine padding, gratuitous emoji, exclamation chains.

### Empty-day fallback

When Schedule, Tasks, Overnight, At-risk are ALL empty:

Variant A — asleep:
```
<persona greeting>

Today is open — looks like a quiet one. <persona-voice "take it easy"
closer>
```

Variant B — active:
```
<persona bridge>

No schedule, no tasks queued — looks open today. <persona-voice
closer that returns to chat>
```

Even on empty days, the briefing IS the daily greeting. Persona
voice carries the whole message.

### Hard limits

- Maximum ~25 lines total (briefing fits one mobile screen).
- Schedule list: cap 8, append `...and N more` if over.
- Tasks list: cap 10, append `...and N more` if over.
- Overnight: cap 5 per category (mail / dm / calendar / filed). For
  `(filed)`, lead with the count and name at most 3 by title; on a
  long-quiet day a single line ("N background results filed quietly")
  is enough — never let filed results crowd out the day's actual shape.
- No internal names ("Morning Routine", "Agent Plan",
  "scheduled.dm", "state/today.md") in user-facing text.
- Forbidden openers across all variants: "Morning briefing —",
  "Morning briefing delivered", "Here's your day".

### Delivery channel — final text only, NOT `/api/notify`

The briefing is delivered as the final assistant turn of this
session. Do NOT call `POST /api/notify` for it — that path is for
ad-hoc alerts and applies the `notify` skill's universal
message-discipline rules, which have the wrong semantics for a daily
DM. Compose the briefing as your final assistant turn; the daemon
DMs it automatically.

### Bookkeeping (silent — never visible to the user)

Append one line to today.md `## Agent Log` (PATCH append,
section=agent_log) using the `today` skill:

```
- HH:MM [dm_session] morning briefing — DM sent
```

The user-visible final text is the briefing itself. The Agent Log
entry is internal bookkeeping.

### Latent profile-question piggyback (optional, at most one per briefing)

The morning routine sometimes lays a `(latent)` profile-interview row
into today.md ## Agent Notes. The briefing is one of the few naturally-
occurring outgoing-DM opportunities to slip a question in without it
feeling cold. Use the **user-interview** skill's "Operation 3 — Latent
piggyback" recipe:

1. GET `state/profile-questions.md` ## In Progress. If no entry has
   `state=latent`, skip this section entirely.
1.5 **Slot-filled pre-check.** GET
   `/api/profile-questions/slot-filled?path=<target>&section=<section?>&anchor=<anchor?>`.
   If `filled: true`, resolve the row (tick Pending, remove In
   Progress, append `(reconciled:opportunity)` to Answered, remove the
   `Profile question (latent):` line from today.md ## Agent Notes)
   and **skip the piggyback**. The slot was filled between 04:00
   morning routine and the briefing fire — asking would re-ask a
   known fact.
2. Compare the briefing's main content (Schedule / Tasks / Overnight)
   against the latent question's domain. Examples of natural fits:
   - day full of work meetings + latent `employer_role` / `tech_stack` →
     fit
   - quiet personal day + latent `hobbies` / `location` → fit
   - day full of personal items + latent `family` → fit
3. If the fit is real, weave ONE question into the briefing's closer
   line (Variant A) or bridge-out line (Variant B). NO separate
   paragraph. NO "by the way", NO meta-prefix. The question reads as a
   natural side comment at the end.
4. After composing (final text ready), PATCH the In Progress entry to
   `state=asked :: asked_at=<HH:MM>`. Update the today.md ## Agent Notes
   parenthetical from `(latent)` to `(asked HH:MM)`.

If no fit, leave the latent entry untouched. The DM-handler opportunity
check (Operation 2) and the eventual evening-sweep fallback (Operation
5B) will handle it later.

The piggyback question DOES NOT get its own briefing-section. Hard limit
above ("Maximum ~25 lines total") still binds — the question lives
inside the closer line.

---

## Profile interview

Triggered by `sub_flow` = `profile_interview` in `<task_context>` (legacy
routing fallback: `{event_data[task]}` starts with `profile_interview:<id>
— <ask-hint>`). This is the **fallback** path — the morning routine
normally just lays the row latent and waits for an opportunity in DM /
briefing. The evening sweep promotes a row to a scheduled DM only after
3 days of no opportunity AND the user has been actively DMing.

Follow the **user-interview** skill's "Operation 6 — Fallback DM"
recipe:

### Step 1 — Fire-time abort (Layer 3)

GET `state/profile-questions.md` and the row's `<target_path>`. Call:

```bash
curl -s "http://localhost:8321/api/profile-questions/slot-filled?path=<target>&section=<section?>&anchor=<anchor?>"
```

If `filled: true` OR the matching ## Pending row is no longer `[ ]`:

1. Tick the Pending row to `[x]` if still `[ ]` (read-rebuild + replace).
2. Append `- [x] <today> → <id> (reconciled:fire-time)` to ## Answered.
3. Remove the In Progress entry.
4. Append a one-line entry to today.md ## Agent Log:
   `- HH:MM [profile-interview] aborted <id>: target already filled`
5. **End the turn with NO assistant text.** `shouldNotify` is
   unconditional for `scheduled.dm` — empty turn = no DM sent. Do NOT
   emit a placeholder string.

### Step 2 — Compose the question

Send a single short DM whose body is naturally phrased around
`<ask-hint>`. The hint is agent-internal English (Policy A); the
rendered DM follows `<output_language_policy>` — this skill
intentionally splits the two surfaces, see `user-interview/SKILL.md`.
DO NOT mention the queue, the id, the schedule, or the word
"interview". Treat skipped / "later" replies cleanly — no follow-up
DM the same day.

Examples (English source; render the DM per `<output_language_policy>` and persona):

- hint: `current employer and role (or freelance / student)` →
  *"Realised I never asked — what do you do for work? (or are you
  freelancing / studying right now?)"*
- hint: `city / region where the user lives (affects weather, time, recommendations)` →
  *"Where are you based these days? Useful for scheduling and
  weather/maps stuff."*

### Step 3 — Transition state

After the final assistant text is ready (so the daemon will dispatch
the DM), PATCH the In Progress entry to:

```
- <id> :: state=asked :: asked_at=<current_time>
```

Read-rebuild the In Progress section body, replace the matching line,
preserve any other entries byte-for-byte, PATCH `mode=replace`. Without
this transition, the DM-handler queue-flip (Operation 4) will see
`state=scheduled` and treat the user's reply as unrelated, leaving the
row open.

---

## Confirmation follow-up

Triggered by `sub_flow` = `confirm` in `<task_context>` (legacy fallback:
`{event_data[task]}` starts with `confirm:`). The DM
handler scheduled this row because a gate (e.g. project-creation, a
managed-task duplicate, a long-horizon ambiguity) was triggered during
an earlier DM but could not be asked then — either the conversation
topic was incompatible, or the user's reply was already long, or the
universal "no topic-pivoting trailing question" rule in
`message.received.dm{,_first}.md` suppressed the inline ask.

The full `taskContext` schema is documented in
`docs/design/appendices/dm-conversational-flow.md` §B1. The fields
this sub-flow reads at fire time are:

- `confirm_id` — opaque per-row identifier; logged on abort / fire
- `confirm_dedup_key` (required) — stable topic key (`<gate>:<topic>`)
- `confirm_hint` — agent-internal English brief of what to ask
- `confirm_recent_window_hours` (default 24) — DM-history scan horizon
- `confirm_attempt` (default 1) / `confirm_max_attempts` (default 2)
  — retry accounting (see Step 3)
- `confirm_defer_count` (default 0) / `confirm_max_defers` (default 3)
  — active-conversation-interlock deferrals (see Step 1 check 1)
- `confirm_decline_marker` (optional, `{path, section, match}`) —
  file + section + match string that, when present in the named
  context file, signals the user already declined
- `confirm_slot` (optional, `{path, section?, anchor?}`) — file slot
  that, when filled, means the answer already landed via a different
  path

### Step 1 — Fire-time abort or defer

Four checks, run in order. **The first positive result terminates
Step 1** — either abort silent or self-defer; checks after a positive
are skipped.

#### Check 1 — Active-conversation interlock

Inspect `<recent_dm_messages window="60min">`:

- **state=very-recent** (inbound user DM in the last 5 min):
  **self-defer.** The user is mid-thread. Firing now violates Goal 1
  ("don't break the conversation thread") even with a Variant-B
  bridge. POST a replacement schedule row at
  `<current_time> + 15 min` with the SAME `confirm_dedup_key`,
  `confirm_attempt` unchanged, `confirm_defer_count += 1`, and all
  other `taskContext` fields inherited:

  ```bash
  curl -s -X POST http://localhost:8321/api/schedule \
    -H 'Content-Type: application/json' \
    -d @- <<JSON
  {
    "time": "<current_time + 15min, ISO 8601 with offset>",
    "taskType": "dm_session",
    "description": "confirm:<topic> — <hint>",
    "tier": "medium",
    "taskContext": {
      "scheduledBy": "scheduled_dm.confirm_followup.self_defer",
      "sub_flow": "confirm",
      "confirm_id": "<new short id>",
      "confirm_dedup_key": "<inherited>",
      "confirm_hint": "<inherited>",
      "confirm_recent_window_hours": <inherited>,
      "confirm_attempt": <inherited unchanged>,
      "confirm_max_attempts": <inherited>,
      "confirm_defer_count": <prior + 1>,
      "confirm_max_defers": <inherited>,
      "confirm_decline_marker": <inherited>,
      "confirm_slot": <inherited>,
      "importance": "low"
    }
  }
  JSON
  ```

  If `confirm_defer_count` after increment would **exceed**
  `confirm_max_defers` (default 3, max total ~45 min delay), do NOT
  re-schedule. Instead fall through to checks 2-4 below and let one
  of them decide whether to fire or abort. The conversation has been
  continuously hot for ~45 min; further deferral is unlikely to find
  a better moment, and at this point the universal Goal-1-outranks-
  Goal-3 rule means we accept Variant-B framing rather than letting
  the confirm starve forever.

  Log:
  ```
  - HH:MM [dm_session] confirm:<topic> deferred (defer=N): user mid-thread
  ```
  Then end the turn with NO assistant text.

- **state=active** (last 30 min, not last 5 min): **proceed** to
  check 2. The conversational weave (Variant B) framing in this
  task flow handles the on-the-fly bridge.

- **state=asleep**: **proceed** to check 2. Variant A applies.

#### Check 2 — Decline-marker probe (when `confirm_decline_marker` is set)

If `taskContext.confirm_decline_marker` is set, the user may have
previously said "no" to this exact intent. Read the file and grep the
named section for the `match` string:

```bash
curl -sS -w '\n%{http_code}' "http://localhost:8321/api/context/<confirm_decline_marker.path>"
```

A `404` status means the file has not yet been created → no marker
can exist → continue to Check 3. On `200`, parse the body and look
under the `<confirm_decline_marker.section>` heading: if any line in
that section contains `<confirm_decline_marker.match>` as a
substring, the marker is present → **abort silent** with reason
`decline-marker`.

#### Check 3 — Slot-filled probe (when `confirm_slot` is set)

If `taskContext.confirm_slot` is set, the gate's durable state may
have been written via a different path since this confirm was
scheduled. Probe:

```bash
curl -s "http://localhost:8321/api/profile-questions/slot-filled?path=<confirm_slot.path>&section=<confirm_slot.section?>&anchor=<confirm_slot.anchor?>"
```

(The endpoint is profile-questions-named but generic — see
`packages/daemon/src/core/profile-questions/slot-filled.ts`.)

**Abort silent** with reason `slot-filled` when EITHER:

- `filled: true` — the named section / anchor has a substantive
  bullet. This is the standard case (e.g. user-profile slot already
  landed via a separate write), OR
- `fileExists: true` AND `confirm_slot.section` is null/omitted
  AND `confirm_slot.anchor` is null/omitted — i.e. the gate
  encoded "the file's mere existence is the answer". This covers
  project-creation, where the durable state is "a
  `projects/<slug>.md` file with frontmatter + H1 exists" rather
  than "a specific section is populated". The endpoint reports
  `filled: false` for a fresh frontmatter+H1 file (zero substantive
  bullets), so a `filled`-only check would let the confirm fire
  even though the project was already created — `fileExists` is
  the correct signal in the no-section/no-anchor case.

Otherwise (file does not exist, or filled=false with a section
or anchor specified) continue to Check 4.

#### Check 4 — DM-history scan

Read `<recent_dm_conversation>` (last 20 turns) AND
`<recent_dm_messages window="60min">`. Judge whether the user
already answered the question described in
`taskContext.confirm_hint`. Three answer shapes count as "answered":

- **Affirmative resolution** — user wrote a sentence that lets the
  gate complete its write. Examples: *"yeah, track it as
  la-pm-masters"*, *"sounds good"*, *"go ahead"*, *"please do"*.
  Abort silent with reason `already answered (yes) in DM`.
- **Negative resolution** — user wrote a clear decline. Examples:
  *"no"*, *"don't bother"*, *"later"*, *"skip it"*, *"drop it"*.
  Abort silent with reason `already answered (no) in DM`. AND if
  `taskContext.confirm_decline_marker` is set, write the marker now
  (see §"Decline-marker write" below) so subsequent re-fires of the
  same gate see the declined state.
- **Volunteered answer** — user wrote the underlying fact without
  prompting (e.g. *"I changed my mind about LA — heading back to
  Tokyo"*, or supplied the value the gate would have asked for).
  The gate's write-side picks this up. Abort silent with reason
  `already answered (volunteered) in DM`.

Does NOT count as "answered" (fire the DM):
- bare re-mention without action: *"still thinking about LA PM"*
- status updates on the topic without consent/decline: *"LA
  classes started"*, *"midterm was hard"*
- non-answer continuations: *"hmm"*, *"not sure"*

The examples above are English for prompt clarity only; recognise
the same shapes in any language the user writes in.

**Bias conservative on ambiguous shapes, strict on explicit "yes" /
"no".** A redundant ask is recoverable; a missed confirmation can
leave a project / roadmap entry unwritten. When the DM-history
evidence is genuinely ambiguous, fire the DM (fall through to
Step 2).

#### On abort

1. Append one line to today.md `## Agent Log` via the `today` skill
   (PATCH `mode: "append"`, `section: "agent_log"`):
   ```
   - HH:MM [dm_session] confirm:<topic> aborted: <reason>
   ```
   Where `<reason>` is one of `interlock-skip`, `decline-marker`,
   `slot-filled`, `already answered (yes|no|volunteered) in DM`.
2. End the turn with **NO assistant text**. `shouldNotify` is
   unconditional for `scheduled.dm` — an empty turn means no DM is
   sent. Do NOT emit a placeholder string.
3. Step 2 and Step 3 are skipped.

#### On self-defer (Check 1 only)

Same as abort (no DM, no Step 2 / Step 3 execution) — the replacement
schedule row is the recovery path.

#### Decline-marker write (helper for Check 4 "no" branch and evaluator)

When Check 4 detects a "no" (or the evaluator branch in Step 2 fires
on silence) and `taskContext.confirm_decline_marker` is set, write
the marker before ending the turn. Three cases — file missing
entirely, file present but section missing, both present — are
handled in one read-then-branch sequence:

1. GET the file, capturing the status code:
   ```bash
   resp=$(curl -sS -w '\n%{http_code}' "http://localhost:8321/api/context/<confirm_decline_marker.path>")
   status=$(printf '%s\n' "$resp" | tail -n1)
   body=$(printf '%s\n' "$resp" | sed '$d')
   ```

   `<confirm_decline_marker.path>` is the value from `taskContext`
   (e.g. `journal/agent.md`). The endpoint accepts the path with or
   without the `.md` suffix.

2. Branch on status + section presence:
   - **status=404 (file missing).** Some marker paths
     (`journal/agent`) support `PUT` for first-write creation via the
     daemon's CREATE_ONLY_PUT allowlist. PUT a minimal file
     containing an H1, the section header, and the new marker line:
     ```bash
     curl -s -X PUT "http://localhost:8321/api/context/<confirm_decline_marker.path>" \
       -H 'Content-Type: application/json' \
       -d "$(jq -n --arg m '- <YYYY-MM-DD> [<confirm_dedup_key>] user declined (DM fire-time scan)' \
                  --arg s '<confirm_decline_marker.section as Title Case heading>' \
             '{content: "# Agent Journal\n\n## \($s)\n\($m)\n"}')"
     ```
     If the PUT returns 403 (`forbidden`), the path is not on the
     create-only allowlist — fall through to an `append_to_file`
     PATCH (which will fail with 404, surfacing the design gap so
     the operator can fix it).
   - **status=200 AND `body` contains `## <section title>`.**
     Append a bullet to the existing section:
     ```bash
     curl -s -X PATCH "http://localhost:8321/api/context/<confirm_decline_marker.path>" \
       -H 'Content-Type: application/json' \
       -d '{"section":"<section snake_case>","mode":"append","content":"- <YYYY-MM-DD> [<confirm_dedup_key>] user declined (DM fire-time scan)"}'
     ```
   - **status=200 AND section heading missing.** Use
     `mode: "append_to_file"` and include the header in the content:
     ```bash
     curl -s -X PATCH "http://localhost:8321/api/context/<confirm_decline_marker.path>" \
       -H 'Content-Type: application/json' \
       -d '{"mode":"append_to_file","content":"\n## <Section Title>\n- <YYYY-MM-DD> [<confirm_dedup_key>] user declined (DM fire-time scan)\n"}'
     ```

The marker is one short line; do not paraphrase the user's words.
Lifetime: append-only, no rotation — the gate that opted in can
remove the line later if the user explicitly revisits ("OK now let's
start that LA project after all"), but the confirm sub-flow itself
never deletes markers.

**Duplicate-line tolerance.** Both this helper and the gate's
reply-branch Decline path (e.g. `context` skill §"Reply branches")
can in principle write the same `[<confirm_dedup_key>]` line if a
narrow race slips past `runWithSessionGates`. Do NOT add a defensive
"check before write" guard. The pre-check readers (e.g. Step 1
Check 2 here; the gate's Step 1 decline-marker pre-check) all match
on the `[<confirm_dedup_key>]` substring, so duplicate lines do not
break the dedup contract — they are cosmetic only.

### Step 2 — Compose the confirmation (or close the chain silently)

#### Evaluator branch — chain-close on silence

If `taskContext.confirm_attempt > taskContext.confirm_max_attempts`,
this row is a **decline-on-silence evaluator** (see Step 3). Step 1's
four checks already established that the user has not replied. Do
NOT compose a DM. Instead:

1. Write the decline marker described in §"Decline-marker write"
   above, with marker text:
   ```
   - <YYYY-MM-DD> [<confirm_dedup_key>] silence-after-<confirm_max_attempts>-asks
   ```
2. Append one line to today.md `## Agent Log`:
   ```
   - HH:MM [dm_session] confirm:<topic> chain closed: silent decline
   ```
3. End the turn with **NO assistant text**. The chain is now closed;
   Step 3 below is skipped for the evaluator branch.

#### Compose branch — emit a single short DM

`taskContext.confirm_attempt <= taskContext.confirm_max_attempts`.
Compose a single short DM in persona voice that asks the question
from `taskContext.confirm_hint`. The hint is agent-internal English
(Policy A); the rendered DM follows `<output_language_policy>` and
the persona / Character voice rules at the top of this file.

Hard rules:

- **One question, one sentence** unless the topic genuinely needs
  more context. End with the question; do NOT layer a second topic.
- **Do NOT mention** the schedule, the queue, the gate that fired
  it, the word "confirm" / "confirmation", `taskContext`, IDs, or
  any internal mechanism. The user sees a natural DM, not a queue
  entry.
- **Conversation-state framing applies.** If state=active or
  very-recent (Check 1 returned "proceed"), use Variant B — no
  greeting, acknowledge the interruption briefly, hand the floor
  back at the end. If state=asleep, use Variant A — persona
  greeting opener is fine.
- **Softened re-check on retries.** If `confirm_attempt > 1`, this
  is a re-check after silence, NOT a re-issue of the same question.
  Phrase it as a check-in with a soft exit ("...or skip?", "...or
  did this change?", "...or want me to leave it open?"). The user
  must feel acknowledged, not pestered.

Examples (English source; render per `<output_language_policy>` and
persona — these phrasings are STRUCTURAL):

- Initial (`confirm_attempt=1`):
  - hint: `create project "la-pm-masters"? (origin: DM said they moved to LA and started a PM master's)` →
    *"Should I track 'LA PM master's' as a project so I can keep the syllabus / deadlines in one place?"*
  - hint: `ambiguous: trip to Tokyo "next month" — date 5/15?` →
    *"Was the Tokyo trip 5/15, or are you still picking the date?"*
- Softened re-check (`confirm_attempt=2`):
  - same first hint →
    *"Still on for tracking the LA PM master's as its own project, or skip for now?"*
  - same second hint →
    *"Did the Tokyo date settle, or want me to leave it open?"*

### Step 3 — Schedule the chain successor

This step runs only on the **compose branch** of Step 2 (a DM was
emitted). The evaluator branch already closed the chain in Step 2;
Step 3 is skipped in that case.

After Step 2 emits the DM text (which the daemon will dispatch as
this turn's final assistant text), schedule a successor row based on
the current attempt counter. Inherit all unchanged `taskContext`
fields from this row.

**Quiet-hours discipline.** The literal `<current_time> + 24h` may
land inside the user's quiet hours (default 22:00-08:00, configurable
via `runtime_settings.quietHoursStart/End`). The schedule skill's
"Time discipline" section forbids non-`critical` rows in quiet hours,
and the scheduler rejects them. Pick a target time that:

1. Is at least 24h after `<current_time>` (the §B6 minimum-interval
   contract), and
2. Falls outside the user's quiet hours.

The simplest pattern: take `<current_time> + 24h` and, if that
clock-time is inside quiet hours, roll forward to quiet-hours-end
on that day. For a 23:30 initial fire with quiet hours starting at
22:00, this yields a 08:00 successor 24h+8.5h later — slightly more
than 24h, still within the spirit of "next agent-day". Do not roll
*backward* to fit before quiet hours; that violates the 24h
minimum.

#### Case A — `confirm_attempt < confirm_max_attempts`

Schedule a **softened retry** at `<current_time> + 24h`:

```bash
curl -s -X POST http://localhost:8321/api/schedule \
  -H 'Content-Type: application/json' \
  -d @- <<JSON
{
  "time": "<current_time + 24h, ISO 8601 with offset>",
  "taskType": "dm_session",
  "description": "confirm:<topic> — <hint, softened paraphrase>",
  "tier": "medium",
  "taskContext": {
    "scheduledBy": "scheduled_dm.confirm_followup.retry",
    "sub_flow": "confirm",
    "confirm_id": "<new short id>",
    "confirm_dedup_key": "<inherited unchanged>",
    "confirm_hint": "<softened English brief — e.g. 'still on for tracking LA PM master's, or skip?'>",
    "confirm_recent_window_hours": <inherited>,
    "confirm_attempt": <prior + 1>,
    "confirm_max_attempts": <inherited>,
    "confirm_defer_count": 0,
    "confirm_max_defers": <inherited>,
    "confirm_decline_marker": <inherited>,
    "confirm_slot": <inherited>,
    "importance": "low"
  }
}
JSON
```

The successor's `confirm_hint` SHOULD be softened by the composing
session — the next fire's Step 2 reads the hint as written, so a
gentler hint produces a gentler DM. Reset `confirm_defer_count` to 0
on a retry (defers are per-fire, not per-chain).

#### Case B — `confirm_attempt == confirm_max_attempts`

Schedule a single **decline-on-silence evaluator** at
`<current_time> + 24h` with `confirm_attempt = confirm_max_attempts + 1`
(sentinel). At the evaluator's fire time, Step 1 runs as usual; if
all four checks pass (user still has not replied), Step 2's
evaluator branch silently writes the decline marker and ends —
no DM, no further successor.

```bash
curl -s -X POST http://localhost:8321/api/schedule \
  -H 'Content-Type: application/json' \
  -d @- <<JSON
{
  "time": "<current_time + 24h, ISO 8601 with offset>",
  "taskType": "dm_session",
  "description": "confirm:<topic> — silence-evaluator",
  "tier": "medium",
  "taskContext": {
    "scheduledBy": "scheduled_dm.confirm_followup.evaluator",
    "sub_flow": "confirm",
    "confirm_id": "<new short id>",
    "confirm_dedup_key": "<inherited unchanged>",
    "confirm_hint": "<inherited>",
    "confirm_recent_window_hours": <inherited>,
    "confirm_attempt": <confirm_max_attempts + 1>,
    "confirm_max_attempts": <inherited>,
    "confirm_defer_count": 0,
    "confirm_max_defers": <inherited>,
    "confirm_decline_marker": <inherited>,
    "confirm_slot": <inherited>,
    "importance": "low"
  }
}
JSON
```

#### Bookkeeping (silent — never visible to the user)

After scheduling the successor (Case A or B), append one line to
today.md `## Agent Log`:

```
- HH:MM [dm_session] confirm:<topic> sent (attempt=N/max=M); successor scheduled <case>
```

(Use `case=retry` for Case A and `case=evaluator` for Case B.)

### Notes — invariants this sub-flow upholds

- **Goal 1 (thread preservation).** Check 1's self-defer keeps a
  hot thread intact even though the confirm has been waiting.
  When defers exhaust, Goal 1 still wins: Variant-B framing softens
  the entry rather than firing a cold opener.
- **Goal 2 (confirmations happen naturally).** Step 2's persona
  voice + state-aware framing means the user experiences the DM as
  a check-in, not a queue ping.
- **Goal 3 (never ask twice).** Checks 2-4 dedup against all
  observable answer surfaces (declined, slot-filled, replied in
  DM). Step 3's chained-fire model caps the chain at
  `confirm_max_attempts + 1` fires (default 3), of which only
  `confirm_max_attempts` (default 2) send DMs. The minimum
  inter-fire interval is 24h — no same-day re-asks.
- **Schedule row IS the queue.** No new table, no
  `pending-confirmations.md`. All chain state lives in
  `taskContext`; cross-path cancellation is the gate's
  responsibility (see the gate's reply-branch contract, e.g. the
  `context` skill's Project DM-intent detection §"Reply branches").

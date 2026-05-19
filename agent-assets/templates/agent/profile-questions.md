---
type: agent_questions
owner: agent
updated: 2026-04-26
language: en
template_version: 1
---
# Profile Interview Queue

> Agent-internal — never auto-injected into prompts. The agent picks at
> most one Pending question per agent-day and writes it to ## In Progress
> as `state=latent`. Latent questions wait for a natural opportunity in
> DM (a topic-related inbound message, the morning briefing) and are NOT
> scheduled as cold standalone DMs by default. Falls back to a scheduled
> DM only after 3 days of no opportunity. Answers flow back through the
> normal user-profile capture path.
>
> Schema and operations: `agent-assets/skills/user-interview/SKILL.md`.

## Pending

### Identity
- [ ] (HIGH) name :: user/profile.md ## Identity :: match=Name :: preferred name or alias (real name not required)
- [ ] (HIGH) timezone :: user/profile.md ## Identity :: match=Timezone :: IANA timezone (e.g. Asia/Tokyo)

### Personal
- [ ] (HIGH) location :: user/personal.md ## Location :: city / region where the user lives (affects weather, time, recommendations)
- [ ] (MID) sleep_pattern :: user/personal.md :: match=Sleep :: typical sleep window on weekdays / weekends (user-profile skill writes a `- Sleep:` bullet to user/personal.md when the user states their schedule)
- [ ] (MID) hobbies :: user/personal.md ## Hobbies :: hobbies, recurring leisure activities
- [ ] (LOW) origin :: user/personal.md ## Background :: where the user is from (city / cultural background)
- [ ] (LOW) diet :: user/personal.md ## Diet :: dietary preferences or restrictions

### Work
- [ ] (HIGH) employer_role :: user/work.md ## Company :: current employer and role (or freelance / student)
- [ ] (MID) tech_stack :: user/work.md ## Stack :: tools / languages / frameworks used at work
- [ ] (LOW) team :: user/work.md ## Team :: team size and frequent collaborators

### People
- [ ] (MID) family :: user/people.md ## Family :: family composition (do not pry on detail)
- [ ] (LOW) close_colleagues :: user/people.md ## Colleagues :: colleagues the user works with often

### Goals
- [ ] (MID) annual_goals :: user/goals.md ## Annual :: goals or themes for the year
- [ ] (LOW) learning_targets :: user/goals.md ## Learning :: skills / topics the user wants to learn

## In Progress

> One entry per question currently being worked on. Format:
>   `- <id> :: state=<state> :: since=<YYYY-MM-DD> [:: scheduled_at=<ISO>] [:: asked_at=<ISO>]`
> The `since=` field is the agent-day the entry was first added; it is
> preserved across `latent → asked → resolved` state transitions and is
> what the evening sweep uses to compute the 3-day fallback threshold.
>
> State machine:
>   `latent`    — picked by morning routine; awaiting a natural opportunity.
>   `scheduled` — fallback only (≥3 days latent + active user); standalone
>                 DM is registered, not yet fired.
>   `asked`     — DM has been sent (any path); waiting for user reply.
> The DM-handler queue-flip MUST gate on `state=asked` only.

- (none)

## Answered

> Append-only log. Source markers:
>   (DM)                       — user answered in chat
>   (reconciled:skeleton)      — Layer 1 deterministic pre-tick
>   (reconciled:morning)       — Layer 2 morning-routine pre-pick
>   (reconciled:opportunity)   — Layer 3 DM-handler / briefing abort
>   (reconciled:fire-time)     — Layer 3 fallback DM fire-time abort
>   (reconciled:sweep)         — Layer 4 evening-sweep LLM reconcile
>   (import:<source>)          — profile import migration

- (none)

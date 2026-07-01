---
kind: reference
name: prompt-frame
description: The canonical core prompt frame (# Role / # Important / # Instruction / # Output), the operating-playbook references, and the clarify-back gate the DM agent uses to author a deployed agent's prompt. Shared byte-identical between agent-create and schedule.
---

### The core frame

Author the deployed agent's prompt as this Markdown skeleton. It is classic,
model-agnostic structure and reads identically under every backend. Keep it well
under the 8000-char cap — durable methodology lives in the playbooks (below), not
inlined here.

```markdown
# Role
You are <agent identity>. Every <cadence> you <the single outcome this agent exists for>.

# Important
- <hard constraints & rules to uphold>
- Preconditions: read <inputs> first; if <precondition> is missing, <fallback> and do not guess.
- Do NOT <the things that would make the output wrong or unsafe>.
- <playbook reference — name the methodology you'll follow, e.g. "Follow the research playbook.">

# Instruction
1. <ordered, concrete step — specific verb + endpoint / filename / decision rule>
2. <step — include a worked EXAMPLE wherever a step is non-obvious>
   e.g. "Classify each item actionable-today / FYI / ignore — 'PR review requested' → actionable-today; a newsletter → ignore."
3. ...

# Output
- <format & destination: which file / section, frontmatter, append-vs-new-file, when/whether to DM>
- <if writing a note, say "follow the markdown-note playbook for structure">
- (Omit this section only when the task produces no durable artifact and no DM.)
```

Rules that make the difference between a sharp agent and a drifting one:

- **`# Instruction` steps must include concrete examples.** A step the agent could
  read two ways needs a worked example pinning the intended one. Vague steps are
  the #1 cause of a drifting agent.
- **`# Important` is the guardrail section** — preconditions, fallbacks, the
  explicit "do NOT" list, and the playbook reference all live here. Don't scatter
  guardrails across the other sections.
- **The deployed agent has no memory of this conversation.** Everything it needs is
  in the prompt or in a playbook it is told to follow — nothing else carries over.

Migrating from the old four-element skeleton:

| Old element | New home |
|---|---|
| Goal | `# Role` (identity + the single outcome) |
| Requirements / preconditions | `# Important` (preconditions + fallbacks) |
| Process | `# Instruction` (ordered steps, **with examples**) |
| Expected output | `# Output` |
| guardrails / "what NOT to do" | `# Important` |

### Operating playbooks (never inline the full text)

Durable methodology lives in the operating playbooks, kept central so a single
update reaches every agent. Do NOT paste a playbook's full content into the prompt
— that copy would silently go stale. How the methodology reaches the run depends
on the path:

- **Recurring Agent** (agent definition): name the playbook in `# Important` AND
  declare its slug in the top-level `playbooks:` field. The daemon then injects the
  full methodology into every run — the single, guaranteed copy in the prompt.
- **One-off task** (`/schedule`): there is no `playbooks:` field and no injection.
  Fold the handful of steps you actually need straight into `# Instruction`; a
  run-once task has no staleness concern, so inlining is the right call here.

| If the agent's job is… | Name this playbook in `# Important` | Also |
|---|---|---|
| Research a topic and report | "Follow the **research** playbook." | + markdown-note if it writes a note |
| Watch something and report changes | "Follow the **monitoring** playbook." | + markdown-note for the rolling note |
| Produce / update a free-form topic note | "Follow the **markdown-note** playbook." | — |

The markdown-note playbook governs *free-form topic notes only* — never the
structured context-vault files (today.md, journal, roadmap), which keep their own
schemas.

### Clarify-back before you deploy

If a required slot for the agent's archetype is unknown from the conversation, ask
the user **one consolidated question** before creating the agent — never guess. (The
runtime drops an ambiguous task rather than salvaging it, so ambiguity has to be
resolved now.) Batch all missing slots into a single message and pair each with a
sensible **default** the user can accept in one tap. Ask only *missing, required*
slots — don't interrogate.

| Archetype | Required slots (ask only if unknown) | Sensible default |
|---|---|---|
| **Research** | topic/scope; what you mainly want (a decision? situational awareness? specific sub-questions?); depth (how many angles/sources); output destination (Obsidian note? DM? both); cadence + time | medium depth (3–5 angles); Obsidian note + short DM digest |
| **Monitoring / digest** | what to watch; what counts as a noteworthy change; where to record; notify threshold (always vs only-on-change) | notify only on material change; record to a rolling note |
| **Any task writing a note** | destination path; title pattern; append-to-existing vs new-file-per-run | new dated file under the topic folder |

### Worked example — a content agent

**Good** (research → note; core frame + playbook references):

```markdown
# Role
You are the user's AI-news researcher. Every morning you produce a verified digest
of the most important AI developments from the last 24h.

# Important
- Read context/research/ai-news.md for what you already reported; don't repeat it.
- Follow the **research** playbook for method + source verification, and the
  **markdown-note** playbook for the note's shape.
- Do NOT include a claim backed by a single source without marking it "(single source)".

# Instruction
1. Pick 3–5 distinct angles not already covered in the existing note.
2. For each angle, find 2–4 authoritative sources with WebSearch; open the top 1–2
   in full if the agent has page-fetch access (a standard scheduled agent does not).
   e.g. for "model releases" prefer the lab's own post over a news aggregator.
3. Cross-check every material claim against ≥ 2 sources before including it.

# Output
- Write context/research/ai-news/<YYYY-MM-DD>-digest.md per the markdown-note playbook.
- DM the user the 2–4 sentence "what matters" summary + the note path.
```

**Bad:** `"Research the latest AI news every morning and send me a summary."` — no
preconditions, no method, no source bar, no output contract; the agent improvises
differently (and shallowly) every day.

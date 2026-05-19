---
# dm-intent.long-horizon — Long-horizon DM-intent detection decision tree.
# Included from: message.received.dm.md (Step 4), message.received.dm_first.md
# (Step 4). The `roadmap` skill is the WRITER (PUT / PATCH / archive); this
# partial carries the trigger surface that the DM dispatcher applies before
# the writer runs.
---

Referenced from `message.received.dm` and `message.received.dm_first`.
Identify user messages that describe a commitment or plan beyond the
current day so the DM handler can route them into roadmap.

**Signals (positive):**
- Explicit forward-looking verb + horizon phrase:
  *"going to X next month"*, *"planning to do Y this summer"*,
  *"want to Z this quarter"*
- Specific future date ≥ 48h out
- Concrete object (destination, deliverable, learning target,
  reservation)

**Not signals:**
- Speculative language (*"maybe"*, *"someday"*, *"might"*, *"perhaps"*,
  *"thinking about"*) without a concrete anchor
- Current-week commitments (those belong in `today.md`)
- Opinions, preferences, taste statements
  (those belong in `user/*.md` via the `user-profile` skill)

**Routing after detection:**
- Dated ≥ 48h out → Agent Action Plan event entry (Preparation
  Timeline grows once destination / details resolve).
- Undated horizon ("this summer", "this quarter") →
  `## Long-term Plans` line with a horizon-tag.
- Ambiguous → keep in `agent-journal.md` as a candidate line and
  surface via the next morning routine for user confirmation
  (dry-run mode).

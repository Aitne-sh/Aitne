---
name: monitoring
description: Read-prior-state → fetch → compute-delta method, materiality gate, and Added/Changed/Resolved reporting for a recurring watch/digest agent.
---

Operating standard for an agent that watches something and reports changes.
Follow it on every run.

### Method

1. Read the prior state (last run's note/section) BEFORE fetching new data — you
   cannot compute a delta without it.
2. Fetch the current state from the named source(s).
3. Compute the DELTA: what is new / changed / resolved since the last run.

### Materiality (avoid noise)

- If nothing material changed, record "no change" and do NOT DM the user — unless
  the agent was explicitly told to always report on its cadence.
- "Material" is defined in the agent's `# Important` section; the default is a
  change the user would actually act on. When in doubt, record it to the note but
  don't interrupt the user.

### Reporting

- Lead with the delta, not a re-dump of unchanged state.
- Use a consistent delta format every run: **Added / Changed / Resolved**.
- Append to a rolling note (**markdown-note** playbook); DM only on a material
  change, or on the explicit cadence the user requested.

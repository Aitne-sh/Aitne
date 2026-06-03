---
kind: reference
name: retention
description: Roadmap retention windows (RFC-D preview) — when Agent Action Plan entries, Scheduled rows, and Long-term Plans roll off. Governs removal acceptance in the transition guard.
---

# Retention (RFC-D preview)

- **Agent Action Plan event entries** — kept while the event's header
  date is within `[today - 7d, today + 180d]`. Older entries whose
  Preparation Timeline rows are all `completed` roll off into `daily/`
  history.
- **`Scheduled:` entries** — kept while the Wake-up date is within
  `[today - 1d, today + 180d]`. On completion, Status flips to
  `completed` and the entry persists one extra day for the journal.
- **Long-term Plans** — entries without date movement for 90 days are
  marked `[stale]` by Evening Review. 180 days without user
  confirmation → DM; no reply in 7 days → remove.

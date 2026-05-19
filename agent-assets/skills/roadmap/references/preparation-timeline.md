---
kind: reference
parent_skill: roadmap
---

Action line formats:

```
- YYYY-MM-DD [tag]: description
- completed YYYY-MM-DD: YYYY-MM-DD [tag]: description
```

The completed prefix date is the completion date; the second date is
the original planned date. Preserve completed rows byte-for-byte across
refreshes. Morning Routine marks an open row complete by rewriting:
`- YYYY-MM-DD [tag]: foo` →
`- completed <today>: YYYY-MM-DD [tag]: foo`.

Tags: `[notify]`, `[today]`, `[check]`, `[schedule]`.

### Travel (domestic / international)

- International: visa/ESTA application `[notify]` 3–4 weeks before
- Flight tickets `[notify]` 2–3 weeks before (prices rise closer to date)
- Accommodation confirmation `[check]` 1–2 weeks before
- Packing list `[today]` 2 days before
- Transit plan, weather check `[today]` 1 day before
- Final checklist `[notify]` day before departure

### Deadlines / Submissions

- Data gathering / research `[today]` 2 weeks before
- Draft creation `[today]` 1 week before
- Final review reminder `[notify]` 2 days before
- Due date reminder `[notify]` 1 day before

### Conferences / Presentations

- Slide preparation `[today]` 2 weeks before
- Rehearsal `[today]` 3 days before
- Travel prep if applicable (see Travel above)

### Recurring milestones

- Progress review `[today]` 3 weeks before
- Remaining tasks audit `[notify]` 2 weeks before
- Final confirmation `[today]` 3 days before

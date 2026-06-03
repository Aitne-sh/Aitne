---
kind: reference
parent_skill: roadmap
---

Horizon-tag grammar (validated by the context API):
- `YYYY-MM` → month-granular
- `YYYY-Qn` → calendar quarter
- `YYYY spring|summer|autumn|winter`
- `undated` → no horizon yet

Worked examples:
- `- [2026-05] LA trip candidate — Source: dm 2026-04-19 — Review: 2026-04-20 — ReviewCount: 0  <!-- id: rm-20260419-a3f1c2 -->`
- `- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-b8e7d4 -->`
- `- [undated] Eventually learn Spanish — Source: dm 2026-04-19 — Review: [noreview] — ReviewCount: 3  <!-- id: rm-20260419-0d4c9a -->`

`Review:` is the date when Evening Review should re-evaluate whether the
line is ready to become an Agent Action Plan entry. Date math uses the
configured user timezone, not UTC midnight.

| Horizon tag | Anchor (earliest plausible start) | Default `Review:` |
|---|---:|---:|
| `YYYY-MM` | first day of that month | anchor - 28 days |
| `YYYY-Qn` | first day of the quarter's first month | anchor - 45 days |
| `YYYY spring` | `YYYY-03-01` | anchor - 60 days |
| `YYYY summer` | `YYYY-06-01` | anchor - 60 days |
| `YYYY autumn` | `YYYY-09-01` | anchor - 60 days |
| `YYYY winter` | `YYYY-12-01` | anchor - 60 days |
| `undated` | none | Source date + 90 days |
| explicit `Review: [noreview]` | none | never fires |

Northern-hemisphere season anchors are intentional. When a derived
review date is already in the past at write time, clamp it to
`Source date + 1 day` so newly captured plans do not fire in the same
turn.

`ReviewCount:` starts at `0`. For undated entries that fail to promote,
Evening Review moves `Review:` forward by 90 days and increments
`ReviewCount:`. When an undated entry reaches `ReviewCount: 3` with no
movement, rewrite `Review:` to `[noreview]` silently; do not DM the
user. Dated entries that fail to promote move `Review:` forward by 30
days.

User edits are normalized narrowly. If a Dashboard/API write adds a
parseable bullet with a horizon tag and intent but omits `Source:`,
`Review:`, or `ReviewCount:`, the context API fills
`Source: dashboard <today>`, derives `Review:` from the table above,
and sets `ReviewCount: 0`. Direct filesystem edits bypass the API, so
the next roadmap refresh or evening review must preserve the line by
rewriting it into the same canonical shape. Unparseable bullets are
validation errors with line numbers; do not guess.

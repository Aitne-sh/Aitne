---
kind: reference
parent_skill: mail
---

One grammar, translated per-provider:

| Token | Meaning |
|---|---|
| `from:<email>` | sender match |
| `to:<email>` | recipient match |
| `subject:"..."` | substring of subject |
| `has:attachment` | ≥ 1 attachment |
| `is:unread` | unread only |
| `newer_than:<N>d` | received in last N days |
| `older_than:<N>d` | received before N days |
| `<free text>` | subject / body / from |

**Non-ASCII and IMAP.** Before running a non-ASCII free-text query
against an IMAP account, check `accounts.md` `kind` column. For `yahoo`
/ `icloud`, the route downgrades to client-side filtering over recent
UIDs — historic ranges will be **incomplete**. Either (a) keep the
window short with `newer_than:30d`, (b) use the local FTS5 endpoint
instead, or (c) tell the user results may miss older matches.

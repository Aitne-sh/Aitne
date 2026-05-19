---
kind: reference
parent_skill: mail
---

Each provider supports the unified surface but with differing semantics.
Routes return **HTTP 501 `not_implemented`** when a method isn't available
on this kind — do NOT retry; tell the user and fall back.

| Operation | Gmail | Outlook | Yahoo / iCloud (IMAP) |
|---|---|---|---|
| Read, search, list folders | yes | yes | yes (ASCII; non-ASCII degrades — see §4) |
| Direct send (`POST /messages/send`) | yes | yes | yes |
| `markRead` / `tags` / `trash` | yes | yes | yes |
| `archive` / `untrash` | yes | yes | yes |
| Thread read (`GET /threads/:id`) | yes | yes | partial (client-walked; `status: "partial"` possible) |
| Draft read (`GET /drafts`, `GET /drafts/:id`) | yes | yes | yes |
| Draft write (`POST`/`PATCH`/`DELETE /drafts`, `POST /drafts/:id/send`) | yes | yes | no — **501** — direct `/messages/send` only |
| Attachment download (via `/receipts/:id/file`) | yes | no — 501 | no — 501 |

**IMAP drafts** (Yahoo / iCloud): every draft *write* returns 501. To
queue outbound mail for a non-Gmail IMAP user, send directly via
`POST /messages/send` (agent composes body) or ask the user to compose in
their native client. MIME-constructed drafts ship in a later phase.

**Attachments beyond Gmail**: receipts / attachment download currently
work only for Gmail messages. If the user asks you to save an attachment
off an Outlook or IMAP message, say so and point them to the provider's
web UI.

### Provider-specific quirks

| Concern | Gmail / Outlook | Yahoo / iCloud (IMAP) |
|---|---|---|
| Tag semantics | Gmail: label ids. Outlook: category names. Free-form. | System flags only (`\Seen \Flagged \Answered`) + server-advertised `PERMANENTFLAGS` keywords. Unknown tags silently dropped. |
| Threads | Provider-authoritative | Client-walked from `In-Reply-To` + `References`. `status: "partial"` when local index lacks older ancestors. `404 not_found` if the rfc822 id can't be reached. |
| `PATCH /drafts/:id` with `reply` | Gmail: threading is editable. Outlook: silently ignores `reply`; response includes `warnings: ["reply_threading_immutable_after_create"]` — create a fresh draft to reshape threading. | N/A (draft writes 501) |

Call `GET /api/mail/:acct/tags` before tagging on IMAP — `userDefined` is
often empty on servers that don't advertise keywords.

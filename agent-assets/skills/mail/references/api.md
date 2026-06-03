---
kind: reference
name: api
description: Direct-mode /api/mail/* reference — accounts, search, read, send/draft, modify/move, health. ACCT is the accountId resolved from accounts.md.
---

# /api/mail/* — Direct-mode reference

Base URL `http://localhost:8321`. `ACCT` = `accountId` from
`accounts.md` (resolved per §1 of the skill body).

Cross-cutting rules (apply to every endpoint below):

- The per-account `/api/mail/:acct/*` gate returns `410` for the
  account's `kind` when Gmail / Outlook are in delegated or native
  mode. Re-check `integrations.md` and switch to the matching
  delegated / native skill body instead — do not retry through
  `/api/mail/*`.
- The trash / untrash / archive / send endpoints are Autonomous but
  still respect the user's `deniedTools` for delegated-mode
  connector tools (no equivalent gate in direct mode today).

## Accounts

```bash
curl -s "http://localhost:8321/api/mail/accounts?active=1"
# → { accounts: [{ id, kind, email, label?, authStatus, idleEnabled, active, createdAt }, ...] }
```

Always pass `?active=1` for recovery from a stale `accounts.md` —
the unfiltered form returns dormant / unhealthy rows that every
operation will reject.

## Search (local FTS5, cross-account)

```bash
curl -s "http://localhost:8321/api/mail/search?q=...&limit=50&accountId=ACCT"
# → { results: [{ accountId, providerMsgId, subject, snippet, receivedAtUtc,
#                 from: { email } | null, isRead }], count, query }
```

`accountId` is optional — omit to search across every active account.
The local index is zero provider round-trips, so prefer it for "find
emails about X / from Y / last month" queries before falling back to
per-account provider search.

## Read

```bash
# List / search via the provider.
curl -s "http://localhost:8321/api/mail/ACCT/messages?q=is:unread&limit=20"
# → { messages: [{ providerMsgId, threadId, from, subject, snippet,
#                  receivedAtUtc, isRead, flags, hasAttachment }] }

curl -s "http://localhost:8321/api/mail/ACCT/messages/MSG_ID"
# → { message: { ..., body: { text, html }, attachments: [...] } }

curl -s "http://localhost:8321/api/mail/ACCT/threads/THREAD_ID"
# → { thread: { threadId, messages: [...], status: "full"|"partial", missingAncestors? } }

curl -s "http://localhost:8321/api/mail/ACCT/folders"
curl -s "http://localhost:8321/api/mail/ACCT/tags"
```

For body understanding on large messages, use the extracted-body
endpoint (`/messages/MSG/body?format=extracted&maxChars=…&chunk=…`)
documented in §"Reading message bodies — use extracted chunks" of the
skill body.

## Send / draft

```bash
# Direct send — Autonomous. Direct mode has NO deny-tool gate: this
# route validates the body and sends unconditionally (no 403/denied_tool
# path; `deniedTools` only applies to delegated-mode connector tools).
# Call /api/notify yourself if the user should know.
curl -sX POST "http://localhost:8321/api/mail/ACCT/messages/send" \
  -H "Content-Type: application/json" \
  -d '{"to": [...], "subject": "...", "textBody": "...", "reply"?: {...}}'
# → { result: { id, isDraft: false, rfc822MsgId?, warnings? } }

# Draft CRUD — Autonomous tier.
curl -s "http://localhost:8321/api/mail/ACCT/drafts"
curl -s "http://localhost:8321/api/mail/ACCT/drafts/DRAFT_ID"
curl -sX POST   "http://localhost:8321/api/mail/ACCT/drafts" -d '{...}'
curl -sX PATCH  "http://localhost:8321/api/mail/ACCT/drafts/DRAFT_ID" -d '{...}'
# PATCH response: { status, id, warnings? }
# - On Outlook, `warnings: ["reply_threading_immutable_after_create"]` if
#   `reply` was supplied — reply headers are fixed at createDraft time.
curl -sX DELETE "http://localhost:8321/api/mail/ACCT/drafts/DRAFT_ID"
curl -sX POST   "http://localhost:8321/api/mail/ACCT/drafts/DRAFT_ID/send"
```

## Modify / move

```bash
curl -sX POST "http://localhost:8321/api/mail/ACCT/messages/MSG_ID/read"    -d '{"read": true}'
curl -sX POST "http://localhost:8321/api/mail/ACCT/messages/MSG_ID/tags"    -d '{"add": ["Starred"], "remove": []}'
curl -sX POST "http://localhost:8321/api/mail/ACCT/messages/MSG_ID/trash"
curl -sX POST "http://localhost:8321/api/mail/ACCT/messages/MSG_ID/untrash"
curl -sX POST "http://localhost:8321/api/mail/ACCT/messages/MSG_ID/archive"
```

## Health

```bash
curl -s "http://localhost:8321/api/mail/ACCT/health"
# → { accountId, lastPollAtUtc, lastError, lastErrorAtUtc,
#     consecutiveErrorCount, idleFallbackUntilUtc }
```

---
kind: reference
name: examples
description: Worked examples for direct-mode mail — reply with context, file a message (read + tag + archive), cross-account search → pick account → send.
---

# Worked examples (direct mode)

These examples target the direct-mode `/api/mail/*` surface. The
delegated and native variants of this skill carry their own examples
in their own bodies (Gmail via `/api/integrations/gmail/exec`,
Outlook via the user's MCP). Use this reference only for
direct-mode accounts.

## Reply with context

```bash
# 1. Find the thread — start local.
curl -s "http://localhost:8321/api/mail/search?q=from:alice+proposal&limit=5"
# → pick the hit, note accountId + providerMsgId.

# 2. Fetch the thread.
curl -s "http://localhost:8321/api/mail/acct-1/threads/THREAD_ID"
# → last message has rfc822MsgId, providerMsgId (no references[] on the
#   message — you SUPPLY references in the reply block below).

# 3. Create a draft threaded to it. Drafts are Autonomous tier.
curl -sX POST "http://localhost:8321/api/mail/acct-1/drafts" \
  -H "Content-Type: application/json" \
  -d '{
    "to": ["alice@example.com"],
    "subject": "Re: Proposal",
    "textBody": "Thanks Alice — ...",
    "reply": {
      "inReplyToRfc822Id": "<abc@mail.example.com>",
      "references": ["<root@mail.example.com>", "<abc@mail.example.com>"],
      "providerThreadId": "THREAD_ID",
      "parentProviderMsgId": "PARENT_MSG_ID"
    }
  }'
```

## File a message (read + tag + archive)

```bash
curl -sX POST "http://localhost:8321/api/mail/acct-1/messages/MSG/read" \
  -d '{"read": true}'
curl -sX POST "http://localhost:8321/api/mail/acct-1/messages/MSG/tags" \
  -d '{"add": ["followup"], "remove": []}'
curl -sX POST "http://localhost:8321/api/mail/acct-1/messages/MSG/archive"
```

On IMAP, confirm `followup` is in `GET /mail/:acct/tags` `.userDefined`
first — unknown keywords get dropped.

## Cross-account search → pick account → send

```bash
# Find recipient's earlier emails across all accounts.
curl -s "http://localhost:8321/api/mail/search?q=from:bob@acme.com&limit=10"
# → hits carry accountId. Use whichever account received the earlier thread
#   so the reply comes from a familiar address.

curl -sX POST "http://localhost:8321/api/mail/acct-2/messages/send" \
  -H "Content-Type: application/json" \
  -d '{"to": ["bob@acme.com"], "subject": "...", "textBody": "..."}'
```

Prefer drafts when the message goes to someone the user has not
recently corresponded with — the §"Send vs draft" rule in the skill
body applies whether or not you came from a cross-account search.

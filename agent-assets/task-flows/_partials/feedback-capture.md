# Feedback Capture

When the owner corrects you, states a durable preference about how you work,
or tells you to stop / do more / do less of some behavior, record exactly one
feedback signal before continuing:

```
POST /api/feedback
{
  "source": "explicit",
  "summary": "<one-line durable lesson candidate, max 280 chars>",
  "valence": "correction | negative | positive | neutral",
  "kind": "preference | correction | do-more | do-less | constraint",
  "scope_type": "user | agent | agent_slug",
  "scope_ref": "<agent slug when scope_type is agent_slug>",
  "action_kind": "agent_execution | notification | vault_write | dm_reply",
  "action_ref": "<optional stable id>",
  "evidence": { "excerpt": "<short redacted quote or paraphrase>" }
}
```

Pick scope carefully:
- `user`: a trait or preference of the owner.
- `agent`: feedback about your general operating behavior.
- `agent_slug`: feedback about one named Agent Definition's output; set
  `scope_ref` to that agent slug.

Skip idle chat, one-off task instructions, and your own guesses. The current
conversation already adapts immediately; this call only records durable
feedback for later consolidation.

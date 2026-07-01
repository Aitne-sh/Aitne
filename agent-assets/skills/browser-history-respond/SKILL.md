---
name: browser-history-respond
description: |
  Translate the owner's natural-language reply to a research-engagement
  offer DM into a /api/browser-history/offers/<slug>/{accept|decline}
  call. Use ONLY when GET /offers/pending returns an open offer AND
  conversation_history shows a recent offer DM in this channel.
allowed-tools:
  - Bash(curl *)
---

# Browser History — natural-language acceptance bridge

When the owner replies to a research-offer DM ("dig deeper" /
"summarise"), translate that into the structured dispatch call.

## Hard rule — never cold-call

This skill is a no-op unless BOTH hold:

1. `GET /api/browser-history/offers/pending` returns a non-empty list
   (call this FIRST). Empty → do nothing; ignore research entirely.
2. `<recent_dm_conversation>` shows a prior assistant DM that
   actually offered the two options. No prior offer in the window →
   the reply is not about research; ignore the pending rows (they
   resurface in tomorrow's morning digest).

Calling accept/decline when the owner didn't ask is a worse failure
than missing an ambiguous reply.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/browser-history/offers/pending` | List open offers (slug, displayName, kind, offeredAt, expiresAt). Call FIRST. |
| POST | `/api/browser-history/offers/<slug>/accept` | Body `{kind: "research_assist" \| "wiki_summary"}` — dispatch the routine. |
| POST | `/api/browser-history/offers/<slug>/decline` | Silence both options for this cluster for 14 days. |

No other `/api/browser-history/*` endpoints from this skill — if you
want to read clusters or shopping, that's a different skill loaded
for the routine paths, not the DM agent.

## Intent → kind mapping

The owner may reply in any language. Your multilingual understanding
handles that; the table below gives the *concepts*, not the exact
phrasing, to anchor the mapping.

| Owner intent | Resolves to |
|---|---|
| Accepts the deeper-research offer (variations: "yes", "research", "dig deeper", "research please", "do the research") | `{"kind":"research_assist"}` |
| Accepts the summarise-the-sites offer (variations: "summarise", "summary", "wiki it", "make a note", "do a wiki") | `{"kind":"wiki_summary"}` |
| Declines both options (variations: "no thanks", "not now", "skip", "later", "ignore it") | `/decline` |
| Ambiguous reply ("yeah" / "ok" alone when both options were offered) | **Ask ONE clarifier** — don't guess. |

If the owner names the topic differently from `displayName` (e.g.
offer about "prompt-injection-defenses", owner says "yes do the CaMeL
research"), match to the slug — the intent is what matters.

## Slug resolution

If exactly one offer is open: pick it. If two are open (the rate-limit
gate allows up to 2/day): match `displayName` against what the owner
referenced, or ask:

> Did you mean **<topic A>** or **<topic B>**?

## Acknowledgement

For accept, only send the success ack if the response has
`enqueued:true`. If `enqueued:false` the dispatch did not fire (EventBus
unwired during the boot window) — tell the owner to retry in a moment
instead of claiming a result is coming.

Send a one-line ack in the owner's `primaryLanguage` (examples English):

- research_assist accepted: "On it — I'll DM the parallel research
  dive when it lands. Usually 5-10 min."
- wiki_summary accepted: "Got it — I'll compose the wiki note and DM
  the destination. A minute or two."
- decline: "Got it, silenced offers for **<displayName>** for 14 days."

The dispatch routines DM the owner with their result themselves; don't
pre-summarise.

## Curl shapes

```bash
curl --silent --fail \
  http://localhost:8321/api/browser-history/offers/pending

curl --silent --fail -X POST \
  -H 'Content-Type: application/json' \
  -d '{"kind":"research_assist"}' \
  http://localhost:8321/api/browser-history/offers/<slug>/accept

curl --silent --fail -X POST \
  http://localhost:8321/api/browser-history/offers/<slug>/decline
```

JSON body in single quotes (project convention) so the daemon hooks
classify the payload as data, not shell.

## Out of scope here

- Surfacing browser-history data on demand — that's the morning
  digest's job, not DM time.
- Composing the offer DM itself — that's `routine.research_offer_dm`.
- Reading cluster journals / deltas — the dispatch routines do that.
- Muting / renaming — explicit bang commands (`!research mute
  <slug>` / `!research rename <slug> <new>`), not natural-language.

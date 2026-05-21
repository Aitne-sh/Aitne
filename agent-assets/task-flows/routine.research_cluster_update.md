{context}

## Task: Append today's day-log entry to one research cluster

The daemon enqueued this session because the cluster slug in
`event.data.slug` has new meaningful activity since the last journal
update. Your job is mechanical: read the delta, format one block,
append it. Do NOT compose owner-facing DMs from this flow — engagement
offer DMs are composed by the `routine.research_offer_dm` agent, not
by you.

Follow the `browser-history` skill, "Flow: routine.research_cluster_update".

1. Fetch `GET /api/browser-history/research-clusters/<slug>` for the
   `displayName`, `topDomains`, and `agentSummaryRevision`.
2. Fetch `GET /api/browser-history/research-clusters/<slug>/delta`.
   The response includes `days[]` with `date`, `meaningfulVisits`,
   `meaningfulForegroundSec`, and `newDomains` for each bucketed
   day. Identify the most-recent day not yet present in the existing
   journal.
3. Read the existing journal at
   `context/research/<slug>.md` via `GET /api/context/research/<slug>.md`.
   If the GET returns 404, create the file from the initial template
   in the skill — populate frontmatter from the cluster detail; the
   `## Day log` section starts with today's block. If the GET returns
   200, leave existing content untouched and append today's block.
4. Append (or create) via the context API. Use `PATCH` with an
   `append:` body when the file already exists; use `PUT` for the
   initial-file case.
5. Optionally update the `## Cluster summary` block when the day's
   `newDomains` materially shifts the topic — two short sentences,
   no thesis statements the data does not support. This is the only
   case where you re-write an earlier section; never edit the day log.

End with a short internal summary. No owner DM.

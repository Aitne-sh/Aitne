{context}

## Task: Append the missing day-log entries to one research cluster

The daemon enqueued this session because the cluster slug in
`event.data.slug` has new meaningful activity since the last journal
update. Operate on that **one** slug only — the daemon already selected
the cluster and fans out one event per cluster, so do not list or
iterate clusters. Your job is mechanical: read the delta, format the
day blocks that are still missing from the journal, append them. Do NOT
compose owner-facing DMs from this flow — engagement offer DMs are
composed by the `routine.research_offer_dm` agent, not by you.

Follow the `browser-history` skill, "Flow: routine.research_cluster_update".

1. Fetch `GET /api/browser-history/research-clusters/<slug>` for the
   `displayName`, `topDomains`, and `agentSummaryRevision`.
2. Fetch `GET /api/browser-history/research-clusters/<slug>/delta`.
   The response's `days[]` carries `date`, `meaningfulVisits`,
   `meaningfulForegroundSec`, `newDomains`, and `complete` for each
   bucketed day. `days[]` is ordered **oldest-first** and capped to the
   most recent 31 days. `complete: false` marks the still-accumulating
   current agent day — its counts are not final yet.
3. Read the existing journal at
   `context/research/<slug>.md` via `GET /api/context/research/<slug>.md`,
   and note which `### <YYYY-MM-DD>` headings already appear under
   `## Day log`. If the GET returns 404, the file does not exist yet —
   create it from the initial template in the skill (populate
   frontmatter from the cluster detail). If the GET returns 200, leave
   existing content untouched.
4. Append a block for **every** day in `days[]` with `complete: true`
   whose `date` is not already present under `## Day log`, **oldest
   first** (iterate `days[]` in its natural order). Never append a
   `complete: false` day — its counts are still growing and this ledger
   is append-only, so a premature block would freeze an undercounted
   day forever; it will arrive complete on a later run. This backfills
   any nights the update was skipped or failed — a failed run waits a
   full agent-day before retrying, so missed days accumulate until the
   next successful run, and the 31-day delta window bounds the
   catch-up. Use `PATCH` with an `append:` body when the file already
   exists; use `PUT` for the initial-file case (the first block is the
   oldest missing day). Never rewrite earlier days — this is an
   append-only ledger.
5. Optionally update the `## Cluster summary` block when the new
   `newDomains` materially shift the topic — two short sentences,
   no thesis statements the data does not support. This is the only
   case where you re-write an earlier section; never edit the day log.

End with a short internal summary. No owner DM.

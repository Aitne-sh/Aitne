{context}

## Custom Routine

This is a user-defined recurring check fired from a cron schedule. The
primary-vault file `routines/custom/<slug>.md` (injected above under
"Vault policy files") contains your canonical check list and the reason
it exists.

### Execution

1. Read the policy-file block for this routine. Each `### <label>` entry
   under `## Checks` is one step. Run them in order.
2. Skip any step whose `**Precondition**` is not satisfied. Log skipped
   steps in a single summary line.
3. Respect the budget. The routine file's frontmatter sets
   `max_budget_usd` and `backend_tier`; stop early rather than exceed
   either.
4. For each action, use the same conventions as the other routines:
   - Scheduled actions → append to `today.md` `## Agent Plan` and
     register a matching `POST /api/schedule` row. Use `tier` for the
     row's cost knob; check `GET /api/schedule/options` for the live
     model list when a step needs to pin a specific model id.
   - User-visible findings → route through the `notify` skill only when
     truly urgent. Silent is the default.
   - Observations → consume via `observations` skill if the step pulls
     from pending observations.
5. When all checks complete, append ONE line to `agent/journal.md`
   summarising what ran:
   `- HH:MM [routine.custom.<slug>] ran N checks, skipped M (<reasons>)`.

### What NOT to do

- Do not invent new checks outside the routine file. If the routine file
  says nothing about a given concern, the check does not exist for this
  cadence.
- Do not alter the routine file itself during execution. User edits to
  the rulebook happen out-of-band via DM or the dashboard editor.
- Do not send a notification to confirm "routine ran successfully".
  Silent completion is the expected path.

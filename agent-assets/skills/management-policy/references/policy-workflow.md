---
kind: reference
name: policy-workflow
description: Step 5.1-5.4 dossier → routine → policy file → auto-index fan-out, with curl recipes and rollback ordering.
---

# Step 5 fan-out — dossier → routine → policy file → auto-index

Each step gates the next. If step `N` fails, attempt to roll back
steps `N-1 … 1` in reverse before reporting the failure to the user.

## 5.1 Create the dossier (only if it doesn't exist)

```bash
# Optional — only if the policy accumulates data into a new topic.
curl -sS -X PUT http://localhost:8321/api/context/knowledge/dossiers/<topic> \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{"content":"---\ntype: dossier\nowner: agent\nupdated: 2026-04-24\n---\n# <Topic>\n\n## Daily Log\n"}
JSON
```

Skip this step if `linked.dossier` is not set or the dossier already
exists. The dossier file is data only — no harm if it ends up empty
when the rest of the flow rolls back.

## 5.2 Create the custom routine (only if scheduling is needed)

```bash
curl -sS -X PUT http://localhost:8321/api/context/policies/routines/custom/<slug> \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{"content":"---\ntype: rule\nslug: <slug>\nprocess_key: routine.custom.<slug>\ncron: \"0 7 * * *\"\nbackend_tier: light\nmax_budget_usd: 0.20\nenabled: true\n---\n# <Title>\n\n## Checks\n\n### <step label>\n**Action**: …\n"}
JSON
```

The route's `onCustomRoutinesChanged` hook reloads the cron scheduler
automatically — no separate reload call.

Skip this step if the policy is purely passive (e.g. "from now on,
when the user mentions X in DM, also …"). The policy file itself
documents the rule and the relevant DM / event task-flow picks it up
via the global injection.

## 5.3 Create the policy file

`origin` MUST be a **single-line** YAML scalar. The frontmatter
extractor is line-scalar only — block scalars (`origin: |`,
`origin: >`) are silently truncated to the marker character and the
validator rejects them. If the user's message is too long for one
line, write a short summary in `origin` and put the verbatim quote in
a body section called `## Captured From`.

```bash
curl -sS -X PUT http://localhost:8321/api/context/policies/management-captures/<slug> \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{"content":"---\ntype: rule\nkind: policy\nowner: agent\nupdated: 2026-04-24\nslug: <slug>\nstatus: active\ncreated_at: 2026-04-24\ncreated_via: dm\norigin: \"User DM 2026-04-24T14:30Z: <one-line summary or short quote>\"\nlinked:\n  routine: <slug>\n  dossier: <topic>\ntemplate_version: 1\n---\n# <Title>\n\n## Why\n<one short paragraph>\n\n## How\n1. …\n\n## Source of Truth\n- Authoritative: …\n- Local cache: dossiers/<topic>.md\n\n## Captured From\n> <verbatim DM quote, only when too long for the origin line>\n\n## Notes\n- …\n"}
JSON
```

The global FS-watch reconciler picks this up within ~1 s and the
policy appears in `context-index.md` automatically. The policy-index
reconciler also fires on the same FS event (chained off the same
debounce), so `policies/management-captures/_index.md` and `policies/management.md`'s
`## Active Policies` section refresh within ~10 s — no manual PATCH
needed.

The `linked:` mapping uses nested YAML for human / LLM readability.
The daemon's frontmatter validator does not parse nested keys, but
the **policy-index reconciler does** — it reads `linked.routine` to
populate the cadence column (by reading the routine file's `cron`
field) and `linked.dossier` for the dossier column. Keep the slug
values aligned with the filenames you created at 5.1 / 5.2 so the
reconciler can resolve them.

## 5.4 _(no manual step required)_

`policies/management-captures/_index.md` is auto-maintained by the daemon's
policy-index reconciler — it re-renders within ~10 s of step 5.3's
write. Same for the `## Active Policies` section in
`policies/management.md`. **Do not PATCH or PUT either path manually**;
doing so just races the reconciler and creates snapshot churn.

If you need to confirm the index is up to date before replying to the
user, GET `policies/management-captures/_index` after a short wait. The
reconciler's last-run record lives at `runtime_state` key
`reconciler.policy_index.last_run` for diagnostics.

## Rollback table

| Failure at | Roll back |
|---|---|
| 5.2 | undo 5.1 (`DELETE` the dossier file you just created — only if you created it; do not delete a pre-existing dossier) |
| 5.3 | undo 5.2 (PUT routines file back to `enabled: false` and the next reconcile clears the cron job; or `DELETE` if you created it new), then undo 5.1 as above |
| 5.4 | none required — there is no manual 5.4. If the reconciler does not pick the change up within ~30 s, surface the diagnostics record (`runtime_state` key above) to the user rather than rolling back. |

If any rollback step itself fails, **report the partial state to the
user verbatim** (which slugs / files are in which state) rather than
silently re-attempting. The user can then decide whether to retry,
hand-edit, or accept the partial.

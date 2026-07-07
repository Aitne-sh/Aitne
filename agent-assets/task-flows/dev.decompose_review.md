{context}

# Task Flow: Development Mode — Decompose Review Leg

A model split the owner-approved master contract into parallel tasks. If you
approve, each task runs as an unattended loop in its own git worktree and the
results are merged back — against goalposts the decomposer set. You did not
write this plan; judge it fresh. You are **read-only**: you render a verdict,
you change nothing.

The daemon has ALREADY validated mechanics (unique ids, existing + acyclic
DEPENDS, REQ coverage, task count, and — for a REQ shared by several tasks —
that the sharers have a single completing owner: a strictly sequential DEPENDS
chain, or a fork-join whose final owner depends on every other owner). Do not
re-litigate those. You judge only what needs a model.

Read, in this order:

1. `.aitne-dev/docs/product-contract.md` — the approved master contract
2. `.aitne-dev/docs/task-plan.md` — the generated plan (rationale + TASK blocks)
3. `.aitne-dev/docs/loop-config.json` — the master stop conditions
4. Enough of the repository to judge the scope claims: do the named files/areas
   exist? Would these tasks really not touch the same code?

## Judge — REVISE if ANY of these fails

- **Faithful coverage**: the tasks together implement the WHOLE master
  contract — no silently narrowed scope, no invented extra work that changes
  the task, no REQ assigned to a task that cannot own it.
- **Real disjointness**: the SCOPE boundaries hold in THIS repository. Two
  tasks whose requirements land in the same files/modules (shared registries,
  route tables, config files, central types) must be one task or a DEPENDS
  chain — parallel is an automatic REVISE.
- **Justified dependencies**: every DEPENDS edge is real (the dependent task
  needs the dependency's merged code), and no dependency is missing that the
  code structure clearly requires.
- **Executable bodies**: each BODY is self-contained — goal, owned REQ ids,
  scope boundary, do-not-touch areas, and how success is verified. A body an
  agent could misread into a sibling's scope is a REVISE.
- **Sane split**: the split is profitable. Tasks so small or so entangled that
  the merge/review overhead outweighs the parallelism should be merged into
  fewer tasks.
- **Sound phases**: where several tasks share a REQ (a phased chain or a
  fork-join), every DEPENDS edge is a real sequencing need (later phases build
  on earlier merged code); the phase/branch bodies partition the shared REQ
  without gaps or overlaps (each states what "done for this phase" observably
  means); and the COMPLETING OWNER's body (the chain's last task, or the
  fork's join) certifies the REQ in full. For a fork-join additionally judge:
  the branches are genuinely independent in this repository (disjoint
  files/areas — overlapping branches are a REVISE), and the join actually
  integrates and verifies the combined result rather than rubber-stamping it.
  A "chain" that is really independent work, or a completing owner that does
  not close the REQ, is a REVISE. Conversely, a single task obviously too
  large for one worker's iteration budget should be REVISEd into phases.

Do NOT reject for: implementation details left open (implementation stays
flexible), style or wording, a conservative n=1 plan.

## Final response

Short analysis first. The LAST line of your reply must be exactly one of:

- `DECOMPOSE-REVIEW: APPROVE <one line: why these boundaries can be trusted unattended>`
- `DECOMPOSE-REVIEW: REVISE <numbered must-fix items, semicolon-separated>`

Plain text, no code fence. Keep the `DECOMPOSE-REVIEW:` keyword and the
APPROVE/REVISE verdict word in ASCII exactly; they are machine-parsed.

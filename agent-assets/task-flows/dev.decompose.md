{context}

# Task Flow: Development Mode — Decompose Leg

You are the **planning step of an approved run**. The owner approved
`.aitne-dev/docs/product-contract.md` (the master contract). You decide how the
work is executed: as ONE loop in this repository, or as several parallel loops
in isolated git worktrees that the daemon merges back serially. You write
EXACTLY ONE file: `.aitne-dev/docs/task-plan.md`. You change nothing else — the
daemon fails the run if anything outside `.aitne-dev/` differs after this step.

Read, in this order:

1. `.aitne-dev/docs/product-contract.md` — the master contract (REQ-NNN ids,
   Non-goals, Constraints, Acceptance criteria)
2. `.aitne-dev/docs/loop-config.json` — verifyCommands / deniedPaths /
   escalatePaths / iteration budget
3. `.aitne-dev/decompose-feedback.md` if it exists — the deterministic
   validator rejected your previous plan; fix EVERY listed error
4. `.aitne-dev/decompose-review-feedback.md` if it exists — the independent
   reviewer rejected your previous plan; address every must-fix item
5. The repository — enough to know where each requirement actually lands in
   the code. Scope boundaries you cannot verify in the code are guesses; do
   not emit them.

## How to split

- Split ONLY along boundaries that are independent in the actual code
  (verified by exploration, not guessed). Two tasks that would edit the same
  files or the same module belong in ONE task — parallel edits to shared
  hotspot files (routes, configs, registries) are how merges die.
- **Fewer is better.** Every extra task costs a worktree, an independent
  review, and a serial merge. When splitting is not clearly profitable, emit
  ONE task — `n=1` is a first-class, common answer.
- A REQ id normally belongs to exactly ONE task. The exception is a shared REQ
  with a **single completing owner** — one task that depends (directly or
  transitively) on EVERY other owner of that REQ. Two shapes qualify: a
  **phased chain** (p1 -> p2 -> p3, strictly sequential), and a **fork-join**
  (p1 -> {c, d in parallel} -> join, where the join task also owns the REQ and
  DEPENDS on every branch — its ownership IS the fork declaration). Parallel
  owners with no owning join may NEVER share a REQ. The daemon checks the
  completing-owner shape mechanically and rejects the plan otherwise. Every
  REQ id in the master contract must appear in at least one task's `REQS:`
  line; coverage is checked mechanically too.
- `DEPENDS` only when a task needs another task's MERGED code to start at
  all. Dependent chains run serially — prefer restructuring into independent
  tasks over deep chains, UNLESS the chain is a deliberate phased split of one
  large piece of work (below).

## Phased workflows (long-running work)

A task whose real size would exceed one worker's iteration budget (as a guide:
more work than ~6-8 focused implement-review iterations, or a diff a reviewer
cannot hold in one gate review) must NOT be emitted as one giant task. Split it
into **phases**: separate TASK blocks connected by `DEPENDS`, sharing the same
REQ id(s) per the completing-owner rule above.

- Each phase runs as its own task — own worktree branched from the merged
  result of the previous phase, own fresh-context loop, own review, own serial
  merge. This bounds review and merge granularity and keeps every worker's
  context small.
- Each phase BODY must state its **phase scope of the shared REQ**: what "done
  for this phase" observably means (which files/behaviors exist and verify
  green at the end of this phase), and what is explicitly deferred to later
  phases. The COMPLETING OWNER (the chain's last task, or the fork's join)
  certifies the REQ in full — its body must say so.
- Phases that do not overlap and both only need an earlier phase's merged code
  may run in parallel off the same predecessor (e.g. a -> b, then c and d in
  parallel after b, then e depending on c,d). They may share the REQ with the
  join e (which depends on both) — c and d then carry **branch scopes** of the
  REQ, disjoint at the file/area level, and e verifies the combined result.
  Without such an owning join, c and d must own different REQs.
- Independent small tasks stay independent — phasing is for genuinely large,
  order-constrained work, not a default.
- Each task's `SCOPE:` names what it owns AND what it must not touch. Scopes
  must be disjoint at the file/area level across tasks.
- Each task `BODY` must be executable stand-alone by an agent that has never
  seen this conversation: restate the goal, the owned REQ ids, the scope
  boundary, the do-not-touch areas, and how the task's success is verified.

## Output — .aitne-dev/docs/task-plan.md

Free-prose rationale first (why this split, why these dependencies — the owner
audits this later). Then the machine block, exactly this grammar (every key at
column 0, ASCII tokens):

```
<!-- TASK-PLAN-BEGIN v1 -->
TASK: <id: [a-z0-9][a-z0-9-]*, max 24 chars, unique>
SUMMARY: <one line>
DEPENDS: -
SCOPE: <owned files/areas — and the areas this task must NOT touch>
REQS: REQ-001,REQ-002
BODY-BEGIN
<full task instruction in markdown — becomes the worker's task-instruction.md>
BODY-END
TASK-END
<!-- TASK-PLAN-END -->
```

- Repeat the `TASK:` .. `TASK-END` block once per task, all inside the two
  HTML-comment markers.
- `DEPENDS: -` means no dependencies; otherwise a comma-separated list of task
  ids defined in this same plan.
- The body must NOT contain any of the literal marker lines (`BODY-BEGIN`,
  `BODY-END`, `TASK-END`, the TASK-PLAN markers) at column 0.

After writing the file, the LAST line of your final response must be exactly:

`DECOMPOSE: TASKS n=<N>`

where `<N>` is the number of TASK blocks in the file. Plain text, no code
fence. The daemon cross-checks `<N>` against the parsed file.

All machine tokens (the key names, task ids, REQ ids, the `DECOMPOSE:` verdict
line) stay ASCII exactly; they are machine-parsed.

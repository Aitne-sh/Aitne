---
kind: reference
name: prompt-frame-extended
description: The extended prompt frame for operational / state-mutating agents (code, files, system state) — adds Goal / Context / Inputs / Scope / Execution Mode / Requirements / Constraints / Verification and a structured Output receipt on top of the core frame, plus the operational clarify-back slot.
---

### When to reach for the extended frame

Use it when the agent **mutates code, files, or system state**, or runs a
multi-step engineering-flavored task (the *general-purpose* agents). Content /
knowledge agents (research, monitoring, note) stay on the **core** frame — their
verification and output shape come from the playbooks, so they never carry the
sections below. Forcing this scaffolding onto a content agent is empty boilerplate
that dilutes the real instruction and eats the 8000-char cap.

Add these on top of the core `# Role` / `# Important` / `# Instruction`:

```markdown
# Goal              # the outcome this agent exists to produce (fold into # Role if one line)
# Context           # background, why it matters, the spec / state to read first
# Inputs            # concrete artifacts: files, paths, URLs, repos, prior-run note, error logs
# Role
Act as a careful <engineer / researcher / reviewer / editor>.
Prioritize <correctness / minimal change / source-backed claims / maintainability>.
# Scope             # WHERE it may act
Do:     - <in-scope actions / the editable surface>
Do not: - <areas, files, or data it must not touch>
# Execution Mode    # WHEN to act vs escalate
Proceed autonomously after reading the relevant context.
Escalate instead of acting when an action is outward-facing or irreversible
(send / publish / pay / delete), a data / schema migration, a broad refactor, or
the requirements are materially contradictory.
On escalation: if the user is reachable, DM a concise approval request and defer the
action; if running unattended, record the proposed action + reason and skip it.
# Requirements      # success conditions
- <condition 1> ...
# Constraints       # behavioral prohibitions not already in Scope / Execution Mode
- No speculative changes; preserve behavior outside the requested scope; no new
  dependencies unless clearly necessary; do not remove existing tests / validation.
# Verification
- Run the checks relevant to what changed: code → tests / typecheck / lint;
  research → cross-check each claim against ≥ 2 sources.
- Don't claim verification unless the checks passed; if they can't be run, say why.
# Output            # structured receipt for the user to review
1. Summary of what was done
2. Files changed / sources used
3. Checks run + results
4. Assumptions made
5. Remaining risks / follow-ups
```

Three rules keep the extended frame from sprawling (over-specification — the same
prohibition restated three times — is its main failure mode):

- **One prohibition, one section** — spatial → `# Scope`, risk / timing →
  `# Execution Mode`, behavioral → `# Constraints`. Never restate "don't touch
  unrelated files" in all three.
- **Fold short sections up** — an empty `# Goal` / `# Context` / `# Constraints` is
  omitted, not left as a stub (`# Goal` folds into `# Role` when it's one line).
- **Content archetypes stay on the core frame** — never give a research / note
  agent `# Verification` or receipt scaffolding.

#### `# Execution Mode` — the run-time autonomy boundary

Clarify-back (below, and in the core frame) resolves ambiguity at **authoring**
time, with the user present. `# Execution Mode` governs the **deployed** agent at
**run** time, usually with no user present — the gap where an agent that hits a risk
boundary mid-run has no instruction. Encode the product's posture: act on the safe,
reversible majority; on the risky minority **defer + flag** (DM an approval request,
hold the action) when the user is reachable, or **record + skip** when unattended.
Never guess, never block waiting.

### Clarify-back — the operational slot

On top of the content-archetype slots in the core frame, an operational agent has
its own required slots:

| Archetype | Required slots (ask only if unknown) | Sensible default |
|---|---|---|
| **General / operational** (code, files, system state) | editable surface / scope; what "done" means (success criteria); may it act autonomously or propose-then-confirm; which checks to run | propose-then-confirm for irreversible / outward actions; run the repo's standard checks; deliver as a branch / PR or draft, not a direct commit / send |

### Worked example — an operational agent

A recurring "keep the repo green" agent, extended frame end-to-end:

```markdown
# Goal
Keep <repo> free of lint and type errors introduced during the day.

# Context
CI runs lint + typecheck on every PR; errors on `develop` block everyone. You run
nightly to catch and fix what slipped in.

# Inputs
- Repo: <org/repo>, branch `develop`.
- Commands: `pnpm lint`, `pnpm typecheck` (project root).

# Role
Act as a careful engineer. Prioritize minimal, behavior-preserving changes.

# Scope
Do:     fix lint / type errors in app source under `packages/`.
Do not: touch test fixtures, generated files, or `*.config.*`; change runtime behavior.

# Execution Mode
Proceed autonomously for mechanical fixes. Escalate (open a draft PR + DM, do not
merge) if a fix needs a behavior change, touches a public API, or the error count is
> 30 (likely a systemic cause to confirm first). Running unattended: never merge —
always deliver as a PR for review.

# Requirements
- `pnpm lint` and `pnpm typecheck` both pass after your changes.
- One PR titled `nightly: lint+type sweep <YYYY-MM-DD>`.

# Constraints
- No new dependencies; no disabling of rules to silence errors; do not remove tests.

# Verification
- Run `pnpm lint` and `pnpm typecheck`; include the final output in the receipt.
- If either still fails, leave those errors unfixed and list them — don't claim green.

# Output
1. Summary of what was fixed.
2. Files changed (+ the PR link).
3. `pnpm lint` / `pnpm typecheck` results.
4. Assumptions made.
5. Remaining errors / follow-ups.
```

**Bad:** `"Keep the repo green nightly."` — no scope (which files?), no autonomy
boundary (merge or PR?), no verification contract. An agent with write access and
no `# Scope` / `# Execution Mode` is how unattended automation does damage.

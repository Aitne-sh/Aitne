# agent-assets/templates/

Source templates used by the daemon at **fresh install** time to populate
`~/.personal-agent/context/` with the CONTEXT_VAULT_REDESIGN six-class
layout (`identity/`, `state/`, `plans/`, `journal/`, `knowledge/`,
`policies/`). The daemon copies system / pass-through assets from here
directly. User-facing scaffolds that must follow `primary_language` are
seeded by the `setup.initial` agent flow.

**Language policy (B-007 §3 P6, unified through
`docs/design/appendices/output-language-policy.md`)** — template source
lives here in English. The runtime rule is now carried by the
`<output_language_policy>` block emitted by ContextBuilder, so every
flow that writes a scaffold or refreshes one of these files follows one
shared policy reference instead of restating language wording per flow.
System prose templates (`policies/redaction.md`, `journal/agent.md`,
`.base` files, and the reconciler-block portion of `_index.md`) stay
English regardless of locale (Policy A). User-facing scaffolds
(`state/today.md`, `plans/roadmap.md`, `_index.md`,
`policies/routines/*.md`, `policies/journal-format.md`,
`policies/journal-export.md`, `identity/profile.md`) keep the template
H2/H3 headers (skeleton, Policy B) and their body is filled in
`primary_language` by the setup conversation before `save-rules`
finalizes setup.

Two rendering paths:
1. **Pass-through** — the file is copied verbatim. Used for system prose
   and `.base` files.
2. **Localized scaffold** — the setup conversation uses these files as the
   English reference for the shape of user-facing notes, then writes the
   actual runtime file in `primary_language` via the context API.

Files prefixed `_` (e.g. `_active.base`) are Obsidian sidebar-sort
conventions — the leading underscore floats them to the top.

**`state/today.md` and `plans/roadmap.md`** are shape-canary templates.
They are copied verbatim by `skeleton.ts:ensureSkeletonFiles` when the
templates tree is reachable; when the tree is unreachable, `skeleton.ts`
falls back to an inline literal in `FALLBACK_PLACEHOLDERS` that is kept
byte-equal to these template files. A unit test
(`packages/daemon/src/core/skeleton.test.ts:"shape canary ..."`)
asserts this equality on every CI run, so a PR that updates one path
without the other fails at review time. Edit the template file; the
inline fallback and any relevant validators must be updated in the
same PR.

## Template versioning — upgrade contract (course 4 of the design audit)

Every template file whose content may evolve carries a
`template_version: N` field in its YAML frontmatter. The shipped
inventory lives at `_manifest.json` (auto-generated) alongside the
templates. When a template's format changes:

1. **Bump `template_version` in the template file's frontmatter** (e.g.
   1 → 2 when `policies/management.md` gains a new required section).
2. **Regenerate `_manifest.json`** so the `version` entry matches. A
   unit test (`template-versions.test.ts:"shipped manifest consistency"`)
   fails the build if the two disagree.
3. **Ship the release.** On the user's next daemon start,
   `checkTemplateUpgrades` (`packages/daemon/src/core/template-versions.ts`)
   walks each user-side file, reads its `template_version` from
   frontmatter, compares against the manifest, and persists the pending
   list in `runtime_state.templates.pending`. `/api/health.templatesPending`
   surfaces the list for the dashboard.

### What is NOT done automatically

- **No content overwrite.** The detection is observational only. The
  user's current file is left untouched; a merge-aware "apply upgrade"
  UX is scheduled for a later phase.
- **No alert for user-rewritten files.** If a user stripped the
  `template_version:` field entirely (or replaced the file with
  something unrelated), the daemon treats it as user-owned and stays
  out of the way.
- **No alert when the user version is AHEAD of the manifest.** Advanced
  users can lock a file at a custom version to prevent spurious
  pending-upgrade signals.

### Files excluded from versioning

- `state/today.md`, `plans/roadmap.md`, `plans/projects/_active.base` —
  no frontmatter to carry the marker. These files are shape canaries /
  Obsidian view configs that evolve through schema validation, not
  template diff.
- `README.md` (this file) — documentation, not a template.

Bump `manifestVersion` in `_manifest.json` only when the manifest
schema itself changes (e.g. a new per-entry field). Individual
template-version bumps leave `manifestVersion` alone.

See `docs/design/06-memory.md` and `docs/design/12-configuration.md` for the
fresh-install flow and vault layout. The `policies/management.md` template
follows the structured `schema_version: 3` registry specified in
`docs/design/21-management-registry-and-entities.md` (A. SoT bindings,
B. Managed tasks, C. Active-Policies stub) — the v2 "Default Schedules"
section has been retired (§21 §8.10); do not reintroduce it.

## Skills

You have access to skills materialized under `.codex/skills/` (or
`.gemini/skills/` when running Gemini). Each skill is a small markdown
file with frontmatter (`name`, `description`, `allowed-tools`) followed
by guidance and worked examples.

All skills require: `Bash(curl *)` for daemon API calls, `Read` for
on-demand `SKILL.md` introspection. Skills with additional tool
requirements declare them in their own `SKILL.md` frontmatter — `Read`
the file to see the full list before invoking those tools.

Before acting on a user request:

1. Scan the `<skill-index>` below for a skill whose `description` matches
   your task.
2. If one matches, `Read` `.codex/skills/<name>/SKILL.md` (or
   `.gemini/skills/<name>/SKILL.md`) and follow its contents. The path is
   fixed by the header sentence inside `<skill-index>`; the `<name>` comes
   verbatim from the entry.
3. You may load multiple skills in a single turn.
4. Do not invent skill names — only use entries listed in `<skill-index>`.

The directory under `.codex/skills/` (or `.gemini/skills/`) is the
authoritative source of skill content. Anything inlined in this system
prompt above is supporting context only.

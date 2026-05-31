---
schema_version: 1
slug: reference/disallowed-tools
title: Disallowed Tools (Reference)
id: disallowed-tools-ref
aliases:
  - disallowed tools
  - blocked tools
  - deny list
  - absolute block
category: reference
summary: |
  The absolute-block tool patterns. Cannot be widened by config or
  by skill-level allow-lists. Mirrors src/safety/always-disallowed.ts.
section: reference
tags:
  - reference
  - safety
  - core
  - audit
status: stable
ask_examples:
  - What can the agent never run?
  - Can I unblock a tool in the absolute-block list?
  - Why can't the agent read my .env or SSH keys?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - disallowedTools
  - deniedTools
  - absolute block
  - always-disallowed
  - Bash(rm -rf)
  - PreToolUse
  - blocked_absolute
related:
  - concepts/safety-and-execution
  - concepts/safety-model
---

# Disallowed Tools

There are two distinct deny layers — the **absolute-block layer**
(non-overridable) and the **default strict-mode list** (in `config.ts`,
relaxable in Allow mode or via `allowedToolsOverride`).

## Absolute-block layer (cannot be widened past)

These patterns are denied unconditionally regardless of execution mode
or `allowedToolsOverride`. Source of truth:
`packages/daemon/src/safety/always-disallowed.ts`.

| Category | Examples |
|---|---|
| Recursive delete | `Bash(rm -rf *)`, `Bash(rm -r *)`, `Bash(rm -R*)`, `Bash(rm -fr*)`, `Bash(rm --recursive*)`, plus the bypass-coverage family of every short-flag bundle containing `r`/`R` (see source) |
| Privilege escalation | `Bash(sudo *)`, `Bash(doas *)`, `Bash(su *)` |
| Pipe-to-shell RCE | `Bash(curl * | sh*)`, `Bash(curl * | bash*)`, `Bash(wget * | sh*)`, `Bash(wget * | bash*)`, `Bash(bash <(*)*)`, `Bash(sh <(*)*)`, `Bash(bash<*)`, `Bash(sh<*)`, `Bash(eval *)`, `Bash(source *)` |
| Platform secret-management CLIs | `Bash(security *)` (macOS Keychain), `Bash(secret-tool *)` (libsecret), `Bash(cmdkey *)` (Windows Credential Manager), `Bash(certutil *)` and `Bash(rundll32.exe *)` (Windows DPAPI / vault dump) |
| Secret-file reads | `Read(.env)`, `Read(.env.*)`, `Read(**/.env)`, `Read(**/.env.*)`, `Read(id_rsa*)`, `Read(id_ed25519*)`, `Read(~/.ssh/**)`, `Read(~/.gnupg/**)`, `Read(~/.aws/**)`, `Read(~/.config/gcloud/**)`, `Read(~/.config/gh/hosts.yml)`, `Read(~/.netrc)`, `Read(~/Library/Keychains/**)`, `Read(~/.local/share/keyrings/**)` |
| Daemon-managed secret surfaces | `Read(~/.personal-agent/backups/**)`, `Read(~/.personal-agent/whatsapp/auth/**)`, `Read(~/.personal-agent/secrets/**)` |
| Browser-history profile dirs | `Bash(sqlite3 *)`, `Bash(curl file://*)`, `Bash(cp ~/Library/Application Support/Google/Chrome/*)` (Chrome / Chromium / Edge / Brave / Comet / Atlas on macOS, Linux, and `/mnt/c/Users/*` for WSL), plus the matching `Read(...)` patterns — access goes through `/api/browser-history/*` only |
| Managed-Chromium profile dirs | `Read(~/.personal-agent/chromium-sync/**)`, `chromium-automation{,-anon,-auth,-purchase}/**`, and `Bash(cp …)` / `mv` / `tar` / `zip` / `rsync` of `~/.personal-agent/chromium-*` — protects the daemon-owned OAuth refresh token |
| Anthropic-cloud managed agents | `CronCreate`, `CronList`, `CronDelete`, `RemoteTrigger`, `PushNotification` — Aitne is local-first; cloud-scheduled agents would bypass the audit log, MD memory, quiet hours, and cost telemetry |
| Secret-file writes | `Write(...)` and `Edit(...)` mirrors of every Read pattern in the secret-file and profile-dir rows above |

Plain `curl` / `wget` are intentionally **not** in this list — skills
rely on `curl http://localhost:<port>/api/...` as the daemon-API
chokepoint for memory writes (including the browser-history and
managed-Chromium chokepoints above).

> **Codex allow-mode gap.** Codex CLI has no hook or admin-policy
> surface for shell commands, so allow mode runs under
> `--dangerously-bypass-approvals-and-sandbox` and the absolute-block
> layer can't enforce on Codex there. Claude, Gemini, and OpenCode
> enforce it in every mode. See [Safety and Execution](../concepts/safety-and-execution.md)
> for the accepted gap.

## Default strict-mode list (relaxable)

`config.ts > disallowedTools` ships with additional defaults that the
operator can widen out of via `allowedToolsOverride` or by switching
to Allow mode. These include `Bash(chmod *)`, `Bash(chown *)`,
`Bash(git push --force *)`, `Bash(git reset --hard *)` and a handful
of other footgun patterns. They are **not** in the absolute-block
layer — Allow mode permits them.

## Audit log

Every absolute-block match is logged as
`agent_actions(action_type='blocked_absolute')` with a redacted form
of the offending argument and the matched category. The classifier
that produces the category is `classifyAbsoluteBlock` in
`src/safety/always-disallowed.ts`; browser-profile and managed-Chromium
attempts route through `classifyChromiumTokenAccess` /
`looksLikeBrowserProfileBash` in the same module.

The `blocked_absolute` row is written on Claude (a PreToolUse `block`
hook on top of the SDK `disallowedTools` glob list) and on Codex,
Gemini, and OpenCode (a stream observer that classifies each attempted
command, recording `result='partial'`). You can review these in
`aitne audit` (e.g. `aitne audit --type blocked_absolute`) or under
[Activity](/activity?tab=system) in the dashboard.

## Related

- [Safety and Execution](../concepts/safety-and-execution.md) — how Safe vs Allow mode interacts with this layer
- [Safety Model](../concepts/safety-model.md) — the broader risk-classification picture

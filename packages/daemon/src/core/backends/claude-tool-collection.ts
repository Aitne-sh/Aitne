/**
 * Claude tool surface — pure helpers split out of `claude-code-core.ts` as
 * part of the file-split plan (Tier 2, §8). Owns five responsibilities:
 *
 *  - `getAllowedTools` — assemble the SDK `allowedTools` list from the
 *    configured default + the runtime override + any delegated- and native-
 *    integration tools the registry exposes.
 *  - `getDelegatedClaudeTools` — read the current `integrations` registry
 *    state and project it through `computeDelegatedClaudeTools`. Returns
 *    `[]` when the MCP context is not yet wired or on DB read failure.
 *  - `getNativeClaudeTools` — same shape as `getDelegatedClaudeTools` but
 *    projects through `computeNativeClaudeTools` (native-mode parallel).
 *  - `getSessionDeniedTools` — DELEGATED-MODE-V2-DESIGN.md §4.3.3 — expand
 *    per-integration `deniedTools` into namespaced tool names that the SDK
 *    rejects via `disallowedTools` regardless of the allow list.
 *  - `buildSecurityHooks` — build the PreToolUse hook record that enforces
 *    curl localhost-only, jq env/file-flag denials, context-dir chokepoint,
 *    vault write attribution, and the absolute-block audit layer.
 *
 * Pattern A (file-split-plan §5): each function reads its dependencies via
 * an explicit argument record rather than `this.<field>`. The pure shape
 * means these can be unit tested without instantiating `ClaudeCodeCore`,
 * and lets tests inspect the hook closures directly. Thin shims on
 * `ClaudeCodeCore` (`private getAllowedTools(...) { return ... }`) remain
 * for the transitional period (file-split-plan §15).
 */

import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { collectSessionDeniedTools } from "@aitne/shared";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath, isAbsolute } from "node:path";
import type Database from "better-sqlite3";

import type { AgentConfig } from "../../config.js";
import { getContextDir } from "../../config.js";
import { readIntegrations } from "../../db/integrations-store.js";
import { recordAbsoluteBlockAudit } from "../../safety/absolute-block-audit.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import {
  classifyAbsoluteBlock,
  stripBashHeredocs,
  stripBashStringContent,
} from "../../safety/always-disallowed.js";
import { createLogger } from "../../logging.js";
import { computeDelegatedClaudeTools, computeNativeClaudeTools } from "./claude-probe.js";
import { isPathInsideOrEqual, shellPathForms } from "../path-compat.js";

/**
 * Resolve a path through symlinks, even when the leaf does not yet exist.
 *
 * `fs.realpathSync` throws ENOENT on a non-existent leaf, which is the
 * common case for a Write hook (the target file is the *next* write).
 * Walk upwards until an existing ancestor is found, realpath that, then
 * rejoin the missing suffix. Used by both `fileWriteHook` and
 * `bashContextWriteHook` to defeat symlink-based bypasses that point
 * back into the context dir.
 */
function realpathLenient(absPath: string): string {
  const segments: string[] = [];
  let current = absPath;
  // Hard ceiling on iterations so a pathological path never spins forever.
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(current);
      return segments.length === 0
        ? real
        : resolvePath(real, ...segments.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absPath;
      segments.push(current.slice(parent.length).replace(/^[/\\]+/, ""));
      current = parent;
    }
  }
  return absPath;
}

/**
 * Best-effort shell tokenizer for path-token scanning. Splits on
 * whitespace while honouring single, double, and back-tick quotes; ignores
 * shell operators (`|`, `;`, `&`, `<`, `>`, parentheses). Returns tokens
 * with their quote wrappers stripped.
 *
 * Not a full shell parser — it cannot resolve variable expansions,
 * subshells, or function definitions. Exists to surface *literal* path
 * arguments so that an obvious form like
 * `echo > /Users/alice/.personal-agent/context/today.md` is caught. The
 * absolute-block layer is the authoritative defence for the things this
 * heuristic misses.
 */
function tokenizeShellCommand(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|\$\(([^)]*)\)|([^\s|;&<>()]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cmd)) !== null) {
    const tok = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
    if (tok.length > 0) tokens.push(tok);
  }
  return tokens;
}

/**
 * Expand the leading `~`, `$HOME`, and `${HOME}` segments of a token
 * to the supplied home directory. No other shell expansion is performed.
 */
function expandHomeForms(token: string, home: string): string {
  if (token === "~") return home;
  if (token.startsWith("~/")) return home + token.slice(1);
  if (token.startsWith("$HOME/")) return home + token.slice(5);
  if (token.startsWith("${HOME}/")) return home + token.slice(7);
  if (token === "$HOME" || token === "${HOME}") return home;
  return token;
}

/**
 * Decide whether a shell token (after `expandHomeForms` normalisation)
 * resembles a filesystem path argument. Replaces the older "contains
 * `/` or `\`" filter, which false-positived on quoted JSON bodies and
 * HTTP header values whenever the session cwd was inside the data dir
 * (production cwd is `<dataDir>/agent-sessions/<id>`):
 *
 *   - `Content-Type: application/json` → `/` inside `application/json`
 *     was treated as a path separator, the token was resolved relative
 *     to the (data-dir-internal) cwd, the resulting candidate landed
 *     inside `absDataDir`, and the hook blocked an otherwise benign
 *     `curl -X PATCH -H '...'` invocation.
 *   - `'{"content":"line1\nline2"}'` → the literal `\` in `\n` triggered
 *     the same data-dir resolution path even though the token is a JSON
 *     payload, not a filename.
 *
 * The shape rules below are deliberately positive (a token must look
 * like a path) rather than negative (skip if it contains JSON chars):
 *
 *   1. Absolute on POSIX (`/foo`) — also catches tokens that
 *      `expandHomeForms` rewrote from `~` / `$HOME` / `${HOME}` forms.
 *   2. Explicit relative anchor (`./foo`, `../foo`, exactly `.` / `..`).
 *   3. Unresolved home / env-var prefix that survived `expandHomeForms`
 *      (e.g. `~user/foo`, `$OTHER/foo` when the variable is unknown).
 *      Treating these as path candidates is a defensive belt — the
 *      static analysis can't know what they expand to at runtime, so
 *      err on the side of forwarding them through the data-dir check.
 *   4. Bare multi-segment path made of filename-safe characters
 *      (`context/today.md`, `agent-sessions/foo/bar`). The character
 *      class deliberately excludes whitespace, `:`, `=`, `{`, `}`,
 *      `"`, `'`, `` ` ``, `?`, `*`, `<`, `>` — all of which appear in
 *      header values, JSON bodies, and query strings but never in
 *      well-formed filename segments.
 *
 * URL-shaped tokens (`http://...`) are filtered by the caller before
 * this helper runs, so rule 1 / rule 4 cannot misfire on them.
 */
function looksLikePathArg(token: string): boolean {
  if (token.length === 0) return false;
  // Rules 1 + 2 — POSIX-absolute or anchored-relative.
  if (token.startsWith("/")) return true;
  if (token === "." || token === ".." || token.startsWith("./") || token.startsWith("../")) {
    return true;
  }
  // Rule 3 — unresolved home / env-var prefix.
  if (token.startsWith("~") || token.startsWith("$")) return true;
  // Rule 4 — bare relative path with filename-safe segments only.
  // `[A-Za-z0-9_.\-+@]` is the segment alphabet — broad enough to
  // cover typical project filenames (dashes, underscores, dots,
  // version suffixes, `@scope/pkg` style) without admitting tokens
  // that came from a JSON body or header value. The trailing `/?`
  // tolerates a directory-shape suffix (`context/`).
  if (/^[A-Za-z0-9_.\-+@]+(?:\/[A-Za-z0-9_.\-+@]+)+\/?$/.test(token)) {
    return true;
  }
  return false;
}

const logger = createLogger("claude-tool-collection");

/** Default allowed-tools list when the dashboard override is unset. */
export const CLAUDE_DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Skill", // user skills (external-services, obsidian-*, observations, ...)
  "Bash(curl *)", // curl broadly allowed; hooks restrict to localhost
  "Bash(git *)", // Git operations
  "Bash(jq *)", // safe JSON post-processor for curl pipelines
] as const;

/**
 * Allowed tools whitelist for dontAsk permission mode.
 *
 * `delegatedTools` and `nativeTools` are UNION'd onto the returned list —
 * even when `allowedToolsOverride` is set. This is a deliberate deviation
 * from the override's otherwise-absolute "replace everything" contract (see
 * `CRITICAL_OVERRIDE_TOOLS` in `claude-code-core.ts`, which warns but does
 * not union). Rationale: delegated / native modes are runtime-configurable
 * axes orthogonal to the dashboard's tool-customization override. If a user
 * set the override before flipping an integration, silently dropping the
 * registry-declared connector tools would break mail/calendar with a
 * misleading "permission denied" DM. Union semantics keep the override's
 * curation intent while letting either mode widen the surface to whatever
 * the registry already advertised.
 *
 * Native and delegated lists are accepted separately (rather than a single
 * `extraMcpTools` parameter) so callers — and tests — surface the
 * provenance of every widening: an audit log entry with
 * `delegatedToolCount` and `nativeToolCount` makes a misconfigured flip
 * diagnosable without re-running the resolver.
 */
export function getAllowedTools(
  config: Pick<AgentConfig, "allowedToolsOverride">,
  webSearchEnabled: boolean,
  delegatedTools: readonly string[] = [],
  nativeTools: readonly string[] = [],
  // WIKI_BUILDER_DESIGN.md §4.3 — wiki.ingest_url turns need WebFetch on
  // top of the default surface to read external pages (the `Bash(curl *)`
  // PreToolUse hook keeps curl restricted to localhost). Gated on the
  // same `!allowedToolsOverride` clause as `webSearchEnabled` so a user
  // who configured a custom override gets the override verbatim — they
  // are expected to add `WebFetch` themselves if they need it (matches
  // the WebSearch contract; documented in /settings/wiki).
  wikiUrlFetchEnabled = false,
  // Wiki sessions must write only through the daemon Wiki API
  // (`POST /api/wiki/<ws>/files/...`) — every wiki.* process key has a
  // skill body and the wiki-agent profile both stating "no `Write` /
  // `Edit` against the vault." Skill frontmatter `allowed-tools` is
  // human-facing metadata and does NOT propagate into the SDK's
  // session-level allowlist, so without this hard strip a wiki turn
  // can bypass the API path-classifier, the agent_actions audit row,
  // and the result-processor's write-verifier by Writing a vault
  // path directly. Pass true for any `processKey.startsWith("wiki.")`.
  wikiApiOnlyWrites = false,
): string[] {
  const base = config.allowedToolsOverride ?? [...CLAUDE_DEFAULT_ALLOWED_TOOLS];
  const merged = new Set<string>(base);
  if (!config.allowedToolsOverride && webSearchEnabled) {
    merged.add("WebSearch");
  }
  if (!config.allowedToolsOverride && wikiUrlFetchEnabled) {
    merged.add("WebFetch");
  }
  for (const tool of delegatedTools) merged.add(tool);
  for (const tool of nativeTools) merged.add(tool);
  // Claude Code 2.1+ defers large MCP manifests (`mcp__claude_ai_*`) behind
  // `ToolSearch` — the tools appear by name but their schemas are not
  // loaded until the agent calls `ToolSearch select:<name>`. Without
  // ToolSearch allowed, the model cannot invoke any unioned MCP tool and
  // silently falls back to denied surfaces (raw Bash, WebFetch), surfacing
  // as "Bash and WebFetch denied" failure DMs from native/delegated-same
  // routines. Mirrors the same widening already applied by
  // `composePrePassAllowedTools` (pre-pass), `CLAUDE_PROBE_TOOLS_PROMPT`
  // (probe), and `claude-delegated.ts` (cross-backend proxy). Unioned even
  // under `allowedToolsOverride` for the same orthogonality reason the
  // MCP tools themselves bypass the override above — silently dropping
  // ToolSearch while keeping the MCP names defeats the widening.
  if (delegatedTools.length > 0 || nativeTools.length > 0) {
    merged.add("ToolSearch");
  }
  if (wikiApiOnlyWrites) {
    merged.delete("Write");
    merged.delete("Edit");
  }
  return Array.from(merged);
}

/**
 * Read the integrations record from the wired MCP context and project it
 * through the `computeDelegatedClaudeTools` allowlist computation. Returns
 * `[]` when the context is not yet wired (tests / startup ordering) or on
 * DB read failure — the latter is logged as a warning so a corrupt
 * integrations table is visible without halting the session.
 */
export function getDelegatedClaudeTools(
  mcpContext: { db: Database.Database } | undefined,
): readonly string[] {
  if (!mcpContext) return [];
  try {
    const integrations = readIntegrations(mcpContext.db);
    return computeDelegatedClaudeTools(integrations);
  } catch (err) {
    logger.warn(
      { err },
      "Failed to read integrations for delegated-tool allowlist — proceeding without delegated tools",
    );
    return [];
  }
}

/**
 * Sibling of `getDelegatedClaudeTools` — projects integrations record
 * through `computeNativeClaudeTools`. Returns `[]` when the context is
 * not yet wired or on DB read failure, matching the conservative pattern
 * used by the delegated counterpart.
 *
 * Required because the SDK's `dontAsk` permission mode silently denies
 * tools not in `allowedTools`. Native-mode skill bodies instruct the
 * agent to call connector MCP tools directly (e.g.
 * `mcp__claude_ai_Gmail__search_threads`), so the registry-declared tool
 * names for every `mode === "native" && nativeBackend === "claude"` row
 * must be pre-authorized.
 */
export function getNativeClaudeTools(
  mcpContext: { db: Database.Database } | undefined,
): readonly string[] {
  if (!mcpContext) return [];
  try {
    const integrations = readIntegrations(mcpContext.db);
    return computeNativeClaudeTools(integrations);
  } catch (err) {
    logger.warn(
      { err },
      "Failed to read integrations for native-tool allowlist — proceeding without native tools",
    );
    return [];
  }
}

/**
 * DELEGATED-MODE-V2-DESIGN.md §4.3.3 — same-backend deny enforcement at
 * the SDK boundary. For every integration whose `delegatedBackend === "claude"`,
 * expand `state.deniedTools` against the connector's known tools and emit
 * the namespaced names (`mcp__claude_ai_<X>__<tool>`). The SDK refuses any
 * tool listed in `disallowedTools` regardless of `allowedTools` — hard
 * enforcement.
 *
 * Returns `[]` when context isn't wired (tests / pre-startup) and on read
 * failures, matching the conservative pattern used by
 * `getDelegatedClaudeTools`.
 */
export function getSessionDeniedTools(
  mcpContext: { db: Database.Database } | undefined,
): readonly string[] {
  if (!mcpContext) return [];
  try {
    const integrations = readIntegrations(mcpContext.db);
    const map = collectSessionDeniedTools(integrations, "claude");
    const out: string[] = [];
    for (const names of map.values()) {
      for (const n of names) out.push(n);
    }
    return out;
  } catch (err) {
    logger.warn(
      { err },
      "Failed to read integrations for same-backend denied-tools — proceeding without per-integration deny",
    );
    return [];
  }
}

/**
 * Dependencies for `buildSecurityHooks`. `writeTracker` is optional because
 * tests construct lightweight cores without one; the vault-write
 * pre-marking is skipped in that case.
 *
 * `mcpContext` is passed as a thunk rather than a value so the
 * absolute-block audit hook reads the live reference at fire time,
 * matching the original `this.mcpContext?.db` semantics of
 * `claude-code-core.ts`. The hook is built once per `executeOnce`
 * call but fires many times during the SDK turn — in production
 * `setMcpContext` is only invoked at startup so the values are
 * equivalent, but the thunk preserves the original semantics for
 * any future reordering of the lifecycle. `config` and `writeTracker`
 * are readonly / constructor-set on `ClaudeCodeCore` and safe to
 * capture by value.
 */
export interface SecurityHooksDeps {
  readonly config: AgentConfig;
  readonly writeTracker?: AgentWriteTracker | undefined;
  readonly getMcpContext?: () => { db: Database.Database } | undefined;
}

/**
 * Security hooks:
 *   1. Bash(curl *) — restrict to localhost Daemon API, block connection-override flags. (strict only)
 *   2. Bash(jq *)  — block file-access flags and the `env` filter (process env exfiltration). (strict only)
 *   3. Write/Edit  — block writes into the session helper dir and context dir, mark vault writes.
 *
 * In allow mode the curl and jq hooks are dropped, but the Write/Edit hook
 * stays: the context-dir chokepoint exists for memory integrity (today-write
 * lock, md_file_snapshots, CONTEXT_WRITE_PERMISSIONS), not permissions.
 */
export function buildSecurityHooks(deps: SecurityHooksDeps, allowMode = false) {
  const { config, writeTracker, getMcpContext } = deps;

  // Per-Bash-hook block logging. The SDK's `dontAsk` mode silently
  // denies any Bash command that doesn't match an allowed prefix —
  // no tool_result, no error feedback — and PreToolUse hooks that
  // return `block` emit a generic reason that the agent often
  // misinterprets as "Bash is blocked entirely." Without this log,
  // diagnosing a failed wiki / context update means guessing at the
  // command the model produced. The line is logged at warn level
  // (one per actual block, not per call) so steady-state cost is
  // negligible; the cmd is truncated to 400 chars to keep secrets
  // out of logs and the entry parseable.
  const wrapBashHook = (
    hookName: string,
    inner: (input: HookInput) => Promise<HookJSONOutput>,
  ) => async (input: HookInput): Promise<HookJSONOutput> => {
    const result = await inner(input);
    if (result && (result as { decision?: string }).decision === "block") {
      const toolInput = (input as { tool_input?: unknown }).tool_input as
        | { command?: string }
        | undefined;
      const cmd = toolInput?.command ?? "";
      logger.warn(
        {
          hook: hookName,
          reason: (result as { reason?: string }).reason,
          cmd: cmd.slice(0, 400),
        },
        "Bash hook block",
      );
    }
    return result;
  };

  const bashCurlHook = async (input: HookInput): Promise<HookJSONOutput> => {
    const toolInput = (input as { tool_input?: unknown }).tool_input as
      | { command?: string }
      | undefined;
    const cmd = toolInput?.command ?? "";
    // Three views of the command, each used by a different class of check:
    //
    // - `cmd` (raw)         — the initial `\bcurl\b` keyword presence test.
    //                          Must see literal token text so a `-d
    //                          '{"text":"see curl docs"}'` body doesn't
    //                          suppress the hook entirely.
    // - `scan`              — substring scans for flag PRESENCE (chained
    //                          curl, --next, --proxy, -L, -o, -c, -b, etc.).
    //                          Strips single-quoted strings AND heredoc
    //                          bodies so prose inside a JSON payload like
    //                          "set -o pipefail in scripts" cannot trip
    //                          the flag detectors.
    // - `tokenizable`       — tokenizer walks and value extractors
    //                          (top-level URL collection, `-d @file` arg
    //                          walker, `-o <file>` path capture). Strips
    //                          ONLY heredoc bodies (which are stdin
    //                          payload, never shell argv) and PRESERVES
    //                          quoted strings so the value extractors can
    //                          still recognise quoted URL targets and
    //                          quoted file paths.
    //
    // The wiki.ingest_url skill is the canonical case where this matters:
    // it POSTs an article body via `-d @- <<'JSON' … JSON`, and the body
    // routinely contains the source URL ("Source: https://news.example.com/…").
    // Before this layered design the URL extractor scanned `cmd`, found
    // the body URL, and falsely blocked with "Multiple URL targets".
    const scan = stripBashStringContent(cmd);
    const tokenizable = stripBashHeredocs(cmd);
    if (/\bcurl\b/.test(cmd)) {
      // ── Multi-request defenses (run BEFORE host/port loop) ─────────
      // The SDK `allowedTools` glob is a prefix match against the full
      // command, so a permitted `Bash(curl http://localhost:<port>/api/x/*)`
      // entry still matches a chained `curl http://localhost/api/x/y ;
      // curl http://localhost/api/notify -d @evil`. The URL host/port
      // loop below validates every URL but does NOT count invocations
      // or request transactions, so a second HTTP request slips through.
      // The three rules below cap a curl-bearing command to a single
      // HTTP request.
      //
      // 1. Chained curl invocations — mirrors the `cmdStart` anchor
      //    pattern in `safety/always-disallowed.ts`. Count `curl`
      //    tokens at start-of-string / after `;` / `&&` / `||` / `|` /
      //    newline / backtick / `$(`. A single `jq -n '…' | curl URL`
      //    pipeline counts as ONE curl (only the `curl` token itself
      //    is matched; the leading `jq` is not). Two or more anchored
      //    `curl` tokens → chained invocation → block.
      const chainedCurlMatches =
        scan.match(/(?:^|[;&|`\n]|\$\()\s*curl\b/g) ?? [];
      if (chainedCurlMatches.length > 1) {
        return {
          decision: "block" as const,
          reason:
            `Chained curl invocations are not allowed `
            + `(detected ${chainedCurlMatches.length} curl commands; `
            + `one curl per Bash invocation).`,
        };
      }
      // 2. `--next` / `-:` URL multiplexing — curl's `--next` (short
      //    form `-:`) starts a new transaction with reset option state
      //    inside the same invocation. The URL loop below still passes
      //    because both URLs hit the same host:port, but curl issues
      //    one HTTP request per `--next` separator. Same exfil shape
      //    as chained curl, different syntax.
      if (
        /(?:^|\s)--next(?:[\s=]|$)/.test(scan)
        || /(?:^|\s)-:(?:\s|$)/.test(scan)
      ) {
        return {
          decision: "block" as const,
          reason:
            "curl --next / -: (URL multiplexing) is not allowed "
            + "— one HTTP request per Bash invocation.",
        };
      }
      // 3. Multi-positional URL targets — `curl URL1 URL2 -X PUT -d
      //    @body` sends the same options to BOTH URLs sequentially,
      //    which `--next` blocking above does not catch. Tokenize the
      //    heredoc-stripped command and collect tokens that are URLs:
      //
      //      - Bare URL token: `curl http://localhost:8321/api/x`
      //      - Fully single-quoted URL: `curl 'http://localhost:8321/api/x'`
      //      - Fully double-quoted URL: `curl "http://localhost:8321/api/x"`
      //
      //    URLs that appear INSIDE a quoted body / header value
      //    (e.g. `-d '{"link":"https://example.com"}'` or
      //    `-H "X-Source: https://example.com"`) are NOT counted: the
      //    surrounding quoted token carries other characters, so the
      //    "entire content is the URL" patterns below do not match.
      //
      //    Heredoc bodies (`<<'JSON' … JSON`) are stripped from
      //    `tokenizable` above because they are stdin payload, never
      //    shell argv — without that strip, the routine wiki.ingest_url
      //    shape of "store an article body that mentions other URLs"
      //    would trip this multi-URL rule on the body URL.
      const topLevelTokenRe = /'[^']*'|"[^"]*"|[^'"\s]+/g;
      const topLevelUrls: string[] = [];
      let tokenMatch: RegExpExecArray | null;
      while ((tokenMatch = topLevelTokenRe.exec(tokenizable)) !== null) {
        const token = tokenMatch[0];
        if (/^https?:\/\//.test(token)) {
          topLevelUrls.push(token);
          continue;
        }
        // Fully-quoted URL token: the WHOLE content between matching
        // single or double quotes must be the URL — anything else
        // (JSON body, header value) starts with non-URL characters
        // after the quote.
        const quoted = /^(['"])(https?:\/\/[^'"\s]+)\1$/.exec(token);
        if (quoted) {
          topLevelUrls.push(quoted[2]);
        }
      }
      if (topLevelUrls.length > 1) {
        return {
          decision: "block" as const,
          reason:
            `Multiple URL targets in a single curl invocation are not allowed `
            + `(detected ${topLevelUrls.length} top-level URL tokens; quote `
            + `body URLs inside -d/-H string args).`,
        };
      }
      if (topLevelUrls.length === 0) {
        return {
          decision: "block" as const,
          reason: "curl command must contain an explicit localhost URL",
        };
      }
      for (const url of topLevelUrls) {
        try {
          const parsed = new URL(url);
          if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
            return {
              decision: "block" as const,
              reason: `curl target not allowed: ${url} (host: ${parsed.hostname})`,
            };
          }
          const effectivePort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
          if (effectivePort !== String(config.apiPort)) {
            return {
              decision: "block" as const,
              reason: `curl target port not allowed: ${effectivePort}`,
            };
          }
        } catch {
          return {
            decision: "block" as const,
            reason: `curl target URL is malformed: ${url}`,
          };
        }
      }
      // Connection-override flags — host/proxy/socket redirection that
      // would let curl reach something other than the configured loopback
      // HTTP endpoint.
      if (/--connect-to|--resolve|--config\b|(?:^|\s)-[a-zA-Z]*K|--proxy\b|(?:^|\s)-[a-zA-Z]*x|--socks|--unix-socket|--abstract-unix-socket|--interface\b|--local-port\b/.test(scan)) {
        return {
          decision: "block" as const,
          reason:
            "curl connection override flags not allowed " +
            "(--connect-to, --resolve, --config, --proxy, " +
            "--unix-socket, --abstract-unix-socket, " +
            "--interface, --local-port)",
        };
      }
      // File-read exfil flags. curl can read arbitrary files into the
      // request body via `@<path>` in -d / --data / --form, or via the
      // upload-file flag. The daemon API is loopback so the request
      // body would land in `agent_actions` / notification surfaces that
      // the agent reads back — a confused-deputy exfil.
      //
      //   --upload-file / -T          — PUT a local file as the body
      //   -d @path  /  --data @path   — body literal from file
      //   --data-binary @path         — same, raw bytes
      //   --data-raw @path            — same, no escape
      //   --data-urlencode @path      — same, urlencoded
      //   --data-ascii @path          — same, ascii
      //   -F name=@path / --form …=@  — multipart file part
      //   -F name=<path / --form …=<  — multipart text from file
      // Short-flag combined forms (`curl -fsT /etc/passwd`) must be
      // caught alongside the single-flag form (`curl -T /etc/passwd`).
      // The leading `-[a-zA-Z]*` permits zero-or-more other short flags
      // before the dangerous letter, mirroring the pattern proven for
      // `-L`. Same shape applied to every short-flag below — without it
      // an attacker can stuff the dangerous letter into a benign-looking
      // flag bundle like `-fs<X>` and bypass the deny rule entirely.
      if (/(?:^|\s)(?:--upload-file\b|-[a-zA-Z]*T(?:\s|=|$))/.test(scan)) {
        return {
          decision: "block" as const,
          reason: "curl --upload-file / -T not allowed — would read arbitrary files",
        };
      }
      // `@-` is curl's stdin marker (canonical: `-d @-` reads the body
      // from stdin, used by pipelines like `echo $body | curl ... -d @-`).
      // Block `@<anything-other-than-stdin-marker>`. The lookahead
      // `(?!-["']?(?:\s|$))` lets `@-`, `@-"`, `@-'`, `@- ` through.
      // `-d / --data* / -F / --form` value-content checks. The previous
      // regex `(?:^|\s)…\s+["']?@(?!-…)` matched the @-file syntax with
      // the value attached, which meant a JSON BODY containing literal
      // text like ` -d @<chars>` (an agent journal entry that quotes a
      // shell example) also tripped it. Conversely, switching to the
      // `scan` form alone loses single-quoted attack content (the
      // legitimate `-d '@/etc/passwd'` form): scan strips the body and
      // the regex no longer sees the `@`.
      //
      // The walker below is value-aware: tokenize the command (already
      // quote-aware via the same regex used for URL extraction), find
      // every `-d` / `--data*` / `-F` / `--form` flag token, recover the
      // unquoted value (either after `=` in the same token or in the
      // adjacent token), and reject if the value's FIRST CHARACTER is
      // `@` (with the canonical stdin marker `@-` excluded). That
      // discriminates:
      //   - `-d '@/etc/passwd'` → value starts with `@` and is not `@-`
      //     → block (matches the original protection).
      //   - `-d '{"content":"a -d @x b"}'` → value starts with `{` →
      //     allow (the body contains @ but is not an @-file argument).
      //
      // For `-F`/`--form`, the file-read syntax is `name=@file` /
      // `name=<file` (first `=` in the value followed by `@` or `<`),
      // which the same walker can test in the value once recovered.
      // Adjacent-token merge: bash treats `-d='value'` as the SINGLE
      // argument `-d=value` (the quote is stripped, the bare prefix and
      // the quoted body are joined when there is no whitespace between
      // them). The regex pass below splits the two pieces — track each
      // match's start vs. the previous match's end and concatenate any
      // pair with no whitespace gap. A composite token is treated as
      // "effectively bare" if either constituent was bare, so the flag
      // walker still recognises `-d='@/path'` as a `-d=` flag carrying
      // the value `@/path` (which the regex form `["']?@` used to catch).
      const argRe = /'([^']*)'|"([^"]*)"|`([^`]*)`|([^\s'"`]+)/g;
      const argList: { value: string; quoted: boolean }[] = [];
      let am: RegExpExecArray | null;
      let lastEnd = -1;
      // Walks `tokenizable` (heredoc-stripped) so a body line like
      // `prose mentioning -d @/etc/passwd` cannot be parsed as a real
      // `-d` flag carrying an `@file` value. Single / double quotes are
      // preserved so the `quoted` discriminator still tracks user intent
      // correctly for the dataFlag / formFlag checks below.
      while ((am = argRe.exec(tokenizable)) !== null) {
        const value = am[1] ?? am[2] ?? am[3] ?? am[4] ?? "";
        const quoted = am[4] === undefined;
        if (am.index === lastEnd && argList.length > 0) {
          const prev = argList[argList.length - 1]!;
          prev.value = prev.value + value;
          prev.quoted = prev.quoted && quoted;
        } else {
          argList.push({ value, quoted });
        }
        lastEnd = argRe.lastIndex;
      }
      const dataFlag = /^(?:--data(?:-binary|-raw|-urlencode|-ascii)?|--data|-d)(?:=(.*))?$/;
      const formFlag = /^(?:--form|-F)(?:=(.*))?$/;
      for (let i = 0; i < argList.length; i++) {
        const tok = argList[i];
        if (!tok || tok.quoted) continue;
        const dm = tok.value.match(dataFlag);
        if (dm) {
          const value = dm[1] ?? argList[i + 1]?.value ?? "";
          if (value.length > 0 && value[0] === "@" && value !== "@-") {
            return {
              decision: "block" as const,
              reason:
                "curl -d/--data with `@file` syntax not allowed — reads local files",
            };
          }
          continue;
        }
        const fm = tok.value.match(formFlag);
        if (fm) {
          const value = fm[1] ?? argList[i + 1]?.value ?? "";
          // `name=@path` / `name=<path`: first `=` then `@` or `<`.
          if (/^[^=\s]*=[@<]/.test(value)) {
            return {
              decision: "block" as const,
              reason:
                "curl -F/--form with `=@file` or `=<file` syntax not allowed — reads local files",
            };
          }
        }
      }
      // File-write flags. The agent can land bytes anywhere on disk —
      // overwriting shims, ssh keys, shell rc files, etc. Daemon API is
      // the sole sanctioned write path; Bash curl writes are denied.
      //
      //   -o / --output FILE          — write response to FILE
      //   -O / --remote-name          — write to basename-of-URL
      //   --remote-name-all           — same, for every URL
      //   -D / --dump-header FILE     — write response headers
      //   -c / --cookie-jar FILE      — write Set-Cookie state
      //   --trace / --trace-ascii F   — write protocol trace
      //   -w / --write-out FORMAT     — format-string output
      //                                  (`%{stderr}` writes to stderr;
      //                                  combined with shell redirect
      //                                  it's another write channel)
      // `-o <file>` / `--output <file>` — used to download binary
      // payloads from the daemon API (e.g. `curl -o receipt.pdf
      // /api/receipts/1/download`). Permit only simple relative
      // filenames so absolute (`-o /etc/passwd`) and parent-escape
      // (`-o ../../foo`) forms are still blocked. Tilde / env-var
      // prefixes are likewise refused because they bypass cwd
      // containment. Quoted paths with spaces (`-o "my file"`) are
      // ALSO rejected so a denylist regex that stops at the space
      // inside the quotes cannot be smuggled past.
      // Flag PRESENCE detection runs on the scan (quote-stripped) command
      // so a body containing prose like "set -o pipefail" does not falsely
      // claim there is an output flag. The subsequent VALUE extraction
      // reads `tokenizable` (heredoc-stripped, quotes preserved) so an
      // earlier heredoc-body occurrence of `-o /etc/passwd` cannot be
      // captured ahead of the real flag — while quoted paths like
      // `-o "my file.pdf"` are still readable.
      const hasOutputFlag = /(?:^|\s)(?:--output(?:\b|=)|-[a-zA-Z]*o(?:\s|=|$))/.test(scan);
      if (hasOutputFlag) {
        // Three capture-group alternatives so quoted paths with spaces
        // are caught — `[^\s'"]+` alone fails on `"my file"`.
        const valueMatch = tokenizable.match(
          /(?:^|\s)(?:--output(?:\s+|=)|-o(?:\s+|=))(?:"([^"]*)"|'([^']*)'|([^\s'"]+))/,
        );
        const target =
          valueMatch?.[1] ?? valueMatch?.[2] ?? valueMatch?.[3] ?? "";
        const isSafeRelative =
          target.length > 0 &&
          !target.startsWith("/") &&
          !target.startsWith("~") &&
          !target.startsWith("$") &&
          !target.split("/").includes("..") &&
          !target.split("\\").includes("..");
        if (!isSafeRelative) {
          return {
            decision: "block" as const,
            reason:
              `curl --output/-o target must be a simple relative path; ` +
              `got: ${target || "<unparseable>"} ` +
              `(no absolute paths, parent-dir escapes, or shell expansions).`,
          };
        }
      }
      if (/(?:^|\s)(?:--remote-name(?:-all)?\b|-[a-zA-Z]*O(?:\s|=|$))/.test(scan)) {
        return {
          decision: "block" as const,
          reason: "curl --remote-name/-O not allowed — would write to URL-derived path",
        };
      }
      if (/(?:^|\s)(?:--dump-header\b|-[a-zA-Z]*D(?:\s|=|$))/.test(scan)) {
        return {
          decision: "block" as const,
          reason: "curl --dump-header/-D not allowed — writes response headers to disk",
        };
      }
      if (/(?:^|\s)(?:--cookie-jar\b|-[a-zA-Z]*c(?:\s|=|$))/.test(scan)) {
        return {
          decision: "block" as const,
          reason: "curl --cookie-jar/-c not allowed — writes cookie state to disk",
        };
      }
      // `--cookie` / `-b` reads cookies from a file when the value
      // is a filename (curl's documented semantics: `-b "FILE"` if
      // the value has no `=`). Same exfil shape as `-d @file` — the
      // file content is sent in the request header. Allowing
      // `-b name=value` would require parsing the value; the simpler
      // safe stance is to refuse the flag outright since the daemon
      // API uses bearer tokens, not cookies.
      if (/(?:^|\s)(?:--cookie\b|-[a-zA-Z]*b(?:\s|=|$))/.test(scan)) {
        return {
          decision: "block" as const,
          reason:
            "curl --cookie/-b not allowed — when the value is a path, " +
            "the file contents are sent as the Cookie header (file read).",
        };
      }
      if (/(?:^|\s)--trace(?:-ascii)?\b/.test(scan)) {
        return {
          decision: "block" as const,
          reason: "curl --trace / --trace-ascii not allowed — writes protocol trace to disk",
        };
      }
      if (/(?:^|\s)(?:--write-out\b|-[a-zA-Z]*w(?:\s|=|$))/.test(scan)) {
        return {
          decision: "block" as const,
          reason: "curl --write-out/-w not allowed — format strings include file/stderr sinks",
        };
      }
      // Cert / key file references. The daemon API is plain HTTP on
      // loopback; none of these flags are needed for legitimate
      // operation and they all read arbitrary files from disk.
      if (/(?:^|\s)(?:--cert\b|--key\b|--cacert\b|--capath\b|-[a-zA-Z]*E(?:\s|=|$))/.test(scan)) {
        return {
          decision: "block" as const,
          reason: "curl --cert/--key/--cacert/--capath/-E not allowed — read arbitrary files",
        };
      }
      // Follow-redirect flags. The localhost URL check above is
      // bypass-able if curl follows a 3xx off-localhost. The daemon
      // never emits redirects so this flag has no legitimate use.
      //
      // Combined-short-flag forms (`-fsSL`, `-vL`) are caught by the
      // `[a-zA-Z]*L` alternation; the literal `--location` and
      // `--location-trusted` long forms are matched explicitly.
      if (/(?:^|\s)(?:-[a-zA-Z]*L(?:\s|=|$)|--location(?:-trusted)?\b)/.test(scan)) {
        return {
          decision: "block" as const,
          reason: "curl -L / --location not allowed — would follow redirects off localhost",
        };
      }
    }
    return { continue: true };
  };

  const bashJqHook = async (input: HookInput): Promise<HookJSONOutput> => {
    const toolInput = (input as { tool_input?: unknown }).tool_input as
      | { command?: string }
      | undefined;
    const cmd = toolInput?.command ?? "";
    if (!/\bjq\b/.test(cmd)) return { continue: true };

    // Narrow to THIS jq invocation's own args (up to the next pipe / chain op)
    // so that later pipeline stages are not inspected by the jq rules.
    //
    // The match runs against `stripBashHeredocs(cmd)` so that prose inside
    // a heredoc body (e.g. a wiki article that mentions "the jq env
    // filter") cannot trip the env / -L / --slurpfile checks below.
    // Quoted strings remain intact because the env-filter detector
    // intentionally peers inside the single-quoted jq filter argument
    // (jq syntax lives inside shell quotes, so blanket quote-stripping
    // would lose the very thing we need to inspect).
    //
    // Known approximation: `[^|;&]*` does not respect shell quoting, so a
    // jq filter with a `|` INSIDE a quoted expression (e.g. `jq 'env | keys'`)
    // will truncate `jqPart` at the first `|` regardless of whether that `|`
    // is a jq pipe inside quotes or an actual shell pipeline break. This is
    // intentionally conservative on the safe side: the env-filter check
    // below still fires on the truncated left half (`jq 'env `), so attack
    // payloads are still blocked. The downside is slightly reduced precision
    // on benign expressions containing the jq `|` operator — those get
    // scanned only up to the first pipe, not their full extent.
    const jqMatch = stripBashHeredocs(cmd).match(/\bjq\b([^|;&]*)/);
    if (!jqMatch) return { continue: true };
    const jqPart = jqMatch[0];

    // (a) Block file-access flags — --slurpfile / --rawfile read arbitrary
    // files, which would bypass the Read deny list (~/.ssh/**, .env, etc.).
    if (/(?:^|\s)--slurpfile\b/.test(jqPart) || /(?:^|\s)--rawfile\b/.test(jqPart)) {
      return {
        decision: "block" as const,
        reason:
          "jq --slurpfile and --rawfile are not allowed " +
          "(would bypass Read(.env) / Read(~/.ssh/**) disallow rules).",
      };
    }

    // (b) Block module loading — -L <dir> + import can load filter code from
    // the filesystem, effectively RCE inside the jq process.
    if (/(?:^|\s)-L(?:\s|=|$)/.test(jqPart)) {
      return {
        decision: "block" as const,
        reason: "jq -L (module load path) is not allowed.",
      };
    }

    // (c) Block the `env` filter. `jq env`, `jq -n env`, `jq 'env.FOO'`,
    // `jq '. , env'` all dump the daemon's process.env to stdout. Process.env
    // on this daemon is expected to be clean (secrets live in the keychain),
    // but defense-in-depth: if OPENAI_API_KEY or similar is ever exported at
    // launch, the env filter is the shortest exfil path.
    //
    // Heuristic: match bare `env` NOT preceded by a field-access dot or word
    // char, and NOT followed by a word char. This matches jq's env filter
    // (`env`, `env.HOME`, `(env)`, `env|keys`) while leaving field access
    // like `.env`, `.env_var`, `.data.environments` untouched.
    if (/(?:^|[^\w.])env(?!\w)/.test(jqPart)) {
      return {
        decision: "block" as const,
        reason:
          "jq env filter is not allowed — it dumps the daemon process " +
          "environment, which is a known exfiltration vector for any " +
          "secrets loaded via .env at startup.",
      };
    }

    return { continue: true };
  };

  /**
   * Block any Bash command that references the context-directory path.
   *
   * Rationale: the daemon API is the ONLY sanctioned write channel for
   * context files — it enforces today-write-lock, md_file_snapshots,
   * CONTEXT_WRITE_PERMISSIONS, and onPromptContextChanged. In strict mode,
   * the allowlist (Bash narrowed to curl/git/jq) + fileWriteHook keeps
   * this chokepoint intact. In allow mode Bash is unrestricted, so an
   * agent could bypass via `echo > today.md`, `tee`, `python -c 'open…'`,
   * `git log … > context/…`, etc. The defence here is layered:
   *
   *   1. Original substring match against `shellPathForms`. Cheap and
   *      catches the obvious literal form an honest model would emit.
   *   2. Best-effort shell tokenizer + `~`/`$HOME` expansion + symlink
   *      realpath. Catches `cd ~/.personal-agent && echo > ./context/X`
   *      (the `./context/X` token, once joined to the cwd or after a
   *      separate `cd` token is detected, lands in the context dir),
   *      `ln -s ~/.personal-agent/context /tmp/x` followed by writes
   *      to `/tmp/x/today.md`, and `~/.personal-agent/./context/X`.
   *   3. Hard block on interpreter escape hatches (`python -c`, `node
   *      -e`, `bash -c`, etc.). Static analysis cannot see what these
   *      will do; in allow-mode Bash they are the most direct route
   *      around the chokepoint.
   *
   * Defence-in-depth, not authoritative: a prompt-injection-driven
   * variable-construction attack (`P=context; D=today; cd ~/.personal-agent;
   * echo > "$P/$D.md"`) can still slip past static analysis. The static
   * absolute-block layer covers the highest-risk patterns; if a new
   * shape of bypass is observed in audit, codify it here.
   */
  const bashContextWriteHook = async (
    input: HookInput,
  ): Promise<HookJSONOutput> => {
    const hookInput = input as { tool_input?: unknown; cwd?: string };
    const toolInput = hookInput.tool_input as
      | { command?: string }
      | undefined;
    const cmd = toolInput?.command ?? "";
    if (typeof cmd !== "string" || cmd.length === 0) return { continue: true };

    const absContextDir = resolvePath(getContextDir(config));
    const home = homedir();
    const realContextDir = realpathLenient(absContextDir);
    // The data dir is the context dir's parent. `cd ~/.personal-agent`
    // followed by `echo > context/today.md` lands in context via a
    // post-cd relative path that Layer 2 cannot resolve (the hook only
    // sees the *initial* cwd). Treating any reference to the data dir
    // as out-of-bounds preempts that bypass — the agent has no
    // legitimate reason to touch the data dir directly when the daemon
    // API is the sanctioned write channel.
    const absDataDir = resolvePath(config.dataDir);
    const realDataDir = realpathLenient(absDataDir);

    // Use the quote/heredoc-stripped form for Layer 1 (substring) and
    // Layer 3 (interpreter regex) so a JSON body or heredoc payload that
    // legitimately contains the absolute context-dir path string, or the
    // literal text `bash -c …`, does not trip these layers. Layer 2
    // still uses `cmd` because its tokenizer is already quote-aware via
    // `looksLikePathArg`.
    const scan = stripBashStringContent(cmd);

    // ── Layer 1: substring match against well-known path forms ──
    const pathForms = shellPathForms(absContextDir, home);
    for (const form of pathForms) {
      if (scan.includes(form)) {
        return blockContextWrite(absContextDir, `substring match: ${form}`);
      }
    }

    // ── Layer 2: tokenized realpath check ──
    //
    // Resolve every path-looking token to its absolute form (relative
    // to the hook-provided cwd) and to its realpath. If either lands
    // inside the context dir OR the data dir, block.
    const cwd = hookInput.cwd ?? "/";
    const tokens = tokenizeShellCommand(cmd);
    for (const rawTok of tokens) {
      const tok = expandHomeForms(rawTok, home);
      // Skip URL-shaped tokens; they are not filesystem paths. Must
      // come before `looksLikePathArg` because `http://localhost/...`
      // satisfies the "starts with `/`" rule once the scheme prefix
      // is removed — and the bare-path rule too — but is never a
      // filesystem reference.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) continue;
      // The old filter (`!tok.includes("/") && !tok.includes("\\")`)
      // forwarded any quoted token with a `/` or `\` into the data-dir
      // resolution branch, which produced false positives on JSON
      // bodies (`{"content":"a\nb"}`) and header values (`Content-Type:
      // application/json`) whenever cwd lived under the data dir. See
      // `looksLikePathArg` for the replacement rules.
      if (!looksLikePathArg(tok)) continue;
      const candidate = isAbsolute(tok) ? tok : resolvePath(cwd, tok);
      const real = realpathLenient(candidate);
      const landsInsideContext =
        isPathInsideOrEqual(absContextDir, candidate) ||
        isPathInsideOrEqual(realContextDir, real);
      const landsInsideData =
        isPathInsideOrEqual(absDataDir, candidate) ||
        isPathInsideOrEqual(realDataDir, real);
      if (landsInsideContext || landsInsideData) {
        return blockContextWrite(
          absContextDir,
          landsInsideContext
            ? `path token resolves into context dir: ${rawTok} → ${real}`
            : `path token resolves into the data dir (${absDataDir}); ` +
              `the agent should never reference the data dir directly: ${rawTok} → ${real}`,
        );
      }
    }

    // ── Layer 3: interpreter escape hatches ──
    //
    // `bash -c "..."`, `python -c "..."`, etc. tunnel arbitrary code
    // through an opaque argument that static analysis cannot see into.
    // Even in allow-mode Bash the agent should never need these — the
    // SDK Write/Edit tools and the daemon API cover legitimate
    // file-touching use cases. Blocking the patterns themselves is the
    // only way to keep this hook's guarantees meaningful.
    if (
      /(?:^|[\s|;&])(?:bash|sh|zsh|ksh|dash|busybox)\s+-c\b/.test(scan) ||
      /(?:^|[\s|;&])(?:python3?|node|ruby|perl|php|deno|bun)\s+-[ce]\b/.test(scan)
    ) {
      return {
        decision: "block" as const,
        reason:
          `Bash commands that invoke an interpreter with -c / -e are not ` +
          `allowed. Their argument is opaque to static analysis, which ` +
          `defeats the context-write chokepoint. Use the Write/Edit tools ` +
          `or the daemon API at http://localhost:${config.apiPort}/api/context/.`,
      };
    }

    return { continue: true };
  };

  function blockContextWrite(
    absContextDir: string,
    reasonDetail: string,
  ): HookJSONOutput {
    return {
      decision: "block" as const,
      reason:
        `Bash commands that reference the context directory (${absContextDir}) are ` +
        `not allowed. Use the daemon API: ` +
        `GET/PUT/PATCH http://localhost:${config.apiPort}/api/context/<path>. ` +
        `The API enforces today-write-lock, md_file_snapshots, CONTEXT_WRITE_PERMISSIONS, ` +
        `and onPromptContextChanged — bypassing it via shell redirects or script ` +
        `engines leaves the memory layer inconsistent. ${reasonDetail}.`,
    };
  }

  const fileWriteHook = async (
    input: HookInput,
  ): Promise<HookJSONOutput> => {
    const hookInput = input as { tool_input?: unknown; cwd?: string };
    const toolInput = hookInput.tool_input as
      | { file_path?: unknown }
      | undefined;
    const rawFilePath = toolInput?.file_path;
    if (typeof rawFilePath !== "string" || rawFilePath.length === 0) {
      return { continue: true };
    }
    const filePath = rawFilePath;

    const cwd = hookInput.cwd;
    if (!cwd && !isAbsolute(filePath)) return { continue: true };
    const absFile = resolvePath(cwd ?? "/", filePath);
    // Resolve symlinks. A lexical containment check accepts a symlink
    // whose target lives inside a forbidden dir, because the link
    // itself sits outside. The kernel write follows the link, so the
    // forbidden bytes land anyway. Realpath both sides of every
    // comparison closes that bypass.
    const realFile = realpathLenient(absFile);

    // (a) Block writes into the session-local helper dir. The `curl` shim in
    // `.pa/bin/` carries daemon-auth env at execution time; letting the model
    // rewrite it would turn the helper into a secret exfiltration vector.
    const absHelperDir = resolvePath(cwd ?? "/", ".pa");
    const realHelperDir = realpathLenient(absHelperDir);
    const withinHelperDir =
      isPathInsideOrEqual(absHelperDir, absFile) ||
      isPathInsideOrEqual(realHelperDir, realFile);
    if (withinHelperDir) {
      return {
        decision: "block" as const,
        reason:
          "Direct Write/Edit to .pa is forbidden. " +
          "Session helper binaries are managed by the daemon.",
      };
    }

    // (b) Block writes into the context dir.
    const contextDir = getContextDir(config);
    const absContextDir = resolvePath(contextDir);
    const realContextDir = realpathLenient(absContextDir);
    const withinContext =
      isPathInsideOrEqual(absContextDir, absFile) ||
      isPathInsideOrEqual(realContextDir, realFile);
    if (withinContext) {
      return {
        decision: "block" as const,
        reason:
          `Direct Write/Edit to context dir is forbidden. ` +
          `Use the daemon API instead: ` +
          `PUT http://localhost:${config.apiPort}/api/context/<path> (full replace) or ` +
          `PATCH http://localhost:${config.apiPort}/api/context/<path> (section op). ` +
          `The API enforces CONTEXT_WRITE_PERMISSIONS, morningRoutineLock, md_file_snapshots, ` +
          `onPromptContextChanged, and expectedMtime concurrency. Path: ${absFile}` +
          (realFile !== absFile ? ` (realpath: ${realFile})` : ""),
      };
    }

    // (c) Mark vault-scoped writes for observer attribution.
    // Targets the EXTERNAL Obsidian vault; the ObsidianWatcher observer
    // watches that path and would otherwise misattribute agent writes
    // as user writes.
    if (!writeTracker) return { continue: true };
    const vaultPath = config.externalObsidianVaultPath;
    if (!vaultPath) return { continue: true };
    const absVault = resolvePath(vaultPath);
    const realVault = realpathLenient(absVault);
    const withinVault =
      isPathInsideOrEqual(absVault, absFile) ||
      isPathInsideOrEqual(realVault, realFile);
    if (!withinVault) return { continue: true };

    // Mark BOTH paths so the observer can match whichever form the
    // ObsidianWatcher emits. Most filesystems report the lexical path;
    // the realpath form is belt-and-braces.
    writeTracker.markWriting(absFile);
    if (realFile !== absFile) writeTracker.markWriting(realFile);
    logger.debug(
      { filePath: absFile, realPath: realFile },
      "vault write pre-marked for observer attribution",
    );
    return { continue: true };
  };

  // EXECUTION-MODE-DESIGN.md §6 — absolute-block audit hook. Runs ahead
  // of every other Bash/Read/Write/Edit hook in both modes. The SDK-level
  // `disallowedTools` rejection is the authoritative block; this hook is
  // redundant defense-in-depth that also writes the `blocked_absolute`
  // audit row so the owner can see the layer is active.
  const makeAbsoluteBlockHook =
    (toolName: string, argField: "command" | "file_path") =>
    async (input: HookInput): Promise<HookJSONOutput> => {
      const toolInput = (input as { tool_input?: unknown }).tool_input as
        | Record<string, unknown>
        | undefined;
      const raw = toolInput?.[argField];
      if (typeof raw !== "string") return { continue: true };
      const match = classifyAbsoluteBlock(toolName, raw);
      if (!match) return { continue: true };
      recordAbsoluteBlockAudit({
        db: getMcpContext?.()?.db,
        backend: "claude",
        mode: config.claudeExecutionPermissionMode,
        match,
        toolName,
      });
      return {
        decision: "block" as const,
        reason:
          `Absolute-block layer denied this ${toolName} call ` +
          `(category: ${match.category}). This rule holds in both Safe ` +
          `and Allow modes — see EXECUTION-MODE-DESIGN.md §6.`,
      };
    };

  const bashAbsoluteBlockHook = makeAbsoluteBlockHook("Bash", "command");
  const readAbsoluteBlockHook = makeAbsoluteBlockHook("Read", "file_path");
  const writeAbsoluteBlockHook = makeAbsoluteBlockHook("Write", "file_path");
  const editAbsoluteBlockHook = makeAbsoluteBlockHook("Edit", "file_path");

  // The context-write hook is always attached to Bash — it is the only
  // guarantee that the daemon-API chokepoint for memory files survives
  // allow mode (where curl/jq restrictions are dropped and Bash can
  // otherwise redirect into context/*.md freely).
  //
  // The absolute-block audit hook is appended LAST on every matcher
  // (§6.3). Appended rather than prepended so existing per-index hook
  // tests keep pointing at the same functions; semantically it is a
  // fallback defense whose practical effect is duplicating the SDK's
  // `disallowedTools` rejection into an `agent_actions` row.
  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: allowMode
          ? [
              wrapBashHook("bashContextWriteHook", bashContextWriteHook),
              wrapBashHook("bashAbsoluteBlockHook", bashAbsoluteBlockHook),
            ]
          : [
              wrapBashHook("bashCurlHook", bashCurlHook),
              wrapBashHook("bashJqHook", bashJqHook),
              wrapBashHook("bashContextWriteHook", bashContextWriteHook),
              wrapBashHook("bashAbsoluteBlockHook", bashAbsoluteBlockHook),
            ],
      },
      { matcher: "Write", hooks: [fileWriteHook, writeAbsoluteBlockHook] },
      { matcher: "Edit", hooks: [fileWriteHook, editAbsoluteBlockHook] },
      { matcher: "Read", hooks: [readAbsoluteBlockHook] },
    ],
  };
}

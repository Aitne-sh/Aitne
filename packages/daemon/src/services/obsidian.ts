import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import type { AgentConfig } from "../config.js";
import { createLogger } from "../logging.js";

const logger = createLogger("obsidian-service");
const execFileAsync = promisify(execFile);

/**
 * Check whether a process with the given executable name is running.
 *
 * Cross-platform:
 * - POSIX (macOS / Linux): `pgrep -x <name>` — fast, exact name match.
 * - Windows: `tasklist /FI "IMAGENAME eq <name>.exe" /FO CSV /NH` — the
 *   in-box equivalent. Image filter is case-insensitive on NTFS, which
 *   matches the casing tolerance Windows users expect for `.exe` names.
 *
 * Any failure (binary missing, no match, timeout) returns false. Callers
 * use this as a fail-closed gate before invoking the Obsidian CLI: on
 * macOS the CLI doubles as a GUI launcher and would hang indefinitely if
 * the app isn't already running, so a stale "yes" here is a worse outcome
 * than a stale "no".
 *
 * Results are cached with a 1 s TTL so a tight burst of CLI calls
 * doesn't pay the per-spawn cost (tasklist on Windows is ~50-200 ms per
 * invocation). Stale window is bounded — a user who launches Obsidian
 * mid-burst sees the "running" state on the next call after the cache
 * expires.
 */
const PROCESS_RUNNING_CACHE_TTL_MS = 1_000;
let cachedRunning: { name: string; result: boolean; expiresAt: number } | null = null;

async function isProcessRunning(name: string): Promise<boolean> {
  const now = Date.now();
  if (cachedRunning && cachedRunning.name === name && now < cachedRunning.expiresAt) {
    return cachedRunning.result;
  }
  const result = await detectProcessRunning(name);
  cachedRunning = { name, result, expiresAt: now + PROCESS_RUNNING_CACHE_TTL_MS };
  return result;
}

async function detectProcessRunning(name: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const imageName = `${name}.exe`;
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
        { timeout: 2_000, windowsHide: true },
      );
      // No-match output: `INFO: No tasks are running which match …` —
      // the image name itself never appears. Real match: a CSV row whose
      // first field is the image name (always present, case-insensitive).
      return stdout.toLowerCase().includes(imageName.toLowerCase());
    }
    await execFileAsync("pgrep", ["-x", name], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function obsidianAppRunning(): Promise<boolean> {
  return isProcessRunning("Obsidian");
}

export interface ObsidianSearchResult {
  path: string;
  title: string;
  excerpt: string;
}

/**
 * ObsidianService — wraps Obsidian CLI (1.12+).
 *
 * The CLI communicates with the running Obsidian process, so it works
 * transparently with iCloud vaults. All writes go through the CLI;
 * reads can use Claude Code's Read tool directly (vault path is injected
 * by ContextBuilder).
 *
 * Prerequisites:
 * - Obsidian 1.12+ installed
 * - Settings > General > "Command line interface" enabled
 * - Obsidian running (CLI communicates with the Obsidian process)
 * - CLI in PATH (~/.zprofile auto-updated when CLI is enabled)
 */
export class ObsidianService {
  private readonly vaultName: string | null;
  private readonly vaultPath: string | null;

  constructor(config: AgentConfig) {
    // Management Mode: this service always operates on the EXTERNAL Obsidian
    // vault (a user-maintained note vault reached via the Obsidian CLI).
    // The agent's primary vault — its own personal data — lives under
    // `getContextDir(config)` and is reached via `/api/context/*` instead.
    this.vaultName = config.externalObsidianVaultName;
    this.vaultPath = config.externalObsidianVaultPath;
  }

  /** Whether Obsidian integration is configured */
  get available(): boolean {
    return this.vaultName !== null;
  }

  /** Get the vault name (for status endpoint) */
  get vault(): string | null {
    return this.vaultName;
  }

  /** Get the absolute vault path (for attribution tracking) */
  get absoluteVaultPath(): string | null {
    return this.vaultPath;
  }

  /**
   * Append `.md` to a note path when the caller omitted an extension.
   * Exposed so route handlers and this service agree on the same path
   * normalization before passing values to the CLI or AgentWriteTracker.
   */
  static ensureMdExtension(notePath: string): string {
    return /\.[A-Za-z0-9]+$/.test(notePath) ? notePath : `${notePath}.md`;
  }

  /**
   * Resolve a logical note name to an absolute file path inside the vault.
   * Returns `null` if the vault path is not configured. The daemon uses
   * this to pre-mark agent writes in AgentWriteTracker so the observer
   * correctly attributes subsequent chokidar events to the agent rather
   * than the user. Adds a `.md` suffix when the caller omits it.
   */
  resolveNotePath(noteName: string): string | null {
    if (!this.vaultPath) return null;
    return resolvePath(this.vaultPath, ObsidianService.ensureMdExtension(noteName));
  }

  /**
   * Check if Obsidian CLI is accessible and the app is running.
   *
   * On macOS the CLI binary installed by Obsidian (at
   * `/Applications/Obsidian.app/Contents/MacOS/obsidian`) doubles as the GUI
   * launcher: invoking it with no running Obsidian process spawns Electron
   * instead of answering `--version`, and that never exits. Check first that
   * an Obsidian process is already running, and enforce a short timeout on
   * the probe as a belt-and-braces guard.
   */
  async isRunning(): Promise<boolean> {
    if (!(await obsidianAppRunning())) {
      logger.warn(
        "Obsidian app is not running — CLI requires the app to be open. Skipping Obsidian integration.",
      );
      return false;
    }
    try {
      await execFileAsync("obsidian", ["--version"], {
        timeout: 3_000,
        killSignal: "SIGKILL",
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, "Obsidian CLI probe failed");
      return false;
    }
  }

  /** Create a new note */
  async createNote(name: string, content: string): Promise<void> {
    await this.exec(["create", `name=${name}`, `content=${content}`, "silent"]);
    logger.info({ name }, "Obsidian note created");
  }

  /**
   * Overwrite an existing note (or create it if missing).
   *
   * Wraps `obsidian create path=… overwrite`, which is idempotent: the
   * CLI replaces the file's contents if it exists and creates it
   * otherwise. This is PUT semantics — use `createNote` when strict
   * create-only behavior is required.
   *
   * **Must use `path=`, not `name=`.** The CLI's `name=` resolves like a
   * wikilink (basename match across the vault), which combined with the
   * `overwrite` flag could silently clobber an unrelated note that
   * happens to share a basename. `path=` is exact (folder/note.md).
   */
  async updateNote(filePath: string, content: string): Promise<void> {
    const normalized = ObsidianService.ensureMdExtension(filePath);
    await this.exec([
      "create",
      `path=${normalized}`,
      `content=${content}`,
      "overwrite",
      "silent",
    ]);
    logger.info({ path: normalized }, "Obsidian note updated (overwrite)");
  }

  /**
   * Delete a note.
   *
   * Defaults to Obsidian's trash (recoverable via the vault UI). Pass
   * `permanent=true` to skip the trash — irreversible, use sparingly.
   *
   * Uses `path=` (not `file=`) for the same reason as `updateNote`:
   * wikilink resolution on a shared basename would let a destructive
   * call silently target the wrong vault file.
   */
  async deleteNote(filePath: string, permanent = false): Promise<void> {
    const normalized = ObsidianService.ensureMdExtension(filePath);
    const args = ["delete", `path=${normalized}`];
    if (permanent) args.push("permanent");
    await this.exec(args);
    logger.info({ path: normalized, permanent }, "Obsidian note deleted");
  }

  /** Append content to an existing note */
  async appendToNote(file: string, content: string): Promise<void> {
    await this.exec(["append", `file=${file}`, `content=${content}`]);
    logger.debug({ file }, "Appended to Obsidian note");
  }

  /** Search notes by query */
  async search(query: string, limit = 10): Promise<ObsidianSearchResult[]> {
    const result = await this.exec([
      "search",
      `query=${query}`,
      `limit=${limit}`,
    ]);
    return this.parseSearchResult(result);
  }

  /**
   * Read a note's content.
   *
   * Uses `path=` (not `file=`) so the lookup is exact and doesn't
   * depend on Obsidian's wikilink index — the wikilink index is
   * populated asynchronously and can briefly miss a file that was
   * just written via `create path=…`. `path=` hits the filesystem
   * directly and avoids that race.
   *
   * Also detects the CLI's "Error: File … not found." stdout pattern:
   * the `read` command reports missing files on stdout with exit 0,
   * so we must promote it to an exception for the caller to get a
   * meaningful "not found" signal.
   */
  async readNote(filePath: string): Promise<string> {
    const normalized = ObsidianService.ensureMdExtension(filePath);
    const out = await this.exec(["read", `path=${normalized}`]);
    if (/^Error:\s/m.test(out)) {
      throw new Error(out.trim());
    }
    return out;
  }

  /** Append to the daily note */
  async appendToDaily(content: string): Promise<void> {
    await this.exec(["daily:append", `content=${content}`]);
    logger.debug("Appended to Obsidian daily note");
  }

  /** Set a property on a note */
  async setProperty(
    file: string,
    name: string,
    value: string,
  ): Promise<void> {
    await this.exec([
      "property:set",
      `name=${name}`,
      `value=${value}`,
      `file=${file}`,
    ]);
  }

  /**
   * Execute an Obsidian CLI command.
   *
   * Uses execFile with args array (not shell) to prevent injection.
   * Prepends vault name if configured.
   */
  private async exec(args: string[]): Promise<string> {
    const fullArgs = this.vaultName
      ? [`vault=${this.vaultName}`, ...args]
      : args;

    if (!(await obsidianAppRunning())) {
      // Without this guard the `obsidian` binary would launch the GUI and
      // hang, holding up every API caller until the 10s timeout — see
      // `isRunning()` for the full explanation.
      throw new Error(
        "Obsidian app is not running. The CLI requires the app to be open.",
      );
    }
    try {
      const { stdout } = await execFileAsync("obsidian", fullArgs, {
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      return stdout.trim();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      if (message.includes("ENOENT")) {
        throw new Error(
          "Obsidian CLI not found. Ensure Obsidian 1.12+ is installed and CLI is enabled in Settings > General.",
        );
      }
      throw new Error(`Obsidian CLI error: ${message}`);
    }
  }

  /** Parse the CLI search output into structured results */
  private parseSearchResult(raw: string): ObsidianSearchResult[] {
    if (!raw.trim()) return [];

    const results: ObsidianSearchResult[] = [];
    // Obsidian CLI search returns one result per line: "path | title | excerpt"
    // Exact format depends on CLI version; handle both JSON and plain text
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item: Record<string, string>) => ({
          path: item.path ?? item.file ?? "",
          title: item.title ?? item.name ?? "",
          excerpt: item.excerpt ?? item.content ?? "",
        }));
      }
    } catch {
      // Plain text fallback
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("|").map((s) => s.trim());
        results.push({
          path: parts[0] ?? "",
          title: parts[1] ?? parts[0] ?? "",
          excerpt: parts[2] ?? "",
        });
      }
    }
    return results;
  }
}

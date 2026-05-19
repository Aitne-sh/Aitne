import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, join, normalize, parse, sep } from "node:path";
import { homedir } from "node:os";

export type DirectoryPickerStatus = "selected" | "cancelled" | "unavailable";

export interface DirectoryPickerResponse {
  status: DirectoryPickerStatus;
  path?: string;
  message?: string;
  method?: "osascript" | "powershell" | "zenity" | "kdialog" | "yad";
}

export interface DirectoryPickerInput {
  title?: string;
  defaultPath?: string;
}

export interface PickerCommand {
  command: string;
  args: string[];
  method: NonNullable<DirectoryPickerResponse["method"]>;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: NodeJS.ErrnoException;
}

type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export interface PickDirectoryOptions extends DirectoryPickerInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runner?: CommandRunner;
  findExecutable?: (names: string[], env: NodeJS.ProcessEnv) => string | null;
}

const DEFAULT_TITLE = "Choose folder";
const DEFAULT_TIMEOUT_MS = 120_000;

function expandHome(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function existingDirectoryOrParent(rawPath: string | undefined): string | null {
  const trimmed = rawPath?.trim();
  if (!trimmed) return null;
  const expanded = expandHome(trimmed);
  try {
    if (existsSync(expanded) && statSync(expanded).isDirectory()) {
      return expanded;
    }
    const parent = dirname(expanded);
    if (parent !== expanded && existsSync(parent) && statSync(parent).isDirectory()) {
      return parent;
    }
    /* c8 ignore start — defensive: existsSync should suppress most stat errors,
       but EACCES on a parent directory can still throw. */
  } catch {
    return null;
  }
  /* c8 ignore stop */
  return null;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, " ")}"`;
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''").replace(/\r?\n/g, " ")}'`;
}

function trailingSep(path: string): string {
  /* c8 ignore start — callers pass `existingDirectoryOrParent(...)` or
     `homedir()` results, both of which never carry a trailing separator
     on posix runners. The truthy branch is forward-defensive. */
  return path.endsWith(sep) ? path : `${path}${sep}`;
  /* c8 ignore stop */
}

export function findExecutableOnPath(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const entries = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    for (const name of names) {
      /* c8 ignore start — `process.platform === "win32"` truthy and
         the PATHEXT fallback are unreachable on posix CI runners; full
         coverage would require process.platform mocking which ESM
         blocks. Posix returns `[""]` deterministically. */
      const extensions = process.platform === "win32" && !/\.[A-Za-z0-9]+$/.test(name)
        ? (env.PATHEXT?.split(";").filter(Boolean) ?? [".exe", ".cmd", ".bat"])
        : [""];
      /* c8 ignore stop */
      for (const ext of extensions) {
        const candidate = join(entry, `${name}${ext}`);
        try {
          accessSync(candidate, fsConstants.X_OK);
          return candidate;
        } catch {
          // Keep searching.
        }
      }
    }
  }
  return null;
}

export function buildDirectoryPickerCommand(
  input: DirectoryPickerInput,
  options: Pick<
    PickDirectoryOptions,
    "platform" | "env" | "findExecutable"
  > = {},
): PickerCommand | { unavailable: string } {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const title = input.title?.trim() || DEFAULT_TITLE;
  const defaultDir = existingDirectoryOrParent(input.defaultPath);

  if (platform === "darwin") {
    const defaultClause = defaultDir
      ? ` default location (POSIX file ${appleScriptString(defaultDir)})`
      : "";
    const script = [
      `set selectedFolder to choose folder with prompt ${appleScriptString(title)}${defaultClause}`,
      "POSIX path of selectedFolder",
    ].join("\n");
    return {
      command: "osascript",
      args: ["-e", script],
      method: "osascript",
    };
  }

  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.Description = ${powershellString(title)}`,
      "$dialog.ShowNewFolderButton = $true",
      ...(defaultDir ? [`$dialog.SelectedPath = ${powershellString(defaultDir)}`] : []),
      "$result = $dialog.ShowDialog()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
    ].join("; ");
    // Prefer Windows PowerShell 5.1 (`powershell.exe`) — in-box on every
    // modern desktop SKU. Fall back to `pwsh.exe` for PowerShell-Core-only
    // installs (Windows Server Core, pwsh-only setups). Mirrors the
    // resolution order in `secret-client-factory.ts`.
    const finder = options.findExecutable ?? findExecutableOnPath;
    const psBinary = finder(["powershell.exe"], env)
      ? "powershell.exe"
      : finder(["pwsh.exe"], env)
        ? "pwsh.exe"
        : "powershell.exe";
    return {
      command: psBinary,
      args: ["-NoProfile", "-STA", "-Command", script],
      method: "powershell",
    };
  }

  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
      return {
        unavailable:
          "No graphical desktop session is available for opening a folder picker.",
      };
    }

    const finder = options.findExecutable ?? findExecutableOnPath;
    const startDir = defaultDir ?? homedir();
    const zenity = finder(["zenity"], env);
    if (zenity) {
      return {
        command: zenity,
        args: [
          "--file-selection",
          "--directory",
          "--title",
          title,
          `--filename=${trailingSep(startDir)}`,
        ],
        method: "zenity",
      };
    }

    const kdialog = finder(["kdialog"], env);
    if (kdialog) {
      return {
        command: kdialog,
        args: ["--title", title, "--getexistingdirectory", startDir],
        method: "kdialog",
      };
    }

    const yad = finder(["yad"], env);
    if (yad) {
      return {
        command: yad,
        args: [
          "--file-selection",
          "--directory",
          "--title",
          title,
          `--filename=${trailingSep(startDir)}`,
        ],
        method: "yad",
      };
    }

    return {
      unavailable:
        "Install zenity, kdialog, or yad to use the graphical folder picker on this Linux desktop.",
    };
  }

  return {
    unavailable: `Folder picker is not supported on platform ${platform}.`,
  };
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        error,
      });
    });
    child.on("close", (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
  });
}

function stripLineEnding(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

function normalizeSelectedPath(value: string): string {
  const normalized = normalize(value);
  const root = parse(normalized).root;
  let next = normalized;
  while (next.length > root.length && /[\\/]$/.test(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

function isCancelled(command: PickerCommand, result: CommandResult): boolean {
  if (result.code === 0 && stripLineEnding(result.stdout).trim().length === 0) {
    return true;
  }
  if (
    command.method === "osascript"
    && /user canceled/i.test(result.stderr)
  ) {
    return true;
  }
  if (
    (command.method === "zenity"
      || command.method === "kdialog"
      || command.method === "yad")
    && result.code === 1
    && result.stdout.trim().length === 0
  ) {
    return true;
  }
  return false;
}

export async function pickDirectory(
  options: PickDirectoryOptions = {},
): Promise<DirectoryPickerResponse> {
  const command = buildDirectoryPickerCommand(options, options);
  if ("unavailable" in command) {
    return { status: "unavailable", message: command.unavailable };
  }

  const runner = options.runner ?? runCommand;
  const result = await runner(
    command.command,
    command.args,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (result.error) {
    return {
      status: "unavailable",
      method: command.method,
      message:
        result.error.code === "ENOENT"
          ? `${command.command} is not available on this machine.`
          : result.error.message,
    };
  }
  if (result.timedOut) {
    return {
      status: "unavailable",
      method: command.method,
      message: "Folder picker timed out.",
    };
  }
  if (isCancelled(command, result)) {
    return { status: "cancelled", method: command.method };
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    return {
      status: "unavailable",
      method: command.method,
      message: `Folder picker failed: ${detail}`,
    };
  }

  const selected = stripLineEnding(result.stdout).trim();
  /* c8 ignore start — `isCancelled` already returns true when stdout
     trims to "" with code===0, and code!==0 is filtered into the
     "Folder picker failed" branch above. By the time control reaches
     here `selected` is always non-empty; the guard is forward-defensive. */
  if (!selected) return { status: "cancelled", method: command.method };
  /* c8 ignore stop */
  return {
    status: "selected",
    path: normalizeSelectedPath(selected),
    method: command.method,
  };
}

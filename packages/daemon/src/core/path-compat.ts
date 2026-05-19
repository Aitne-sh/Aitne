import path from "node:path";

type PathApi = typeof path.posix;

export type PathFlavor = "posix" | "win32";

function looksWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.includes("\\");
}

export function inferPathFlavor(...values: string[]): PathFlavor {
  return values.some(looksWindowsPath) ? "win32" : "posix";
}

function apiForFlavor(flavor: PathFlavor): PathApi {
  return flavor === "win32" ? path.win32 : path.posix;
}

/**
 * Segment-aware containment check that works for both POSIX and Windows paths.
 *
 * Native `startsWith(parent + "/")` checks fail on Windows because `\` is the
 * path separator, and they also mis-handle paths on different Windows drives.
 */
export function isPathInsideOrEqual(
  parent: string,
  candidate: string,
  flavor: PathFlavor = inferPathFlavor(parent, candidate),
): boolean {
  const p = apiForFlavor(flavor);
  const rel = p.relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

export function trimTrailingSeparators(value: string, flavor: PathFlavor): string {
  const p = apiForFlavor(flavor);
  const root = p.parse(value).root;
  let next = value;
  while (next.length > root.length && /[\\/]+$/.test(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export function slashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Return likely raw command-text forms for an absolute path. This is used by
 * backend guardrail hooks that inspect shell command strings before execution.
 */
export function shellPathForms(absPath: string, homeDir: string): string[] {
  const flavor = inferPathFlavor(absPath, homeDir);
  const p = apiForFlavor(flavor);
  const nativePath = trimTrailingSeparators(p.normalize(absPath), flavor);
  const forms = [nativePath, slashPath(nativePath)];
  const nativeHome = trimTrailingSeparators(p.normalize(homeDir), flavor);

  if (
    nativePath !== nativeHome &&
    isPathInsideOrEqual(nativeHome, nativePath, flavor)
  ) {
    const relative = p.relative(nativeHome, nativePath);
    const slashRelative = slashPath(relative);

    if (flavor === "win32") {
      forms.push(
        `~\\${relative}`,
        `~/${slashRelative}`,
        `%USERPROFILE%\\${relative}`,
        `%USERPROFILE%/${slashRelative}`,
        `$env:USERPROFILE\\${relative}`,
        `$env:USERPROFILE/${slashRelative}`,
        `$HOME/${slashRelative}`,
        `\${HOME}/${slashRelative}`,
      );
    } else {
      forms.push(
        `~/${slashRelative}`,
        `$HOME/${slashRelative}`,
        `\${HOME}/${slashRelative}`,
      );
    }
  }

  return unique(forms);
}

/**
 * Forms as they appear inside a JSON-stringified tool args object, where
 * Windows backslashes are doubled.
 */
export function jsonStringPathForms(forms: string[]): string[] {
  return unique(forms.map((form) => JSON.stringify(form).slice(1, -1)));
}

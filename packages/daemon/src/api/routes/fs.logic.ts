import { isAbsolute, normalize, resolve, sep } from "node:path";

/**
 * Wiki-vault path probe — pure path-classification helpers.
 *
 * The route `/api/fs/probe` validates a user-chosen external wiki vault
 * directory (WIKI_BUILDER_DESIGN.md §6.1 / §7). Selection is handled by
 * the existing system-native picker — this module is only the guard
 * layer that runs before any filesystem call.
 *
 * Reasoning lives here so it can be unit-tested without spinning up
 * Hono, and so a future surface (CLI, MCP tool) can reuse the same
 * guards.
 *
 * Threat model: the user is the principal who triggers picker requests
 * from the dashboard (Bearer-gated; the whole `/api/fs` prefix is
 * `RiskTier.Approve`). These guards exist so that even if an agent
 * extracts a Bearer it cannot use the probe to confirm secret-material
 * locations.
 */

/**
 * Path prefixes the probe refuses. System-managed locations that
 * contain no user content the picker legitimately needs to validate;
 * additionally protected against an operator pasting a system path
 * into the manual input.
 */
export const FORBIDDEN_PREFIXES: ReadonlyArray<string> = [
  "/etc",
  "/var",
  "/dev",
  "/sys",
  "/proc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/root",
  // macOS
  "/System",
  "/private/etc",
  "/private/var",
  "/private/tmp",
  "/Library/Application Support/com.apple",
];

/**
 * Exempt subtrees inside `FORBIDDEN_PREFIXES`. macOS's `os.tmpdir()`
 * resolves to `/var/folders/<hash>/T` (`/private/var/folders/...` after
 * `realpath`) — user processes are explicitly supposed to put files
 * there, and Aitne's setup wizard surfaces tmpdir as a valid choice
 * for "scratch vault" testing. Mirrors `SYSTEM_PATH_EXEMPTIONS` in
 * `config.ts` so the picker's view of "valid user-writable space"
 * matches `validatePrimaryVaultPath`.
 */
export const FORBIDDEN_PREFIX_EXEMPTIONS: ReadonlyArray<string> = [
  "/var/folders/",
  "/private/var/folders/",
];

/**
 * Per-path secret patterns. Mirrors the `Read(...)` globs in
 * `always-disallowed.ts` so the probe stays in lockstep with the
 * absolute-block layer. A future addition to always-disallowed must
 * also be added here; the test file holds the drift guard.
 */
export const SECRET_ABS_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.ssh(\/.*)?$/,
  /(^|\/)\.gnupg(\/.*)?$/,
  /(^|\/)\.aws(\/.*)?$/,
  /(^|\/)\.config\/gcloud(\/.*)?$/,
  /(^|\/)\.config\/gh\/hosts\.yml$/,
  /(^|\/)\.local\/share\/keyrings(\/.*)?$/,
  /\/Library\/Keychains(\/.*)?$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.personal-agent\/secrets(\/.*)?$/,
  /(^|\/)\.personal-agent\/backups(\/.*)?$/,
  /(^|\/)\.personal-agent\/whatsapp(\/.*)?$/,
  /(^|\/)id_rsa(\..*)?$/,
  /(^|\/)id_ed25519(\..*)?$/,
];

export function isSecretPath(absPath: string): boolean {
  // SECRET_ABS_PATTERNS are POSIX-slash anchored, so a backslash-delimited
  // Windows path (e.g. `C:\Users\me\.ssh\id_rsa`) would slip past them.
  // Normalising separators is inert on macOS/Linux (legitimate secret-dir
  // paths there contain no backslashes) and closes the Windows gap.
  const p = absPath.replace(/\\/g, "/");
  return SECRET_ABS_PATTERNS.some((re) => re.test(p));
}

export function isUnderForbidden(absPath: string): boolean {
  // Exemptions take precedence — a path under `/var/folders/...`
  // matches the `/var` prefix below but is legitimate user space.
  for (const exempt of FORBIDDEN_PREFIX_EXEMPTIONS) {
    if (absPath.startsWith(exempt)) return false;
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (absPath === prefix) return true;
    if (absPath.startsWith(prefix + sep)) return true;
  }
  return false;
}

/**
 * Normalise a path supplied by the dashboard before any FS call.
 *
 * Returns the resolved absolute path on success, or a structured error
 * the route returns as `400 { error, message }`. Never throws — invalid
 * input always becomes a typed error.
 */
export function normalizeRequestedPath(raw: string): NormalizeResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "invalid_path", message: "Path is required." };
  }
  // NUL bytes — node's path APIs accept them and downstream calls
  // would then throw `ERR_INVALID_ARG_VALUE`.
  if (raw.includes("\0")) {
    return { ok: false, error: "invalid_path", message: "Path contains NUL." };
  }
  if (!isAbsolute(raw)) {
    return {
      ok: false,
      error: "relative_path",
      message: "Path must be absolute.",
    };
  }
  const absPath = resolve(normalize(raw));
  if (isUnderForbidden(absPath)) {
    return {
      ok: false,
      error: "forbidden_prefix",
      message: "Path is under a system-managed prefix.",
    };
  }
  if (isSecretPath(absPath)) {
    return {
      ok: false,
      error: "secret_path",
      message: "Path matches a known secret-material location.",
    };
  }
  return { ok: true, path: absPath };
}

export type NormalizeResult =
  | { ok: true; path: string }
  | { ok: false; error: NormalizeError; message: string };

export type NormalizeError =
  | "invalid_path"
  | "relative_path"
  | "forbidden_prefix"
  | "secret_path";

import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Symlink-safe atomic file write.
 *
 * Closes the TOCTOU race that exists between a path-validation step
 * (e.g. `safePath` in the Context API) and the actual `writeFileSync`.
 * Without this, an attacker who can place a symlink at the validated
 * destination *after* validation but *before* the write would cause
 * `writeFileSync` to follow the symlink and overwrite an arbitrary file.
 *
 * Two layers of defense:
 *
 * 1. **`O_NOFOLLOW` + `O_EXCL` on a fresh temp path.** We never open the
 *    final destination directly. Instead we open a randomly-suffixed temp
 *    file in the same directory using `O_NOFOLLOW`, which makes `open(2)`
 *    fail with `ELOOP` if a symlink ever appears at the temp path, and
 *    `O_EXCL`, which makes `open(2)` fail with `EEXIST` if anything is
 *    already there. The random suffix ensures an attacker cannot
 *    pre-place a target.
 *
 * 2. **`rename(2)` over the destination.** POSIX `rename` replaces the
 *    target atomically *without* dereferencing a symlink that may exist
 *    at the destination — the symlink itself is replaced by the renamed
 *    file. Combined with the temp-file open above, this means at no
 *    point does our process write through a symlink.
 *
 * The caller is still responsible for validating that the destination is
 * inside an allowed root (the Context API does this via `safePath`). This
 * helper only protects the write step.
 *
 * Notes:
 * - `fsync` is called on the temp fd before rename so a power loss between
 *   write and rename does not leave a half-written file as the canonical
 *   one. The directory itself is not fsync'd; the existing context-api
 *   write path does not do this either, and adding it would be a separate
 *   durability change beyond the scope of the symlink fix.
 * - The parent directory is created with `mkdirSync({ recursive: true })`
 *   if missing — the same behavior as the original write paths. After
 *   creation we `lstat` it to assert it is a regular directory, not a
 *   symlink. This is defense-in-depth: the caller should already have
 *   resolved the parent through realpath, but a TOCTOU swap between
 *   that resolution and our open is still possible in theory.
 *
 * Throws on:
 * - The destination already exists and is a symlink (`EEXIST`-style error
 *   thrown explicitly so the caller surfaces a clear message rather than
 *   silently following the link).
 * - The parent directory is itself a symlink after `mkdirSync`.
 * - Any underlying I/O failure from `open` / `write` / `rename`.
 */
export function writeFileAtomically(fullPath: string, content: string): void {
  const dir = dirname(fullPath);
  mkdirSync(dir, { recursive: true });

  // Defense-in-depth: refuse if the parent directory itself is a symlink.
  // Realistic exploits require an attacker who can create symlinks inside
  // the validated context root — which is not reachable through the
  // public API surface, but the kernel accepts symlinks at any component
  // of the path. Asserting this here makes the failure mode loud rather
  // than silent if the invariant is ever violated.
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink()) {
    throw Object.assign(
      new Error(`atomic-write: parent directory is a symlink: ${dir}`),
      { code: "EATOMIC_PARENT_SYMLINK" },
    );
  }

  // Refuse to overwrite a symlink at the final path. lstat is racy on its
  // own — the actual TOCTOU defense is the rename below — but surfacing
  // the symlink early gives a clearer error than letting rename quietly
  // replace an attacker's link. Also reuse the lstat result to preserve
  // the existing file's permission bits — a fresh `openSync(..., 0o644)`
  // would silently widen a 0o600 file (e.g. sensitive dossier / policy)
  // on every write.
  let createMode = 0o600;
  try {
    const targetStat = lstatSync(fullPath);
    if (targetStat.isSymbolicLink()) {
      throw Object.assign(
        new Error(`atomic-write: refusing to overwrite symlink: ${fullPath}`),
        { code: "EATOMIC_TARGET_SYMLINK" },
      );
    }
    if (targetStat.isFile()) {
      createMode = targetStat.mode & 0o777;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EATOMIC_TARGET_SYMLINK") throw err;
    /* c8 ignore start — non-ENOENT errors (EACCES, EIO) are platform-rare;
       the rethrow is a defensive guard, not a tested path. */
    if (code !== "ENOENT") throw err;
    /* c8 ignore stop */
    // ENOENT is expected when the file does not exist yet — `createMode`
    // stays at the conservative 0o600 default. Context MD files contain
    // operator PII / plans; defaulting to owner-only is safer than the
    // historical 0o644.
  }

  // Random suffix prevents an attacker from pre-placing a symlink at our
  // temp path even if they can guess the pid. 16 hex chars = 64 bits of
  // entropy, more than enough for collision avoidance.
  const tempPath = `${fullPath}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_NOFOLLOW;

  const fd = openSync(tempPath, flags, createMode);
  try {
    const buf = Buffer.from(content, "utf-8");
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    fsyncSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // If close fails after a write/fsync error, the original error is
      // more informative. Swallow the secondary failure.
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup. If unlink fails the temp file will be
      // garbage-collected by the next retention sweep or restart.
    }
    throw err;
  }
  closeSync(fd);

  try {
    renameSync(tempPath, fullPath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Same rationale as the unlink above: best-effort.
    }
    throw err;
  }
}

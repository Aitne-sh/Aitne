import { spawn } from "node:child_process";

/**
 * Run a command with stdin input piped from a string.
 *
 * Unlike `promisify(execFile)`, this supports writing to the child's stdin,
 * which is needed by `secret-tool store` (Linux) and PowerShell DPAPI
 * (Windows) where values must be passed via stdin to avoid command injection.
 */
export function execWithStdin(
  command: string,
  args: string[],
  input: string,
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options?.timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data;
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data;
    });

    // Handle spawn errors (e.g., command not found) before writing to stdin
    child.on("error", reject);

    // Handle write-side stream errors. When the child closes/exits its stdin
    // before the piped input fully drains — PowerShell DPAPI on Windows, or
    // `secret-tool store` on Linux exiting early (locked keyring, malformed
    // args, fast startup failure) — Node emits EPIPE / ERR_STREAM_DESTROYED
    // on `child.stdin`. Without this listener that event is unhandled and
    // crashes the entire daemon. `child.on("error")` only catches spawn
    // failures, not write-side stream errors, so this is a distinct listener.
    // (macOS uses the native Keychain client and never routes through here.)
    child.stdin.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Exit ${code}: ${stderr}`));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

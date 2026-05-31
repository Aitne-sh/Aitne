import { describe, it, expect } from "vitest";
import { execWithStdin } from "./exec-with-stdin.js";

describe("execWithStdin", () => {
  it("pipes input to stdin and captures stdout", async () => {
    const { stdout } = await execWithStdin(
      "node",
      ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
      "hello world",
      { timeout: 5_000 },
    );
    expect(stdout).toBe("hello world");
  });

  it("rejects when process exits with non-zero code", async () => {
    await expect(
      execWithStdin("node", ["-e", "process.exit(1)"], "", { timeout: 5_000 }),
    ).rejects.toThrow("Exit 1");
  });

  it("rejects when command is not found", async () => {
    await expect(
      execWithStdin("nonexistent-command-xyz", [], "", { timeout: 5_000 }),
    ).rejects.toThrow();
  });

  it("captures stderr in error message", async () => {
    await expect(
      execWithStdin(
        "node",
        ["-e", "process.stderr.write('oops'); process.exit(2)"],
        "",
        { timeout: 5_000 },
      ),
    ).rejects.toThrow("oops");
  });

  it("rejects (does not crash) when the child closes stdin before input drains", async () => {
    // The child exits immediately without reading stdin. Writing a payload
    // larger than the OS pipe buffer to the now-closed stdin emits an
    // 'error' (EPIPE / ERR_STREAM_DESTROYED) on child.stdin. Without the
    // stdin 'error' listener this is an unhandled event that crashes the
    // whole process; with it, the promise rejects. The child exits non-zero
    // so the assertion holds regardless of whether the stdin error or the
    // close event wins the race. This mirrors the real-world DPAPI/secret-tool
    // early-exit broken-pipe scenario (secrets-store-1).
    const bigInput = "x".repeat(8 * 1024 * 1024); // 8 MB ≫ pipe buffer
    await expect(
      execWithStdin("node", ["-e", "process.exit(1)"], bigInput, {
        timeout: 5_000,
      }),
    ).rejects.toThrow();
  });
});

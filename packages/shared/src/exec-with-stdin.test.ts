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
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  escapeSandboxLiteral,
  installSandboxExecProfile,
  pathAncestors,
  renderAncestorMetadataLiterals,
} from "./sandbox-install.js";

describe("pathAncestors", () => {
  it("returns the chain from the top-level component down to the parent", () => {
    expect(
      pathAncestors(
        "/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app",
      ),
    ).toEqual([
      "/Users",
      "/Users/example",
      "/Users/example/Library",
      "/Users/example/Library/Caches",
      "/Users/example/Library/Caches/ms-playwright",
      "/Users/example/Library/Caches/ms-playwright/chromium-1223",
      "/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64",
    ]);
  });

  it("returns the empty list for top-level paths", () => {
    expect(pathAncestors("/")).toEqual([]);
    expect(pathAncestors("/Users")).toEqual([]);
  });

  it("ignores duplicate / trailing slashes", () => {
    expect(pathAncestors("/Users//example///foo/")).toEqual([
      "/Users",
      "/Users/example",
    ]);
  });

  it("rejects non-absolute paths", () => {
    expect(() => pathAncestors("Users/example")).toThrow(/absolute/);
    expect(() => pathAncestors("")).toThrow(/absolute/);
  });
});

describe("escapeSandboxLiteral", () => {
  it("escapes embedded quotes and backslashes", () => {
    expect(escapeSandboxLiteral('/tmp/he"llo')).toBe('/tmp/he\\"llo');
    expect(escapeSandboxLiteral("/tmp/back\\slash")).toBe("/tmp/back\\\\slash");
  });

  it("leaves ordinary POSIX paths unchanged", () => {
    expect(escapeSandboxLiteral("/Users/example/Library/Caches")).toBe(
      "/Users/example/Library/Caches",
    );
  });
});

describe("renderAncestorMetadataLiterals", () => {
  it("emits deduped, sorted, indented (literal ...) lines", () => {
    const rendered = renderAncestorMetadataLiterals([
      "/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app",
      "/Users/example/.personal-agent/chromium-automation-anon/abc-123",
    ]);
    expect(rendered).toBe(
      [
        '  (literal "/Users")',
        '  (literal "/Users/example")',
        '  (literal "/Users/example/.personal-agent")',
        '  (literal "/Users/example/.personal-agent/chromium-automation-anon")',
        '  (literal "/Users/example/Library")',
        '  (literal "/Users/example/Library/Caches")',
        '  (literal "/Users/example/Library/Caches/ms-playwright")',
        '  (literal "/Users/example/Library/Caches/ms-playwright/chromium-1223")',
        '  (literal "/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64")',
      ].join("\n"),
    );
  });

  it("falls back to a single (literal \"/\") line when no ancestors exist", () => {
    expect(renderAncestorMetadataLiterals(["/", "/Users"])).toBe(
      '  (literal "/")',
    );
  });

  it("escapes adversarial path characters in the emitted literals", () => {
    expect(renderAncestorMetadataLiterals(['/tmp/ev"il/foo'])).toBe(
      ['  (literal "/tmp")', '  (literal "/tmp/ev\\"il")'].join("\n"),
    );
  });
});

const itDarwin = process.platform === "darwin" ? it : it.skip;

describe("installSandboxExecProfile", () => {
  itDarwin(
    "renders all four placeholders and ancestor metadata into the installed profile",
    async () => {
      const paDataDir = await mkdtemp(join(tmpdir(), "aitne-sandbox-install-"));
      try {
        const binaryPath =
          "/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
        const userDataDir =
          "/Users/example/.personal-agent/chromium-automation-anon/abc-123";
        const outPath = await installSandboxExecProfile({
          paDataDir,
          binaryPath,
          userDataDir,
        });

        expect(outPath).toBe(join(paDataDir, "sandbox", "aitne-chromium.sb"));
        const rendered = await readFile(outPath, "utf8");

        // No placeholders left.
        expect(rendered).not.toContain("%binary_path%");
        expect(rendered).not.toContain("%binary_bundle%");
        expect(rendered).not.toContain("%user_data_dir%");
        expect(rendered).not.toContain("%ancestor_metadata_literals%");

        // macOS-26 fixes present.
        expect(rendered).toMatch(/\(allow file-read\*[\s\S]*\(literal "\/"\)/);
        expect(rendered).toContain('(literal "/dev/dtracehelper")');

        // Ancestor metadata block exists and contains the expected traversal
        // chain (union of bundle + user_data_dir ancestors).
        expect(rendered).toMatch(
          /\(allow file-read-metadata\s+(?:\(literal "[^"]+"\)\s*)+\)/,
        );
        for (const ancestor of [
          "/Users",
          "/Users/example",
          "/Users/example/.personal-agent",
          "/Users/example/.personal-agent/chromium-automation-anon",
          "/Users/example/Library",
          "/Users/example/Library/Caches",
          "/Users/example/Library/Caches/ms-playwright",
          "/Users/example/Library/Caches/ms-playwright/chromium-1223",
          "/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64",
        ]) {
          expect(rendered).toContain(`(literal "${ancestor}")`);
        }

        // The binary path placeholder is substituted with the concrete
        // absolute path (process-exec literal + helper executables under
        // the .app are reached via the bundle subpath).
        expect(rendered).toContain(`(literal "${binaryPath}")`);
        expect(rendered).toContain(
          '(subpath "/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app")',
        );
        expect(rendered).toContain(`(subpath "${userDataDir}")`);
      } finally {
        await rm(paDataDir, { recursive: true, force: true });
      }
    },
  );
});

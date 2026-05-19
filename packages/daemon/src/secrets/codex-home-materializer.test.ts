import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import {
  clearCodexAzureConfig,
  materializeCodexAzureConfig,
  resolveCodexHomePath,
} from "./codex-home-materializer.js";

describe("codex-home-materializer", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "aitne-codex-home-test-"));
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("creates the codex-home dir + writes config.toml on materialize", () => {
    const home = materializeCodexAzureConfig(dataDir, {
      provider: "azure-openai",
      resource: "my-resource",
      apiKey: "k",
    });

    expect(home).toBe(resolveCodexHomePath(dataDir));
    const toml = readFileSync(join(home, "config.toml"), "utf-8");
    expect(toml).toContain("[model_providers.azure]");
    expect(toml).toContain(
      'base_url = "https://my-resource.openai.azure.com/openai/v1"',
    );
    expect(toml).toContain('env_key = "AZURE_OPENAI_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
  });

  /**
   * Parse-roundtrip the generated TOML to verify Codex CLI will read
   * `model_provider` at the top level, not nested under
   * `[model_providers.azure]`. A previous iteration of this code
   * emitted `model_provider = "azure"` AFTER the section header,
   * which TOML implicitly nested as
   * `model_providers.azure.model_provider`, leaving the top-level key
   * unset and Codex routing through the OpenAI default. This test
   * pins the structural invariant via a real TOML parse so the
   * regression cannot recur.
   */
  it("emits `model_provider` and `model` at the TOML top level (not nested)", () => {
    const home = materializeCodexAzureConfig(dataDir, {
      provider: "azure-openai",
      resource: "my-resource",
      apiKey: "k",
      deploymentName: "gpt-prod-deployment",
    });
    const tomlString = readFileSync(join(home, "config.toml"), "utf-8");
    const parsed = TOML.parse(tomlString) as {
      model_provider?: string;
      model?: string;
      model_providers?: {
        azure?: {
          name?: string;
          base_url?: string;
          env_key?: string;
          wire_api?: string;
          model_provider?: unknown;
          model?: unknown;
        };
      };
    };

    // Top-level keys present and correct
    expect(parsed.model_provider).toBe("azure");
    expect(parsed.model).toBe("gpt-prod-deployment");

    // Provider definition present
    expect(parsed.model_providers?.azure?.env_key).toBe(
      "AZURE_OPENAI_API_KEY",
    );
    expect(parsed.model_providers?.azure?.wire_api).toBe("responses");
    expect(parsed.model_providers?.azure?.base_url).toBe(
      "https://my-resource.openai.azure.com/openai/v1",
    );

    // Critical: model_provider / model must NOT be nested under the
    // azure section (the original bug).
    expect(parsed.model_providers?.azure?.model_provider).toBeUndefined();
    expect(parsed.model_providers?.azure?.model).toBeUndefined();
  });

  it("file mode is 0600 (config embeds production routing)", () => {
    const home = materializeCodexAzureConfig(dataDir, {
      provider: "azure-openai",
      resource: "my-resource",
      apiKey: "k",
    });
    const stats = statSync(join(home, "config.toml"));
    // Mask out the file-type bits and check perms only.
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("idempotent: re-materializing overwrites without throwing", () => {
    materializeCodexAzureConfig(dataDir, {
      provider: "azure-openai",
      resource: "old-resource",
      apiKey: "k1",
    });
    materializeCodexAzureConfig(dataDir, {
      provider: "azure-openai",
      resource: "new-resource",
      apiKey: "k2",
      deploymentName: "gpt-prod",
    });
    const toml = readFileSync(
      join(resolveCodexHomePath(dataDir), "config.toml"),
      "utf-8",
    );
    expect(toml).toContain("new-resource");
    expect(toml).toContain('model = "gpt-prod"');
    expect(toml).not.toContain("old-resource");
  });

  it("clearCodexAzureConfig removes config.toml when present", () => {
    const home = materializeCodexAzureConfig(dataDir, {
      provider: "azure-openai",
      resource: "x",
      apiKey: "k",
    });
    expect(() => statSync(join(home, "config.toml"))).not.toThrow();

    clearCodexAzureConfig(dataDir);

    expect(() => statSync(join(home, "config.toml"))).toThrow();
  });

  it("clearCodexAzureConfig is a no-op when nothing was materialized", () => {
    expect(() => clearCodexAzureConfig(dataDir)).not.toThrow();
  });

  it("logs and returns when rmSync of config.toml throws (best-effort)", async () => {
    // The `clearCodexAzureConfig` catch block is reached only when
    // `rmSync({force: true})` rejects with something other than the
    // missing-file case it would otherwise swallow. We trigger this
    // by replacing config.toml's parent dir with a chmod-locked
    // directory: rmSync of a file inside an unwritable dir raises
    // EACCES, which the helper must catch + log + return.
    const { chmodSync } = await import("node:fs");
    materializeCodexAzureConfig(dataDir, {
      provider: "azure-openai",
      resource: "x",
      apiKey: "k",
    });
    const codexHome = join(dataDir, "codex-home");
    chmodSync(codexHome, 0o500); // r-x — no write
    try {
      // EACCES on the rmSync(tomlPath) call lands in the catch block
      // and an early `return` short-circuits the parent-dir cleanup.
      // The helper must NOT throw the underlying error to its caller.
      const { clearCodexAzureConfig } = await import(
        "./codex-home-materializer.js"
      );
      expect(() => clearCodexAzureConfig(dataDir)).not.toThrow();
    } finally {
      // Restore so afterEach can clean up.
      chmodSync(codexHome, 0o700);
    }
  });

  it("never touches files outside <dataDir>/codex-home/", () => {
    // Sentinel file that lives next to codex-home — must survive
    // materialize + clear cycles.
    const sentinelPath = join(dataDir, "sentinel.txt");
    writeFileSync(sentinelPath, "do not delete");

    materializeCodexAzureConfig(dataDir, {
      provider: "azure-openai",
      resource: "x",
      apiKey: "k",
    });
    clearCodexAzureConfig(dataDir);

    expect(readFileSync(sentinelPath, "utf-8")).toBe("do not delete");
  });
});

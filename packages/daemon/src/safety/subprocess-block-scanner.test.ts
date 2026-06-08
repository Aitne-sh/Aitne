import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../db/schema.js";
import {
  auditStreamObservation,
  extractCodexShellCall,
  extractGeminiToolUseTarget,
  extractOpencodeToolUseTarget,
} from "./subprocess-block-scanner.js";

describe("extractCodexShellCall", () => {
  it("extracts a string `command` field", () => {
    const out = extractCodexShellCall({ command: "rm -rf ~" });
    expect(out).toEqual({ toolName: "Bash", arg: "rm -rf ~" });
  });

  it("extracts an argv array under `action.command`", () => {
    const out = extractCodexShellCall({
      action: { type: "exec", command: ["rm", "-rf", "/tmp/foo"] },
    });
    expect(out).toEqual({ toolName: "Bash", arg: "rm -rf /tmp/foo" });
  });

  it("extracts a string `action.command`", () => {
    const out = extractCodexShellCall({ action: { command: "sudo ls" } });
    expect(out).toEqual({ toolName: "Bash", arg: "sudo ls" });
  });

  it("extracts a string `input.command`", () => {
    const out = extractCodexShellCall({ input: { command: "rm -rf foo" } });
    expect(out).toEqual({ toolName: "Bash", arg: "rm -rf foo" });
  });

  it("returns null on non-shell items", () => {
    expect(extractCodexShellCall({ name: "search_files" })).toBeNull();
    expect(extractCodexShellCall(undefined)).toBeNull();
    expect(extractCodexShellCall(null)).toBeNull();
    expect(extractCodexShellCall({})).toBeNull();
  });
});

describe("extractGeminiToolUseTarget", () => {
  it("maps run_shell_command to Bash", () => {
    const out = extractGeminiToolUseTarget("run_shell_command", {
      command: "rm -rf /",
    });
    expect(out).toEqual({ toolName: "Bash", arg: "rm -rf /" });
  });

  it("maps shell to Bash (older versions)", () => {
    const out = extractGeminiToolUseTarget("shell", { command: "sudo cat" });
    expect(out).toEqual({ toolName: "Bash", arg: "sudo cat" });
  });

  it("maps read_file to Read", () => {
    const out = extractGeminiToolUseTarget("read_file", {
      absolute_path: "/etc/passwd",
    });
    expect(out).toEqual({ toolName: "Read", arg: "/etc/passwd" });
  });

  it("maps write_file to Write", () => {
    const out = extractGeminiToolUseTarget("write_file", {
      file_path: "/var/log/foo",
    });
    expect(out).toEqual({ toolName: "Write", arg: "/var/log/foo" });
  });

  it("maps replace to Edit", () => {
    const out = extractGeminiToolUseTarget("replace", {
      file_path: "/etc/hosts",
    });
    expect(out).toEqual({ toolName: "Edit", arg: "/etc/hosts" });
  });

  it("returns null for unknown tools or missing args", () => {
    expect(extractGeminiToolUseTarget("unknown", {})).toBeNull();
    expect(
      extractGeminiToolUseTarget("run_shell_command", undefined),
    ).toBeNull();
    expect(extractGeminiToolUseTarget(undefined, { command: "x" })).toBeNull();
    expect(extractGeminiToolUseTarget("run_shell_command", {})).toBeNull();
  });

  it("falls back through file_path / path on read_file when absolute_path missing", () => {
    expect(
      extractGeminiToolUseTarget("read_file", { file_path: "/etc/shadow" }),
    ).toEqual({ toolName: "Read", arg: "/etc/shadow" });
    expect(
      extractGeminiToolUseTarget("read_file", { path: "/etc/shadow" }),
    ).toEqual({ toolName: "Read", arg: "/etc/shadow" });
  });

  it("falls back through absolute_path / path on write_file when file_path missing", () => {
    expect(
      extractGeminiToolUseTarget("write_file", { absolute_path: "/var/log/x" }),
    ).toEqual({ toolName: "Write", arg: "/var/log/x" });
    expect(
      extractGeminiToolUseTarget("write_file", { path: "/var/log/x" }),
    ).toEqual({ toolName: "Write", arg: "/var/log/x" });
  });

  it("falls back through absolute_path / path on replace when file_path missing", () => {
    expect(
      extractGeminiToolUseTarget("replace", { absolute_path: "/etc/hosts" }),
    ).toEqual({ toolName: "Edit", arg: "/etc/hosts" });
    expect(
      extractGeminiToolUseTarget("replace", { path: "/etc/hosts" }),
    ).toEqual({ toolName: "Edit", arg: "/etc/hosts" });
  });
});

describe("extractOpencodeToolUseTarget", () => {
  it("maps bash to Bash", () => {
    const out = extractOpencodeToolUseTarget("bash", { command: "rm -rf /" });
    expect(out).toEqual({ toolName: "Bash", arg: "rm -rf /" });
  });

  it("maps read to Read (filePath preferred)", () => {
    const out = extractOpencodeToolUseTarget("read", {
      filePath: "/etc/passwd",
    });
    expect(out).toEqual({ toolName: "Read", arg: "/etc/passwd" });
  });

  it("maps read to Read (falls back to path / file)", () => {
    expect(extractOpencodeToolUseTarget("read", { path: "/a" })).toEqual({
      toolName: "Read",
      arg: "/a",
    });
    expect(extractOpencodeToolUseTarget("read", { file: "/b" })).toEqual({
      toolName: "Read",
      arg: "/b",
    });
  });

  it("maps write and apply_patch to Write", () => {
    expect(
      extractOpencodeToolUseTarget("write", { filePath: "/var/log/x" }),
    ).toEqual({ toolName: "Write", arg: "/var/log/x" });
    expect(
      extractOpencodeToolUseTarget("apply_patch", { filePath: "/etc/hosts" }),
    ).toEqual({ toolName: "Write", arg: "/etc/hosts" });
  });

  it("maps edit to Edit", () => {
    expect(
      extractOpencodeToolUseTarget("edit", { filePath: "/etc/hosts" }),
    ).toEqual({ toolName: "Edit", arg: "/etc/hosts" });
  });

  it("returns null for unknown tools / missing args", () => {
    expect(extractOpencodeToolUseTarget("task", { goal: "x" })).toBeNull();
    expect(extractOpencodeToolUseTarget("bash", {})).toBeNull();
    expect(extractOpencodeToolUseTarget("read", {})).toBeNull();
    expect(extractOpencodeToolUseTarget("write", {})).toBeNull();
    expect(extractOpencodeToolUseTarget("edit", {})).toBeNull();
    expect(extractOpencodeToolUseTarget(undefined, { command: "x" })).toBeNull();
    expect(extractOpencodeToolUseTarget("bash", undefined)).toBeNull();
  });

  it("returns null when the command field is empty string", () => {
    expect(extractOpencodeToolUseTarget("bash", { command: "" })).toBeNull();
  });
});

describe("auditStreamObservation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("writes a blocked_absolute row with result='partial' on a hit", () => {
    const match = auditStreamObservation(
      { toolName: "Bash", arg: "rm -rf ~" },
      { db, backend: "codex", mode: "strict" },
    );

    expect(match).not.toBeNull();
    expect(match?.category).toBe("recursive_delete");

    const rows = db
      .prepare(
        "SELECT action_type, trigger, result, detail, backend FROM agent_actions",
      )
      .all() as Array<{
        action_type: string;
        trigger: string;
        result: string;
        detail: string;
        backend: string;
      }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe("blocked_absolute");
    // Stream-observation rows use a distinct trigger from Claude PreToolUse
    // rows so the audit log can filter the two cleanly. This is part of the
    // (action_type, trigger, result) consistency contract documented in
    // recordAbsoluteBlockAudit.
    expect(rows[0].trigger).toBe("absolute_block_stream_observation");
    expect(rows[0].result).toBe("partial");
    expect(rows[0].backend).toBe("codex");
    const detail = JSON.parse(rows[0].detail);
    expect(detail.category).toBe("recursive_delete");
    expect(detail.observation).toBe("stream");
  });

  it("returns null and writes nothing for benign commands", () => {
    const match = auditStreamObservation(
      { toolName: "Bash", arg: "ls -la" },
      { db, backend: "codex", mode: "strict" },
    );
    expect(match).toBeNull();
    const rows = db.prepare("SELECT id FROM agent_actions").all();
    expect(rows).toHaveLength(0);
  });

  it("captures Gemini Read of a secret path", () => {
    const target = extractGeminiToolUseTarget("read_file", {
      absolute_path: "/Users/x/.ssh/id_rsa",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    const match = auditStreamObservation(target, {
      db,
      backend: "gemini",
      mode: "strict",
    });
    expect(match?.category).toBe("secret_read");

    const row = db
      .prepare(
        "SELECT result, backend, detail FROM agent_actions WHERE action_type = 'blocked_absolute'",
      )
      .get() as { result: string; backend: string; detail: string };
    expect(row.result).toBe("partial");
    expect(row.backend).toBe("gemini");
    const detail = JSON.parse(row.detail);
    expect(detail.observation).toBe("stream");
  });

  it("is a no-op when db is undefined", () => {
    const match = auditStreamObservation(
      { toolName: "Bash", arg: "rm -rf ~" },
      { db: undefined, backend: "codex", mode: "strict" },
    );
    // Match is still returned (caller can act on it), but no DB write happens.
    expect(match).not.toBeNull();
  });
});

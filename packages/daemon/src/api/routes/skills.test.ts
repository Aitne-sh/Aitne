import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSkillsRoutes,
  parseSkillFile,
  serializeSkillFile,
  safeSkillPath,
  listSkillsInRoot,
} from "./skills.js";
import type { AgentConfig } from "../../config.js";

/**
 * Integration tests for /api/skills/* routes.
 *
 * We build a throwaway workspace with a fake built-in skill and a fresh
 * data dir for user skills. The routes never touch anything outside these
 * two roots, so cleanup is just `rm -rf` on both.
 */
describe("Skills API routes", () => {
  let dataDir: string;
  let workspaceDir: string;
  let app: ReturnType<typeof createSkillsRoutes>;

  function makeConfig(): AgentConfig {
    return {
      dataDir,
      workspaceDir,
      // Only the fields the skills route reads matter — the rest are unused.
    } as unknown as AgentConfig;
  }

  beforeEach(() => {
    dataDir = join(tmpdir(), `pa-skills-data-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspaceDir = join(tmpdir(), `pa-skills-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    // Plant a built-in skill at `{workspaceDir}/agent-assets/skills/notify/SKILL.md`
    const builtinDir = join(workspaceDir, "agent-assets", "skills", "notify");
    mkdirSync(builtinDir, { recursive: true });
    writeFileSync(
      join(builtinDir, "SKILL.md"),
      `---\nname: notify\ndescription: "Built-in notify skill"\n---\n\n# Built-in\n`,
      "utf-8",
    );

    const profilesDir = join(workspaceDir, "agent-assets", "agent-profiles");
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, "routine.md"), "# Routine profile\n", "utf-8");
    writeFileSync(join(profilesDir, "conversational.md"), "# Conversational profile\n", "utf-8");
    writeFileSync(join(profilesDir, "task.md"), "# Task profile\n", "utf-8");

    app = createSkillsRoutes({ config: makeConfig() });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  describe("frontmatter helpers", () => {
    it("round-trips plain description and body", () => {
      const raw = serializeSkillFile("foo", "Simple description", "Body text");
      const parsed = parseSkillFile(raw);
      expect(parsed.description).toBe("Simple description");
      expect(parsed.body.trim()).toBe("Body text");
    });

    it("round-trips description with embedded double quotes", () => {
      const raw = serializeSkillFile("foo", 'Has "quotes" inside', "Body text");
      const parsed = parseSkillFile(raw);
      expect(parsed.description).toBe('Has "quotes" inside');
      expect(parsed.body.trim()).toBe("Body text");
    });

    it("round-trips description with backslash characters", () => {
      const raw = serializeSkillFile("foo", "Path is C:\\Users\\x", "Body");
      const parsed = parseSkillFile(raw);
      expect(parsed.description).toBe("Path is C:\\Users\\x");
    });

    it("tolerates files without frontmatter", () => {
      const parsed = parseSkillFile("Just a plain note\n");
      expect(parsed.description).toBe("");
      expect(parsed.body).toBe("Just a plain note\n");
    });

    it("handles single-quoted YAML descriptions from uploaded files", () => {
      const raw = `---\nname: foo\ndescription: 'It''s fine'\n---\n\n# Body\n`;
      const parsed = parseSkillFile(raw);
      expect(parsed.description).toBe("It's fine");
    });

    it("round-trips allowed-tools as a block sequence", () => {
      const raw = serializeSkillFile("foo", "desc", "body", [
        "Bash(curl *)",
        "Read",
      ]);
      expect(raw).toContain("allowed-tools:");
      expect(raw).toContain("- \"Bash(curl *)\"");
      const parsed = parseSkillFile(raw);
      expect(parsed.allowedTools).toEqual(["Bash(curl *)", "Read"]);
    });

    it("parses allowed-tools from built-in block sequence style", () => {
      // Matches the format used by agent-assets/skills/notify/SKILL.md
      const raw = `---\nname: notify\ndescription: "x"\nallowed-tools:\n  - Bash(curl *)\n  - Read\n---\n\nbody\n`;
      const parsed = parseSkillFile(raw);
      expect(parsed.allowedTools).toEqual(["Bash(curl *)", "Read"]);
    });

    it("parses allowed-tools from flow sequence style", () => {
      const raw = `---\nname: x\ndescription: "x"\nallowed-tools: [Bash(git *), Grep]\n---\n\nbody`;
      const parsed = parseSkillFile(raw);
      expect(parsed.allowedTools).toEqual(["Bash(git *)", "Grep"]);
    });

    it("returns empty allowed-tools when field is absent", () => {
      const parsed = parseSkillFile(`---\nname: foo\ndescription: "x"\n---\n\nbody`);
      expect(parsed.allowedTools).toEqual([]);
    });

    it("returns empty description when frontmatter lacks description key", () => {
      const raw = `---\nname: foo\n---\n\nbody text`;
      const parsed = parseSkillFile(raw);
      expect(parsed.description).toBe("");
      expect(parsed.body).toContain("body text");
    });

    it("serializeSkillFile: body already starting with newline does not double-prefix", () => {
      const raw = serializeSkillFile("foo", "desc", "\nalready starts with newline");
      // When body starts with \n it is used as-is (no extra \n prepended).
      // The result should be "---\n...\n---\nalready starts with newline"
      // (no extra blank line between frontmatter closer and body).
      expect(raw).not.toMatch(/---\n\n\n/);
      // The FRONTMATTER_RE's "\n?" after "---" consumes the leading newline,
      // so the parsed body does not include the leading newline character.
      expect(raw).toContain("---\nalready starts with newline");
    });
  });

  describe("createSkillsRoutes without workspaceDir", () => {
    it("uses process.cwd() when workspaceDir is omitted from config", async () => {
      // When workspaceDir is not in config, falls back to process.cwd().
      // The GET /skills endpoint should still work (just with no builtins from cwd).
      const noWsApp = createSkillsRoutes({
        config: { dataDir } as unknown as AgentConfig,
      });
      const res = await noWsApp.request("/skills");
      expect(res.status).toBe(200);
    });
  });

  describe("safeSkillPath (unit)", () => {
    it("resolves a normal slug to a SKILL.md path under root", () => {
      const path = safeSkillPath("/tmp/skills", "my-skill");
      expect(path).toBe("/tmp/skills/my-skill/SKILL.md");
    });

    it("returns null for empty slug", () => {
      const path = safeSkillPath("/tmp/skills", "");
      expect(path).toBeNull();
    });

    it("returns null for path traversal slug", () => {
      const path = safeSkillPath("/tmp/skills", "../escape");
      expect(path).toBeNull();
    });
  });

  describe("listSkillsInRoot (unit)", () => {
    it("returns empty array when directory does not exist", () => {
      const result = listSkillsInRoot("/nonexistent/path", false);
      expect(result).toEqual([]);
    });

    it("skips subdirectory that has no SKILL.md file", () => {
      // Create a subdir without SKILL.md
      const noSkillDir = join(dataDir, "context", "policies", "skills", "no-skill-md");
      mkdirSync(noSkillDir, { recursive: true });
      // Note: no SKILL.md is written, so listSkillsInRoot should skip it

      const result = listSkillsInRoot(join(dataDir, "context", "policies", "skills"), false);
      expect(result.map((s) => s.name)).not.toContain("no-skill-md");
    });

    it("skips non-directory entries at the skills root", () => {
      // Create a regular file (not a directory) inside the skills root.
      const skillsDir = join(dataDir, "context", "policies", "skills");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, "not-a-dir.txt"), "just a file", "utf-8");

      // listSkillsInRoot skips non-directory entries (covers the !entry.isDirectory() continue branch)
      const result = listSkillsInRoot(skillsDir, false);
      // Should be empty since no valid skill directories exist
      expect(result.map((s) => s.name)).not.toContain("not-a-dir.txt");
    });
  });

  describe("GET /skills", () => {
    it("lists built-in and user skills with correct flags", async () => {
      // Plant a user skill manually
      const userDir = join(dataDir, "context", "policies", "skills", "my-skill");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "SKILL.md"),
        `---\nname: my-skill\ndescription: "A user skill"\n---\n\n# Body\n`,
        "utf-8",
      );

      const res = await app.request("/skills");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        skills: Array<{ name: string; description: string; builtin: boolean }>;
      };

      const names = data.skills.map((s) => s.name).sort();
      expect(names).toEqual(["my-skill", "notify"]);

      const notify = data.skills.find((s) => s.name === "notify");
      const mine = data.skills.find((s) => s.name === "my-skill");
      expect(notify?.builtin).toBe(true);
      expect(mine?.builtin).toBe(false);
      expect(mine?.description).toBe("A user skill");
    });

    it("returns only built-ins when data dir has no user skills", async () => {
      const res = await app.request("/skills");
      const data = (await res.json()) as { skills: Array<{ name: string }> };
      expect(data.skills.map((s) => s.name)).toEqual(["notify"]);
    });
  });

  describe("backend bundle management", () => {
    it("lists built-in source skills via /skills/sources", async () => {
      const res = await app.request("/skills/sources");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { skills: Array<{ name: string; builtin: boolean }> };
      expect(data.skills).toHaveLength(1);
      expect(data.skills[0]).toMatchObject({ name: "notify", builtin: true });
    });

    it("returns empty skills list from /skills/sources when builtinSkillsRoot does not exist", async () => {
      // Use a workspaceDir with no agent-assets directory
      const emptyWsDir = join(tmpdir(), `pa-skills-empty-ws-${Date.now()}`);
      mkdirSync(emptyWsDir, { recursive: true });
      try {
        const noBuiltinApp = createSkillsRoutes({
          config: { dataDir, workspaceDir: emptyWsDir } as unknown as AgentConfig,
        });
        const res = await noBuiltinApp.request("/skills/sources");
        expect(res.status).toBe(200);
        const data = (await res.json()) as { skills: unknown[] };
        expect(data.skills).toEqual([]);
      } finally {
        rmSync(emptyWsDir, { recursive: true, force: true });
      }
    });

    it("/skills/sources skips builtin subdir without SKILL.md", async () => {
      // Add a directory inside agent-assets/skills that has NO SKILL.md
      const extraDir = join(workspaceDir, "agent-assets", "skills", "no-skill-file-here");
      mkdirSync(extraDir, { recursive: true });
      // listSkillDetailsInRoot should skip it (covers the !existsSync(skillFile) continue branch)
      const res = await app.request("/skills/sources");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { skills: Array<{ name: string }> };
      // Only the notify builtin should appear, not the empty dir
      expect(data.skills.map((s) => s.name)).not.toContain("no-skill-file-here");
      expect(data.skills.map((s) => s.name)).toContain("notify");
    });

    it("/skills/sources skips non-directory entries in builtins root", async () => {
      // Add a regular file (not a directory) inside agent-assets/skills
      const builtinsRoot = join(workspaceDir, "agent-assets", "skills");
      writeFileSync(join(builtinsRoot, "not-a-dir.txt"), "readme content", "utf-8");

      // listSkillDetailsInRoot skips non-directory entries (covers !entry.isDirectory() branch)
      const res = await app.request("/skills/sources");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { skills: Array<{ name: string }> };
      // Only the notify builtin should appear, not the file
      expect(data.skills.map((s) => s.name)).not.toContain("not-a-dir.txt");
      expect(data.skills.map((s) => s.name)).toContain("notify");
    });

    it("returns source files via /skills/source", async () => {
      const res = await app.request("/skills/source");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { files: Array<{ path: string }> };
      const paths = data.files.map((file) => file.path);
      expect(paths).toContain("agent-profiles/routine.md");
      expect(paths).toContain("skills/notify/SKILL.md");
    });

    it("returns process skill manifests", async () => {
      const res = await app.request("/skills/manifest/message.dm");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { profile: string; skills: string[] };
      expect(data.profile).toBe("conversational");
      expect(data.skills).toContain("context");
      expect(data.skills).toContain("today");
      expect(data.skills).toContain("external-services");
    });
  });

  describe("GET /skills/:name", () => {
    it("returns built-in skill content with builtin=true", async () => {
      const res = await app.request("/skills/notify");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        name: string;
        description: string;
        content: string;
        builtin: boolean;
      };
      expect(data.name).toBe("notify");
      expect(data.builtin).toBe(true);
      expect(data.description).toBe("Built-in notify skill");
      expect(data.content).toContain("# Built-in");
    });

    it("404s for unknown skill", async () => {
      const res = await app.request("/skills/does-not-exist");
      expect(res.status).toBe(404);
    });

    it("400s on path traversal attempts", async () => {
      const res = await app.request("/skills/..%2F..%2Fetc");
      expect(res.status).toBe(400);
    });

    it("prefers user skill over built-in on name collision (defense in depth)", async () => {
      // Normally the API rejects POST with a built-in slug. But if a user
      // skill ever coexisted on disk with a built-in of the same name, reads
      // should return the user copy (the one the user last modified).
      const userSkillDir = join(dataDir, "context", "policies", "skills", "notify");
      mkdirSync(userSkillDir, { recursive: true });
      writeFileSync(
        join(userSkillDir, "SKILL.md"),
        `---\nname: notify\ndescription: "User override"\n---\n\n# User version\n`,
      );

      const res = await app.request("/skills/notify");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { description: string; builtin: boolean };
      expect(data.builtin).toBe(false);
      expect(data.description).toBe("User override");
    });
  });

  describe("POST /skills", () => {
    it("creates a new user skill", async () => {
      const res = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "greet",
          description: "Say hello",
          content: "# Hello\n\nGreet the user.",
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; name: string };
      expect(data.status).toBe("created");

      // File should exist on disk
      const path = join(dataDir, "context", "policies", "skills", "greet", "SKILL.md");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("name: greet");
      expect(content).toContain("# Hello");
    });

    it("rejects built-in name collision", async () => {
      const res = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "notify",
          description: "Try to shadow builtin",
          content: "# Nope",
        }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("builtin_protected");
      // Built-in file should be untouched
      const builtinPath = join(workspaceDir, "agent-assets", "skills", "notify", "SKILL.md");
      expect(readFileSync(builtinPath, "utf-8")).toContain("Built-in notify skill");
    });

    it("rejects duplicate user skill creation", async () => {
      const body = {
        name: "dup",
        description: "Dup",
        content: "body",
      };
      const first = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(first.status).toBe(200);
      const second = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(second.status).toBe(409);
    });

    it("rejects invalid slug (uppercase)", async () => {
      const res = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "BadName",
          description: "desc",
          content: "body",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON body (not-ok readJsonBody)", async () => {
      const res = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });

    it("rejects description with newline", async () => {
      const res = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "multiline",
          description: "Line 1\nLine 2",
          content: "body",
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("validation_error");
    });

    it("rejects description longer than 500 chars", async () => {
      const longDesc = "x".repeat(501);
      const res = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "too-long",
          description: longDesc,
          content: "body",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("persists allowedTools through create + read", async () => {
      const res = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "restricted",
          description: "Limited tool access",
          content: "# body",
          allowedTools: ["Bash(curl *)", "Read"],
        }),
      });
      expect(res.status).toBe(200);
      const get = await app.request("/skills/restricted");
      const data = (await get.json()) as { allowedTools: string[] };
      expect(data.allowedTools).toEqual(["Bash(curl *)", "Read"]);
    });

    it("accepts description at exactly 500 chars", async () => {
      const maxDesc = "x".repeat(500);
      const res = await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "max-desc",
          description: maxDesc,
          content: "body",
        }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("PUT /skills/:name", () => {
    beforeEach(async () => {
      await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "editable",
          description: "Original",
          content: "# v1",
        }),
      });
    });

    it("updates description and content", async () => {
      const res = await app.request("/skills/editable", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "Updated",
          content: "# v2",
        }),
      });
      expect(res.status).toBe(200);
      const get = await app.request("/skills/editable");
      const data = (await get.json()) as { description: string; content: string };
      expect(data.description).toBe("Updated");
      expect(data.content).toContain("# v2");
    });

    it("supports partial update (description only)", async () => {
      const res = await app.request("/skills/editable", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "New desc" }),
      });
      expect(res.status).toBe(200);
      const get = await app.request("/skills/editable");
      const data = (await get.json()) as { description: string; content: string };
      expect(data.description).toBe("New desc");
      expect(data.content).toContain("# v1");
    });

    it("refuses to modify built-in skill", async () => {
      const res = await app.request("/skills/notify", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Hijacked" }),
      });
      expect(res.status).toBe(403);
      const builtinPath = join(workspaceDir, "agent-assets", "skills", "notify", "SKILL.md");
      expect(readFileSync(builtinPath, "utf-8")).toContain("Built-in notify skill");
    });

    it("404s for unknown user skill", async () => {
      const res = await app.request("/skills/nope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "x" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects empty update body", async () => {
      const res = await app.request("/skills/editable", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("validation_error");
    });

    it("rejects update with empty content string", async () => {
      const res = await app.request("/skills/editable", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("400s on invalid slug (uppercase)", async () => {
      const res = await app.request("/skills/BadSlug", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Updated" }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_name");
    });

    it("returns 400 for invalid JSON body (not-ok readJsonBody)", async () => {
      const res = await app.request("/skills/editable", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });

    it("updates only content preserving existing description from file", async () => {
      // This covers the `parsed.data.description ?? current.description` branch
      // where description is undefined and we fall back to the parsed file value.
      const res = await app.request("/skills/editable", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Updated content only" }),
      });
      expect(res.status).toBe(200);
      const get = await app.request("/skills/editable");
      const data = (await get.json()) as { description: string; content: string };
      // Description should remain "Original" from the beforeEach setup
      expect(data.description).toBe("Original");
      expect(data.content).toContain("# Updated content only");
    });
  });

  describe("DELETE /skills/:name", () => {
    it("deletes a user skill", async () => {
      await app.request("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "temp",
          description: "Temporary",
          content: "body",
        }),
      });
      const res = await app.request("/skills/temp", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(existsSync(join(dataDir, "context", "policies", "skills", "temp"))).toBe(false);
    });

    it("refuses to delete built-in skill", async () => {
      const res = await app.request("/skills/notify", { method: "DELETE" });
      expect(res.status).toBe(403);
      const builtinPath = join(workspaceDir, "agent-assets", "skills", "notify", "SKILL.md");
      expect(existsSync(builtinPath)).toBe(true);
    });

    it("404s for unknown user skill", async () => {
      const res = await app.request("/skills/ghost", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("400s on invalid slug (uppercase)", async () => {
      const res = await app.request("/skills/BadSlug", { method: "DELETE" });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_name");
    });
  });

  describe("POST /skills (builtin not found when root missing)", () => {
    it("allows creating a skill with same name as builtin when builtinSkillsRoot does not exist", async () => {
      // Create an app without the agent-assets directory so isBuiltinSlug
      // always returns false (builtinSkillsRoot not found).
      const emptyWsDir = join(tmpdir(), `pa-skills-no-builtin-${Date.now()}`);
      mkdirSync(emptyWsDir, { recursive: true });
      try {
        const noBuiltinApp = createSkillsRoutes({
          config: { dataDir, workspaceDir: emptyWsDir } as unknown as AgentConfig,
        });
        // "notify" would normally be blocked as a builtin, but without the
        // builtinSkillsRoot the isBuiltinSlug check returns false.
        const res = await noBuiltinApp.request("/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "notify",
            description: "User-created notify skill",
            content: "# Notify body",
          }),
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { status: string };
        expect(data.status).toBe("created");
      } finally {
        rmSync(emptyWsDir, { recursive: true, force: true });
      }
    });
  });

  describe("POST /skills/upload", () => {
    it("accepts a multipart .md upload", async () => {
      const form = new FormData();
      const file = new File(
        [
          `---\nname: uploaded\ndescription: "From upload"\n---\n\n# Uploaded body\n`,
        ],
        "uploaded.md",
        { type: "text/markdown" },
      );
      form.append("file", file);

      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; name: string };
      expect(data.status).toBe("created");
      expect(data.name).toBe("uploaded");
      expect(existsSync(join(dataDir, "context", "policies", "skills", "uploaded", "SKILL.md"))).toBe(true);
    });

    it("refuses to overwrite a built-in", async () => {
      const form = new FormData();
      const file = new File(
        [`---\nname: notify\ndescription: "x"\n---\n\n# Body\n`],
        "notify.md",
        { type: "text/markdown" },
      );
      form.append("file", file);

      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(403);
    });

    it("rejects upload missing the file field", async () => {
      const form = new FormData();
      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toMatch(/file/);
    });

    it("returns invalid_form when request body is not multipart form data", async () => {
      // Sending a JSON body to the upload endpoint causes formData() to throw,
      // which is caught and returns null → invalid_form response.
      const res = await app.request("/skills/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "not-a-file" }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_form");
    });

    it("uses slug as description fallback when uploaded file has no description", async () => {
      // When parsed description is empty (""), serializeSkillFile uses `description || slug`
      // which falls back to the slug name.
      const form = new FormData();
      const file = new File(
        // No description field in frontmatter
        [`---\nname: no-desc\n---\n\n# Body with content\n`],
        "no-desc.md",
        { type: "text/markdown" },
      );
      form.append("file", file);

      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(200);
      // Description should have been set to the slug ("no-desc") as fallback
      const get = await app.request("/skills/no-desc");
      const data = (await get.json()) as { description: string };
      expect(data.description).toBe("no-desc");
    });

    it("rejects upload larger than 256 KB", async () => {
      const form = new FormData();
      // 256 KB + 1 byte
      const big = `---\nname: big\ndescription: "x"\n---\n\n${"x".repeat(256 * 1024 + 1)}`;
      form.append("file", new File([big], "big.md", { type: "text/markdown" }));
      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(413);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("file_too_large");
    });

    it("rejects non-UTF-8 binary upload", async () => {
      const form = new FormData();
      // Invalid UTF-8: 0xff is never valid as a leading byte
      const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x41, 0x42]);
      form.append("file", new File([binary], "binary.md", { type: "application/octet-stream" }));
      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_encoding");
    });

    it("updates an existing user skill on repeated upload", async () => {
      const upload = async (body: string) => {
        const form = new FormData();
        form.append(
          "file",
          new File([body], "rev.md", { type: "text/markdown" }),
        );
        return app.request("/skills/upload", { method: "POST", body: form });
      };

      const first = await upload(
        `---\nname: rev\ndescription: "v1"\n---\n\n# v1 body\n`,
      );
      expect(first.status).toBe(200);
      expect(((await first.json()) as { status: string }).status).toBe("created");

      const second = await upload(
        `---\nname: rev\ndescription: "v2"\n---\n\n# v2 body\n`,
      );
      expect(second.status).toBe(200);
      expect(((await second.json()) as { status: string }).status).toBe("updated");

      const get = await app.request("/skills/rev");
      const data = (await get.json()) as { description: string; content: string };
      expect(data.description).toBe("v2");
      expect(data.content).toContain("# v2 body");
    });

    it("uses the name field override from FormData to set the skill slug", async () => {
      const form = new FormData();
      const file = new File(
        [`---\nname: will-be-overridden\ndescription: "Override test"\n---\n\n# Body\n`],
        "original-name.md",
        { type: "text/markdown" },
      );
      form.append("file", file);
      form.append("name", "my-override-slug");

      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; name: string };
      expect(data.name).toBe("my-override-slug");
      expect(existsSync(join(dataDir, "context", "policies", "skills", "my-override-slug", "SKILL.md"))).toBe(true);
    });

    it("rejects upload with empty body content after stripping frontmatter", async () => {
      const form = new FormData();
      // Frontmatter only, body is empty
      const file = new File(
        [`---\nname: empty-body\ndescription: "Empty"\n---\n`],
        "empty-body.md",
        { type: "text/markdown" },
      );
      form.append("file", file);

      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("empty_content");
    });

    it("rejects upload with bad slug derived from filename when no name override", async () => {
      const form = new FormData();
      // Filename has uppercase letters which map to an invalid slug even after lowercasing +
      // replacement — but actually replacement produces valid lowercase. Use a very long name
      // that exceeds the slug length limit instead.
      const longName = "x".repeat(100);
      const file = new File(
        [`---\nname: x\ndescription: "desc"\n---\n\n# Body\n`],
        // The fallback slug from filename: strip .md, lowercase, replace non-alphanum = "x...x" (100 chars)
        // skillNameSchema max is 64 chars, so this will be rejected
        `${longName}.md`,
        { type: "text/markdown" },
      );
      form.append("file", file);

      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_name");
    });

    it("rejects upload with invalid name override from FormData", async () => {
      const form = new FormData();
      const file = new File(
        [`---\nname: good\ndescription: "desc"\n---\n\n# Body\n`],
        "good.md",
        { type: "text/markdown" },
      );
      form.append("file", file);
      form.append("name", "INVALID_UPPERCASE");

      const res = await app.request("/skills/upload", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_name");
    });
  });
});

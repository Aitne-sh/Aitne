import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createObsidianRoutes } from "./obsidian.js";
import { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import type { ObsidianService } from "../../services/obsidian.js";

/**
 * Tests for the Obsidian API routes.
 *
 * The ObsidianService wraps the Obsidian CLI, which is a hard external
 * dependency. We mock the service interface directly — these tests verify
 * the HTTP routing layer, not the CLI wrapper.
 */
describe("Obsidian API routes", () => {
  // Temp dirs created during markAgentWrite / 404-pre-check tests. Tracked
  // so afterEach can rmSync them regardless of which test leaked.
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempVault(): string {
    const dir = mkdtempSync(join(tmpdir(), "obsidian-routes-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  function makeMockService(overrides: Partial<ObsidianService> = {}): ObsidianService {
    return {
      available: true,
      vault: "test-vault",
      isRunning: vi.fn().mockResolvedValue(true),
      readNote: vi.fn().mockResolvedValue("# Test Note\n\nContent here."),
      search: vi.fn(),
      createNote: vi.fn(),
      updateNote: vi.fn(),
      deleteNote: vi.fn(),
      appendToNote: vi.fn(),
      appendToDaily: vi.fn(),
      setProperty: vi.fn(),
      // Defaults to null so the DELETE 404 pre-check and the
      // markAgentWrite closure both no-op unless a specific test
      // overrides this. That preserves the intent of the existing
      // mock-only tests (no real vault, no filesystem interaction)
      // while letting new tests opt into a real temp path.
      resolveNotePath: vi.fn().mockReturnValue(null),
      ...overrides,
    } as unknown as ObsidianService;
  }

  describe("GET /obsidian/status", () => {
    // Management Mode redesign Phase 5: the status payload now advertises
    // `vaultType: "external"` and a human-readable `statusLabel` so dashboard
    // widgets and skill prompts can distinguish this route's target from the
    // agent's primary management vault without string-matching the vaultName.
    it("reports configured external vault when service is available", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/status");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        available: boolean;
        vaultName: string | null;
        obsidianRunning: boolean;
        vaultType: string;
        statusLabel: string;
      };
      expect(data).toEqual({
        available: true,
        vaultName: "test-vault",
        obsidianRunning: true,
        vaultType: "external",
        statusLabel: "external Obsidian vault: configured",
      });
    });

    it("reports not-configured external vault when service is null", async () => {
      const app = createObsidianRoutes({ obsidianService: null });

      const res = await app.request("/obsidian/status");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        available: boolean;
        vaultName: string | null;
        obsidianRunning: boolean;
        vaultType: string;
        statusLabel: string;
      };
      expect(data).toEqual({
        available: false,
        vaultName: null,
        obsidianRunning: false,
        vaultType: "external",
        statusLabel: "external Obsidian vault: not configured",
      });
    });

    it("reports not-configured when service exists but is unavailable", async () => {
      // `available: false` can occur when the vault path is set but the
      // Obsidian CLI isn't installed. The status endpoint treats that as
      // "not configured" rather than exposing a partial state.
      const service = makeMockService({ available: false });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/status");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        available: boolean;
        vaultType: string;
        statusLabel: string;
      };
      expect(data.available).toBe(false);
      expect(data.vaultType).toBe("external");
      expect(data.statusLabel).toBe("external Obsidian vault: not configured");
    });

    it("includes obsidianRunning: false when the CLI check fails", async () => {
      const service = makeMockService({
        isRunning: vi.fn().mockResolvedValue(false),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/status");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        available: boolean;
        obsidianRunning: boolean;
        statusLabel: string;
      };
      expect(data.available).toBe(true);
      expect(data.obsidianRunning).toBe(false);
      // "configured" refers to vault config, not process state — still configured.
      expect(data.statusLabel).toBe("external Obsidian vault: configured");
    });
  });

  describe("GET /obsidian/notes/:path", () => {
    it("returns note content for a valid path", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Daily/2026-04-06");
      expect(res.status).toBe(200);

      const data = (await res.json()) as { content: string; path: string };
      expect(data.path).toBe("Daily/2026-04-06");
      expect(data.content).toContain("Test Note");
      expect(service.readNote).toHaveBeenCalledWith("Daily/2026-04-06");
    });

    it("handles URL-encoded spaces", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Meeting%20Notes/2026-04-06");
      expect(res.status).toBe(200);
      expect(service.readNote).toHaveBeenCalledWith("Meeting Notes/2026-04-06");
    });

    it("returns 503 when Obsidian is not configured", async () => {
      const app = createObsidianRoutes({ obsidianService: null });

      const res = await app.request("/obsidian/notes/Anything");
      expect(res.status).toBe(503);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("obsidian_not_configured");
    });

    it("returns 503 when Obsidian is not running", async () => {
      const service = makeMockService({
        isRunning: vi.fn().mockResolvedValue(false),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Anything");
      expect(res.status).toBe(503);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("obsidian_not_running");
    });

    it("returns 404 when note cannot be read", async () => {
      const service = makeMockService({
        readNote: vi.fn().mockRejectedValue(new Error("file not found")),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Missing");
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("not_found");
      expect(data.message).toBe("file not found");
    });

    it("rejects path traversal attempts", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/..%2Fetc%2Fpasswd");
      expect(res.status).toBe(400);
      expect(service.readNote).not.toHaveBeenCalled();
    });

    it("rejects absolute paths", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      // /obsidian/notes// → filePath becomes "/etc/passwd" after replace
      const res = await app.request("/obsidian/notes//etc/passwd");
      expect(res.status).toBe(400);
      expect(service.readNote).not.toHaveBeenCalled();
    });

    it("rejects invalid characters", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      // `$` and `;` are not in the allowed charset
      const res = await app.request("/obsidian/notes/bad%24name");
      expect(res.status).toBe(400);
      expect(service.readNote).not.toHaveBeenCalled();
    });
  });

  describe("PUT /obsidian/notes/:path", () => {
    it("overwrites a note with the provided content", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Projects/ProjectA", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# ProjectA\n\nNew body" }),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { status: string; path: string };
      expect(data.status).toBe("updated");
      expect(data.path).toBe("Projects/ProjectA");
      expect(service.updateNote).toHaveBeenCalledWith(
        "Projects/ProjectA",
        "# ProjectA\n\nNew body",
      );
    });

    it("accepts an empty string as valid content", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Scratch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      expect(res.status).toBe(200);
      expect(service.updateNote).toHaveBeenCalledWith("Scratch", "");
    });

    it("returns 400 when content is missing", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Scratch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(service.updateNote).not.toHaveBeenCalled();
    });

    it("reports `typeof content` when PUT body content is a non-string (number)", async () => {
      // Exercises the false branch of `content === undefined ? "<missing>" : typeof content`.
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });
      const res = await app.request("/obsidian/notes/Scratch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: 42 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { errors: Array<{ received: string }> };
      expect(body.errors[0].received).toBe("number");
    });

    it("rejects path traversal attempts", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/..%2Fetc%2Fpasswd", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "pwned" }),
      });
      expect(res.status).toBe(400);
      expect(service.updateNote).not.toHaveBeenCalled();
    });

    it("returns 503 when Obsidian is not running", async () => {
      const service = makeMockService({
        isRunning: vi.fn().mockResolvedValue(false),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Scratch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
      expect(res.status).toBe(503);
      expect(service.updateNote).not.toHaveBeenCalled();
    });

    it("returns 503 when Obsidian is not configured", async () => {
      const app = createObsidianRoutes({ obsidianService: null });

      const res = await app.request("/obsidian/notes/Scratch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
      expect(res.status).toBe(503);
    });

    it("returns 502 when the CLI fails", async () => {
      const service = makeMockService({
        updateNote: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Scratch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("obsidian_error");
      expect(data.message).toBe("boom");
    });
  });

  describe("DELETE /obsidian/notes/:path", () => {
    it("moves a note to trash by default", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Projects/Old", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as {
        status: string;
        path: string;
        permanent: boolean;
      };
      expect(data.status).toBe("deleted");
      expect(data.path).toBe("Projects/Old");
      expect(data.permanent).toBe(false);
      expect(service.deleteNote).toHaveBeenCalledWith("Projects/Old", false);
    });

    it("deletes permanently when ?permanent=true", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request(
        "/obsidian/notes/Projects/Old?permanent=true",
        { method: "DELETE" },
      );
      expect(res.status).toBe(200);
      expect(service.deleteNote).toHaveBeenCalledWith("Projects/Old", true);
    });

    it("ignores non-literal permanent values", async () => {
      // Query strings like ?permanent=1 or ?permanent=yes must NOT be treated
      // as permanent. Only the literal string "true" opts in, otherwise the
      // caller gets recoverable (trash) deletion — the safer default.
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Projects/Old?permanent=1", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(service.deleteNote).toHaveBeenCalledWith("Projects/Old", false);
    });

    it("returns 503 when Obsidian is not configured on delete", async () => {
      const app = createObsidianRoutes({ obsidianService: null });
      const res = await app.request("/obsidian/notes/Projects/Old", { method: "DELETE" });
      expect(res.status).toBe(503);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("obsidian_not_configured");
    });

    it("rejects path traversal attempts", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/..%2Fetc%2Fpasswd", {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      expect(service.deleteNote).not.toHaveBeenCalled();
    });

    it("returns 503 when Obsidian is not running", async () => {
      const service = makeMockService({
        isRunning: vi.fn().mockResolvedValue(false),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Projects/Old", {
        method: "DELETE",
      });
      expect(res.status).toBe(503);
      expect(service.deleteNote).not.toHaveBeenCalled();
    });

    it("returns 502 when the CLI fails", async () => {
      const service = makeMockService({
        deleteNote: vi.fn().mockRejectedValue(new Error("permission denied")),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Projects/Old", {
        method: "DELETE",
      });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("obsidian_error");
      expect(data.message).toBe("permission denied");
    });

    it("returns 404 when the resolved vault path does not exist", async () => {
      // 404 pre-check: if the resolved absolute path is missing on disk,
      // the route must short-circuit to 404 (idempotent DELETE semantics)
      // without invoking the CLI.
      const vault = makeTempVault();
      const missing = join(vault, "Projects", "Gone.md");
      const service = makeMockService({
        resolveNotePath: vi.fn().mockReturnValue(missing),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Projects/Gone", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string; path: string };
      expect(data.error).toBe("not_found");
      expect(data.path).toBe("Projects/Gone");
      expect(service.deleteNote).not.toHaveBeenCalled();
    });

    it("deletes an existing note when the resolved path is present on disk", async () => {
      // Counterpart to the 404 test: the pre-check must NOT block a
      // legitimate delete when the file is actually there. We use a
      // real temp file so existsSync returns true.
      const vault = makeTempVault();
      const target = join(vault, "Present.md");
      writeFileSync(target, "# Present\n", "utf-8");

      const service = makeMockService({
        resolveNotePath: vi.fn().mockReturnValue(target),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Present", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(service.deleteNote).toHaveBeenCalledWith("Present", false);
    });
  });

  describe("AgentWriteTracker integration", () => {
    // These tests guarantee that every write endpoint pre-marks the
    // resolved absolute path on the shared tracker — the attribution
    // invariant that keeps the obsidian-watcher from looping the agent's
    // own writes back into the hourly_check queue.

    it("PUT marks the resolved absolute path on the write tracker", async () => {
      const vault = makeTempVault();
      const absolute = join(vault, "Projects", "ProjectA.md");
      const service = makeMockService({
        resolveNotePath: vi.fn().mockReturnValue(absolute),
      });
      const tracker = new AgentWriteTracker();
      const markSpy = vi.spyOn(tracker, "markWriting");

      const app = createObsidianRoutes({
        obsidianService: service,
        writeTracker: tracker,
      });

      const res = await app.request("/obsidian/notes/Projects/ProjectA", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# ProjectA\n" }),
      });
      expect(res.status).toBe(200);
      expect(service.resolveNotePath).toHaveBeenCalledWith("Projects/ProjectA");
      expect(markSpy).toHaveBeenCalledWith(absolute);
      expect(service.updateNote).toHaveBeenCalledWith(
        "Projects/ProjectA",
        "# ProjectA\n",
      );
    });

    it("DELETE marks the resolved absolute path on the write tracker", async () => {
      const vault = makeTempVault();
      const absolute = join(vault, "Projects", "Old.md");
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, "# Old\n", "utf-8");

      const service = makeMockService({
        resolveNotePath: vi.fn().mockReturnValue(absolute),
      });
      const tracker = new AgentWriteTracker();
      const markSpy = vi.spyOn(tracker, "markWriting");

      const app = createObsidianRoutes({
        obsidianService: service,
        writeTracker: tracker,
      });

      const res = await app.request("/obsidian/notes/Projects/Old", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(markSpy).toHaveBeenCalledWith(absolute);
      expect(service.deleteNote).toHaveBeenCalledWith("Projects/Old", false);
    });

    it("DELETE 404 short-circuit does NOT mark the tracker", async () => {
      // Regression guard: if the pre-check returns 404, the write
      // tracker must stay clean — otherwise a subsequent user edit to
      // a coincidentally-recreated path would be wrongly attributed
      // to the agent within the TTL window.
      const vault = makeTempVault();
      const missing = join(vault, "Projects", "Gone.md");
      const service = makeMockService({
        resolveNotePath: vi.fn().mockReturnValue(missing),
      });
      const tracker = new AgentWriteTracker();
      const markSpy = vi.spyOn(tracker, "markWriting");

      const app = createObsidianRoutes({
        obsidianService: service,
        writeTracker: tracker,
      });

      const res = await app.request("/obsidian/notes/Projects/Gone", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      expect(markSpy).not.toHaveBeenCalled();
      expect(service.deleteNote).not.toHaveBeenCalled();
    });

    it("POST marks the write tracker before creating", async () => {
      // Pre-existing behavior — previously untested. Lock it down so
      // future refactors can't regress the attribution invariant for
      // the create path.
      const vault = makeTempVault();
      const absolute = join(vault, "New.md");
      const service = makeMockService({
        resolveNotePath: vi.fn().mockReturnValue(absolute),
      });
      const tracker = new AgentWriteTracker();
      const markSpy = vi.spyOn(tracker, "markWriting");

      const app = createObsidianRoutes({
        obsidianService: service,
        writeTracker: tracker,
      });

      const res = await app.request("/obsidian/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New", content: "# New\n" }),
      });
      expect(res.status).toBe(200);
      expect(markSpy).toHaveBeenCalledWith(absolute);
      expect(service.createNote).toHaveBeenCalledWith("New", "# New\n");
    });
  });

  describe("Write mutex", () => {
    // Serialization test: two concurrent writes against the same route
    // must not race inside the handler. We gate the mocked service call
    // on a manually-resolved promise so we can observe ordering.

    it("serializes concurrent PUTs — second call waits for the first", async () => {
      let activeCount = 0;
      let maxConcurrent = 0;
      const releases: Array<() => void> = [];

      const service = makeMockService({
        updateNote: vi.fn().mockImplementation(async () => {
          activeCount += 1;
          maxConcurrent = Math.max(maxConcurrent, activeCount);
          await new Promise<void>((resolve) => releases.push(resolve));
          activeCount -= 1;
        }),
      });

      const app = createObsidianRoutes({ obsidianService: service });

      const p1 = app.request("/obsidian/notes/A", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "1" }),
      });
      const p2 = app.request("/obsidian/notes/B", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "2" }),
      });

      // Yield so the first handler can enter updateNote.
      await new Promise((r) => setTimeout(r, 10));
      expect(releases.length).toBe(1); // only one handler should be inside updateNote

      releases[0]();
      // Yield again so the second handler can progress.
      await new Promise((r) => setTimeout(r, 10));
      expect(releases.length).toBe(2);
      releases[1]();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(maxConcurrent).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // isValidNotePath — additional branch coverage
  // ──────────────────────────────────────────────────────────────────
  describe("isValidNotePath edge cases", () => {
    it("GET returns 400 for an empty path segment (URL ends with trailing slash)", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });
      // The regex strips prefix; /obsidian/notes/ yields empty string
      const res = await app.request("/obsidian/notes/");
      expect(res.status).toBe(400);
      expect(service.readNote).not.toHaveBeenCalled();
    });

    it("GET returns 400 for a path exceeding 500 characters", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });
      const longPath = "a".repeat(501);
      const res = await app.request(`/obsidian/notes/${longPath}`);
      expect(res.status).toBe(400);
      expect(service.readNote).not.toHaveBeenCalled();
    });

    it("GET returns 400 for a path starting with a backslash", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });
      // URL-encoded backslash at the start of the path segment
      const res = await app.request("/obsidian/notes/%5Cetc%5Cpasswd");
      expect(res.status).toBe(400);
      expect(service.readNote).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /obsidian/search
  // ──────────────────────────────────────────────────────────────────
  describe("GET /obsidian/search", () => {
    it("returns search results when q is provided", async () => {
      const service = makeMockService({
        search: vi.fn().mockResolvedValue([
          { path: "Daily/2026-04-06", excerpt: "meeting notes" },
        ]),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/search?q=meeting");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { results: unknown[] };
      expect(data.results).toHaveLength(1);
      expect(service.search).toHaveBeenCalledWith("meeting", 10);
    });

    it("returns 400 when q is missing", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/search");
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("q");
    });

    it("returns 503 when Obsidian is not running on search", async () => {
      const service = makeMockService({
        isRunning: vi.fn().mockResolvedValue(false),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/search?q=test");
      expect(res.status).toBe(503);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("obsidian_not_running");
    });

    it("returns 503 when Obsidian is not configured on search", async () => {
      const app = createObsidianRoutes({ obsidianService: null });
      const res = await app.request("/obsidian/search?q=test");
      expect(res.status).toBe(503);
    });

    it("returns 502 when search throws", async () => {
      const service = makeMockService({
        search: vi.fn().mockRejectedValue(new Error("CLI error")),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/search?q=test");
      expect(res.status).toBe(502);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("obsidian_error");
    });

    it("caps limit at 50 regardless of request parameter", async () => {
      const service = makeMockService({
        search: vi.fn().mockResolvedValue([]),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      await app.request("/obsidian/search?q=test&limit=100");
      expect(service.search).toHaveBeenCalledWith("test", 50);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /obsidian/notes — additional paths
  // ──────────────────────────────────────────────────────────────────
  describe("POST /obsidian/notes — additional paths", () => {
    it("returns 503 when Obsidian is not configured", async () => {
      const app = createObsidianRoutes({ obsidianService: null });
      const res = await app.request("/obsidian/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "NewNote", content: "# New" }),
      });
      expect(res.status).toBe(503);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("obsidian_not_configured");
    });

    it("returns 400 for invalid JSON body", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when only name is missing", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# content only" }),
      });
      expect(res.status).toBe(400);
      expect(service.createNote).not.toHaveBeenCalled();
    });

    it("returns 400 when only content is missing", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "MyNote" }),
      });
      expect(res.status).toBe(400);
      expect(service.createNote).not.toHaveBeenCalled();
    });

    it("returns 400 when name contains an invalid path", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "../evil", content: "# Pwned" }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid note name");
      expect(service.createNote).not.toHaveBeenCalled();
    });

    it("returns 503 when Obsidian is not running on create", async () => {
      const service = makeMockService({
        isRunning: vi.fn().mockResolvedValue(false),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "NewNote", content: "# New" }),
      });
      expect(res.status).toBe(503);
      expect(service.createNote).not.toHaveBeenCalled();
    });

    it("returns 502 when createNote throws", async () => {
      const service = makeMockService({
        createNote: vi.fn().mockRejectedValue(new Error("already exists")),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "NewNote", content: "# New" }),
      });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("obsidian_error");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PUT /obsidian/notes/* — additional paths
  // ──────────────────────────────────────────────────────────────────
  describe("PUT /obsidian/notes/* — additional paths", () => {
    it("returns 400 for invalid JSON body", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes/Scratch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PATCH /obsidian/notes — append to note
  // ──────────────────────────────────────────────────────────────────
  describe("PATCH /obsidian/notes", () => {
    it("appends content to an existing note", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "Daily/2026-04-06", content: "\n- new item" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe("appended");
      expect(service.appendToNote).toHaveBeenCalledWith("Daily/2026-04-06", "\n- new item");
    });

    it("returns 503 when Obsidian is not configured", async () => {
      const app = createObsidianRoutes({ obsidianService: null });
      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "note", content: "x" }),
      });
      expect(res.status).toBe(503);
    });

    it("returns 400 for invalid JSON body", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when file is missing", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "append text" }),
      });
      expect(res.status).toBe(400);
      expect(service.appendToNote).not.toHaveBeenCalled();
    });

    it("returns 400 when content is missing", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "note" }),
      });
      expect(res.status).toBe(400);
      expect(service.appendToNote).not.toHaveBeenCalled();
    });

    it("returns 400 when file path is invalid", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "../etc/passwd", content: "x" }),
      });
      expect(res.status).toBe(400);
      expect(service.appendToNote).not.toHaveBeenCalled();
    });

    it("returns 503 when Obsidian is not running on append", async () => {
      const service = makeMockService({
        isRunning: vi.fn().mockResolvedValue(false),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "note", content: "x" }),
      });
      expect(res.status).toBe(503);
      expect(service.appendToNote).not.toHaveBeenCalled();
    });

    it("returns 502 when appendToNote throws", async () => {
      const service = makeMockService({
        appendToNote: vi.fn().mockRejectedValue(new Error("file locked")),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "note", content: "x" }),
      });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("obsidian_error");
    });

    it("marks agent write with resolved path when tracker is provided", async () => {
      const vault = makeTempVault();
      const absolute = join(vault, "note.md");
      const service = makeMockService({
        resolveNotePath: vi.fn().mockReturnValue(absolute),
        appendToNote: vi.fn().mockResolvedValue(undefined),
      });
      const tracker = new AgentWriteTracker();
      const markSpy = vi.spyOn(tracker, "markWriting");
      const app = createObsidianRoutes({ obsidianService: service, writeTracker: tracker });

      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "note", content: "x" }),
      });
      expect(res.status).toBe(200);
      expect(markSpy).toHaveBeenCalledWith(absolute);
    });

    it("skips markWriting when resolveNotePath returns null", async () => {
      // resolveNotePath returns null (default mock) — markAgentWrite must NOT
      // call tracker.markWriting in this case.
      const service = makeMockService({
        appendToNote: vi.fn().mockResolvedValue(undefined),
      });
      const tracker = new AgentWriteTracker();
      const markSpy = vi.spyOn(tracker, "markWriting");
      const app = createObsidianRoutes({ obsidianService: service, writeTracker: tracker });

      const res = await app.request("/obsidian/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "note", content: "x" }),
      });
      expect(res.status).toBe(200);
      expect(markSpy).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PATCH /obsidian/daily — append to daily note
  // ──────────────────────────────────────────────────────────────────
  describe("PATCH /obsidian/daily", () => {
    it("appends content to the daily note", async () => {
      const service = makeMockService({
        appendToDaily: vi.fn().mockResolvedValue(undefined),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/daily", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "- daily entry" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe("appended");
      expect(service.appendToDaily).toHaveBeenCalledWith("- daily entry");
    });

    it("returns 503 when Obsidian is not configured", async () => {
      const app = createObsidianRoutes({ obsidianService: null });
      const res = await app.request("/obsidian/daily", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
      expect(res.status).toBe(503);
    });

    it("returns 400 for invalid JSON body", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/daily", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when content is missing", async () => {
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/daily", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("content is required");
    });

    it("reports `<empty>` when daily PATCH content is the empty string", async () => {
      // Exercises the false branch of `content === undefined ? "<missing>" : "<empty>"`
      // where the truthiness check (`!content`) catches "" but undefined goes
      // through the same gate.
      const service = makeMockService();
      const app = createObsidianRoutes({ obsidianService: service });
      const res = await app.request("/obsidian/daily", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { errors: Array<{ received: string }> };
      expect(body.errors[0].received).toBe("<empty>");
    });

    it("returns 503 when Obsidian is not running on daily append", async () => {
      const service = makeMockService({
        isRunning: vi.fn().mockResolvedValue(false),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/daily", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
      expect(res.status).toBe(503);
      expect(service.appendToDaily).not.toHaveBeenCalled();
    });

    it("returns 502 when appendToDaily throws", async () => {
      const service = makeMockService({
        appendToDaily: vi.fn().mockRejectedValue(new Error("vault locked")),
      });
      const app = createObsidianRoutes({ obsidianService: service });

      const res = await app.request("/obsidian/daily", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("obsidian_error");
    });

    it("marks agent write for today's date on daily append", async () => {
      const vault = makeTempVault();
      const today = new Date().toISOString().slice(0, 10);
      const absolute = join(vault, `${today}.md`);
      const service = makeMockService({
        resolveNotePath: vi.fn().mockReturnValue(absolute),
        appendToDaily: vi.fn().mockResolvedValue(undefined),
      });
      const tracker = new AgentWriteTracker();
      const markSpy = vi.spyOn(tracker, "markWriting");
      const app = createObsidianRoutes({ obsidianService: service, writeTracker: tracker });

      const res = await app.request("/obsidian/daily", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "- entry" }),
      });
      expect(res.status).toBe(200);
      // markAgentWrite is called with today's date string; resolveNotePath translates it
      expect(service.resolveNotePath).toHaveBeenCalledWith(today);
      expect(markSpy).toHaveBeenCalledWith(absolute);
    });
  });
});

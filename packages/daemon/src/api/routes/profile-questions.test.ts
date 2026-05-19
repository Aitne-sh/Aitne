/**
 * Tests for the profile-questions HTTP route.
 *
 * The route ships its own `safePath` (separate from `context.ts:safePath`)
 * because it is read-only and intentionally lighter-weight. These tests
 * pin the current behavior — both the path-traversal rejection set and
 * the wiring to `isSlotFilled` — so a future refactor cannot silently
 * widen what the read endpoint accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileQuestionsRoutes } from "./profile-questions.js";
import type { ApiDependencies } from "../server.js";

function makeDeps(dataDir: string): ApiDependencies {
  return {
    config: {
      dataDir,
      vaultMode: "plain",
      primaryVaultPath: null,
    },
  } as unknown as ApiDependencies;
}

describe("Profile-questions API route", () => {
  let dataDir: string;
  let contextDir: string;
  let app: ReturnType<typeof createProfileQuestionsRoutes>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-profile-questions-"));
    contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "user"), { recursive: true });
    app = createProfileQuestionsRoutes(makeDeps(dataDir));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("GET /profile-questions/slot-filled", () => {
    it("returns 400 missing_path when path query is omitted", async () => {
      const res = await app.request("/profile-questions/slot-filled");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("missing_path");
    });

    it("returns 400 missing_path when path is whitespace-only", async () => {
      const res = await app.request("/profile-questions/slot-filled?path=%20%20");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("missing_path");
    });

    it("returns fileExists:false when the target file does not exist", async () => {
      const res = await app.request(
        "/profile-questions/slot-filled?path=user/profile",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        filled: boolean;
        sectionPresent: boolean;
        fileExists: boolean;
        path: string;
        section: string | null;
        anchor: string | null;
      };
      expect(body).toEqual({
        filled: false,
        sectionPresent: false,
        fileExists: false,
        path: "user/profile",
        section: null,
        anchor: null,
      });
    });

    it("appends the .md extension automatically when omitted", async () => {
      writeFileSync(
        join(contextDir, "user", "profile.md"),
        "## Identity\n- Name: Alice\n",
        "utf-8",
      );
      const withMd = await app.request(
        "/profile-questions/slot-filled?path=user/profile.md&section=Identity&anchor=Name",
      );
      const sansMd = await app.request(
        "/profile-questions/slot-filled?path=user/profile&section=Identity&anchor=Name",
      );
      expect(withMd.status).toBe(200);
      expect(sansMd.status).toBe(200);
      const a = (await withMd.json()) as { filled: boolean };
      const b = (await sansMd.json()) as { filled: boolean };
      expect(a.filled).toBe(true);
      expect(b.filled).toBe(true);
    });

    it("forwards isSlotFilled output for a populated section/anchor", async () => {
      writeFileSync(
        join(contextDir, "user", "profile.md"),
        "## Identity\n- Name: Alice\n- Role: dev\n",
        "utf-8",
      );
      const res = await app.request(
        "/profile-questions/slot-filled?path=user/profile&section=Identity&anchor=Name",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        filled: boolean;
        sectionPresent: boolean;
        fileExists: boolean;
        section: string | null;
        anchor: string | null;
      };
      expect(body.filled).toBe(true);
      expect(body.sectionPresent).toBe(true);
      expect(body.fileExists).toBe(true);
      expect(body.section).toBe("Identity");
      expect(body.anchor).toBe("Name");
    });

    it("reports filled:false sectionPresent:true when the section exists with a placeholder", async () => {
      writeFileSync(
        join(contextDir, "user", "profile.md"),
        "## Identity\n- (none)\n",
        "utf-8",
      );
      const res = await app.request(
        "/profile-questions/slot-filled?path=user/profile&section=Identity",
      );
      const body = (await res.json()) as {
        filled: boolean;
        sectionPresent: boolean;
      };
      expect(body.filled).toBe(false);
      expect(body.sectionPresent).toBe(true);
    });

    it("treats an omitted section as a whole-file probe", async () => {
      writeFileSync(
        join(contextDir, "user", "profile.md"),
        "- Name: Alice\n",
        "utf-8",
      );
      const res = await app.request(
        "/profile-questions/slot-filled?path=user/profile",
      );
      const body = (await res.json()) as {
        filled: boolean;
        sectionPresent: boolean;
        section: string | null;
      };
      expect(body.filled).toBe(true);
      expect(body.sectionPresent).toBe(true);
      expect(body.section).toBeNull();
    });
  });

  describe("safePath rejection set", () => {
    it("rejects paths containing a `..` segment with 400 invalid_path", async () => {
      const res = await app.request(
        "/profile-questions/slot-filled?path=../etc/passwd",
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_path");
    });

    it("rejects mid-path `..` segments", async () => {
      const res = await app.request(
        "/profile-questions/slot-filled?path=user/../../etc/passwd",
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_path");
    });

    it("rejects Windows-style `..` segments", async () => {
      const res = await app.request(
        `/profile-questions/slot-filled?path=${encodeURIComponent("user\\..\\..\\etc\\passwd")}`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_path");
    });

    it("rejects absolute paths", async () => {
      const res = await app.request(
        `/profile-questions/slot-filled?path=${encodeURIComponent("/etc/passwd")}`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_path");
    });

    it("rejects paths containing a NUL byte", async () => {
      const res = await app.request(
        `/profile-questions/slot-filled?path=${encodeURIComponent("user/profile\0.md")}`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_path");
    });

    it("rejects `.base` files (Obsidian view configs are not prose)", async () => {
      // Even when the file exists, the route refuses to read .base at the
      // safePath layer — its job is prose probing, not config inspection.
      writeFileSync(
        join(contextDir, "user", "view.base"),
        "filters:\n  and: []\n",
        "utf-8",
      );
      const res = await app.request(
        "/profile-questions/slot-filled?path=user/view.base",
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_path");
    });

    it("does NOT reject a file whose name merely contains '..' as part of a segment", async () => {
      // The traversal check splits on `/` and matches `seg === ".."`
      // exactly — a filename like `notes..md` is its own segment and
      // legal.
      writeFileSync(
        join(contextDir, "user", "notes..md"),
        "## Identity\n- Name: Alice\n",
        "utf-8",
      );
      const res = await app.request(
        "/profile-questions/slot-filled?path=user/notes..md&section=Identity&anchor=Name",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { filled: boolean };
      expect(body.filled).toBe(true);
    });
  });

  describe("read failure", () => {
    it("returns 500 read_failed when the readFileSync call throws", async () => {
      // Direct the route at a directory entry that exists but cannot be
      // read as a regular file. We create `target/` as a directory inside
      // contextDir so existsSync passes but readFileSync throws EISDIR.
      mkdirSync(join(contextDir, "user", "directory.md"));

      const res = await app.request(
        "/profile-questions/slot-filled?path=user/directory",
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("read_failed");
    });
  });

  describe("contextDir resolution honors vaultMode='obsidian'", () => {
    it("reads from primaryVaultPath when vaultMode='obsidian' and the path is set", async () => {
      const altRoot = mkdtempSync(join(tmpdir(), "pa-profile-vault-"));
      try {
        const altContextDir = join(altRoot);
        mkdirSync(join(altContextDir, "user"), { recursive: true });
        writeFileSync(
          join(altContextDir, "user", "profile.md"),
          "## Identity\n- Name: Bob\n",
          "utf-8",
        );

        const altApp = createProfileQuestionsRoutes({
          config: {
            dataDir,
            vaultMode: "obsidian",
            primaryVaultPath: altContextDir,
          },
        } as unknown as ApiDependencies);

        const res = await altApp.request(
          "/profile-questions/slot-filled?path=user/profile&section=Identity&anchor=Name",
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { filled: boolean; fileExists: boolean };
        expect(body.fileExists).toBe(true);
        expect(body.filled).toBe(true);
      } finally {
        rmSync(altRoot, { recursive: true, force: true });
      }
    });
  });
});

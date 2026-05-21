import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  digestPaths,
  readPreMorningDigestJsonForDate,
  runPreMorningDigestJob,
  safeRunPreMorningDigestJob,
} from "./pre-morning-digest-job.js";
import type { DigestBoundary } from "../../services/browser-history/pipeline/pre-morning-digest.js";

const TOKYO: DigestBoundary = { timezone: "Asia/Tokyo", dayBoundaryHour: 4 };
const TARGET_DATE = "2026-05-19";
/** 03:00 JST on May 20 — inside the agent-day that opened at 04:00 JST May 19. */
const NOW_MS = Date.UTC(2026, 4, 19, 18, 0, 0);

describe("pre-morning-digest-job", () => {
  let db: Database.Database;
  let contextDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    contextDir = mkdtempSync(join(tmpdir(), "pre-morning-digest-test-"));
  });

  afterEach(() => {
    db.close();
    rmSync(contextDir, { recursive: true, force: true });
  });

  describe("digestPaths", () => {
    it("derives markdown / JSON / context-relative paths from contextDir + date", () => {
      const paths = digestPaths(contextDir, TARGET_DATE);
      expect(paths.markdownPath).toBe(
        join(contextDir, "browser/yesterday-2026-05-19.md"),
      );
      expect(paths.jsonPath).toBe(
        join(contextDir, "browser/yesterday-2026-05-19.json"),
      );
      expect(paths.contextRelative).toBe("browser/yesterday-2026-05-19.md");
    });
  });

  describe("runPreMorningDigestJob", () => {
    it("writes both markdown + JSON sidecar for the agent-day of nowMs", () => {
      const result = runPreMorningDigestJob({
        db,
        contextDir,
        boundary: TOKYO,
        nowMs: NOW_MS,
      });
      expect(result.date).toBe(TARGET_DATE);
      expect(existsSync(result.paths.markdownPath)).toBe(true);
      expect(existsSync(result.paths.jsonPath)).toBe(true);
      const md = readFileSync(result.paths.markdownPath, "utf-8");
      expect(md).toContain(`date: ${TARGET_DATE}`);
      const sidecar = JSON.parse(
        readFileSync(result.paths.jsonPath, "utf-8"),
      );
      expect(sidecar.date).toBe(TARGET_DATE);
      expect(sidecar.source).toBe("deterministic");
    });

    it("falls back to Date.now() when nowMs is omitted", () => {
      const result = runPreMorningDigestJob({
        db,
        contextDir,
        boundary: TOKYO,
      });
      // No fixture rows + no nowMs → digest still produces a valid
      // empty payload, dated by whatever agent-day the runner is in.
      expect(result.digest.source).toBe("deterministic");
      expect(result.digest.clusters).toEqual([]);
      expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("is idempotent across re-runs", () => {
      const a = runPreMorningDigestJob({
        db,
        contextDir,
        boundary: TOKYO,
        nowMs: NOW_MS,
      });
      const b = runPreMorningDigestJob({
        db,
        contextDir,
        boundary: TOKYO,
        nowMs: NOW_MS,
      });
      // generatedAt is `new Date(nowMs).toISOString()` — identical given
      // the same nowMs.
      expect(JSON.stringify(a.digest)).toBe(JSON.stringify(b.digest));
    });
  });

  describe("readPreMorningDigestJsonForDate", () => {
    it("returns null when the sidecar is missing", () => {
      expect(readPreMorningDigestJsonForDate(contextDir, TARGET_DATE)).toBeNull();
    });

    it("returns the typed digest when the sidecar is present and valid", () => {
      const result = runPreMorningDigestJob({
        db,
        contextDir,
        boundary: TOKYO,
        nowMs: NOW_MS,
      });
      const read = readPreMorningDigestJsonForDate(contextDir, TARGET_DATE);
      expect(read).not.toBeNull();
      expect(read?.date).toBe(TARGET_DATE);
      // Round-trip through JSON should be exact.
      expect(JSON.stringify(read)).toBe(JSON.stringify(result.digest));
    });

    it("returns null when the sidecar JSON does not parse against the schema", () => {
      // Run the job first so the parent dir exists (writeFileSync does
      // NOT recurse), then overwrite the sidecar with a payload that
      // fails Zod parsing.
      runPreMorningDigestJob({
        db,
        contextDir,
        boundary: TOKYO,
        nowMs: NOW_MS,
      });
      const paths = digestPaths(contextDir, TARGET_DATE);
      writeFileSync(paths.jsonPath, '{"oops":"not a digest"}', "utf-8");
      expect(readPreMorningDigestJsonForDate(contextDir, TARGET_DATE)).toBeNull();
    });

    it("returns null on JSON.parse failure", () => {
      runPreMorningDigestJob({
        db,
        contextDir,
        boundary: TOKYO,
        nowMs: NOW_MS,
      });
      const paths = digestPaths(contextDir, TARGET_DATE);
      writeFileSync(paths.jsonPath, "this is not json at all", "utf-8");
      expect(readPreMorningDigestJsonForDate(contextDir, TARGET_DATE)).toBeNull();
    });
  });

  describe("safeRunPreMorningDigestJob", () => {
    it("returns the result on success", () => {
      const result = safeRunPreMorningDigestJob({
        db,
        contextDir,
        boundary: TOKYO,
        nowMs: NOW_MS,
      });
      expect(result).not.toBeNull();
      expect(result?.date).toBe(TARGET_DATE);
    });

    it("returns null without throwing on internal failure", () => {
      // Closed DB → every query throws — exercise the catch block.
      const broken = new Database(":memory:");
      broken.close();
      const result = safeRunPreMorningDigestJob({
        db: broken,
        contextDir,
        boundary: TOKYO,
        nowMs: NOW_MS,
      });
      expect(result).toBeNull();
    });
  });
});

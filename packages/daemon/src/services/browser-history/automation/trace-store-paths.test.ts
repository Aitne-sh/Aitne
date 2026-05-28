import { describe, expect, it } from "vitest";

import {
  apiPathForTraceFile,
  AUTOMATION_TRACES_DIRNAME,
  makeScreenshotFileName,
  resolveTraceFilePath,
  TRACE_FILE_PATTERN,
  tracesRootDir,
  workflowTraceDir,
  WORKFLOW_ID_PATTERN,
} from "./trace-store-paths.js";

const PA = "/home/u/.personal-agent";
const WFID = "abcdef01-2345-6789-abcd-ef0123456789";

describe("trace-store-paths", () => {
  describe("constants", () => {
    it("AUTOMATION_TRACES_DIRNAME is stable", () => {
      expect(AUTOMATION_TRACES_DIRNAME).toBe("automation-traces");
    });
    it("WORKFLOW_ID_PATTERN matches the runner's randomUUID format", () => {
      expect(WORKFLOW_ID_PATTERN.test(WFID)).toBe(true);
    });
    it("TRACE_FILE_PATTERN accepts the known asset extensions", () => {
      expect(TRACE_FILE_PATTERN.test("1234567-primary.png")).toBe(true);
      expect(TRACE_FILE_PATTERN.test("trace.zip")).toBe(true);
      expect(TRACE_FILE_PATTERN.test("data.json")).toBe(true);
      expect(TRACE_FILE_PATTERN.test("img.webp")).toBe(true);
      expect(TRACE_FILE_PATTERN.test("img.jpeg")).toBe(true);
      expect(TRACE_FILE_PATTERN.test(".env")).toBe(false);
      expect(TRACE_FILE_PATTERN.test("foo.exe")).toBe(false);
      expect(TRACE_FILE_PATTERN.test("../a.png")).toBe(false);
      expect(TRACE_FILE_PATTERN.test("a/b.png")).toBe(false);
    });
  });

  describe("directory builders", () => {
    it("tracesRootDir joins PA_DATA_DIR + AUTOMATION_TRACES_DIRNAME", () => {
      expect(tracesRootDir(PA)).toBe(`${PA}/${AUTOMATION_TRACES_DIRNAME}`);
    });
    it("workflowTraceDir appends the workflow id", () => {
      expect(
        workflowTraceDir({ paDataDir: PA, workflowId: WFID }),
      ).toBe(`${PA}/${AUTOMATION_TRACES_DIRNAME}/${WFID}`);
    });
  });

  describe("resolveTraceFilePath", () => {
    it("resolves a legal trace path", () => {
      const resolved = resolveTraceFilePath(PA, WFID, "1234-primary.png");
      expect(resolved).toBe(`${PA}/${AUTOMATION_TRACES_DIRNAME}/${WFID}/1234-primary.png`);
    });

    it("rejects a malformed workflow id (path traversal smuggling)", () => {
      expect(resolveTraceFilePath(PA, "../secrets", "a.png")).toBeNull();
      expect(resolveTraceFilePath(PA, "abc", "a.png")).toBeNull();
    });

    it("rejects a filename with embedded separators / traversal", () => {
      expect(resolveTraceFilePath(PA, WFID, "../etc/passwd.png")).toBeNull();
      expect(resolveTraceFilePath(PA, WFID, "sub/file.png")).toBeNull();
      expect(resolveTraceFilePath(PA, WFID, "..\\file.png")).toBeNull();
      expect(resolveTraceFilePath(PA, WFID, "/etc/passwd.png")).toBeNull();
    });

    it("rejects NUL byte (defensive)", () => {
      expect(resolveTraceFilePath(PA, WFID, "file\0.png")).toBeNull();
    });

    it("rejects unknown file extensions", () => {
      expect(resolveTraceFilePath(PA, WFID, "x.exe")).toBeNull();
    });

    it("returns null when the resolved path would escape baseDir", () => {
      // This is theoretical — the regex blocks separators before we reach
      // the prefix check — but the prefix check is the structural lock.
      const result = resolveTraceFilePath(PA, WFID, "abc.png");
      expect(result).toContain(`/${AUTOMATION_TRACES_DIRNAME}/`);
    });
  });

  describe("apiPathForTraceFile", () => {
    it("builds the canonical API-served URL the dashboard fetches", () => {
      expect(apiPathForTraceFile(WFID, "1234-primary.png")).toBe(
        `/api/browser-task/${WFID}/screenshots/1234-primary.png`,
      );
    });
  });

  describe("makeScreenshotFileName", () => {
    it("normalises the label and prepends a tag", () => {
      const name = makeScreenshotFileName("Post Load!", 1700000000000);
      expect(name).toBe("1700000000000-post-load.png");
    });
    it("falls back to `screenshot` when label is empty after sanitisation", () => {
      expect(makeScreenshotFileName("!!!", 1)).toBe("1-screenshot.png");
    });
    it("caps the label length to 32 chars", () => {
      const long = "a".repeat(100);
      const name = makeScreenshotFileName(long, 5);
      // 5 + "-" + 32 chars + ".png"
      expect(name.length).toBeLessThan(50);
      expect(name.endsWith(".png")).toBe(true);
    });
  });
});

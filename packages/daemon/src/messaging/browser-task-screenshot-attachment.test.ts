import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OutboundAttachmentRef } from "../adapters/types.js";
import {
  buildStoreAttachment,
  buildTraceAttachment,
  resolveScreenshotAttachment,
  resolveTraceImage,
} from "./browser-task-screenshot-attachment.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const PNG_FILE = "123-capture.png";
const PNG_KEY = `/api/browser-task/${TASK_ID}/screenshots/${PNG_FILE}`;
// matches SCREENSHOT_KEY_PATTERN ([a-f0-9-]{36}) but NOT WORKFLOW_ID_PATTERN
// (no hyphens) → resolveTraceFilePath returns null.
const BAD_ID_KEY =
  "/api/browser-task/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/screenshots/x.png";
// valid task id + allowed-but-non-image extension → mimeType undefined.
const ZIP_KEY = `/api/browser-task/${TASK_ID}/screenshots/data.zip`;
const NON_MATCH_KEY = "/api/other/thing";

describe("resolveTraceImage", () => {
  it("returns null when paDataDir is absent", () => {
    expect(resolveTraceImage(null, PNG_KEY)).toBeNull();
    expect(resolveTraceImage("", PNG_KEY)).toBeNull();
  });

  it("returns null when the key shape is unrecognised", () => {
    expect(resolveTraceImage("/data", NON_MATCH_KEY)).toBeNull();
  });

  it("returns null when the trace path fails validation", () => {
    expect(resolveTraceImage("/data", BAD_ID_KEY)).toBeNull();
  });

  it("returns null for a recognised but non-image extension", () => {
    expect(resolveTraceImage("/data", ZIP_KEY)).toBeNull();
  });

  it("resolves a valid key to its on-disk path + image MIME", () => {
    const resolved = resolveTraceImage("/data", PNG_KEY);
    expect(resolved).not.toBeNull();
    expect(resolved!.fileName).toBe(PNG_FILE);
    expect(resolved!.mimeType).toBe("image/png");
    expect(resolved!.absPath).toContain(
      join("automation-traces", TASK_ID, PNG_FILE),
    );
  });
});

describe("buildTraceAttachment", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bt-screenshot-"));
    const dir = join(dataDir, "automation-traces", TASK_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PNG_FILE), Buffer.from([1, 2, 3, 4]));
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns null when the key cannot be resolved", async () => {
    expect(await buildTraceAttachment(null, PNG_KEY)).toBeNull();
  });

  it("returns null when the trace file is missing on disk", async () => {
    expect(await buildTraceAttachment("/no/such/dir", PNG_KEY)).toBeNull();
  });

  it("returns a trace-file attachment ref when the file exists", async () => {
    const ref = await buildTraceAttachment(dataDir, PNG_KEY);
    expect(ref).not.toBeNull();
    expect(ref!.id).toBe(PNG_KEY);
    expect(ref!.originalFilename).toBe(PNG_FILE);
    expect(ref!.mimeType).toBe("image/png");
    expect(ref!.sizeBytes).toBe(4);
    expect(ref!.path).toContain(PNG_FILE);
  });
});

describe("buildStoreAttachment", () => {
  const storeRef: OutboundAttachmentRef = {
    id: "store-id-1",
    path: "/data/attachments/store-id-1/123-capture.png",
    originalFilename: PNG_FILE,
    mimeType: "image/png",
    sizeBytes: 4,
  };

  it("returns null when the key cannot be resolved", async () => {
    const ingest = vi.fn();
    expect(await buildStoreAttachment(null, ingest, PNG_KEY)).toBeNull();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("returns null when no ingest hook is wired", async () => {
    expect(await buildStoreAttachment("/data", undefined, PNG_KEY)).toBeNull();
  });

  it("delegates to the ingest hook with the resolved trace path", async () => {
    const ingest = vi.fn().mockResolvedValue(storeRef);
    const ref = await buildStoreAttachment("/data", ingest, PNG_KEY);
    expect(ref).toBe(storeRef);
    expect(ingest).toHaveBeenCalledWith({
      absPath: expect.stringContaining(join(TASK_ID, PNG_FILE)),
      mimeType: "image/png",
      originalFilename: PNG_FILE,
    });
  });

  it("returns null when the ingest hook throws", async () => {
    const ingest = vi.fn().mockRejectedValue(new Error("disallowed_mime"));
    expect(await buildStoreAttachment("/data", ingest, PNG_KEY)).toBeNull();
  });

  it("returns null when the ingest hook throws a non-Error value", async () => {
    const ingest = vi.fn().mockRejectedValue("boom");
    expect(await buildStoreAttachment("/data", ingest, PNG_KEY)).toBeNull();
  });
});

describe("resolveScreenshotAttachment", () => {
  it("ingests into the store for the dashboard platform", async () => {
    const storeRef: OutboundAttachmentRef = {
      id: "store-id-2",
      path: "/data/attachments/store-id-2/123-capture.png",
      originalFilename: PNG_FILE,
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const ingest = vi.fn().mockResolvedValue(storeRef);
    const ref = await resolveScreenshotAttachment({
      platform: "dashboard",
      key: PNG_KEY,
      paDataDir: "/data",
      ingestOutboundImage: ingest,
    });
    expect(ref).toBe(storeRef);
    expect(ingest).toHaveBeenCalledOnce();
  });

  it("uses the native trace file for messaging platforms", async () => {
    const ingest = vi.fn();
    const ref = await resolveScreenshotAttachment({
      platform: "telegram",
      key: PNG_KEY,
      paDataDir: "/no/such/dir",
      ingestOutboundImage: ingest,
    });
    // file does not exist on disk → null, and the ingest hook is never used
    // for a non-dashboard platform.
    expect(ref).toBeNull();
    expect(ingest).not.toHaveBeenCalled();
  });
});

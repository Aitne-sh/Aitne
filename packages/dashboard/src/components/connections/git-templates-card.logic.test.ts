import { describe, expect, it } from "vitest";
import {
  buildApplyWarning,
  buildFileGridRows,
  gridStatusCounts,
  runHeadline,
  templateFileName,
  templateLabel,
} from "./git-templates-card.logic";
import type { RetemplateStatusRecord } from "@/lib/hooks/use-git-templates";

const baseEntry = {
  contextPath: "projects/x",
  contextFile: "plans/projects/x.md",
  backupRelPath: "plans/projects/x.md",
  classification: "project" as const,
};

describe("git-templates-card logic", () => {
  it("templateLabel + templateFileName route by kind", () => {
    expect(templateLabel("project")).toContain("projects/<slug>");
    expect(templateLabel("git-repo")).toContain("git-repos/<slug>");
    expect(templateFileName("project")).toBe("project.md");
    expect(templateFileName("git-repo")).toBe("git-repo.md");
  });

  it("buildApplyWarning includes auto-backup language and pluralization", () => {
    const single = buildApplyWarning("project", 1);
    expect(single.title).toContain("1 project document");
    expect(single.title).not.toContain("documents");
    expect(single.bullets.join(" ")).toContain("auto-backed up");
    expect(single.acknowledge).toMatch(/apply/i);

    const plural = buildApplyWarning("git-repo", 5);
    expect(plural.title).toContain("5 git-repo documents");
  });

  it("buildFileGridRows sorts by slug and computes byte deltas", () => {
    const record: RetemplateStatusRecord = {
      scheduleId: 1,
      correlationId: "c",
      kind: "project",
      backupRoot: "/tmp",
      startedAt: "2026-04-30T00:00:00.000Z",
      files: {
        zeta: { ...baseEntry, slug: "zeta", status: "completed", beforeBytes: 100, afterBytes: 110 },
        alpha: { ...baseEntry, slug: "alpha", status: "started" },
      },
    };
    const rows = buildFileGridRows(record);
    expect(rows.map((r) => r.slug)).toEqual(["alpha", "zeta"]);
    expect(rows[1].bytesDelta).toBe(10);
    expect(rows[0].bytesDelta).toBeNull();
  });

  it("gridStatusCounts buckets every status", () => {
    const rows = buildFileGridRows({
      scheduleId: 1,
      correlationId: "c",
      kind: "project",
      backupRoot: "/tmp",
      startedAt: "x",
      files: {
        a: { ...baseEntry, slug: "a", status: "completed" },
        b: { ...baseEntry, slug: "b", status: "completed" },
        c: { ...baseEntry, slug: "c", status: "failed", error: "x" },
        d: { ...baseEntry, slug: "d", status: "rolled_back" },
        e: { ...baseEntry, slug: "e", status: "skipped" },
      },
    });
    const counts = gridStatusCounts(rows);
    expect(counts.completed).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.rolled_back).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(counts.started).toBe(0);
  });

  it("runHeadline reflects in-progress vs final status", () => {
    expect(runHeadline(null)).toBeNull();
    const inProgress = runHeadline({
      scheduleId: 1,
      correlationId: "c",
      kind: "project",
      backupRoot: "/tmp",
      startedAt: "x",
      files: {},
    });
    expect(inProgress?.tone).toBe("info");
    expect(inProgress?.label).toMatch(/in progress/i);

    const success = runHeadline({
      scheduleId: 1,
      correlationId: "c",
      kind: "project",
      backupRoot: "/tmp",
      startedAt: "x",
      finalizedAt: "y",
      finalStatus: "success",
      files: {},
    });
    expect(success?.tone).toBe("success");

    const partial = runHeadline({
      scheduleId: 1,
      correlationId: "c",
      kind: "project",
      backupRoot: "/tmp",
      startedAt: "x",
      finalizedAt: "y",
      finalStatus: "partial",
      files: {},
    });
    expect(partial?.tone).toBe("warning");

    const failed = runHeadline({
      scheduleId: 1,
      correlationId: "c",
      kind: "project",
      backupRoot: "/tmp",
      startedAt: "x",
      finalizedAt: "y",
      finalStatus: "failed",
      files: {},
    });
    expect(failed?.tone).toBe("error");
  });
});

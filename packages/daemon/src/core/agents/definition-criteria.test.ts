import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentSuccessCriteria } from "./definition-criteria.js";

const VALID_AGENT_MD = `---
slug: daily-digest
name: Daily Digest
description: Composes the daily digest
kind: user
schedule:
  kind: cron
  expression: "0 9 * * *"
backend:
  process_key: agent.task
limits: {}
success_criteria:
  - kind: file_exists
    id: digest_written
    target: state/today.md
  - kind: file_section_count
    id: digest_sections
    target: state/today.md
    heading_level: 2
    min: 3
---

Compose the digest.
`;

describe("loadAgentSuccessCriteria", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pa-def-criteria-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses the success_criteria array from a valid agent.md", () => {
    const path = join(dir, "agent.md");
    writeFileSync(path, VALID_AGENT_MD, "utf-8");
    const criteria = loadAgentSuccessCriteria(path);
    expect(criteria).toHaveLength(2);
    expect(criteria[0]).toMatchObject({ kind: "file_exists", id: "digest_written" });
    expect(criteria[1]).toMatchObject({ kind: "file_section_count", id: "digest_sections", min: 3 });
  });

  it("returns [] for a missing file", () => {
    expect(loadAgentSuccessCriteria(join(dir, "nope.md"))).toEqual([]);
  });

  it("returns [] for a malformed definition", () => {
    const path = join(dir, "bad.md");
    writeFileSync(path, "not frontmatter at all", "utf-8");
    expect(loadAgentSuccessCriteria(path)).toEqual([]);
  });

  it("returns [] (schema default) when the definition declares no criteria", () => {
    const path = join(dir, "no-criteria.md");
    writeFileSync(
      path,
      `---
slug: x
name: X
description: No criteria
kind: user
schedule:
  kind: cron
  expression: "0 9 * * *"
backend:
  process_key: agent.task
limits: {}
---
body
`,
      "utf-8",
    );
    expect(loadAgentSuccessCriteria(path)).toEqual([]);
  });
});

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../config.js";
import {
  resolveSkillCurationOverlaysRoot,
  resolveUserSkillsRoot,
} from "./user-skills-root.js";

describe("user-skills-root", () => {
  it("resolveUserSkillsRoot routes to <contextDir>/policies/skills", () => {
    const config = { dataDir: "/tmp/pa-data" } as unknown as AgentConfig;
    expect(resolveUserSkillsRoot(config)).toBe(
      resolve("/tmp/pa-data", "context", "policies", "skills"),
    );
  });

  it("resolveSkillCurationOverlaysRoot lives outside the vault under <dataDir>", () => {
    expect(resolveSkillCurationOverlaysRoot("/tmp/pa-data")).toBe(
      resolve("/tmp/pa-data", "skill-curation-overlays"),
    );
  });
});

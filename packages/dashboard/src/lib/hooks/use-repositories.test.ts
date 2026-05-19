import { describe, expect, it } from "vitest";
import {
  repositoryDisplayName,
  type RepositoryDTO,
} from "./use-repositories";

function repo(overrides: Partial<RepositoryDTO>): RepositoryDTO {
  return {
    id: "local:x",
    githubOwner: null,
    githubRepo: null,
    githubAccount: null,
    localPath: null,
    localOnly: true,
    displayName: null,
    classification: "repo-only",
    category: "other",
    pollPriority: "normal",
    pollIntervalSec: null,
    slug: "fallback",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("repositoryDisplayName", () => {
  it("uses the final segment of Windows local paths", () => {
    expect(
      repositoryDisplayName(repo({ localPath: "C:\\Users\\me\\code\\widget" })),
    ).toBe("widget");
  });
});

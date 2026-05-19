import { describe, expect, it } from "vitest";
import { EventPriority } from "@aitne/shared";
import {
  classifyNotification,
  classifyWorkflowRun,
  parseGitHubRepoFullName,
  parseGitHubRemote,
  type GitHubNotification,
  type GitHubWorkflowRun,
} from "./github-poller-classifier.js";

function makeNotification(
  overrides: Partial<GitHubNotification> & { reason: string },
): GitHubNotification {
  const { reason, ...rest } = overrides;
  return {
    id: "1234",
    unread: true,
    reason,
    updated_at: "2026-04-28T10:00:00Z",
    subject: {
      title: "Test PR",
      type: "PullRequest",
      url: "https://api.github.com/repos/owner/repo/pulls/42",
    },
    repository: {
      full_name: "owner/repo",
      html_url: "https://github.com/owner/repo",
    },
    ...rest,
  };
}

function makeWorkflowRun(
  overrides: Partial<GitHubWorkflowRun> = {},
): GitHubWorkflowRun {
  return {
    id: 999,
    name: "ci",
    display_title: "Some commit message",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    html_url: "https://github.com/owner/repo/actions/runs/999",
    updated_at: "2026-04-28T10:00:00Z",
    event: "push",
    ...overrides,
  };
}

describe("classifyNotification", () => {
  it("skips already-read notifications", () => {
    const result = classifyNotification(
      makeNotification({ reason: "review_requested", unread: false }),
    );
    expect(result).toEqual({ kind: "skip", reason: "already_read" });
  });

  it("emits HIGH event for review_requested", () => {
    const result = classifyNotification(
      makeNotification({ reason: "review_requested" }),
    );
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.eventType).toBe("github.pull_request.review_requested");
    expect(result.priority).toBe(EventPriority.HIGH);
    expect(result.emitEvent).toBe(true);
    expect(result.source).toBe("github:notification:owner/repo");
    expect(result.ref).toBe("notification:1234");
    expect(result.payload).toMatchObject({
      repository: "owner/repo",
      reason: "review_requested",
      subjectTitle: "Test PR",
    });
  });

  it("emits HIGH event for assign", () => {
    const result = classifyNotification(makeNotification({ reason: "assign" }));
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.eventType).toBe("github.assigned");
    expect(result.priority).toBe(EventPriority.HIGH);
    expect(result.emitEvent).toBe(true);
  });

  it("emits HIGH event for security_alert", () => {
    const result = classifyNotification(
      makeNotification({ reason: "security_alert" }),
    );
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.eventType).toBe("github.security_alert");
    expect(result.priority).toBe(EventPriority.HIGH);
    expect(result.emitEvent).toBe(true);
  });

  it("records mention as NORMAL observation without EventBus emit", () => {
    const result = classifyNotification(makeNotification({ reason: "mention" }));
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.eventType).toBe("github.mention");
    expect(result.priority).toBe(EventPriority.NORMAL);
    expect(result.emitEvent).toBe(false);
  });

  it("records team_mention identically to mention", () => {
    const result = classifyNotification(
      makeNotification({ reason: "team_mention" }),
    );
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.eventType).toBe("github.mention");
    expect(result.priority).toBe(EventPriority.NORMAL);
    expect(result.emitEvent).toBe(false);
  });

  it("records ci_activity as LOW observation only", () => {
    const result = classifyNotification(
      makeNotification({ reason: "ci_activity" }),
    );
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.eventType).toBe("github.ci_activity");
    expect(result.priority).toBe(EventPriority.LOW);
    expect(result.emitEvent).toBe(false);
    expect(result.changeType).toBe("modified");
  });

  it("falls through unknown reason as LOW observation", () => {
    const result = classifyNotification(
      makeNotification({ reason: "something_new_from_github" }),
    );
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.eventType).toBe("github.notification");
    expect(result.priority).toBe(EventPriority.LOW);
    expect(result.emitEvent).toBe(false);
  });
});

describe("classifyWorkflowRun", () => {
  it("skips runs that are not completed", () => {
    const result = classifyWorkflowRun(
      makeWorkflowRun({ status: "in_progress", conclusion: null }),
      "main",
      "owner/repo",
    );
    expect(result).toEqual({ kind: "skip", reason: "not_completed" });
  });

  it("skips completed-but-successful runs", () => {
    const result = classifyWorkflowRun(
      makeWorkflowRun({ conclusion: "success" }),
      "main",
      "owner/repo",
    );
    expect(result).toEqual({ kind: "skip", reason: "not_failed" });
  });

  it("skips cancelled runs", () => {
    const result = classifyWorkflowRun(
      makeWorkflowRun({ conclusion: "cancelled" }),
      "main",
      "owner/repo",
    );
    expect(result).toEqual({ kind: "skip", reason: "not_failed" });
  });

  it("treats timed_out as failure", () => {
    const result = classifyWorkflowRun(
      makeWorkflowRun({ conclusion: "timed_out" }),
      "main",
      "owner/repo",
    );
    expect(result.kind).toBe("observe");
  });

  it("emits HIGH event for default-branch failure", () => {
    const result = classifyWorkflowRun(
      makeWorkflowRun({ head_branch: "main", conclusion: "failure" }),
      "main",
      "owner/repo",
    );
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.eventType).toBe("github.workflow_run.failed");
    expect(result.priority).toBe(EventPriority.HIGH);
    expect(result.emitEvent).toBe(true);
    expect(result.source).toBe("github:workflow:owner/repo");
    expect(result.ref).toBe("workflow_run:999");
    expect(result.payload).toMatchObject({
      repository: "owner/repo",
      branch: "main",
      defaultBranch: "main",
      onDefaultBranch: true,
      conclusion: "failure",
    });
  });

  it("records LOW observation for feature-branch failure (no event emit)", () => {
    const result = classifyWorkflowRun(
      makeWorkflowRun({ head_branch: "feat/foo", conclusion: "failure" }),
      "main",
      "owner/repo",
    );
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.priority).toBe(EventPriority.LOW);
    expect(result.emitEvent).toBe(false);
    expect(result.payload).toMatchObject({ onDefaultBranch: false });
  });

  it("falls back to display_title=name when display_title is missing", () => {
    const result = classifyWorkflowRun(
      makeWorkflowRun({ display_title: undefined, name: "build" }),
      "main",
      "owner/repo",
    );
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    expect(result.payload.displayTitle).toBe("build");
  });
});

describe("parseGitHubRemote", () => {
  it("parses git@github.com SSH form with .git suffix", () => {
    expect(parseGitHubRemote("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses git@github.com SSH form without .git suffix", () => {
    expect(parseGitHubRemote("git@github.com:owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses ssh:// SSH form", () => {
    expect(parseGitHubRemote("ssh://git@github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses https form", () => {
    expect(parseGitHubRemote("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses https form with .git suffix and trailing slash", () => {
    expect(parseGitHubRemote("https://github.com/owner/repo.git/")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses http form", () => {
    expect(parseGitHubRemote("http://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRemote("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGitHubRemote("https://bitbucket.org/owner/repo")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(parseGitHubRemote("garbage")).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
  });

  it("trims whitespace before parsing", () => {
    expect(parseGitHubRemote("  https://github.com/owner/repo\n")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });
});

describe("parseGitHubRepoFullName", () => {
  it("parses owner/repo form", () => {
    expect(parseGitHubRepoFullName("owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
    });
  });

  it("parses GitHub URLs using the remote parser", () => {
    expect(parseGitHubRepoFullName("https://github.com/openai/codex.git")).toEqual({
      owner: "openai",
      repo: "codex",
      fullName: "openai/codex",
    });
  });

  it("returns null for invalid identifiers", () => {
    expect(parseGitHubRepoFullName("repo-only")).toBeNull();
    expect(parseGitHubRepoFullName("https://gitlab.com/owner/repo")).toBeNull();
  });
});

describe("classifyNotification subject.url null coercion", () => {
  it("coerces a null subject.url into an empty string in the payload", () => {
    const notification = makeNotification({ reason: "review_requested" });
    notification.subject.url = null;
    const result = classifyNotification(notification);
    expect(result.kind).toBe("observe");
    if (result.kind !== "observe") return;
    // `String(null)` would yield the literal "null" once the task-flow
    // formatter stringifies the payload, so the classifier coerces null to
    // an empty string. Asserting the empty-string branch closes the missing
    // branch on `notification.subject.url ?? ""`.
    expect(result.payload).toMatchObject({ subjectUrl: "" });
    expect((result.payload as { subjectUrl: unknown }).subjectUrl).not.toBe(
      "null",
    );
  });
});

import { describe, expect, it } from "vitest";
import { EventPriority } from "@aitne/shared";
import {
  classifyGitBranchCreated,
  classifyGitBranchDeleted,
  classifyGitForcePush,
  classifyGitLifecycleEvent,
  classifyGitLocalAheadStale,
  classifyGitMergeToDefault,
  classifyGitPushDetected,
  classifyGitTagCreated,
  classifyGitTagDeleted,
  type GitEventClassification,
  type GitLifecycleEvent,
} from "./git-event-classifier.js";

const baseEvent = {
  repoPath: "/repo",
  ref: "ref:main:bbb222",
  changeType: "modified",
  actor: "unknown",
  payload: {
    branch: "main",
    defaultBranch: "main",
    remoteHash: "bbb222",
    previousRemoteHash: "aaa111",
  },
} as const;

function expectObserve(
  result: GitEventClassification,
): Extract<GitEventClassification, { kind: "observe" }> {
  expect(result.kind).toBe("observe");
  return result as Extract<GitEventClassification, { kind: "observe" }>;
}

describe("GitEventClassifier", () => {
  it("classifies force-push as the only high-priority EventBus-worthy git event", () => {
    const result = expectObserve(classifyGitForcePush(baseEvent));

    expect(result).toMatchObject({
      eventType: "git.push.force_pushed",
      priority: EventPriority.HIGH,
      emitEvent: true,
      source: "git:/repo",
      ref: "ref:main:bbb222",
      changeType: "modified",
      actor: "unknown",
    });
    expect(result.payload).toMatchObject({
      eventType: "git.push.force_pushed",
      repoPath: "/repo",
      branch: "main",
      previousRemoteHash: "aaa111",
      remoteHash: "bbb222",
    });
  });

  it("keeps all non-force lifecycle events observation-only", () => {
    const cases = [
      classifyGitPushDetected(baseEvent),
      classifyGitLocalAheadStale({ ...baseEvent, actor: "user" }),
      classifyGitBranchCreated({ ...baseEvent, changeType: "created" }),
      classifyGitBranchDeleted({ ...baseEvent, changeType: "deleted" }),
      classifyGitTagCreated({
        ...baseEvent,
        ref: "tag_created:v1.2.3:tag123",
        changeType: "created",
        payload: { tag: "v1.2.3", tagHash: "tag123" },
      }),
      classifyGitTagDeleted({
        ...baseEvent,
        ref: "tag_deleted:v1.2.3:tag123",
        changeType: "deleted",
        payload: { tag: "v1.2.3", previousTagHash: "tag123" },
      }),
      classifyGitMergeToDefault(baseEvent),
    ];

    for (const result of cases) {
      const observed = expectObserve(result);
      expect(observed.emitEvent).toBe(false);
      expect(observed.priority).not.toBe(EventPriority.HIGH);
      expect(observed.payload.repoPath).toBe("/repo");
      expect(observed.payload.eventType).toBe(observed.eventType);
    }
  });

  it("routes the generic classifier to the event-specific classifier", () => {
    const event: GitLifecycleEvent = {
      ...baseEvent,
      eventType: "git.merge_to_default",
    };

    const result = expectObserve(classifyGitLifecycleEvent(event));

    expect(result.eventType).toBe("git.merge_to_default");
    expect(result.priority).toBe(EventPriority.NORMAL);
    expect(result.emitEvent).toBe(false);
  });

  it("dispatches every known eventType through the generic classifier", () => {
    // Without this loop, classifyGitLifecycleEvent's individual case arms are
    // unhit (the per-classifier tests bypass dispatch). Routing every member
    // of the union through the generic entry-point covers all switch arms
    // and keeps the test in lock-step with the discriminated union shape.
    const eventTypes = [
      "git.push.detected",
      "git.local_ahead.stale",
      "git.push.force_pushed",
      "git.branch.created",
      "git.branch.deleted",
      "git.tag.created",
      "git.tag.deleted",
      "git.merge_to_default",
    ] as const;

    for (const eventType of eventTypes) {
      const event = { ...baseEvent, eventType } as GitLifecycleEvent;
      const result = classifyGitLifecycleEvent(event);
      expect(result.kind).toBe("observe");
      if (result.kind !== "observe") continue;
      expect(result.eventType).toBe(eventType);
    }
  });

  it("returns a defensive skip with the unreachable event-type for unknown discriminants", () => {
    // The type system makes this branch unreachable through normal API use
    // (classifyGitLifecycleEvent's `event.eventType` is exhaustively matched
    // against the GitLifecycleEvent union). We force-cast a bogus discriminant
    // to exercise the defensive `unreachable: never` fall-through that would
    // otherwise mask a future case-list drift if a new event type is added
    // without a matching switch arm.
    const bogus = {
      ...baseEvent,
      eventType: "git.bogus_unknown_event",
    } as unknown as GitLifecycleEvent;
    const result = classifyGitLifecycleEvent(bogus);
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toBe("unknown_git_event:git.bogus_unknown_event");
  });
});

import { EventPriority } from "@aitne/shared";

export type GitObservationChangeType = "created" | "modified" | "deleted";
export type GitObservationActor = "user" | "agent" | "system" | "unknown";

/**
 * Lifecycle events recognized by the watcher and classifier. The `.deleted`
 * variants are intentionally observation-only and are NOT registered in
 * `CONFIGURABLE_PROCESS_KEYS` — they never reach the dispatcher as standalone
 * sessions (`emitEvent` is always `false`) and surface only through the
 * hourly observation review. Adding them as ProcessKeys would expose them in
 * the dashboard's per-key model picker without any per-key task flow to back
 * them, which is misleading.
 */
export type GitLifecycleEventType =
  | "git.push.detected"
  | "git.local_ahead.stale"
  | "git.push.force_pushed"
  | "git.branch.created"
  | "git.branch.deleted"
  | "git.tag.created"
  | "git.tag.deleted"
  | "git.merge_to_default";

export interface GitLifecycleEventInput {
  repoPath: string;
  ref: string;
  changeType: GitObservationChangeType;
  actor: GitObservationActor;
  payload: Record<string, unknown>;
}

export interface GitLifecycleEvent extends GitLifecycleEventInput {
  eventType: GitLifecycleEventType;
}

export type GitEventClassification =
  | { kind: "skip"; reason: string }
  | {
      kind: "observe";
      eventType: GitLifecycleEventType;
      priority: EventPriority;
      changeType: GitObservationChangeType;
      actor: GitObservationActor;
      source: string;
      ref: string;
      payload: Record<string, unknown>;
      /**
       * Only HIGH-priority, interruption-worthy git events should enter
       * EventBus immediately. Everything else is recorded for the hourly
       * observation review or later project-MD lifecycle flows.
       */
      emitEvent: boolean;
    };

export function classifyGitLifecycleEvent(
  event: GitLifecycleEvent,
): GitEventClassification {
  switch (event.eventType) {
    case "git.push.detected":
      return classifyGitPushDetected(event);
    case "git.local_ahead.stale":
      return classifyGitLocalAheadStale(event);
    case "git.push.force_pushed":
      return classifyGitForcePush(event);
    case "git.branch.created":
      return classifyGitBranchCreated(event);
    case "git.branch.deleted":
      return classifyGitBranchDeleted(event);
    case "git.tag.created":
      return classifyGitTagCreated(event);
    case "git.tag.deleted":
      return classifyGitTagDeleted(event);
    case "git.merge_to_default":
      return classifyGitMergeToDefault(event);
  }
  const unreachable: never = event.eventType;
  return { kind: "skip", reason: `unknown_git_event:${unreachable}` };
}

export function classifyGitPushDetected(
  event: GitLifecycleEventInput,
): GitEventClassification {
  return observe("git.push.detected", event, EventPriority.LOW, false);
}

export function classifyGitLocalAheadStale(
  event: GitLifecycleEventInput,
): GitEventClassification {
  return observe("git.local_ahead.stale", event, EventPriority.NORMAL, false);
}

export function classifyGitForcePush(
  event: GitLifecycleEventInput,
): GitEventClassification {
  return observe("git.push.force_pushed", event, EventPriority.HIGH, true);
}

export function classifyGitBranchCreated(
  event: GitLifecycleEventInput,
): GitEventClassification {
  return observe("git.branch.created", event, EventPriority.LOW, false);
}

export function classifyGitBranchDeleted(
  event: GitLifecycleEventInput,
): GitEventClassification {
  return observe("git.branch.deleted", event, EventPriority.LOW, false);
}

export function classifyGitTagCreated(
  event: GitLifecycleEventInput,
): GitEventClassification {
  return observe("git.tag.created", event, EventPriority.LOW, false);
}

export function classifyGitTagDeleted(
  event: GitLifecycleEventInput,
): GitEventClassification {
  return observe("git.tag.deleted", event, EventPriority.LOW, false);
}

export function classifyGitMergeToDefault(
  event: GitLifecycleEventInput,
): GitEventClassification {
  return observe("git.merge_to_default", event, EventPriority.NORMAL, false);
}

function observe(
  eventType: GitLifecycleEventType,
  event: GitLifecycleEventInput,
  priority: EventPriority,
  emitEvent: boolean,
): GitEventClassification {
  return {
    kind: "observe",
    eventType,
    priority,
    changeType: event.changeType,
    actor: event.actor,
    source: `git:${event.repoPath}`,
    ref: event.ref,
    // Spread caller payload FIRST so the canonical fields below cannot be
    // shadowed. A caller that accidentally puts `eventType` or `repoPath`
    // into `payload` should not be able to override the values the
    // classifier sets — those two fields are dedup-relevant and downstream
    // consumers (task flows, hourly review) read them as ground truth.
    payload: {
      ...event.payload,
      eventType,
      repoPath: event.repoPath,
    },
    emitEvent,
  };
}
